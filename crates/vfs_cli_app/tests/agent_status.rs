use serde_json::{Value, json};
use std::{
    fs,
    path::Path,
    process::{Command, Output},
};
fn status(root: &Path, home: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_kinic-vfs-cli"))
        .args(args)
        .current_dir(root)
        .env("HOME", home)
        .env("ICP_HOME", home.join("icp"))
        .env_remove("CODEX_HOME")
        .env_remove("VFS_DATABASE_ID")
        .env_remove("VFS_CANISTER_ID")
        .env_remove("KINIC_LEARNING_HOME")
        .env_remove("KINIC_LEARNING_CONFIG")
        .output()
        .unwrap()
}
fn report(output: Output) -> Value {
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}
#[test]
fn missing_status_never_creates_state_or_requires_identity() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let home = root.join("absent-home");
    let value = report(status(root, &home, &["agent", "status", "--json"]));
    assert_eq!(value["schema_version"], 1);
    assert_eq!(value["mode"], "local_read_only");
    assert_eq!(value["records"]["status"], "unknown");
    assert_eq!(value["publication"]["status"], "unknown");
    assert!(!home.exists());
    assert_eq!(fs::read_dir(root).unwrap().count(), 0);
}
#[test]
fn status_cwd_resolves_other_project_without_network_or_engine_start() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let home = root.join("absent-home");
    for (name, db) in [("a", "db-a"), ("b", "db-b")] {
        let config = root.join(name).join(".kinic");
        fs::create_dir_all(&config).unwrap();
        fs::write(config.join("config.toml"),format!("replica_host='http://127.0.0.1:1'\ncanister_id='aaaaa-aa'\ndatabase_id='{db}'\n[learning]\nbudget_tokens=1000\n[agents.codex]\nexecutable='/bin/false'\n")).unwrap();
    }
    let value = report(status(
        &root.join("a"),
        &home,
        &["agent", "status", "--cwd", "../b", "--json"],
    ));
    assert_eq!(value["target"]["database_id"], "db-b");
    assert_eq!(value["configuration"]["engines"], json!(["codex"]));
    assert!(!home.exists());
}

const PROJECT: &str = "11111111111111111111111111111111";
fn project(root: &Path) {
    fs::write(root.join(".kinic-learning.json"), json!({"version":2,"project_id":PROJECT,"enabled":true,"replica_host":"http://127.0.0.1:1","canister_id":"aaaaa-aa","database_id":"db","principal":"bound-caller","recall":{"namespace":format!("/Knowledge/projects/{PROJECT}"),"budget_tokens":1000},"runner":{"engine":"codex","executable":"/bin/false"}}).to_string()).unwrap();
}
fn tree(root: &Path) -> std::collections::BTreeMap<std::path::PathBuf, Vec<u8>> {
    fn collect(
        base: &Path,
        dir: &Path,
        out: &mut std::collections::BTreeMap<std::path::PathBuf, Vec<u8>>,
    ) {
        for entry in fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                collect(base, &path, out)
            } else {
                out.insert(
                    path.strip_prefix(base).unwrap().to_path_buf(),
                    fs::read(path).unwrap(),
                );
            }
        }
    }
    let mut out = std::collections::BTreeMap::new();
    collect(root, root, &mut out);
    out
}
fn seed_records(root: &Path, state: &Path) {
    use vfs_cli_app::learning::{Event, Outbox};
    let box_ = Outbox::open(state, "http://127.0.0.1:1:aaaaa-aa", "db", "bound-caller").unwrap();
    for (id, run, kind, payload) in [
        (
            "run-a",
            "run-a",
            "run",
            json!({"project_id":PROJECT,"repository":root,"task":"secret-task-value"}),
        ),
        (
            "context-a",
            "run-a",
            "context",
            json!({"project_id":PROJECT,"id":"receipt-a","rendered":"secret-context-value"}),
        ),
        (
            "record-a",
            "run-a",
            "observation",
            json!({"capture":"secret-transcript-value"}),
        ),
        (
            "run-b",
            "run-b",
            "run",
            json!({"project_id":"22222222222222222222222222222222","repository":"/other/project"}),
        ),
        ("record-b", "run-b", "observation", json!({})),
    ] {
        box_.enqueue(&Event {
            id: id.into(),
            run_id: run.into(),
            kind: kind.into(),
            payload,
        })
        .unwrap();
    }
    drop(box_);
    let db = rusqlite::Connection::open(state.join("learning-outbox.sqlite3")).unwrap();
    db.execute(
        "UPDATE learning_outbox SET acknowledged=1 WHERE id IN ('run-a','context-a')",
        [],
    )
    .unwrap();
    drop(db);
    let other = Outbox::open(state, "http://127.0.0.1:1:aaaaa-aa", "db", "other-caller").unwrap();
    other
        .enqueue(&Event {
            id: "other-caller".into(),
            run_id: "other-caller".into(),
            kind: "run".into(),
            payload: json!({"project_id":PROJECT,"repository":root}),
        })
        .unwrap();
}
#[test]
fn status_reads_only_selected_project_and_principal_without_exposing_payloads() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    project(root);
    let state = root.join("state");
    let home = root.join("home");
    seed_records(root, &state);
    let before = tree(root);
    let output = status(
        root,
        &home,
        &[
            "agent",
            "status",
            "--state-dir",
            state.to_str().unwrap(),
            "--json",
        ],
    );
    let raw = String::from_utf8_lossy(&output.stdout).to_string();
    let value = report(output);
    assert_eq!(value["records"]["status"], "observed");
    assert_eq!(value["records"]["pending_records"], 1);
    assert_eq!(value["records"]["acknowledged_records"], 2);
    assert_eq!(value["records"]["last_record"]["id"], "record-a");
    assert_eq!(value["context"]["receipt_id"], "receipt-a");
    assert_eq!(value["context"]["delivery"], "unverified");
    assert_eq!(value["context"]["adoption"], "unknown");
    assert!(value["records"]["last_record"]["observed_at"].is_null());
    for secret in [
        "secret-task-value",
        "secret-context-value",
        "secret-transcript-value",
        "record-b",
        "other-caller",
    ] {
        assert!(!raw.contains(secret), "leaked {secret}");
    }
    assert_eq!(
        tree(root),
        before,
        "status modified files or created sidecars"
    );
}
#[test]
fn status_reads_job_references_and_sanitizes_failure_reason() {
    use vfs_cli_app::learning::jobs::JobQueue;
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    project(root);
    let state = root.join("state");
    let home = root.join("home");
    let binding =
        serde_json::to_string(&("http://127.0.0.1:1:aaaaa-aa", Some("db"), "bound-caller"))
            .unwrap();
    let q = JobQueue::open(&state, &binding, PROJECT).unwrap();
    q.enqueue("job-a", root, &root.join(".kinic-learning.json"))
        .unwrap();
    let mut job = q.list().unwrap().remove(0);
    job.state = "retry".into();
    job.candidate_path = Some("/Sources/learning-candidates/candidate-a.json".into());
    job.evaluation_path = Some("/Sources/learning-evaluations/evaluation-a.json".into());
    job.error = Some("secret-job-error-value".into());
    q.save(&job).unwrap();
    q.enqueue("job-paused", root, &root.join(".kinic-learning.json"))
        .unwrap();
    let mut paused = q.list().unwrap().remove(1);
    paused.pause("evidence_missing");
    q.save(&paused).unwrap();
    drop(q);
    let before = tree(root);
    let output = status(
        root,
        &home,
        &[
            "agent",
            "status",
            "--state-dir",
            state.to_str().unwrap(),
            "--json",
        ],
    );
    let raw = String::from_utf8_lossy(&output.stdout).to_string();
    let value = report(output);
    assert_eq!(value["learning"]["jobs"][1]["state"], "retry");
    assert_eq!(
        value["learning"]["jobs"][1]["candidate_path"],
        "/Sources/learning-candidates/candidate-a.json"
    );
    assert_eq!(value["learning"]["jobs"][1]["reason_code"], "retry_pending");
    assert_eq!(value["learning"]["jobs"][0]["state"], "paused");
    assert_eq!(
        value["learning"]["jobs"][0]["reason_code"],
        "evidence_missing"
    );
    assert!(
        value["learning"]["jobs"][0]["next_action"]
            .as_str()
            .unwrap()
            .contains("evidence")
    );
    assert!(!raw.contains("secret-job-error-value"));
    assert_eq!(value["publication"]["status"], "unknown");
    assert_eq!(tree(root), before);
}
#[test]
fn corrupt_or_locked_outbox_does_not_suppress_configuration_or_other_sources() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    project(root);
    let state = root.join("state");
    let home = root.join("home");
    fs::create_dir(&state).unwrap();
    let dbpath = state.join("learning-outbox.sqlite3");
    fs::write(&dbpath, b"secret-database-error-value").unwrap();
    let before = tree(root);
    let value = report(status(
        root,
        &home,
        &[
            "agent",
            "status",
            "--state-dir",
            state.to_str().unwrap(),
            "--json",
        ],
    ));
    assert_eq!(value["records"]["status"], "unknown");
    assert_eq!(value["records"]["code"], "source_unreadable");
    assert_eq!(value["target"]["database_id"], "db");
    assert_eq!(tree(root), before);
    fs::remove_file(&dbpath).unwrap();
    seed_records(root, &state);
    let conn = rusqlite::Connection::open(&dbpath).unwrap();
    conn.execute_batch("PRAGMA journal_mode=DELETE;").unwrap();
    let before = tree(root);
    conn.execute_batch("BEGIN EXCLUSIVE").unwrap();
    let value = report(status(
        root,
        &home,
        &[
            "agent",
            "status",
            "--state-dir",
            state.to_str().unwrap(),
            "--json",
        ],
    ));
    assert_eq!(value["records"]["status"], "unknown");
    assert_eq!(tree(root), before);
    conn.execute_batch("ROLLBACK").unwrap();
}
#[test]
fn live_wal_is_reported_unavailable_without_touching_shared_memory() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    project(root);
    let state = root.join("state");
    let home = root.join("home");
    fs::create_dir(&state).unwrap();
    let conn = rusqlite::Connection::open(state.join("learning-outbox.sqlite3")).unwrap();
    conn.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE marker(id);")
        .unwrap();
    let before = tree(root);
    let value = report(status(
        root,
        &home,
        &[
            "agent",
            "status",
            "--state-dir",
            state.to_str().unwrap(),
            "--json",
        ],
    ));
    assert_eq!(value["records"]["code"], "active_wal_unverified");
    assert_eq!(tree(root), before);
    drop(conn);
}

