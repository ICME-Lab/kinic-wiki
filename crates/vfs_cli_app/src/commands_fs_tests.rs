use crate::cli::{Cli, Command, ConnectionArgs, NodeKindArg};
use crate::commands::{pull, push, run_command};
use crate::mirror::{load_state, parse_managed_metadata};
use anyhow::{Result, anyhow};
use async_trait::async_trait;
use std::cmp::Reverse;
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Mutex;
use tempfile::tempdir;
use vfs_client::VfsApi;
use vfs_types::{
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
    pub(crate) fetch_nodes: Vec<Node>,
    pub(crate) search_hits: Vec<SearchNodeHit>,
    pub(crate) delete_fail_paths: HashSet<String>,
    pub(crate) lists: std::sync::Mutex<Vec<ListNodesRequest>>,
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

struct SnapshotRestartClient {
    calls: Mutex<usize>,
}

const SNAPSHOT_REVISION_1: &str = "v5:1:2f57696b69";

#[async_trait]
impl VfsApi for MockClient {
    async fn status(&self) -> Result<Status> {
        Ok(Status {
            file_count: 0,
            source_count: 0,
        })
    }

    async fn read_node(&self, _path: &str) -> Result<Option<Node>> {
        if self.nodes.is_empty() {
            return Ok(Some(Node {
                path: _path.to_string(),
                kind: NodeKind::File,
                content: "# Remote".to_string(),
                created_at: 1,
                updated_at: 3,
                etag: "etag-remote".to_string(),
                metadata_json: "{}".to_string(),
            }));
        }
        Ok(self.nodes.iter().find(|node| node.path == _path).cloned())
    }

    async fn list_nodes(&self, request: ListNodesRequest) -> Result<Vec<NodeEntry>> {
        self.lists
            .lock()
            .expect("lists should lock")
            .push(request.clone());
        let mut entries = Vec::new();
        for node in &self.nodes {
            if !node.path.starts_with(&request.prefix) {
                continue;
            }
            entries.push(NodeEntry {
                path: node.path.clone(),
                kind: match node.kind {
                    NodeKind::File => vfs_types::NodeEntryKind::File,
                    NodeKind::Source => vfs_types::NodeEntryKind::Source,
                },
                updated_at: node.updated_at,
                etag: node.etag.clone(),
                has_children: false,
            });
        }
        Ok(entries)
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
        if self.delete_fail_paths.contains(&request.path) {
            return Err(anyhow!("delete failed: {}", request.path));
        }
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
            .push(request.clone());
        let mut hits = self
            .nodes
            .iter()
            .filter(|node| match &request.path {
                Some(path) => node.path.starts_with(path),
                None => true,
            })
            .map(|node| RecentNodeHit {
                path: node.path.clone(),
                kind: node.kind.clone(),
                updated_at: node.updated_at,
                etag: node.etag.clone(),
            })
            .collect::<Vec<_>>();
        hits.sort_by_key(|right| Reverse(right.updated_at));
        hits.truncate(request.limit as usize);
        Ok(hits)
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
        Ok(self.search_hits.clone())
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
            snapshot_revision: SNAPSHOT_REVISION_1.to_string(),
            snapshot_session_id: None,
            nodes: self.nodes.clone(),
            next_cursor: None,
        })
    }

    async fn fetch_updates(&self, _request: FetchUpdatesRequest) -> Result<FetchUpdatesResponse> {
        Ok(FetchUpdatesResponse {
            snapshot_revision: SNAPSHOT_REVISION_1.to_string(),
            changed_nodes: self.fetch_nodes.clone(),
            removed_paths: Vec::new(),
            next_cursor: None,
        })
    }
}

