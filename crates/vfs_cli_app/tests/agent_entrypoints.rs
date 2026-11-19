use clap::Parser;
use vfs_cli_app::cli::Cli;
#[test]
fn agent_short_commands_and_cwd_parse_without_json_files() {
    for args in [
        vec![
            "kinic-vfs-cli",
            "agent",
            "run",
            "--engine",
            "dsh",
            "--task",
            "fix",
            "--cwd",
            "/project",
        ],
        vec![
            "kinic-vfs-cli",
            "agent",
            "recall",
            "--task",
            "decisions",
            "--cwd",
            "/project",
        ],
    ] {
        assert!(Cli::try_parse_from(args).is_ok(), "short command rejected");
    }
}

use std::{
    fs,
    path::Path,
    process::{Command, Output},
};
fn invoke(root: &Path, home: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_kinic-vfs-cli"))
        .args(args)
        .current_dir(root)
        .env("HOME", home)
        .env("ICP_HOME", home.join("icp"))
        .env_remove("VFS_DATABASE_ID")
        .env_remove("VFS_CANISTER_ID")
        .output()
        .unwrap()
}
#[test]
fn doctor_without_identity_returns_partial_json_and_never_runs_executables() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let home = root.join("home");
    fs::create_dir_all(root.join(".kinic")).unwrap();
    fs::write(
        root.join(".kinic/config.toml"),
        "[learning]\nbudget_tokens=4096\n[agents.codex]\nexecutable='/definitely/missing/codex'\n",
    )
    .unwrap();
    let output = invoke(
        root,
        &home,
        &["agent", "doctor", "--engine", "codex", "--json"],
    );
    assert_eq!(
        output.status.code(),
        Some(1),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["schema_version"], 1);
    assert!(
        value["checks"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["code"] == "executable_missing")
    );
    assert!(!home.exists(), "doctor created local state");
}
#[test]
fn setup_dry_run_conflicts_and_apply_are_explicit_and_idempotent() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let home = root.join("home");
    let base = [
        "agent",
        "setup",
        "--engine",
        "dsh",
        "--executable",
        "/bin/echo",
        "--json",
    ];
    let output = invoke(root, &home, &[base.as_slice(), &["--dry-run"]].concat());
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(!home.exists());
    assert!(!root.join(".kinic").exists());
    let output = invoke(root, &home, &base);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let config = home.join(".config/kinic-vfs-cli/config.toml");
    assert!(fs::read_to_string(&config).unwrap().contains("/bin/echo"));
    let before = fs::read(&config).unwrap();
    let mut different = base;
    different[5] = "/bin/cat";
    let output = invoke(root, &home, &different);
    assert!(output.status.success());
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["status"], "changes_pending");
    assert_eq!(fs::read(&config).unwrap(), before);
    let output = invoke(root, &home, &[different.as_slice(), &["--apply"]].concat());
    assert!(output.status.success());
    assert!(fs::read_to_string(config).unwrap().contains("/bin/cat"));
    let output = invoke(root, &home, &different);
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["status"], "unchanged");
}

#[test]
fn legacy_setup_aliases_use_nonwriting_shared_setup() {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().join("home");
    for engine in ["codex", "dsh"] {
        let output = invoke(
            tmp.path(),
            &home,
            &[
                engine,
                "setup",
                "--executable",
                "/bin/echo",
                "--dry-run",
                "--json",
            ],
        );
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(value["status"], "dry_run");
        assert!(!home.exists());
    }
}