#[test]
fn portable_target_override_is_reported_without_reading_the_bound_queue() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    project(root);
    let state = root.join("state");
    let home = root.join("home");
    seed_records(root, &state);
    let value = report(status(
        root,
        &home,
        &[
            "--database-id",
            "other-db",
            "agent",
            "status",
            "--state-dir",
            state.to_str().unwrap(),
            "--json",
        ],
    ));
    assert_eq!(value["target"]["binding"], "project_binding_mismatch");
    assert_eq!(value["records"]["status"], "unknown");
    assert!(value["records"]["pending_records"].is_null());
}
#[test]
fn explicit_project_file_and_state_path_keep_the_invocation_base_with_cwd() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    project(root);
    fs::create_dir(root.join("work")).unwrap();
    fs::rename(
        root.join(".kinic-learning.json"),
        root.join("external.json"),
    )
    .unwrap();
    let value = report(status(
        root,
        &root.join("home"),
        &[
            "agent",
            "status",
            "--cwd",
            "work",
            "--recall-config",
            "external.json",
            "--state-dir",
            "state",
            "--json",
        ],
    ));
    assert_eq!(value["target"]["project_id"], PROJECT);
    assert_eq!(value["target"]["database_id"], "db");
    assert_eq!(value["configuration"]["engines"], json!(["codex"]));
    assert!(
        value["records"]["source"]
            .as_str()
            .unwrap()
            .ends_with("/state/learning-outbox.sqlite3")
    );
    assert!(!root.join("state").exists());
}
#[test]
fn orphaned_events_do_not_become_a_false_zero_pending_count() {
    use vfs_cli_app::learning::{Event, Outbox};
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    project(root);
    let state = root.join("state");
    let home = root.join("home");
    let q = Outbox::open(&state, "http://127.0.0.1:1:aaaaa-aa", "db", "bound-caller").unwrap();
    q.enqueue(&Event {
        id: "orphan".into(),
        run_id: "unidentified-run".into(),
        kind: "observation".into(),
        payload: json!({}),
    })
    .unwrap();
    drop(q);
    let value = report(status(
        root,
        &home,
        &[
            "agent",
            "status",
            "--state-dir",
            state.to_str().unwrap(),
            "--json",
        ],
    ));
    assert_eq!(value["records"]["status"], "partial");
    assert!(value["records"]["pending_records"].is_null());
    assert_eq!(value["records"]["unattributed_records"], 1);
}
#[test]
fn malformed_configuration_returns_sanitized_partial_status() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let home = root.join("home");
    fs::create_dir(root.join(".kinic")).unwrap();
    fs::write(root.join(".kinic/config.toml"), "secret-parser-value = [").unwrap();
    let output = status(root, &home, &["agent", "status", "--json"]);
    assert!(!String::from_utf8_lossy(&output.stdout).contains("secret-parser-value"));
    let value = report(output);
    assert_eq!(value["configuration"]["status"], "unknown");
    assert!(!home.exists());
}

