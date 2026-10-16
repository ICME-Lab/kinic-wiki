use super::integration_tests::StoreClient;
use super::{
    cli::{LearnCommand, StateArgs},
    project::*,
};
use crate::learning_runner::RunnerConfig;
use std::{path::Path, process::Command};
use vfs_cli::connection::ResolvedConnection;
fn connection() -> ResolvedConnection {
    ResolvedConnection {
        replica_host: "http://local".into(),
        canister_id: "canister".into(),
        database_id: Some("db".into()),
        replica_host_source: "test".into(),
        canister_id_source: "test".into(),
        database_id_source: None,
    }
}
fn state() -> StateArgs {
    StateArgs {
        state_dir: None,
        json: true,
    }
}
fn fixture_runner(root: &Path) -> RunnerConfig {
    let executable = root.join("fixture-agent");
    std::fs::write(&executable, "#!/bin/sh\nexit 0\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    RunnerConfig {
        executable,
        ..Default::default()
    }
}
fn setup(root: &Path, runner: &Path) -> LearnCommand {
    LearnCommand::Setup {
        project_root: root.into(),
        runner_file: runner.into(),
        validation_suite: None,
        shared_scope: vec!["/Knowledge/shared".into()],
        state: state(),
    }
}
#[tokio::test]
async fn setup_is_idempotent_and_projects_are_isolated() {
    let tmp = tempfile::tempdir().unwrap();
    let client = StoreClient::new(tmp.path());
    let runner = tmp.path().join("runner.json");
    std::fs::write(
        &runner,
        serde_json::to_vec(&fixture_runner(tmp.path())).unwrap(),
    )
    .unwrap();
    let a = tmp.path().join("a");
    let b = tmp.path().join("b");
    std::fs::create_dir(&a).unwrap();
    std::fs::create_dir(&b).unwrap();
    handle_project_command(&client, &connection(), &setup(&a, &runner))
        .await
        .unwrap();
    let first = load_project(&a.join(CONFIG_FILE)).unwrap();
    handle_project_command(&client, &connection(), &setup(&a, &runner))
        .await
        .unwrap();
    assert_eq!(
        first.project_id,
        load_project(&a.join(CONFIG_FILE)).unwrap().project_id
    );
    handle_project_command(&client, &connection(), &setup(&b, &runner))
        .await
        .unwrap();
    let second = load_project(&b.join(CONFIG_FILE)).unwrap();
    assert_ne!(first.project_id, second.project_id);
    assert!(
        first
            .private_scopes()
            .iter()
            .all(|p| !second.private_scopes().contains(p))
    );
    assert_eq!(first.recall_scopes().len(), 4);
    assert!(first.runner.executable.is_absolute());
    let mut wrong = connection();
    wrong.database_id = Some("other".into());
    assert!(first.validate_connection(&wrong).is_err());
    handle_project_command(
        &client,
        &connection(),
        &LearnCommand::Disable {
            project_root: a.clone(),
            state: state(),
        },
    )
    .await
    .unwrap();
    assert!(!load_project(&a.join(CONFIG_FILE)).unwrap().enabled);
}
#[tokio::test]
async fn legacy_migration_preserves_retrieval_and_rejects_invalid_scopes() {
    let tmp = tempfile::tempdir().unwrap();
    let client = StoreClient::new(tmp.path());
    let runner = tmp.path().join("runner.json");
    std::fs::write(
        &runner,
        serde_json::to_vec(&fixture_runner(tmp.path())).unwrap(),
    )
    .unwrap();
    let config = tmp.path().join(CONFIG_FILE);
    std::fs::write(
        &config,
        r#"{"namespace":"/Knowledge/old","budget_tokens":321,"fts":false}"#,
    )
    .unwrap();
    assert!(load_project(&config).is_err());
    handle_project_command(&client, &connection(), &setup(tmp.path(), &runner))
        .await
        .unwrap();
    let migrated = load_project(&config).unwrap();
    assert_eq!(migrated.recall.budget_tokens, 321);
    assert!(!migrated.recall.fts);
    assert!(
        migrated
            .shared_scopes
            .contains(&"/Knowledge/old".to_string())
    );
    assert!(config.with_extension("json.legacy").exists());
    let invalid = LearnCommand::Setup {
        project_root: tmp.path().into(),
        runner_file: runner,
        validation_suite: None,
        shared_scope: vec!["/Sources/secrets".into()],
        state: state(),
    };
    assert!(
        handle_project_command(&client, &connection(), &invalid)
            .await
            .is_err()
    );
}
#[test]
fn discovery_stops_at_git_root_and_shares_primary_with_linked_worktrees() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("primary");
    std::fs::create_dir(&repo).unwrap();
    for args in [
        vec!["init"],
        vec![
            "-c",
            "user.email=test@example.com",
            "-c",
            "user.name=Test",
            "commit",
            "--allow-empty",
            "-m",
            "initial",
        ],
    ] {
        assert!(
            Command::new("git")
                .args(args)
                .current_dir(&repo)
                .output()
                .unwrap()
                .status
                .success()
        );
    }
    std::fs::write(repo.join(CONFIG_FILE), "{}").unwrap();
    let linked = tmp.path().join("linked");
    assert!(
        Command::new("git")
            .args(["worktree", "add", "--detach"])
            .arg(&linked)
            .current_dir(&repo)
            .output()
            .unwrap()
            .status
            .success()
    );
    let nested = linked.join("deep");
    std::fs::create_dir(&nested).unwrap();
    assert_eq!(
        discover_config(&nested).unwrap(),
        Some(std::fs::canonicalize(repo.join(CONFIG_FILE)).unwrap())
    );
    std::fs::write(linked.join(CONFIG_FILE), "{}").unwrap();
    assert_eq!(
        discover_config(&nested).unwrap(),
        Some(std::fs::canonicalize(linked.join(CONFIG_FILE)).unwrap())
    );
    let unrelated = tmp.path().join("other");
    std::fs::create_dir(&unrelated).unwrap();
    std::fs::create_dir(unrelated.join(".git")).unwrap();
    std::fs::write(tmp.path().join(CONFIG_FILE), "{}").unwrap();
    assert!(discover_config(&unrelated).unwrap().is_none());
}

