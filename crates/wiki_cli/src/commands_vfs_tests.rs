use std::path::PathBuf;

use clap::Parser;
use tempfile::tempdir;

use crate::cli::{Cli, Command, ConnectionArgs, GlobNodeTypeArg, NodeKindArg};
use crate::commands::run_command;
use crate::commands_fs_tests::MockClient;

fn test_cli(command: Command) -> Cli {
    Cli {
        connection: ConnectionArgs {
            local: false,
            canister_id: Some("aaaaa-aa".to_string()),
        },
        command,
    }
}

#[tokio::test]
async fn append_node_command_calls_canister_append() {
    let dir = tempdir().expect("temp dir should exist");
    let input = PathBuf::from(dir.path()).join("append.md");
    std::fs::write(&input, "\nnext").expect("input should write");
    let client = MockClient::default();

    run_command(
        &client,
        test_cli(Command::AppendNode {
            path: "/Wiki/foo.md".to_string(),
            input,
            kind: Some(NodeKindArg::File),
            metadata_json: Some("{\"k\":1}".to_string()),
            expected_etag: Some("etag-1".to_string()),
            separator: Some("\n".to_string()),
            json: false,
        }),
    )
    .await
    .expect("append command should succeed");

    let appends = client.appends.lock().expect("appends should lock");
    assert_eq!(appends.len(), 1);
    assert_eq!(appends[0].path, "/Wiki/foo.md");
    assert_eq!(appends[0].expected_etag.as_deref(), Some("etag-1"));
    assert_eq!(appends[0].separator.as_deref(), Some("\n"));
}

#[tokio::test]
async fn write_node_command_supports_source_kind() {
    let dir = tempdir().expect("temp dir should exist");
    let input = PathBuf::from(dir.path()).join("source.md");
    std::fs::write(&input, "# Source\n\nBody").expect("input should write");
    let client = MockClient::default();

    run_command(
        &client,
        test_cli(Command::WriteNode {
            path: "/Sources/raw/source/source.md".to_string(),
            kind: NodeKindArg::Source,
            input,
            metadata_json: "{}".to_string(),
            expected_etag: None,
            json: false,
        }),
    )
    .await
    .expect("write source command should succeed");

    let writes = client.writes.lock().expect("writes should lock");
    assert_eq!(writes.len(), 1);
    assert_eq!(writes[0].path, "/Sources/raw/source/source.md");
    assert_eq!(writes[0].kind, wiki_types::NodeKind::Source);
}

#[tokio::test]
async fn append_node_command_supports_source_kind() {
    let dir = tempdir().expect("temp dir should exist");
    let input = PathBuf::from(dir.path()).join("append-source.md");
    std::fs::write(&input, "\nnext").expect("input should write");
    let client = MockClient::default();

    run_command(
        &client,
        test_cli(Command::AppendNode {
            path: "/Sources/raw/source/source.md".to_string(),
            input,
            kind: Some(NodeKindArg::Source),
            metadata_json: Some("{}".to_string()),
            expected_etag: Some("etag-1".to_string()),
            separator: Some("\n".to_string()),
            json: false,
        }),
    )
    .await
    .expect("append source command should succeed");

    let appends = client.appends.lock().expect("appends should lock");
    assert_eq!(appends.len(), 1);
    assert_eq!(appends[0].path, "/Sources/raw/source/source.md");
    assert_eq!(appends[0].kind, Some(wiki_types::NodeKind::Source));
}

#[tokio::test]
async fn write_node_command_rejects_noncanonical_source_path() {
    let dir = tempdir().expect("temp dir should exist");
    let input = PathBuf::from(dir.path()).join("source.md");
    std::fs::write(&input, "# Source\n\nBody").expect("input should write");
    let client = MockClient::default();

    let error = run_command(
        &client,
        test_cli(Command::WriteNode {
            path: "/Sources/raw/source.md".to_string(),
            kind: NodeKindArg::Source,
            input,
            metadata_json: "{}".to_string(),
            expected_etag: None,
            json: false,
        }),
    )
    .await
    .expect_err("noncanonical source path should fail");

    assert!(
        error.to_string().contains("canonical form")
            || error.to_string().contains("source path must stay under")
    );
}

