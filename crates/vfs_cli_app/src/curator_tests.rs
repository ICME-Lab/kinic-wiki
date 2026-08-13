// Curator behavior tests live here so they can exercise crate-private validation helpers.
use crate::cli::{Cli, Command, CuratorCommand};
use crate::commands_fs_tests::MockClient;
use crate::curator::test_support::{
    CuratorStatus, apply_curator_plan, curator_error_json, markdown_body, parse_and_validate_plan,
    parse_curator_status_checked, render_curated_content, scan_curator, store_for_path,
    write_private_json,
};
use crate::curator::{
    CuratorChange, CuratorPlanV1, CuratorProposal, CuratorStore, FindingConfidence,
    SemanticEvidence, SemanticFinding,
};
use clap::Parser;
use std::collections::BTreeMap;
use vfs_types::{
    ExportSnapshotResponse, LinkEdge, Node, NodeKind, NodeMutation, NodeMutationError,
    NodeMutationErrorCode, SourceEvidence, SourceEvidenceRef,
};

fn node(path: &str, kind: NodeKind, content: &str, updated_at: i64, etag: &str) -> Node {
    Node {
        path: path.to_string(),
        kind,
        content: content.to_string(),
        created_at: 1,
        updated_at,
        etag: etag.to_string(),
        metadata_json: r#"{"keep":true}"#.to_string(),
    }
}

fn valid_plan(changes: Vec<CuratorChange>) -> CuratorPlanV1 {
    CuratorPlanV1 {
        schema_version: "kinic.curator.plan.v1".to_string(),
        database_id: "default".to_string(),
        canister_id: "aaaaa-aa".to_string(),
        snapshot_revision: "v5:1:2f".to_string(),
        agent: "codex-test".to_string(),
        findings: vec![SemanticFinding {
            id: "F001".to_string(),
            kind: "possible_conflict".to_string(),
            confidence: FindingConfidence::High,
            store: CuratorStore::Knowledge,
            summary: "conflict".to_string(),
            paths: vec!["/Knowledge/a.md".to_string(), "/Knowledge/b.md".to_string()],
            evidence: vec![
                SemanticEvidence {
                    path: "/Knowledge/a.md".to_string(),
                    excerpt: "first claim".to_string(),
                },
                SemanticEvidence {
                    path: "/Knowledge/b.md".to_string(),
                    excerpt: "second claim".to_string(),
                },
            ],
        }],
        proposals: vec![CuratorProposal {
            id: "P001".to_string(),
            finding_ids: vec!["F001".to_string()],
            summary: "update a".to_string(),
            rationale: "use current evidence".to_string(),
            confidence: FindingConfidence::High,
            changes,
        }],
    }
}

#[test]
fn classifies_all_store_roots_without_prefix_bleed() {
    assert_eq!(store_for_path("/Memory/facts.md"), CuratorStore::Memory);
    assert_eq!(store_for_path("/Knowledge/a.md"), CuratorStore::Knowledge);
    assert_eq!(store_for_path("/Skills/x/SKILL.md"), CuratorStore::Skill);
    assert_eq!(store_for_path("/Sessions/s.md"), CuratorStore::Session);
    assert_eq!(
        store_for_path("/Sources/web/a.md"),
        CuratorStore::SourceEvidence
    );
    assert_eq!(store_for_path("/SourcesBackup/a.md"), CuratorStore::Other);
}

#[test]
fn curator_cli_requires_one_exclusive_proposal_selection() {
    let missing = Cli::try_parse_from(["kinic-vfs-cli", "curator", "apply", "--plan", "plan.json"]);
    assert!(missing.is_err());
    let conflict = Cli::try_parse_from([
        "kinic-vfs-cli",
        "curator",
        "apply",
        "--plan",
        "plan.json",
        "--proposal",
        "P001",
        "--all",
    ]);
    assert!(conflict.is_err());

    let parsed = Cli::try_parse_from([
        "kinic-vfs-cli",
        "curator",
        "apply",
        "--plan",
        "plan.json",
        "--proposal",
        "P001",
    ])
    .expect("proposal selection should parse");
    let Command::Curator {
        command: CuratorCommand::Apply { confirm, .. },
    } = parsed.command
    else {
        panic!("expected curator apply");
    };
    assert!(!confirm);
}

