use crate::cli::{Cli, Command, ConnectionArgs, IdentityModeArg, NodeKindArg};
use crate::commands::run_command;
use anyhow::{Result, anyhow};
use async_trait::async_trait;
use std::cmp::Reverse;
use std::collections::HashSet;
use tempfile::tempdir;
use vfs_cli::connection::ResolvedConnection;
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
    pub(crate) child_lists: std::sync::Mutex<Vec<vfs_types::ListChildrenRequest>>,
    pub(crate) writes: std::sync::Mutex<Vec<WriteNodeRequest>>,
    pub(crate) appends: std::sync::Mutex<Vec<AppendNodeRequest>>,
    pub(crate) edits: std::sync::Mutex<Vec<EditNodeRequest>>,
    pub(crate) deletes: std::sync::Mutex<Vec<DeleteNodeRequest>>,
    pub(crate) mkdirs: std::sync::Mutex<Vec<MkdirNodeRequest>>,
    pub(crate) moves: std::sync::Mutex<Vec<MoveNodeRequest>>,
    pub(crate) globs: std::sync::Mutex<Vec<GlobNodesRequest>>,
    pub(crate) recents: std::sync::Mutex<Vec<RecentNodesRequest>>,
    pub(crate) multi_edits: std::sync::Mutex<Vec<MultiEditNodeRequest>>,
    pub(crate) searches: std::sync::Mutex<Vec<SearchNodesRequest>>,
    pub(crate) path_searches: std::sync::Mutex<Vec<SearchNodePathsRequest>>,
}

fn test_connection() -> ResolvedConnection {
    ResolvedConnection {
        replica_host: "http://127.0.0.1:8000".to_string(),
        canister_id: "aaaaa-aa".to_string(),
        database_id: Some("default".to_string()),
        replica_host_source: "test".to_string(),
        canister_id_source: "test".to_string(),
        database_id_source: Some("test".to_string()),
    }
}

const SNAPSHOT_REVISION_1: &str = "v5:1:2f57696b69";

#[async_trait]
impl VfsApi for MockClient {
    async fn status(&self, _database_id: &str) -> Result<Status> {
        Ok(Status {
            file_count: 0,
            source_count: 0,
        })
    }

    async fn read_node(&self, _database_id: &str, _path: &str) -> Result<Option<Node>> {
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
                    NodeKind::Folder => vfs_types::NodeEntryKind::Folder,
                },
                updated_at: node.updated_at,
                etag: node.etag.clone(),
                has_children: false,
            });
        }
        Ok(entries)
    }

    async fn list_children(
        &self,
        request: vfs_types::ListChildrenRequest,
    ) -> Result<Vec<vfs_types::ChildNode>> {
        self.child_lists
            .lock()
            .expect("child lists should lock")
            .push(request);
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

    async fn search_nodes(&self, request: SearchNodesRequest) -> Result<Vec<SearchNodeHit>> {
        self.searches
            .lock()
            .expect("searches should lock")
            .push(request);
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
                    database_id: Some("default".to_string()),
                    local: false,
                    replica_host: None,
                    canister_id: None,
                    identity_mode: IdentityModeArg::Auto,
                    allow_non_ii_identity: false,
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
            &test_connection(),
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
                    database_id: Some("default".to_string()),
                    local: false,
                    replica_host: None,
                    canister_id: None,
                    identity_mode: IdentityModeArg::Auto,
                    allow_non_ii_identity: false,
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
            &test_connection(),
        )
        .await
        .expect_err("non-canonical source path should fail");
        assert!(error.to_string().contains("source path must"));
    }

    let writes = client.writes.lock().expect("writes should lock");
    assert!(writes.is_empty());
}

