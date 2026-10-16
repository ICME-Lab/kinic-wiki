//! The client boundary uses a real SQLite store; only transport failure is injected.
use super::*;
use anyhow::{Result, anyhow};
use async_trait::async_trait;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use vfs_client::VfsApi;
use vfs_store::FsStore;
use vfs_types::*;

pub(crate) struct StoreClient {
    pub(crate) store: FsStore,
    deny: AtomicBool,
    fail_after_write: AtomicBool,
    pub(crate) fail_after_publication: AtomicBool,
    fail_after_batch: AtomicBool,
    pub(crate) writes: AtomicUsize,
    pub(crate) batch_writes: AtomicUsize,
}
impl StoreClient {
    pub(crate) fn new(path: &std::path::Path) -> Self {
        let store = FsStore::new(path.join("wiki.sqlite"));
        store.run_fs_migrations().unwrap();
        Self {
            store,
            deny: AtomicBool::new(false),
            fail_after_write: AtomicBool::new(false),
            fail_after_publication: AtomicBool::new(false),
            fail_after_batch: AtomicBool::new(false),
            writes: AtomicUsize::new(0),
            batch_writes: AtomicUsize::new(0),
        }
    }
}
#[async_trait]
impl VfsApi for StoreClient {
    fn caller_principal(&self) -> Option<String> {
        Some("principal".into())
    }
    async fn status(&self, _: &str) -> Result<Status> {
        if self.deny.load(Ordering::SeqCst) {
            return Err(anyhow!("read revoked"));
        }
        self.store.status().map_err(|e| anyhow!(e))
    }
    async fn scope_revision(&self, request: ScopeRevisionRequest) -> Result<u64> {
        self.status(&request.database_id).await?;
        self.store
            .scope_revision(&request.prefix)
            .map_err(|error| anyhow!(error))
    }
    async fn check_database_write_cycles(&self, _: &str) -> Result<()> {
        self.status("db").await?;
        Ok(())
    }
    async fn read_node(&self, _: &str, p: &str) -> Result<Option<Node>> {
        self.status("db").await?;
        self.store.read_node(p).map_err(|e| anyhow!(e))
    }
    async fn list_nodes(&self, r: ListNodesRequest) -> Result<Vec<NodeEntry>> {
        self.store.list_nodes(r).map_err(|e| anyhow!(e))
    }
    async fn list_children(&self, r: ListChildrenRequest) -> Result<Vec<ChildNode>> {
        self.store.list_children(r).map_err(|e| anyhow!(e))
    }
    async fn write_nodes(&self, r: WriteNodesRequest) -> Result<Vec<WriteNodeResult>> {
        self.batch_writes.fetch_add(1, Ordering::SeqCst);
        let result = self
            .store
            .write_nodes(r, 10)
            .map_err(|e| anyhow!("{e:?}"))?;
        if self.fail_after_batch.swap(false, Ordering::SeqCst) {
            return Err(anyhow!("lost batch response"));
        }
        Ok(result)
    }
    async fn write_node(&self, r: WriteNodeRequest) -> Result<WriteNodeResult> {
        self.writes.fetch_add(1, Ordering::SeqCst);
        let result = self.store.write_node(r, 10).map_err(|e| anyhow!("{e:?}"))?;
        if self.fail_after_write.swap(false, Ordering::SeqCst) {
            return Err(anyhow!("lost transport response"));
        }
        Ok(result)
    }
    async fn append_node(&self, r: AppendNodeRequest) -> Result<WriteNodeResult> {
        self.store.append_node(r, 10).map_err(|e| anyhow!("{e:?}"))
    }
    async fn edit_node(&self, r: EditNodeRequest) -> Result<EditNodeResult> {
        self.store.edit_node(r, 10).map_err(|e| anyhow!("{e:?}"))
    }
    async fn delete_node(&self, r: DeleteNodeRequest) -> Result<DeleteNodeResult> {
        self.store.delete_node(r, 10).map_err(|e| anyhow!("{e:?}"))
    }
    async fn move_node(&self, r: MoveNodeRequest) -> Result<MoveNodeResult> {
        self.store.move_node(r, 10).map_err(|e| anyhow!("{e:?}"))
    }
    async fn mkdir_node(&self, r: MkdirNodeRequest) -> Result<MkdirNodeResult> {
        self.store.mkdir_node(r, 10).map_err(|e| anyhow!("{e:?}"))
    }
    async fn glob_nodes(&self, r: GlobNodesRequest) -> Result<Vec<GlobNodeHit>> {
        self.store.glob_nodes(r).map_err(|e| anyhow!(e))
    }
    async fn multi_edit_node(&self, r: MultiEditNodeRequest) -> Result<MultiEditNodeResult> {
        self.store
            .multi_edit_node(r, 10)
            .map_err(|e| anyhow!("{e:?}"))
    }
    async fn search_nodes(&self, r: SearchNodesRequest) -> Result<Vec<SearchNodeHit>> {
        self.store.search_nodes(r).map_err(|e| anyhow!(e))
    }
    async fn search_node_paths(&self, r: SearchNodePathsRequest) -> Result<Vec<SearchNodeHit>> {
        self.store.search_node_paths(r).map_err(|e| anyhow!(e))
    }
    async fn export_snapshot(&self, r: ExportSnapshotRequest) -> Result<ExportSnapshotResponse> {
        self.store.export_snapshot(r).map_err(|e| anyhow!(e))
    }
    async fn fetch_updates(&self, r: FetchUpdatesRequest) -> Result<FetchUpdatesResponse> {
        self.store.fetch_updates(r).map_err(|e| anyhow!(e))
    }
    async fn current_node_revision(&self, r: NodeRevisionRequest) -> Result<Option<NodeRevision>> {
        self.store
            .current_node_revision(&r.path)
            .map_err(|e| anyhow!(e))
    }
    async fn node_history(&self, r: NodeHistoryRequest) -> Result<NodeHistoryPage> {
        self.store.node_history(r).map_err(|e| anyhow!(e))
    }
    async fn publish_learning(
        &self,
        r: LearningPublicationRequest,
    ) -> Result<LearningPublicationResult> {
        {
            let result = self
                .store
                .publish_learning(r, 11)
                .map_err(|e| anyhow!("{e:?}"))?;
            if self.fail_after_publication.swap(false, Ordering::SeqCst) {
                return Err(anyhow!("lost publication response"));
            }
            Ok(result)
        }
    }
}
fn outbox_events(count: usize, runs: usize) -> Vec<Event> {
    (0..count)
        .map(|i| Event {
            id: format!("e{i}"),
            run_id: format!("r{}", i % runs),
            kind: "hook".into(),
            payload: serde_json::json!({"n":i}),
        })
        .collect()
}
#[tokio::test]
async fn outbox_backlog_is_sent_in_one_batched_update() {
    let dir = tempfile::tempdir().unwrap();
    let client = StoreClient::new(dir.path());
    let outbox = Outbox::open(&dir.path().join("local"), "c", "db", "p").unwrap();
    let events = outbox_events(12, 3);
    for event in &events {
        outbox.enqueue(event).unwrap();
    }
    assert_eq!(outbox.flush(&client, "db").await.unwrap(), 12);
    assert_eq!(client.batch_writes.load(Ordering::SeqCst), 1);
    assert_eq!(
        client.writes.load(Ordering::SeqCst),
        0,
        "no per-event writes"
    );
    assert_eq!(outbox.pending_count().unwrap(), 0);
    for event in &events {
        let node = client
            .store
            .read_node(&outbox::evidence_path(event))
            .unwrap()
            .unwrap();
        assert_eq!(node.content, serde_json::to_string(event).unwrap());
        assert_eq!(node.kind, NodeKind::Source);
    }
    assert_eq!(outbox.flush(&client, "db").await.unwrap(), 0);
}
#[tokio::test]
async fn outbox_lost_batch_response_and_partial_remote_state_fall_back_to_verification() {
    let dir = tempfile::tempdir().unwrap();
    let client = StoreClient::new(dir.path());
    let outbox = Outbox::open(&dir.path().join("local"), "c", "db", "p").unwrap();
    let events = outbox_events(4, 2);
    for event in &events {
        outbox.enqueue(event).unwrap();
    }
    client.fail_after_batch.store(true, Ordering::SeqCst);
    assert_eq!(outbox.flush(&client, "db").await.unwrap(), 4);
    assert_eq!(outbox.pending_count().unwrap(), 0);
    // An event that landed before its acknowledgement was lost makes the atomic
    // create-only batch fail; verification still sends the remaining events.
    let more = outbox_events(6, 2);
    for event in &more {
        outbox.enqueue(event).unwrap();
    }
    client
        .store
        .write_node(
            WriteNodeRequest {
                database_id: "db".into(),
                path: outbox::evidence_path(&more[5]),
                kind: NodeKind::Source,
                content: serde_json::to_string(&more[5]).unwrap(),
                metadata_json: "{}".into(),
                expected_etag: None,
            },
            10,
        )
        .unwrap();
    assert_eq!(outbox.flush(&client, "db").await.unwrap(), 2);
    assert_eq!(outbox.pending_count().unwrap(), 0);
}
#[tokio::test]
async fn outbox_batch_never_overwrites_conflicting_remote_evidence() {
    let dir = tempfile::tempdir().unwrap();
    let client = StoreClient::new(dir.path());
    let outbox = Outbox::open(&dir.path().join("local"), "c", "db", "p").unwrap();
    let events = outbox_events(3, 1);
    for event in &events {
        outbox.enqueue(event).unwrap();
    }
    outbox.flush(&client, "db").await.unwrap();
    let conflicting = Event {
        id: "late".into(),
        run_id: "r0".into(),
        kind: "hook".into(),
        payload: serde_json::json!({"local":true}),
    };
    client
        .store
        .write_node(
            WriteNodeRequest {
                database_id: "db".into(),
                path: outbox::evidence_path(&conflicting),
                kind: NodeKind::Source,
                content: "{\"remote\":true}".into(),
                metadata_json: "{}".into(),
                expected_etag: None,
            },
            10,
        )
        .unwrap();
    outbox.enqueue(&conflicting).unwrap();
    let error = outbox.flush(&client, "db").await.unwrap_err();
    assert!(error.to_string().contains("conflicts"), "{error:#}");
    assert_eq!(outbox.pending_count().unwrap(), 1);
    let node = client
        .store
        .read_node(&outbox::evidence_path(&conflicting))
        .unwrap()
        .unwrap();
    assert_eq!(node.content, "{\"remote\":true}");
}
#[tokio::test]
async fn outbox_recovers_ambiguous_success_and_does_not_duplicate_remote_evidence() {
    let dir = tempfile::tempdir().unwrap();
    let client = StoreClient::new(dir.path());
    let outbox = Outbox::open(&dir.path().join("local"), "c", "db", "p").unwrap();
    let event = Event {
        id: "e1".into(),
        run_id: "r1".into(),
        kind: "outcome".into(),
        payload: serde_json::json!({"complete":false}),
    };
    outbox.enqueue(&event).unwrap();
    client.fail_after_write.store(true, Ordering::SeqCst);
    assert_eq!(outbox.flush(&client, "db").await.unwrap(), 1);
    assert_eq!(outbox.flush(&client, "db").await.unwrap(), 0);
    assert!(outbox.pending().unwrap().is_empty());
    let nodes = client
        .store
        .list_nodes(ListNodesRequest {
            database_id: "db".into(),
            prefix: "/Sources/learning-runs".into(),
            recursive: true,
            limit: 100,
        })
        .unwrap();
    assert_eq!(
        nodes.iter().filter(|n| n.path.ends_with(".json")).count(),
        1
    );
}
#[tokio::test]
async fn recall_overlay_is_budgeted_and_does_not_pollute_live_index_or_ignore_revocation() {
    let dir = tempfile::tempdir().unwrap();
    let client = StoreClient::new(dir.path());
    let node = client
        .store
        .write_node(
            WriteNodeRequest {
                database_id: "db".into(),
                path: "/Knowledge/rust.md".into(),
                kind: NodeKind::File,
                content: "rust tests: old advice".into(),
                metadata_json: "{\"authority\":\"agent\"}".into(),
                expected_etag: None,
            },
            1,
        )
        .unwrap();
    let opts:RecallOptions=serde_json::from_value(serde_json::json!({"task":"rust tests","budget_tokens":200,"state_dir":dir.path().join("cache"),"endpoint":"c","principal":"p","graph":false})).unwrap();
    let receipt = recall(&client, "db", "run", &opts).await.unwrap();
    assert_eq!(receipt.supplied.len(), 1);
    assert!(receipt.rendered.contains("old advice"));
    let replacement = WriteNodeItem {
        path: "/Knowledge/rust.md".into(),
        kind: NodeKind::File,
        content: format!("rust tests: new advice {}", "x".repeat(3000)),
        metadata_json: "{\"authority\":\"agent\"}".into(),
        expected_etag: Some(node.node.etag),
    };
    let revised = recall_overlay(
        &client,
        "db",
        "run",
        &opts,
        std::slice::from_ref(&replacement),
    )
    .await
    .unwrap();
    assert!(revised.rendered.chars().count() <= 800);
    assert!(revised.truncated);
    assert!(revised.rendered.contains("new advice"));
    let again = recall(&client, "db", "run", &opts).await.unwrap();
    assert!(again.rendered.contains("old advice"));
    let excluded = WriteNodeItem {
        metadata_json: "{\"authority\":\"agent\",\"exceptions\":[\"rust\"]}".into(),
        ..replacement
    };
    assert!(
        recall_overlay(&client, "db", "run", &opts, &[excluded])
            .await
            .unwrap()
            .supplied
            .is_empty()
    );
    client.deny.store(true, Ordering::SeqCst);
    assert!(recall(&client, "db", "run", &opts).await.is_err());
}