#[test]
fn curator_frontmatter_preserves_domain_status_and_body_boundary() {
    let current = "---\nstatus: reviewed\ntitle: Keep\ncurator:\n  status: stale\n  updated_at: old\n  updated_by: old-agent\n---\nold body\n";
    let rendered = render_curated_content(
        current,
        Some("new body\n"),
        Some(CuratorStatus::Active),
        "codex",
        "2026-08-13T00:00:00Z",
    )
    .expect("content should render");

    assert!(rendered.contains("status: reviewed\ntitle: Keep\ncurator:"));
    assert!(rendered.contains("  status: active"));
    assert!(rendered.contains("updated_by: \"codex\""));
    assert_eq!(markdown_body(&rendered), "new body\n");
    assert_eq!(
        parse_curator_status_checked(&rendered),
        Ok(Some(CuratorStatus::Active))
    );
}

#[test]
fn curator_body_replacement_separates_frontmatter_closed_at_eof() {
    let current = "---\nstatus: reviewed\ntitle: Keep\n---";
    let rendered = render_curated_content(
        current,
        Some("new body\n"),
        None,
        "codex",
        "2026-08-13T00:00:00Z",
    )
    .expect("content should render");

    assert_eq!(
        rendered,
        "---\nstatus: reviewed\ntitle: Keep\n---\nnew body\n"
    );
    assert_eq!(markdown_body(&rendered), "new body\n");
}

#[test]
fn missing_status_is_active_but_invalid_status_is_rejected() {
    assert_eq!(parse_curator_status_checked("# Plain"), Ok(None));
    let invalid = "---\ncurator:\n  status: promoted\n---\nbody";
    assert!(
        parse_curator_status_checked(invalid)
            .expect_err("unsupported status should fail")
            .contains("unsupported curator.status")
    );
}

