use std::path::PathBuf;

use clap::Parser;
use tempfile::tempdir;
use wiki_types::NodeKind;

use crate::cli::{Cli, Command, WorkflowTaskArg};
use crate::commands_fs_tests::MockClient;
use crate::workflow::{
    WorkflowLogKind, WorkflowTaskKind, append_log, apply_workflow_result_json,
    build_crystallize_context, build_ingest_context, build_integrate_context, build_lint_context,
    build_query_context, ingest_session_source, ingest_source, rebuild_index,
};

fn node(path: &str, kind: NodeKind, content: &str) -> wiki_types::Node {
    wiki_types::Node {
        path: path.to_string(),
        kind,
        content: content.to_string(),
        created_at: 1,
        updated_at: 2,
        etag: format!("etag-{path}"),
        metadata_json: "{}".to_string(),
    }
}

#[tokio::test]
async fn ingest_source_writes_remote_source_only() {
    let dir = tempdir().expect("temp dir should exist");
    let input = PathBuf::from(dir.path()).join("alpha.md");
    std::fs::write(&input, "# Alpha\n\nRaw summary").expect("raw source should write");
    let client = MockClient::default();

    let path = ingest_source(&client, &input, None, None)
        .await
        .expect("ingest source should succeed");

    assert_eq!(path, "/Sources/raw/alpha/alpha.md");
    let writes = client.writes.lock().expect("writes should lock");
    assert_eq!(writes.len(), 1);
    assert_eq!(writes[0].path, "/Sources/raw/alpha/alpha.md");
    assert_eq!(writes[0].kind, NodeKind::Source);
}

#[tokio::test]
async fn build_ingest_context_returns_expected_shape() {
    let client = MockClient {
        nodes: vec![
            node(
                "/Sources/raw/alpha/alpha.md",
                NodeKind::Source,
                "# Alpha\n\nRaw summary",
            ),
            node("/Wiki/topic.md", NodeKind::File, "# Topic\n\nTopic summary"),
        ],
        ..Default::default()
    };

    let context = build_ingest_context(&client, "/Sources/raw/alpha/alpha.md", None)
        .await
        .expect("ingest context should build");

    assert_eq!(context.task, "ingest");
    assert_eq!(
        context.source_path.as_deref(),
        Some("/Sources/raw/alpha/alpha.md")
    );
    assert_eq!(context.source_id.as_deref(), Some("alpha"));
    assert_eq!(
        context.source_etag.as_deref(),
        Some("etag-/Sources/raw/alpha/alpha.md")
    );
    assert!(
        context
            .allowed_write_paths
            .contains(&"/Wiki/sources/alpha.md".to_string())
    );
    assert!(context.response_schema.get("required").is_some());
}

#[tokio::test]
async fn build_crystallize_context_returns_expected_shape() {
    let client = MockClient {
        nodes: vec![
            node(
                "/Sources/sessions/session-1/session-1.md",
                NodeKind::Source,
                "# Session 1\n\nLong durable session",
            ),
            node("/Wiki/topic.md", NodeKind::File, "# Topic\n\nTopic summary"),
        ],
        ..Default::default()
    };

    let context = build_crystallize_context(&client, "session-1", None)
        .await
        .expect("crystallize context should build");

    assert_eq!(context.task, "crystallize");
    assert_eq!(
        context.source_path.as_deref(),
        Some("/Sources/sessions/session-1/session-1.md")
    );
    assert_eq!(context.source_id.as_deref(), Some("session-1"));
    assert_eq!(
        context.source_etag.as_deref(),
        Some("etag-/Sources/sessions/session-1/session-1.md")
    );
    assert_eq!(context.allowed_write_paths, vec!["/Wiki/..."]);
    assert!(context.response_schema.get("required").is_some());
}