#[async_trait]
impl VfsApi for SnapshotRestartClient {
    async fn status(&self) -> Result<Status> {
        unreachable!()
    }
    async fn read_node(&self, _path: &str) -> Result<Option<Node>> {
        unreachable!()
    }
    async fn list_nodes(&self, _request: ListNodesRequest) -> Result<Vec<NodeEntry>> {
        unreachable!()
    }
    async fn write_node(&self, _request: WriteNodeRequest) -> Result<WriteNodeResult> {
        unreachable!()
    }
    async fn append_node(&self, _request: AppendNodeRequest) -> Result<WriteNodeResult> {
        unreachable!()
    }
    async fn edit_node(&self, _request: EditNodeRequest) -> Result<EditNodeResult> {
        unreachable!()
    }
    async fn delete_node(&self, _request: DeleteNodeRequest) -> Result<DeleteNodeResult> {
        unreachable!()
    }
    async fn mkdir_node(&self, _request: MkdirNodeRequest) -> Result<MkdirNodeResult> {
        unreachable!()
    }
    async fn move_node(&self, _request: MoveNodeRequest) -> Result<MoveNodeResult> {
        unreachable!()
    }
    async fn glob_nodes(&self, _request: GlobNodesRequest) -> Result<Vec<GlobNodeHit>> {
        unreachable!()
    }
    async fn recent_nodes(&self, _request: RecentNodesRequest) -> Result<Vec<RecentNodeHit>> {
        unreachable!()
    }
    async fn multi_edit_node(&self, _request: MultiEditNodeRequest) -> Result<MultiEditNodeResult> {
        unreachable!()
    }
    async fn search_nodes(&self, _request: SearchNodesRequest) -> Result<Vec<SearchNodeHit>> {
        unreachable!()
    }
    async fn search_node_paths(
        &self,
        _request: SearchNodePathsRequest,
    ) -> Result<Vec<SearchNodeHit>> {
        unreachable!()
    }

    async fn export_snapshot(
        &self,
        request: ExportSnapshotRequest,
    ) -> Result<ExportSnapshotResponse> {
        let mut calls = self.calls.lock().expect("calls should lock");
        let response = match *calls {
            0 => ExportSnapshotResponse {
                snapshot_revision: "v5:1:2f57696b69".to_string(),
                snapshot_session_id: Some("session-1".to_string()),
                nodes: vec![Node {
                    path: "/Wiki/000.md".to_string(),
                    kind: NodeKind::File,
                    content: "page-1".to_string(),
                    created_at: 1,
                    updated_at: 1,
                    etag: "etag-1".to_string(),
                    metadata_json: "{}".to_string(),
                }],
                next_cursor: Some("/Wiki/000.md".to_string()),
            },
            _ => {
                assert_eq!(request.snapshot_session_id.as_deref(), Some("session-1"));
                assert_eq!(
                    request.snapshot_revision.as_deref(),
                    Some("v5:1:2f57696b69")
                );
                return Err(anyhow!("snapshot_revision is no longer current"));
            }
        };
        *calls += 1;
        Ok(response)
    }

