// Where: crates/wiki_runtime/src/lib.rs
// What: Service-level orchestration for the FS-first node store.
// Why: Higher layers should depend on one node-oriented service boundary and nothing else.
use std::path::PathBuf;

use wiki_store::FsStore;
use wiki_types::{
    DeleteNodeRequest, DeleteNodeResult, ExportSnapshotRequest, ExportSnapshotResponse,
    FetchUpdatesRequest, FetchUpdatesResponse, ListNodesRequest, Node, NodeEntry,
    SearchNodeHit, SearchNodesRequest, Status, WriteNodeRequest, WriteNodeResult,
};

pub struct WikiService {
    fs_store: FsStore,
}

impl WikiService {
    pub fn new(database_path: PathBuf) -> Self {
        Self {
            fs_store: FsStore::new(database_path),
        }
    }

    pub fn run_fs_migrations(&self) -> Result<(), String> {
        self.fs_store.run_fs_migrations()
    }

    pub fn status(&self) -> Result<Status, String> {
        self.fs_store.status()
    }

    pub fn read_node(&self, path: &str) -> Result<Option<Node>, String> {
        self.fs_store.read_node(path)
    }

    pub fn list_nodes(&self, request: ListNodesRequest) -> Result<Vec<NodeEntry>, String> {
        self.fs_store.list_nodes(request)
    }

    pub fn write_node(
        &self,
        request: WriteNodeRequest,
        now: i64,
    ) -> Result<WriteNodeResult, String> {
        self.fs_store.write_node(request, now)
    }

    pub fn delete_node(
        &self,
        request: DeleteNodeRequest,
        now: i64,
    ) -> Result<DeleteNodeResult, String> {
        self.fs_store.delete_node(request, now)
    }

    pub fn search_nodes(&self, request: SearchNodesRequest) -> Result<Vec<SearchNodeHit>, String> {
        self.fs_store.search_nodes(request)
    }

    pub fn export_fs_snapshot(
        &self,
        request: ExportSnapshotRequest,
    ) -> Result<ExportSnapshotResponse, String> {
        self.fs_store.export_snapshot(request)
    }

    pub fn fetch_fs_updates(
        &self,
        request: FetchUpdatesRequest,
    ) -> Result<FetchUpdatesResponse, String> {
        self.fs_store.fetch_updates(request)
    }
}
