use crate::cli::{SkillRunOutcomeArg, SkillStatusArg};
use crate::hermes::sync_projection;
use crate::skill_registry::{
    SkillRunEvidenceInput, SkillRunInput, export_skill, find_skills, inspect_skill,
    install_skill_lockfile, list_skill_packages, markdown_target_package_key, record_correction,
    record_skill_run, record_skill_run_evidence, record_skill_run_evidence_with_override,
    rollback_skill_version, set_skill_status, skill_history, sync_skill_packages, upsert_skill,
};
use anyhow::Result;
use async_trait::async_trait;
use chrono::DateTime;
use proptest::prelude::*;
use proptest::test_runner::{Config as ProptestConfig, FileFailurePersistence};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use tempfile::TempDir;
use vfs_client::VfsApi;
use vfs_types::{
    AppendNodeRequest, ChildNode, DeleteNodeRequest, DeleteNodeResult, EditNodeRequest,
    EditNodeResult, ExportSnapshotRequest, ExportSnapshotResponse, FetchUpdatesRequest,
    FetchUpdatesResponse, GlobNodeHit, GlobNodesRequest, ListChildrenRequest, ListNodesRequest,
    MkdirNodeRequest, MkdirNodeResult, MoveNodeRequest, MoveNodeResult, MultiEditNodeRequest,
    MultiEditNodeResult, Node, NodeEntry, NodeEntryKind, NodeKind, SearchNodeHit,
    SearchNodePathsRequest, SearchNodesRequest, Status, WriteNodeItem, WriteNodeRequest,
    WriteNodeResult, WriteNodesRequest,
};

#[derive(Default)]
struct SkillMockClient {
    nodes: Mutex<BTreeMap<String, Node>>,
    mkdirs: Mutex<Vec<String>>,
    searches: Mutex<Vec<SearchNodesRequest>>,
    stale_before_batch_path: Mutex<Option<String>>,
    caller_principal: Mutex<Option<String>>,
    writes: AtomicUsize,
    write_batches: AtomicUsize,
}

#[async_trait]
impl VfsApi for SkillMockClient {
    fn caller_principal(&self) -> Option<String> {
        self.caller_principal.lock().expect("caller lock").clone()
    }

    async fn status(&self, _database_id: &str) -> Result<Status> {
        Ok(Status {
            file_count: 0,
            source_count: 0,
        })
    }

    async fn read_node(&self, _database_id: &str, path: &str) -> Result<Option<Node>> {
        Ok(self.nodes.lock().expect("nodes lock").get(path).cloned())
    }

    async fn list_nodes(&self, request: ListNodesRequest) -> Result<Vec<NodeEntry>> {
        Ok(self
            .nodes
            .lock()
            .expect("nodes lock")
            .values()
            .filter(|node| node.path.starts_with(&request.prefix))
            .map(|node| NodeEntry {
                path: node.path.clone(),
                kind: match node.kind {
                    NodeKind::File => NodeEntryKind::File,
                    NodeKind::Source => NodeEntryKind::Source,
                    NodeKind::Folder => NodeEntryKind::Folder,
                },
                updated_at: node.updated_at,
                etag: node.etag.clone(),
                has_children: false,
            })
            .take(request.limit as usize)
            .collect())
    }

    async fn list_children(&self, _request: ListChildrenRequest) -> Result<Vec<ChildNode>> {
        Ok(Vec::new())
    }

    async fn write_node(&self, request: WriteNodeRequest) -> Result<WriteNodeResult> {
        let mut nodes = self.nodes.lock().expect("nodes lock");
        let mut write_count = self.writes.load(Ordering::SeqCst);
        let result = apply_mock_write(&mut nodes, &mut write_count, request)?;
        self.writes.store(write_count, Ordering::SeqCst);
        Ok(result)
    }

    async fn write_nodes(&self, request: WriteNodesRequest) -> Result<Vec<WriteNodeResult>> {
        self.write_batches.fetch_add(1, Ordering::SeqCst);
        let nodes = self.nodes.lock().expect("nodes lock");
        let mut next_nodes = nodes.clone();
        drop(nodes);
        let stale_path = self
            .stale_before_batch_path
            .lock()
            .expect("stale path lock")
            .clone();
        if let Some(path) = stale_path
            && request.nodes.iter().any(|item| item.path == path)
            && let Some(node) = next_nodes.get_mut(&path)
        {
            *self
                .stale_before_batch_path
                .lock()
                .expect("stale path lock") = None;
            node.etag = "externally-updated".to_string();
        }
        let mut write_count = self.writes.load(Ordering::SeqCst);
        let mut results = Vec::new();
        for item in request.nodes {
            results.push(apply_mock_write(
                &mut next_nodes,
                &mut write_count,
                write_request_from_item(&request.database_id, item),
            )?);
        }
        *self.nodes.lock().expect("nodes lock") = next_nodes;
        self.writes.store(write_count, Ordering::SeqCst);
        Ok(results)
    }

    async fn append_node(&self, _request: AppendNodeRequest) -> Result<WriteNodeResult> {
        unreachable!("skill tests do not append")
    }

    async fn edit_node(&self, _request: EditNodeRequest) -> Result<EditNodeResult> {
        unreachable!("skill tests do not edit")
    }

    async fn delete_node(&self, request: DeleteNodeRequest) -> Result<DeleteNodeResult> {
        let mut nodes = self.nodes.lock().expect("nodes lock");
        let Some(current) = nodes.get(&request.path) else {
            anyhow::bail!("node not found: {}", request.path);
        };
        if request.expected_etag.as_deref() != Some(current.etag.as_str()) {
            anyhow::bail!(
                "expected_etag does not match current etag: {}",
                request.path
            );
        }
        nodes.remove(&request.path);
        Ok(DeleteNodeResult { path: request.path })
    }

    async fn move_node(&self, _request: MoveNodeRequest) -> Result<MoveNodeResult> {
        unreachable!("skill tests do not move")
    }

    async fn mkdir_node(&self, request: MkdirNodeRequest) -> Result<MkdirNodeResult> {
        self.mkdirs
            .lock()
            .expect("mkdir lock")
            .push(request.path.clone());
        Ok(MkdirNodeResult {
            path: request.path,
            created: true,
        })
    }

    async fn glob_nodes(&self, _request: GlobNodesRequest) -> Result<Vec<GlobNodeHit>> {
        Ok(Vec::new())
    }

    async fn multi_edit_node(&self, _request: MultiEditNodeRequest) -> Result<MultiEditNodeResult> {
        unreachable!("skill tests do not multi-edit")
    }

    async fn search_nodes(&self, request: SearchNodesRequest) -> Result<Vec<SearchNodeHit>> {
        self.searches
            .lock()
            .expect("search lock")
            .push(request.clone());
        let prefix = request.prefix.unwrap_or_default();
        Ok(self
            .nodes
            .lock()
            .expect("nodes lock")
            .values()
            .filter(|node| {
                node.path.starts_with(&prefix) && node.content.contains(&request.query_text)
            })
            .map(|node| SearchNodeHit {
                path: node.path.clone(),
                kind: node.kind.clone(),
                snippet: Some(node.path.clone()),
                preview: None,
                score: 1.0,
                match_reasons: vec!["content".to_string()],
            })
            .collect())
    }

    async fn search_node_paths(
        &self,
        _request: SearchNodePathsRequest,
    ) -> Result<Vec<SearchNodeHit>> {
        Ok(Vec::new())
    }

    async fn export_snapshot(
        &self,
        _request: ExportSnapshotRequest,
    ) -> Result<ExportSnapshotResponse> {
        Ok(ExportSnapshotResponse {
            snapshot_revision: "snap".to_string(),
            snapshot_session_id: None,
            nodes: Vec::new(),
            next_cursor: None,
        })
    }

    async fn fetch_updates(&self, _request: FetchUpdatesRequest) -> Result<FetchUpdatesResponse> {
        Ok(FetchUpdatesResponse {
            snapshot_revision: "snap".to_string(),
            changed_nodes: Vec::new(),
            removed_paths: Vec::new(),
            next_cursor: None,
        })
    }
}

fn apply_mock_write(
    nodes: &mut BTreeMap<String, Node>,
    write_count: &mut usize,
    request: WriteNodeRequest,
) -> Result<WriteNodeResult> {
    let created = !nodes.contains_key(&request.path);
    if let Some(current) = nodes.get(&request.path) {
        if request.expected_etag.as_deref() != Some(current.etag.as_str()) {
            anyhow::bail!(
                "expected_etag does not match current etag: {}",
                request.path
            );
        }
    } else if request.expected_etag.is_some() {
        anyhow::bail!("expected_etag must be None for new node: {}", request.path);
    }
    *write_count += 1;
    let etag = format!("etag-write-{write_count}");
    let node = Node {
        path: request.path.clone(),
        kind: request.kind.clone(),
        content: request.content,
        created_at: 1,
        updated_at: 2,
        etag: etag.clone(),
        metadata_json: request.metadata_json,
    };
    nodes.insert(request.path.clone(), node);
    Ok(WriteNodeResult {
        created,
        node: vfs_types::NodeMutationAck {
            path: request.path,
            kind: request.kind,
            updated_at: 2,
            etag,
        },
    })
}