#[tokio::test]
async fn overlay_link_changes_and_invalidations_equal_published_recall() {
    let dir = tempfile::tempdir().unwrap();
    let client = StoreClient::new(dir.path());
    let mut nodes = vec![];
    for (path, content) in [
        ("/Knowledge/a.md", "rust root [support](/Knowledge/b.md)"),
        ("/Knowledge/b.md", "previous supporting advice"),
        ("/Knowledge/c.md", "replacement supporting advice"),
    ] {
        client
            .store
            .write_node(
                WriteNodeRequest {
                    database_id: "db".into(),
                    path: path.into(),
                    kind: NodeKind::File,
                    content: content.into(),
                    metadata_json: "{\"authority\":\"agent\"}".into(),
                    expected_etag: None,
                },
                1,
            )
            .unwrap();
        nodes.push(client.store.read_node(path).unwrap().unwrap());
    }
    let opts:RecallOptions=serde_json::from_value(serde_json::json!({"task":"rust","budget_tokens":1000,"state_dir":dir.path().join("cache"),"endpoint":"c","principal":"p","graph":true})).unwrap();
    let before = recall(&client, "db", "r", &opts).await.unwrap();
    assert!(before.supplied.iter().any(|n| n.path == "/Knowledge/b.md"));
    let targets = vec![
        WriteNodeItem {
            path: nodes[0].path.clone(),
            kind: NodeKind::File,
            content: "rust root [replacement](/Knowledge/c.md)".into(),
            metadata_json: nodes[0].metadata_json.clone(),
            expected_etag: Some(nodes[0].etag.clone()),
        },
        WriteNodeItem {
            path: nodes[1].path.clone(),
            kind: NodeKind::File,
            content: nodes[1].content.clone(),
            metadata_json: "{\"authority\":\"agent\",\"state\":\"invalidated\"}".into(),
            expected_etag: Some(nodes[1].etag.clone()),
        },
    ];
    let preview = recall_overlay(&client, "db", "r", &opts, &targets)
        .await
        .unwrap();
    assert!(preview.supplied.iter().any(|n| n.path == "/Knowledge/c.md"));
    assert!(!preview.supplied.iter().any(|n| n.path == "/Knowledge/b.md"));
    client
        .publish_learning(LearningPublicationRequest {
            scope_guards: vec![],
            database_id: "db".into(),
            operation_id: "links".into(),
            targets,
            evidence: vec![],
        })
        .await
        .unwrap();
    let published = recall(&client, "db", "r", &opts).await.unwrap();
    assert_eq!(preview.rendered, published.rendered);
}

