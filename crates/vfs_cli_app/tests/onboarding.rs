use std::process::Command;

#[test]
fn privileged_setup_preview_never_executes_or_writes() {
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().join("project");
    std::fs::create_dir(&project).unwrap();
    let home = temp.path().join("home");
    let output = Command::new(env!("CARGO_BIN_EXE_kinic-vfs-cli"))
        .current_dir(&project)
        .env("HOME", &home)
        .env("PATH", "")
        .args([
            "agent",
            "setup",
            "--engine",
            "codex",
            "--authorize-keyring",
            "--install-plugin",
            "--dry-run",
            "--json",
        ])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["identity_authorization"]["status"], "planned");
    assert_eq!(value["plugin_installation"]["status"], "planned");
    assert!(!home.exists());
    assert!(!project.join(".kinic").exists());
}

#[cfg(unix)]
#[test]
fn changed_identity_stops_even_an_anonymous_read_before_network() {
    use std::{fs, os::unix::fs::PermissionsExt};
    use vfs_cli_app::identity_policy::{Grant, save};
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let home = root.join("home");
    let bin = root.join("bin");
    fs::create_dir(&bin).unwrap();
    fs::create_dir(root.join(".git")).unwrap();
    let id = home.join("icp/identity");
    fs::create_dir_all(&id).unwrap();
    fs::write(
        id.join("identity_list.json"),
        r#"{"v":1,"identities":{"changed":{"kind":"keyring"}}}"#,
    )
    .unwrap();
    fs::write(
        bin.join("icp"),
        "#!/bin/sh\nif [ \"$2\" = default ]; then echo changed; else exit 99; fi\n",
    )
    .unwrap();
    fs::set_permissions(bin.join("icp"), fs::Permissions::from_mode(0o755)).unwrap();
    save(
        &home,
        &Grant {
            project_root: root.clone(),
            replica_host: "http://127.0.0.1:1".into(),
            canister_id: "aaaaa-aa".into(),
            database_id: "db".into(),
            identity_name: "wiki".into(),
            principal: "aaaaa-aa".into(),
        },
    )
    .unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_kinic-vfs-cli"))
        .current_dir(&root)
        .env("HOME", &home)
        .env("ICP_HOME", home.join("icp"))
        .env("PATH", &bin)
        .args([
            "--replica-host",
            "http://127.0.0.1:1",
            "--canister-id",
            "aaaaa-aa",
            "--database-id",
            "db",
            "--identity-mode",
            "anonymous",
            "read-node",
            "--path",
            "/Knowledge/test",
            "--json",
        ])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("scoped identity grant identity mismatch"),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[cfg(unix)]
#[test]
fn explicit_authorization_pins_keyring_without_storing_private_key_and_is_idempotent() {
    authorization_case(false);
}
#[cfg(unix)]
#[test]
fn authorization_uses_existing_portable_project_destination() {
    authorization_case(true);
}
#[cfg(unix)]
fn authorization_case(portable: bool) {
    use std::{fs, os::unix::fs::PermissionsExt};
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let home = root.join("home");
    let bin = root.join("bin");
    fs::create_dir(&bin).unwrap();
    let id = home.join("icp/identity");
    fs::create_dir_all(&id).unwrap();
    fs::write(
        id.join("identity_list.json"),
        r#"{"v":1,"identities":{"fixture":{"kind":"keyring"}}}"#,
    )
    .unwrap();
    const PEM: &str = "-----BEGIN EC PARAMETERS-----\nBgUrgQQACg==\n-----END EC PARAMETERS-----\n-----BEGIN EC PRIVATE KEY-----\nMHQCAQEEIAgy7nZEcVHkQ4Z1Kdqby8SwyAiyKDQmtbEHTIM+WNeBoAcGBSuBBAAK\noUQDQgAEgO87rJ1ozzdMvJyZQ+GABDqUxGLvgnAnTlcInV3NuhuPv4O3VGzMGzeB\nN3d26cRxD99TPtm8uo2OuzKhSiq6EQ==\n-----END EC PRIVATE KEY-----\n";
    let script = format!(
        "#!/bin/sh\ncase \"$2\" in\ndefault) echo fixture;;\nexport) /bin/cat <<'KEY'\n{PEM}KEY\n;;\n*) exit 99;;\nesac\n"
    );
    fs::write(bin.join("icp"), script).unwrap();
    fs::set_permissions(bin.join("icp"), fs::Permissions::from_mode(0o755)).unwrap();
    if portable {
        portable_project(&root, "https://icp-api.io");
    }
    for _ in 0..2 {
        let mut command = Command::new(env!("CARGO_BIN_EXE_kinic-vfs-cli"));
        if !portable {
            command.args([
                "--replica-host",
                "https://icp-api.io",
                "--canister-id",
                "aaaaa-aa",
                "--database-id",
                "db",
            ]);
        }
        let output = command
            .current_dir(&root)
            .env("HOME", &home)
            .env("ICP_HOME", home.join("icp"))
            .env("CODEX_HOME", home.join(".codex"))
            .env("PATH", &bin)
            .args([
                "agent",
                "setup",
                "--engine",
                "codex",
                "--authorize-keyring",
                "--apply",
                "--json",
            ])
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(!String::from_utf8_lossy(&output.stdout).contains("PRIVATE KEY"));
        let result: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(result["identity_authorization"]["status"], "authorized");
        let connection = vfs_cli::connection::ResolvedConnection {
            replica_host: "https://icp-api.io".into(),
            canister_id: "aaaaa-aa".into(),
            database_id: Some("db".into()),
            replica_host_source: "test".into(),
            canister_id_source: "test".into(),
            database_id_source: None,
        };
        let grant = vfs_cli_app::identity_policy::lookup(&home, &root, &connection)
            .unwrap()
            .unwrap();
        assert_eq!(grant.identity_name, "fixture");
        assert_eq!(
            grant.principal,
            vfs_client::identity_from_pem(PEM.as_bytes())
                .unwrap()
                .sender()
                .unwrap()
                .to_text()
        );
    }
    assert_eq!(
        fs::read_dir(home.join(".config/kinic-vfs-cli/identity-grants"))
            .unwrap()
            .count(),
        1
    );
}

#[cfg(unix)]
fn portable_project(root: &std::path::Path, replica: &str) {
    let value = serde_json::json!({"version":2,"project_id":"00000000000000000000000000000000","enabled":true,"replica_host":replica,"canister_id":"aaaaa-aa","database_id":"db","principal":"aaaaa-aa","recall":{"budget_tokens":1000,"namespace":"/Knowledge/projects/00000000000000000000000000000000"},"runner":{"executable":"/bin/echo"}});
    std::fs::write(
        root.join(".kinic-learning.json"),
        serde_json::to_vec(&value).unwrap(),
    )
    .unwrap();
}

#[cfg(unix)]
#[test]
fn unavailable_scoped_keyring_preserves_hook_and_reports_flush_failure() {
    use std::{fs, io::Write, os::unix::fs::PermissionsExt, process::Stdio};
    use vfs_cli_app::identity_policy::{Grant, save};
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let home = root.join("home");
    let bin = root.join("bin");
    let state = root.join("state");
    fs::create_dir(&bin).unwrap();
    portable_project(&root, "http://127.0.0.1:1");
    let id = home.join("icp/identity");
    fs::create_dir_all(&id).unwrap();
    fs::write(
        id.join("identity_list.json"),
        r#"{"v":1,"identities":{"wiki":{"kind":"keyring"}}}"#,
    )
    .unwrap();
    fs::write(
        bin.join("icp"),
        "#!/bin/sh\nif [ \"$2\" = default ]; then echo wiki; else exit 99; fi\n",
    )
    .unwrap();
    fs::set_permissions(bin.join("icp"), fs::Permissions::from_mode(0o755)).unwrap();
    save(
        &home,
        &Grant {
            project_root: root.clone(),
            replica_host: "http://127.0.0.1:1".into(),
            canister_id: "aaaaa-aa".into(),
            database_id: "db".into(),
            identity_name: "wiki".into(),
            principal: "aaaaa-aa".into(),
        },
    )
    .unwrap();
    let request = serde_json::json!({"event":"UserPromptSubmit","session_id":"onboarding-failure","cwd":root,"task":"fixture only"});
    let mut command = Command::new(env!("CARGO_BIN_EXE_kinic-vfs-cli"));
    command
        .current_dir(&root)
        .env("HOME", &home)
        .env("ICP_HOME", home.join("icp"))
        .env("PATH", &bin);
    let mut child = command
        .args([
            "agent",
            "hook",
            "--engine",
            "codex",
            "--state-dir",
            state.to_str().unwrap(),
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(&serde_json::to_vec(&request).unwrap())
        .unwrap();
    assert!(!child.wait_with_output().unwrap().status.success());
    assert!(
        state.join("hook-inbox").is_dir(),
        "credential failure must preserve durable hook intake"
    );
    let output = Command::new(env!("CARGO_BIN_EXE_kinic-vfs-cli"))
        .current_dir(&root)
        .env("HOME", &home)
        .env("ICP_HOME", home.join("icp"))
        .env("PATH", &bin)
        .args([
            "agent",
            "flush",
            "--replay-inbox",
            "--engine",
            "codex",
            "--state-dir",
            state.to_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(
        state.join("learning-outbox.sqlite3").is_file(),
        "startup failure must be attributed to configured principal: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let connection = rusqlite::Connection::open(state.join("learning-outbox.sqlite3")).unwrap();
    let rows: i64 = connection
        .query_row(
            "SELECT count(*) FROM learning_delivery WHERE last_error_code = 'identity_unavailable'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(rows, 1);
}
