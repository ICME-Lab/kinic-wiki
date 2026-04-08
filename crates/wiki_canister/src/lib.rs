// Where: crates/wiki_canister/src/lib.rs
// What: ICP canister entrypoints backed by WikiService with an FS-first public API.
// Why: The canister now exposes node-oriented operations directly and keeps the runtime boundary thin.
use std::cell::RefCell;
use std::fs::create_dir_all;
use std::ops::Range;
use std::path::{Path, PathBuf};

use candid::export_service;
use ic_cdk::{init, post_upgrade, query, update};
use ic_stable_structures::DefaultMemoryImpl;
use ic_stable_structures::memory_manager::{MemoryId, MemoryManager};
use wiki_runtime::WikiService;
use wiki_types::{
    DeleteNodeRequest, DeleteNodeResult, ExportSnapshotRequest, ExportSnapshotResponse,
    FetchUpdatesRequest, FetchUpdatesResponse, ListNodesRequest, Node, NodeEntry,
    SearchNodeHit, SearchNodesRequest, Status, WriteNodeRequest, WriteNodeResult,
};

const DB_PATH: &str = "./DB/wiki.sqlite3";
const FS_MEMORY_RANGE: Range<u8> = 200..210;
const DB_MEMORY_ID: u8 = 210;

thread_local! {
    static MEMORY_MANAGER: RefCell<MemoryManager<DefaultMemoryImpl>> =
        RefCell::new(MemoryManager::init(DefaultMemoryImpl::default()));
    static SERVICE: RefCell<Option<WikiService>> = const { RefCell::new(None) };
}

#[init]
fn init_hook() {
    initialize_or_trap();
}

#[post_upgrade]
fn post_upgrade_hook() {
    initialize_or_trap();
}

#[query]
fn status() -> Status {
    with_service(|service| service.status()).unwrap_or_else(|error| ic_cdk::trap(&error))
}

#[query]
fn read_node(path: String) -> Result<Option<Node>, String> {
    with_service(|service| service.read_node(&path))
}

#[query]
fn list_nodes(request: ListNodesRequest) -> Result<Vec<NodeEntry>, String> {
    with_service(|service| service.list_nodes(request))
}

#[update]
fn write_node(request: WriteNodeRequest) -> Result<WriteNodeResult, String> {
    with_service(|service| service.write_node(request, now_millis()))
}

#[update]
fn delete_node(request: DeleteNodeRequest) -> Result<DeleteNodeResult, String> {
    with_service(|service| service.delete_node(request, now_millis()))
}

#[query]
fn search_nodes(request: SearchNodesRequest) -> Result<Vec<SearchNodeHit>, String> {
    with_service(|service| service.search_nodes(request))
}

#[query]
fn export_snapshot(request: ExportSnapshotRequest) -> Result<ExportSnapshotResponse, String> {
    with_service(|service| service.export_fs_snapshot(request))
}

#[query]
fn fetch_updates(request: FetchUpdatesRequest) -> Result<FetchUpdatesResponse, String> {
    with_service(|service| service.fetch_fs_updates(request))
}

fn initialize_or_trap() {
    initialize_service().unwrap_or_else(|error| ic_cdk::trap(&error));
}

fn initialize_service() -> Result<(), String> {
    initialize_wasi_storage()?;
    let service = WikiService::new(PathBuf::from(DB_PATH));
    service.run_fs_migrations()?;
    SERVICE.with(|slot| *slot.borrow_mut() = Some(service));
    Ok(())
}

fn initialize_wasi_storage() -> Result<(), String> {
    MEMORY_MANAGER.with(|manager| {
        let manager = manager.borrow();
        ic_wasi_polyfill::init_with_memory_manager(
            &[0u8; 32],
            &[("SQLITE_TMPDIR", "tmp")],
            &manager,
            FS_MEMORY_RANGE.clone(),
        );

        create_dir_all("tmp").map_err(|error| error.to_string())?;
        let db_parent = Path::new(DB_PATH)
            .parent()
            .ok_or_else(|| "database path is missing parent directory".to_string())?;
        create_dir_all(db_parent).map_err(|error| error.to_string())?;

        ic_wasi_polyfill::unmount_memory_file(DB_PATH);
        let memory = manager.get(MemoryId::new(DB_MEMORY_ID));
        let mount_result = ic_wasi_polyfill::mount_memory_file(
            DB_PATH,
            Box::new(memory),
            ic_wasi_polyfill::MountedFileSizePolicy::MemoryPages,
        );
        if mount_result > 0 {
            return Err(format!("failed to mount database file: {mount_result}"));
        }
        Ok(())
    })
}

fn now_millis() -> i64 {
    #[cfg(test)]
    {
        1_700_000_000_000
    }
    #[cfg(not(test))]
    {
        (ic_cdk::api::time() / 1_000_000) as i64
    }
}

fn with_service<T, F>(f: F) -> Result<T, String>
where
    F: FnOnce(&WikiService) -> Result<T, String>,
{
    SERVICE.with(|slot| {
        let borrowed = slot.borrow();
        let service = borrowed
            .as_ref()
            .ok_or_else(|| "wiki service is not initialized".to_string())?;
        f(service)
    })
}

export_service!();

pub fn candid_interface() -> String {
    __export_service()
}

#[cfg(test)]
mod tests;