fn write_request_from_item(database_id: &str, item: WriteNodeItem) -> WriteNodeRequest {
    WriteNodeRequest {
        database_id: database_id.to_string(),
        path: item.path,
        kind: item.kind,
        content: item.content,
        metadata_json: item.metadata_json,
        expected_etag: item.expected_etag,
    }
}

#[tokio::test]
async fn skill_upsert_find_inspect_status_and_run_use_vfs_nodes() {
    let client = SkillMockClient::default();
    let temp = tempfile::tempdir().expect("tempdir");
    write(
        temp.path(),
        "SKILL.md",
        "# Legal Review\n\nReview redlines.\n\nRead [checklist](ingest.md) and [usage](docs/usage.md).\n\nIgnore [web](https://example.com/remote.md), [absolute](/tmp/secret.md), [parent](../outside.md), and [text](notes.txt).",
    );
    write(temp.path(), "ingest.md", "# Ingest\n\nredlines checklist");
    std::fs::create_dir(temp.path().join("docs")).expect("docs dir");
    write(
        temp.path(),
        "docs/usage.md",
        "# Usage\n\ncontract review usage",
    );
    std::fs::write(
        temp.path().parent().unwrap().join("outside.md"),
        "# Outside",
    )
    .expect("outside");
    write(temp.path(), "manifest.md", &manifest("reviewed"));

    upsert_skill(&client, "default", temp.path(), "legal-review", false)
        .await
        .expect("upsert");
    assert!(
        client
            .list_nodes(ListNodesRequest {
                database_id: "default".to_string(),
                prefix: "/Skills/legal-review/versions".to_string(),
                recursive: true,
                limit: 100,
            })
            .await
            .expect("list versions after first upsert")
            .is_empty(),
        "first upsert should not snapshot a new skill"
    );
    assert_mkdirs_include(&client, &["/Skills", "/Skills/legal-review"]);
    assert!(
        client
            .read_node("default", "/Skills/legal-review/SKILL.md")
            .await
            .unwrap()
            .is_some()
    );
    assert!(
        client
            .read_node("default", "/Skills/legal-review/ingest.md")
            .await
            .unwrap()
            .is_some()
    );
    assert!(
        client
            .read_node("default", "/Skills/legal-review/docs/usage.md")
            .await
            .unwrap()
            .is_some()
    );
    assert!(
        client
            .read_node("default", "/Skills/legal-review/outside.md")
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        client
            .read_node("default", "/Skills/legal-review/provenance.md")
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        client
            .read_node("default", "/Skills/legal-review/evals.md")
            .await
            .unwrap()
            .is_none()
    );
    write(
        temp.path(),
        "SKILL.md",
        "# Legal Review\n\nReview redlines and contract risks.",
    );
    upsert_skill(&client, "default", temp.path(), "legal-review", false)
        .await
        .expect("second upsert updates existing skill");
    let versions_after_second = client
        .list_nodes(ListNodesRequest {
            database_id: "default".to_string(),
            prefix: "/Skills/legal-review/versions".to_string(),
            recursive: true,
            limit: 100,
        })
        .await
        .expect("list versions after second upsert");
    assert!(
        versions_after_second
            .iter()
            .any(|entry| entry.path.ends_with("/SKILL.md")),
        "second upsert should snapshot the previous SKILL.md"
    );
    assert!(
        versions_after_second
            .iter()
            .any(|entry| entry.path.ends_with("/manifest.md")),
        "second upsert should snapshot the previous manifest.md"
    );
    let updated_skill = client
        .read_node("default", "/Skills/legal-review/SKILL.md")
        .await
        .expect("read updated skill")
        .expect("skill exists")
        .content;
    assert!(updated_skill.contains("contract risks"));
    assert!(
        client
            .read_node("default", "/Skills/legal-review/ingest.md")
            .await
            .unwrap()
            .is_some(),
        "stale package files are retained without explicit prune"
    );
    let pruned = upsert_skill(&client, "default", temp.path(), "legal-review", true)
        .await
        .expect("prune upsert");
    assert_eq!(
        pruned["pruned_paths"],
        serde_json::json!([
            "/Skills/legal-review/docs/usage.md",
            "/Skills/legal-review/ingest.md"
        ])
    );
    assert!(
        client
            .read_node("default", "/Skills/legal-review/ingest.md")
            .await
            .unwrap()
            .is_none(),
        "explicit prune removes files no longer present in the source package"
    );
    let versions_after_prune = client
        .list_nodes(ListNodesRequest {
            database_id: "default".to_string(),
            prefix: "/Skills/legal-review/versions".to_string(),
            recursive: true,
            limit: 100,
        })
        .await
        .expect("list versions after prune");
    assert!(
        versions_after_prune
            .iter()
            .any(|entry| entry.path.ends_with("/SKILL.md")),
        "prune must not delete snapshots"
    );

    let found = find_skills(&client, "default", "redlines", false, 10)
        .await
        .expect("find");
    assert_eq!(found["hits"][0]["id"], "legal-review");
    assert_eq!(found["hits"][0]["status"], "reviewed");

    let inspected = inspect_skill(&client, "default", "legal-review")
        .await
        .expect("inspect");
    assert_eq!(inspected["files"]["evals.md"], false);
    assert_eq!(inspected["files"]["provenance.md"], false);
    assert!(inspected["files"]["ingest.md"].is_null());
    assert!(inspected["files"]["docs/usage.md"].is_null());

    set_skill_status(
        &client,
        "default",
        "legal-review",
        SkillStatusArg::Deprecated,
        None,
    )
    .await
    .expect("set status");
    let hidden = find_skills(&client, "default", "redlines", false, 10)
        .await
        .expect("find");
    assert_eq!(hidden["hits"].as_array().unwrap().len(), 0);
    let shown = find_skills(&client, "default", "redlines", true, 10)
        .await
        .expect("find");
    assert_eq!(shown["hits"][0]["status"], "deprecated");
    let updated_manifest = client
        .read_node("default", "/Skills/legal-review/manifest.md")
        .await
        .expect("read manifest")
        .expect("manifest exists")
        .content;
    assert!(updated_manifest.contains("status: deprecated"));

    let notes = temp.path().join("notes.md");
    std::fs::write(&notes, "worked on contract").expect("notes");
    let run = record_skill_run(
        &client,
        SkillRunInput {
            database_id: "default",
            id: "legal-review",
            task: "review contract",
            outcome: SkillRunOutcomeArg::Success,
            notes_file: &notes,
            agent: "cli",
        },
    )
    .await
    .expect("record run");
    assert_mkdirs_include(
        &client,
        &[
            "/Sources",
            "/Sources/skill-runs",
            "/Sources/skill-runs/legal-review",
        ],
    );
    assert!(
        run["run_path"]
            .as_str()
            .unwrap()
            .starts_with("/Sources/skill-runs/legal-review/")
    );
    let run_node = client
        .read_node("default", run["run_path"].as_str().unwrap())
        .await
        .expect("read run")
        .expect("run exists")
        .content;
    assert!(run_node.contains("schema_version: 1"));
    assert!(run_node.contains("skill_hash: "));
    assert!(run_node.contains("manifest_hash: "));
    assert!(run_node.contains("task_hash: "));
    assert!(run_node.contains("agent: cli"));

    let shown = find_skills(&client, "default", "redlines", true, 10)
        .await
        .expect("find with run summary");
    assert_eq!(shown["hits"][0]["run_summary"]["runs"], 1);
    assert_eq!(shown["hits"][0]["run_summary"]["success"], 1);

    let inspected = inspect_skill(&client, "default", "legal-review")
        .await
        .expect("inspect with run summary");
    assert_eq!(inspected["run_summary"]["runs"], 1);
}

#[tokio::test]
async fn skill_install_writes_lockfile_without_local_package_install() {
    let client = SkillMockClient::default();
    client
        .write_node(WriteNodeRequest {
            database_id: "team-db".to_string(),
            path: "/Skills/legal-review/manifest.md".to_string(),
            kind: NodeKind::File,
            content: manifest("reviewed"),
            metadata_json: "{}".to_string(),
            expected_etag: None,
        })
        .await
        .expect("seed manifest");
    client
        .write_node(WriteNodeRequest {
            database_id: "team-db".to_string(),
            path: "/Skills/legal-review/SKILL.md".to_string(),
            kind: NodeKind::File,
            content: "# Legal Review\n".to_string(),
            metadata_json: "{}".to_string(),
            expected_etag: None,
        })
        .await
        .expect("seed skill");
    let temp = tempfile::tempdir().expect("tempdir");
    let lockfile = temp.path().join("skill.lock.json");

    let result = install_skill_lockfile(&client, "team-db", "legal-review", &lockfile)
        .await
        .expect("install lockfile");

    assert_eq!(result["lockfile"], lockfile.display().to_string());
    let lock: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&lockfile).expect("lockfile should exist"))
            .expect("lockfile json");
    assert_eq!(lock["schema_version"], 1);
    assert_eq!(lock["database_id"], "team-db");
    assert_eq!(lock["id"], "legal-review");
    assert!(lock.get("public").is_none());
    assert_eq!(lock["manifest_path"], "/Skills/legal-review/manifest.md");
    assert_eq!(lock["entry_path"], "/Skills/legal-review/SKILL.md");
    assert!(lock["manifest_hash"].as_str().unwrap().len() == 64);
    assert!(lock["entry_hash"].as_str().unwrap().len() == 64);
    assert!(lock["installed_at"].as_str().unwrap().ends_with('Z'));
    assert_eq!(
        client
            .read_node("team-db", "/Skills/legal-review/installed/SKILL.md")
            .await
            .expect("read nonexistent install target"),
        None
    );
}