#[tokio::test]
async fn setup_rejects_stored_runner_secrets_and_load_rejects_injected_secrets() {
    let tmp = tempfile::tempdir().unwrap();
    let client = StoreClient::new(tmp.path());
    let runner = tmp.path().join("runner.json");
    let mut config = fixture_runner(tmp.path());
    config
        .environment
        .insert("PROVIDER_API_KEY".into(), "secret-value".into());
    std::fs::write(&runner, serde_json::to_vec(&config).unwrap()).unwrap();
    let error = handle_project_command(&client, &connection(), &setup(tmp.path(), &runner))
        .await
        .unwrap_err();
    assert!(error.to_string().contains("secrets must be inherited"));
    assert!(!tmp.path().join(CONFIG_FILE).exists());
    config.environment.clear();
    std::fs::write(&runner, serde_json::to_vec(&config).unwrap()).unwrap();
    handle_project_command(&client, &connection(), &setup(tmp.path(), &runner))
        .await
        .unwrap();
    let path = tmp.path().join(CONFIG_FILE);
    let mut project: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    project["runner"]["environment"] = serde_json::json!({"AUTH_TOKEN":"secret-value"});
    std::fs::write(&path, serde_json::to_vec(&project).unwrap()).unwrap();
    assert!(load_project(&path).is_err());
}
#[tokio::test]
async fn legacy_retry_reuses_identical_backup_but_preserves_conflicting_backup() {
    let tmp = tempfile::tempdir().unwrap();
    let client = StoreClient::new(tmp.path());
    let runner = tmp.path().join("runner.json");
    std::fs::write(
        &runner,
        serde_json::to_vec(&fixture_runner(tmp.path())).unwrap(),
    )
    .unwrap();
    let path = tmp.path().join(CONFIG_FILE);
    let backup = path.with_extension("json.legacy");
    let legacy = r#"{"budget_tokens":321}"#;
    std::fs::write(&path, legacy).unwrap();
    std::fs::write(&backup, legacy).unwrap();
    handle_project_command(&client, &connection(), &setup(tmp.path(), &runner))
        .await
        .unwrap();
    assert_eq!(std::fs::read_to_string(&backup).unwrap(), legacy);
    std::fs::write(&path, legacy).unwrap();
    std::fs::write(&backup, "different preserved original").unwrap();
    assert!(
        handle_project_command(&client, &connection(), &setup(tmp.path(), &runner))
            .await
            .is_err()
    );
    assert_eq!(std::fs::read_to_string(&path).unwrap(), legacy);
    assert_eq!(
        std::fs::read_to_string(&backup).unwrap(),
        "different preserved original"
    );
}

#[test]
fn review_fix_explicit_config_wins_before_connection_resolution() {
    use clap::Parser;
    let root = tempfile::tempdir().unwrap();
    let cwd = root.path().join("workspace");
    std::fs::create_dir(&cwd).unwrap();
    std::fs::write(cwd.join(CONFIG_FILE), "{}").unwrap();
    let explicit = root.path().join("external.json");
    std::fs::write(&explicit, "{}").unwrap();
    let cli = crate::cli::Cli::try_parse_from([
        "kinic-vfs-cli",
        "agent",
        "hook",
        "--engine",
        "codex",
        "--recall-config",
        explicit.to_str().unwrap(),
    ])
    .unwrap();
    assert_eq!(
        config_for_command(&cli.command, &cwd).unwrap(),
        Some(explicit.canonicalize().unwrap())
    );
    let drain = crate::cli::Cli::try_parse_from([
        "kinic-vfs-cli",
        "learn",
        "drain",
        "--project-root",
        cwd.to_str().unwrap(),
        "--recall-config",
        explicit.to_str().unwrap(),
    ])
    .unwrap();
    assert_eq!(
        config_for_command(&drain.command, &cwd).unwrap(),
        Some(explicit.canonicalize().unwrap())
    );
}
