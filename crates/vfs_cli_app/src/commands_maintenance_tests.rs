use clap::Parser;
use vfs_types::{Node, NodeKind};

use crate::cli::{Cli, Command, ConnectionArgs, IdentityModeArg};
use crate::commands::run_command;
use crate::commands_fs_tests::MockClient;
use crate::maintenance::{rebuild_index, rebuild_scope_index};
use vfs_cli::connection::ResolvedConnection;

fn node(path: &str, kind: NodeKind, content: &str) -> Node {
    Node {
        path: path.to_string(),
        kind,
        content: content.to_string(),
        created_at: 1,
        updated_at: 2,
        etag: format!("etag-{path}"),
        metadata_json: "{}".to_string(),
    }
}

fn test_cli(command: Command) -> Cli {
    Cli {
        connection: ConnectionArgs {
            database_id: Some("default".to_string()),
            local: false,
            replica_host: None,
            identity_mode: IdentityModeArg::Auto,
            allow_non_ii_identity: false,
            canister_id: Some("aaaaa-aa".to_string()),
        },
        command,
    }
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

#[tokio::test]
async fn rebuild_index_renders_sections_from_existing_wiki_nodes() {
    let client = MockClient {
        nodes: vec![
            node(
                "/Wiki/foo/index.md",
                NodeKind::File,
                "# Index\n\nScope entry point for foo.\n",
            ),
            node(
                "/Wiki/foo/facts.md",
                NodeKind::File,
                "# Facts\n\nFacts summary",
            ),
            node(
                "/Wiki/foo/child/index.md",
                NodeKind::File,
                "# Index\n\nScope entry point for child.\n",
            ),
            node(
                "/Wiki/sources/alpha.md",
                NodeKind::File,
                "# Alpha\n\nAlpha summary",
            ),
            node(
                "/Wiki/sources/index.md",
                NodeKind::File,
                "# Sources\n\nSource landing page",
            ),
            node(
                "/Wiki/entities/openai.md",
                NodeKind::File,
                "# OpenAI\n\nEntity summary",
            ),
            node(
                "/Wiki/entities/index.md",
                NodeKind::File,
                "# Entities\n\nEntity landing page",
            ),
            node(
                "/Wiki/concepts/tool-calling.md",
                NodeKind::File,
                "# Tool Calling\n\nConcept summary",
            ),
            node(
                "/Wiki/concepts/index.md",
                NodeKind::File,
                "# Concepts\n\nConcept landing page",
            ),
            node("/Wiki/lint/r.md", NodeKind::File, "# Lint\n\nLint summary"),
        ],
        ..Default::default()
    };

    rebuild_index(&client, "default")
        .await
        .expect("rebuild index should succeed");

    let writes = client.writes.lock().expect("writes should lock");
    let index = writes.last().expect("index write should exist");
    assert_eq!(index.path, "/Wiki/index.md");
    assert!(index.content.contains("## Scopes"));
    assert!(
        index
            .content
            .contains("- [foo](/Wiki/foo/index.md) - Scope entry point for foo.")
    );
    assert!(
        !index
            .content
            .contains("- [sources](/Wiki/sources/index.md) - ")
    );
    assert!(
        !index
            .content
            .contains("- [entities](/Wiki/entities/index.md) - ")
    );
    assert!(
        !index
            .content
            .contains("- [concepts](/Wiki/concepts/index.md) - ")
    );
    assert!(!index.content.contains("/Wiki/foo/child/index.md"));
    assert!(index.content.contains("## Sources"));
    assert!(index.content.contains("## Entities"));
    assert!(index.content.contains("## Concepts"));
    assert!(index.content.contains("[Sources](/Wiki/sources/index.md)"));
    assert!(
        index
            .content
            .contains("[Entities](/Wiki/entities/index.md)")
    );
    assert!(
        index
            .content
            .contains("[Concepts](/Wiki/concepts/index.md)")
    );
    assert!(!index.content.contains("## Queries"));
    assert!(!index.content.contains("## Lint Reports"));
}

#[tokio::test]
async fn rebuild_index_command_dispatches() {
    let client = MockClient::default();

    run_command(&client, test_cli(Command::RebuildIndex), &test_connection())
        .await
        .expect("rebuild index command should succeed");

    let writes = client.writes.lock().expect("writes should lock");
    assert_eq!(writes.last().expect("index write").path, "/Wiki/index.md");
}

#[tokio::test]
async fn rebuild_scope_index_renders_direct_children_and_updates_root_entry() {
    let client = MockClient {
        nodes: vec![
            node(
                "/Wiki/foo/index.md",
                NodeKind::File,
                "# Index\n\nScope entry point for foo.\n",
            ),
            node(
                "/Wiki/index.md",
                NodeKind::File,
                "# Index\n\n## Scopes\n\n- [bar](/Wiki/bar/index.md) - existing bar\n",
            ),
            node(
                "/Wiki/foo/summary.md",
                NodeKind::File,
                "# Summary\n\nSummary text",
            ),
            node(
                "/Wiki/foo/custom.md",
                NodeKind::File,
                "# Custom\n\nCustom text",
            ),
            node(
                "/Wiki/foo/facts.md",
                NodeKind::File,
                "# Facts\n\nFacts text",
            ),
            node(
                "/Wiki/foo/child/note.md",
                NodeKind::File,
                "# Child\n\nChild text",
            ),
            node(
                "/Wiki/bar/index.md",
                NodeKind::File,
                "# Index\n\nScope entry point for bar.",
            ),
        ],
        ..Default::default()
    };

    rebuild_scope_index(&client, "default", "foo")
        .await
        .expect("rebuild scope index should succeed");

    let writes = client.writes.lock().expect("writes should lock");
    assert_eq!(writes.len(), 2);
    assert_eq!(writes[0].path, "/Wiki/foo/index.md");
    assert!(writes[0].content.contains("Scope entry point for foo."));
    assert!(writes[0].content.contains("## Scopes"));
    assert!(!writes[0].content.contains("/Wiki/foo/child/index.md"));
    let facts_pos = writes[0]
        .content
        .find("- [facts](/Wiki/foo/facts.md)")
        .expect("facts row should exist");
    let summary_pos = writes[0]
        .content
        .find("- [summary](/Wiki/foo/summary.md)")
        .expect("summary row should exist");
    let custom_pos = writes[0]
        .content
        .find("- [custom](/Wiki/foo/custom.md)")
        .expect("custom row should exist");
    assert!(facts_pos < summary_pos);
    assert!(summary_pos < custom_pos);
    assert!(!writes[0].content.contains("/Wiki/foo/index.md)"));

    assert_eq!(writes[1].path, "/Wiki/index.md");
    assert!(
        writes[1]
            .content
            .contains("- [bar](/Wiki/bar/index.md) - existing bar")
    );
    assert!(
        writes[1]
            .content
            .contains("- [foo](/Wiki/foo/index.md) - Scope entry point for foo.")
    );
}

#[tokio::test]
async fn rebuild_scope_index_command_dispatches_for_canonical_path() {
    let client = MockClient::default();

    run_command(
        &client,
        test_cli(Command::RebuildScopeIndex {
            scope: "/Wiki/foo".to_string(),
        }),
        &test_connection(),
    )
    .await
    .expect("rebuild scope index command should succeed");

    let writes = client.writes.lock().expect("writes should lock");
    assert_eq!(writes[0].path, "/Wiki/foo/index.md");
    assert_eq!(writes[1].path, "/Wiki/index.md");
}

#[tokio::test]
async fn rebuild_scope_index_command_dispatches_for_nested_scope() {
    let client = MockClient::default();

    run_command(
        &client,
        test_cli(Command::RebuildScopeIndex {
            scope: "/Wiki/foo/child".to_string(),
        }),
        &test_connection(),
    )
    .await
    .expect("nested rebuild scope index command should succeed");

    let writes = client.writes.lock().expect("writes should lock");
    assert_eq!(writes[0].path, "/Wiki/foo/child/index.md");
    assert_eq!(writes[1].path, "/Wiki/foo/index.md");
    assert_eq!(writes[2].path, "/Wiki/index.md");
    assert_eq!(writes.len(), 3);
}

#[tokio::test]
async fn rebuild_scope_index_does_not_touch_other_scope_indexes() {
    let client = MockClient {
        nodes: vec![
            node(
                "/Wiki/foo/facts.md",
                NodeKind::File,
                "# Facts\n\nFacts text",
            ),
            node(
                "/Wiki/bar/index.md",
                NodeKind::File,
                "# Index\n\nScope entry point for bar.",
            ),
        ],
        ..Default::default()
    };

    rebuild_scope_index(&client, "default", "foo")
        .await
        .expect("rebuild scope index should succeed");

    let writes = client.writes.lock().expect("writes should lock");
    assert!(
        writes
            .iter()
            .all(|write| write.path != "/Wiki/bar/index.md")
    );
}

#[tokio::test]
async fn rebuild_scope_index_nested_scope_updates_leaf_parent_and_root() {
    let client = MockClient {
        nodes: vec![
            node(
                "/Wiki/index.md",
                NodeKind::File,
                "# Index\n\n## Scopes\n\n- [bar](/Wiki/bar/index.md) - existing bar\n",
            ),
            node(
                "/Wiki/foo/index.md",
                NodeKind::File,
                "# Index\n\nScope entry point for foo.\n",
            ),
            node(
                "/Wiki/foo/child/facts.md",
                NodeKind::File,
                "# Facts\n\nFacts text",
            ),
        ],
        ..Default::default()
    };

    rebuild_scope_index(&client, "default", "/Wiki/foo/child")
        .await
        .expect("nested rebuild should succeed");

    let writes = client.writes.lock().expect("writes should lock");
    assert_eq!(writes.len(), 3);
    assert_eq!(writes[0].path, "/Wiki/foo/child/index.md");
    assert_eq!(writes[1].path, "/Wiki/foo/index.md");
    assert_eq!(writes[2].path, "/Wiki/index.md");
    assert!(writes[1].content.contains("## Scopes"));
    assert!(
        writes[1]
            .content
            .contains("- [child](/Wiki/foo/child/index.md)")
    );
    assert!(
        writes[2]
            .content
            .contains("- [foo](/Wiki/foo/index.md) - Scope entry point for foo.")
    );
}

#[tokio::test]
async fn rebuild_scope_index_lists_child_scope_only_when_child_index_exists() {
    let client = MockClient {
        nodes: vec![
            node(
                "/Wiki/foo/index.md",
                NodeKind::File,
                "# Index\n\nScope entry point for foo.\n",
            ),
            node(
                "/Wiki/foo/child/index.md",
                NodeKind::File,
                "# Index\n\nScope entry point for child.\n",
            ),
            node(
                "/Wiki/foo/child/facts.md",
                NodeKind::File,
                "# Facts\n\nFacts text",
            ),
        ],
        ..Default::default()
    };

    rebuild_scope_index(&client, "default", "foo")
        .await
        .expect("scope rebuild should succeed");

    let writes = client.writes.lock().expect("writes should lock");
    assert_eq!(writes[0].path, "/Wiki/foo/index.md");
    assert!(
        writes[0]
            .content
            .contains("- [child](/Wiki/foo/child/index.md)")
    );
}

#[tokio::test]
async fn rebuild_scope_index_reserved_root_scope_does_not_update_root_scopes() {
    let client = MockClient {
        nodes: vec![
            node(
                "/Wiki/index.md",
                NodeKind::File,
                "# Index\n\n## Scopes\n\n- [foo](/Wiki/foo/index.md) - existing foo\n",
            ),
            node(
                "/Wiki/sources/index.md",
                NodeKind::File,
                "# Sources\n\nSource landing page\n",
            ),
            node(
                "/Wiki/sources/alpha.md",
                NodeKind::File,
                "# Alpha\n\nAlpha summary",
            ),
        ],
        ..Default::default()
    };

    rebuild_scope_index(&client, "default", "/Wiki/sources")
        .await
        .expect("reserved scope rebuild should succeed");

    let writes = client.writes.lock().expect("writes should lock");
    assert_eq!(writes.len(), 1);
    assert_eq!(writes[0].path, "/Wiki/sources/index.md");
}

#[test]
fn workflow_commands_are_not_in_cli_anymore() {
    for removed in [
        "append-log",
        "ingest-source",
        "build-ingest-context",
        "build-crystallize-context",
        "build-query-context",
        "build-integrate-context",
        "build-lint-context",
        "apply-workflow-result",
        "apply-integrate",
    ] {
        let parsed = Cli::try_parse_from(["kinic-vfs-cli", "--canister-id", "aaaaa-aa", removed]);
        assert!(parsed.is_err(), "{removed} should be removed");
    }
}

#[test]
fn connection_flags_are_optional_in_cli() {
    let parsed = Cli::try_parse_from(["kinic-vfs-cli", "rebuild-index"]);
    assert!(parsed.is_ok(), "connection flags should be optional");

    let scoped = Cli::try_parse_from(["kinic-vfs-cli", "rebuild-scope-index", "--scope", "foo"]);
    assert!(scoped.is_ok(), "scope rebuild command should parse");

    let scoped_path = Cli::try_parse_from([
        "kinic-vfs-cli",
        "rebuild-scope-index",
        "--scope",
        "/Wiki/foo",
    ]);
    assert!(scoped_path.is_ok(), "canonical scope path should parse");

    let nested = Cli::try_parse_from([
        "kinic-vfs-cli",
        "rebuild-scope-index",
        "--scope",
        "foo/child",
    ]);
    assert!(nested.is_ok(), "nested scope rebuild command should parse");
}