#[tokio::test]
async fn delete_node_autofills_folder_index_etag() {
    let client = MockClient {
        nodes: vec![
            Node {
                path: "/Wiki/topic".to_string(),
                kind: NodeKind::Folder,
                content: String::new(),
                created_at: 1,
                updated_at: 2,
                etag: "etag-folder".to_string(),
                metadata_json: "{}".to_string(),
            },
            Node {
                path: "/Wiki/topic/index.md".to_string(),
                kind: NodeKind::File,
                content: "# Topic".to_string(),
                created_at: 1,
                updated_at: 3,
                etag: "etag-index".to_string(),
                metadata_json: "{}".to_string(),
            },
        ],
        ..Default::default()
    };

    run_command(
        &client,
        Cli {
            connection: ConnectionArgs {
                database_id: Some("default".to_string()),
                local: false,
                replica_host: None,
                canister_id: None,
                identity_mode: IdentityModeArg::Auto,
                allow_non_ii_identity: false,
            },
            command: Command::DeleteNode {
                path: "/Wiki/topic".to_string(),
                expected_etag: Some("etag-folder".to_string()),
                expected_folder_index_etag: None,
                json: true,
            },
        },
        &test_connection(),
    )
    .await
    .expect("folder delete should succeed");

    let deletes = client.deletes.lock().expect("deletes should lock");
    assert_eq!(deletes.len(), 1);
    assert_eq!(deletes[0].path, "/Wiki/topic");
    assert_eq!(deletes[0].expected_etag.as_deref(), Some("etag-folder"));
    assert_eq!(
        deletes[0].expected_folder_index_etag.as_deref(),
        Some("etag-index")
    );
}

#[tokio::test]
async fn purge_url_ingest_dry_run_does_not_delete() {
    let client = MockClient {
        nodes: url_ingest_nodes(),
        ..Default::default()
    };

    run_command(
        &client,
        Cli {
            connection: ConnectionArgs {
                database_id: Some("default".to_string()),
                local: false,
                replica_host: None,
                canister_id: None,
                identity_mode: IdentityModeArg::Auto,
                allow_non_ii_identity: false,
            },
            command: Command::PurgeUrlIngest {
                url: Some("https://example.com/page#fragment".to_string()),
                source_path: None,
                yes: false,
                force_target_prefix: None,
                json: true,
            },
        },
        &test_connection(),
    )
    .await
    .expect("dry-run purge should succeed");

    let deletes = client.deletes.lock().expect("deletes should lock");
    assert!(deletes.is_empty());
}

#[tokio::test]
async fn purge_url_ingest_requires_force_for_wide_target_delete() {
    let client = MockClient {
        nodes: url_ingest_nodes(),
        ..Default::default()
    };

    let error = run_command(
        &client,
        Cli {
            connection: ConnectionArgs {
                database_id: Some("default".to_string()),
                local: false,
                replica_host: None,
                canister_id: None,
                identity_mode: IdentityModeArg::Auto,
                allow_non_ii_identity: false,
            },
            command: Command::PurgeUrlIngest {
                url: None,
                source_path: Some("/Sources/raw/web-1/web-1.md".to_string()),
                yes: true,
                force_target_prefix: None,
                json: true,
            },
        },
        &test_connection(),
    )
    .await
    .expect_err("wide target delete should require force");

    assert!(error.to_string().contains("--force-target-prefix"));
    let deletes = client.deletes.lock().expect("deletes should lock");
    assert!(deletes.is_empty());
}