#[test]
fn current_cli_intake_is_separate_from_records_and_old_config_partitions() {
    use std::{io::Write, process::Stdio};
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    project(root);
    let state = root.join("state");
    let home = root.join("home");
    seed_records(root, &state);
    for engine in ["codex", "dsh"] {
        let mut child = Command::new(env!("CARGO_BIN_EXE_kinic-vfs-cli"))
            .args([
                "--identity-mode",
                "anonymous",
                "agent",
                "hook",
                "--engine",
                engine,
                "--state-dir",
            ])
            .arg(&state)
            .current_dir(root)
            .env_clear()
            .env("HOME", &home)
            .env("ICP_HOME", home.join("icp"))
            .env_remove("CODEX_HOME")
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
            .write_all(
                json!({"event":"Stop","cwd":root,"session_id":"pending-input","turn_id":"turn-a"})
                    .to_string()
                    .as_bytes(),
            )
            .unwrap();
        let result = child.wait_with_output().unwrap();
        assert!(!result.status.success());
        assert!(
            String::from_utf8_lossy(&result.stderr).contains("cannot run authenticated commands")
        );
    }
    let before = tree(root);
    let value = report(status(
        root,
        &home,
        &[
            "agent",
            "status",
            "--state-dir",
            state.to_str().unwrap(),
            "--json",
        ],
    ));
    assert_eq!(value["records"]["pending_records"], 1);
    assert_eq!(value["intake"]["per_engine"][0]["pending_inputs"], 1);
    let dsh = value["intake"]["per_engine"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["engine"] == "dsh")
        .expect("pending DSH intake was hidden because no DSH runner table exists");
    assert_eq!(dsh["pending_inputs"], 1);
    assert!(value["intake"]["combined_total"].is_null());
    assert_eq!(tree(root), before);
    fs::create_dir(root.join(".kinic")).unwrap();
    fs::write(
        root.join(".kinic/config.toml"),
        "[learning]\nbudget_tokens=1234\n",
    )
    .unwrap();
    let value = report(status(
        root,
        &home,
        &[
            "agent",
            "status",
            "--state-dir",
            state.to_str().unwrap(),
            "--json",
        ],
    ));
    assert_eq!(value["intake"]["per_engine"][0]["code"], "source_absent");
    assert!(value["intake"]["per_engine"][0]["pending_inputs"].is_null());
}
#[test]
fn human_status_displays_counts_receipt_and_uncertainty_in_readable_lines() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    project(root);
    let state = root.join("state");
    let home = root.join("home");
    seed_records(root, &state);
    let output = status(
        root,
        &home,
        &["agent", "status", "--state-dir", state.to_str().unwrap()],
    );
    assert!(output.status.success());
    let text = String::from_utf8_lossy(&output.stdout);
    for expected in [
        "Pending records: 1",
        "Receipt: receipt-a",
        "Delivery: unverified",
        "Publication: unknown",
    ] {
        assert!(text.contains(expected), "missing {expected}: {text}");
    }
}