#[tokio::test]
async fn build_query_context_returns_search_pages_and_schema() {
    let client = MockClient {
        nodes: vec![
            node("/Wiki/index.md", NodeKind::File, "# Index\n\nTopic links"),
            node(
                "/Wiki/topic-0.md",
                NodeKind::File,
                &format!("# Topic 0\n\n{}", "a".repeat(2500)),
            ),
            node(
                "/Wiki/topic-1.md",
                NodeKind::File,
                &format!("# Topic 1\n\n{}", "a".repeat(2500)),
            ),
            node(
                "/Wiki/topic-2.md",
                NodeKind::File,
                &format!("# Topic 2\n\n{}", "a".repeat(2500)),
            ),
            node(
                "/Wiki/topic-3.md",
                NodeKind::File,
                &format!("# Topic 3\n\n{}", "a".repeat(2500)),
            ),
            node(
                "/Wiki/topic-4.md",
                NodeKind::File,
                &format!("# Topic 4\n\n{}", "a".repeat(2500)),
            ),
            node(
                "/Wiki/topic-5.md",
                NodeKind::File,
                &format!("# Topic 5\n\n{}", "a".repeat(2500)),
            ),
        ],
        search_hits: (0..6)
            .map(|index| wiki_types::SearchNodeHit {
                path: format!("/Wiki/topic-{index}.md"),
                kind: NodeKind::File,
                snippet: Some("Topic summary".to_string()),
                score: 1.0,
                match_reasons: vec!["fts".to_string()],
            })
            .collect(),
        ..Default::default()
    };

    let context = build_query_context(&client, "topic", None)
        .await
        .expect("query context should build");

    assert_eq!(context.task, "query");
    assert_eq!(context.query_text.as_deref(), Some("topic"));
    assert_eq!(context.index_etag.as_deref(), Some("etag-/Wiki/index.md"));
    assert_eq!(context.search_pages.len(), 5);
    assert_eq!(context.search_pages[0].etag, "etag-/Wiki/topic-0.md");
    assert!(context.search_pages[0].content_truncated);
    assert_eq!(
        context.search_pages[0]
            .content
            .as_deref()
            .expect("search page content should exist")
            .chars()
            .count(),
        2000
    );
    assert_eq!(context.allowed_write_paths, Vec::<String>::new());
}

#[tokio::test]
async fn build_lint_context_returns_structural_stats() {
    let client = MockClient {
        nodes: vec![
            node("/Wiki/index.md", NodeKind::File, "# Index"),
            node("/Wiki/log.md", NodeKind::File, "# Log"),
            node("/Wiki/topic.md", NodeKind::File, "# Topic\n\nTopic summary"),
        ],
        ..Default::default()
    };

    let context = build_lint_context(&client)
        .await
        .expect("lint context should build");

    assert_eq!(context.task, "lint");
    assert_eq!(context.index_etag.as_deref(), Some("etag-/Wiki/index.md"));
    let stats = context.structural_stats.expect("stats should exist");
    assert_eq!(stats.file_count, 3);
    assert!(stats.has_index);
    assert!(stats.has_log);
}

#[tokio::test]
async fn build_integrate_context_returns_target_pages_and_schema() {
    let client = MockClient {
        nodes: vec![
            node("/Wiki/index.md", NodeKind::File, "# Index\n\nTopic links"),
            node("/Wiki/topic.md", NodeKind::File, "# Topic\n\nTopic summary"),
            node("/Wiki/other.md", NodeKind::File, "# Other\n\nOther summary"),
        ],
        search_hits: vec![wiki_types::SearchNodeHit {
            path: "/Wiki/other.md".to_string(),
            kind: NodeKind::File,
            snippet: Some("Other summary".to_string()),
            score: 1.0,
            match_reasons: vec!["fts".to_string()],
        }],
        ..Default::default()
    };

    let context = build_integrate_context(
        &client,
        &["/Wiki/topic.md".to_string()],
        Some("integrate title".to_string()),
        Some("other".to_string()),
    )
    .await
    .expect("integrate context should build");

    assert_eq!(context.task, "integrate");
    assert_eq!(context.title.as_deref(), Some("integrate title"));
    assert_eq!(context.query_text.as_deref(), Some("other"));
    assert_eq!(context.allowed_write_paths, vec!["/Wiki/topic.md"]);
    assert_eq!(context.candidate_pages.len(), 1);
    assert_eq!(context.search_pages.len(), 1);
    assert!(context.response_schema.get("required").is_some());
}

