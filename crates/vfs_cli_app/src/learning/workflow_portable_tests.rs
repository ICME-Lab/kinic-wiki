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
