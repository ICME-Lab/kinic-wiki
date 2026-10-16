use std::{fs, path::Path};
use vfs_cli_app::agent_config::AgentConfig;
fn put(root: &Path, relative: &str, value: &str) {
    let path = root.join(relative);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, value).unwrap();
}
#[test]
fn config_layers_paths_and_explicit_json_preserve_absent_fields() {
    let root = tempfile::tempdir().unwrap();
    let home = root.path().join("home");
    let project = root.path().join("project");
    put(
        &home,
        ".config/kinic-vfs-cli/config.toml",
        "[learning]\nbudget_tokens=1000\n[agents.dsh]\nexecutable='./bin/dsh'\nmodel='user-model'\ntimeout_seconds=44\ninherited_environment=['DEEPSEEK_API_KEY']\n",
    );
    put(
        &project,
        ".kinic/config.toml",
        "[learning]\nbudget_tokens=2000\nstate_dir='./state'\n[agents.dsh]\nmodel='project-model'\n",
    );
    fs::create_dir_all(project.join("src/deep")).unwrap();
    let config = AgentConfig::load(&project.join("src/deep"), &home).unwrap();
    let runner = config.runner(Some("dsh"), None).unwrap();
    assert_eq!(runner.model.as_deref(), Some("project-model"));
    assert_eq!(runner.timeout_seconds, 44);
    assert_eq!(runner.inherited_environment, vec!["DEEPSEEK_API_KEY"]);
    assert_eq!(
        runner.executable,
        home.join(".config/kinic-vfs-cli/bin/dsh")
    );
    let recall = config.recall(None).unwrap().unwrap();
    assert_eq!(recall.budget_tokens, 2000);
    assert_eq!(
        recall.state_dir,
        project.canonicalize().unwrap().join(".kinic/state")
    );
    let json = root.path().join("runner.json");
    fs::write(&json, r#"{"engine":"dsh","model":"json-model"}"#).unwrap();
    assert_eq!(
        config
            .runner(Some("dsh"), Some(&json))
            .unwrap()
            .timeout_seconds,
        44
    );
    assert_eq!(
        config.runner(None, Some(&json)).unwrap().model.as_deref(),
        Some("json-model")
    );
    assert_eq!(
        config
            .runner(None, Some(&json))
            .unwrap()
            .inherited_environment,
        vec!["DEEPSEEK_API_KEY"]
    );
    assert!(config.runner(Some("codex"), Some(&json)).is_err());
}
#[test]
fn legacy_runner_and_recall_keep_defaults_and_path_meaning() {
    let root = tempfile::tempdir().unwrap();
    let home = root.path().join("home");
    let json = root.path().join("runner.json");
    fs::write(&json, r#"{"engine":"codex","executable":"./wrapper"}"#).unwrap();
    let recall = root.path().join("recall.json");
    fs::write(&recall, r#"{"budget_tokens":1234,"state_dir":"./cache"}"#).unwrap();
    let config = AgentConfig::load(root.path(), &home).unwrap();
    let runner = config.runner(None, Some(&json)).unwrap();
    assert_eq!(runner.executable, Path::new("./wrapper"));
    assert_eq!(runner.timeout_seconds, 300);
    assert_eq!(
        config.recall(Some(&recall)).unwrap().unwrap().budget_tokens,
        1234
    );
    assert!(config.recall(None).unwrap().is_none());
    assert!(config.runner(None, None).is_err());
}
#[test]
fn config_errors_never_echo_secret_input() {
    let root = tempfile::tempdir().unwrap();
    put(
        root.path(),
        ".kinic/config.toml",
        "secret='VERY_PRIVATE_TOKEN\n",
    );
    let error = AgentConfig::load(root.path(), root.path())
        .unwrap_err()
        .to_string();
    assert!(!error.contains("VERY_PRIVATE_TOKEN"));
}

#[test]
fn invalid_agent_table_is_rejected_before_setup_can_index_it() {
    let root = tempfile::tempdir().unwrap();
    put(root.path(), ".kinic/config.toml", "agents='not-a-table'\n");
    assert!(AgentConfig::load(root.path(), root.path()).is_err());
}

#[test]
fn equivalent_toml_and_legacy_json_resolve_identical_runtime_inputs() {
    // Compare against the original typed JSON deserialization path, not resolver helpers.
    let root = tempfile::tempdir().unwrap();
    let home = root.path().join("home");
    put(
        root.path(),
        ".kinic/config.toml",
        r#"
[agents.codex]
executable="codex"
model="fixture-model"
reasoning_effort="high"
timeout_seconds=321
max_output_bytes=100000
extra_args=[]
read_only=true
env_clear=false
[learning]
namespace="/Memory"
budget_tokens=2048
fts=true
graph=false
semantic=false
max_index_nodes=999
environment=["fixture"]
"#,
    );
    let runner: vfs_cli_app::learning_runner::RunnerConfig=serde_json::from_str(r#"{"engine":"codex","executable":"codex","model":"fixture-model","reasoning_effort":"high","timeout_seconds":321,"max_output_bytes":100000,"read_only":true}"#).unwrap();
    let recall: vfs_cli_app::learning::RecallOptions=serde_json::from_str(r#"{"namespace":"/Memory","budget_tokens":2048,"fts":true,"graph":false,"semantic":false,"max_index_nodes":999,"environment":["fixture"]}"#).unwrap();
    let config = AgentConfig::load(root.path(), &home).unwrap();
    assert_eq!(config.runner(Some("codex"), None).unwrap(), runner);
    assert_eq!(
        serde_json::to_value(config.recall(None).unwrap().unwrap()).unwrap(),
        serde_json::to_value(recall).unwrap()
    );
}

fn portable(root: &Path) -> vfs_cli_app::learning::project::ProjectConfig {
    let id = "a".repeat(32);
    let config=vfs_cli_app::learning::project::ProjectConfig {
        version:2,project_id:id.clone(),enabled:false,
        replica_host:"http://127.0.0.1:1".into(),canister_id:"aaaaa-aa".into(),database_id:"portable-db".into(),principal:None,
        recall:serde_json::from_value(serde_json::json!({"namespace":format!("/Knowledge/projects/{id}"),"budget_tokens":1024})).unwrap(),
        runner:vfs_cli_app::learning_runner::RunnerConfig {executable:root.join("runner"),model:Some("portable-model".into()),..Default::default()},
        validation_suite:None,shared_scopes:vec!["/Knowledge/shared".into()],
    };
    vfs_cli_app::learning::project::save_project(&root.join(".kinic-learning.json"), &config)
        .unwrap();
    config
}
#[test]
fn toml_overlays_portable_runtime_settings_without_changing_identity_policy_or_enablement() {
    let root = tempfile::tempdir().unwrap();
    let project = portable(root.path());
    let before = fs::read(root.path().join(".kinic-learning.json")).unwrap();
    put(
        root.path(),
        ".kinic/config.toml",
        "[learning]\nbudget_tokens=2048\n[agents.codex]\nmodel='toml-model'\n",
    );
    let config = AgentConfig::load(root.path(), &root.path().join("home")).unwrap();
    let recall = config.recall(None).unwrap().unwrap();
    assert_eq!(recall.budget_tokens, 2048);
    assert_eq!(
        recall.project_id.as_deref(),
        Some(project.project_id.as_str())
    );
    assert_eq!(recall.read_scopes, project.recall_scopes());
    let runner = config.runner(Some("codex"), None).unwrap();
    assert_eq!(runner.model.as_deref(), Some("toml-model"));
    assert_eq!(runner.executable, project.runner.executable);
    assert_eq!(
        fs::read(root.path().join(".kinic-learning.json")).unwrap(),
        before
    );
    put(
        root.path(),
        ".kinic/config.toml",
        "[learning]\nnamespace='/Knowledge'\nbudget_tokens=2048\n",
    );
    assert!(
        AgentConfig::load(root.path(), &root.path().join("home"))
            .unwrap()
            .recall(None)
            .is_err()
    );
}

#[test]
fn setup_in_linked_worktree_keeps_primary_portable_budget() {
    let root = tempfile::tempdir().unwrap();
    let primary = root.path().join("primary");
    let linked = root.path().join("linked");
    let home = root.path().join("home");
    fs::create_dir_all(primary.join(".git/worktrees/test")).unwrap();
    fs::create_dir(&linked).unwrap();
    portable(&primary);
    fs::write(primary.join(".git/worktrees/test/commondir"), "../..\n").unwrap();
    fs::write(
        linked.join(".git"),
        format!(
            "gitdir: {}\n",
            primary.join(".git/worktrees/test").display()
        ),
    )
    .unwrap();
    let report = vfs_cli_app::agent_setup::prepare(
        &vfs_cli_app::learning::cli::SetupArgs {
            engine: "codex".into(),
            dry_run: true,
            ..Default::default()
        },
        &linked,
        &home,
    )
    .unwrap();
    assert!(report["configuration_changes"]["new_learning_budget_tokens"].is_null());
    assert!(!report["changes"].as_array().unwrap().iter().any(|c| {
        c["path"]
            .as_str()
            .unwrap()
            .ends_with("linked/.kinic/config.toml")
    }));
}

#[test]
fn prepared_stdin_recall_is_reusable_and_overrides_project_runtime_defaults() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    put(
        dir.path(),
        ".kinic/config.toml",
        "[learning]\nbudget_tokens=99\nfts=false\n",
    );
    let config = AgentConfig::load(dir.path(), &home)
        .unwrap()
        .with_stdin_recall(Some(serde_json::json!({"budget_tokens":1234})));
    for _ in 0..3 {
        assert!(
            config
                .portable_project(Some(Path::new("-")))
                .unwrap()
                .is_none()
        );
        let recall = config.recall(Some(Path::new("-"))).unwrap().unwrap();
        assert_eq!(recall.budget_tokens, 1234);
        assert!(!recall.fts);
    }
}

#[test]
fn legacy_file_and_stdin_retain_portable_policy() {
    let root = tempfile::tempdir().unwrap();
    let project = portable(root.path());
    let path = root.path().join("runtime.json");
    fs::write(&path, r#"{"budget_tokens":2222}"#).unwrap();
    for explicit in [&*path, Path::new("-")] {
        let config = AgentConfig::load(root.path(), &root.path().join("home"))
            .unwrap()
            .with_stdin_recall(Some(serde_json::json!({"budget_tokens":2222})));
        assert_eq!(
            config
                .portable_project(Some(explicit))
                .unwrap()
                .unwrap()
                .project_id,
            project.project_id
        );
        let recall = config.recall(Some(explicit)).unwrap().unwrap();
        assert_eq!(recall.budget_tokens, 2222);
        assert_eq!(recall.namespace, project.knowledge_scope());
        assert_eq!(recall.read_scopes, project.recall_scopes());
        for policy in [
            serde_json::json!({"namespace":"/Knowledge"}),
            serde_json::json!({"project_id":"other"}),
            serde_json::json!({"read_scopes":["/Knowledge"]}),
        ] {
            fs::write(&path, serde_json::to_vec(&policy).unwrap()).unwrap();
            let config = config.clone().with_stdin_recall(Some(policy));
            assert!(config.recall(Some(explicit)).is_err());
        }
        fs::write(&path, r#"{"budget_tokens":2222}"#).unwrap();
    }
    let other_root = tempfile::tempdir().unwrap();
    let mut other = portable(other_root.path());
    other.project_id = "b".repeat(32);
    other.recall.namespace = other.knowledge_scope();
    other.runner.inherited_environment = vec!["OPENAI_API_KEY".into()];
    let external = other_root.path().join(".kinic-learning.json");
    vfs_cli_app::learning::project::save_project(&external, &other).unwrap();
    let config = AgentConfig::load(root.path(), &root.path().join("home")).unwrap();
    let chosen = config.portable_project(Some(&external)).unwrap().unwrap();
    assert_eq!(chosen.project_id, "b".repeat(32));
    assert_eq!(chosen.runner.inherited_environment, vec!["OPENAI_API_KEY"]);
    assert_eq!(
        config.recall(Some(&external)).unwrap().unwrap().project_id,
        Some("b".repeat(32))
    );
}
