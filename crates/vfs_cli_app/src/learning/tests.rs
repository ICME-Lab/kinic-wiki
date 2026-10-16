use super::*;
use serde_json::json;

#[test]
fn outbox_deduplicates_identical_events_and_rejects_reused_ids() {
    let dir = tempfile::tempdir().unwrap();
    let outbox = Outbox::open(dir.path(), "canister", "db", "principal").unwrap();
    let event = Event {
        id: "event-1".into(),
        run_id: "run-1".into(),
        kind: "outcome".into(),
        payload: json!({"success":false}),
    };
    outbox.enqueue(&event).unwrap();
    outbox.enqueue(&event).unwrap();
    assert_eq!(outbox.pending().unwrap().len(), 1);
    let changed = Event {
        payload: json!({"success":true}),
        ..event
    };
    assert!(outbox.enqueue(&changed).is_err());
    let other = Outbox::open(dir.path(), "canister", "other-db", "principal").unwrap();
    assert!(other.pending().unwrap().is_empty());
}

#[test]
fn incomplete_or_self_reported_outcome_is_not_verified_success() {
    let outcome = Outcome {
        claimed_success: Some(true),
        checks: vec![],
        complete: true,
        requirements_met: None,
    };
    assert!(!outcome.verified_success());
    let mut outcome = Outcome {
        checks: vec![CheckResult {
            argv: vec!["cargo".into(), "test".into()],
            exit_code: Some(0),
            output_hash: "abc".into(),
        }],
        requirements_met: Some(true),
        ..outcome
    };
    assert!(outcome.verified_success());
    outcome.complete = false;
    assert!(!outcome.verified_success());
}

#[test]
fn context_budget_keeps_exact_supplied_bytes_and_deduplicates() {
    let node = vfs_types::Node {
        path: "/Knowledge/a.md".into(),
        kind: vfs_types::NodeKind::File,
        content: "日本語の根拠です".repeat(200),
        created_at: 1,
        updated_at: 1,
        etag: "e1".into(),
        metadata_json: "{}".into(),
    };
    let receipt = assemble_context("r1", vec![node.clone(), node], 100).unwrap();
    assert_eq!(receipt.supplied.len(), 1);
    assert!(receipt.truncated);
    assert_eq!(
        receipt.supplied[0].content_hash,
        hash(&receipt.supplied[0].content)
    );
    assert!(receipt.rendered.chars().count() <= 400);
}

#[test]
fn protected_or_deprecated_lessons_cannot_be_auto_revised_or_recalled() {
    assert!(!agent_mutable(&json!({})));
    assert!(!agent_mutable(&json!({"authority":"human"})));
    assert!(agent_mutable(&json!({"authority":"agent"})));
    assert!(!agent_mutable(
        &json!({"authority":"agent","protected":true})
    ));
}

#[test]
fn index_namespace_separates_database_and_principal_and_model() {
    let dir = tempfile::tempdir().unwrap();
    let index = RetrievalIndex::open(dir.path(), "c", "db", "p", "model-a").unwrap();
    index
        .upsert("/Knowledge/x", "e", "socket timeout", &[1.0, 0.0])
        .unwrap();
    assert_eq!(
        index.semantic(&[1.0, 0.0], 5).unwrap(),
        vec!["/Knowledge/x"]
    );
    let other = RetrievalIndex::open(dir.path(), "c", "db", "p2", "model-a").unwrap();
    assert!(other.semantic(&[1.0, 0.0], 5).unwrap().is_empty());
    assert!(index.upsert("x", "e", "bad", &[f64::NAN]).is_err());
}

#[test]
fn learning_cli_commands_require_inputs_and_preserve_identity_resolution() {
    use crate::cli::{Cli, Command};
    use clap::Parser;
    let cli = Cli::try_parse_from([
        "kinic-vfs-cli",
        "agent",
        "record",
        "--event-file",
        "event.json",
        "--json",
    ])
    .unwrap();
    assert!(cli.command.requires_identity());
    assert!(Cli::try_parse_from(["kinic-vfs-cli", "learn", "promote"]).is_err());
    let cli = Cli::try_parse_from([
        "kinic-vfs-cli",
        "eval",
        "report",
        "--report-file",
        "report.json",
        "--json",
    ])
    .unwrap();
    assert!(!cli.command.requires_identity());
    assert!(matches!(cli.command, Command::Eval { .. }));
}