#[tokio::test]
async fn purge_url_ingest_deletes_request_source_and_generated_tree_with_etags() {
    let client = MockClient {
        nodes: url_ingest_nodes(),
        ..Default::default()
    };

    run_command(
        &client,
        Cli {
            connection: ConnectionArgs {
                database_id: Some("default".to_string()),
                local: false,
                replica_host: None,
                canister_id: None,
                identity_mode: IdentityModeArg::Auto,
                allow_non_ii_identity: false,
            },
            command: Command::PurgeUrlIngest {
                url: None,
                source_path: Some("/Sources/raw/web-1/web-1.md".to_string()),
                yes: true,
                force_target_prefix: Some("/Wiki/conversations/web-1".to_string()),
                json: true,
            },
        },
        &test_connection(),
    )
    .await
    .expect("purge should succeed");

    let deletes = client.deletes.lock().expect("deletes should lock");
    let deleted = deletes
        .iter()
        .map(|request| (request.path.as_str(), request.expected_etag.as_deref()))
        .collect::<Vec<_>>();
    assert!(deleted.contains(&("/Sources/ingest-requests/r1.md", Some("etag-request"))));
    assert!(deleted.contains(&("/Sources/raw/web-1/web-1.md", Some("etag-source"))));
    assert!(deleted.contains(&("/Wiki/conversations/web-1/facts.md", Some("etag-facts"))));
    assert!(deleted.contains(&("/Wiki/conversations/web-1", Some("etag-folder"))));
    assert!(
        !deleted
            .iter()
            .any(|(path, _)| *path == "/Wiki/conversations/web-1/index.md")
    );
    let folder_delete = deletes
        .iter()
        .find(|request| request.path == "/Wiki/conversations/web-1")
        .expect("folder delete should dispatch");
    assert_eq!(
        folder_delete.expected_folder_index_etag.as_deref(),
        Some("etag-index")
    );
}

#[tokio::test]
async fn purge_url_ingest_deletes_index_only_folder_with_folder_index_etag() {
    let mut nodes = url_ingest_nodes();
    nodes.retain(|node| node.path != "/Wiki/conversations/web-1/facts.md");
    let index = nodes
        .iter_mut()
        .find(|node| node.path == "/Wiki/conversations/web-1/index.md")
        .expect("index node should exist");
    index.etag = "etag-index-only".to_string();
    let client = MockClient {
        nodes,
        ..Default::default()
    };

    run_command(
        &client,
        Cli {
            connection: ConnectionArgs {
                database_id: Some("default".to_string()),
                local: false,
                replica_host: None,
                canister_id: None,
                identity_mode: IdentityModeArg::Auto,
                allow_non_ii_identity: false,
            },
            command: Command::PurgeUrlIngest {
                url: None,
                source_path: Some("/Sources/raw/web-1/web-1.md".to_string()),
                yes: true,
                force_target_prefix: Some("/Wiki/conversations/web-1".to_string()),
                json: true,
            },
        },
        &test_connection(),
    )
    .await
    .expect("purge should delete index-only folder");

    let deletes = client.deletes.lock().expect("deletes should lock");
    assert!(
        !deletes
            .iter()
            .any(|request| request.path == "/Wiki/conversations/web-1/index.md")
    );
    let folder_delete = deletes
        .iter()
        .find(|request| request.path == "/Wiki/conversations/web-1")
        .expect("folder delete should dispatch");
    assert_eq!(
        folder_delete.expected_folder_index_etag.as_deref(),
        Some("etag-index-only")
    );
}

#[tokio::test]
async fn purge_url_ingest_rejects_unsafe_target_paths() {
    for target_path in [
        "",
        "/",
        "/Wiki",
        "/Sources",
        "/Wiki/conversations",
        "/Wiki/sources/web-1",
        "/Wiki/conversations-web-1",
    ] {
        let client = MockClient {
            nodes: url_ingest_nodes_with_target(target_path),
            ..Default::default()
        };

        let error = run_command(
            &client,
            Cli {
                connection: ConnectionArgs {
                    database_id: Some("default".to_string()),
                    local: false,
                    replica_host: None,
                    canister_id: None,
                    identity_mode: IdentityModeArg::Auto,
                    allow_non_ii_identity: false,
                },
                command: Command::PurgeUrlIngest {
                    url: Some("https://example.com/page".to_string()),
                    source_path: None,
                    yes: false,
                    force_target_prefix: None,
                    json: true,
                },
            },
            &test_connection(),
        )
        .await
        .expect_err("unsafe target_path should fail before delete");

        let message = error.to_string();
        assert!(
            message.contains("target_path") || message.contains("protected"),
            "{target_path}: {message}"
        );
        let deletes = client.deletes.lock().expect("deletes should lock");
        assert!(deletes.is_empty());
    }
}