#[cfg(unix)]
#[test]
fn curator_artifacts_are_private_on_create_and_overwrite() {
    use std::os::unix::fs::PermissionsExt;

    let directory = tempfile::tempdir().expect("temp directory should exist");
    let path = directory.path().join("scan.curator-scan.json");
    write_private_json(&path, &serde_json::json!({"private": true}), false)
        .expect("artifact creation should succeed");
    assert_eq!(
        std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );

    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
    write_private_json(&path, &serde_json::json!({"private": "updated"}), true)
        .expect("artifact overwrite should succeed");
    assert_eq!(
        std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
}

#[test]
fn strict_plan_validation_rejects_unknown_fields_and_source_mutation() {
    let plan = valid_plan(vec![CuratorChange {
        path: "/Knowledge/a.md".to_string(),
        expected_etag: "etag-a".to_string(),
        replacement_body: Some("new".to_string()),
        target_status: None,
    }]);
    let mut json = serde_json::to_value(&plan).expect("plan should serialize");
    json.as_object_mut()
        .expect("plan should be object")
        .insert("unknown".to_string(), serde_json::json!(true));
    assert!(parse_and_validate_plan(&serde_json::to_vec(&json).unwrap()).is_err());

    let source_plan = valid_plan(vec![CuratorChange {
        path: "/Sources/web/a.md".to_string(),
        expected_etag: "etag-source".to_string(),
        replacement_body: Some("changed".to_string()),
        target_status: None,
    }]);
    let error = parse_and_validate_plan(&serde_json::to_vec(&source_plan).unwrap())
        .expect_err("source mutation should fail");
    assert!(
        error
            .to_string()
            .contains("must not mutate source evidence")
    );
}

#[test]
fn plan_validation_rejects_duplicate_paths_low_confidence_and_large_batches() {
    let change = CuratorChange {
        path: "/Knowledge/a.md".to_string(),
        expected_etag: "etag-a".to_string(),
        replacement_body: Some("new".to_string()),
        target_status: None,
    };
    let duplicate = valid_plan(vec![change.clone(), change]);
    assert!(
        parse_and_validate_plan(&serde_json::to_vec(&duplicate).unwrap())
            .expect_err("duplicate should fail")
            .to_string()
            .contains("same path")
    );

    let mut low = valid_plan(vec![CuratorChange {
        path: "/Knowledge/a.md".to_string(),
        expected_etag: "etag-a".to_string(),
        replacement_body: None,
        target_status: Some(CuratorStatus::Stale),
    }]);
    low.proposals[0].confidence = FindingConfidence::Low;
    assert!(parse_and_validate_plan(&serde_json::to_vec(&low).unwrap()).is_err());

    let many = valid_plan(
        (0..101)
            .map(|index| CuratorChange {
                path: format!("/Knowledge/{index}.md"),
                expected_etag: format!("etag-{index}"),
                replacement_body: None,
                target_status: Some(CuratorStatus::Stale),
            })
            .collect(),
    );
    assert!(
        parse_and_validate_plan(&serde_json::to_vec(&many).unwrap())
            .expect_err("large plan should fail")
            .to_string()
            .contains("maximum is 100")
    );
}

#[tokio::test]
async fn scan_pages_snapshot_and_reports_cross_store_findings() {
    let knowledge = node(
        "/Knowledge/a.md",
        NodeKind::File,
        "[missing](/Knowledge/missing.md)",
        1,
        "etag-a",
    );
    let source = node(
        "/Sources/web/source.md",
        NodeKind::Source,
        "raw",
        10,
        "etag-source",
    );
    let mut outgoing = BTreeMap::new();
    outgoing.insert(
        knowledge.path.clone(),
        vec![LinkEdge {
            source_path: knowledge.path.clone(),
            target_path: "/Knowledge/missing.md".to_string(),
            raw_href: "/Knowledge/missing.md".to_string(),
            link_text: "missing".to_string(),
            link_kind: "markdown".to_string(),
            updated_at: 1,
        }],
    );
    let mut evidence = BTreeMap::new();
    evidence.insert(
        knowledge.path.clone(),
        SourceEvidence {
            node_path: knowledge.path.clone(),
            refs: vec![SourceEvidenceRef {
                source_path: source.path.clone(),
                via_path: knowledge.path.clone(),
                raw_href: source.path.clone(),
                link_text: "source".to_string(),
                source_etag: Some(source.etag.clone()),
                source_updated_at: Some(source.updated_at),
                source_content_hash: None,
            }],
        },
    );
    let client = MockClient {
        nodes: vec![knowledge.clone(), source.clone()],
        outgoing,
        evidence,
        snapshot_pages: vec![
            ExportSnapshotResponse {
                snapshot_revision: "rev-1".to_string(),
                snapshot_session_id: None,
                nodes: vec![knowledge],
                next_cursor: Some("/Knowledge/a.md".to_string()),
            },
            ExportSnapshotResponse {
                snapshot_revision: "rev-1".to_string(),
                snapshot_session_id: None,
                nodes: vec![source],
                next_cursor: None,
            },
        ],
        ..Default::default()
    };

    let scan = scan_curator(
        &client,
        "default",
        "aaaaa-aa",
        90,
        100 * 24 * 60 * 60 * 1_000,
    )
    .await
    .expect("scan should succeed");
    assert_eq!(scan.nodes.len(), 2);
    assert!(scan.coverage.complete);
    assert!(
        scan.findings
            .iter()
            .any(|finding| finding.kind == "broken_internal_link")
    );
    assert!(
        scan.findings
            .iter()
            .any(|finding| finding.kind == "source_newer_than_node")
    );
    assert!(
        scan.findings
            .iter()
            .any(|finding| finding.kind == "age_review_due")
    );
    assert!(
        scan.findings
            .iter()
            .any(|finding| finding.kind == "orphan_source_evidence")
    );
}

#[tokio::test]
async fn scan_rejects_snapshot_revision_drift() {
    let client = MockClient {
        snapshot_pages: vec![
            ExportSnapshotResponse {
                snapshot_revision: "rev-1".to_string(),
                snapshot_session_id: None,
                nodes: Vec::new(),
                next_cursor: Some("/Knowledge/a.md".to_string()),
            },
            ExportSnapshotResponse {
                snapshot_revision: "rev-2".to_string(),
                snapshot_session_id: None,
                nodes: Vec::new(),
                next_cursor: None,
            },
        ],
        ..Default::default()
    };
    assert!(
        scan_curator(&client, "default", "aaaaa-aa", 90, 1)
            .await
            .expect_err("revision drift should fail")
            .to_string()
            .contains("revision changed")
    );
}

#[tokio::test]
async fn scan_uses_inclusive_stale_boundary_and_reports_store_specific_health() {
    const DAY_MS: i64 = 24 * 60 * 60 * 1_000;
    let nodes = vec![
        node(
            "/Memory/facts.md",
            NodeKind::File,
            "deadline: tomorrow",
            10,
            "etag-facts",
        ),
        node(
            "/Skills/review/SKILL.md",
            NodeKind::File,
            "# Review",
            10,
            "etag-skill",
        ),
        node(
            "/Sessions/session.md",
            NodeKind::File,
            "# Session",
            10,
            "etag-session",
        ),
    ];
    let client = MockClient {
        nodes,
        ..Default::default()
    };
    let scan = scan_curator(&client, "default", "aaaaa-aa", 90, 10 + 90 * DAY_MS)
        .await
        .expect("boundary scan should succeed");
    for kind in [
        "age_review_due",
        "isolated_node",
        "facts_future_item",
        "skill_manifest_missing",
        "skill_provenance_missing",
        "skill_run_evidence_missing",
        "session_evidence_missing",
    ] {
        assert!(
            scan.findings.iter().any(|finding| finding.kind == kind),
            "missing finding {kind}"
        );
    }

    let before_boundary = scan_curator(&client, "default", "aaaaa-aa", 90, 9 + 90 * DAY_MS)
        .await
        .expect("pre-boundary scan should succeed");
    assert!(
        !before_boundary
            .findings
            .iter()
            .any(|finding| finding.kind == "age_review_due")
    );
}

#[tokio::test]
async fn apply_dry_run_preserves_kind_metadata_and_confirm_uses_one_batch() {
    let current = node(
        "/Knowledge/a.md",
        NodeKind::File,
        "---\nstatus: reviewed\n---\nold body",
        3,
        "etag-a",
    );
    let client = MockClient {
        nodes: vec![current],
        ..Default::default()
    };
    let plan = valid_plan(vec![CuratorChange {
        path: "/Knowledge/a.md".to_string(),
        expected_etag: "etag-a".to_string(),
        replacement_body: Some("new body".to_string()),
        target_status: Some(CuratorStatus::Active),
    }]);

    let preview = apply_curator_plan(
        &client,
        "default",
        "aaaaa-aa",
        &plan,
        &["P001".to_string()],
        false,
        false,
    )
    .await
    .expect("dry-run should succeed");
    assert!(preview.dry_run);
    assert!(client.mutation_batches.lock().unwrap().is_empty());

    apply_curator_plan(
        &client,
        "default",
        "aaaaa-aa",
        &plan,
        &["P001".to_string()],
        false,
        true,
    )
    .await
    .expect("confirmed apply should succeed");
    let batches = client.mutation_batches.lock().unwrap();
    assert_eq!(batches.len(), 1);
    assert_eq!(batches[0].operations.len(), 1);
    let NodeMutation::Write(write) = &batches[0].operations[0] else {
        panic!("curator should use write mutation");
    };
    assert_eq!(write.kind, NodeKind::File);
    assert_eq!(write.metadata_json, r#"{"keep":true}"#);
    assert!(write.content.contains("status: reviewed"));
    assert!(write.content.contains("new body"));
}

#[tokio::test]
async fn etag_conflict_stops_before_atomic_batch() {
    let client = MockClient {
        nodes: vec![node(
            "/Knowledge/a.md",
            NodeKind::File,
            "old",
            3,
            "etag-new",
        )],
        ..Default::default()
    };
    let plan = valid_plan(vec![CuratorChange {
        path: "/Knowledge/a.md".to_string(),
        expected_etag: "etag-old".to_string(),
        replacement_body: Some("new".to_string()),
        target_status: None,
    }]);
    let error = apply_curator_plan(
        &client,
        "default",
        "aaaaa-aa",
        &plan,
        &["P001".to_string()],
        false,
        true,
    )
    .await
    .expect_err("etag conflict should fail");
    assert!(error.to_string().contains("etag conflict"));
    assert!(client.mutation_batches.lock().unwrap().is_empty());
}

#[tokio::test]
async fn batch_failure_retains_structured_error_fields() {
    let client = MockClient {
        nodes: vec![node("/Knowledge/a.md", NodeKind::File, "old", 3, "etag-a")],
        mutation_error: Some(NodeMutationError {
            code: NodeMutationErrorCode::EtagConflict,
            message: "conflict".to_string(),
            failed_index: Some(0),
            conflict_path: Some("/Knowledge/a.md".to_string()),
        }),
        ..Default::default()
    };
    let plan = valid_plan(vec![CuratorChange {
        path: "/Knowledge/a.md".to_string(),
        expected_etag: "etag-a".to_string(),
        replacement_body: Some("new".to_string()),
        target_status: None,
    }]);
    let error = apply_curator_plan(
        &client,
        "default",
        "aaaaa-aa",
        &plan,
        &["P001".to_string()],
        false,
        true,
    )
    .await
    .expect_err("batch should fail");
    let json = curator_error_json(&error);
    assert_eq!(json["error"]["code"], "etag_conflict");
    assert_eq!(json["error"]["failed_index"], 0);
    assert_eq!(json["error"]["conflict_path"], "/Knowledge/a.md");
}