#[tokio::test]
async fn append_node_command_rejects_noncanonical_source_path_when_kind_is_explicit() {
    let dir = tempdir().expect("temp dir should exist");
    let input = PathBuf::from(dir.path()).join("append-source.md");
    std::fs::write(&input, "\nnext").expect("input should write");
    let client = MockClient::default();

    let error = run_command(
        &client,
        test_cli(Command::AppendNode {
            path: "/Wiki/topic.md".to_string(),
            input,
            kind: Some(NodeKindArg::Source),
            metadata_json: Some("{}".to_string()),
            expected_etag: Some("etag-1".to_string()),
            separator: Some("\n".to_string()),
            json: false,
        }),
    )
    .await
    .expect_err("explicit source kind with wiki path should fail");

    assert!(error.to_string().contains("source path must stay under"));
}

#[tokio::test]
async fn edit_node_command_calls_canister_edit() {
    let client = MockClient::default();

    run_command(
        &client,
        test_cli(Command::EditNode {
            path: "/Wiki/foo.md".to_string(),
            old_text: "before".to_string(),
            new_text: "after".to_string(),
            expected_etag: Some("etag-1".to_string()),
            replace_all: true,
            json: false,
        }),
    )
    .await
    .expect("edit command should succeed");

    let edits = client.edits.lock().expect("edits should lock");
    assert_eq!(edits.len(), 1);
    assert!(edits[0].replace_all);
    assert_eq!(edits[0].old_text, "before");
    assert_eq!(edits[0].new_text, "after");
}

#[tokio::test]
async fn mkdir_node_command_calls_canister_mkdir() {
    let client = MockClient::default();

    run_command(
        &client,
        test_cli(Command::MkdirNode {
            path: "/Wiki/new-dir".to_string(),
            json: false,
        }),
    )
    .await
    .expect("mkdir command should succeed");

    let mkdirs = client.mkdirs.lock().expect("mkdirs should lock");
    assert_eq!(mkdirs.len(), 1);
    assert_eq!(mkdirs[0].path, "/Wiki/new-dir");
}

#[tokio::test]
async fn move_node_command_calls_canister_move() {
    let client = MockClient::default();

    run_command(
        &client,
        test_cli(Command::MoveNode {
            from_path: "/Wiki/from.md".to_string(),
            to_path: "/Wiki/to.md".to_string(),
            expected_etag: Some("etag-1".to_string()),
            overwrite: true,
            json: false,
        }),
    )
    .await
    .expect("move command should succeed");

    let moves = client.moves.lock().expect("moves should lock");
    assert_eq!(moves.len(), 1);
    assert_eq!(moves[0].from_path, "/Wiki/from.md");
    assert_eq!(moves[0].to_path, "/Wiki/to.md");
    assert!(moves[0].overwrite);
}

#[tokio::test]
async fn move_node_command_allows_canonical_source_target() {
    let client = MockClient {
        nodes: vec![wiki_types::Node {
            path: "/Sources/raw/source/source.md".to_string(),
            kind: wiki_types::NodeKind::Source,
            content: "# Source".to_string(),
            created_at: 1,
            updated_at: 2,
            etag: "etag-1".to_string(),
            metadata_json: "{}".to_string(),
        }],
        ..Default::default()
    };

    run_command(
        &client,
        test_cli(Command::MoveNode {
            from_path: "/Sources/raw/source/source.md".to_string(),
            to_path: "/Sources/raw/renamed/renamed.md".to_string(),
            expected_etag: Some("etag-1".to_string()),
            overwrite: false,
            json: false,
        }),
    )
    .await
    .expect("source move should succeed");

    let moves = client.moves.lock().expect("moves should lock");
    assert_eq!(moves.len(), 1);
    assert_eq!(moves[0].to_path, "/Sources/raw/renamed/renamed.md");
}