#[test]
fn rendered_context_keeps_metadata_and_contains_only_complete_frames() {
    let metadata = json!({"authority":"human","applies_to":["rust"],"exceptions":["windows"],"environment":{"os":"linux"}}).to_string();
    let node = vfs_types::Node {
        path: "/Knowledge/policy.md".into(),
        kind: vfs_types::NodeKind::File,
        content: "日本語\n\"\\".repeat(200),
        created_at: 1,
        updated_at: 1,
        etag: "e1".into(),
        metadata_json: metadata.clone(),
    };
    let receipt = assemble_context("metadata", vec![node.clone()], 100).unwrap();
    assert_eq!(receipt.supplied.len(), 1);
    assert!(receipt.rendered.chars().count() <= 400);
    let frame: serde_json::Value = serde_json::from_str(receipt.rendered.trim_end()).unwrap();
    assert_eq!(frame["metadata_json"], metadata);
    assert_eq!(frame["authority"], "human");
    assert_eq!(frame["path"], node.path);
    assert_eq!(frame["content"], receipt.supplied[0].content);
    assert_eq!(receipt.supplied[0].metadata_json, metadata);
    assert_eq!(receipt.supplied[0].source_hash, hash(&node.content));
    assert_eq!(
        receipt.supplied[0].content_hash,
        hash(&receipt.supplied[0].content)
    );
    assert!(receipt.supplied[0].truncated);
}

#[test]
fn context_omits_unfittable_headers_and_frames_have_exact_boundaries() {
    let first = vfs_types::Node {
        path: "/Knowledge/first.md".into(),
        kind: vfs_types::NodeKind::File,
        content: "first\nline".into(),
        created_at: 1,
        updated_at: 1,
        etag: "e".into(),
        metadata_json: r#"{"authority":"agent"}"#.into(),
    };
    let second = vfs_types::Node {
        path: "/Knowledge/second.md".into(),
        content: "second".into(),
        ..first.clone()
    };
    let full = assemble_context("full", vec![first.clone(), second.clone()], 1000).unwrap();
    let frames = full
        .rendered
        .lines()
        .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(frames.len(), 2);
    assert_eq!(frames[0]["content"], "first\nline");
    assert_eq!(frames[1]["content"], "second");
    assert!(!full.truncated);
    let tiny = assemble_context("tiny", vec![first.clone()], 1).unwrap();
    assert!(tiny.rendered.is_empty());
    assert!(tiny.supplied.is_empty());
    assert!(tiny.truncated);
    let exact = full.rendered.chars().count();
    // Every generated frame, including delimiters, consumes the declared budget.
    let bounded = assemble_context("bounded", vec![first, second], exact.div_ceil(4) - 1).unwrap();
    assert!(bounded.rendered.chars().count() < exact);
    assert!(bounded.rendered.chars().count() <= (exact.div_ceil(4) - 1) * 4);
    assert!(bounded.truncated);
    for line in bounded.rendered.lines() {
        let _: serde_json::Value = serde_json::from_str(line).unwrap();
    }
}

#[test]
fn legacy_records_keep_fingerprint_without_project_identity() {
    let old = r#"{"historical_evidence":[],"id":"candidate","source_run":"run","operation":"new","rationale":"evidence","targets":[],"evidence":[],"baseline":[],"dependency_paths":[]}"#;
    let mut candidate: RevisionCandidate = serde_json::from_str(old).unwrap();
    assert_eq!(candidate.fingerprint().unwrap(), hash(old));
    assert!(candidate.project_id.is_none());
    candidate.project_id = Some("project-a".into());
    assert_ne!(candidate.fingerprint().unwrap(), hash(old));
    let old = r#"{"id":"receipt","run_id":"run","candidates":[],"supplied":[],"rendered":"","truncated":false,"index_model":null,"scope_guard":null}"#;
    let receipt: ContextReceipt = serde_json::from_str(old).unwrap();
    assert_eq!(serde_json::to_string(&receipt).unwrap(), old);
    assert!(receipt.scope_guards.is_empty());
}
