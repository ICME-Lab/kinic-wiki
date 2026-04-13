use crate::client::WikiApi;
use crate::commands::{pull, push};
use crate::mirror::{load_state, parse_managed_metadata};
use anyhow::Result;
use async_trait::async_trait;
use std::path::PathBuf;
use tempfile::tempdir;
use wiki_types::{
    AppendNodeRequest, DeleteNodeRequest, DeleteNodeResult, EditNodeRequest, EditNodeResult,
    ExportSnapshotRequest, ExportSnapshotResponse, FetchUpdatesRequest, FetchUpdatesResponse,
    GlobNodeHit, GlobNodesRequest, ListNodesRequest, MkdirNodeRequest, MkdirNodeResult,
    MoveNodeRequest, MoveNodeResult, MultiEditNodeRequest, MultiEditNodeResult, Node, NodeEntry,
    NodeKind, NodeMutationAck, RecentNodeHit, RecentNodesRequest, SearchNodeHit,
    SearchNodePathsRequest, SearchNodesRequest, Status, WriteNodeRequest, WriteNodeResult,
};

#[derive(Default)]
pub(crate) struct MockClient {
    pub(crate) nodes: Vec<Node>,
    pub(crate) writes: std::sync::Mutex<Vec<WriteNodeRequest>>,
    pub(crate) appends: std::sync::Mutex<Vec<AppendNodeRequest>>,
    pub(crate) edits: std::sync::Mutex<Vec<EditNodeRequest>>,
    pub(crate) deletes: std::sync::Mutex<Vec<DeleteNodeRequest>>,
    pub(crate) mkdirs: std::sync::Mutex<Vec<MkdirNodeRequest>>,
    pub(crate) moves: std::sync::Mutex<Vec<MoveNodeRequest>>,
    pub(crate) globs: std::sync::Mutex<Vec<GlobNodesRequest>>,
    pub(crate) recents: std::sync::Mutex<Vec<RecentNodesRequest>>,
    pub(crate) multi_edits: std::sync::Mutex<Vec<MultiEditNodeRequest>>,
    pub(crate) path_searches: std::sync::Mutex<Vec<SearchNodePathsRequest>>,
}

#[async_trait]
impl WikiApi for MockClient {
    async fn status(&self) -> Result<Status> {
        Ok(Status {
            file_count: 0,
            source_count: 0,
        })
    }

    async fn read_node(&self, _path: &str) -> Result<Option<Node>> {
        Ok(Some(Node {
            path: _path.to_string(),
            kind: NodeKind::File,
            content: "# Remote".to_string(),
            created_at: 1,
            updated_at: 3,
            etag: "etag-remote".to_string(),
            metadata_json: "{}".to_string(),
        }))
    }

    async fn list_nodes(&self, _request: ListNodesRequest) -> Result<Vec<NodeEntry>> {
        Ok(Vec::new())
    }

    async fn write_node(&self, request: WriteNodeRequest) -> Result<WriteNodeResult> {
        self.writes
            .lock()
            .expect("writes should lock")
            .push(request.clone());
        Ok(WriteNodeResult {
            created: false,
            node: NodeMutationAck {
                path: request.path,
                kind: request.kind,
                updated_at: 3,
                etag: "etag-write".to_string(),
            },
        })
    }

    async fn append_node(&self, request: AppendNodeRequest) -> Result<WriteNodeResult> {
        self.appends
            .lock()
            .expect("appends should lock")
            .push(request.clone());
        Ok(WriteNodeResult {
            created: false,
            node: NodeMutationAck {
                path: request.path,
                kind: request.kind.unwrap_or(NodeKind::File),
                updated_at: 3,
                etag: "etag-append".to_string(),
            },
        })
    }

    async fn edit_node(&self, request: EditNodeRequest) -> Result<EditNodeResult> {
        self.edits
            .lock()
            .expect("edits should lock")
            .push(request.clone());
        Ok(EditNodeResult {
            node: NodeMutationAck {
                path: request.path,
                kind: NodeKind::File,
                updated_at: 3,
                etag: "etag-edit".to_string(),
            },
            replacement_count: 1,
        })
    }

    async fn delete_node(&self, request: DeleteNodeRequest) -> Result<DeleteNodeResult> {
        self.deletes
            .lock()
            .expect("deletes should lock")
            .push(request.clone());
        Ok(DeleteNodeResult { path: request.path })
    }

    async fn mkdir_node(&self, request: MkdirNodeRequest) -> Result<MkdirNodeResult> {
        self.mkdirs
            .lock()
            .expect("mkdirs should lock")
            .push(request.clone());
        Ok(MkdirNodeResult {
            path: request.path,
            created: true,
        })
    }

    async fn move_node(&self, request: MoveNodeRequest) -> Result<MoveNodeResult> {
        self.moves
            .lock()
            .expect("moves should lock")
            .push(request.clone());
        Ok(MoveNodeResult {
            from_path: request.from_path,
            overwrote: request.overwrite,
            node: NodeMutationAck {
                path: request.to_path,
                kind: NodeKind::File,
                updated_at: 5,
                etag: "etag-move".to_string(),
            },
        })
    }