#[tokio::test]
async fn move_node_command_rejects_noncanonical_source_target() {
    let client = MockClient {
        nodes: vec![wiki_types::Node {
            path: "/Sources/raw/source/source.md".to_string(),
            kind: wiki_types::NodeKind::Source,
            content: "# Source".to_string(),
            created_at: 1,
            updated_at: 2,
            etag: "etag-1".to_string(),
            metadata_json: "{}".to_string(),
        }],
        ..Default::default()
    };

    let error = run_command(
        &client,
        test_cli(Command::MoveNode {
            from_path: "/Sources/raw/source/source.md".to_string(),
            to_path: "/Sources/raw/renamed/wrong.md".to_string(),
            expected_etag: Some("etag-1".to_string()),
            overwrite: false,
            json: false,
        }),
    )
    .await
    .expect_err("noncanonical source move should fail");

    assert!(error.to_string().contains("canonical form"));
    assert!(client.moves.lock().expect("moves should lock").is_empty());
}

#[tokio::test]
async fn glob_node_command_calls_canister_glob() {
    let client = MockClient::default();

    run_command(
        &client,
        test_cli(Command::GlobNodes {
            pattern: "**/*.md".to_string(),
            path: "/Wiki".to_string(),
            node_type: Some(GlobNodeTypeArg::Directory),
            json: false,
        }),
    )
    .await
    .expect("glob command should succeed");

    let globs = client.globs.lock().expect("globs should lock");
    assert_eq!(globs.len(), 1);
    assert_eq!(globs[0].pattern, "**/*.md");
}

#[tokio::test]
async fn recent_node_command_calls_canister_recent() {
    let client = MockClient::default();

    run_command(
        &client,
        test_cli(Command::RecentNodes {
            limit: 5,
            path: "/Wiki".to_string(),
            json: false,
        }),
    )
    .await
    .expect("recent command should succeed");

    let recents = client.recents.lock().expect("recents should lock");
    assert_eq!(recents.len(), 1);
    assert_eq!(recents[0].limit, 5);
    assert_eq!(recents[0].path.as_deref(), Some("/Wiki"));
}

#[tokio::test]
async fn multi_edit_node_command_calls_canister_multi_edit() {
    let dir = tempdir().expect("temp dir should exist");
    let input = PathBuf::from(dir.path()).join("edits.json");
    std::fs::write(
        &input,
        r#"[{"old_text":"before","new_text":"after"},{"old_text":"alpha","new_text":"beta"}]"#,
    )
    .expect("edits file should write");
    let client = MockClient::default();

    run_command(
        &client,
        test_cli(Command::MultiEditNode {
            path: "/Wiki/foo.md".to_string(),
            edits_file: input,
            expected_etag: Some("etag-1".to_string()),
            json: false,
        }),
    )
    .await
    .expect("multi edit command should succeed");

    let edits = client.multi_edits.lock().expect("multi edits should lock");
    assert_eq!(edits.len(), 1);
    assert_eq!(edits[0].edits.len(), 2);
}

#[tokio::test]
async fn search_path_command_calls_canister_path_search() {
    let client = MockClient::default();

    run_command(
        &client,
        test_cli(Command::SearchPathRemote {
            query_text: "nested".to_string(),
            prefix: "/Wiki".to_string(),
            top_k: 7,
            json: false,
        }),
    )
    .await
    .expect("search path command should succeed");

    let searches = client
        .path_searches
        .lock()
        .expect("path searches should lock");
    assert_eq!(searches.len(), 1);
    assert_eq!(searches[0].query_text, "nested");
    assert_eq!(searches[0].prefix.as_deref(), Some("/Wiki"));
    assert_eq!(searches[0].top_k, 7);
}

