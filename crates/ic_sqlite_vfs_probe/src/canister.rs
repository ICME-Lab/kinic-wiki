// Where: crates/ic_sqlite_vfs_probe/src/canister.rs
// What: PocketIC-facing canister API for the ic-sqlite-vfs probe crate.
// Why: Exercise DbHandle storage, queries, rollback, and upgrade persistence in an IC runtime.
use std::cell::RefCell;

use ic_cdk::{init, post_upgrade, query, update};

use crate::{get, init_probe, params, put};
use ic_sqlite_vfs::{DbError, DbHandle, DefaultMemoryImpl, MemoryId, MemoryManager};

const FIRST_SLOT_MEMORY_ID: MemoryId = MemoryId::new(120);
const SECOND_SLOT_MEMORY_ID: MemoryId = MemoryId::new(121);

#[derive(Clone, Copy)]
struct Handles {
    first: DbHandle,
    second: DbHandle,
}

thread_local! {
    static MEMORY_MANAGER: RefCell<MemoryManager<DefaultMemoryImpl>> =
        RefCell::new(
            MemoryManager::init_strict(DefaultMemoryImpl::default())
                .expect("stable memory must be empty or contain an ic-sqlite-vfs image"),
        );
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

// A single update keeps the same SQLite connection alive across registration,
// prepared-statement reuse, rejection, guard removal and ordinary writes.
#[update]
fn verify_read_authorizer() -> Result<(), String> {
    use kinic_sqlite_compat as sqlite;
    handle_for_slot(0)?
        .update(|connection| {
            connection.execute("CREATE TABLE IF NOT EXISTS fs_nodes(id INTEGER)", params![])?;
            connection.execute("CREATE TABLE IF NOT EXISTS secret(id INTEGER)", params![])?;
            connection.execute("INSERT INTO fs_nodes VALUES(1)", params![])?;
            connection.execute("INSERT INTO secret VALUES(7)", params![])?;
            let mut allowed = connection.prepare("SELECT id FROM fs_nodes LIMIT 1")?;
            let mut forbidden = connection.prepare("SELECT id FROM secret LIMIT 1")?;
            assert_eq!(
                sqlite::query_one(&mut allowed, params![], |row| sqlite::row_get::<i64>(
                    row, 0
                ))?,
                1
            );
            assert_eq!(
                sqlite::query_one(&mut forbidden, params![], |row| sqlite::row_get::<i64>(
                    row, 0
                ))?,
                7
            );
            {
                let _guard =
                    sqlite::install_read_authorizer(connection, &["fs_nodes", "fs_links"])?;
                assert!(
                    sqlite::query_one(&mut forbidden, params![], |row| sqlite::row_get::<i64>(
                        row, 0
                    ))
                    .is_err()
                );
                assert_eq!(
                    sqlite::query_one(&mut allowed, params![], |row| sqlite::row_get::<i64>(
                        row, 0
                    ))?,
                    1
                );
                for sql in [
                    "SELECT id FROM 'secret' fs_nodes",
                    "SELECT id IN secret FROM fs_nodes",
                    "SELECT json_object('x', 1) FROM secret",
                    "DELETE FROM fs_nodes",
                    "PRAGMA database_list",
                ] {
                    assert!(connection.prepare(sql).is_err(), "authorizer allowed {sql}");
                }
            }
            // This happens in the same call, so IC query rollback cannot mask a
            // stale callback or a policy pointer retained after guard destruction.
            assert_eq!(
                connection
                    .query_optional_scalar::<i64>("SELECT id FROM secret LIMIT 1", params![])?,
                Some(7)
            );
            connection.execute("INSERT INTO fs_nodes VALUES(2)", params![])?;
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