#[tokio::test]
async fn purge_url_ingest_rejects_prefix_bleed_from_list_nodes() {
    let mut nodes = url_ingest_nodes();
    nodes.push(Node {
        path: "/Wiki/conversations/web-1-copy/secret.md".to_string(),
        kind: NodeKind::File,
        content: "# Secret".to_string(),
        created_at: 1,
        updated_at: 9,
        etag: "etag-secret".to_string(),
        metadata_json: "{}".to_string(),
    });
    let client = MockClient {
        nodes,
        ..Default::default()
    };

    let error = run_command(
        &client,
        Cli {
            connection: ConnectionArgs {
                database_id: Some("default".to_string()),
                local: false,
                replica_host: None,
                canister_id: None,
                identity_mode: IdentityModeArg::Auto,
                allow_non_ii_identity: false,
            },
            command: Command::PurgeUrlIngest {
                url: Some("https://example.com/page".to_string()),
                source_path: None,
                yes: false,
                force_target_prefix: None,
                json: true,
            },
        },
        &test_connection(),
    )
    .await
    .expect_err("prefix bleed should fail closed");

    assert!(error.to_string().contains("outside target prefix"));
}

#[tokio::test]
async fn purge_url_ingest_rejects_request_paths_outside_ingest_prefix() {
    let mut nodes = url_ingest_nodes();
    nodes[0].path = "/Sources/ingest-requestsfake/r1.md".to_string();
    let client = MockClient {
        nodes,
        ..Default::default()
    };

    let error = run_command(
        &client,
        Cli {
            connection: ConnectionArgs {
                database_id: Some("default".to_string()),
                local: false,
                replica_host: None,
                canister_id: None,
                identity_mode: IdentityModeArg::Auto,
                allow_non_ii_identity: false,
            },
            command: Command::PurgeUrlIngest {
                url: Some("https://example.com/page".to_string()),
                source_path: None,
                yes: false,
                force_target_prefix: None,
                json: true,
            },
        },
        &test_connection(),
    )
    .await
    .expect_err("request prefix bleed should fail closed");

    assert!(error.to_string().contains("outside ingest request prefix"));
}

#[tokio::test]
async fn purge_url_ingest_rejects_noncanonical_request_source_path() {
    let mut nodes = url_ingest_nodes();
    nodes[0].content = [
        "---",
        "kind: kinic.url_ingest_request",
        "schema_version: 1",
        "status: completed",
        "url: https://example.com/page",
        "source_path: /Sources/raw/../evil.md",
        "target_path: /Wiki/conversations/web-1",
        "---",
        "",
    ]
    .join("\n");
    let client = MockClient {
        nodes,
        ..Default::default()
    };

    let error = run_command(
        &client,
        Cli {
            connection: ConnectionArgs {
                database_id: Some("default".to_string()),
                local: false,
                replica_host: None,
                canister_id: None,
                identity_mode: IdentityModeArg::Auto,
                allow_non_ii_identity: false,
            },
            command: Command::PurgeUrlIngest {
                url: Some("https://example.com/page".to_string()),
                source_path: None,
                yes: false,
                force_target_prefix: None,
                json: true,
            },
        },
        &test_connection(),
    )
    .await
    .expect_err("bad request source_path should fail");

    assert!(error.to_string().contains("source_path"));
}