    async fn glob_nodes(&self, request: GlobNodesRequest) -> Result<Vec<GlobNodeHit>> {
        self.globs.lock().expect("globs should lock").push(request);
        Ok(Vec::new())
    }

    async fn recent_nodes(&self, request: RecentNodesRequest) -> Result<Vec<RecentNodeHit>> {
        self.recents
            .lock()
            .expect("recents should lock")
            .push(request);
        Ok(Vec::new())
    }

    async fn multi_edit_node(&self, request: MultiEditNodeRequest) -> Result<MultiEditNodeResult> {
        self.multi_edits
            .lock()
            .expect("multi edits should lock")
            .push(request.clone());
        Ok(MultiEditNodeResult {
            node: NodeMutationAck {
                path: request.path,
                kind: NodeKind::File,
                updated_at: 6,
                etag: "etag-multi".to_string(),
            },
            replacement_count: 2,
        })
    }

    async fn search_nodes(&self, _request: SearchNodesRequest) -> Result<Vec<SearchNodeHit>> {
        Ok(Vec::new())
    }

    async fn search_node_paths(
        &self,
        request: SearchNodePathsRequest,
    ) -> Result<Vec<SearchNodeHit>> {
        self.path_searches
            .lock()
            .expect("path searches should lock")
            .push(request);
        Ok(Vec::new())
    }

    async fn export_snapshot(
        &self,
        _request: ExportSnapshotRequest,
    ) -> Result<ExportSnapshotResponse> {
        Ok(ExportSnapshotResponse {
            snapshot_revision: "snap_1".to_string(),
            nodes: self.nodes.clone(),
        })
    }

    async fn fetch_updates(&self, _request: FetchUpdatesRequest) -> Result<FetchUpdatesResponse> {
        Ok(FetchUpdatesResponse {
            snapshot_revision: "snap_1".to_string(),
            changed_nodes: self.nodes.clone(),
            removed_paths: Vec::new(),
        })
    }
}

#[tokio::test]
async fn pull_writes_nodes_under_mirror_root() {
    let dir = tempdir().expect("tempdir should create");
    let root = PathBuf::from(dir.path()).join("Wiki");
    let client = MockClient {
        nodes: vec![Node {
            path: "/Wiki/nested/bar.md".to_string(),
            kind: NodeKind::File,
            content: "# Bar".to_string(),
            created_at: 1,
            updated_at: 2,
            etag: "etag-1".to_string(),
            metadata_json: "{}".to_string(),
        }],
        ..Default::default()
    };

    pull(&client, &root).await.expect("pull should succeed");

    let content =
        std::fs::read_to_string(root.join("nested/bar.md")).expect("mirror file should exist");
    let metadata = parse_managed_metadata(&content).expect("frontmatter should parse");
    assert_eq!(metadata.path, "/Wiki/nested/bar.md");
    assert_eq!(
        load_state(&root)
            .expect("state should load")
            .tracked_nodes
            .len(),
        1
    );
}

#[tokio::test]
async fn push_uses_expected_etag_from_frontmatter() {
    let dir = tempdir().expect("tempdir should create");
    let root = PathBuf::from(dir.path()).join("Wiki");
    std::fs::create_dir_all(&root).expect("mirror root should exist");
    let initial = Node {
        path: "/Wiki/foo.md".to_string(),
        kind: NodeKind::File,
        content: "# Foo".to_string(),
        created_at: 1,
        updated_at: 2,
        etag: "etag-1".to_string(),
        metadata_json: "{}".to_string(),
    };
    crate::mirror::write_node_mirror(&root, &initial).expect("mirror write should succeed");
    crate::mirror::save_state(
        &root,
        &crate::mirror::MirrorState {
            snapshot_revision: "snap-1".to_string(),
            last_synced_at: 0,
            tracked_nodes: crate::mirror::tracked_nodes_from_snapshot(std::slice::from_ref(
                &initial,
            )),
        },
    )
    .expect("state should save");
    std::fs::write(
        root.join("foo.md"),
        crate::mirror::serialize_mirror_file(
            &crate::mirror::MirrorFrontmatter {
                path: "/Wiki/foo.md".to_string(),
                kind: NodeKind::File,
                etag: "etag-1".to_string(),
                updated_at: 2,
                mirror: true,
            },
            "# Foo\n\nedited",
        ),
    )
    .expect("edited file should write");

    let client = MockClient {
        nodes: vec![Node {
            etag: "etag-2".to_string(),
            updated_at: 3,
            content: "# Foo\n\nedited".to_string(),
            ..initial
        }],
        ..Default::default()
    };

    push(&client, &root).await.expect("push should succeed");

    let writes = client.writes.lock().expect("writes should lock");
    assert_eq!(writes.len(), 1);
    assert_eq!(writes[0].expected_etag.as_deref(), Some("etag-1"));
    let state = load_state(&root).expect("state should load");
    assert_eq!(state.snapshot_revision, "snap_1");
    assert_eq!(state.tracked_nodes[0].etag, "etag-2");
}