#[test]
fn status_rejects_stdin_config_without_waiting_for_input() {
    use std::{
        process::Stdio,
        time::{Duration, Instant},
    };
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let mut child = Command::new(env!("CARGO_BIN_EXE_kinic-vfs-cli"))
        .args(["agent", "status", "--recall-config", "-", "--json"])
        .current_dir(root)
        .env("HOME", root.join("home"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let start = Instant::now();
    loop {
        if child.try_wait().unwrap().is_some() {
            break;
        }
        if start.elapsed() > Duration::from_secs(2) {
            child.kill().unwrap();
            let _ = child.wait();
            panic!("status waited for stdin");
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let value = report(child.wait_with_output().unwrap());
    assert_eq!(value["configuration"]["code"], "configuration_unavailable");
}

#[test]
fn readable_stored_identity_mismatch_withholds_project_records() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    project(root);
    let state = root.join("state");
    let home = root.join("home");
    seed_records(root, &state);
    stored_identity(&home);
    let before = tree(root);
    let output = status(
        root,
        &home,
        &[
            "--allow-non-ii-identity",
            "agent",
            "status",
            "--state-dir",
            state.to_str().unwrap(),
            "--json",
        ],
    );
    assert!(!String::from_utf8_lossy(&output.stdout).contains("PRIVATE KEY"));
    let value = report(output);
    assert_eq!(value["target"]["binding"], "project_binding_mismatch");
    assert_eq!(value["target"]["principal"], "bound-caller");
    assert_eq!(
        value["target"]["principal_basis"],
        "configured_project_compared_to_stored_identity"
    );
    assert_ne!(value["target"]["stored_principal"], "bound-caller");
    assert!(value["records"]["pending_records"].is_null());
    assert_eq!(tree(root), before);
}

#[test]
fn invalid_or_oversized_record_rows_preserve_partial_evidence_without_exact_totals() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    project(root);
    let state = root.join("state");
    let home = root.join("home");
    seed_records(root, &state);
    let conn = rusqlite::Connection::open(state.join("learning-outbox.sqlite3")).unwrap();
    for (id, body) in [
        ("bad", "secret-invalid-row".to_string()),
        ("large", "x".repeat(1048577)),
    ] {
        conn.execute("INSERT INTO learning_outbox(scope,id,body) SELECT scope,?1,?2 FROM learning_outbox WHERE id='record-a' LIMIT 1",rusqlite::params![id,body]).unwrap();
    }
    drop(conn);
    let before = tree(root);
    let output = status(
        root,
        &home,
        &[
            "agent",
            "status",
            "--state-dir",
            state.to_str().unwrap(),
            "--json",
        ],
    );
    assert!(!String::from_utf8_lossy(&output.stdout).contains("secret-invalid-row"));
    let value = report(output);
    assert_eq!(value["records"]["status"], "partial");
    assert!(value["records"]["pending_records"].is_null());
    assert_eq!(value["context"]["receipt_id"], "receipt-a");
    assert_eq!(tree(root), before);
}

fn stored_identity(home: &Path) -> String {
    const TEST_PEM: &str = "-----BEGIN EC PARAMETERS-----\nBgUrgQQACg==\n-----END EC PARAMETERS-----\n-----BEGIN EC PRIVATE KEY-----\nMHQCAQEEIAgy7nZEcVHkQ4Z1Kdqby8SwyAiyKDQmtbEHTIM+WNeBoAcGBSuBBAAK\noUQDQgAEgO87rJ1ozzdMvJyZQ+GABDqUxGLvgnAnTlcInV3NuhuPv4O3VGzMGzeB\nN3d26cRxD99TPtm8uo2OuzKhSiq6EQ==\n-----END EC PRIVATE KEY-----\n";
    let identity = home.join("icp/identity");
    fs::create_dir_all(identity.join("keys")).unwrap();
    fs::write(
        identity.join("identity_defaults.json"),
        r#"{"default":"fixture"}"#,
    )
    .unwrap();
    fs::write(
        identity.join("identity_list.json"),
        r#"{"v":1,"identities":{"fixture":{"kind":"pem"}}}"#,
    )
    .unwrap();
    fs::write(identity.join("keys/fixture.pem"), TEST_PEM).unwrap();
    vfs_client::identity_from_pem(TEST_PEM.as_bytes())
        .unwrap()
        .sender()
        .unwrap()
        .to_text()
}

#[test]
fn legacy_runs_from_subdirectories_belong_to_their_workspace_but_nested_projects_do_not() {
    use vfs_cli_app::learning::{Event, Outbox};
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let state = root.join("state");
    let home = root.join("home");
    let principal = stored_identity(&home);
    fs::create_dir(root.join(".kinic")).unwrap();
    fs::write(root.join(".kinic/config.toml"),"replica_host='http://127.0.0.1:1'\ncanister_id='aaaaa-aa'\ndatabase_id='db'\n[learning]\nbudget_tokens=1000\n").unwrap();
    let sub = root.join("src");
    let nested = root.join("nested");
    fs::create_dir(&sub).unwrap();
    fs::create_dir_all(nested.join(".kinic")).unwrap();
    fs::write(
        nested.join(".kinic/config.toml"),
        "[learning]\nbudget_tokens=1000\n",
    )
    .unwrap();
    let q = Outbox::open(&state, "http://127.0.0.1:1:aaaaa-aa", "db", &principal).unwrap();
    for (run, repository) in [("selected", sub), ("nested", nested)] {
        q.enqueue(&Event {
            id: format!("{run}-record"),
            run_id: run.into(),
            kind: "run".into(),
            payload: json!({"repository":repository}),
        })
        .unwrap();
        q.enqueue(&Event {
            id: format!("{run}-receipt"),
            run_id: run.into(),
            kind: "context".into(),
            payload: json!({"id":format!("{run}-receipt")}),
        })
        .unwrap();
    }
    drop(q);
    let value = report(status(
        root,
        &home,
        &[
            "--allow-non-ii-identity",
            "agent",
            "status",
            "--state-dir",
            state.to_str().unwrap(),
            "--json",
        ],
    ));
    assert_eq!(value["records"]["pending_records"], 2);
    assert_eq!(value["context"]["receipt_id"], "selected-receipt");
}
#[test]
fn oversized_toml_configuration_is_unavailable_without_parsing_or_leaking_it() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let home = root.join("home");
    fs::create_dir(root.join(".kinic")).unwrap();
    fs::write(
        root.join(".kinic/config.toml"),
        format!("#{}", "x".repeat(8 * 1024 * 1024)),
    )
    .unwrap();
    let value = report(status(root, &home, &["agent", "status", "--json"]));
    assert_eq!(value["configuration"]["code"], "configuration_unavailable");
    assert!(!home.exists());
}

#[cfg(unix)]
#[test]
fn fifo_configuration_is_rejected_without_opening_the_pipe() {
    use std::{
        process::Stdio,
        time::{Duration, Instant},
    };
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let fifo = root.join("config.json");
    assert!(
        Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .unwrap()
            .success()
    );
    let mut child = Command::new(env!("CARGO_BIN_EXE_kinic-vfs-cli"))
        .args(["agent", "status", "--json", "--recall-config"])
        .arg(&fifo)
        .current_dir(root)
        .env("HOME", root.join("home"))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let start = Instant::now();
    loop {
        if child.try_wait().unwrap().is_some() {
            break;
        }
        if start.elapsed() > Duration::from_secs(2) {
            child.kill().unwrap();
            let _ = child.wait();
            panic!("status opened a FIFO");
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let value = report(child.wait_with_output().unwrap());
    assert_eq!(value["configuration"]["status"], "unknown");
}
#[test]
fn inaccessible_intake_partition_preserves_the_other_engine_result() {
    use std::{io::Write, process::Stdio};
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    project(root);
    let home = root.join("home");
    let state = root.join("state");
    fs::create_dir(root.join(".kinic")).unwrap();
    fs::write(
        root.join(".kinic/config.toml"),
        "[agents.dsh]\nexecutable='/bin/false'\n",
    )
    .unwrap();
    for engine in ["codex", "dsh"] {
        let mut child = Command::new(env!("CARGO_BIN_EXE_kinic-vfs-cli"))
            .args([
                "--identity-mode",
                "anonymous",
                "agent",
                "hook",
                "--engine",
                engine,
                "--state-dir",
            ])
            .arg(&state)
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
            .write_all(
                json!({"event":"Stop","cwd":root,"session_id":engine,"turn_id":"turn"})
                    .to_string()
                    .as_bytes(),
            )
            .unwrap();
        assert!(!child.wait_with_output().unwrap().status.success());
    }
    let value = report(status(
        root,
        &home,
        &[
            "agent",
            "status",
            "--state-dir",
            state.to_str().unwrap(),
            "--json",
        ],
    ));
    let bad = Path::new(
        value["intake"]["per_engine"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["engine"] == "codex")
            .unwrap()["source"]
            .as_str()
            .unwrap(),
    );
    fs::rename(bad, bad.with_extension("backup")).unwrap();
    fs::write(bad, b"not a directory").unwrap();
    let value = report(status(
        root,
        &home,
        &[
            "agent",
            "status",
            "--state-dir",
            state.to_str().unwrap(),
            "--json",
        ],
    ));
    assert_eq!(value["intake"]["status"], "partial");
    let engines = value["intake"]["per_engine"].as_array().unwrap();
    let dsh = engines.iter().find(|e| e["engine"] == "dsh").unwrap();
    assert_eq!(dsh["pending_inputs"], 1);
    let codex = engines.iter().find(|e| e["engine"] == "codex").unwrap();
    assert_eq!(codex["code"], "source_unreadable");
}

#[test]
fn reused_run_id_across_projects_is_ambiguous_and_never_selects_the_other_receipt() {
    use vfs_cli_app::learning::{Event, Outbox};
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    project(root);
    let state = root.join("state");
    let home = root.join("home");
    let q = Outbox::open(&state, "http://127.0.0.1:1:aaaaa-aa", "db", "bound-caller").unwrap();
    for (id, pid) in [
        ("receipt-a", PROJECT),
        ("receipt-b", "22222222222222222222222222222222"),
    ] {
        q.enqueue(&Event {
            id: id.into(),
            run_id: "shared-custom-run".into(),
            kind: "context".into(),
            payload: json!({"project_id":pid,"id":id}),
        })
        .unwrap();
    }
    q.enqueue(&Event {
        id: "ambiguous-observation".into(),
        run_id: "shared-custom-run".into(),
        kind: "observation".into(),
        payload: json!({}),
    })
    .unwrap();
    drop(q);
    let before = tree(root);
    let output = status(
        root,
        &home,
        &[
            "agent",
            "status",
            "--state-dir",
            state.to_str().unwrap(),
            "--json",
        ],
    );
    assert!(!String::from_utf8_lossy(&output.stdout).contains("receipt-b"));
    let value = report(output);
    assert_eq!(value["records"]["status"], "partial");
    assert!(value["records"]["pending_records"].is_null());
    assert_eq!(value["records"]["unattributed_records"], 3);
    assert_eq!(value["context"]["status"], "unknown");
    assert_eq!(tree(root), before);
}
#[test]
fn unresolved_legacy_repository_is_unknown_instead_of_an_exact_zero() {
    use vfs_cli_app::learning::{Event, Outbox};
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let state = root.join("state");
    let home = root.join("home");
    let principal = stored_identity(&home);
    fs::create_dir(root.join(".kinic")).unwrap();
    fs::write(root.join(".kinic/config.toml"),"replica_host='http://127.0.0.1:1'\ncanister_id='aaaaa-aa'\ndatabase_id='db'\n[learning]\nbudget_tokens=1000\n").unwrap();
    let q = Outbox::open(&state, "http://127.0.0.1:1:aaaaa-aa", "db", &principal).unwrap();
    for (id, kind, payload) in [
        (
            "lost-run",
            "run",
            json!({"repository":root.join("moved-away")}),
        ),
        ("lost-result", "observation", json!({})),
    ] {
        q.enqueue(&Event {
            id: id.into(),
            run_id: "lost-run".into(),
            kind: kind.into(),
            payload,
        })
        .unwrap();
    }
    drop(q);
    let value = report(status(
        root,
        &home,
        &[
            "--allow-non-ii-identity",
            "agent",
            "status",
            "--state-dir",
            state.to_str().unwrap(),
            "--json",
        ],
    ));
    assert_eq!(value["records"]["status"], "partial");
    assert!(value["records"]["pending_records"].is_null());
    assert_eq!(value["records"]["unattributed_records"], 2);
}

#[test]
fn delivery_status_reports_persisted_failure_and_unknown_legacy_age_without_writes() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    project(root);
    let state = root.join("state");
    seed_records(root, &state);
    let db = rusqlite::Connection::open(state.join("learning-outbox.sqlite3")).unwrap();
    db.execute_batch("UPDATE learning_outbox SET enqueued_at=NULL WHERE id='record-a'; INSERT INTO learning_delivery(scope,last_failure_at,last_error_code) SELECT DISTINCT scope,'2026-10-16T00:00:00Z','delivery_failed' FROM learning_outbox;").unwrap();
    drop(db);
    let before = tree(root);
    let v = report(status(
        root,
        &root.join("home"),
        &[
            "agent",
            "status",
            "--state-dir",
            state.to_str().unwrap(),
            "--json",
        ],
    ));
    assert_eq!(v["records"]["last_send_failure"]["code"], "delivery_failed");
    assert_eq!(
        v["records"]["last_send_failure"]["at"],
        "2026-10-16T00:00:00Z"
    );
    assert!(v["records"]["oldest_pending_at"].is_null());
    assert_eq!(v["records"]["pending_time_unknown"], true);
    assert_eq!(before, tree(root));
}

#[test]
fn readiness_distinguishes_recall_from_portable_learning_and_hook_trust() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let home = root.join("home");
    fs::create_dir_all(root.join(".kinic")).unwrap();
    fs::write(
        root.join(".kinic/config.toml"),
        "[learning]\nbudget_tokens=1000\n[agents.codex]\nexecutable='/bin/false'\n",
    )
    .unwrap();
    fs::create_dir_all(home.join(".codex/plugins/kinic-skill-recorder/hooks")).unwrap();
    fs::write(
        home.join(".codex/plugins/kinic-skill-recorder/hooks/hooks.json"),
        "{}",
    )
    .unwrap();
    fs::write(
        home.join(".codex/config.toml"),
        "[plugins.\"kinic-skill-recorder@personal-plugins\"]\nenabled=true\n",
    )
    .unwrap();
    let before = tree(root);
    for command in ["status", "doctor"] {
        let output = status(root, &home, &["agent", command, "--json"]);
        let value: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(value["schema_version"], 1);
        assert_eq!(value["readiness"]["recall"]["status"], "ok");
        assert_eq!(
            value["readiness"]["automatic_learning"]["code"],
            "learning_project_missing"
        );
        assert!(
            value["readiness"]["automatic_learning"]["next_action"]
                .as_str()
                .unwrap()
                .contains("setup")
        );
        let engine = &value["readiness"]["engines"][0];
        assert_eq!(engine["placement"]["status"], "ok");
        assert_eq!(
            engine["plugin_enablement"]["code"],
            "plugin_enabled_in_config"
        );
        assert_eq!(engine["plugin_installation"]["status"], "unknown");
        assert_eq!(engine["hook_trust"]["status"], "unknown");
        assert_eq!(value["readiness"]["operation"]["status"], "unknown");
        if command == "doctor" {
            assert!(
                value["checks"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|c| c["id"] == "learning.project"
                        && c["code"] == "learning_project_missing")
            );
        }
    }
    assert_eq!(tree(root), before);
}

#[test]
fn readiness_reports_disabled_or_invalid_project_and_plugin_without_secret_excerpts() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let home = root.join("home");
    project(root);
    let path = root.join(".kinic-learning.json");
    let mut configured: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    configured["enabled"] = json!(false);
    fs::write(&path, configured.to_string()).unwrap();
    fs::create_dir_all(home.join(".codex")).unwrap();
    fs::write(
        home.join(".codex/config.toml"),
        "[plugins.\"kinic-skill-recorder@personal-plugins\"]\nenabled=false\n",
    )
    .unwrap();
    let value = report(status(root, &home, &["agent", "status", "--json"]));
    assert_eq!(
        value["readiness"]["automatic_learning"]["code"],
        "learning_project_disabled"
    );
    assert_eq!(
        value["readiness"]["engines"][0]["plugin_enablement"]["code"],
        "plugin_disabled_in_config"
    );
    fs::write(path, "{secret-malformed-project").unwrap();
    fs::write(home.join(".codex/config.toml"), "secret-malformed-config").unwrap();
    let output = status(root, &home, &["agent", "status", "--json"]);
    assert!(!String::from_utf8_lossy(&output.stdout).contains("secret-malformed"));
    let value = report(output);
    assert_eq!(
        value["readiness"]["automatic_learning"]["code"],
        "learning_project_invalid"
    );
}