#[tokio::test]
async fn purge_url_ingest_returns_error_when_delete_fails() {
    let client = MockClient {
        nodes: url_ingest_nodes(),
        delete_fail_paths: HashSet::from(["/Sources/raw/web-1/web-1.md".to_string()]),
        ..Default::default()
    };

    let error = run_command(
        &client,
        Cli {
            connection: ConnectionArgs {
                database_id: Some("default".to_string()),
                local: false,
                replica_host: None,
                canister_id: None,
                identity_mode: IdentityModeArg::Auto,
                allow_non_ii_identity: false,
            },
            command: Command::PurgeUrlIngest {
                url: None,
                source_path: Some("/Sources/raw/web-1/web-1.md".to_string()),
                yes: true,
                force_target_prefix: Some("/Wiki/conversations/web-1".to_string()),
                json: true,
            },
        },
        &test_connection(),
    )
    .await
    .expect_err("delete failure should fail the command");

    assert!(error.to_string().contains("failed to delete"));
    let deletes = client.deletes.lock().expect("deletes should lock");
    assert!(
        deletes
            .iter()
            .any(|request| request.path == "/Sources/ingest-requests/r1.md")
    );
}

#[tokio::test]
async fn purge_url_ingest_source_path_rejects_non_source_nodes() {
    let client = MockClient {
        nodes: vec![Node {
            path: "/Wiki/foo.md".to_string(),
            kind: NodeKind::File,
            content: "# Foo".to_string(),
            created_at: 1,
            updated_at: 2,
            etag: "etag-wiki".to_string(),
            metadata_json: "{}".to_string(),
        }],
        ..Default::default()
    };

    let error = run_command(
        &client,
        Cli {
            connection: ConnectionArgs {
                database_id: Some("default".to_string()),
                local: false,
                replica_host: None,
                canister_id: None,
                identity_mode: IdentityModeArg::Auto,
                allow_non_ii_identity: false,
            },
            command: Command::PurgeUrlIngest {
                url: None,
                source_path: Some("/Wiki/foo.md".to_string()),
                yes: true,
                force_target_prefix: None,
                json: true,
            },
        },
        &test_connection(),
    )
    .await
    .expect_err("invalid source-path purge should fail before delete");

    assert!(error.to_string().contains("source path must"));

    let deletes = client.deletes.lock().expect("deletes should lock");
    assert!(deletes.is_empty());
}

#[tokio::test]
async fn purge_url_ingest_source_path_requires_matching_request() {
    let client = MockClient {
        nodes: vec![Node {
            path: "/Sources/raw/web-2/web-2.md".to_string(),
            kind: NodeKind::Source,
            content: [
                "---",
                "kind: kinic.raw_web_source",
                "schema_version: 1",
                "---",
                "",
            ]
            .join("\n"),
            created_at: 1,
            updated_at: 2,
            etag: "etag-source".to_string(),
            metadata_json: "{}".to_string(),
        }],
        ..Default::default()
    };

    run_command(
        &client,
        Cli {
            connection: ConnectionArgs {
                database_id: Some("default".to_string()),
                local: false,
                replica_host: None,
                canister_id: None,
                identity_mode: IdentityModeArg::Auto,
                allow_non_ii_identity: false,
            },
            command: Command::PurgeUrlIngest {
                url: None,
                source_path: Some("/Sources/raw/web-2/web-2.md".to_string()),
                yes: true,
                force_target_prefix: None,
                json: true,
            },
        },
        &test_connection(),
    )
    .await
    .expect("orphan raw source purge should report safely");

    let deletes = client.deletes.lock().expect("deletes should lock");
    assert!(deletes.is_empty());
}

#[tokio::test]
async fn purge_url_ingest_source_path_requires_request_source_path() {
    let mut nodes = url_ingest_nodes();
    nodes[0].content = [
        "---",
        "kind: kinic.url_ingest_request",
        "schema_version: 1",
        "status: completed",
        "url: https://example.com/page",
        "target_path: /Wiki/conversations/web-1",
        "---",
        "",
    ]
    .join("\n");
    let client = MockClient {
        nodes,
        ..Default::default()
    };

    run_command(
        &client,
        Cli {
            connection: ConnectionArgs {
                database_id: Some("default".to_string()),
                local: false,
                replica_host: None,
                canister_id: None,
                identity_mode: IdentityModeArg::Auto,
                allow_non_ii_identity: false,
            },
            command: Command::PurgeUrlIngest {
                url: None,
                source_path: Some("/Sources/raw/web-1/web-1.md".to_string()),
                yes: true,
                force_target_prefix: None,
                json: true,
            },
        },
        &test_connection(),
    )
    .await
    .expect("missing request source_path should report safely");

    let deletes = client.deletes.lock().expect("deletes should lock");
    assert!(deletes.is_empty());
}