#[tokio::test]
async fn build_ingest_context_applies_caps_and_truncation_flags() {
    let long_index = format!("# Index\n\n{}", "b".repeat(7000));
    let long_source = format!("# Alpha\n\n{}", "c".repeat(2500));
    let mut nodes = vec![
        node("/Wiki/index.md", NodeKind::File, &long_index),
        node(
            "/Sources/raw/alpha/alpha.md",
            NodeKind::Source,
            &long_source,
        ),
    ];
    for index in 0..10 {
        nodes.push(node(
            &format!("/Wiki/page-{index}.md"),
            NodeKind::File,
            &format!("# Page {index}\n\n{}", "d".repeat(2500)),
        ));
    }
    let client = MockClient {
        nodes,
        ..Default::default()
    };

    let context = build_ingest_context(&client, "/Sources/raw/alpha/alpha.md", None)
        .await
        .expect("ingest context should build");

    assert_eq!(
        context.source_etag.as_deref(),
        Some("etag-/Sources/raw/alpha/alpha.md")
    );
    assert_eq!(context.index_etag.as_deref(), Some("etag-/Wiki/index.md"));
    assert!(context.source_content_truncated);
    assert!(context.index_truncated);
    assert_eq!(
        context
            .source_content
            .as_deref()
            .expect("source content should exist")
            .chars()
            .count(),
        2000
    );
    assert_eq!(
        context
            .index_markdown
            .as_deref()
            .expect("index markdown should exist")
            .chars()
            .count(),
        6000
    );
    assert_eq!(context.candidate_pages.len(), 8);
    assert_eq!(context.recent_pages.len(), 5);
}

#[tokio::test]
async fn ingest_session_source_writes_canonical_session_path() {
    let dir = tempdir().expect("temp dir should exist");
    let input = PathBuf::from(dir.path()).join("session-1.md");
    std::fs::write(&input, "# Session 1\n\nNotes").expect("session source should write");
    let client = MockClient::default();

    let path = ingest_session_source(&client, &input, None, None)
        .await
        .expect("ingest session source should succeed");

    assert_eq!(path, "/Sources/sessions/session-1/session-1.md");
    let writes = client.writes.lock().expect("writes should lock");
    assert_eq!(writes.len(), 1);
    assert_eq!(writes[0].path, "/Sources/sessions/session-1/session-1.md");
    assert_eq!(writes[0].kind, NodeKind::Source);
}

#[tokio::test]
async fn apply_ingest_result_writes_summary_then_related_then_system_files() {
    let client = MockClient {
        nodes: vec![node(
            "/Sources/raw/alpha/alpha.md",
            NodeKind::Source,
            "# Alpha\n\nRaw summary",
        )],
        ..Default::default()
    };

    let updated = apply_workflow_result_json(
        &client,
        WorkflowTaskKind::Ingest,
        r##"{
          "source_path":"/Sources/raw/alpha/alpha.md",
          "source_id":"alpha",
          "source_etag":"etag-/Sources/raw/alpha/alpha.md",
          "index_etag":null,
          "source_summary_markdown":"# Alpha\n\nSummary",
          "related_updates":[{"path":"/Wiki/topic.md","markdown":"# Topic\n\nUpdated"}],
          "rationale":"because"
        }"##,
    )
    .await
    .expect("ingest apply should succeed");

    assert!(updated.contains(&"/Wiki/index.md".to_string()));
    let writes = client.writes.lock().expect("writes should lock");
    assert_eq!(writes[0].path, "/Wiki/sources/alpha.md");
    assert_eq!(writes[1].path, "/Wiki/topic.md");
    assert_eq!(writes[2].path, "/Wiki/index.md");
    assert_eq!(writes[3].path, "/Wiki/log.md");
}

#[tokio::test]
async fn apply_ingest_result_rejects_system_file_update() {
    let client = MockClient {
        nodes: vec![node(
            "/Sources/raw/alpha/alpha.md",
            NodeKind::Source,
            "# Alpha\n\nRaw summary",
        )],
        ..Default::default()
    };

    let error = apply_workflow_result_json(
        &client,
        WorkflowTaskKind::Ingest,
        r##"{
          "source_path":"/Sources/raw/alpha/alpha.md",
          "source_id":"alpha",
          "source_etag":"etag-/Sources/raw/alpha/alpha.md",
          "index_etag":null,
          "source_summary_markdown":"# Alpha\n\nSummary",
          "related_updates":[{"path":"/Wiki/index.md","markdown":"bad"}],
          "rationale":"because"
        }"##,
    )
    .await
    .expect_err("system file update should fail");

    assert!(error.to_string().contains("system file update"));
}