#[tokio::test]
async fn skill_list_filters_default_and_explicit_statuses() {
    let client = SkillMockClient::default();
    let reviewed = tempfile::tempdir().expect("reviewed tempdir");
    seed_legal_review_skill(&client, reviewed.path()).await;
    seed_skill_package(&client, "team-db", "draft-skill", "draft").await;
    seed_skill_package(&client, "team-db", "deprecated-skill", "deprecated").await;

    let default_list = list_skill_packages(&client, "team-db", &[])
        .await
        .expect("default list");
    let default_ids = skill_list_ids(&default_list);
    assert_eq!(default_ids, vec!["legal-review"]);

    let explicit_list = list_skill_packages(
        &client,
        "team-db",
        &[SkillStatusArg::Draft, SkillStatusArg::Reviewed],
    )
    .await
    .expect("explicit list");
    let explicit_ids = skill_list_ids(&explicit_list);
    assert_eq!(explicit_ids, vec!["draft-skill", "legal-review"]);
}

#[tokio::test]
async fn skill_sync_dry_run_does_not_write_local_files() {
    let client = SkillMockClient::default();
    let temp = tempfile::tempdir().expect("tempdir");
    seed_legal_review_skill(&client, temp.path()).await;
    let target = temp.path().join("local-skills");

    let result = sync_skill_packages(&client, "team-db", &target, &[], false, true)
        .await
        .expect("dry-run sync");

    assert_eq!(result["dry_run"], true);
    assert_eq!(result["added"].as_array().unwrap().len(), 1);
    assert!(!target.exists());
}

#[tokio::test]
async fn skill_sync_conflicts_existing_unmanaged_local_skill_on_first_run() {
    let client = SkillMockClient::default();
    let temp = tempfile::tempdir().expect("tempdir");
    seed_legal_review_skill(&client, temp.path()).await;
    let target = temp.path().join("local-skills");
    std::fs::create_dir_all(target.join("legal-review")).expect("manual local dir");
    std::fs::write(
        target.join("legal-review/SKILL.md"),
        "# Local skill is source of truth\n",
    )
    .expect("manual local skill");

    let result = sync_skill_packages(&client, "team-db", &target, &[], true, false)
        .await
        .expect("sync");

    assert_eq!(result["added"].as_array().unwrap().len(), 0);
    assert!(
        result["conflicts"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["reason"] == "unmanaged_existing_dir")
    );
    assert_eq!(
        std::fs::read_to_string(target.join("legal-review/SKILL.md")).expect("local skill"),
        "# Local skill is source of truth\n"
    );
    assert!(!target.join(".kinic-skill-sync.json").exists());
}

#[tokio::test]
async fn skill_sync_exports_updates_and_prunes_only_managed_skills() {
    let client = SkillMockClient::default();
    let temp = tempfile::tempdir().expect("tempdir");
    seed_legal_review_skill(&client, temp.path()).await;
    let target = temp.path().join("local-skills");

    let initial = sync_skill_packages(&client, "team-db", &target, &[], true, false)
        .await
        .expect("initial sync");
    assert_eq!(initial["added"].as_array().unwrap().len(), 1);
    assert!(target.join("legal-review/SKILL.md").is_file());
    assert!(target.join(".kinic-skill-sync.json").is_file());

    let unchanged = sync_skill_packages(&client, "team-db", &target, &[], true, false)
        .await
        .expect("unchanged sync");
    assert_eq!(unchanged["unchanged"].as_array().unwrap().len(), 1);

    write_skill_file(
        &client,
        "team-db",
        "/Skills/legal-review/SKILL.md",
        "# Legal Review\n\nUpdated registry copy.\n",
    )
    .await;
    let updated = sync_skill_packages(&client, "team-db", &target, &[], true, false)
        .await
        .expect("updated sync");
    assert_eq!(updated["updated"].as_array().unwrap().len(), 1);
    assert!(
        std::fs::read_to_string(target.join("legal-review/SKILL.md"))
            .expect("synced skill")
            .contains("Updated registry copy.")
    );

    std::fs::create_dir_all(target.join("manual-skill")).expect("manual skill dir");
    std::fs::write(target.join("manual-skill/SKILL.md"), "# Manual\n").expect("manual skill");
    set_skill_status(
        &client,
        "team-db",
        "legal-review",
        SkillStatusArg::Deprecated,
        Some("retired"),
    )
    .await
    .expect("deprecate");
    let pruned = sync_skill_packages(&client, "team-db", &target, &[], true, false)
        .await
        .expect("prune sync");
    assert_eq!(pruned["removed"].as_array().unwrap().len(), 1);
    assert!(!target.join("legal-review").exists());
    assert!(target.join("manual-skill/SKILL.md").is_file());
}

#[tokio::test]
async fn skill_sync_conflicts_on_managed_local_dirty_before_remote_update() {
    let client = SkillMockClient::default();
    let temp = tempfile::tempdir().expect("tempdir");
    seed_legal_review_skill(&client, temp.path()).await;
    let target = temp.path().join("local-skills");
    sync_skill_packages(&client, "team-db", &target, &[], true, false)
        .await
        .expect("initial sync");
    std::fs::write(target.join("legal-review/SKILL.md"), "# Local edit\n").expect("local edit");
    write_skill_file(
        &client,
        "team-db",
        "/Skills/legal-review/SKILL.md",
        "# Remote edit\n",
    )
    .await;

    let result = sync_skill_packages(&client, "team-db", &target, &[], true, false)
        .await
        .expect("sync with dirty local");

    assert_eq!(result["updated"].as_array().unwrap().len(), 0);
    assert!(has_sync_conflict(&result, "managed_local_dirty"));
    assert_eq!(
        std::fs::read_to_string(target.join("legal-review/SKILL.md")).expect("local skill"),
        "# Local edit\n"
    );
}

#[tokio::test]
async fn skill_sync_conflicts_on_managed_missing_and_extra_files() {
    let client = SkillMockClient::default();
    let temp = tempfile::tempdir().expect("tempdir");
    write(
        temp.path(),
        "SKILL.md",
        "# Legal Review\n\nUse [helper](helper.md).",
    );
    write(temp.path(), "manifest.md", &manifest("reviewed"));
    write(temp.path(), "helper.md", "# Helper\n");
    upsert_skill(&client, "team-db", temp.path(), "legal-review", false)
        .await
        .expect("upsert");
    let target = temp.path().join("local-skills");
    sync_skill_packages(&client, "team-db", &target, &[], true, false)
        .await
        .expect("initial sync");

    let lock: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(target.join(".kinic-skill-sync.json")).expect("lockfile"),
    )
    .expect("lock JSON");
    let files = lock["managed_skills"]["legal-review"]["files"]
        .as_object()
        .expect("files should be a hash map");
    assert!(files["SKILL.md"].as_str().unwrap().len() == 64);
    assert!(files["helper.md"].as_str().unwrap().len() == 64);

    std::fs::write(
        target.join("legal-review/helper.md"),
        "# Local helper edit\n",
    )
    .expect("edit helper");
    write_skill_file(
        &client,
        "team-db",
        "/Skills/legal-review/SKILL.md",
        "# Remote edit\n",
    )
    .await;
    let dirty = sync_skill_packages(&client, "team-db", &target, &[], true, false)
        .await
        .expect("sync dirty helper");
    assert!(has_sync_conflict(&dirty, "managed_local_dirty"));
    assert_eq!(
        std::fs::read_to_string(target.join("legal-review/helper.md")).expect("local helper"),
        "# Local helper edit\n"
    );

    std::fs::write(target.join("legal-review/helper.md"), "# Helper\n").expect("restore helper");
    std::fs::remove_file(target.join("legal-review/helper.md")).expect("remove helper");
    let missing = sync_skill_packages(&client, "team-db", &target, &[], true, false)
        .await
        .expect("sync missing file");
    assert!(has_sync_conflict(&missing, "managed_file_missing"));

    std::fs::write(target.join("legal-review/helper.md"), "# Helper\n").expect("restore helper");
    std::fs::write(target.join("legal-review/local.md"), "# Local only\n").expect("extra file");
    let extra = sync_skill_packages(&client, "team-db", &target, &[], true, false)
        .await
        .expect("sync extra file");
    assert!(has_sync_conflict(&extra, "managed_extra_file"));
}

#[tokio::test]
async fn skill_sync_prune_keeps_dirty_managed_skill_as_conflict() {
    let client = SkillMockClient::default();
    let temp = tempfile::tempdir().expect("tempdir");
    seed_legal_review_skill(&client, temp.path()).await;
    let target = temp.path().join("local-skills");
    sync_skill_packages(&client, "team-db", &target, &[], true, false)
        .await
        .expect("initial sync");
    std::fs::write(target.join("legal-review/SKILL.md"), "# Local edit\n").expect("local edit");
    set_skill_status(
        &client,
        "team-db",
        "legal-review",
        SkillStatusArg::Deprecated,
        Some("retired"),
    )
    .await
    .expect("deprecate");

    let result = sync_skill_packages(&client, "team-db", &target, &[], true, false)
        .await
        .expect("prune sync");

    assert_eq!(result["removed"].as_array().unwrap().len(), 0);
    assert!(has_sync_conflict(&result, "managed_local_dirty"));
    assert!(target.join("legal-review/SKILL.md").is_file());
}

