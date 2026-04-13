use crate::client::WikiApi;
use crate::commands::{pull, push};
use crate::mirror::{
    MirrorState, conflict_file_path, load_state, parse_managed_metadata,
    tracked_nodes_from_snapshot, write_node_mirror,
};
use anyhow::{Result, anyhow};
use async_trait::async_trait;
use std::path::PathBuf;
use std::sync::Mutex;
use tempfile::tempdir;
use wiki_types::{
    AppendNodeRequest, DeleteNodeRequest, DeleteNodeResult, EditNodeRequest, EditNodeResult,
    ExportSnapshotRequest, ExportSnapshotResponse, FetchUpdatesRequest, FetchUpdatesResponse,
    GlobNodeHit, GlobNodesRequest, ListNodesRequest, MkdirNodeRequest, MkdirNodeResult,
    MoveNodeRequest, MoveNodeResult, MultiEditNodeRequest, MultiEditNodeResult, Node, NodeEntry,
    NodeKind, NodeMutationAck, RecentNodeHit, RecentNodesRequest, SearchNodeHit,
    SearchNodePathsRequest, SearchNodesRequest, Status, WriteNodeRequest, WriteNodeResult,
};

struct SyncMockClient {
    snapshot_nodes: Vec<Node>,
    fetch_response: Mutex<FetchUpdatesResponse>,
    fail_write: bool,
}
#[async_trait]
impl WikiApi for SyncMockClient {
    async fn status(&self) -> Result<Status> {
        Ok(Status {
            file_count: 0,
            source_count: 0,
        })
    }

    async fn read_node(&self, _path: &str) -> Result<Option<Node>> {
        Ok(None)
    }
    async fn list_nodes(&self, _request: ListNodesRequest) -> Result<Vec<NodeEntry>> {
        Ok(Vec::new())
    }
    async fn append_node(&self, _request: AppendNodeRequest) -> Result<WriteNodeResult> {
        unreachable!()
    }
    async fn edit_node(&self, _request: EditNodeRequest) -> Result<EditNodeResult> {
        unreachable!()
    }
    async fn mkdir_node(&self, _request: MkdirNodeRequest) -> Result<MkdirNodeResult> {
        unreachable!()
    }
    async fn move_node(&self, _request: MoveNodeRequest) -> Result<MoveNodeResult> {
        unreachable!()
    }
    async fn glob_nodes(&self, _request: GlobNodesRequest) -> Result<Vec<GlobNodeHit>> {
        Ok(Vec::new())
    }
    async fn recent_nodes(&self, _request: RecentNodesRequest) -> Result<Vec<RecentNodeHit>> {
        Ok(Vec::new())
    }
    async fn multi_edit_node(&self, _request: MultiEditNodeRequest) -> Result<MultiEditNodeResult> {
        unreachable!()
    }
    async fn search_nodes(&self, _request: SearchNodesRequest) -> Result<Vec<SearchNodeHit>> {
        Ok(Vec::new())
    }
    async fn search_node_paths(
        &self,
        _request: SearchNodePathsRequest,
    ) -> Result<Vec<SearchNodeHit>> {
        Ok(Vec::new())
    }
    async fn write_node(&self, request: WriteNodeRequest) -> Result<WriteNodeResult> {
        if self.fail_write {
            return Err(anyhow!(
                "expected_etag does not match current etag: {}",
                request.path
            ));
        }
        Ok(WriteNodeResult {
            created: false,
            node: NodeMutationAck {
                path: request.path,
                kind: request.kind,
                updated_at: 2,
                etag: "etag-write".to_string(),
            },
        })
    }

    async fn delete_node(&self, request: DeleteNodeRequest) -> Result<DeleteNodeResult> {
        Ok(DeleteNodeResult { path: request.path })
    }
    async fn export_snapshot(
        &self,
        _request: ExportSnapshotRequest,
    ) -> Result<ExportSnapshotResponse> {
        Ok(ExportSnapshotResponse {
            snapshot_revision: "snap-initial".to_string(),
            nodes: self.snapshot_nodes.clone(),
        })
    }
    async fn fetch_updates(&self, _request: FetchUpdatesRequest) -> Result<FetchUpdatesResponse> {
        Ok(self
            .fetch_response
            .lock()
            .expect("fetch response should lock")
            .clone())
    }
}