#[test]
fn status_summary_uses_observed_delivery_outcome_without_claiming_context_delivery() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    project(root);
    let state = root.join("state");
    seed_records(root, &state);
    let path = state.join("learning-outbox.sqlite3");
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch("INSERT INTO learning_delivery(scope,last_attempt_at,last_success_at,last_failure_at,last_error_code) SELECT DISTINCT scope,'2026-10-16T02:00:00Z','2026-10-16T01:00:00Z','2026-10-16T02:00:00Z','delivery_failed' FROM learning_outbox;").unwrap();
    drop(db);
    let value = report(status(
        root,
        &root.join("home"),
        &[
            "agent",
            "status",
            "--state-dir",
            state.to_str().unwrap(),
            "--json",
        ],
    ));
    assert_eq!(value["summary"]["pending_events"], 1);
    assert_eq!(value["summary"]["latest_send"]["outcome"], "failure");
    assert_eq!(
        value["summary"]["last_context_delivered"]["status"],
        "unknown"
    );
    assert_eq!(
        value["summary"]["last_context_delivered"]["code"],
        "receipt_not_delivery_evidence"
    );
    assert_eq!(
        value["readiness"]["operation"]["code"],
        "local_records_observed"
    );
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch("UPDATE learning_delivery SET last_attempt_at='2026-10-16T03:00:00Z'")
        .unwrap();
    drop(db);
    let value = report(status(
        root,
        &root.join("home"),
        &[
            "agent",
            "status",
            "--state-dir",
            state.to_str().unwrap(),
            "--json",
        ],
    ));
    assert_eq!(value["summary"]["latest_send"]["outcome"], "unknown");
    assert_eq!(
        value["summary"]["latest_send"]["code"],
        "send_outcome_not_observed"
    );
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch("UPDATE learning_delivery SET last_attempt_at='2026-10-16T01:00:00Z',last_failure_at='invalid secret timestamp'").unwrap();
    drop(db);
    let value = report(status(
        root,
        &root.join("home"),
        &[
            "agent",
            "status",
            "--state-dir",
            state.to_str().unwrap(),
            "--json",
        ],
    ));
    assert_eq!(value["summary"]["latest_send"]["outcome"], "unknown");
    assert!(!value.to_string().contains("invalid secret timestamp"));
}