#[tokio::test]
async fn skill_record_run_evidence_export_and_correction() {
    let client = SkillMockClient::default();
    let temp = tempfile::tempdir().expect("tempdir");
    write(
        temp.path(),
        "SKILL.md",
        "# Legal Review\n\nUse [helper](helper.md).",
    );
    write(temp.path(), "manifest.md", &manifest("reviewed"));
    write(temp.path(), "helper.md", "# Helper\n");
    upsert_skill(&client, "team-db", temp.path(), "legal-review", false)
        .await
        .expect("upsert");

    let evidence = temp.path().join("evidence.json");
    std::fs::write(
        &evidence,
        serde_json::json!({
            "run_id": "run-1",
            "task_id": "task-1",
            "task": "review redlines",
            "task_outcome": "success",
            "agent_outcome": "unknown",
            "agent": "hermes",
            "recorded_by": "hermes-plugin",
            "summary": "Skill guided the review.",
            "raw_evidence_excerpt": "tool trace excerpt"
        })
        .to_string(),
    )
    .expect("evidence json");
    let run = record_skill_run_evidence(
        &client,
        SkillRunEvidenceInput {
            database_id: "team-db",
            id: "legal-review",
            evidence_json: &evidence,
        },
    )
    .await
    .expect("record evidence");
    assert_eq!(run["run_path"], "/Sources/skill-runs/legal-review/run-1.md");
    let run_content = client
        .read_node("team-db", "/Sources/skill-runs/legal-review/run-1.md")
        .await
        .expect("read run")
        .expect("run exists")
        .content;
    assert!(run_content.contains("schema_version: 2"));
    assert!(run_content.contains("task_outcome: success"));
    assert!(run_content.contains("agent_outcome: unknown"));
    assert!(run_content.contains("recorded_by: hermes-plugin"));
    let inspected = inspect_skill(&client, "team-db", "legal-review")
        .await
        .expect("inspect after v2 run");
    assert_eq!(inspected["run_summary"]["runs"], 1);
    assert_eq!(inspected["run_summary"]["success"], 0);
    assert_eq!(inspected["run_summary"]["last_outcome"], "unknown");

    let notes = temp.path().join("correction.md");
    std::fs::write(&notes, "Correction note").expect("correction");
    let correction = record_correction(&client, "team-db", "legal-review", "run-1", &notes)
        .await
        .expect("record correction");
    assert!(
        correction["correction_path"]
            .as_str()
            .unwrap()
            .contains(".correction.")
    );

    let out = temp.path().join("export");
    let export = export_skill(&client, "team-db", "legal-review", &out)
        .await
        .expect("export");
    assert_eq!(
        export["files"],
        serde_json::json!(["SKILL.md", "helper.md"])
    );
    assert!(out.join("SKILL.md").is_file());
    assert!(!out.join("manifest.md").exists());

    let history = skill_history(&client, "team-db", "legal-review")
        .await
        .expect("history");
    assert!(history.get("events").is_none());
    assert!(
        history["runs"]
            .as_array()
            .unwrap()
            .iter()
            .any(|run| run["path"] == "/Sources/skill-runs/legal-review/run-1.md")
    );
    assert!(
        history["corrections"]
            .as_array()
            .unwrap()
            .iter()
            .any(|correction| correction["path"]
                .as_str()
                .unwrap()
                .contains(".correction."))
    );
}

#[tokio::test]
async fn export_skill_rejects_limit_sized_listing() {
    let client = SkillMockClient::default();
    let temp = tempfile::tempdir().expect("tempdir");
    seed_legal_review_skill(&client, temp.path()).await;
    for index in 0..99 {
        write_skill_file(
            &client,
            "team-db",
            &format!("/Skills/legal-review/overflow-{index:03}.md"),
            "overflow",
        )
        .await;
    }

    let error = export_skill(
        &client,
        "team-db",
        "legal-review",
        &temp.path().join("export"),
    )
    .await
    .expect_err("limit-sized listing should reject");

    assert!(
        error
            .to_string()
            .contains("export may be truncated; list_nodes pagination is required")
    );
}

#[tokio::test]
async fn record_skill_run_evidence_rejects_invalid_explicit_run_id() {
    let client = SkillMockClient::default();
    let temp = tempfile::tempdir().expect("tempdir");
    seed_legal_review_skill(&client, temp.path()).await;
    let evidence = temp.path().join("evidence.json");
    std::fs::write(
        &evidence,
        serde_json::json!({
            "run_id": "bad/id",
            "recorded_by": "codex-plugin"
        })
        .to_string(),
    )
    .expect("evidence json");

    let error = record_skill_run_evidence(
        &client,
        SkillRunEvidenceInput {
            database_id: "team-db",
            id: "legal-review",
            evidence_json: &evidence,
        },
    )
    .await
    .expect_err("invalid evidence run_id should fail");
    assert!(error.to_string().contains("run_id"));

    std::fs::write(
        &evidence,
        serde_json::json!({
            "run_id": "run-1",
            "recorded_by": "codex-plugin"
        })
        .to_string(),
    )
    .expect("evidence json");
    let error = record_skill_run_evidence_with_override(
        &client,
        SkillRunEvidenceInput {
            database_id: "team-db",
            id: "legal-review",
            evidence_json: &evidence,
        },
        Some("bad/id"),
    )
    .await
    .expect_err("invalid override run_id should fail");
    assert!(error.to_string().contains("run_id"));
}

#[tokio::test]
async fn record_skill_run_evidence_does_not_overwrite_existing_run_id() {
    let client = SkillMockClient::default();
    let temp = tempfile::tempdir().expect("tempdir");
    seed_legal_review_skill(&client, temp.path()).await;
    let evidence = temp.path().join("evidence.json");
    std::fs::write(
        &evidence,
        serde_json::json!({
            "run_id": "run-1",
            "recorded_by": "codex-plugin",
            "summary": "first"
        })
        .to_string(),
    )
    .expect("evidence json");
    record_skill_run_evidence(
        &client,
        SkillRunEvidenceInput {
            database_id: "team-db",
            id: "legal-review",
            evidence_json: &evidence,
        },
    )
    .await
    .expect("record first run");
    std::fs::write(
        &evidence,
        serde_json::json!({
            "run_id": "run-1",
            "recorded_by": "codex-plugin",
            "summary": "second"
        })
        .to_string(),
    )
    .expect("evidence json");

    let error = record_skill_run_evidence(
        &client,
        SkillRunEvidenceInput {
            database_id: "team-db",
            id: "legal-review",
            evidence_json: &evidence,
        },
    )
    .await
    .expect_err("duplicate run should fail");
    let content = client
        .read_node("team-db", "/Sources/skill-runs/legal-review/run-1.md")
        .await
        .unwrap()
        .unwrap()
        .content;

    assert!(error.to_string().contains("run already exists"));
    assert!(content.contains("first"));
    assert!(!content.contains("second"));
}

#[tokio::test]
async fn record_skill_run_evidence_sets_recorded_by_for_hermes_codex_and_claude_code() {
    let client = SkillMockClient::default();
    let temp = tempfile::tempdir().expect("tempdir");
    seed_legal_review_skill(&client, temp.path()).await;
    let evidence = temp.path().join("evidence.json");
    for (run_id, recorded_by) in [
        ("hermes-run", "hermes-plugin"),
        ("codex-run", "codex-plugin"),
        ("claude-run", "claude-code-plugin"),
    ] {
        std::fs::write(
            &evidence,
            serde_json::json!({
                "run_id": run_id,
                "recorded_by": recorded_by
            })
            .to_string(),
        )
        .expect("evidence json");
        record_skill_run_evidence(
            &client,
            SkillRunEvidenceInput {
                database_id: "team-db",
                id: "legal-review",
                evidence_json: &evidence,
            },
        )
        .await
        .expect("record run");
        let content = client
            .read_node(
                "team-db",
                &format!("/Sources/skill-runs/legal-review/{run_id}.md"),
            )
            .await
            .unwrap()
            .unwrap()
            .content;
        assert!(content.contains(&format!("recorded_by: {recorded_by}")));
    }
}

#[tokio::test]
async fn record_skill_run_evidence_rejects_invalid_recorded_by() {
    let client = SkillMockClient::default();
    let temp = tempfile::tempdir().expect("tempdir");
    seed_legal_review_skill(&client, temp.path()).await;
    let evidence = temp.path().join("evidence.json");
    std::fs::write(
        &evidence,
        serde_json::json!({
            "run_id": "run-1",
            "recorded_by": "bad/recorder"
        })
        .to_string(),
    )
    .expect("evidence json");

    let error = record_skill_run_evidence(
        &client,
        SkillRunEvidenceInput {
            database_id: "team-db",
            id: "legal-review",
            evidence_json: &evidence,
        },
    )
    .await
    .expect_err("invalid recorded_by should fail");

    assert!(error.to_string().contains("recorded_by"));
}