#[tokio::test]
async fn delete_tree_command_lists_recursive_and_deletes_deepest_first() {
    let client = MockClient {
        nodes: vec![
            wiki_types::Node {
                path: "/Wiki/tree".to_string(),
                kind: wiki_types::NodeKind::File,
                content: String::new(),
                created_at: 1,
                updated_at: 1,
                etag: "etag-tree".to_string(),
                metadata_json: "{}".to_string(),
            },
            wiki_types::Node {
                path: "/Wiki/tree/leaf.md".to_string(),
                kind: wiki_types::NodeKind::File,
                content: String::new(),
                created_at: 1,
                updated_at: 2,
                etag: "etag-leaf".to_string(),
                metadata_json: "{}".to_string(),
            },
            wiki_types::Node {
                path: "/Wiki/tree/branch/twig.md".to_string(),
                kind: wiki_types::NodeKind::File,
                content: String::new(),
                created_at: 1,
                updated_at: 3,
                etag: "etag-twig".to_string(),
                metadata_json: "{}".to_string(),
            },
        ],
        ..Default::default()
    };

    run_command(
        &client,
        test_cli(Command::DeleteTree {
            path: "/Wiki/tree".to_string(),
            json: false,
        }),
    )
    .await
    .expect("delete tree command should succeed");

    let lists = client.lists.lock().expect("lists should lock");
    assert_eq!(lists.len(), 1);
    assert_eq!(lists[0].prefix, "/Wiki/tree");
    assert!(lists[0].recursive);

    let deletes = client.deletes.lock().expect("deletes should lock");
    let deleted_paths = deletes
        .iter()
        .map(|request| request.path.as_str())
        .collect::<Vec<_>>();
    assert_eq!(
        deleted_paths,
        vec![
            "/Wiki/tree/branch/twig.md",
            "/Wiki/tree/leaf.md",
            "/Wiki/tree"
        ]
    );
    let delete_etags = deletes
        .iter()
        .map(|request| request.expected_etag.as_deref())
        .collect::<Vec<_>>();
    assert_eq!(
        delete_etags,
        vec![Some("etag-twig"), Some("etag-leaf"), Some("etag-tree")]
    );
}

#[tokio::test]
async fn delete_tree_command_succeeds_when_nothing_matches() {
    let client = MockClient::default();

    run_command(
        &client,
        test_cli(Command::DeleteTree {
            path: "/Wiki/missing".to_string(),
            json: false,
        }),
    )
    .await
    .expect("delete tree should allow empty matches");

    let deletes = client.deletes.lock().expect("deletes should lock");
    assert!(deletes.is_empty());
}

#[tokio::test]
async fn delete_tree_command_stops_after_first_delete_failure() {
    let client = MockClient {
        nodes: vec![
            wiki_types::Node {
                path: "/Wiki/tree/a.md".to_string(),
                kind: wiki_types::NodeKind::File,
                content: String::new(),
                created_at: 1,
                updated_at: 1,
                etag: "etag-a".to_string(),
                metadata_json: "{}".to_string(),
            },
            wiki_types::Node {
                path: "/Wiki/tree/deeper/b.md".to_string(),
                kind: wiki_types::NodeKind::File,
                content: String::new(),
                created_at: 1,
                updated_at: 2,
                etag: "etag-b".to_string(),
                metadata_json: "{}".to_string(),
            },
            wiki_types::Node {
                path: "/Wiki/tree/z.md".to_string(),
                kind: wiki_types::NodeKind::File,
                content: String::new(),
                created_at: 1,
                updated_at: 3,
                etag: "etag-z".to_string(),
                metadata_json: "{}".to_string(),
            },
        ],
        delete_fail_paths: ["/Wiki/tree/deeper/b.md".to_string()].into_iter().collect(),
        ..Default::default()
    };

    let error = run_command(
        &client,
        test_cli(Command::DeleteTree {
            path: "/Wiki/tree".to_string(),
            json: false,
        }),
    )
    .await
    .expect_err("delete tree should fail fast");
    assert!(error.to_string().contains("/Wiki/tree/deeper/b.md"));

    let deletes = client.deletes.lock().expect("deletes should lock");
    assert!(deletes.is_empty());
}

#[test]
fn delete_tree_command_parses_from_cli() {
    let parsed = Cli::try_parse_from(["wiki-cli", "delete-tree", "--path", "/Wiki/tree"])
        .expect("delete-tree should parse");
    match parsed.command {
        Command::DeleteTree { path, json } => {
            assert_eq!(path, "/Wiki/tree");
            assert!(!json);
        }
        other => panic!("unexpected command: {other:?}"),
    }
}