#[tokio::test]
async fn push_writes_conflict_file_when_remote_write_rejects() {
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
    write_node_mirror(&root, &initial).expect("mirror write should succeed");
    crate::mirror::save_state(
        &root,
        &MirrorState {
            snapshot_revision: "snap-1".to_string(),
            last_synced_at: 0,
            tracked_nodes: tracked_nodes_from_snapshot(std::slice::from_ref(&initial)),
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
            "# Foo\n\nedited body",
        ),
    )
    .expect("edited mirror file should write");

    let client = SyncMockClient {
        snapshot_nodes: vec![initial.clone()],
        fetch_response: Mutex::new(FetchUpdatesResponse {
            snapshot_revision: "snap-2".to_string(),
            changed_nodes: vec![initial],
            removed_paths: Vec::new(),
        }),
        fail_write: true,
    };

    push(&client, &root).await.expect("push should succeed");

    let conflict = std::fs::read_to_string(
        conflict_file_path(&root, "/Wiki/foo.md").expect("conflict path should build"),
    )
    .expect("conflict file should exist");
    assert!(conflict.contains("edited body"));
    let state = load_state(&root).expect("state should load");
    assert_eq!(state.snapshot_revision, "snap-2");
}

#[tokio::test]
async fn push_keeps_conflicts_for_same_basename_under_different_paths() {
    let dir = tempdir().expect("tempdir should create");
    let root = PathBuf::from(dir.path()).join("Wiki");
    let first = sync_node("/Wiki/a/foo.md", "# A", "etag-a");
    let second = sync_node("/Wiki/b/foo.md", "# B", "etag-b");
    write_node_mirror(&root, &first).expect("first mirror write should succeed");
    write_node_mirror(&root, &second).expect("second mirror write should succeed");
    crate::mirror::save_state(
        &root,
        &MirrorState {
            snapshot_revision: "snap-1".to_string(),
            last_synced_at: 0,
            tracked_nodes: tracked_nodes_from_snapshot(&[first.clone(), second.clone()]),
        },
    )
    .expect("state should save");
    std::fs::write(
        root.join("a/foo.md"),
        crate::mirror::serialize_mirror_file(
            &crate::mirror::MirrorFrontmatter {
                path: first.path.clone(),
                kind: NodeKind::File,
                etag: first.etag.clone(),
                updated_at: 2,
                mirror: true,
            },
            "# A\n\nedited a",
        ),
    )
    .expect("edited mirror file should write");
    std::fs::write(
        root.join("b/foo.md"),
        crate::mirror::serialize_mirror_file(
            &crate::mirror::MirrorFrontmatter {
                path: second.path.clone(),
                kind: NodeKind::File,
                etag: second.etag.clone(),
                updated_at: 2,
                mirror: true,
            },
            "# B\n\nedited b",
        ),
    )
    .expect("edited mirror file should write");

    let client = SyncMockClient {
        snapshot_nodes: vec![first.clone(), second.clone()],
        fetch_response: Mutex::new(FetchUpdatesResponse {
            snapshot_revision: "snap-2".to_string(),
            changed_nodes: vec![first, second],
            removed_paths: Vec::new(),
        }),
        fail_write: true,
    };

    push(&client, &root).await.expect("push should succeed");

    let first_conflict = std::fs::read_to_string(
        conflict_file_path(&root, "/Wiki/a/foo.md").expect("first conflict path should build"),
    )
    .expect("first conflict file should exist");
    let second_conflict = std::fs::read_to_string(
        conflict_file_path(&root, "/Wiki/b/foo.md").expect("second conflict path should build"),
    )
    .expect("second conflict file should exist");
    assert!(first_conflict.contains("edited a"));
    assert!(second_conflict.contains("edited b"));
}

