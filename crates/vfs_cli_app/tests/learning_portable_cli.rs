use std::io::Write;
use std::process::{Command, Stdio};
#[test]
fn unconfigured_project_hook_skips_before_identity_or_network() {
    let root = tempfile::tempdir().unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_kinic-vfs-cli"))
        .args(["agent", "hook", "--engine", "codex"])
        .current_dir(root.path())
        .env_clear()
        .env("HOME", root.path())
        .env("PATH", "/usr/bin:/bin")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(serde_json::json!({"event":"UserPromptSubmit","cwd":root.path(),"session_id":"s","prompt":"task"}).to_string().as_bytes()).unwrap();
    let out = child.wait_with_output().unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let value: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(value["skipped"], true);
    assert_eq!(value["additionalContext"], "");
    assert!(!root.path().join(".kinic").exists());
}
#[test]
fn portable_commands_are_in_published_cli_help() {
    for cmd in ["setup", "status", "enable", "disable", "drain"] {
        let out = Command::new(env!("CARGO_BIN_EXE_kinic-vfs-cli"))
            .args(["learn", cmd, "--help"])
            .output()
            .unwrap();
        assert!(out.status.success());
        assert!(String::from_utf8_lossy(&out.stdout).contains("--project-root"));
    }
}

#[test]
fn explicit_external_project_connection_is_bound_before_identity_setup() {
    let dir = tempfile::tempdir().unwrap();
    let project = dir.path().join("unlinked-workspace");
    std::fs::create_dir(&project).unwrap();
    let config = dir.path().join("external.json");
    let state = dir.path().join("state");
    let value = serde_json::json!({"version":2,"project_id":"00000000000000000000000000000000","enabled":false,"replica_host":"http://127.0.0.1:1","canister_id":"canister","database_id":"external-db","principal":"principal","recall":{"budget_tokens":100,"namespace":"/Knowledge/projects/00000000000000000000000000000000"},"runner":{"executable":"/bin/echo"}});
    std::fs::write(&config, serde_json::to_vec(&value).unwrap()).unwrap();
    // Anonymous mode fails before client/network construction. The durable intake
    // still proves which project connection was selected by the real entrypoint.
    let mut child = Command::new(env!("CARGO_BIN_EXE_kinic-vfs-cli"))
        .args([
            "--identity-mode",
            "anonymous",
            "agent",
            "hook",
            "--engine",
            "codex",
            "--recall-config",
        ])
        .arg(&config)
        .arg("--state-dir")
        .arg(&state)
        .env_clear()
        .env("HOME", dir.path())
        .env("PATH", "/usr/bin:/bin")
        .current_dir(&project)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(serde_json::json!({"event":"UserPromptSubmit","cwd":project,"session_id":"external","prompt":"task"}).to_string().as_bytes()).unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("cannot run authenticated commands"));
    let config = config.canonicalize().unwrap();
    // Shared configuration now fingerprints all contributing TOML/JSON files.
    // Verify accepted intake and its explicit project rather than duplicating that key algorithm.
    let partitions = std::fs::read_dir(state.join("hook-inbox"))
        .unwrap()
        .collect::<std::io::Result<Vec<_>>>()
        .unwrap();
    assert_eq!(partitions.len(), 1);
    let entries = std::fs::read_dir(partitions[0].path())
        .unwrap()
        .collect::<std::io::Result<Vec<_>>>()
        .unwrap();
    assert_eq!(entries.len(), 1);
    let accepted: serde_json::Value =
        serde_json::from_slice(&std::fs::read(entries[0].path()).unwrap()).unwrap();
    assert_eq!(accepted["__kinic_config"], serde_json::json!(config));
    assert_eq!(accepted["__kinic_principal"], "principal");
}