#[test]
fn keyring_diagnostics_explain_scoped_authorization_without_loading_credentials() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let home = root.join("home");
    project(root);
    let identity = home.join("icp/identity");
    fs::create_dir_all(&identity).unwrap();
    fs::write(
        identity.join("identity_defaults.json"),
        r#"{"default":"fixture"}"#,
    )
    .unwrap();
    fs::write(
        identity.join("identity_list.json"),
        r#"{"v":1,"identities":{"fixture":{"kind":"keyring"}}}"#,
    )
    .unwrap();
    for granted in [false, true] {
        if granted {
            vfs_cli_app::identity_policy::save(
                &home,
                &vfs_cli_app::identity_policy::Grant {
                    project_root: root.canonicalize().unwrap(),
                    replica_host: "http://127.0.0.1:1".into(),
                    canister_id: "aaaaa-aa".into(),
                    database_id: "db".into(),
                    identity_name: "fixture".into(),
                    principal: "bound-caller".into(),
                },
            )
            .unwrap();
        }
        let before = tree(root);
        for command in ["doctor", "status"] {
            let output = status(root, &home, &["agent", command, "--json"]);
            let value: Value = serde_json::from_slice(&output.stdout).unwrap();
            let check = &value["readiness"]["identity"];
            assert_eq!(check["status"], "unknown");
            assert_eq!(
                check["code"],
                if granted {
                    "keyring_access_unverified"
                } else {
                    "keyring_authorization_missing"
                }
            );
            assert!(check["next_action"].as_str().unwrap().contains(if granted {
                "agent recall"
            } else {
                "--authorize-keyring --apply"
            }));
            if command == "doctor" {
                assert!(
                    value["checks"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|c| c["id"] == "identity" && c["code"] == check["code"])
                );
            } else {
                assert!(value["target"]["stored_principal"].is_null());
            }
        }
        assert_eq!(tree(root), before);
    }
}

#[test]
fn doctor_placement_honors_selected_codex_home_consistently() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let home = root.join("home");
    fs::create_dir_all(home.join(".codex/plugins/kinic-skill-recorder/hooks")).unwrap();
    fs::write(
        home.join(".codex/plugins/kinic-skill-recorder/hooks/hooks.json"),
        "{}",
    )
    .unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_kinic-vfs-cli"))
        .args(["agent", "doctor", "--engine", "codex", "--json"])
        .current_dir(root)
        .env("HOME", &home)
        .env("ICP_HOME", home.join("icp"))
        .env("CODEX_HOME", root.join("selected-codex"))
        .env_remove("VFS_DATABASE_ID")
        .env_remove("VFS_CANISTER_ID")
        .env_remove("KINIC_LEARNING_CONFIG")
        .env_remove("KINIC_LEARNING_HOME")
        .output()
        .unwrap();
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        value["readiness"]["engines"][0]["placement"]["code"],
        "payload_missing"
    );
    assert!(
        value["checks"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["id"] == "engine.codex.placement" && c["code"] == "payload_missing")
    );
    assert!(!root.join("selected-codex").exists());
}

#[test]
fn writer_snapshot_reports_project_counts_with_live_wal_without_mutation() {
    use vfs_cli_app::learning::{Event, Outbox};
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    project(root);
    let state = root.join("state");
    let outbox = Outbox::open(&state, "http://127.0.0.1:1:aaaaa-aa", "db", "bound-caller").unwrap();
    for (id, run, payload) in [
        (
            "one",
            "run-one",
            json!({"project_id":PROJECT,"secret":"private payload"}),
        ),
        ("two", "run-one", json!({})),
        ("other", "run-other", json!({"project_id":"other-project"})),
    ] {
        outbox
            .enqueue(&Event {
                id: id.into(),
                run_id: run.into(),
                kind: "observation".into(),
                payload,
            })
            .unwrap();
    }
    assert!(state.join("learning-outbox.sqlite3-wal").exists());
    let before = tree(root);
    let value = report(status(
        root,
        &root.join("home"),
        &[
            "agent",
            "status",
            "--state-dir",
            state.to_str().unwrap(),
            "--json",
        ],
    ));
    assert_eq!(value["records"]["pending_records"], 2);
    assert_eq!(value["records"]["code"], "delivery_snapshot_read");
    assert_eq!(value["records"]["last_record"]["id"], "two");
    assert_eq!(
        value["summary"]["last_context_delivered"]["status"],
        "unknown"
    );
    assert_eq!(
        tree(root),
        before,
        "status must not mutate WAL, SHM or snapshot"
    );
    let snapshots: Vec<_> = fs::read_dir(&state)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|e| e == "json"))
        .collect();
    assert_eq!(snapshots.len(), 1);
    assert!(
        !fs::read_to_string(&snapshots[0])
            .unwrap()
            .contains("private payload")
    );
}