#[tokio::test]
async fn purge_url_ingest_source_path_requires_matching_request_source_path() {
    let mut nodes = url_ingest_nodes();
    nodes[0].content = [
        "---",
        "kind: kinic.url_ingest_request",
        "schema_version: 1",
        "status: completed",
        "url: https://example.com/page",
        "source_path: /Sources/raw/other/other.md",
        "target_path: /Wiki/conversations/web-1",
        "---",
        "",
    ]
    .join("\n");
    let client = MockClient {
        nodes,
        ..Default::default()
    };

    run_command(
        &client,
        Cli {
            connection: ConnectionArgs {
                database_id: Some("default".to_string()),
                local: false,
                replica_host: None,
                canister_id: None,
                identity_mode: IdentityModeArg::Auto,
                allow_non_ii_identity: false,
            },
            command: Command::PurgeUrlIngest {
                url: None,
                source_path: Some("/Sources/raw/web-1/web-1.md".to_string()),
                yes: true,
                force_target_prefix: None,
                json: true,
            },
        },
        &test_connection(),
    )
    .await
    .expect("mismatched request source_path should report safely");

    let deletes = client.deletes.lock().expect("deletes should lock");
    assert!(deletes.is_empty());
}

#[tokio::test]
async fn purge_url_ingest_source_path_uses_request_side_source_path() {
    let client = MockClient {
        nodes: url_ingest_nodes(),
        ..Default::default()
    };

    run_command(
        &client,
        Cli {
            connection: ConnectionArgs {
                database_id: Some("default".to_string()),
                local: false,
                replica_host: None,
                canister_id: None,
                identity_mode: IdentityModeArg::Auto,
                allow_non_ii_identity: false,
            },
            command: Command::PurgeUrlIngest {
                url: None,
                source_path: Some("/Sources/raw/web-1/web-1.md".to_string()),
                yes: true,
                force_target_prefix: Some("/Wiki/conversations/web-1".to_string()),
                json: true,
            },
        },
        &test_connection(),
    )
    .await
    .expect("matching request source_path should purge");

    let deletes = client.deletes.lock().expect("deletes should lock");
    assert!(
        deletes
            .iter()
            .any(|request| request.path == "/Sources/ingest-requests/r1.md")
    );
    assert!(
        deletes
            .iter()
            .any(|request| request.path == "/Sources/raw/web-1/web-1.md")
    );
    assert!(
        !deletes
            .iter()
            .any(|request| request.path == "/Wiki/conversations/web-1/index.md")
    );
    assert!(
        deletes
            .iter()
            .any(|request| request.path == "/Wiki/conversations/web-1/facts.md")
    );
    let folder_delete = deletes
        .iter()
        .find(|request| request.path == "/Wiki/conversations/web-1")
        .expect("folder delete should dispatch");
    assert_eq!(
        folder_delete.expected_folder_index_etag.as_deref(),
        Some("etag-index")
    );
}