#[tokio::test]
async fn apply_ingest_result_rejects_missing_source_path() {
    let client = MockClient::default();

    let error = apply_workflow_result_json(
        &client,
        WorkflowTaskKind::Ingest,
        r##"{
          "source_id":"alpha",
          "source_etag":"etag-/Sources/raw/alpha/alpha.md",
          "index_etag":null,
          "source_summary_markdown":"# Alpha\n\nSummary",
          "related_updates":[],
          "rationale":"because"
        }"##,
    )
    .await
    .expect_err("missing source_path should fail");

    assert!(error.to_string().contains("missing field `source_path`"));
}

#[tokio::test]
async fn apply_ingest_result_rejects_missing_source_node() {
    let client = MockClient {
        nodes: vec![node(
            "/Sources/raw/other/other.md",
            NodeKind::Source,
            "# Other",
        )],
        ..Default::default()
    };

    let error = apply_workflow_result_json(
        &client,
        WorkflowTaskKind::Ingest,
        r##"{
          "source_path":"/Sources/raw/missing/missing.md",
          "source_id":"missing",
          "source_etag":"etag-/Sources/raw/missing/missing.md",
          "index_etag":null,
          "source_summary_markdown":"# Alpha\n\nSummary",
          "related_updates":[],
          "rationale":"because"
        }"##,
    )
    .await
    .expect_err("missing source node should fail");

    assert!(
        error
            .to_string()
            .contains("source not found for ingest apply")
    );
}

#[tokio::test]
async fn apply_ingest_result_rejects_non_source_node() {
    let client = MockClient {
        nodes: vec![node(
            "/Sources/raw/alpha/alpha.md",
            NodeKind::File,
            "# Alpha",
        )],
        ..Default::default()
    };

    let error = apply_workflow_result_json(
        &client,
        WorkflowTaskKind::Ingest,
        r##"{
          "source_path":"/Sources/raw/alpha/alpha.md",
          "source_id":"alpha",
          "source_etag":"etag-/Sources/raw/alpha/alpha.md",
          "index_etag":null,
          "source_summary_markdown":"# Alpha\n\nSummary",
          "related_updates":[],
          "rationale":"because"
        }"##,
    )
    .await
    .expect_err("file node should fail");

    assert!(
        error
            .to_string()
            .contains("path is not a source node for ingest apply")
    );
}

#[tokio::test]
async fn apply_ingest_result_uses_requested_source_when_newer_source_exists() {
    let client = MockClient {
        nodes: vec![
            node(
                "/Sources/raw/alpha/alpha.md",
                NodeKind::Source,
                "# Alpha\n\nRaw summary",
            ),
            node(
                "/Sources/raw/beta/beta.md",
                NodeKind::Source,
                "# Beta\n\nNewer raw summary",
            ),
        ],
        ..Default::default()
    };

    let updated = apply_workflow_result_json(
        &client,
        WorkflowTaskKind::Ingest,
        r##"{
          "source_path":"/Sources/raw/alpha/alpha.md",
          "source_id":"alpha",
          "source_etag":"etag-/Sources/raw/alpha/alpha.md",
          "index_etag":null,
          "source_summary_markdown":"# Alpha\n\nSummary",
          "related_updates":[],
          "rationale":"because"
        }"##,
    )
    .await
    .expect("ingest apply should succeed");

    assert!(updated.contains(&"/Wiki/sources/alpha.md".to_string()));
    let writes = client.writes.lock().expect("writes should lock");
    assert_eq!(writes[0].path, "/Wiki/sources/alpha.md");
    let log = writes.last().expect("log write should exist");
    assert!(
        log.content
            .contains("target_paths: /Sources/raw/alpha/alpha.md")
    );
}