#[cfg(unix)]
#[test]
fn retrieval_cache_is_private_without_outbox_initialization() {
    use std::os::unix::fs::PermissionsExt;
    let parent = tempfile::tempdir().unwrap();
    let root = parent.path().join("new-state");
    let index = RetrievalIndex::open(&root, "c", "db", "p", "model").unwrap();
    index
        .upsert("private", "etag", "confidential", &[])
        .unwrap();
    assert_eq!(
        std::fs::metadata(&root).unwrap().permissions().mode() & 0o777,
        0o700
    );
    for entry in std::fs::read_dir(&root).unwrap() {
        assert_eq!(
            entry.unwrap().metadata().unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}

#[tokio::test]
async fn portable_recall_fuses_selected_scopes_without_other_project_or_budget_leak() {
    let dir = tempfile::tempdir().unwrap();
    let client = StoreClient::new(dir.path());
    for path in [
        "/Knowledge/projects",
        "/Knowledge/projects/a",
        "/Knowledge/projects/b",
        "/Knowledge/common",
        "/Knowledge/commonly",
    ] {
        client
            .store
            .mkdir_node(
                MkdirNodeRequest {
                    database_id: "db".into(),
                    path: path.into(),
                },
                1,
            )
            .unwrap();
    }

    for (path, body) in [
        (
            "/Knowledge/projects/a/lesson.md",
            "rust project a [common](/Knowledge/common/lesson.md) [outside](/Knowledge/projects/b/lesson.md)",
        ),
        ("/Knowledge/projects/b/lesson.md", "rust secret project b"),
        ("/Knowledge/common/lesson.md", "shared supporting common"),
        ("/Knowledge/commonly/hidden.md", "rust sibling secret"),
    ] {
        client
            .store
            .write_node(
                WriteNodeRequest {
                    database_id: "db".into(),
                    path: path.into(),
                    kind: NodeKind::File,
                    content: body.repeat(100),
                    metadata_json: "{\"authority\":\"agent\"}".into(),
                    expected_etag: None,
                },
                1,
            )
            .unwrap();
    }
    let mut options: RecallOptions = serde_json::from_value(serde_json::json!({
        "project_id":"a", "namespace":"/Knowledge/projects/a", "read_scopes":["/Knowledge/common/", "/Knowledge/common"],
        "task":"rust", "budget_tokens":200, "state_dir":dir.path().join("cache"), "endpoint":"c", "principal":"p"
    })).unwrap();
    let a = recall(&client, "db", "a-run", &options).await.unwrap();
    assert_eq!(a.candidates.len(), 2, "all scopes must rank together");
    assert!(
        a.candidates
            .iter()
            .any(|p| p.starts_with("/Knowledge/common/"))
    );
    assert!(!a.rendered.contains("secret"));
    assert!(a.rendered.chars().count() <= 800, "one total budget");
    let serialized = serde_json::to_value(&a).unwrap();
    assert_eq!(serialized["project_id"], "a");
    assert_eq!(serialized["scope_guards"].as_array().unwrap().len(), 2);
    let files_a = std::fs::read_dir(&options.state_dir).unwrap().count();
    options.project_id = Some("same-scope-different-project".into());
    recall(&client, "db", "other-project", &options)
        .await
        .unwrap();
    let files_other_project = std::fs::read_dir(&options.state_dir).unwrap().count();
    assert!(
        files_other_project > files_a,
        "project identity partitions an otherwise identical cache"
    );
    options.project_id = Some("b".into());
    options.namespace = "/Knowledge/projects/b".into();
    let b = recall(&client, "db", "b-run", &options).await.unwrap();
    assert!(
        b.candidates
            .iter()
            .all(|p| !p.starts_with("/Knowledge/projects/a/"))
    );
    assert!(std::fs::read_dir(&options.state_dir).unwrap().count() > files_other_project);
    let common = client
        .store
        .read_node("/Knowledge/common/lesson.md")
        .unwrap()
        .unwrap();
    client
        .store
        .write_node(
            WriteNodeRequest {
                database_id: "db".into(),
                path: common.path,
                kind: common.kind,
                content: "rust revised shared knowledge".into(),
                metadata_json: common.metadata_json,
                expected_etag: Some(common.etag),
            },
            2,
        )
        .unwrap();
    let next = recall(&client, "db", "b-run2", &options).await.unwrap();
    let before = serialized["scope_guards"]
        .as_array()
        .unwrap()
        .iter()
        .find(|g| g["prefix"] == "/Knowledge/common")
        .unwrap();
    let after = serde_json::to_value(&next).unwrap();
    let after = after["scope_guards"]
        .as_array()
        .unwrap()
        .iter()
        .find(|g| g["prefix"] == "/Knowledge/common")
        .unwrap();
    assert_ne!(before["revision"], after["revision"]);
    let target = client
        .store
        .read_node("/Knowledge/projects/a/lesson.md")
        .unwrap()
        .unwrap();
    assert!(
        client
            .publish_learning(LearningPublicationRequest {
                database_id: "db".into(),
                operation_id: "stale-common".into(),
                scope_guards: a.scope_guards,
                targets: vec![WriteNodeItem {
                    path: target.path,
                    kind: target.kind,
                    content: "rust refined".into(),
                    metadata_json: target.metadata_json,
                    expected_etag: Some(target.etag)
                }],
                evidence: vec![],
            })
            .await
            .is_err(),
        "changes to common knowledge invalidate an otherwise unchanged project candidate"
    );

    options.max_index_nodes = 1;
    assert!(
        recall(&client, "db", "limited", &options)
            .await
            .unwrap_err()
            .to_string()
            .contains("node budget")
    );
}

#[tokio::test]
async fn portable_recall_rejects_ambiguous_scope_boundaries_and_outside_overlays() {
    let dir = tempfile::tempdir().unwrap();
    let client = StoreClient::new(dir.path());
    let mut opts:RecallOptions=serde_json::from_value(serde_json::json!({"namespace":"/Knowledge/projects/a","read_scopes":["/Knowledge/common"],"task":"rust","budget_tokens":100,"state_dir":dir.path().join("cache")})).unwrap();
    let item = WriteNodeItem {
        path: "/Knowledge/projects/b/secret.md".into(),
        kind: NodeKind::File,
        content: "rust secret".into(),
        metadata_json: "{}".into(),
        expected_etag: None,
    };
    assert!(
        recall_overlay(&client, "db", "r", &opts, &[item])
            .await
            .unwrap()
            .supplied
            .is_empty()
    );
    for scope in [
        "/Knowledge/../Sources",
        "Knowledge/common",
        "/",
        "/Knowledge//common",
    ] {
        opts.read_scopes = vec![scope.into()];
        assert!(
            recall(&client, "db", "r", &opts).await.is_err(),
            "accepted {scope}"
        );
    }
}