#[test]
fn doctor_json_hides_parse_secrets_and_cwd_uses_target_project() {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().join("home");
    let other = tmp.path().join("other");
    fs::create_dir_all(tmp.path().join(".kinic")).unwrap();
    fs::create_dir_all(other.join(".kinic")).unwrap();
    fs::write(
        tmp.path().join(".kinic/config.toml"),
        "api_key='PRIVATE_PARSE_SECRET\n",
    )
    .unwrap();
    fs::write(
        other.join(".kinic/config.toml"),
        "database_id='target-db'\ncanister_id='not-a-principal'\n[learning]\nbudget_tokens=100\n",
    )
    .unwrap();
    let output = invoke(tmp.path(), &home, &["agent", "doctor", "--json"]);
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert!(!stdout.contains("PRIVATE_PARSE_SECRET"));
    assert!(!String::from_utf8_lossy(&output.stderr).contains("PRIVATE_PARSE_SECRET"));
    let output = invoke(
        tmp.path(),
        &home,
        &[
            "agent",
            "doctor",
            "--cwd",
            other.to_str().unwrap(),
            "--json",
        ],
    );
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["target"]["database_id"], "target-db");
}
#[cfg(unix)]
#[test]
fn doctor_and_setup_never_start_a_configured_wrapper() {
    use std::os::unix::fs::PermissionsExt;
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().join("home");
    let wrapper = tmp.path().join("wrapper");
    let marker = tmp.path().join("executed");
    fs::write(
        &wrapper,
        format!("#!/bin/sh\ntouch '{}'\n", marker.display()),
    )
    .unwrap();
    fs::set_permissions(&wrapper, fs::Permissions::from_mode(0o700)).unwrap();
    let setup = invoke(
        tmp.path(),
        &home,
        &[
            "agent",
            "setup",
            "--engine",
            "dsh",
            "--executable",
            wrapper.to_str().unwrap(),
            "--json",
        ],
    );
    assert!(setup.status.success());
    let before = fs::read(tmp.path().join(".kinic/config.toml")).unwrap();
    let doctor = invoke(
        tmp.path(),
        &home,
        &["agent", "doctor", "--engine", "dsh", "--json"],
    );
    assert!(!marker.exists());
    assert_eq!(
        fs::read(tmp.path().join(".kinic/config.toml")).unwrap(),
        before
    );
    let value: serde_json::Value = serde_json::from_slice(&doctor.stdout).unwrap();
    assert!(
        value["checks"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["code"] == "model_unverified")
    );
    assert!(!home.join(".kinic/learning").exists());
}

#[test]
fn relative_run_cwd_is_normalized_once_before_connection_and_dispatch() {
    let root = tempfile::tempdir().unwrap();
    fs::create_dir(root.path().join("child")).unwrap();
    let mut cli = Cli::try_parse_from([
        "kinic-vfs-cli",
        "agent",
        "run",
        "--engine",
        "codex",
        "--task",
        "fix",
        "--cwd",
        "child",
    ])
    .unwrap();
    let vfs_cli_app::cli::Command::Agent { command } = &mut cli.command else {
        panic!()
    };
    let target = command.resolve_cwd(root.path()).unwrap().unwrap();
    assert_eq!(target, root.path().join("child").canonicalize().unwrap());
    assert_eq!(command.cwd(), Some(&target));
    // The runner's later canonicalization must still point to this same directory.
    assert_eq!(command.cwd().unwrap().canonicalize().unwrap(), target);
}

#[test]
fn doctor_startup_failure_uses_exit_two_and_structured_sanitized_output() {
    let root = tempfile::tempdir().unwrap();
    let home = root.path().join("home");
    let output = invoke(
        root.path(),
        &home,
        &["agent", "doctor", "--cwd", "missing-directory", "--json"],
    );
    assert_eq!(output.status.code(), Some(2));
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["checks"][0]["code"], "diagnostic_failed");
    assert!(!home.exists());
}

#[cfg(unix)]
#[test]
fn doctor_project_discovery_does_not_execute_git_or_other_helpers() {
    use std::os::unix::fs::PermissionsExt;
    let root = tempfile::tempdir().unwrap();
    let home = root.path().join("home");
    let bin = root.path().join("bin");
    fs::create_dir(&bin).unwrap();
    fs::create_dir(root.path().join(".git")).unwrap();
    let marker = root.path().join("unexpected-helper");
    let git = bin.join("git");
    fs::write(&git, format!("#!/bin/sh\n: > '{}'\n", marker.display())).unwrap();
    fs::set_permissions(&git, fs::Permissions::from_mode(0o700)).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_kinic-vfs-cli"))
        .args(["agent", "doctor", "--json"])
        .current_dir(root.path())
        .env("HOME", &home)
        .env("PATH", &bin)
        .env_remove("VFS_DATABASE_ID")
        .env_remove("VFS_CANISTER_ID")
        .output()
        .unwrap();
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["schema_version"], 1);
    assert!(!marker.exists());
    assert!(!home.exists());
}

#[test]
fn doctor_distinguishes_portable_connection_binding_from_remote_failure() {
    let root = tempfile::tempdir().unwrap();
    let home = root.path().join("home");
    let id = "b".repeat(32);
    let project = serde_json::json!({"version":2,"project_id":id,"enabled":false,"replica_host":"http://127.0.0.1:1","canister_id":"aaaaa-aa","database_id":"bound-db","principal":null,"recall":{"namespace":format!("/Knowledge/projects/{id}"),"budget_tokens":1000},"runner":{"engine":"codex","executable":"/bin/echo"}});
    fs::write(
        root.path().join(".kinic-learning.json"),
        serde_json::to_vec(&project).unwrap(),
    )
    .unwrap();
    let output = invoke(
        root.path(),
        &home,
        &["--database-id", "other-db", "agent", "doctor", "--json"],
    );
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert!(
        value["checks"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["code"] == "project_connection_mismatch")
    );
    assert!(!home.exists());
}