#[test]
fn delivery_snapshot_rejects_stale_mismatched_and_malformed_evidence() {
    use vfs_cli_app::learning::{Event, Outbox};
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    project(root);
    let state = root.join("state");
    let outbox = Outbox::open(&state, "http://127.0.0.1:1:aaaaa-aa", "db", "bound-caller").unwrap();
    outbox
        .enqueue(&Event {
            id: "one".into(),
            run_id: "run-one".into(),
            kind: "run".into(),
            payload: json!({"project_id":PROJECT}),
        })
        .unwrap();
    let path = fs::read_dir(&state)
        .unwrap()
        .map(|e| e.unwrap().path())
        .find(|p| p.extension().is_some_and(|e| e == "json"))
        .expect("writer snapshot");
    let original: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    let read = || {
        report(status(
            root,
            &root.join("home"),
            &[
                "agent",
                "status",
                "--state-dir",
                state.to_str().unwrap(),
                "--json",
            ],
        ))
    };
    for (name, field, replacement) in [
        ("wrong scope", "scope", json!("different")),
        (
            "wrong identity",
            "identity",
            json!(["another-endpoint", "db", "bound-caller"]),
        ),
        (
            "stale",
            "observed_at",
            json!((chrono::Utc::now() - chrono::Duration::seconds(301)).to_rfc3339()),
        ),
        (
            "future",
            "observed_at",
            json!((chrono::Utc::now() + chrono::Duration::seconds(31)).to_rfc3339()),
        ),
        (
            "bad timestamp",
            "observed_at",
            json!("private invalid timestamp"),
        ),
    ] {
        let mut changed = original.clone();
        changed[field] = replacement;
        fs::write(&path, changed.to_string()).unwrap();
        let before = tree(root);
        let value = read();
        assert_eq!(value["records"]["status"], "unknown", "{name}");
        assert!(value["records"]["pending_records"].is_null(), "{name}");
        assert_eq!(
            value["summary"]["latest_send"]["outcome"], "unknown",
            "{name}"
        );
        assert_eq!(tree(root), before, "{name}");
    }
    for bytes in [b"{\"version\":".to_vec(), vec![b' '; 1024 * 1024 + 1]] {
        fs::write(&path, bytes).unwrap();
        assert_eq!(read()["records"]["status"], "unknown");
    }
    #[cfg(unix)]
    {
        fs::remove_file(&path).unwrap();
        let target = root.join("untrusted.json");
        fs::write(&target, original.to_string()).unwrap();
        std::os::unix::fs::symlink(&target, &path).unwrap();
        assert_eq!(read()["records"]["status"], "unknown");
    }
}

#[test]
fn snapshot_never_broadens_unattributed_counts_or_trusts_superseded_success() {
    use vfs_cli_app::learning::{Event, Outbox};
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    project(root);
    let state = root.join("state");
    let outbox = Outbox::open(&state, "http://127.0.0.1:1:aaaaa-aa", "db", "bound-caller").unwrap();
    for (id, run, payload) in [
        ("target", "run-one", json!({"project_id":PROJECT})),
        ("orphan", "run-orphan", json!({})),
    ] {
        outbox
            .enqueue(&Event {
                id: id.into(),
                run_id: run.into(),
                kind: "run".into(),
                payload,
            })
            .unwrap();
    }
    let read = || {
        report(status(
            root,
            &root.join("home"),
            &[
                "agent",
                "status",
                "--state-dir",
                state.to_str().unwrap(),
                "--json",
            ],
        ))
    };
    let value = read();
    assert_eq!(value["records"]["status"], "partial");
    assert!(value["records"]["pending_records"].is_null());
    assert_eq!(value["records"]["unattributed_records"], 1);
    // A legacy/raw writer cannot leave a prior snapshot appearing current.
    let db = rusqlite::Connection::open(state.join("learning-outbox.sqlite3")).unwrap();
    db.execute_batch("INSERT INTO learning_delivery(scope,last_success_at) SELECT DISTINCT scope,'2026-01-01T00:00:00Z' FROM learning_outbox").unwrap();
    let value = read();
    assert_eq!(value["records"]["code"], "delivery_snapshot_superseded");
    assert!(value["records"]["pending_records"].is_null());
    assert_eq!(value["summary"]["latest_send"]["outcome"], "unknown");
}

#[cfg(unix)]
#[test]
fn failed_snapshot_refresh_preserves_enqueue_but_never_displays_prior_success() {
    use std::os::unix::fs::PermissionsExt;
    use vfs_cli_app::learning::{Event, Outbox};
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    project(root);
    let state = root.join("state");
    let outbox = Outbox::open(&state, "http://127.0.0.1:1:aaaaa-aa", "db", "bound-caller").unwrap();
    let event = |id: &str| Event {
        id: id.into(),
        run_id: "run-one".into(),
        kind: "run".into(),
        payload: json!({"project_id":PROJECT}),
    };
    outbox.enqueue(&event("one")).unwrap();
    let db = rusqlite::Connection::open(state.join("learning-outbox.sqlite3")).unwrap();
    db.execute_batch("INSERT INTO learning_delivery(scope,last_attempt_at,last_success_at) SELECT DISTINCT scope,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z' FROM learning_outbox").unwrap();
    outbox.enqueue(&event("two")).unwrap();
    let read = || {
        report(status(
            root,
            &root.join("home"),
            &[
                "agent",
                "status",
                "--state-dir",
                state.to_str().unwrap(),
                "--json",
            ],
        ))
    };
    assert_eq!(read()["summary"]["latest_send"]["outcome"], "success");
    // Existing SQLite WAL descriptors remain writable, while invalidating or
    // publishing the filesystem summary fails. The DB mutation must survive.
    fs::set_permissions(&state, fs::Permissions::from_mode(0o500)).unwrap();
    let result = outbox.enqueue(&event("three"));
    fs::set_permissions(&state, fs::Permissions::from_mode(0o700)).unwrap();
    result.unwrap();
    assert_eq!(outbox.pending_count().unwrap(), 3);
    let value = read();
    assert_eq!(value["records"]["status"], "unknown");
    assert_eq!(value["summary"]["latest_send"]["outcome"], "unknown");
    assert!(value["records"]["pending_records"].is_null());
}

