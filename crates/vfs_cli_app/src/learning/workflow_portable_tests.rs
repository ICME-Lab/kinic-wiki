//! Portable product acceptance: actual CLI orchestration and SQLite storage;
//! only the external model process is replaced with a deterministic JSONL peer.
use super::*;
use crate::learning::integration_tests::StoreClient;
use crate::learning::project::{CONFIG_FILE, handle_project_command, load_project};

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

#[cfg(unix)]
async fn fixture() -> (tempfile::TempDir, StoreClient, StateArgs, PathBuf, PathBuf) {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let client = StoreClient::new(dir.path());
    let state = StateArgs {
        state_dir: Some(dir.path().join("state")),
        json: true,
    };
    let executable = dir.path().join("model-peer.py");
    std::fs::write(&executable, r#"#!/usr/bin/env python3
import json, os, re, sys
assert sys.argv[1:3] == ['exec', '--json']
assert '--sandbox' in sys.argv and sys.argv[sys.argv.index('--sandbox')+1] == 'read-only'
prompt = sys.stdin.read()
match = re.search(r'New target path under (\S+)\. Preserve', prompt)
assert match, prompt
proposal = {'operation':'new','rationale':'Recorded project work supplies an observation; validation is still required.',
 'targets':[{'path':match.group(1)+'portable.md','kind':'File','content':'portable lesson for '+os.path.basename(os.getcwd()),
 'metadata_json':json.dumps({'authority':'agent'}),'expected_etag':None}], 'dependency_paths':[]}
print(json.dumps({'type':'item.completed','item':{'type':'agent_message','text':json.dumps(proposal)}}))
print(json.dumps({'type':'turn.completed','usage':{'input_tokens':10,'output_tokens':10}}))
"#).unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
    let runner = dir.path().join("runner.json");
    let config = RunnerConfig {
        executable,
        ..RunnerConfig::default()
    };
    std::fs::write(&runner, serde_json::to_vec(&config).unwrap()).unwrap();
    let a = dir.path().join("unrelated-a");
    let b = dir.path().join("unrelated-b");
    for root in [&a, &b] {
        std::fs::create_dir(root).unwrap();
        handle_project_command(
            &client,
            &connection(),
            &LearnCommand::Setup {
                project_root: root.clone(),
                runner_file: runner.clone(),
                validation_suite: None,
                shared_scope: vec!["/Knowledge/shared".into()],
                state: state.clone(),
            },
        )
        .await
        .unwrap();
    }
    client
        .mkdir_node(MkdirNodeRequest {
            database_id: "db".into(),
            path: "/Knowledge/shared".into(),
        })
        .await
        .unwrap();
    for root in [&a, &b] {
        let project = load_project(&root.join(CONFIG_FILE)).unwrap();
        client
            .write_node(WriteNodeRequest {
                database_id: "db".into(),
                path: format!("{}/prior.md", project.knowledge_scope()),
                kind: NodeKind::File,
                content: format!(
                    "portable build advice for {}",
                    root.file_name().unwrap().to_string_lossy()
                ),
                metadata_json: "{\"authority\":\"agent\"}".into(),
                expected_etag: None,
            })
            .await
            .unwrap();
    }
    (dir, client, state, a, b)
}

#[cfg(unix)]
#[tokio::test]
async fn revision_startup_failure_reports_safe_reason_and_stays_paused() {
    for (stderr, initialization) in [
        (
            "Error: failed to initialize in-process app-server client: SECRET_TOKEN",
            true,
        ),
        ("Operation not permitted: SECRET_TOKEN", false),
    ] {
        let (dir, client, state, root, _) = fixture().await;
        std::fs::write(dir.path().join("model-peer.py"), format!(
            "#!/usr/bin/env python3\nimport sys\nsys.stdin.read()\nwith open('starts', 'a') as f: f.write('1')\nsys.stderr.write({stderr:?})\nsys.exit(1)\n"
        )).unwrap();
        let c = connection();
        let receipt = hooks::handle(
            &client,
            &c,
            "codex",
            None,
            &state,
            json!({
                "cwd":root,"session_id":"diagnostic","turn_id":"one",
                "event":"UserPromptSubmit","prompt":"portable build"
            }),
        )
        .await
        .unwrap();
        hooks::handle(
            &client,
            &c,
            "codex",
            None,
            &state,
            json!({
                "cwd":root,"session_id":"diagnostic","turn_id":"one",
                "event":"Stop","tool_results":[{"exit_code":0,"output":"test passed"}]
            }),
        )
        .await
        .unwrap();
        let error = job_driver::drain_selected(
            &client,
            &c,
            &root,
            &state,
            None,
            false,
            &job_driver::DrainSelection {
                run_id: Some(receipt["run_id"].as_str().unwrap().into()),
                max_jobs: None,
            },
        )
        .await
        .unwrap_err();
        let project = load_project(&root.join(CONFIG_FILE)).unwrap();
        let q = job_driver::queue(&client, &c, &state, &project).unwrap();
        let job = q.list().unwrap().remove(0);
        assert_eq!(job.state, "paused");
        for message in [format!("{error:#}"), job.error.unwrap()] {
            assert!(message.contains("process_exit:1"), "{message}");
            assert_eq!(
                message.contains("Codex initialization failed"),
                initialization,
                "{message}"
            );
            assert!(!message.contains("SECRET_TOKEN"), "{message}");
            assert!(!message.contains("installation_id"), "{message}");
        }
        let _ = job_driver::drain(&client, &c, &root, &state).await;
        assert_eq!(std::fs::read_to_string(root.join("starts")).unwrap(), "1");
    }
}

#[cfg(unix)]
#[tokio::test]
async fn portable_hooks_and_finite_jobs_keep_unrelated_projects_separate() {
    let (_dir, client, state, a, b) = fixture().await;
    let c = connection();
    let mut runs = vec![];
    for (root, engine, own, other) in [
        (&a, "codex", "unrelated-a", "unrelated-b"),
        (&b, "dsh", "unrelated-b", "unrelated-a"),
    ] {
        let request = json!({"cwd":root,"session_id":"same-session","turn_id":"same-turn","event":"UserPromptSubmit","prompt":"portable build"});
        let response = hooks::handle(&client, &c, engine, None, &state, request)
            .await
            .unwrap();
        let context = response["additionalContext"].as_str().unwrap();
        assert!(context.contains(own));
        assert!(!context.contains(other));
        let run = response["run_id"].as_str().unwrap().to_string();
        runs.push(run.clone());
        let stop = json!({"cwd":root,"session_id":"same-session","turn_id":"same-turn","event":"Stop","tool_results":[{"exit_code":0,"output":"portable external test passed"}]});
        let terminal = hooks::handle(&client, &c, engine, None, &state, stop.clone())
            .await
            .unwrap();
        assert_eq!(terminal["run_id"], run);
        assert_eq!(terminal["queued"], true);
        hooks::handle(&client, &c, engine, None, &state, stop)
            .await
            .unwrap();
        let project = load_project(&root.join(CONFIG_FILE)).unwrap();
        let queue = job_driver::queue(&client, &c, &state, &project).unwrap();
        assert_eq!(
            queue.list().unwrap().len(),
            1,
            "duplicate terminal event must not duplicate work"
        );
        assert_eq!(queue.list().unwrap()[0].run_id, run);
        let result = job_driver::drain(&client, &c, root, &state).await.unwrap();
        assert_eq!(result["jobs"][0]["state"], "candidate", "{result}");
        assert!(
            result["jobs"][0]["error"]
                .as_str()
                .unwrap()
                .contains("validation suite not configured")
        );
        let candidate_path = result["jobs"][0]["candidate_path"].as_str().unwrap();
        let candidate: RevisionCandidate =
            remote_json(&client, "db", candidate_path).await.unwrap();
        assert_eq!(
            candidate.project_id.as_deref(),
            Some(project.project_id.as_str())
        );
        assert!(candidate.targets[0].content.contains(own));
        assert!(
            client
                .read_node("db", &candidate.targets[0].path)
                .await
                .unwrap()
                .is_none(),
            "a successful model process alone must not publish"
        );
        // Restart reads the existing immutable candidate instead of duplicating it.
        let repeated = job_driver::drain(&client, &c, root, &state).await.unwrap();
        assert_eq!(repeated["jobs"][0]["candidate_path"], candidate_path);
        let opts = load_recall(
            &root.join(CONFIG_FILE),
            "portable",
            &client,
            &c,
            &state,
            root,
            None,
        )
        .unwrap();
        let preview = recall_overlay(&client, "db", "preview", &opts, &candidate.targets)
            .await
            .unwrap();
        assert!(
            preview
                .supplied
                .iter()
                .any(|n| n.content.contains(&format!("portable lesson for {own}")))
        );
    }
    assert_ne!(
        runs[0], runs[1],
        "same external session/turn cannot merge projects"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn portable_candidates_cannot_cross_write_and_disable_preserves_pending_jobs() {
    let (_dir, client, state, a, b) = fixture().await;
    let c = connection();
    let project_a = load_project(&a.join(CONFIG_FILE)).unwrap();
    let project_b = load_project(&b.join(CONFIG_FILE)).unwrap();
    let mut candidate = RevisionCandidate {
        project_id: Some(project_a.project_id.clone()),
        historical_evidence: vec![],
        id: "candidate".into(),
        source_run: "run".into(),
        operation: "new".into(),
        rationale: "test boundary".into(),
        targets: vec![WriteNodeItem {
            path: format!("{}/lesson.md", project_a.knowledge_scope()),
            kind: NodeKind::File,
            content: "portable".into(),
            metadata_json: "{\"authority\":\"agent\"}".into(),
            expected_etag: None,
        }],
        evidence: vec![],
        baseline: vec![],
        dependency_paths: vec![],
    };
    validate_project_candidate(&client, &c, &a, &candidate).unwrap();
    assert!(validate_project_candidate(&client, &c, &b, &candidate).is_err());
    for path in [
        format!("{}/lesson.md", project_b.knowledge_scope()),
        "/Knowledge/shared/lesson.md".into(),
    ] {
        candidate.targets[0].path = path;
        assert!(validate_project_candidate(&client, &c, &a, &candidate).is_err());
    }
    candidate.targets[0].path = "/Knowledge/shared/lesson.md".into();
    assert!(validate_staged_candidate(&client, &c, &a, &candidate).unwrap());
    assert!(validate_project_candidate(&client, &c, &a, &candidate).is_err());
    candidate.project_id = None;
    assert!(validate_project_candidate(&client, &c, &a, &candidate).is_err());
    candidate.project_id = Some(project_a.project_id.clone());
    candidate.targets[0].path = format!("{}/../foreign.md", project_a.knowledge_scope());
    assert!(validate_project_candidate(&client, &c, &a, &candidate).is_err());
    candidate.targets[0].path = format!("{}/lesson.md", project_a.knowledge_scope());
    candidate.dependency_paths = vec![format!("{}/dependent.md", project_b.knowledge_scope())];
    assert!(validate_project_candidate(&client, &c, &a, &candidate).is_err());
    let queue = job_driver::queue(&client, &c, &state, &project_a).unwrap();
    job_driver::enqueue(
        &client,
        &c,
        &state,
        &project_a,
        "pending-before-disable",
        &a,
        &a.join(CONFIG_FILE),
    )
    .unwrap();
    handle_project_command(
        &client,
        &c,
        &LearnCommand::Disable {
            project_root: a.clone(),
            state: state.clone(),
        },
    )
    .await
    .unwrap();
    let disabled = load_project(&a.join(CONFIG_FILE)).unwrap();
    job_driver::enqueue(
        &client,
        &c,
        &state,
        &disabled,
        "after-disable",
        &a,
        &a.join(CONFIG_FILE),
    )
    .unwrap();
    let stopped = hooks::handle(
        &client,
        &c,
        "codex",
        None,
        &state,
        json!({"cwd":a,"session_id":"disabled-session","turn_id":"disabled-turn","event":"Stop"}),
    )
    .await
    .unwrap();
    assert_eq!(stopped["queued"], false);
    let result = job_driver::drain(&client, &c, &a, &state).await.unwrap();
    assert_eq!(result["disabled"], true);
    assert_eq!(queue.list().unwrap().len(), 1);
    assert_eq!(queue.list().unwrap()[0].state, "pending");
    assert!(queue.list().unwrap()[0].candidate_path.is_none());
    assert!(
        job_driver::queue(&client, &c, &state, &project_b)
            .unwrap()
            .list()
            .unwrap()
            .is_empty()
    );
}

#[cfg(unix)]
#[tokio::test]
async fn offline_inbox_binds_explicit_config_engine_and_original_run_before_replay() {
    let (_dir, client, state, a, b) = fixture().await;
    let c = connection();
    let request = json!({"event":"UserPromptSubmit","cwd":a,"session_id":"same-session","prompt":"portable task"});
    let first = hooks::spool(&c, &state, "codex", Some(a.join(CONFIG_FILE)), &request).unwrap();
    let second = hooks::spool(&c, &state, "codex", Some(a.join(CONFIG_FILE)), &request).unwrap();
    let other = hooks::spool(&c, &state, "codex", Some(b.join(CONFIG_FILE)), &request).unwrap();
    let engine = hooks::spool(&c, &state, "dsh", Some(a.join(CONFIG_FILE)), &request).unwrap();
    assert_ne!(first.parent(), other.parent());
    assert_ne!(first.parent(), engine.parent());
    let one: Value = read_json(&first).unwrap();
    let two: Value = read_json(&second).unwrap();
    assert_ne!(one["__kinic_run_id"], two["__kinic_run_id"]);
    let stop = json!({"event":"Stop","cwd":a,"session_id":"same-session","terminal":true});
    let terminal = hooks::spool(&c, &state, "codex", Some(a.join(CONFIG_FILE)), &stop).unwrap();
    let terminal_value: Value = read_json(&terminal).unwrap();
    assert_eq!(terminal_value["__kinic_run_id"], two["__kinic_run_id"]);
    // Replay missed prompt evidence, preserving its own reserved identity and
    // never writing a context receipt that the external agent did not receive.
    hooks::replay(
        &client,
        &c,
        "codex",
        Some(a.join(CONFIG_FILE)),
        &state,
        &terminal,
    )
    .await
    .unwrap();
    // Hooks only enqueue; the detached flusher sends the backlog.
    open_outbox(&client, &c, &state)
        .unwrap()
        .flush_exclusive(&client, "db")
        .await
        .unwrap();
    for run in [
        one["__kinic_run_id"].as_str().unwrap(),
        two["__kinic_run_id"].as_str().unwrap(),
    ] {
        let entries = client
            .list_nodes(ListNodesRequest {
                database_id: "db".into(),
                prefix: format!("/Sources/learning-runs/{}", hash(run)),
                recursive: true,
                limit: 100,
            })
            .await
            .unwrap();
        assert!(!entries.is_empty());
        for entry in entries {
            if entry.path.ends_with(".json") {
                let value: Event = remote_json(&client, "db", &entry.path).await.unwrap();
                assert_ne!(value.kind, "context");
                assert_eq!(value.payload["capture"]["missing_recall"], true);
            }
        }
    }
    assert!(other.exists());
    assert!(engine.exists());
}

#[cfg(unix)]
#[tokio::test]
async fn dsh_setup_accepts_portable_project_config_without_identity_or_profile_edits() {
    let (dir, _client, _state, a, _b) = fixture().await;
    let output = dir.path().join("installed-dsh-plugin");
    crate::agent_setup::prepare(
        &SetupArgs {
            engine: "dsh".into(),
            executable: Some("dsh".into()),
            output: Some(output.clone()),
            recall_config: Some(a.join(CONFIG_FILE)),
            json: true,
            ..Default::default()
        },
        &a,
        &dir.path().join("home"),
    )
    .unwrap();
    assert!(output.join("index.js").exists());
    assert!(output.join("index.d.ts").exists());
    let patch = std::fs::read_to_string(output.join("kinic-learning.patch.yml")).unwrap();
    assert!(patch.contains(a.join(CONFIG_FILE).to_str().unwrap()));
}

#[cfg(unix)]
#[tokio::test]
async fn private_publication_and_rollback_reach_next_recall_without_cross_project_writes() {
    let (_dir, client, state, a, b) = fixture().await;
    let c = connection();
    let project = load_project(&a.join(CONFIG_FILE)).unwrap();
    let target = format!("{}/prior.md", project.knowledge_scope());
    let original = client.read_node("db", &target).await.unwrap().unwrap();
    let source = reference(&client, "db", &target).await.unwrap();
    let candidate = RevisionCandidate {
        project_id: Some(project.project_id.clone()),
        historical_evidence: vec![source.clone()],
        id: "private-publish".into(),
        source_run: "run".into(),
        operation: "correct".into(),
        rationale: "attested publication boundary fixture".into(),
        targets: vec![WriteNodeItem {
            path: target.clone(),
            kind: NodeKind::File,
            content: "portable revisedmarker advice".into(),
            metadata_json: original.metadata_json.clone(),
            expected_etag: Some(original.etag.clone()),
        }],
        evidence: vec![source.clone()],
        baseline: vec![original.clone()],
        dependency_paths: vec![],
    };
    let fingerprint = candidate.fingerprint().unwrap();
    let candidate_path = format!("/Sources/learning-candidates/{fingerprint}.json");
    write_immutable(
        &client,
        "db",
        &candidate_path,
        &serde_json::to_string(&candidate).unwrap(),
    )
    .await
    .unwrap();
    // Use an explicitly signed fixture intent to isolate publication from model
    // statistics. Evaluation generation/attestation is tested separately.
    let evaluation_path = "/Sources/learning-evaluations/private-fixture.json".to_string();
    let mut intent = PublicationIntent {
        candidate: candidate.clone(),
        request: LearningPublicationRequest {
            database_id: "db".into(),
            operation_id: fingerprint.clone(),
            targets: candidate.targets.clone(),
            evidence: vec![source],
            scope_guards: vec![],
        },
        evaluation_path: evaluation_path.clone(),
        preimages: vec![original.clone()],
        attestation: String::new(),
    };
    intent.attestation = attest(&intent, &state_root(&state).unwrap(), &c, &client).unwrap();
    write_immutable(
        &client,
        "db",
        &publication_intent_path(&fingerprint, &evaluation_path),
        &serde_json::to_string(&intent).unwrap(),
    )
    .await
    .unwrap();
    let published = promote_candidate(&client, &c, candidate_path, evaluation_path, &state, &a)
        .await
        .unwrap();
    let opts = load_recall(
        &a.join(CONFIG_FILE),
        "portable revisedmarker",
        &client,
        &c,
        &state,
        &a,
        None,
    )
    .unwrap();
    assert!(
        recall(&client, "db", "next", &opts)
            .await
            .unwrap()
            .rendered
            .contains("revisedmarker")
    );
    let publication_path = published["publication_path"].as_str().unwrap().to_string();
    assert!(
        learn_value(
            &client,
            &c,
            LearnCommand::Rollback {
                publication_path: publication_path.clone(),
                state: state.clone()
            },
            &b
        )
        .await
        .is_err()
    );
    assert!(
        client
            .read_node("db", &target)
            .await
            .unwrap()
            .unwrap()
            .content
            .contains("revisedmarker")
    );
    learn_value(
        &client,
        &c,
        LearnCommand::Rollback {
            publication_path,
            state: state.clone(),
        },
        &a,
    )
    .await
    .unwrap();
    assert_eq!(
        client
            .read_node("db", &target)
            .await
            .unwrap()
            .unwrap()
            .content,
        original.content
    );
    assert!(
        !recall(&client, "db", "after-rollback", &opts)
            .await
            .unwrap()
            .rendered
            .contains("revisedmarker")
    );
}

#[cfg(unix)]
#[tokio::test]
async fn shared_toml_runtime_settings_preserve_portable_scopes_and_partition_inbox() {
    let (_dir, client, state, a, _b) = fixture().await;
    let project = load_project(&a.join(CONFIG_FILE)).unwrap();
    let settings = a.join(".kinic/config.toml");
    std::fs::create_dir_all(settings.parent().unwrap()).unwrap();
    std::fs::write(&settings, "[learning]\nbudget_tokens=2222\n").unwrap();
    let options = load_recall_optional(
        None,
        "portable build",
        &client,
        &connection(),
        &state,
        &a,
        None,
    )
    .unwrap();
    assert_eq!(options.budget_tokens, 2222);
    assert_eq!(
        options.project_id.as_deref(),
        Some(project.project_id.as_str())
    );
    assert_eq!(options.read_scopes, project.recall_scopes());
    let request = json!({"cwd":a,"session_id":"shared-config","turn_id":"one","event":"recall","task":"portable build"});
    let first = hooks::spool(&connection(), &state, "codex", None, &request).unwrap();
    std::fs::write(&settings, "[learning]\nbudget_tokens=3333\n").unwrap();
    let second = hooks::spool(&connection(), &state, "codex", None, &request).unwrap();
    assert_ne!(
        first.parent(),
        second.parent(),
        "runtime-setting changes must partition pending intake"
    );
    let reply = hooks::handle(&client, &connection(), "codex", None, &state, request)
        .await
        .unwrap();
    let context = reply["additionalContext"].as_str().unwrap();
    assert!(context.contains("unrelated-a"));
    assert!(!context.contains("unrelated-b"));
}

#[cfg(unix)]
#[tokio::test]
async fn review_fix_replay_keeps_original_transcript_snapshot() {
    let (dir, client, state, a, _b) = fixture().await;
    let c = connection();
    let config = a.join(CONFIG_FILE);
    let log = dir.path().join("changing-session.jsonl");
    let first = format!(
        "{}\n{}\n",
        json!({"payload":{"type":"user_message","message":"original-task-A"}}),
        json!({"payload":{"role":"assistant","content":"result-A"}})
    );
    std::fs::write(&log, &first).unwrap();
    let request = json!({"event":"Stop","cwd":a,"session_id":"snapshot-session","turn_id":"1","transcript_path":log});
    let saved = hooks::spool(&c, &state, "codex", Some(config.clone()), &request).unwrap();
    let original: Value = read_json(&saved).unwrap();
    std::fs::write(
        &log,
        format!(
            "{first}{}\n{}\n",
            json!({"payload":{"type":"user_message","message":"new-task-B"}}),
            json!({"payload":{"role":"assistant","content":"result-B"}})
        ),
    )
    .unwrap();
    let current = hooks::spool(
        &c,
        &state,
        "codex",
        Some(config.clone()),
        &json!({"event":"PostToolUse","cwd":a,"session_id":"snapshot-session","turn_id":"2"}),
    )
    .unwrap();
    hooks::replay(&client, &c, "codex", Some(config), &state, &current)
        .await
        .unwrap();
    // Hooks only enqueue; the detached flusher sends the backlog.
    open_outbox(&client, &c, &state)
        .unwrap()
        .flush_exclusive(&client, "db")
        .await
        .unwrap();
    let run = original["__kinic_run_id"].as_str().unwrap();
    let entries = client
        .list_nodes(ListNodesRequest {
            database_id: "db".into(),
            prefix: format!("/Sources/learning-runs/{}", hash(run)),
            recursive: true,
            limit: 100,
        })
        .await
        .unwrap();
    let mut saw = false;
    for entry in entries {
        if entry.path.ends_with(".json") {
            let event: Event = remote_json(&client, "db", &entry.path).await.unwrap();
            let records = event.payload["capture"]["session_evidence"]["records"].to_string();
            assert!(records.contains("original-task-A"), "{records}");
            assert!(!records.contains("new-task-B"));
            saw = true;
        }
    }
    assert!(saw);
}

#[cfg(unix)]
#[tokio::test]
async fn review_fix_evaluation_rejects_another_projects_recall_before_running_suite() {
    let (_dir, client, state, a, b) = fixture().await;
    let c = connection();
    let project = load_project(&a.join(CONFIG_FILE)).unwrap();
    let target = format!("{}/prior.md", project.knowledge_scope());
    let node = client.read_node("db", &target).await.unwrap().unwrap();
    let source = reference(&client, "db", &target).await.unwrap();
    let candidate = RevisionCandidate {
        project_id: Some(project.project_id.clone()),
        historical_evidence: vec![source.clone()],
        id: "mismatched-evaluation".into(),
        source_run: "run".into(),
        operation: "correct".into(),
        rationale: "test".into(),
        targets: vec![WriteNodeItem {
            path: target,
            kind: NodeKind::File,
            content: "revised".into(),
            metadata_json: node.metadata_json.clone(),
            expected_etag: Some(node.etag.clone()),
        }],
        evidence: vec![source],
        baseline: vec![node],
        dependency_paths: vec![],
    };
    let candidate_path = format!(
        "/Sources/learning-candidates/{}.json",
        candidate.fingerprint().unwrap()
    );
    write_immutable(
        &client,
        "db",
        &candidate_path,
        &serde_json::to_string(&candidate).unwrap(),
    )
    .await
    .unwrap();
    let error = learn_value(
        &client,
        &c,
        LearnCommand::Evaluate {
            no_auto_promote: true,
            candidate_path,
            suite: a.join("must-not-open-suite"),
            runner_file: a.join("must-not-run-agent"),
            recall_config: b.join(CONFIG_FILE),
            output: a.join("must-not-write-output"),
            trials: 3,
            state,
        },
        &a,
    )
    .await
    .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("evaluation recall project differs"),
        "{error:#}"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn review_fix_external_config_flows_from_hook_to_job_processing() {
    let (dir, client, state, a, _b) = fixture().await;
    let c = connection();
    let external = dir.path().join("external-project.json");
    std::fs::rename(a.join(CONFIG_FILE), &external).unwrap();
    assert!(discover_config(&a).unwrap().is_none());
    let recalled=hooks::handle(&client,&c,"codex",Some(external.clone()),&state,json!({"event":"UserPromptSubmit","cwd":a,"session_id":"external-config","turn_id":"1","prompt":"portable advice"})).await.unwrap();
    assert!(!recalled["additionalContext"].as_str().unwrap().is_empty());
    hooks::handle(
        &client,
        &c,
        "codex",
        Some(external.clone()),
        &state,
        json!({"event":"Stop","cwd":a,"session_id":"external-config","turn_id":"1"}),
    )
    .await
    .unwrap();
    let result = learn_value(
        &client,
        &c,
        LearnCommand::Drain {
            run_id: None,
            max_jobs: None,
            require_wakeup: false,
            project_root: a.clone(),
            recall_config: Some(external.clone()),
            state: state.clone(),
        },
        &a,
    )
    .await
    .unwrap();
    assert_eq!(result["jobs"][0]["state"], "candidate", "{result}");
    assert_eq!(
        result["jobs"][0]["config_path"],
        json!(external.canonicalize().unwrap())
    );
}

#[cfg(unix)]
#[tokio::test]
async fn status_and_drain_use_target_project_state_outside_project() {
    let (_dir, client, _state, a, b) = fixture().await;
    let c = connection();
    for root in [&a, &b] {
        std::fs::create_dir(root.join(".kinic")).unwrap();
        std::fs::write(
            root.join(".kinic/config.toml"),
            "[learning]\nstate_dir='state'\n",
        )
        .unwrap();
        let state = StateArgs {
            state_dir: Some(root.join(".kinic/state")),
            json: true,
        };
        hooks::handle(&client,&c,"codex",None,&state,json!({"event":"UserPromptSubmit","cwd":root,"session_id":"target-job","turn_id":"1","prompt":"portable advice"})).await.unwrap();
        hooks::handle(
            &client,
            &c,
            "codex",
            None,
            &state,
            json!({"event":"Stop","cwd":root,"session_id":"target-job","turn_id":"1"}),
        )
        .await
        .unwrap();
    }
    let state = StateArgs {
        state_dir: None,
        json: true,
    };
    let value = learn_value(
        &client,
        &c,
        LearnCommand::Status {
            project_root: b.clone(),
            state: state.clone(),
        },
        &a,
    )
    .await
    .unwrap();
    assert_eq!(value["jobs"].as_array().unwrap().len(), 1, "{value}");
    let b_run = value["jobs"][0]["run_id"].clone();
    let value = learn_value(
        &client,
        &c,
        LearnCommand::Drain {
            run_id: None,
            max_jobs: None,
            require_wakeup: false,
            project_root: b.clone(),
            state,
            recall_config: None,
        },
        &a,
    )
    .await
    .unwrap();
    assert_eq!(value["jobs"][0]["run_id"], b_run, "{value}");
    assert_eq!(value["jobs"][0]["state"], "candidate", "{value}");
    let state = StateArgs {
        state_dir: Some(a.join(".kinic/state")),
        json: true,
    };
    let project = load_project(&a.join(CONFIG_FILE)).unwrap();
    assert_eq!(
        job_driver::queue(&client, &c, &state, &project)
            .unwrap()
            .list()
            .unwrap()[0]
            .state,
        "pending"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn legacy_hook_override_keeps_connection_policy_without_starting_jobs() {
    let (dir, client, state, a, _) = fixture().await;
    let c = connection();
    let runtime = dir.path().join("recall-runtime.json");
    std::fs::write(&runtime, r#"{"budget_tokens":2000}"#).unwrap();
    let recalled = hooks::handle(&client,&c,"codex",Some(runtime.clone()),&state,json!({"event":"UserPromptSubmit","cwd":a,"session_id":"runtime","turn_id":"1","prompt":"portable advice"})).await.unwrap();
    assert!(!recalled["additionalContext"].as_str().unwrap().is_empty());
    let stopped = hooks::handle(
        &client,
        &c,
        "codex",
        Some(runtime.clone()),
        &state,
        json!({"event":"Stop","cwd":a,"session_id":"runtime","turn_id":"1"}),
    )
    .await
    .unwrap();
    assert_eq!(stopped["queued"], false);
    let mut wrong = c.clone();
    wrong.database_id = Some("wrong".into());
    assert!(hooks::handle(&client,&wrong,"codex",Some(runtime.clone()),&state,json!({"event":"UserPromptSubmit","cwd":a,"session_id":"wrong","turn_id":"1","prompt":"advice"})).await.is_err());
    let resolved = crate::agent_config::AgentConfig::at(&a)
        .unwrap()
        .with_stdin_recall(Some(json!({"budget_tokens":2000})));
    let opts = load_recall_resolved(
        &resolved,
        Some(Path::new("-")),
        "advice",
        &client,
        &c,
        &state,
        &a,
        None,
    )
    .unwrap();
    assert_eq!(opts.budget_tokens, 2000);
    assert!(
        load_recall_resolved(
            &resolved,
            Some(Path::new("-")),
            "advice",
            &client,
            &wrong,
            &state,
            &a,
            None
        )
        .is_err()
    );
    let mut project = load_project(&a.join(CONFIG_FILE)).unwrap();
    project.principal = Some("different-principal".into());
    crate::learning::project::save_project(&a.join(CONFIG_FILE), &project).unwrap();
    assert!(hooks::handle(&client,&c,"codex",Some(runtime),&state,json!({"event":"UserPromptSubmit","cwd":a,"session_id":"wrong-principal","turn_id":"1","prompt":"advice"})).await.is_err());
}

#[cfg(unix)]
#[tokio::test]
async fn hooks_enqueue_evidence_without_remote_writes_and_flush_later() {
    use std::sync::atomic::Ordering;
    let (_dir, client, state, a, _b) = fixture().await;
    let c = connection();
    let writes =
        || client.writes.load(Ordering::SeqCst) + client.batch_writes.load(Ordering::SeqCst);
    let before = writes();
    let recalled = hooks::handle(&client, &c, "codex", None, &state, json!({"event":"UserPromptSubmit","cwd":a,"session_id":"hot-path","turn_id":"1","prompt":"portable build"})).await.unwrap();
    assert!(!recalled["additionalContext"].as_str().unwrap().is_empty());
    assert_eq!(recalled["pending_sync"], true);
    for call in 0..3 {
        let tool = hooks::handle(&client, &c, "codex", None, &state, json!({"event":"PostToolUse","cwd":a,"session_id":"hot-path","turn_id":"1","tool_name":"shell","tool_use_id":call})).await.unwrap();
        assert_eq!(tool["recorded"], true);
        assert_eq!(tool["pending_sync"], true);
    }
    assert_eq!(writes(), before, "hooks must not wait on remote writes");
    let outbox = open_outbox(&client, &c, &state).unwrap();
    let pending = outbox.pending_count().unwrap();
    let batches_before_flush = client.batch_writes.load(Ordering::SeqCst);
    assert!(
        pending >= 5,
        "receipt, run and tool events stay queued: {pending}"
    );
    assert_eq!(
        outbox.flush_exclusive(&client, "db").await.unwrap(),
        Some(pending)
    );
    assert_eq!(
        client.batch_writes.load(Ordering::SeqCst) - batches_before_flush,
        1
    );
    assert_eq!(outbox.pending_count().unwrap(), 0);
}

#[cfg(unix)]
#[tokio::test]
async fn delivery_gate_does_not_start_proposal_while_outbox_is_owned() {
    let (_dir, client, state, a, _) = fixture().await;
    let c = connection();
    let r = hooks::handle(&client,&c,"codex",None,&state,json!({"event":"UserPromptSubmit","cwd":a,"session_id":"gate","turn_id":"1","prompt":"portable advice"})).await.unwrap();
    let run = r["run_id"].as_str().unwrap();
    hooks::handle(
        &client,
        &c,
        "codex",
        None,
        &state,
        json!({"event":"Stop","cwd":a,"session_id":"gate","turn_id":"1"}),
    )
    .await
    .unwrap();
    let outbox = open_outbox(&client, &c, &state).unwrap();
    let db = rusqlite::Connection::open(
        state
            .state_dir
            .as_ref()
            .unwrap()
            .join("learning-outbox.sqlite3"),
    )
    .unwrap();
    db.execute(
        "INSERT INTO learning_outbox_owner SELECT DISTINCT scope, ?1 FROM learning_outbox",
        [std::process::id()],
    )
    .unwrap();
    let result = learn_value(
        &client,
        &c,
        LearnCommand::Propose {
            run_id: run.into(),
            runner_file: a.join(CONFIG_FILE),
            state: state.clone(),
        },
        &a,
    )
    .await;
    assert!(result.unwrap_err().to_string().contains("delivery_pending"));
    let jobs = job_driver::drain(&client, &c, &a, &state).await.unwrap();
    assert_eq!(jobs["busy"], true);
    assert_eq!(jobs["jobs"][0]["state"], "pending");
    db.execute("DELETE FROM learning_outbox_owner", []).unwrap();
    assert!(outbox.pending_count().unwrap() > 0);
}

#[cfg(unix)]
#[tokio::test]
async fn poisoned_inbox_is_quarantined_without_blocking_valid_input() {
    let (_dir, client, state, a, _) = fixture().await;
    let c = connection();
    let req = json!({"event":"PostToolUse","cwd":a,"session_id":"poison","turn_id":"1"});
    let valid = hooks::spool(&c, &state, "codex", None, &req).unwrap();
    let bad = valid.parent().unwrap().join("000-broken.json");
    std::fs::write(&bad, "{broken").unwrap();
    let current = hooks::spool(&c, &state, "codex", None, &req).unwrap();
    hooks::replay(&client, &c, "codex", None, &state, &current)
        .await
        .unwrap();
    assert!(!valid.exists());
    assert!(!bad.exists());
    assert!(
        bad.parent()
            .unwrap()
            .join("quarantine/000-broken.json")
            .exists()
    );
    assert!(
        open_outbox(&client, &c, &state)
            .unwrap()
            .pending_count()
            .unwrap()
            > 0
    );
}

#[cfg(unix)]
#[tokio::test]
async fn invalid_reserved_binding_is_quarantined_before_valid_replay() {
    let (_dir, client, state, a, _) = fixture().await;
    let c = connection();
    let req = json!({"event":"PostToolUse","cwd":a,"session_id":"reserved","turn_id":"1"});
    let bad = hooks::spool(&c, &state, "codex", None, &req).unwrap();
    let mut value: Value = read_json(&bad).unwrap();
    value["__kinic_run_id"] = json!("wrong-project:run");
    std::fs::write(&bad, serde_json::to_vec(&value).unwrap()).unwrap();
    let valid = hooks::spool(&c, &state, "codex", None, &req).unwrap();
    let current = hooks::spool(&c, &state, "codex", None, &req).unwrap();
    hooks::replay(&client, &c, "codex", None, &state, &current)
        .await
        .unwrap();
    assert!(!valid.exists());
    assert!(
        bad.parent()
            .unwrap()
            .join("quarantine")
            .join(bad.file_name().unwrap())
            .exists()
    );
}

#[cfg(unix)]
#[tokio::test]
async fn live_unbound_intake_is_not_quarantined_by_delivery() {
    let (_dir, client, state, a, _) = fixture().await;
    let c = connection();
    let req = json!({"event":"PostToolUse","cwd":a,"session_id":"live","turn_id":"1"});
    let current = hooks::spool(&c, &state, "codex", None, &req).unwrap();
    let mut value: Value = read_json(&current).unwrap();
    value["__kinic_principal"] = Value::Null;
    std::fs::write(&current, serde_json::to_vec(&value).unwrap()).unwrap();
    deliver(&client, &c, &state, &a, Some("codex"), None)
        .await
        .unwrap();
    assert!(current.exists());
    assert!(!current.parent().unwrap().join("quarantine").exists());
}

#[cfg(unix)]
#[tokio::test]
async fn intake_publication_never_exposes_partial_json() {
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };
    let (_dir, _client, state, a, _) = fixture().await;
    let c = connection();
    let root = state.state_dir.as_ref().unwrap().join("hook-inbox");
    let done = Arc::new(AtomicBool::new(false));
    let stop = done.clone();
    let reader = std::thread::spawn(move || {
        let mut invalid = 0;
        while !stop.load(Ordering::SeqCst) {
            if let Ok(dirs) = std::fs::read_dir(&root) {
                for dir in dirs.flatten() {
                    if let Ok(files) = std::fs::read_dir(dir.path()) {
                        for file in files.flatten() {
                            if file.path().extension().is_some_and(|e| e == "json")
                                && let Ok(bytes) = std::fs::read(file.path())
                                && serde_json::from_slice::<Value>(&bytes).is_err()
                            {
                                invalid += 1;
                            }
                        }
                    }
                }
            }
        }
        invalid
    });
    for turn in 0..4 {
        let req = json!({"event":"PostToolUse","cwd":a,"session_id":"atomic","turn_id":turn.to_string(),"tool_response":"x".repeat(1024*1024)});
        hooks::spool(&c, &state, "codex", None, &req).unwrap();
    }
    done.store(true, Ordering::SeqCst);
    assert_eq!(
        reader.join().unwrap(),
        0,
        "replay observed partially published intake"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn delivery_review_plain_flush_never_launches_learning() {
    let (_dir, client, state, a, _) = fixture().await;
    let c = connection();
    hooks::handle(
        &client,
        &c,
        "codex",
        None,
        &state,
        json!({"event":"Stop","cwd":a,"session_id":"plain","turn_id":"1"}),
    )
    .await
    .unwrap();
    open_outbox(&client, &c, &state)
        .unwrap()
        .flush(&client, "db")
        .await
        .unwrap();
    job_driver::TEST_LAUNCHES.with(|calls| calls.borrow_mut().clear());
    deliver(&client, &c, &state, &a, None, None).await.unwrap();
    job_driver::TEST_LAUNCHES
        .with(|calls| assert!(calls.borrow().is_empty(), "plain flush launched learning"));
}

#[cfg(unix)]
#[tokio::test]
async fn delivery_review_busy_background_preserves_its_project_wakeup() {
    let (_dir, client, state, a, b) = fixture().await;
    let c = connection();
    hooks::handle(
        &client,
        &c,
        "codex",
        None,
        &state,
        json!({"event":"Stop","cwd":b,"session_id":"busy","turn_id":"1"}),
    )
    .await
    .unwrap();
    let owner = open_outbox(&client, &c, &state).unwrap();
    let lease = owner.acquire().unwrap().unwrap();
    job_driver::TEST_LAUNCHES.with(|calls| calls.borrow_mut().clear());
    let send = async {
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        owner.flush_owned(&client, "db").await.unwrap();
        drop(lease);
    };
    let worker = deliver(&client, &c, &state, &b, Some("codex"), None);
    let (_, result) = tokio::join!(send, worker);
    assert_ne!(
        result.unwrap()["busy"],
        true,
        "background abandoned project wakeup"
    );
    assert_eq!(owner.pending_count().unwrap(), 0);
    job_driver::TEST_LAUNCHES.with(|calls| {
        assert_eq!(*calls.borrow(), vec![b]);
        assert!(!calls.borrow().contains(&a));
    });
}

#[cfg(unix)]
#[tokio::test]
async fn delivery_review_plain_flush_stays_fail_fast_when_busy() {
    let (_dir, client, state, a, _) = fixture().await;
    let c = connection();
    let owner = open_outbox(&client, &c, &state).unwrap();
    let _lease = owner.acquire().unwrap().unwrap();
    let reply = tokio::time::timeout(
        std::time::Duration::from_secs(1),
        deliver(&client, &c, &state, &a, None, None),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(reply["busy"], true);
}

#[cfg(unix)]
#[tokio::test]
async fn drain_rechecks_delivery_after_sender_replacement_exits_busy() {
    let (dir, client, state, a, _) = fixture().await;
    let c = connection();
    hooks::handle(&client, &c, "codex", None, &state, json!({"event":"UserPromptSubmit","cwd":a,"session_id":"handoff","turn_id":"1","prompt":"portable advice"})).await.unwrap();
    hooks::handle(
        &client,
        &c,
        "codex",
        None,
        &state,
        json!({"event":"Stop","cwd":a,"session_id":"handoff","turn_id":"1"}),
    )
    .await
    .unwrap();
    let db_path = state
        .state_dir
        .as_ref()
        .unwrap()
        .join("learning-outbox.sqlite3");
    let db = rusqlite::Connection::open(&db_path).unwrap();
    db.execute(
        "INSERT INTO learning_outbox_owner SELECT DISTINCT scope, ?1 FROM learning_outbox",
        [std::process::id()],
    )
    .unwrap();
    let sender_root = dir.path().to_path_buf();
    let sender_state = state.clone();
    let sender_project = a.clone();
    // Finish delivery after the old drain observes pending evidence, while it
    // still owns the job lease. The sender's replacement drain loses that race.
    job_driver::TEST_DELIVERY_PENDING.with(|hook| {
        *hook.borrow_mut() = Some(Box::new(move || {
            std::thread::spawn(move || {
                tokio::runtime::Runtime::new()
                    .unwrap()
                    .block_on(async move {
                        let sender = StoreClient::new(&sender_root);
                        let db = rusqlite::Connection::open(db_path).unwrap();
                        db.execute("DELETE FROM learning_outbox_owner", []).unwrap();
                        let outbox = open_outbox(&sender, &connection(), &sender_state).unwrap();
                        outbox.flush_exclusive(&sender, "db").await.unwrap();
                        assert_eq!(outbox.pending_count().unwrap(), 0);
                        let replacement = job_driver::drain(
                            &sender,
                            &connection(),
                            &sender_project,
                            &sender_state,
                        )
                        .await
                        .unwrap();
                        assert_eq!(replacement["busy"], true);
                        assert_eq!(replacement["jobs"][0]["state"], "pending");
                    });
            })
            .join()
            .unwrap();
        }));
    });
    let result = job_driver::drain(&client, &c, &a, &state).await.unwrap();
    assert_eq!(result["jobs"][0]["state"], "candidate", "{result}");
    assert!(result["jobs"][0]["candidate_path"].is_string());
}

#[cfg(unix)]
#[tokio::test]
async fn tool_event_delivery_does_not_relaunch_retry_jobs() {
    let (_dir, client, state, a, _) = fixture().await;
    let c = connection();
    let project = load_project(&a.join(CONFIG_FILE)).unwrap();
    let queue = job_driver::queue(&client, &c, &state, &project).unwrap();
    queue
        .enqueue("retry-run", &a, &a.join(CONFIG_FILE))
        .unwrap();
    let mut job = queue.list().unwrap().remove(0);
    job.state = "retry".into();
    queue.save(&job).unwrap();
    hooks::handle(
        &client,
        &c,
        "codex",
        None,
        &state,
        json!({"event":"PostToolUse","cwd":a,"session_id":"tool-only","turn_id":"1"}),
    )
    .await
    .unwrap();
    job_driver::TEST_LAUNCHES.with(|calls| calls.borrow_mut().clear());
    deliver(&client, &c, &state, &a, Some("codex"), None)
        .await
        .unwrap();
    job_driver::TEST_LAUNCHES.with(|calls| {
        assert!(
            calls.borrow().is_empty(),
            "tool-only delivery launched learning"
        )
    });
}

#[cfg(unix)]
#[tokio::test]
async fn tool_delivery_wakes_learning_for_replayed_terminal() {
    let (_dir, client, state, a, _) = fixture().await;
    let c = connection();
    let request = json!({"event":"Stop","cwd":a,"session_id":"replayed-stop","turn_id":"1"});
    let path = hooks::spool(&c, &state, "codex", None, &request).unwrap();
    let mut saved: Value = read_json(&path).unwrap();
    saved.as_object_mut().unwrap().remove("__kinic_owner_pid");
    std::fs::write(&path, serde_json::to_vec(&saved).unwrap()).unwrap();
    job_driver::TEST_LAUNCHES.with(|calls| calls.borrow_mut().clear());
    deliver(&client, &c, &state, &a, Some("codex"), None)
        .await
        .unwrap();
    assert!(!path.exists());
    let project = load_project(&a.join(CONFIG_FILE)).unwrap();
    let jobs = job_driver::queue(&client, &c, &state, &project)
        .unwrap()
        .list()
        .unwrap();
    assert_eq!(jobs.len(), 1);
    assert_eq!(
        open_outbox(&client, &c, &state)
            .unwrap()
            .pending_count()
            .unwrap(),
        0
    );
    job_driver::TEST_LAUNCHES.with(|calls| assert_eq!(*calls.borrow(), vec![a]));
}

#[cfg(unix)]
#[tokio::test]
async fn terminal_wakeup_survives_failed_delivery_until_later_tool_event() {
    let (_dir, client, state, a, _) = fixture().await;
    let c = connection();
    hooks::handle(
        &client,
        &c,
        "codex",
        None,
        &state,
        json!({"event":"Stop","cwd":a,"session_id":"persist-wake","turn_id":"1"}),
    )
    .await
    .unwrap();
    // A delivery attempt fails after the terminal event has been enqueued.
    client.deny.store(true, std::sync::atomic::Ordering::SeqCst);
    job_driver::TEST_LAUNCHES.with(|calls| calls.borrow_mut().clear());
    assert!(
        deliver(&client, &c, &state, &a, Some("codex"), None)
            .await
            .is_err()
    );
    job_driver::TEST_LAUNCHES.with(|calls| assert!(calls.borrow().is_empty()));
    client
        .deny
        .store(false, std::sync::atomic::Ordering::SeqCst);
    deliver(&client, &c, &state, &a, Some("codex"), None)
        .await
        .unwrap();
    job_driver::TEST_LAUNCHES.with(|calls| assert_eq!(*calls.borrow(), vec![a.clone()]));
    let project = load_project(&a.join(CONFIG_FILE)).unwrap();
    let queue = job_driver::queue(&client, &c, &state, &project).unwrap();
    assert!(
        queue.pending_wakeup().unwrap().is_some(),
        "spawning alone must not acknowledge wakeup"
    );
    job_driver::drain(&client, &c, &a, &state).await.unwrap();
    assert_eq!(queue.pending_wakeup().unwrap(), None);
    job_driver::TEST_LAUNCHES.with(|calls| calls.borrow_mut().clear());
    deliver(&client, &c, &state, &a, Some("codex"), None)
        .await
        .unwrap();
    job_driver::TEST_LAUNCHES.with(|calls| assert!(calls.borrow().is_empty()));
}

#[cfg(unix)]
#[tokio::test]
async fn recall_wakeup_survives_delivery_failure() {
    let (_dir, client, state, a, _) = fixture().await;
    let c = connection();
    hooks::handle(&client, &c, "codex", None, &state, json!({"event":"UserPromptSubmit","cwd":a,"session_id":"recall-wake","turn_id":"1","prompt":"portable advice"})).await.unwrap();
    let project = load_project(&a.join(CONFIG_FILE)).unwrap();
    let queue = job_driver::queue(&client, &c, &state, &project).unwrap();
    assert!(
        queue.pending_wakeup().unwrap().is_some(),
        "recall must persist its wakeup"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn wakeup_remains_pending_when_drain_owner_is_busy() {
    let (_dir, client, state, a, _) = fixture().await;
    let c = connection();
    hooks::handle(
        &client,
        &c,
        "codex",
        None,
        &state,
        json!({"event":"Stop","cwd":a,"session_id":"busy-owner","turn_id":"1"}),
    )
    .await
    .unwrap();
    let project = load_project(&a.join(CONFIG_FILE)).unwrap();
    let queue = job_driver::queue(&client, &c, &state, &project).unwrap();
    let lease = queue.acquire().unwrap().unwrap();
    deliver(&client, &c, &state, &a, Some("codex"), None)
        .await
        .unwrap();
    assert!(queue.pending_wakeup().unwrap().is_some());
    assert_eq!(
        job_driver::drain(&client, &c, &a, &state).await.unwrap()["busy"],
        true
    );
    assert!(queue.pending_wakeup().unwrap().is_some());
    drop(lease);
    job_driver::drain(&client, &c, &a, &state).await.unwrap();
    assert_eq!(queue.pending_wakeup().unwrap(), None);
}

#[cfg(unix)]
#[tokio::test]
async fn replayed_recall_preserves_wakeup_without_recalling_again() {
    let (_dir, client, state, a, _) = fixture().await;
    let c = connection();
    let request = json!({"event":"UserPromptSubmit","cwd":a,"session_id":"replayed-recall","turn_id":"1","prompt":"portable advice"});
    let path = hooks::spool(&c, &state, "codex", None, &request).unwrap();
    let mut saved: Value = read_json(&path).unwrap();
    saved.as_object_mut().unwrap().remove("__kinic_owner_pid");
    std::fs::write(&path, serde_json::to_vec(&saved).unwrap()).unwrap();
    job_driver::TEST_LAUNCHES.with(|calls| calls.borrow_mut().clear());
    deliver(&client, &c, &state, &a, Some("codex"), None)
        .await
        .unwrap();
    assert!(!path.exists());
    let project = load_project(&a.join(CONFIG_FILE)).unwrap();
    let q = job_driver::queue(&client, &c, &state, &project).unwrap();
    assert!(q.pending_wakeup().unwrap().is_some());
    job_driver::TEST_LAUNCHES.with(|calls| assert_eq!(*calls.borrow(), vec![a]));
}

#[cfg(unix)]
#[tokio::test]
async fn delivery_without_wakeup_does_not_start_learning() {
    let (_dir, client, state, a, _) = fixture().await;
    let c = connection();
    job_driver::TEST_LAUNCHES.with(|calls| calls.borrow_mut().clear());
    deliver(&client, &c, &state, &a, Some("codex"), None)
        .await
        .unwrap();
    job_driver::TEST_LAUNCHES.with(|calls| {
        assert!(
            calls.borrow().is_empty(),
            "delivery without wakeup launched learning"
        )
    });
}

#[cfg(unix)]
#[tokio::test]
async fn stale_background_drain_does_not_retry_without_wakeup() {
    let (_dir, client, state, a, _) = fixture().await;
    let c = connection();
    let project = load_project(&a.join(CONFIG_FILE)).unwrap();
    let queue = job_driver::queue(&client, &c, &state, &project).unwrap();
    queue
        .enqueue("retry-run", &a, &a.join(CONFIG_FILE))
        .unwrap();
    let mut job = queue.list().unwrap().remove(0);
    job.state = "retry".into();
    queue.save(&job).unwrap();
    let result = job_driver::drain_with_config(&client, &c, &a, &state, None, true)
        .await
        .unwrap();
    assert_eq!(result["already_woken"], true);
    assert_eq!(queue.list().unwrap()[0].state, "retry");
}

#[cfg(unix)]
#[tokio::test]
async fn stop_arriving_after_delivery_check_keeps_wakeup_until_evidence_sent() {
    let (dir, client, state, a, _) = fixture().await;
    let c = connection();
    let outbox = open_outbox(&client, &c, &state).unwrap();
    let lease = outbox.acquire().unwrap().unwrap();
    let source = dir.path().to_path_buf();
    let target = a.clone();
    let saved_state = state.clone();
    job_driver::TEST_AFTER_OUTBOX_CHECK.with(|slot| {
        *slot.borrow_mut() = Some(Box::new(move || {
            std::thread::spawn(move || {
                tokio::runtime::Runtime::new()
                    .unwrap()
                    .block_on(async move {
                        let other = StoreClient::new(&source);
                        hooks::handle(&other, &connection(), "codex", None, &saved_state,
                json!({"event":"Stop","cwd":target,"session_id":"late-stop","turn_id":"1"}))
                .await.unwrap();
                    })
            })
            .join()
            .unwrap();
        }))
    });
    let result = job_driver::drain(&client, &c, &a, &state).await.unwrap();
    assert_eq!(result["reason"], "delivery_pending");
    let project = load_project(&a.join(CONFIG_FILE)).unwrap();
    let q = job_driver::queue(&client, &c, &state, &project).unwrap();
    assert_eq!(q.list().unwrap()[0].state, "pending");
    assert!(q.pending_wakeup().unwrap().is_some());
    drop(lease);
    deliver(&client, &c, &state, &a, Some("codex"), None)
        .await
        .unwrap();
    job_driver::drain(&client, &c, &a, &state).await.unwrap();
    assert_eq!(q.pending_wakeup().unwrap(), None);
    let job = q.list().unwrap().remove(0);
    assert_eq!(job.state, "paused"); // Missing recall/run evidence requires inspection, not automatic retries.
    assert_eq!(job.pause.as_ref().unwrap().reason, "evidence_missing");
    assert!(!job.error.unwrap_or_default().contains("delivery_pending"));
}

#[cfg(unix)]
#[tokio::test]
async fn terminal_job_and_wakeup_commit_atomically() {
    let (_dir, client, state, a, _) = fixture().await;
    let c = connection();
    let project = load_project(&a.join(CONFIG_FILE)).unwrap();
    let q = job_driver::queue(&client, &c, &state, &project).unwrap();
    let root = state.state_dir.as_ref().unwrap();
    let db_path = std::fs::read_dir(root)
        .unwrap()
        .flatten()
        .map(|entry| entry.path())
        .find(|path| {
            path.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("jobs-")
                && path.extension().is_some_and(|e| e == "sqlite")
        })
        .unwrap();
    let db = rusqlite::Connection::open(db_path).unwrap();
    db.execute_batch("CREATE TRIGGER fail_wakeup BEFORE INSERT ON wakeup BEGIN SELECT RAISE(ABORT, 'test wake failure'); END;").unwrap();
    assert!(
        job_driver::enqueue(
            &client,
            &c,
            &state,
            &project,
            "atomic-run",
            &a,
            &a.join(CONFIG_FILE)
        )
        .is_err()
    );
    assert!(
        q.list().unwrap().is_empty(),
        "failed wake insert left a visible job"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn stop_during_wakeup_snapshot_does_not_retry_same_failure_twice() {
    let (dir, client, state, a, _) = fixture().await;
    let c = connection();
    let project = load_project(&a.join(CONFIG_FILE)).unwrap();
    let count = dir.path().join("calls");
    std::fs::write(&project.runner.executable, format!("#!/usr/bin/env python3\nimport pathlib\np=pathlib.Path({:?})\np.write_text(p.read_text()+'x' if p.exists() else 'x')\nraise SystemExit(1)\n", count.to_str().unwrap())).unwrap();
    hooks::handle(&client, &c, "codex", None, &state, json!({"event":"UserPromptSubmit","cwd":a,"session_id":"snapshot-stop","turn_id":"1","prompt":"portable advice"})).await.unwrap();
    open_outbox(&client, &c, &state)
        .unwrap()
        .flush(&client, "db")
        .await
        .unwrap();
    let source = dir.path().to_path_buf();
    let target = a.clone();
    let saved_state = state.clone();
    crate::learning::jobs::TEST_AFTER_WAKE_SNAPSHOT.with(|slot| *slot.borrow_mut() = Some(Box::new(move || {
        std::thread::spawn(move || tokio::runtime::Runtime::new().unwrap().block_on(async move {
            let other = StoreClient::new(&source);
            hooks::handle(&other, &connection(), "codex", None, &saved_state, json!({"event":"Stop","cwd":target,"session_id":"snapshot-stop","turn_id":"1"})).await.unwrap();
            open_outbox(&other, &connection(), &saved_state).unwrap().flush(&other, "db").await.unwrap();
        })).join().unwrap();
    })));
    job_driver::drain(&client, &c, &a, &state).await.unwrap();
    assert_eq!(
        std::fs::read_to_string(count).unwrap(),
        "x",
        "one stop retried the model twice"
    );
    let q = job_driver::queue(&client, &c, &state, &project).unwrap();
    q.request_wakeup().unwrap();
    job_driver::drain(&client, &c, &a, &state).await.unwrap();
    assert_eq!(
        std::fs::read_to_string(dir.path().join("calls")).unwrap(),
        "x",
        "a new event bypassed retry backoff"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn manual_drain_reports_job_failure_as_error() {
    let (_dir, client, state, a, _) = fixture().await;
    let c = connection();
    let config = a.join(CONFIG_FILE).canonicalize().unwrap();
    let project = load_project(&config).unwrap();
    let q = job_driver::queue(&client, &c, &state, &project).unwrap();
    q.enqueue("missing-evidence", &a, &config).unwrap();
    let error = job_driver::drain_selected(
        &client,
        &c,
        &a,
        &state,
        None,
        false,
        &job_driver::DrainSelection {
            run_id: Some("missing-evidence".into()),
            max_jobs: None,
        },
    )
    .await
    .unwrap_err();
    assert!(error.to_string().contains("missing-evidence"));
    assert_eq!(q.list().unwrap()[0].state, "paused");
    assert!(q.list().unwrap()[0].error.is_some());
}

#[cfg(unix)]
#[tokio::test]
async fn selected_drain_does_not_deliver_other_runs() {
    let (_dir, client, state, a, _) = fixture().await;
    let c = connection();
    let config = a.join(CONFIG_FILE).canonicalize().unwrap();
    let project = load_project(&config).unwrap();
    let q = job_driver::queue(&client, &c, &state, &project).unwrap();
    q.enqueue("selected", &a, &config).unwrap();
    q.enqueue("other", &a, &config).unwrap();
    let outbox = open_outbox(&client, &c, &state).unwrap();
    for run in ["selected", "other"] {
        outbox
            .enqueue(&Event {
                id: format!("event-{run}"),
                run_id: run.into(),
                kind: "hook".into(),
                payload: json!({}),
            })
            .unwrap();
    }
    job_driver::drain_selected(
        &client,
        &c,
        &a,
        &state,
        None,
        false,
        &job_driver::DrainSelection {
            run_id: Some("selected".into()),
            max_jobs: None,
        },
    )
    .await
    .unwrap_err();
    assert!(!outbox.pending_run("selected").unwrap());
    assert!(
        outbox.pending_run("other").unwrap(),
        "unselected run must remain pending"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn max_jobs_skips_retained_candidates_without_validation() {
    let (_dir, client, state, a, _) = fixture().await;
    let c = connection();
    let config = a.join(CONFIG_FILE).canonicalize().unwrap();
    let project = load_project(&config).unwrap();
    assert!(project.validation_suite.is_none());
    let q = job_driver::queue(&client, &c, &state, &project).unwrap();
    q.enqueue("candidate", &a, &config).unwrap();
    q.enqueue("pending", &a, &config).unwrap();
    let mut retained = q.list().unwrap().remove(0);
    retained.state = "candidate".into();
    retained.candidate_path = Some("candidate.json".into());
    q.save(&retained).unwrap();
    job_driver::drain_selected(
        &client,
        &c,
        &a,
        &state,
        None,
        false,
        &job_driver::DrainSelection {
            run_id: None,
            max_jobs: Some(1),
        },
    )
    .await
    .unwrap_err();
    assert_eq!(
        q.list().unwrap()[1].state,
        "paused",
        "pending job should be processed"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn max_jobs_drain_does_not_block_on_unselected_delivery() {
    let (_dir, client, state, a, _) = fixture().await;
    let c = connection();
    let config = a.join(CONFIG_FILE).canonicalize().unwrap();
    let project = load_project(&config).unwrap();
    let q = job_driver::queue(&client, &c, &state, &project).unwrap();
    for run in ["first", "second"] {
        q.enqueue(run, &a, &config).unwrap();
    }
    let outbox = open_outbox(&client, &c, &state).unwrap();
    for run in ["first", "second"] {
        outbox
            .enqueue(&Event {
                id: format!("event-{run}"),
                run_id: run.into(),
                kind: "hook".into(),
                payload: json!({}),
            })
            .unwrap();
    }
    let error = job_driver::drain_selected(
        &client,
        &c,
        &a,
        &state,
        None,
        false,
        &job_driver::DrainSelection {
            run_id: None,
            max_jobs: Some(1),
        },
    )
    .await
    .unwrap_err();
    assert!(error.to_string().contains("first"));
    assert!(!outbox.pending_run("first").unwrap());
    assert!(outbox.pending_run("second").unwrap());
    assert_eq!(q.list().unwrap()[1].state, "pending");
}

#[cfg(unix)]
#[tokio::test]
async fn selected_drain_and_job_controls_do_not_process_other_runs() {
    let (_dir, client, state, a, _) = fixture().await;
    let c = connection();
    let config = a.join(CONFIG_FILE).canonicalize().unwrap();
    let project = load_project(&config).unwrap();
    let q = job_driver::queue(&client, &c, &state, &project).unwrap();
    for run in ["first", "second", "third"] {
        q.enqueue(run, &a, &config).unwrap();
    }
    let error = job_driver::drain_selected(
        &client,
        &c,
        &a,
        &state,
        None,
        false,
        &job_driver::DrainSelection {
            run_id: Some("second".into()),
            max_jobs: None,
        },
    )
    .await
    .unwrap_err();
    assert!(error.to_string().contains("second"));
    let jobs = q.list().unwrap();
    assert_eq!(jobs[0].state, "pending");
    assert_eq!(jobs[1].state, "paused");
    assert_eq!(jobs[1].pause.as_ref().unwrap().reason, "evidence_missing");
    assert_eq!(jobs[2].state, "pending");
    job_driver::drain_selected(
        &client,
        &c,
        &a,
        &state,
        None,
        false,
        &job_driver::DrainSelection {
            run_id: None,
            max_jobs: Some(1),
        },
    )
    .await
    .unwrap_err();
    assert_eq!(q.list().unwrap()[2].state, "pending");
    let control = |apply| {
        JobCommand::Resume(JobControlArgs {
            run_id: "second".into(),
            apply,
            dry_run: false,
        })
    };
    let preview = job_driver::control_job(&client, &c, &a, &state, &control(false)).unwrap();
    assert_eq!(preview["dry_run"], true);
    assert_eq!(q.list().unwrap()[1].state, "paused");
    let applied = job_driver::control_job(&client, &c, &a, &state, &control(true)).unwrap();
    assert_eq!(applied["model_started"], false);
    assert_eq!(
        q.list().unwrap()[1].retry_policy.as_ref().unwrap().attempts,
        0
    );
    assert_eq!(
        q.list().unwrap()[1].pause.as_ref().unwrap().reason,
        "evidence_missing"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn resume_rejects_changed_configuration_before_claiming_recovery() {
    let (_dir, client, state, a, _) = fixture().await;
    let c = connection();
    let path = a.join(CONFIG_FILE);
    let original = std::fs::read(&path).unwrap();
    let project = load_project(&path).unwrap();
    let q = job_driver::queue(&client, &c, &state, &project).unwrap();
    q.enqueue("config-run", &a, &path.canonicalize().unwrap())
        .unwrap();
    job_driver::drain(&client, &c, &a, &state).await.unwrap();
    let mut changed: Value = serde_json::from_slice(&original).unwrap();
    changed["runner"]["timeout_seconds"] = json!(123);
    std::fs::write(&path, changed.to_string()).unwrap();
    for apply in [false, true] {
        let command = JobCommand::Resume(JobControlArgs {
            run_id: "config-run".into(),
            apply,
            dry_run: false,
        });
        let error = job_driver::control_job(&client, &c, &a, &state, &command).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("restore the original learning configuration"),
            "{error}"
        );
        assert_eq!(q.list().unwrap()[0].state, "paused");
    }
    std::fs::write(&path, original).unwrap();
    let command = JobCommand::Resume(JobControlArgs {
        run_id: "config-run".into(),
        apply: true,
        dry_run: false,
    });
    assert_eq!(
        job_driver::control_job(&client, &c, &a, &state, &command).unwrap()["applied"],
        true
    );
}

#[cfg(unix)]
#[tokio::test]
async fn no_revision_needed_is_saved_once_and_held_without_retry_or_publication() {
    let (dir, client, state, root, _) = fixture().await;
    let script = dir.path().join("model-peer.py");
    std::fs::write(&script,r#"#!/usr/bin/env python3
import json,sys
from pathlib import Path
sys.stdin.read()
marker=Path(__file__).with_suffix('.calls')
with marker.open('a') as f:f.write('call\n')
proposal={'operation':'keep','rationale':'The recorded read-only task supplies no reason to alter existing lessons.','targets':[],'dependency_paths':[]}
print(json.dumps({'type':'item.completed','item':{'type':'agent_message','text':json.dumps(proposal)}}))
print(json.dumps({'type':'turn.completed'}))
"#).unwrap();
    let c = connection();
    let project = load_project(&root.join(CONFIG_FILE)).unwrap();
    let prior_path = format!("{}/prior.md", project.knowledge_scope());
    let before = client.read_node("db", &prior_path).await.unwrap().unwrap();
    hooks::handle(&client,&c,"codex",None,&state,json!({"cwd":root,"session_id":"noop","turn_id":"one","event":"UserPromptSubmit","prompt":"Read portable advice only"})).await.unwrap();
    hooks::handle(
        &client,
        &c,
        "codex",
        None,
        &state,
        json!({"cwd":root,"session_id":"noop","turn_id":"one","event":"Stop"}),
    )
    .await
    .unwrap();
    let result = job_driver::drain(&client, &c, &root, &state).await.unwrap();
    assert_eq!(result["jobs"][0]["state"], "held", "{result}");
    let path = result["jobs"][0]["candidate_path"].as_str().unwrap();
    let candidate: RevisionCandidate = remote_json(&client, "db", path).await.unwrap();
    assert_eq!(candidate.operation, "keep");
    assert!(candidate.targets.is_empty());
    assert!(!candidate.evidence.is_empty());
    job_driver::drain(&client, &c, &root, &state).await.unwrap();
    assert_eq!(
        std::fs::read_to_string(script.with_extension("calls"))
            .unwrap()
            .lines()
            .count(),
        1
    );
    assert_eq!(
        client
            .read_node("db", &prior_path)
            .await
            .unwrap()
            .unwrap()
            .etag,
        before.etag
    );
}

#[cfg(unix)]
#[tokio::test]
async fn terminal_evidence_reuses_identity_and_rejects_changed_retry_content() {
    let (_dir, client, state, a, _b) = fixture().await;
    let request = json!({"event":"Stop","session_id":"terminal-test","turn_id":"turn","cwd":a,"last_assistant_message":"first"});
    hooks::handle(
        &client,
        &connection(),
        "codex",
        None,
        &state,
        request.clone(),
    )
    .await
    .unwrap();
    hooks::handle(
        &client,
        &connection(),
        "codex",
        None,
        &state,
        request.clone(),
    )
    .await
    .unwrap();
    let mut changed = request;
    changed["last_assistant_message"] = json!("changed");
    assert!(
        hooks::handle(&client, &connection(), "codex", None, &state, changed)
            .await
            .is_err()
    );
}

#[cfg(unix)]
#[tokio::test]
async fn compact_inbox_does_not_retain_dropped_tool_bodies() {
    let (_dir, _client, state, a, _b) = fixture().await;
    let request = json!({"event":"PostToolUse","session_id":"compact-spool","turn_id":"turn","cwd":a,"tool_input":{"command":"large-tool-body".repeat(10000)},"tool_response":"large-tool-output".repeat(10000)});
    let file = hooks::spool(&connection(), &state, "codex", None, &request).unwrap();
    let body = std::fs::read_to_string(file).unwrap();
    assert!(!body.contains("large-tool-body"));
    assert!(!body.contains("large-tool-output"));
    assert!(body.len() < 16 * 1024);
}

#[cfg(unix)]
#[tokio::test]
async fn claude_repeated_stop_retains_first_terminal_and_one_job() {
    let (_dir, client, state, root, _) = fixture().await;
    let c = connection();
    let response = hooks::handle(&client, &c, "claude", None, &state, json!({"cwd":root,"session_id":"claude-session","event":"UserPromptSubmit","prompt":"portable build"})).await.unwrap();
    let mut stop = json!({"cwd":root,"session_id":"claude-session","event":"Stop","last_assistant_message":"first response","stop_hook_active":false});
    let first = hooks::handle(&client, &c, "claude", None, &state, stop.clone())
        .await
        .unwrap();
    assert_eq!(first["run_id"], response["run_id"]);
    let before = open_outbox(&client, &c, &state).unwrap().pending().unwrap();
    stop["last_assistant_message"] = json!("response after another Stop hook");
    stop["stop_hook_active"] = json!(true);
    let second = hooks::handle(&client, &c, "claude", None, &state, stop)
        .await
        .unwrap();
    assert_eq!(first["run_id"], second["run_id"]);
    let after = open_outbox(&client, &c, &state).unwrap().pending().unwrap();
    assert_eq!(
        serde_json::to_value(before).unwrap(),
        serde_json::to_value(after).unwrap()
    );
    let project = load_project(&root.join(CONFIG_FILE)).unwrap();
    assert_eq!(
        job_driver::queue(&client, &c, &state, &project)
            .unwrap()
            .list()
            .unwrap()
            .len(),
        1
    );
}