    async fn fetch_updates(&self, _request: FetchUpdatesRequest) -> Result<FetchUpdatesResponse> {
        unreachable!()
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

    pull(&client, &root, false)
        .await
        .expect("pull should succeed");

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
async fn initial_pull_deduplicates_paths_when_delta_overwrites_snapshot_node() {
    let dir = tempdir().expect("tempdir should create");
    let root = PathBuf::from(dir.path()).join("Wiki");
    let client = MockClient {
        nodes: vec![Node {
            path: "/Wiki/nested/bar.md".to_string(),
            kind: NodeKind::File,
            content: "# Old".to_string(),
            created_at: 1,
            updated_at: 2,
            etag: "etag-old".to_string(),
            metadata_json: "{}".to_string(),
        }],
        fetch_nodes: vec![Node {
            path: "/Wiki/nested/bar.md".to_string(),
            kind: NodeKind::File,
            content: "# New".to_string(),
            created_at: 1,
            updated_at: 3,
            etag: "etag-new".to_string(),
            metadata_json: "{}".to_string(),
        }],
        ..Default::default()
    };

    pull(&client, &root, false)
        .await
        .expect("pull should succeed");

    let state = load_state(&root).expect("state should load");
    assert_eq!(state.tracked_nodes.len(), 1);
    assert_eq!(state.tracked_nodes[0].path, "/Wiki/nested/bar.md");
    assert_eq!(state.tracked_nodes[0].etag, "etag-new");
}

#[tokio::test]
async fn initial_pull_reports_snapshot_restart_when_paged_snapshot_turns_stale() {
    let dir = tempdir().expect("tempdir should create");
    let root = PathBuf::from(dir.path()).join("Wiki");
    let client = SnapshotRestartClient {
        calls: Mutex::new(0),
    };

    let error = pull(&client, &root, false)
        .await
        .expect_err("pull should surface snapshot restart");
    assert_eq!(
        error.to_string(),
        "snapshot_revision is no longer current; rerun pull"
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
            snapshot_revision: SNAPSHOT_REVISION_1.to_string(),
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
        fetch_nodes: vec![Node {
            path: "/Wiki/foo.md".to_string(),
            kind: NodeKind::File,
            content: "# Foo\n\nedited".to_string(),
            created_at: 1,
            updated_at: 3,
            etag: "etag-2".to_string(),
            metadata_json: "{}".to_string(),
        }],
        ..Default::default()
    };

    push(&client, &root).await.expect("push should succeed");

    let writes = client.writes.lock().expect("writes should lock");
    assert_eq!(writes.len(), 1);
    assert_eq!(writes[0].expected_etag.as_deref(), Some("etag-1"));
    let state = load_state(&root).expect("state should load");
    assert_eq!(state.snapshot_revision, SNAPSHOT_REVISION_1);
    assert_eq!(state.tracked_nodes[0].etag, "etag-2");
}

#[tokio::test]
async fn write_node_accepts_canonical_source_paths_only() {
    let dir = tempdir().expect("tempdir should create");
    let input = dir.path().join("source.md");
    std::fs::write(&input, "source").expect("input should write");
    let client = MockClient::default();

    for path in ["/Sources/raw/foo/foo.md", "/Sources/sessions/bar/bar.md"] {
        run_command(
            &client,
            Cli {
                connection: ConnectionArgs {
                    local: false,
                    canister_id: None,
                },
                command: Command::WriteNode {
                    path: path.to_string(),
                    kind: NodeKindArg::Source,
                    input: input.clone(),
                    metadata_json: "{}".to_string(),
                    expected_etag: None,
                    json: false,
                },
            },
        )
        .await
        .expect("canonical source path should pass");
    }

    let writes = client.writes.lock().expect("writes should lock");
    assert_eq!(writes.len(), 2);
}

#[tokio::test]
async fn write_node_rejects_non_canonical_source_paths() {
    let dir = tempdir().expect("tempdir should create");
    let input = dir.path().join("source.md");
    std::fs::write(&input, "source").expect("input should write");
    let client = MockClient::default();

    for path in [
        "/Sources/raw-foo/a/a.md",
        "/Sources/raw/x/y/y.md",
        "/Sources/raw/x/x.txt",
        "/Sources/raw/x/y.md",
        "/Sources/raw/x/",
    ] {
        let error = run_command(
            &client,
            Cli {
                connection: ConnectionArgs {
                    local: false,
                    canister_id: None,
                },
                command: Command::WriteNode {
                    path: path.to_string(),
                    kind: NodeKindArg::Source,
                    input: input.clone(),
                    metadata_json: "{}".to_string(),
                    expected_etag: None,
                    json: false,
                },
            },
        )
        .await
        .expect_err("non-canonical source path should fail");
        assert!(error.to_string().contains("source path must"));
    }

    let writes = client.writes.lock().expect("writes should lock");
    assert!(writes.is_empty());
}

#[test]
fn load_state_preserves_invalid_snapshot_revision() {
    let dir = tempdir().expect("tempdir should create");
    let root = PathBuf::from(dir.path()).join("Wiki");
    std::fs::create_dir_all(&root).expect("mirror root should exist");
    std::fs::write(
        root.join(".wiki-fs-state.json"),
        r#"{
  "snapshot_revision": "  snap-legacy  ",
  "last_synced_at": 123,
  "tracked_nodes": []
}"#,
    )
    .expect("state should write");

    let state = load_state(&root).expect("state should load");
    assert_eq!(state.snapshot_revision, "  snap-legacy  ");
    assert_eq!(state.last_synced_at, 123);
}