#[tokio::test]
async fn purge_url_ingest_source_path_deletes_all_matching_requests() {
    let mut nodes = url_ingest_nodes();
    nodes.push(Node {
        path: "/Sources/ingest-requests/r2.md".to_string(),
        kind: NodeKind::File,
        content: [
            "---",
            "kind: kinic.url_ingest_request",
            "schema_version: 1",
            "status: completed",
            "url: https://example.com/page",
            "source_path: /Sources/raw/web-1/web-1.md",
            "target_path: /Wiki/conversations/web-1-copy",
            "---",
            "",
        ]
        .join("\n"),
        created_at: 1,
        updated_at: 6,
        etag: "etag-request-2".to_string(),
        metadata_json: "{}".to_string(),
    });
    let client = MockClient {
        nodes,
        ..Default::default()
    };

    run_command(
        &client,
        Cli {
            connection: ConnectionArgs {
                database_id: Some("default".to_string()),
                local: false,
                replica_host: None,
                canister_id: None,
                identity_mode: IdentityModeArg::Auto,
                allow_non_ii_identity: false,
            },
            command: Command::PurgeUrlIngest {
                url: None,
                source_path: Some("/Sources/raw/web-1/web-1.md".to_string()),
                yes: true,
                force_target_prefix: Some("/Wiki/conversations/web-1".to_string()),
                json: true,
            },
        },
        &test_connection(),
    )
    .await
    .expect("source-path purge should delete all matching requests");

    let deletes = client.deletes.lock().expect("deletes should lock");
    assert!(
        deletes
            .iter()
            .any(|request| request.path == "/Sources/ingest-requests/r1.md")
    );
    assert!(
        deletes
            .iter()
            .any(|request| request.path == "/Sources/ingest-requests/r2.md")
    );
    assert!(
        deletes
            .iter()
            .any(|request| request.path == "/Sources/raw/web-1/web-1.md")
    );
}

fn url_ingest_nodes() -> Vec<Node> {
    vec![
        Node {
            path: "/Sources/ingest-requests/r1.md".to_string(),
            kind: NodeKind::File,
            content: [
                "---",
                "kind: kinic.url_ingest_request",
                "schema_version: 1",
                "status: completed",
                "url: https://example.com/page",
                "source_path: /Sources/raw/web-1/web-1.md",
                "target_path: /Wiki/conversations/web-1",
                "---",
                "",
            ]
            .join("\n"),
            created_at: 1,
            updated_at: 2,
            etag: "etag-request".to_string(),
            metadata_json: "{}".to_string(),
        },
        Node {
            path: "/Sources/raw/web-1/web-1.md".to_string(),
            kind: NodeKind::Source,
            content: [
                "---",
                "kind: kinic.raw_web_source",
                "schema_version: 1",
                "---",
                "",
            ]
            .join("\n"),
            created_at: 1,
            updated_at: 3,
            etag: "etag-source".to_string(),
            metadata_json: "{}".to_string(),
        },
        Node {
            path: "/Wiki/conversations/web-1".to_string(),
            kind: NodeKind::Folder,
            content: "".to_string(),
            created_at: 1,
            updated_at: 4,
            etag: "etag-folder".to_string(),
            metadata_json: "{}".to_string(),
        },
        Node {
            path: "/Wiki/conversations/web-1/index.md".to_string(),
            kind: NodeKind::File,
            content: "# Index".to_string(),
            created_at: 1,
            updated_at: 4,
            etag: "etag-index".to_string(),
            metadata_json: "{}".to_string(),
        },
        Node {
            path: "/Wiki/conversations/web-1/facts.md".to_string(),
            kind: NodeKind::File,
            content: "# Facts".to_string(),
            created_at: 1,
            updated_at: 5,
            etag: "etag-facts".to_string(),
            metadata_json: "{}".to_string(),
        },
    ]
}

fn url_ingest_nodes_with_target(target_path: &str) -> Vec<Node> {
    let mut nodes = url_ingest_nodes();
    nodes[0].content = [
        "---",
        "kind: kinic.url_ingest_request",
        "schema_version: 1",
        "status: completed",
        "url: https://example.com/page",
        "source_path: /Sources/raw/web-1/web-1.md",
        &format!(
            "target_path: {}",
            serde_json::to_string(target_path).expect("target should encode")
        ),
        "---",
        "",
    ]
    .join("\n");
    nodes
}
