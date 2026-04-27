// Where: crates/vfs_canister/src/lib.rs
// What: ICP canister entrypoints backed by VfsService with an FS-first public API.
// Why: The canister now exposes node-oriented operations directly and keeps the runtime boundary thin.
use std::cell::RefCell;
use std::fs::create_dir_all;
use std::ops::Range;
use std::path::{Path, PathBuf};

use candid::export_service;
use ic_cdk::{init, post_upgrade, query, update};
use ic_stable_structures::DefaultMemoryImpl;
use ic_stable_structures::memory_manager::{MemoryId, MemoryManager};
use vfs_runtime::VfsService;
use vfs_types::{
    AppendNodeRequest, DeleteNodeRequest, DeleteNodeResult, EditNodeRequest, EditNodeResult,
    ExportSnapshotRequest, ExportSnapshotResponse, FetchUpdatesRequest, FetchUpdatesResponse,
    GlobNodeHit, GlobNodesRequest, ListNodesRequest, MkdirNodeRequest, MkdirNodeResult,
    MoveNodeRequest, MoveNodeResult, MultiEditNodeRequest, MultiEditNodeResult, Node, NodeEntry,
    NodeKind, RecentNodeHit, RecentNodesRequest, SearchNodeHit, SearchNodePathsRequest,
    SearchNodesRequest, Status, WriteNodeRequest, WriteNodeResult,
};
use wiki_domain::validate_source_path_for_kind;

const DB_PATH: &str = "./DB/wiki.sqlite3";
const FS_MEMORY_RANGE: Range<u8> = 200..210;
const DB_MEMORY_ID: u8 = 210;

thread_local! {
    static MEMORY_MANAGER: RefCell<MemoryManager<DefaultMemoryImpl>> =
        RefCell::new(MemoryManager::init(DefaultMemoryImpl::default()));
    static SERVICE: RefCell<Option<VfsService>> = const { RefCell::new(None) };
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
    validate_wiki_source_write(&request)?;
    with_service(|service| service.write_node(request, now_millis()))
}

#[update]
fn append_node(request: AppendNodeRequest) -> Result<WriteNodeResult, String> {
    with_service(|service| {
        validate_wiki_source_append(service, &request)?;
        service.append_node(request, now_millis())
    })
}

#[update]
fn edit_node(request: EditNodeRequest) -> Result<EditNodeResult, String> {
    with_service(|service| service.edit_node(request, now_millis()))
}

#[update]
fn delete_node(request: DeleteNodeRequest) -> Result<DeleteNodeResult, String> {
    with_service(|service| service.delete_node(request, now_millis()))
}

#[update]
fn move_node(request: MoveNodeRequest) -> Result<MoveNodeResult, String> {
    with_service(|service| {
        validate_wiki_source_move(service, &request)?;
        service.move_node(request, now_millis())
    })
}

#[query]
fn mkdir_node(request: MkdirNodeRequest) -> Result<MkdirNodeResult, String> {
    with_service(|service| service.mkdir_node(request))
}

#[query]
fn glob_nodes(request: GlobNodesRequest) -> Result<Vec<GlobNodeHit>, String> {
    with_service(|service| service.glob_nodes(request))
}

#[query]
fn recent_nodes(request: RecentNodesRequest) -> Result<Vec<RecentNodeHit>, String> {
    with_service(|service| service.recent_nodes(request))
}

#[update]
fn multi_edit_node(request: MultiEditNodeRequest) -> Result<MultiEditNodeResult, String> {
    with_service(|service| service.multi_edit_node(request, now_millis()))
}

#[query]
fn search_nodes(request: SearchNodesRequest) -> Result<Vec<SearchNodeHit>, String> {
    with_service(|service| service.search_nodes(request))
}

#[query]
fn search_node_paths(request: SearchNodePathsRequest) -> Result<Vec<SearchNodeHit>, String> {
    with_service(|service| service.search_node_paths(request))
}

#[update]
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
    let service = VfsService::new(PathBuf::from(DB_PATH));
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
    F: FnOnce(&VfsService) -> Result<T, String>,
{
    SERVICE.with(|slot| {
        let borrowed = slot.borrow();
        let service = borrowed
            .as_ref()
            .ok_or_else(|| "wiki service is not initialized".to_string())?;
        f(service)
    })
}

fn validate_wiki_source_write(request: &WriteNodeRequest) -> Result<(), String> {
    validate_wiki_source_path_for_kind(&request.path, &request.kind)
}

fn validate_wiki_source_append(
    service: &VfsService,
    request: &AppendNodeRequest,
) -> Result<(), String> {
    if let Some(kind) = request.kind.as_ref() {
        validate_wiki_source_path_for_kind(&request.path, kind)?;
        return Ok(());
    }
    let existing = service.read_node(&request.path)?;
    if let Some(node) = existing {
        validate_wiki_source_path_for_kind(&request.path, &node.kind)?;
    }
    Ok(())
}

fn validate_wiki_source_move(
    service: &VfsService,
    request: &MoveNodeRequest,
) -> Result<(), String> {
    let current = service
        .read_node(&request.from_path)?
        .ok_or_else(|| format!("node does not exist: {}", request.from_path))?;
    validate_wiki_source_path_for_kind(&request.to_path, &current.kind)
}

fn validate_wiki_source_path_for_kind(path: &str, kind: &NodeKind) -> Result<(), String> {
    validate_source_path_for_kind(path, kind)
}

export_service!();

pub fn candid_interface() -> String {
    normalize_candid_interface(__export_service())
}

fn normalize_candid_interface(interface: String) -> String {
    // Where: canister Candid export path.
    // What: Restore the public nominal request name for mkdir_node.
    // Why: candid::export_service() deduplicates identical record shapes and
    //      rewrites MkdirNodeRequest to DeleteNodeResult, but the checked-in
    //      vfs.did is the public contract and must keep MkdirNodeRequest.
    let normalized = interface.replace(
        "mkdir_node : (DeleteNodeResult) -> (Result_7) query;",
        "mkdir_node : (MkdirNodeRequest) -> (Result_7) query;",
    );
    if normalized.contains("type MkdirNodeRequest = record { path : text };") {
        return normalized;
    }
    normalized.replace(
        "type MkdirNodeResult = record { created : bool; path : text };",
        "type MkdirNodeRequest = record { path : text };\ntype MkdirNodeResult = record { created : bool; path : text };",
    )
}

#[cfg(feature = "canbench-rs")]
mod benches;

#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_sync_contract;