#[test]
fn legacy_dsh_alias_preserves_existing_configured_launcher() {
    let root = tempfile::tempdir().unwrap();
    let home = root.path().join("home");
    fs::create_dir(root.path().join(".kinic")).unwrap();
    fs::write(
        root.path().join(".kinic/config.toml"),
        "[learning]\nbudget_tokens=1000\n[agents.dsh]\nexecutable='/bin/echo'\n",
    )
    .unwrap();
    let output = invoke(root.path(), &home, &["dsh", "setup", "--dry-run", "--json"]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["executable"], "/bin/echo");
    assert!(!home.exists());
}

#[test]
fn old_adapter_binding_waits_for_identity_before_creating_intake() {
    use std::io::Write;
    use std::process::Stdio;
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    fs::create_dir_all(root.join(".kinic")).unwrap();
    fs::write(
        root.join(".kinic/config.toml"),
        "[learning]\nbudget_tokens=1000\n",
    )
    .unwrap();
    let state = root.join("state");
    let home = root.join("home");
    let mut child = Command::new(env!("CARGO_BIN_EXE_kinic-vfs-cli"))
        .args([
            "--replica-host",
            "http://127.0.0.1:1",
            "--canister-id",
            "aaaaa-aa",
            "--database-id",
            "bound-db",
            "agent",
            "hook",
            "--engine",
            "codex",
            "--state-dir",
        ])
        .arg(&state)
        .current_dir(root)
        .env("HOME", &home)
        .env("ICP_HOME", home.join("icp"))
        .env_remove("VFS_DATABASE_ID")
        .env_remove("VFS_CANISTER_ID")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let request = serde_json::json!({"cwd":root,"hook_event_name":"SessionEnd","session_id":"old-adapter","expected_routing_binding":"previous-caller"});
    child
        .stdin
        .take()
        .unwrap()
        .write_all(request.to_string().as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        !output.status.success(),
        "missing identity unexpectedly accepted"
    );
    assert!(
        !state.exists(),
        "intake was created before caller binding could be verified"
    );
}

#[test]
fn stdin_recall_configuration_is_prepared_before_identity_without_a_temporary_file() {
    use std::{io::Write, process::Stdio};
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let home = root.join("home");
    for command in [
        vec!["recall", "--task", "test"],
        vec!["run", "--engine", "codex", "--task", "test"],
    ] {
        let mut child = Command::new(env!("CARGO_BIN_EXE_kinic-vfs-cli"))
            .args([
                "--replica-host",
                "http://127.0.0.1:1",
                "--canister-id",
                "aaaaa-aa",
                "--database-id",
                "db",
                "--identity-mode",
                "anonymous",
                "agent",
            ])
            .args(command)
            .args(["--recall-config", "-"])
            .current_dir(root)
            .env_clear()
            .env("HOME", &home)
            .env("PATH", "/usr/bin:/bin")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(b"{\"budget_tokens\":1234}")
            .unwrap();
        let output = child.wait_with_output().unwrap();
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            stderr.contains("cannot run authenticated commands"),
            "stdin failed before normal identity dispatch: {stderr}"
        );
    }
    assert_eq!(
        fs::read_dir(root).unwrap().count(),
        0,
        "stdin configuration created state or a temporary file"
    );
}