#[tokio::test]
async fn apply_ingest_result_rejects_source_id_mismatch() {
    let client = MockClient {
        nodes: vec![node(
            "/Sources/raw/alpha/alpha.md",
            NodeKind::Source,
            "# Alpha\n\nRaw summary",
        )],
        ..Default::default()
    };

    let error = apply_workflow_result_json(
        &client,
        WorkflowTaskKind::Ingest,
        r##"{
          "source_path":"/Sources/raw/alpha/alpha.md",
          "source_id":"beta",
          "source_etag":"etag-/Sources/raw/alpha/alpha.md",
          "index_etag":null,
          "source_summary_markdown":"# Alpha\n\nSummary",
          "related_updates":[],
          "rationale":"because"
        }"##,
    )
    .await
    .expect_err("source id mismatch should fail");

    assert!(
        error
            .to_string()
            .contains("source_id does not match source_path")
    );
}

#[tokio::test]
async fn apply_ingest_result_rejects_source_etag_mismatch() {
    let client = MockClient {
        nodes: vec![node(
            "/Sources/raw/alpha/alpha.md",
            NodeKind::Source,
            "# Alpha\n\nRaw summary",
        )],
        ..Default::default()
    };

    let error = apply_workflow_result_json(
        &client,
        WorkflowTaskKind::Ingest,
        r##"{
          "source_path":"/Sources/raw/alpha/alpha.md",
          "source_id":"alpha",
          "source_etag":"etag-stale",
          "index_etag":null,
          "source_summary_markdown":"# Alpha\n\nSummary",
          "related_updates":[],
          "rationale":"because"
        }"##,
    )
    .await
    .expect_err("source etag mismatch should fail");

    assert!(error.to_string().contains("source_etag mismatch"));
}

#[tokio::test]
async fn apply_ingest_result_rejects_stale_index_etag() {
    let client = MockClient {
        nodes: vec![
            node(
                "/Sources/raw/alpha/alpha.md",
                NodeKind::Source,
                "# Alpha\n\nRaw summary",
            ),
            node("/Wiki/index.md", NodeKind::File, "# Index"),
        ],
        ..Default::default()
    };

    let error = apply_workflow_result_json(
        &client,
        WorkflowTaskKind::Ingest,
        r##"{
          "source_path":"/Sources/raw/alpha/alpha.md",
          "source_id":"alpha",
          "source_etag":"etag-/Sources/raw/alpha/alpha.md",
          "index_etag":"etag-stale",
          "source_summary_markdown":"# Alpha\n\nSummary",
          "related_updates":[],
          "rationale":"because"
        }"##,
    )
    .await
    .expect_err("stale index should fail");

    assert!(error.to_string().contains("index_etag is stale"));
}

#[tokio::test]
async fn apply_lint_result_writes_lint_page_then_system_files() {
    let client = MockClient {
        nodes: vec![node(
            "/Wiki/topic.md",
            NodeKind::File,
            "# Topic\n\nTopic summary",
        )],
        ..Default::default()
    };

    let updated = apply_workflow_result_json(
        &client,
        WorkflowTaskKind::Lint,
        r##"{
          "index_etag":null,
          "report_markdown":"# Lint\n\nBody",
          "checked_paths":["/Wiki/topic.md"]
        }"##,
    )
    .await
    .expect("lint apply should succeed");

    assert_eq!(updated.len(), 2);
    let writes = client.writes.lock().expect("writes should lock");
    assert!(writes[0].path.starts_with("/Wiki/lint/"));
    assert_eq!(writes[1].path, "/Wiki/index.md");
    assert_eq!(writes[2].path, "/Wiki/log.md");
}

#[tokio::test]
async fn apply_crystallize_result_writes_updates_then_system_files() {
    let client = MockClient {
        nodes: vec![node(
            "/Sources/sessions/session-1/session-1.md",
            NodeKind::Source,
            "# Session 1\n\nLong durable session",
        )],
        ..Default::default()
    };

    let updated = apply_workflow_result_json(
        &client,
        WorkflowTaskKind::Crystallize,
        r##"{
          "session_path":"/Sources/sessions/session-1/session-1.md",
          "session_id":"session-1",
          "session_etag":"etag-/Sources/sessions/session-1/session-1.md",
          "index_etag":null,
          "durable_updates":[{"path":"/Wiki/entities/session-1.md","markdown":"# Session 1\n\nDurable"}],
          "rationale":"because"
        }"##,
    )
    .await
    .expect("crystallize apply should succeed");

    assert_eq!(updated.len(), 2);
    let writes = client.writes.lock().expect("writes should lock");
    assert_eq!(writes[0].path, "/Wiki/entities/session-1.md");
    assert_eq!(writes[1].path, "/Wiki/index.md");
    assert_eq!(writes[2].path, "/Wiki/log.md");
}

