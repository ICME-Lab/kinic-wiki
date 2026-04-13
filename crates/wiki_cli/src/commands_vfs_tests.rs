use std::path::PathBuf;

use tempfile::tempdir;

use crate::cli::{Cli, Command, ConnectionArgs, GlobNodeTypeArg, NodeKindArg};
use crate::commands::run_command;
use crate::commands_fs_tests::MockClient;

fn test_cli(command: Command) -> Cli {
    Cli {
        connection: ConnectionArgs {
            replica_host: "http://127.0.0.1:4943".to_string(),
            canister_id: "aaaaa-aa".to_string(),
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