#[test]
fn metadata_projection_counts_large_valid_bodies_in_closed_and_live_outbox() {
    use vfs_cli_app::learning::Outbox;
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    project(root);
    let state = root.join("state");
    drop(Outbox::open(&state, "http://127.0.0.1:1:aaaaa-aa", "db", "bound-caller").unwrap());
    let scope = vfs_cli_app::learning::hash(
        &json!(["http://127.0.0.1:1:aaaaa-aa", "db", "bound-caller"]).to_string(),
    );
    let db = rusqlite::Connection::open(state.join("learning-outbox.sqlite3")).unwrap();
    for i in 0..40 {
        let body = json!({"id":format!("event-{i}"),"run_id":if i<36 {"selected-run"} else {"other-run"},"kind":if i==35 {"context"} else {"run"},"payload":{"project_id":if i<36 {PROJECT} else {"other-project"},"repository":root,"id":"receipt-large","task":format!("private-large-task{}", "x".repeat(500_000))}}).to_string();
        db.execute(
            "INSERT INTO learning_outbox(scope,id,body,acknowledged) VALUES(?1,?2,?3,?4)",
            rusqlite::params![scope, format!("event-{i}"), body, i64::from(i < 6)],
        )
        .unwrap();
    }
    let total: i64 = db
        .query_row("SELECT SUM(length(body)) FROM learning_outbox", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert!(total > 16 * 1024 * 1024);
    drop(db);
    let read = || {
        report(status(
            root,
            &root.join("home"),
            &[
                "agent",
                "status",
                "--state-dir",
                state.to_str().unwrap(),
                "--json",
            ],
        ))
    };
    for live in [false, true] {
        let writer = live.then(|| {
            Outbox::open(&state, "http://127.0.0.1:1:aaaaa-aa", "db", "bound-caller").unwrap()
        });
        let value = read();
        assert_eq!(value["records"]["status"], "observed", "live={live}");
        assert_eq!(value["records"]["pending_records"], 30, "live={live}");
        assert_eq!(value["records"]["acknowledged_records"], 6, "live={live}");
        assert_eq!(value["context"]["receipt_id"], "receipt-large");
        assert!(!value.to_string().contains("private-large-task"));
        if live {
            assert_eq!(value["records"]["code"], "delivery_snapshot_read");
        }
        drop(writer);
    }
}

#[test]
fn metadata_projection_does_not_repair_invalid_or_ambiguous_event_fields() {
    use vfs_cli_app::learning::{Event, Outbox};
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    project(root);
    let state = root.join("state");
    let initial =
        Outbox::open(&state, "http://127.0.0.1:1:aaaaa-aa", "db", "bound-caller").unwrap();
    initial
        .enqueue(&Event {
            id: "valid".into(),
            run_id: "selected-run".into(),
            kind: "run".into(),
            payload: json!({"project_id":PROJECT}),
        })
        .unwrap();
    drop(initial);
    let scope = vfs_cli_app::learning::hash(
        &json!(["http://127.0.0.1:1:aaaaa-aa", "db", "bound-caller"]).to_string(),
    );
    let valid =
        json!({"id":"bad","run_id":"selected-run","kind":"run","payload":{"project_id":PROJECT}});
    let mut invalid = Vec::new();
    for (field, value) in [
        ("id", Value::Null),
        ("run_id", json!(17)),
        ("kind", json!({})),
    ] {
        let mut row = valid.clone();
        row[field] = value;
        invalid.push(row.to_string());
    }
    invalid.push("{truncated".into());
    invalid.push("[]".into());
    invalid.push(format!(r#"{{"id":"first","id":"last","run_id":"selected-run","kind":"run","payload":{{"project_id":"{PROJECT}"}}}}"#));
    invalid.push(format!(r#"{{"id":"bad","run_id":"selected-run","kind":"run","payload":{{"project_id":"{PROJECT}"}},"payload":{{}}}}"#));
    // Invalid ownership metadata must not fall back to a repository or inherit a known owner.
    invalid.push(json!({"id":"bad","run_id":"selected-run","kind":"run","payload":{"project_id":42,"repository":root}}).to_string());
    invalid.push(format!(r#"{{"id":"bad","run_id":"selected-run","kind":"run","payload":{{"project_id":"{PROJECT}","task":1e999}}}}"#));
    invalid.push(format!(r#"{{"id":"bad","run_id":"selected-run","kind":"run","payload":{{"project_id":"{PROJECT}","task":"\ud800"}}}}"#));
    invalid.push(format!(r#"{{"id":"bad","run_id":"selected-run","kind":"run","payload":{{"project_id":"{PROJECT}","task":{}0{}}}}}"#, "[".repeat(140),"]".repeat(140)));
    invalid.push(format!(r#"{{"id":"bad","run_id":"selected-run","kind":"run","payload":{{"project_id":"{PROJECT}","project_id":false}}}}"#));
    for value in [json!({"nested":PROJECT}), json!([PROJECT]), json!(false)] {
        invalid.push(
            json!({"id":"bad","run_id":"bad-run","kind":"run","payload":{"project_id":value}})
                .to_string(),
        );
    }
    for (index, body) in invalid.iter().enumerate() {
        let db = rusqlite::Connection::open(state.join("learning-outbox.sqlite3")).unwrap();
        db.execute("DELETE FROM learning_outbox WHERE id='bad'", [])
            .unwrap();
        db.execute(
            "INSERT INTO learning_outbox(scope,id,body) VALUES(?1,'bad',?2)",
            rusqlite::params![scope, body],
        )
        .unwrap();
        drop(db);
        for live in [false, true] {
            let writer = live.then(|| {
                Outbox::open(&state, "http://127.0.0.1:1:aaaaa-aa", "db", "bound-caller").unwrap()
            });
            let value = report(status(
                root,
                &root.join("home"),
                &[
                    "agent",
                    "status",
                    "--state-dir",
                    state.to_str().unwrap(),
                    "--json",
                ],
            ));
            assert_ne!(
                value["records"]["status"], "observed",
                "case={index}, live={live}"
            );
            assert!(
                value["records"]["pending_records"].is_null(),
                "case={index}, live={live}"
            );
            drop(writer);
        }
    }
    let db = rusqlite::Connection::open(state.join("learning-outbox.sqlite3")).unwrap();
    let body = format!(
        r#"{{"id":"last-wins","run_id":"selected-run","kind":"context","payload":{{"project_id":false,"project_id":"{PROJECT}","id":"first-receipt","id":"last-receipt"}}}}"#
    );
    db.execute("UPDATE learning_outbox SET body=?1 WHERE id='bad'", [body])
        .unwrap();
    drop(db);
    for live in [false, true] {
        let writer = live.then(|| {
            Outbox::open(&state, "http://127.0.0.1:1:aaaaa-aa", "db", "bound-caller").unwrap()
        });
        let value = report(status(
            root,
            &root.join("home"),
            &[
                "agent",
                "status",
                "--state-dir",
                state.to_str().unwrap(),
                "--json",
            ],
        ));
        assert_eq!(value["records"]["pending_records"], 2);
        assert_eq!(value["context"]["receipt_id"], "last-receipt");
        drop(writer);
    }
}

#[test]
fn send_failure_actions_distinguish_database_billing_canister_cycles_and_identity() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    project(root);
    let state = root.join("state");
    seed_records(root, &state);
    for (code, action) in [
        ("cycles_suspended", "database billing"),
        ("canister_cycles_frozen", "execution cycles"),
        ("identity_unavailable", "pinned identity"),
    ] {
        let db = rusqlite::Connection::open(state.join("learning-outbox.sqlite3")).unwrap();
        db.execute("INSERT INTO learning_delivery(scope,last_attempt_at,last_failure_at,last_error_code) SELECT DISTINCT scope,?1,?1,?2 FROM learning_outbox WHERE true ON CONFLICT(scope) DO UPDATE SET last_attempt_at=excluded.last_attempt_at,last_failure_at=excluded.last_failure_at,last_error_code=excluded.last_error_code",rusqlite::params![chrono::Utc::now().to_rfc3339(),code]).unwrap();
        drop(db);
        for live in [false, true] {
            let writer = live.then(|| {
                vfs_cli_app::learning::Outbox::open(
                    &state,
                    "http://127.0.0.1:1:aaaaa-aa",
                    "db",
                    "bound-caller",
                )
                .unwrap()
            });
            let value = report(status(
                root,
                &root.join("home"),
                &[
                    "agent",
                    "status",
                    "--state-dir",
                    state.to_str().unwrap(),
                    "--json",
                ],
            ));
            let send = &value["summary"]["latest_send"];
            assert_eq!(send["code"], "send_outcome_recorded");
            assert_eq!(send["outcome"], "failure");
            assert_eq!(send["failure_code"], code);
            assert!(
                send["next_action"].as_str().unwrap().contains(action),
                "{code}: {}",
                send["next_action"]
            );
            if code == "canister_cycles_frozen" {
                assert!(send["next_action"].as_str().unwrap().contains("ledger"));
            }
            drop(writer);
        }
    }
}