#[tokio::test]
async fn apply_crystallize_result_rejects_stale_session_etag() {
    let client = MockClient {
        nodes: vec![node(
            "/Sources/sessions/session-1/session-1.md",
            NodeKind::Source,
            "# Session 1\n\nLong durable session",
        )],
        ..Default::default()
    };

    let error = apply_workflow_result_json(
        &client,
        WorkflowTaskKind::Crystallize,
        r##"{
          "session_path":"/Sources/sessions/session-1/session-1.md",
          "session_id":"session-1",
          "session_etag":"etag-stale",
          "index_etag":null,
          "durable_updates":[{"path":"/Wiki/entities/session-1.md","markdown":"# Session 1\n\nDurable"}],
          "rationale":"because"
        }"##,
    )
    .await
    .expect_err("stale session etag should fail");

    assert!(error.to_string().contains("session_etag mismatch"));
}

#[tokio::test]
async fn apply_integrate_result_writes_updates_then_system_files() {
    let client = MockClient {
        nodes: vec![node("/Wiki/topic.md", NodeKind::File, "# Topic\n\nOld")],
        ..Default::default()
    };

    let updated = apply_workflow_result_json(
        &client,
        WorkflowTaskKind::Integrate,
        r##"{
          "target_paths":["/Wiki/topic.md"],
          "index_etag":null,
          "page_updates":[{"path":"/Wiki/topic.md","markdown":"# Topic\n\nNew"}],
          "rationale":"because"
        }"##,
    )
    .await
    .expect("integrate apply should succeed");

    assert_eq!(updated.len(), 2);
    let writes = client.writes.lock().expect("writes should lock");
    assert_eq!(writes[0].path, "/Wiki/topic.md");
    assert_eq!(writes[1].path, "/Wiki/index.md");
    assert_eq!(writes[2].path, "/Wiki/log.md");
}

#[tokio::test]
async fn apply_integrate_result_rejects_stale_index_etag() {
    let client = MockClient {
        nodes: vec![
            node("/Wiki/index.md", NodeKind::File, "# Index"),
            node("/Wiki/topic.md", NodeKind::File, "# Topic"),
        ],
        ..Default::default()
    };

    let error = apply_workflow_result_json(
        &client,
        WorkflowTaskKind::Integrate,
        r##"{
          "target_paths":["/Wiki/topic.md"],
          "index_etag":"etag-stale",
          "page_updates":[{"path":"/Wiki/topic.md","markdown":"# Topic\n\nNew"}],
          "rationale":"because"
        }"##,
    )
    .await
    .expect_err("stale integrate index should fail");

    assert!(error.to_string().contains("index_etag is stale"));
}

#[test]
fn cli_parses_new_workflow_commands() {
    let cli = Cli::try_parse_from([
        "wiki-cli",
        "--replica-host",
        "http://127.0.0.1:4943",
        "--canister-id",
        "aaaaa-aa",
        "build-crystallize-context",
        "session-1",
    ])
    .expect("build crystallize context should parse");
    assert!(matches!(
        cli.command,
        Command::BuildCrystallizeContext { .. }
    ));

    let cli = Cli::try_parse_from([
        "wiki-cli",
        "--replica-host",
        "http://127.0.0.1:4943",
        "--canister-id",
        "aaaaa-aa",
        "apply-workflow-result",
        "--task",
        "crystallize",
        "--input",
        "result.json",
    ])
    .expect("apply crystallize should parse");
    match cli.command {
        Command::ApplyWorkflowResult { task, .. } => {
            assert_eq!(task, WorkflowTaskArg::Crystallize)
        }
        _ => panic!("unexpected command"),
    }

    let cli = Cli::try_parse_from([
        "wiki-cli",
        "--replica-host",
        "http://127.0.0.1:4943",
        "--canister-id",
        "aaaaa-aa",
        "apply-integrate",
        "--input",
        "result.json",
    ])
    .expect("apply integrate should parse");
    assert!(matches!(cli.command, Command::ApplyIntegrate { .. }));
}