#[tokio::test]
async fn hermes_projection_sync_removes_deapproved_skill_dirs() {
    let client = SkillMockClient::default();
    let temp = TempDir::new().unwrap();
    let projection = temp.path().join("projection");
    std::fs::create_dir_all(projection.join("manual")).unwrap();
    std::fs::write(projection.join("README.md"), "local note\n").unwrap();
    write_skill_file(
        &client,
        "team-db",
        "/Skills/legal-review/manifest.md",
        &manifest("reviewed"),
    )
    .await;
    write_skill_file(
        &client,
        "team-db",
        "/Skills/legal-review/SKILL.md",
        "# Legal Review\n",
    )
    .await;

    sync_projection(&client, "team-db", &projection)
        .await
        .expect("initial projection");
    assert!(projection.join("legal-review/SKILL.md").is_file());

    write_skill_file(
        &client,
        "team-db",
        "/Skills/legal-review/manifest.md",
        &manifest("draft"),
    )
    .await;
    sync_projection(&client, "team-db", &projection)
        .await
        .expect("deapproved projection");

    assert!(!projection.join("legal-review").exists());
    assert!(projection.join("manual").is_dir());
    assert!(projection.join("README.md").is_file());
}

#[tokio::test]
async fn hermes_projection_sync_removes_deleted_skill_files() {
    let client = SkillMockClient::default();
    let temp = TempDir::new().unwrap();
    let projection = temp.path().join("projection");
    write_skill_file(
        &client,
        "team-db",
        "/Skills/legal-review/manifest.md",
        &manifest("promoted"),
    )
    .await;
    write_skill_file(
        &client,
        "team-db",
        "/Skills/legal-review/SKILL.md",
        "# Legal Review\n",
    )
    .await;
    write_skill_file(&client, "team-db", "/Skills/legal-review/A.md", "A\n").await;
    write_skill_file(&client, "team-db", "/Skills/legal-review/B.md", "B\n").await;

    sync_projection(&client, "team-db", &projection)
        .await
        .expect("initial projection");
    assert!(projection.join("legal-review/A.md").is_file());
    assert!(projection.join("legal-review/B.md").is_file());

    client
        .nodes
        .lock()
        .expect("nodes lock")
        .remove("/Skills/legal-review/B.md");
    sync_projection(&client, "team-db", &projection)
        .await
        .expect("pruned file projection");

    assert!(projection.join("legal-review/SKILL.md").is_file());
    assert!(projection.join("legal-review/A.md").is_file());
    assert!(!projection.join("legal-review/B.md").exists());
}

#[tokio::test]
async fn skill_rollback_restores_version_and_history_lists_snapshots() {
    let client = SkillMockClient::default();
    client
        .write_node(WriteNodeRequest {
            database_id: "team-db".to_string(),
            path: "/Skills/legal-review/SKILL.md".to_string(),
            kind: NodeKind::File,
            content: "# Current\n".to_string(),
            metadata_json: "{}".to_string(),
            expected_etag: None,
        })
        .await
        .unwrap();
    client
        .write_node(WriteNodeRequest {
            database_id: "team-db".to_string(),
            path: "/Skills/legal-review/manifest.md".to_string(),
            kind: NodeKind::File,
            content: manifest("reviewed"),
            metadata_json: "{}".to_string(),
            expected_etag: None,
        })
        .await
        .unwrap();
    client
        .write_node(WriteNodeRequest {
            database_id: "team-db".to_string(),
            path: "/Skills/legal-review/versions/v1/SKILL.md".to_string(),
            kind: NodeKind::File,
            content: "# Old\n".to_string(),
            metadata_json: "{}".to_string(),
            expected_etag: None,
        })
        .await
        .unwrap();
    client
        .write_node(WriteNodeRequest {
            database_id: "team-db".to_string(),
            path: "/Skills/legal-review/versions/v1/manifest.md".to_string(),
            kind: NodeKind::File,
            content: manifest("draft"),
            metadata_json: "{}".to_string(),
            expected_etag: None,
        })
        .await
        .unwrap();

    let rollback = rollback_skill_version(&client, "team-db", "legal-review", "v1", None)
        .await
        .unwrap();
    let current = client
        .read_node("team-db", "/Skills/legal-review/SKILL.md")
        .await
        .unwrap()
        .unwrap()
        .content;
    let history = skill_history(&client, "team-db", "legal-review")
        .await
        .unwrap();

    assert_eq!(rollback["status"], "rolled_back");
    assert!(current.contains("# Old"));
    assert!(history.get("events").is_none());
    let versions = history["versions"].as_array().unwrap();
    let version = versions
        .iter()
        .find(|version| version["id"] == "v1")
        .expect("v1 snapshot should be listed");
    assert_eq!(version["path"], "/Skills/legal-review/versions/v1");
    assert_eq!(
        version["files"],
        serde_json::json!([
            "/Skills/legal-review/versions/v1/SKILL.md",
            "/Skills/legal-review/versions/v1/manifest.md"
        ])
    );
}

#[tokio::test]
async fn skill_set_status_preserves_manifest_body_and_unknown_frontmatter() {
    let client = SkillMockClient::default();
    let manifest_path = "/Skills/legal-review/manifest.md";
    client
        .write_node(WriteNodeRequest {
            database_id: "default".to_string(),
            path: manifest_path.to_string(),
            kind: NodeKind::File,
            content: concat!(
                "---\n",
                "kind: kinic.skill\n",
                "schema_version: 1\n",
                "id: legal-review\n",
                "version: 0.1.0\n",
                "x-team: acme\n",
                "entry: SKILL.md\n",
                "x-team-note: keep this\n",
                "provenance:\n",
                "  status: upstream-reviewed\n",
                "status: reviewed # old comment\n",
                "---\n",
                "# Skill Manifest\n",
                "\n",
                "Human-maintained notes stay here.\n"
            )
            .to_string(),
            metadata_json: "{}".to_string(),
            expected_etag: None,
        })
        .await
        .expect("seed manifest");

    set_skill_status(
        &client,
        "default",
        "legal-review",
        SkillStatusArg::Promoted,
        None,
    )
    .await
    .expect("set status");

    let updated = client
        .read_node("default", manifest_path)
        .await
        .expect("read manifest")
        .expect("manifest exists")
        .content;
    assert!(updated.contains("x-team-note: keep this"));
    assert!(updated.contains("  status: upstream-reviewed"));
    assert!(updated.contains("status: promoted\n"));
    assert!(updated.contains("# Skill Manifest\n\nHuman-maintained notes stay here.\n"));
    assert!(!updated.contains("status: reviewed # old comment"));
}

#[tokio::test]
async fn skill_upsert_uses_write_nodes_for_package_files() {
    let client = SkillMockClient::default();
    let temp = tempfile::tempdir().expect("tempdir");
    write(temp.path(), "SKILL.md", "# Legal Review\n\nReview.");
    write(temp.path(), "manifest.md", &manifest("draft"));
    write(temp.path(), "evals.md", "# Evals");

    upsert_skill(&client, "default", temp.path(), "legal-review", false)
        .await
        .expect("upsert");

    assert_eq!(client.write_batches.load(Ordering::SeqCst), 1);
    assert_eq!(client.writes.load(Ordering::SeqCst), 3);
    assert!(
        client
            .read_node("default", "/Skills/legal-review/evals.md")
            .await
            .expect("read should succeed")
            .is_some()
    );
}

