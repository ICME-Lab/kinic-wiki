// Where: crates/ic_sqlite_vfs_probe/src/canister.rs
// What: PocketIC-facing canister API for the ic-sqlite-vfs probe crate.
// Why: Exercise DbHandle storage, queries, rollback, and upgrade persistence in an IC runtime.
use std::cell::RefCell;

use ic_cdk::{init, post_upgrade, query, update};
use ic_stable_structures::DefaultMemoryImpl;
use ic_stable_structures::memory_manager::{MemoryId, MemoryManager};

use crate::{get, init_probe, params, put};
use ic_sqlite_vfs::{DbError, DbHandle};

const FIRST_SLOT_MEMORY_ID: MemoryId = MemoryId::new(120);
const SECOND_SLOT_MEMORY_ID: MemoryId = MemoryId::new(121);

#[derive(Clone, Copy)]
struct Handles {
    first: DbHandle,
    second: DbHandle,
}

thread_local! {
    static MEMORY_MANAGER: RefCell<MemoryManager<DefaultMemoryImpl>> =
        RefCell::new(MemoryManager::init(DefaultMemoryImpl::default()));
    static HANDLES: RefCell<Option<Handles>> = const { RefCell::new(None) };
}

#[init]
fn init_hook() {
    initialize_or_trap();
}

#[post_upgrade]
fn post_upgrade_hook() {
    initialize_or_trap();
}

#[update]
fn put_value(slot: u8, key: String, value: String) -> Result<(), String> {
    let handle = handle_for_slot(slot)?;
    put(handle, &key, &value).map_err(error_text)
}

#[query]
fn get_value(slot: u8, key: String) -> Result<Option<String>, String> {
    let handle = handle_for_slot(slot)?;
    get(handle, &key).map_err(error_text)
}

#[update]
fn update_get_value(slot: u8, key: String) -> Result<Option<String>, String> {
    let handle = handle_for_slot(slot)?;
    handle
        .update(|connection| {
            connection.query_optional_scalar::<String>(
                "SELECT value FROM probe_kv WHERE key = ?1",
                params![key],
            )
        })
        .map_err(error_text)
}

#[update]
fn put_then_fail(slot: u8, key: String, value: String) -> Result<(), String> {
    let handle = handle_for_slot(slot)?;
    handle
        .update(|connection| {
            connection.execute(
                "INSERT INTO probe_kv(key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![key, value],
            )?;
            connection.execute(
                "INSERT INTO missing_table(value) VALUES (?1)",
                params![1_i64],
            )?;
            Ok(())
        })
        .map_err(error_text)
}

#[query]
fn integrity_check(slot: u8) -> Result<String, String> {
    handle_for_slot(slot)?.integrity_check().map_err(error_text)
}

#[query]
fn checksum(slot: u8) -> Result<u64, String> {
    handle_for_slot(slot)?.db_checksum().map_err(error_text)
}

#[update]
fn refresh_checksum(slot: u8) -> Result<u64, String> {
    handle_for_slot(slot)?
        .refresh_checksum()
        .map_err(error_text)
}

fn initialize_or_trap() {
    initialize().unwrap_or_else(|error| ic_cdk::trap(error));
}

fn initialize() -> Result<(), String> {
    MEMORY_MANAGER.with(|manager| {
        let manager = manager.borrow();
        let first = init_probe(manager.get(FIRST_SLOT_MEMORY_ID)).map_err(error_text)?;
        let second = init_probe(manager.get(SECOND_SLOT_MEMORY_ID)).map_err(error_text)?;
        HANDLES.with(|slot| {
            *slot.borrow_mut() = Some(Handles { first, second });
        });
        Ok(())
    })
}

fn handle_for_slot(slot: u8) -> Result<DbHandle, String> {
    HANDLES.with(|handles| {
        let handles = handles
            .borrow()
            .ok_or_else(|| "probe database is not initialized".to_string())?;
        match slot {
            0 => Ok(handles.first),
            1 => Ok(handles.second),
            _ => Err(format!("unknown slot: {slot}")),
        }
    })
}

fn error_text(error: DbError) -> String {
    error.to_string()
}

ic_cdk::export_candid!();