#[tokio::test]
async fn rebuild_index_renders_sections_from_existing_wiki_nodes() {
    let client = MockClient {
        nodes: vec![
            node(
                "/Wiki/sources/alpha.md",
                NodeKind::File,
                "# Alpha\n\nAlpha summary",
            ),
            node(
                "/Wiki/entities/openai.md",
                NodeKind::File,
                "# OpenAI\n\nEntity summary",
            ),
            node(
                "/Wiki/concepts/tool-calling.md",
                NodeKind::File,
                "# Tool Calling\n\nConcept summary",
            ),
            node("/Wiki/lint/r.md", NodeKind::File, "# Lint\n\nLint summary"),
        ],
        ..Default::default()
    };

    rebuild_index(&client)
        .await
        .expect("rebuild index should succeed");

    let writes = client.writes.lock().expect("writes should lock");
    let index = writes.last().expect("index write should exist");
    assert_eq!(index.path, "/Wiki/index.md");
    assert!(index.content.contains("## Sources"));
    assert!(index.content.contains("## Entities"));
    assert!(index.content.contains("## Concepts"));
    assert!(!index.content.contains("## Queries"));
    assert!(!index.content.contains("## Lint Reports"));
}

#[tokio::test]
async fn append_log_appends_formatted_entry() {
    let client = MockClient {
        nodes: vec![node("/Wiki/log.md", NodeKind::File, "# Log\n")],
        ..Default::default()
    };

    append_log(
        &client,
        WorkflowLogKind::Ingest,
        "Alpha",
        &["/Sources/raw/alpha/alpha.md".to_string()],
        &["/Wiki/sources/alpha.md".to_string()],
        None,
    )
    .await
    .expect("append log should succeed");

    let writes = client.writes.lock().expect("writes should lock");
    let log = writes.last().expect("log write should exist");
    assert_eq!(log.path, "/Wiki/log.md");
    assert!(log.content.contains("## ["));
    assert!(log.content.contains("ingest | Alpha"));
    assert!(
        log.content
            .contains("target_paths: /Sources/raw/alpha/alpha.md")
    );
}

#[tokio::test]
async fn ingest_source_uses_directory_name_as_source_id() {
    let client = MockClient {
        nodes: vec![node(
            "/Sources/raw/alpha.beta/alpha.beta.md",
            NodeKind::Source,
            "# Alpha Beta\n\nRaw summary",
        )],
        ..Default::default()
    };

    let updated = apply_workflow_result_json(
        &client,
        WorkflowTaskKind::Ingest,
        r##"{
          "source_path":"/Sources/raw/alpha.beta/alpha.beta.md",
          "source_id":"alpha.beta",
          "source_etag":"etag-/Sources/raw/alpha.beta/alpha.beta.md",
          "index_etag":null,
          "source_summary_markdown":"# Alpha Beta\n\nSummary",
          "related_updates":[],
          "rationale":"because"
        }"##,
    )
    .await
    .expect("dotted filename should succeed");

    assert!(updated.contains(&"/Wiki/sources/alpha.beta.md".to_string()));
    let writes = client.writes.lock().expect("writes should lock");
    assert_eq!(writes[0].path, "/Wiki/sources/alpha.beta.md");
}

#[tokio::test]
async fn apply_lint_result_rejects_stale_index_etag() {
    let client = MockClient {
        nodes: vec![node("/Wiki/index.md", NodeKind::File, "# Index")],
        ..Default::default()
    };

    let error = apply_workflow_result_json(
        &client,
        WorkflowTaskKind::Lint,
        r##"{
          "index_etag":"etag-stale",
          "report_markdown":"# Lint\n\nBody",
          "checked_paths":[]
        }"##,
    )
    .await
    .expect_err("stale lint index should fail");

    assert!(error.to_string().contains("index_etag is stale"));
}
