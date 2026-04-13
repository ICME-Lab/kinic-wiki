// Where: crates/wiki_runtime/src/lib.rs
// What: Service-level orchestration for the FS-first node store.
// Why: Higher layers should depend on one node-oriented service boundary and nothing else.
use std::path::PathBuf;

use wiki_store::FsStore;
use wiki_types::{
    AppendNodeRequest, DeleteNodeRequest, DeleteNodeResult, EditNodeRequest, EditNodeResult,
    ExportSnapshotRequest, ExportSnapshotResponse, FetchUpdatesRequest, FetchUpdatesResponse,
    GlobNodeHit, GlobNodesRequest, ListNodesRequest, MkdirNodeRequest, MkdirNodeResult,
    MoveNodeRequest, MoveNodeResult, MultiEditNodeRequest, MultiEditNodeResult, Node, NodeEntry,
    RecentNodeHit, RecentNodesRequest, SearchNodeHit, SearchNodePathsRequest, SearchNodesRequest,
    Status, WriteNodeRequest, WriteNodeResult,
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

    pub fn append_node(
        &self,
        request: AppendNodeRequest,
        now: i64,
    ) -> Result<WriteNodeResult, String> {
        self.fs_store.append_node(request, now)
    }

    pub fn edit_node(&self, request: EditNodeRequest, now: i64) -> Result<EditNodeResult, String> {
        self.fs_store.edit_node(request, now)
    }

    pub fn mkdir_node(&self, request: MkdirNodeRequest) -> Result<MkdirNodeResult, String> {
        self.fs_store.mkdir_node(request)
    }

    pub fn move_node(&self, request: MoveNodeRequest, now: i64) -> Result<MoveNodeResult, String> {
        self.fs_store.move_node(request, now)
    }

    pub fn glob_nodes(&self, request: GlobNodesRequest) -> Result<Vec<GlobNodeHit>, String> {
        self.fs_store.glob_nodes(request)
    }

    pub fn recent_nodes(&self, request: RecentNodesRequest) -> Result<Vec<RecentNodeHit>, String> {
        self.fs_store.recent_nodes(request)
    }

    pub fn multi_edit_node(
        &self,
        request: MultiEditNodeRequest,
        now: i64,
    ) -> Result<MultiEditNodeResult, String> {
        self.fs_store.multi_edit_node(request, now)
    }

    pub fn search_nodes(&self, request: SearchNodesRequest) -> Result<Vec<SearchNodeHit>, String> {
        self.fs_store.search_nodes(request)
    }

    pub fn search_node_paths(
        &self,
        request: SearchNodePathsRequest,
    ) -> Result<Vec<SearchNodeHit>, String> {
        self.fs_store.search_node_paths(request)
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
