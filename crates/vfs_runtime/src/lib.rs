// Where: crates/vfs_runtime/src/lib.rs
// What: Service-level orchestration for the reusable VFS node store.
// Why: Canister and CLI-adjacent consumers should share one stable VFS service boundary.
use std::path::PathBuf;

use vfs_store::FsStore;
use vfs_types::{
    AppendNodeRequest, DeleteNodeRequest, DeleteNodeResult, EditNodeRequest, EditNodeResult,
    ExportSnapshotRequest, ExportSnapshotResponse, FetchUpdatesRequest, FetchUpdatesResponse,
    GlobNodeHit, GlobNodesRequest, ListNodesRequest, MkdirNodeRequest, MkdirNodeResult,
    MoveNodeRequest, MoveNodeResult, MultiEditNodeRequest, MultiEditNodeResult, Node, NodeEntry,
    RecentNodeHit, RecentNodesRequest, SearchNodeHit, SearchNodePathsRequest, SearchNodesRequest,
    Status, WriteNodeRequest, WriteNodeResult,
};
use wiki_domain::validate_source_path_for_kind;

pub struct VfsService {
    fs_store: FsStore,
}

impl VfsService {
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
        validate_source_path_for_kind(&request.path, &request.kind)?;
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
        if let Some(kind) = request.kind.as_ref() {
            validate_source_path_for_kind(&request.path, kind)?;
        }
        self.fs_store.append_node(request, now)
    }

    pub fn edit_node(&self, request: EditNodeRequest, now: i64) -> Result<EditNodeResult, String> {
        self.fs_store.edit_node(request, now)
    }

    pub fn mkdir_node(&self, request: MkdirNodeRequest) -> Result<MkdirNodeResult, String> {
        self.fs_store.mkdir_node(request)
    }

    pub fn move_node(&self, request: MoveNodeRequest, now: i64) -> Result<MoveNodeResult, String> {
        if let Some(node) = self.fs_store.read_node(&request.from_path)? {
            validate_source_path_for_kind(&request.to_path, &node.kind)?;
        }
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