#[test]
fn conflict_file_path_uses_short_stem_and_stable_hash() {
    let root = PathBuf::from("/tmp/Wiki");
    let ascii = conflict_file_path(&root, "/Wiki/a/foo.md").expect("path should build");
    let unicode = conflict_file_path(&root, "/Wiki/日本/foo.md").expect("path should build");
    let emoji = conflict_file_path(&root, "/Wiki/emoji/😀.md").expect("path should build");

    let ascii_name = ascii
        .file_name()
        .and_then(|value| value.to_str())
        .expect("ascii name should be utf-8");
    let unicode_name = unicode
        .file_name()
        .and_then(|value| value.to_str())
        .expect("unicode name should be utf-8");
    let emoji_name = emoji
        .file_name()
        .and_then(|value| value.to_str())
        .expect("emoji name should be utf-8");

    assert!(ascii_name.starts_with("a__foo--"));
    assert!(unicode_name.starts_with("foo--"));
    assert!(emoji_name.starts_with("emoji--"));
    assert!(ascii_name.ends_with(".conflict.md"));
    assert!(unicode_name.ends_with(".conflict.md"));
    assert!(emoji_name.ends_with(".conflict.md"));
    assert_ne!(ascii_name, unicode_name);
    assert_ne!(unicode_name, emoji_name);
}

#[test]
fn conflict_file_path_stays_within_component_limit() {
    let root = PathBuf::from("/tmp/Wiki");
    let long_parent = "deep".repeat(100);
    let long_name = "emoji😀".repeat(100);
    let remote_path = format!("/Wiki/{long_parent}/{long_name}.md");
    let conflict_path =
        conflict_file_path(&root, &remote_path).expect("long conflict path should build");
    let file_name = conflict_path
        .file_name()
        .and_then(|value| value.to_str())
        .expect("conflict file name should be utf-8");
    assert!(file_name.len() <= 255);
    assert!(file_name.contains("--"));
    assert!(file_name.ends_with(".conflict.md"));
}

#[tokio::test]
async fn pull_removes_stale_paths_and_refreshes_tracked_state() {
    let dir = tempdir().expect("tempdir should create");
    let root = PathBuf::from(dir.path()).join("Wiki");
    std::fs::create_dir_all(&root).expect("mirror root should exist");
    let stale = Node {
        path: "/Wiki/stale.md".to_string(),
        kind: NodeKind::File,
        content: "# Stale".to_string(),
        created_at: 1,
        updated_at: 2,
        etag: "etag-stale".to_string(),
        metadata_json: "{}".to_string(),
    };
    write_node_mirror(&root, &stale).expect("mirror write should succeed");
    crate::mirror::save_state(
        &root,
        &MirrorState {
            snapshot_revision: "snap-1".to_string(),
            last_synced_at: 0,
            tracked_nodes: tracked_nodes_from_snapshot(std::slice::from_ref(&stale)),
        },
    )
    .expect("state should save");
    let fresh = Node {
        path: "/Wiki/fresh.md".to_string(),
        kind: NodeKind::File,
        content: "# Fresh".to_string(),
        created_at: 1,
        updated_at: 3,
        etag: "etag-fresh".to_string(),
        metadata_json: "{}".to_string(),
    };
    let client = SyncMockClient {
        snapshot_nodes: Vec::new(),
        fetch_response: Mutex::new(FetchUpdatesResponse {
            snapshot_revision: "snap-2".to_string(),
            changed_nodes: vec![fresh.clone()],
            removed_paths: vec!["/Wiki/stale.md".to_string()],
        }),
        fail_write: false,
    };

    pull(&client, &root).await.expect("pull should succeed");

    assert!(!root.join("stale.md").exists());
    let fresh_content =
        std::fs::read_to_string(root.join("fresh.md")).expect("fresh mirror file should exist");
    let metadata = parse_managed_metadata(&fresh_content).expect("frontmatter should parse");
    assert_eq!(metadata.etag, "etag-fresh");
    let state = load_state(&root).expect("state should load");
    assert_eq!(state.snapshot_revision, "snap-2");
    assert_eq!(state.tracked_nodes.len(), 1);
    assert_eq!(state.tracked_nodes[0].path, fresh.path);
}

fn sync_node(path: &str, content: &str, etag: &str) -> Node {
    Node {
        path: path.to_string(),
        kind: NodeKind::File,
        content: content.to_string(),
        created_at: 1,
        updated_at: 2,
        etag: etag.to_string(),
        metadata_json: "{}".to_string(),
    }
}