#[tokio::test]
async fn skill_upsert_rejects_noncanonical_skill_ids_before_writing() {
    let client = SkillMockClient::default();
    let temp = tempfile::tempdir().expect("tempdir");
    write(temp.path(), "SKILL.md", "# Legal Review\n\nReview.");

    let overlong = "a".repeat(129);
    for invalid_id in ["legal..review", "_legal-review", overlong.as_str()] {
        let error = upsert_skill(&client, "default", temp.path(), invalid_id, false)
            .await
            .expect_err("invalid skill id should fail before writes");
        assert!(error.to_string().contains("single path-safe name"));
    }

    assert_eq!(client.write_batches.load(Ordering::SeqCst), 0);
    assert_eq!(client.writes.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn skill_upsert_rejects_package_over_batch_limit_before_writing() {
    let client = SkillMockClient::default();
    let temp = tempfile::tempdir().expect("tempdir");
    let mut skill = String::from("# Legal Review\n\nReview.");
    for index in 0..99 {
        let file_name = format!("extra-{index:03}.md");
        skill.push_str(&format!("\n[{file_name}]({file_name})"));
        write(temp.path(), &file_name, "# Extra");
    }
    write(temp.path(), "SKILL.md", &skill);
    write(temp.path(), "manifest.md", &manifest("draft"));

    let error = upsert_skill(&client, "default", temp.path(), "legal-review", false)
        .await
        .expect_err("over-limit package should fail before write_nodes");

    assert!(
        error
            .to_string()
            .contains("skill package file count must be between 1 and 100")
    );
    assert_eq!(client.write_batches.load(Ordering::SeqCst), 0);
    assert_eq!(client.writes.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn skill_upsert_batch_failure_does_not_partially_write_package_files() {
    let client = SkillMockClient::default();
    let temp = tempfile::tempdir().expect("tempdir");
    write(temp.path(), "SKILL.md", "# Legal Review\n\nReview.");
    write(temp.path(), "manifest.md", &manifest("draft"));
    upsert_skill(&client, "default", temp.path(), "legal-review", false)
        .await
        .expect("initial upsert");
    write(temp.path(), "SKILL.md", "# Legal Review\n\nUpdated.");
    write(temp.path(), "evals.md", "# Evals");
    *client
        .stale_before_batch_path
        .lock()
        .expect("stale path lock") = Some("/Skills/legal-review/SKILL.md".to_string());

    let error = upsert_skill(&client, "default", temp.path(), "legal-review", false)
        .await
        .expect_err("stale etag should fail batch");

    assert!(error.to_string().contains("expected_etag"));
    let skill = client
        .read_node("default", "/Skills/legal-review/SKILL.md")
        .await
        .expect("read should succeed")
        .expect("skill should exist");
    assert!(!skill.content.contains("Updated."));
    assert!(
        client
            .read_node("default", "/Skills/legal-review/evals.md")
            .await
            .expect("read should succeed")
            .is_none()
    );
}

#[tokio::test]
async fn skill_upsert_snapshots_existing_skill_before_update() {
    let client = SkillMockClient::default();
    let temp = tempfile::tempdir().expect("tempdir");
    write(temp.path(), "SKILL.md", "# Legal Review\n\nInitial.");
    write(temp.path(), "manifest.md", &manifest("draft"));
    upsert_skill(&client, "default", temp.path(), "legal-review", false)
        .await
        .expect("initial upsert");

    write(temp.path(), "SKILL.md", "# Legal Review\n\nUpdated.");
    write(temp.path(), "manifest.md", &manifest("reviewed"));
    let result = upsert_skill(&client, "default", temp.path(), "legal-review", false)
        .await
        .expect("second upsert");
    let snapshot_id = result["snapshot_version_id"]
        .as_str()
        .expect("snapshot id should be returned");
    let snapshot_base = format!("/Skills/legal-review/versions/{snapshot_id}");
    let snapshot_skill = client
        .read_node("default", &format!("{snapshot_base}/SKILL.md"))
        .await
        .expect("read snapshot skill")
        .expect("snapshot skill exists")
        .content;
    let snapshot_manifest = client
        .read_node("default", &format!("{snapshot_base}/manifest.md"))
        .await
        .expect("read snapshot manifest")
        .expect("snapshot manifest exists")
        .content;

    assert!(snapshot_skill.contains("Initial."));
    assert!(snapshot_manifest.contains("status: draft"));

    let history = skill_history(&client, "default", "legal-review")
        .await
        .expect("history");
    assert!(
        history["versions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|version| version["id"] == snapshot_id)
    );
}

#[tokio::test]
async fn skill_upsert_validates_manifest_version_format_only() {
    let client = SkillMockClient::default();
    let temp = tempfile::tempdir().expect("tempdir");
    write(temp.path(), "SKILL.md", "# Legal Review\n\nReview.");
    write(temp.path(), "manifest.md", &manifest("draft"));
    upsert_skill(&client, "default", temp.path(), "legal-review", false)
        .await
        .expect("semver-like version should pass");

    for invalid_version in ["v0.1.0", "1"] {
        let invalid = tempfile::tempdir().expect("tempdir");
        write(invalid.path(), "SKILL.md", "# Legal Review\n\nReview.");
        let bad_manifest =
            manifest("draft").replace("version: 0.1.0", &format!("version: {invalid_version}"));
        write(invalid.path(), "manifest.md", &bad_manifest);
        let error = upsert_skill(&client, "default", invalid.path(), "legal-review", false)
            .await
            .expect_err("invalid version should fail");
        assert!(error.to_string().contains("manifest version"));
    }
}

#[tokio::test]
async fn skill_upsert_uses_skill_frontmatter_to_fill_missing_manifest_fields() {
    let client = SkillMockClient::default();
    let temp = tempfile::tempdir().expect("tempdir");
    write(
        temp.path(),
        "SKILL.md",
        concat!(
            "---\n",
            "name: canister-security\n",
            "description: IC-specific security patterns for canister development\n",
            "license: Apache-2.0\n",
            "metadata:\n",
            "  title: Canister Security\n",
            "  category: Security\n",
            "---\n",
            "# Canister Security\n"
        ),
    );

    upsert_skill(&client, "default", temp.path(), "canister-security", false)
        .await
        .expect("upsert");

    let manifest = client
        .read_node("default", "/Skills/canister-security/manifest.md")
        .await
        .expect("read manifest")
        .expect("manifest exists")
        .content;
    assert!(manifest.contains("title: Canister Security"));
    assert!(manifest.contains("summary: IC-specific security patterns for canister development"));
    assert!(manifest.contains("- Security"));
    assert!(manifest.contains("status: draft"));
    assert!(manifest.contains("license: Apache-2.0"));

    let found = find_skills(&client, "default", "security", false, 10)
        .await
        .expect("find");
    assert_eq!(found["hits"][0]["id"], "canister-security");
    assert_eq!(found["hits"][0]["title"], "Canister Security");
    let inspected = inspect_skill(&client, "default", "canister-security")
        .await
        .expect("inspect");
    assert_eq!(inspected["manifest"]["title"], "Canister Security");
}

#[tokio::test]
async fn skill_upsert_preserves_existing_manifest_fields_over_skill_frontmatter() {
    let client = SkillMockClient::default();
    let temp = tempfile::tempdir().expect("tempdir");
    write(
        temp.path(),
        "SKILL.md",
        concat!(
            "---\n",
            "name: legal-review\n",
            "description: Upstream description\n",
            "license: Apache-2.0\n",
            "metadata:\n",
            "  title: Upstream Title\n",
            "  category: Upstream\n",
            "---\n",
            "# Legal Review\n"
        ),
    );
    write(
        temp.path(),
        "manifest.md",
        concat!(
            "---\n",
            "kind: kinic.skill\n",
            "schema_version: 1\n",
            "id: legal-review\n",
            "version: 0.1.0\n",
            "entry: SKILL.md\n",
            "title: KB Title\n",
            "summary: KB summary\n",
            "tags:\n",
            "  - kb-tag\n",
            "status: reviewed\n",
            "provenance:\n",
            "  license: MIT\n",
            "---\n",
            "# Skill Manifest\n"
        ),
    );

    upsert_skill(&client, "default", temp.path(), "legal-review", false)
        .await
        .expect("upsert");

    let manifest = client
        .read_node("default", "/Skills/legal-review/manifest.md")
        .await
        .expect("read manifest")
        .expect("manifest exists")
        .content;
    assert!(manifest.contains("title: KB Title"));
    assert!(manifest.contains("summary: KB summary"));
    assert!(manifest.contains("- kb-tag"));
    assert!(manifest.contains("license: MIT"));
    assert!(!manifest.contains("Upstream Title"));
    assert!(!manifest.contains("Upstream description"));
    assert!(!manifest.contains("- Upstream"));
    assert!(!manifest.contains("Apache-2.0"));
}

#[tokio::test]
async fn skill_upsert_allows_upstream_frontmatter_name_to_differ_from_db_id() {
    let client = SkillMockClient::default();
    let temp = tempfile::tempdir().expect("tempdir");
    write(
        temp.path(),
        "SKILL.md",
        concat!(
            "---\n",
            "name: react:components\n",
            "description: React component workflow\n",
            "license: Apache-2.0\n",
            "metadata:\n",
            "  title: React Components\n",
            "  category: React\n",
            "---\n",
            "# React Components\n"
        ),
    );

    upsert_skill(&client, "default", temp.path(), "react-components", false)
        .await
        .expect("upstream name does not need to match DB id");
    let manifest = client
        .read_node("default", "/Skills/react-components/manifest.md")
        .await
        .expect("read manifest")
        .expect("manifest exists")
        .content;
    assert!(manifest.contains("id: react-components"));
    assert!(manifest.contains("title: React Components"));
    assert!(manifest.contains("summary: React component workflow"));
    assert!(manifest.contains("- React"));
    assert!(manifest.contains("license: Apache-2.0"));
}

#[tokio::test]
async fn skill_set_status_adds_missing_root_status_without_touching_body() {
    let client = SkillMockClient::default();
    let manifest_path = "/Skills/legal-review/manifest.md";
    client
        .write_node(WriteNodeRequest {
            database_id: "default".to_string(),
            path: manifest_path.to_string(),
            kind: NodeKind::File,
            content: concat!(
                "---\n",
                "kind: kinic.skill\n",
                "schema_version: 1\n",
                "id: legal-review\n",
                "version: 0.1.0\n",
                "x-team: acme\n",
                "entry: SKILL.md\n",
                "provenance:\n",
                "  status: upstream-reviewed\n",
                "---\n",
                "# Body\n"
            )
            .to_string(),
            metadata_json: "{}".to_string(),
            expected_etag: None,
        })
        .await
        .expect("seed manifest");

    set_skill_status(
        &client,
        "default",
        "legal-review",
        SkillStatusArg::Draft,
        None,
    )
    .await
    .expect("set status");

    let updated = client
        .read_node("default", manifest_path)
        .await
        .expect("read manifest")
        .expect("manifest exists")
        .content;
    assert!(updated.contains("  status: upstream-reviewed\nstatus: draft\n---\n# Body\n"));
}

#[tokio::test]
async fn skill_set_status_records_deprecated_reason() {
    let client = SkillMockClient::default();
    let temp = tempfile::tempdir().expect("tempdir");
    write(temp.path(), "SKILL.md", "# Legal Review\n\nredlines");
    write(temp.path(), "manifest.md", &manifest("reviewed"));
    upsert_skill(&client, "default", temp.path(), "legal-review", false)
        .await
        .expect("upsert");

    set_skill_status(
        &client,
        "default",
        "legal-review",
        SkillStatusArg::Deprecated,
        Some("replaced by safer workflow"),
    )
    .await
    .expect("set deprecated");

    let found = find_skills(&client, "default", "redlines", true, 10)
        .await
        .expect("find deprecated");
    assert_eq!(
        found["hits"][0]["deprecated_reason"],
        "replaced by safer workflow"
    );
    let manifest = client
        .read_node("default", "/Skills/legal-review/manifest.md")
        .await
        .expect("read manifest")
        .expect("manifest exists")
        .content;
    assert_rfc3339_field(&manifest, "deprecated_at");
}

#[tokio::test]
async fn skill_set_status_records_promoted_at_as_rfc3339() {
    let client = SkillMockClient::default();
    let temp = tempfile::tempdir().expect("tempdir");
    write(temp.path(), "SKILL.md", "# Legal Review\n\nredlines");
    write(temp.path(), "manifest.md", &manifest("reviewed"));
    upsert_skill(&client, "default", temp.path(), "legal-review", false)
        .await
        .expect("upsert");

    set_skill_status(
        &client,
        "default",
        "legal-review",
        SkillStatusArg::Promoted,
        None,
    )
    .await
    .expect("set promoted");

    let manifest = client
        .read_node("default", "/Skills/legal-review/manifest.md")
        .await
        .expect("read manifest")
        .expect("manifest exists")
        .content;
    assert_rfc3339_field(&manifest, "promoted_at");
}

#[tokio::test]
async fn skill_set_status_removes_stale_status_metadata() {
    let client = SkillMockClient::default();
    let temp = tempfile::tempdir().expect("tempdir");
    write(temp.path(), "SKILL.md", "# Legal Review\n\nredlines");
    write(temp.path(), "manifest.md", &manifest("reviewed"));
    upsert_skill(&client, "default", temp.path(), "legal-review", false)
        .await
        .expect("upsert");

    set_skill_status(
        &client,
        "default",
        "legal-review",
        SkillStatusArg::Promoted,
        None,
    )
    .await
    .expect("set promoted");
    set_skill_status(
        &client,
        "default",
        "legal-review",
        SkillStatusArg::Deprecated,
        Some("retired"),
    )
    .await
    .expect("set deprecated");

    let deprecated = client
        .read_node("default", "/Skills/legal-review/manifest.md")
        .await
        .expect("read manifest")
        .expect("manifest exists")
        .content;
    assert!(!deprecated.contains("promoted_at:"));
    assert_rfc3339_field(&deprecated, "deprecated_at");
    assert!(deprecated.contains("deprecated_reason: retired"));

    set_skill_status(
        &client,
        "default",
        "legal-review",
        SkillStatusArg::Reviewed,
        None,
    )
    .await
    .expect("set reviewed");

    let reviewed = client
        .read_node("default", "/Skills/legal-review/manifest.md")
        .await
        .expect("read manifest")
        .expect("manifest exists")
        .content;
    assert!(!reviewed.contains("promoted_at:"));
    assert!(!reviewed.contains("deprecated_at:"));
    assert!(!reviewed.contains("deprecated_reason:"));
}

#[test]
fn skill_markdown_targets_normalize_package_local_paths() {
    assert_eq!(
        markdown_target_package_key("ingest.md").as_deref(),
        Some("ingest.md")
    );
    assert_eq!(
        markdown_target_package_key("./docs/usage.md#setup").as_deref(),
        Some("docs/usage.md")
    );
    assert_eq!(
        markdown_target_package_key("docs/Project Plan.md").as_deref(),
        Some("docs/Project Plan.md")
    );
    assert_eq!(
        markdown_target_package_key("<docs/Project Plan.md>").as_deref(),
        Some("docs/Project Plan.md")
    );
    assert_eq!(
        markdown_target_package_key("docs/Project (Alpha).md").as_deref(),
        Some("docs/Project (Alpha).md")
    );
    assert_eq!(
        markdown_target_package_key("docs/usage.md \"Usage\"").as_deref(),
        Some("docs/usage.md")
    );
    assert_eq!(
        markdown_target_package_key("<docs/Project Plan.md> 'Project plan'").as_deref(),
        Some("docs/Project Plan.md")
    );
    assert_eq!(
        markdown_target_package_key("docs/usage.md (Usage)").as_deref(),
        Some("docs/usage.md")
    );
    assert_eq!(markdown_target_package_key("../outside.md"), None);
    assert_eq!(markdown_target_package_key("/Skills/x.md"), None);
    assert_eq!(
        markdown_target_package_key("https://example.com/x.md"),
        None
    );
    assert_eq!(markdown_target_package_key("image.png"), None);
}

fn write(dir: &Path, name: &str, content: &str) {
    std::fs::write(dir.join(name), content).expect("write fixture");
}

async fn seed_legal_review_skill(client: &SkillMockClient, dir: &Path) {
    write(dir, "SKILL.md", "# Legal Review\n");
    write(dir, "manifest.md", &manifest("reviewed"));
    upsert_skill(client, "team-db", dir, "legal-review", false)
        .await
        .expect("upsert");
}

async fn seed_skill_package(client: &SkillMockClient, database_id: &str, id: &str, status: &str) {
    let manifest = manifest(status).replace("id: legal-review", &format!("id: {id}"));
    client
        .write_node(WriteNodeRequest {
            database_id: database_id.to_string(),
            path: format!("/Skills/{id}/manifest.md"),
            kind: NodeKind::File,
            content: manifest,
            metadata_json: "{}".to_string(),
            expected_etag: None,
        })
        .await
        .expect("seed manifest");
    client
        .write_node(WriteNodeRequest {
            database_id: database_id.to_string(),
            path: format!("/Skills/{id}/SKILL.md"),
            kind: NodeKind::File,
            content: format!("# {id}\n"),
            metadata_json: "{}".to_string(),
            expected_etag: None,
        })
        .await
        .expect("seed skill");
}

fn skill_list_ids(value: &serde_json::Value) -> Vec<&str> {
    value["skills"]
        .as_array()
        .unwrap()
        .iter()
        .map(|skill| skill["id"].as_str().unwrap())
        .collect()
}

fn has_sync_conflict(value: &serde_json::Value, reason: &str) -> bool {
    value["conflicts"]
        .as_array()
        .unwrap()
        .iter()
        .any(|conflict| conflict["reason"] == reason)
}

fn assert_rfc3339_field(content: &str, key: &str) {
    let prefix = format!("{key}: ");
    let value = content
        .lines()
        .find_map(|line| line.strip_prefix(&prefix))
        .unwrap_or_else(|| panic!("{key} should exist"));
    DateTime::parse_from_rfc3339(value).expect("timestamp should be RFC3339");
    assert!(value.ends_with('Z'));
}

fn assert_mkdirs_include(client: &SkillMockClient, expected: &[&str]) {
    let mkdirs = client.mkdirs.lock().expect("mkdir lock");
    for path in expected {
        assert!(
            mkdirs.iter().any(|mkdir| mkdir == path),
            "expected mkdir for {path}, got {mkdirs:?}"
        );
    }
}

async fn write_skill_file(client: &SkillMockClient, database_id: &str, path: &str, content: &str) {
    let expected_etag = client
        .read_node(database_id, path)
        .await
        .expect("read skill file")
        .map(|node| node.etag);
    client
        .write_node(WriteNodeRequest {
            database_id: database_id.to_string(),
            path: path.to_string(),
            kind: NodeKind::File,
            content: content.to_string(),
            metadata_json: "{}".to_string(),
            expected_etag,
        })
        .await
        .expect("write skill file");
}

fn manifest(status: &str) -> String {
    format!(
        concat!(
            "---\n",
            "kind: kinic.skill\n",
            "schema_version: 1\n",
            "id: legal-review\n",
            "version: 0.1.0\n",
            "x-team: acme\n",
            "entry: SKILL.md\n",
            "summary: Contract review workflow for spotting redlines, risk clauses, and missing approval context\n",
            "tags:\n",
            "  - legal\n",
            "  - contract\n",
            "  - review\n",
            "  - risk\n",
            "use_cases:\n",
            "  - Review vendor contract redlines before counsel handoff\n",
            "  - Summarize risky clauses and negotiation blockers\n",
            "  - Check whether approval, renewal, and liability terms are documented\n",
            "status: {status}\n",
            "replaces: []\n",
            "related:\n",
            "  - /Knowledge/legal/contract-review-playbook.md\n",
            "  - /Sources/github/legal-review\n",
            "knowledge:\n",
            "  - /Knowledge/legal/contract-review-playbook.md\n",
            "permissions:\n",
            "  file_read: true\n",
            "  network: false\n",
            "  shell: false\n",
            "provenance:\n",
            "  source: github.com/legal-review\n",
            "  source_ref: demo\n",
            "---\n",
            "# Skill Manifest\n"
        ),
        status = status
    )
}

fn skill_registry_property_config() -> ProptestConfig {
    ProptestConfig {
        cases: std::env::var("PROPTEST_CASES")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(128),
        failure_persistence: Some(Box::new(FileFailurePersistence::Off)),
        ..ProptestConfig::default()
    }
}

fn pbt_skill_status(value: u8) -> SkillStatusArg {
    match value % 4 {
        0 => SkillStatusArg::Draft,
        1 => SkillStatusArg::Reviewed,
        2 => SkillStatusArg::Promoted,
        _ => SkillStatusArg::Deprecated,
    }
}

fn pbt_skill_status_text(status: SkillStatusArg) -> &'static str {
    match status {
        SkillStatusArg::Draft => "draft",
        SkillStatusArg::Reviewed => "reviewed",
        SkillStatusArg::Promoted => "promoted",
        SkillStatusArg::Deprecated => "deprecated",
    }
}

fn pbt_manifest(id: &str, status: &str) -> String {
    format!(
        concat!(
            "---\n",
            "kind: kinic.skill\n",
            "schema_version: 1\n",
            "id: {id}\n",
            "version: 0.1.0\n",
            "entry: SKILL.md\n",
            "summary: PBT generated skill\n",
            "status: {status}\n",
            "---\n",
            "# Skill Manifest\n"
        ),
        id = id,
        status = status
    )
}

fn write_pbt_skill_package(dir: &Path, id: &str, body: &str) {
    std::fs::create_dir_all(dir.join("docs")).expect("docs dir");
    write(
        dir,
        "SKILL.md",
        &format!(
            concat!(
                "---\n",
                "description: PBT generated skill\n",
                "license: MIT\n",
                "metadata:\n",
                "  title: PBT {id}\n",
                "  category: fuzz\n",
                "---\n",
                "# {id}\n\n",
                "{body}\n\n",
                "[Details](docs/details.md)\n",
                "[More](docs/more.md)\n",
                "[External](https://example.com/ignored.md)\n"
            ),
            id = id,
            body = body
        ),
    );
    write(dir, "manifest.md", &pbt_manifest(id, "draft"));
    write(dir, "provenance.md", "source: pbt\n");
    write(dir, "evals.md", "eval: pbt\n");
    write(dir, "docs/details.md", "package detail\n");
    write(dir, "docs/more.md", "more package detail\n");
}

async fn seed_stale_skill_files(client: &SkillMockClient, id: &str) {
    for path in [
        format!("/Skills/{id}/stale.md"),
        format!("/Skills/{id}/docs/old.md"),
        format!("/Skills/{id}/nested/stale.md"),
    ] {
        client
            .write_node(WriteNodeRequest {
                database_id: "team-db".to_string(),
                path,
                kind: NodeKind::File,
                content: "stale\n".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            })
            .await
            .expect("stale file should seed");
    }
}

async fn pbt_remote_package_paths(client: &SkillMockClient, id: &str) -> BTreeSet<String> {
    client
        .list_nodes(ListNodesRequest {
            database_id: "team-db".to_string(),
            prefix: format!("/Skills/{id}"),
            recursive: true,
            limit: 100,
        })
        .await
        .expect("package nodes should list")
        .into_iter()
        .filter(|entry| entry.kind == NodeEntryKind::File)
        .map(|entry| entry.path)
        .collect()
}

async fn assert_pbt_package_contents(client: &SkillMockClient, id: &str) {
    let base = format!("/Skills/{id}");
    let expected = BTreeSet::from([
        format!("{base}/SKILL.md"),
        format!("{base}/manifest.md"),
        format!("{base}/provenance.md"),
        format!("{base}/evals.md"),
        format!("{base}/docs/details.md"),
        format!("{base}/docs/more.md"),
    ]);
    assert_eq!(pbt_remote_package_paths(client, id).await, expected);
    for (path, expected_content) in [
        (format!("{base}/provenance.md"), "source: pbt\n"),
        (format!("{base}/evals.md"), "eval: pbt\n"),
        (format!("{base}/docs/details.md"), "package detail\n"),
        (format!("{base}/docs/more.md"), "more package detail\n"),
    ] {
        assert_eq!(
            client
                .read_node("team-db", &path)
                .await
                .expect("package file read")
                .expect("package file exists")
                .content,
            expected_content
        );
    }
}

async fn assert_single_run_plus_corrections(client: &SkillMockClient, id: &str, run_id: &str) {
    let run_prefix = format!("/Sources/skill-runs/{id}");
    let entries = client
        .list_nodes(ListNodesRequest {
            database_id: "team-db".to_string(),
            prefix: run_prefix,
            recursive: true,
            limit: 100,
        })
        .await
        .expect("run entries should list");
    let run_count = entries
        .iter()
        .filter(|entry| entry.path.ends_with(&format!("{run_id}.md")))
        .count();
    let correction_count = entries
        .iter()
        .filter(|entry| entry.path.contains(&format!("{run_id}.correction.")))
        .count();
    assert_eq!(run_count, 1);
    assert_eq!(correction_count, 1);
}

proptest! {
    #![proptest_config(skill_registry_property_config())]

    #[test]
    fn skill_registry_pbt(
        id in "[a-z][a-z0-9]{0,8}",
        run_id in "[a-z][a-z0-9]{0,8}",
        status_value in 0_u8..4,
    ) {
        let runtime = tokio::runtime::Runtime::new().expect("tokio runtime");
        runtime.block_on(async move {
            let client = SkillMockClient::default();
            let temp = TempDir::new().expect("temp dir");
            write_pbt_skill_package(temp.path(), &id, "initial body");
            seed_stale_skill_files(&client, &id).await;

            let upsert = upsert_skill(&client, "team-db", temp.path(), &id, true)
                .await
                .expect("upsert should succeed");
            let written = upsert["written_paths"].as_array().expect("written paths");
            assert!(written.iter().any(|path| path == &serde_json::json!(format!("/Skills/{id}/SKILL.md"))));
            assert!(written.iter().any(|path| path == &serde_json::json!(format!("/Skills/{id}/manifest.md"))));
            assert!(written.iter().any(|path| path == &serde_json::json!(format!("/Skills/{id}/docs/details.md"))));
            let pruned = upsert["pruned_paths"].as_array().expect("pruned paths");
            assert!(pruned.iter().any(|path| path == &serde_json::json!(format!("/Skills/{id}/stale.md"))));
            assert_pbt_package_contents(&client, &id).await;

            let status = pbt_skill_status(status_value);
            set_skill_status(
                &client,
                "team-db",
                &id,
                status,
                Some("pbt deprecation reason"),
            )
            .await
            .expect("status should update");
            let manifest = client
                .read_node("team-db", &format!("/Skills/{id}/manifest.md"))
                .await
                .expect("manifest read")
                .expect("manifest node");
            assert!(manifest.content.contains(&format!("status: {}", pbt_skill_status_text(status))));
            assert!(manifest.content.contains("# Skill Manifest"));

            let evidence = temp.path().join("evidence.json");
            std::fs::write(
                &evidence,
                serde_json::json!({
                    "run_id": run_id,
                    "task": "pbt task",
                    "task_outcome": "success",
                    "agent_outcome": "success",
                    "agent": "pbt",
                    "summary": "ok"
                })
                .to_string(),
            )
            .expect("evidence write");
            record_skill_run_evidence_with_override(
                &client,
                SkillRunEvidenceInput {
                    database_id: "team-db",
                    id: &id,
                    evidence_json: &evidence,
                },
                Some(&run_id),
            )
            .await
            .expect("run evidence should record");
            assert!(
                record_skill_run_evidence_with_override(
                    &client,
                    SkillRunEvidenceInput {
                        database_id: "team-db",
                        id: &id,
                        evidence_json: &evidence,
                    },
                    Some(&run_id),
                )
                .await
                .is_err()
            );
            let notes = temp.path().join("correction.md");
            std::fs::write(&notes, "correction\n").expect("correction write");
            record_correction(&client, "team-db", &id, &run_id, &notes)
                .await
                .expect("correction should record");
            assert_single_run_plus_corrections(&client, &id, &run_id).await;

            let projection = temp.path().join("projection");

            write_skill_file(
                &client,
                "team-db",
                &format!("/Skills/{id}/manifest.md"),
                &pbt_manifest(&id, "reviewed"),
            )
            .await;
            std::fs::create_dir_all(projection.join("stale-managed")).expect("managed dir");
            std::fs::write(projection.join("stale-managed/SKILL.md"), "stale\n")
                .expect("managed skill");
            std::fs::create_dir_all(projection.join("manual")).expect("manual dir");
            std::fs::write(projection.join("README.md"), "unmanaged\n").expect("unmanaged file");
            sync_projection(&client, "team-db", &projection)
                .await
                .expect("projection should sync");
            assert!(projection.join(&id).join("SKILL.md").is_file());
            assert!(!projection.join("stale-managed").exists());
            assert!(projection.join("manual").is_dir());
            assert!(projection.join("README.md").is_file());
        });
    }
}