#[test]
fn stdin_recall_errors_are_sanitized_and_portable_policies_require_a_file() {
    use std::{io::Write, process::Stdio};
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    for (input, expected) in [
        ("{\"PRIVATE_STDIN_TOKEN\":", "invalid JSON configuration"),
        ("{\"version\":2}", "on-disk file"),
    ] {
        let mut child = Command::new(env!("CARGO_BIN_EXE_kinic-vfs-cli"))
            .args(["agent", "recall", "--task", "test", "--recall-config", "-"])
            .current_dir(root)
            .env_clear()
            .env("HOME", root.join("home"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(input.as_bytes())
            .unwrap();
        let output = child.wait_with_output().unwrap();
        let error = String::from_utf8_lossy(&output.stderr);
        assert!(!output.status.success());
        assert!(error.contains(expected), "{error}");
        assert!(!error.contains("PRIVATE_STDIN_TOKEN"));
    }
    let output = Command::new(env!("CARGO_BIN_EXE_kinic-vfs-cli"))
        .args([
            "agent",
            "run",
            "--task",
            "test",
            "--runner-file",
            "-",
            "--recall-config",
            "-",
        ])
        .current_dir(root)
        .env("HOME", root.join("home"))
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(String::from_utf8_lossy(&output.stderr).contains("cannot both read stdin"));
    assert_eq!(fs::read_dir(root).unwrap().count(), 0);
}

#[test]
fn claude_engine_is_accepted_by_all_agent_entrypoints() {
    for args in [
        vec!["agent", "setup", "--engine", "claude", "--dry-run"],
        vec!["agent", "doctor", "--engine", "claude"],
        vec!["agent", "run", "--engine", "claude", "--task", "fix"],
        vec!["agent", "hook", "--engine", "claude"],
        vec!["agent", "flush", "--engine", "claude", "--replay-inbox"],
    ] {
        assert!(
            Cli::try_parse_from(std::iter::once("kinic-vfs-cli").chain(args.clone())).is_ok(),
            "{args:?}"
        );
    }
}

#[test]
fn claude_setup_prepares_payload_without_activation_and_preserves_settings() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let home = root.join("home");
    fs::create_dir_all(home.join(".claude")).unwrap();
    let settings = home.join(".claude/settings.json");
    fs::write(
        &settings,
        r#"{"theme":"dark","enabledPlugins":{"keep@tools":true}}"#,
    )
    .unwrap();
    let original = fs::read(&settings).unwrap();
    let args = [
        "agent",
        "setup",
        "--engine",
        "claude",
        "--executable",
        "/bin/echo",
        "--json",
    ];
    let dry = invoke(root, &home, &[args.as_slice(), &["--dry-run"]].concat());
    assert!(
        dry.status.success(),
        "{}",
        String::from_utf8_lossy(&dry.stderr)
    );
    assert!(!home.join(".claude/plugins/kinic").exists());
    assert!(!root.join(".kinic").exists());
    let output = invoke(root, &home, &args);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    let plugin = home.join(".claude/plugins/kinic/plugins/kinic-skill-recorder");
    assert_eq!(value["plugin_directory"], plugin.to_string_lossy().as_ref());
    assert!(plugin.join("hooks/hooks.json").exists());
    assert_eq!(fs::read(&settings).unwrap(), original);
    assert!(!root.join(".kinic-learning.json").exists());
    let manifest = home.join(".claude/plugins/kinic/.claude-plugin/marketplace.json");
    let mut metadata: serde_json::Value =
        serde_json::from_slice(&fs::read(&manifest).unwrap()).unwrap();
    let descriptor: serde_json::Value =
        serde_json::from_slice(&fs::read(plugin.join(".claude-plugin/plugin.json")).unwrap())
            .unwrap();
    assert_eq!(
        metadata["plugins"][0]["version"], descriptor["version"],
        "marketplace version must match embedded plugin"
    );
    metadata["custom"] = serde_json::json!("keep");
    metadata["plugins"]
        .as_array_mut()
        .unwrap()
        .push(serde_json::json!({"name":"other","source":"./other"}));
    fs::write(&manifest, serde_json::to_vec(&metadata).unwrap()).unwrap();
    let output = invoke(root, &home, &[args.as_slice(), &["--apply"]].concat());
    assert!(output.status.success());
    let after: serde_json::Value = serde_json::from_slice(&fs::read(&manifest).unwrap()).unwrap();
    assert_eq!(after["custom"], "keep");
    assert_eq!(after["plugins"].as_array().unwrap().len(), 2);
    let output = invoke(root, &home, &args);
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["status"], "unchanged");
    assert!(!value["next"].as_str().unwrap().contains("Codex"));
    fs::write(plugin.join("hooks/hooks.json"), "local customization").unwrap();
    let output = invoke(root, &home, &args);
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["status"], "changes_pending");
    assert_eq!(
        fs::read_to_string(plugin.join("hooks/hooks.json")).unwrap(),
        "local customization"
    );
}

#[test]
fn claude_doctor_inspects_claude_payload_without_executing_wrapper() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let home = root.join("home");
    let plugin = home.join(".claude/plugins/kinic/plugins/kinic-skill-recorder/hooks");
    fs::create_dir_all(&plugin).unwrap();
    fs::write(plugin.join("hooks.json"), "{}").unwrap();
    let output = invoke(
        root,
        &home,
        &[
            "agent",
            "setup",
            "--engine",
            "claude",
            "--executable",
            "/definitely/missing/claude",
            "--dry-run",
            "--json",
        ],
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let output = invoke(
        root,
        &home,
        &["agent", "doctor", "--engine", "claude", "--json"],
    );
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert!(
        value["checks"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["id"] == "engine.claude.placement" && c["code"] == "payload_present")
    );
    assert!(
        value["checks"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["code"] == "executable_missing")
    );
    assert!(!root.join(".kinic").exists());
}
