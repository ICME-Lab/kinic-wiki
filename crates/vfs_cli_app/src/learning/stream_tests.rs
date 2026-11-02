use super::*;
use crate::learning::integration_tests::StoreClient;

#[test]
fn stream_retrieval_compares_original_queries_not_revised_text() {
    let entries = vec![
        entry("old", "alpha beta", "irrelevant"),
        entry("new", "unrelated", "alpha beta"),
    ];
    assert_eq!(lexical_rank("alpha beta", &entries, 1), vec![0]);
    assert_eq!(cosine(&[1.0, 0.0], &[0.0, 1.0]).unwrap(), 0.0);
    assert!(cosine(&[1.0], &[1.0, 0.0]).is_err());
    assert!(cosine(&[0.0], &[0.0]).is_err());
}
fn entry(id: &str, query: &str, reflection: &str) -> Memory {
    Memory {
        id: id.into(),
        query: query.into(),
        original: json!({"query":query,"observations":"ORIGINAL_ONLY"}),
        original_ref: None,
        reflection: reflection.into(),
        embedding: None,
        embedding_ref: None,
    }
}
#[test]
fn revision_separates_original_source_and_later_feedback() {
    let m = entry("old", "query", "old reflection");
    let p = revision_prompt(&m, &json!({"observations":"LATER_ONLY"}));
    assert!(p.contains("sole source of content"));
    assert!(p.find("ORIGINAL_ONLY").unwrap() < p.find("[LATEST OBSERVED USE]").unwrap());
    assert!(p.find("LATER_ONLY").unwrap() > p.find("[LATEST OBSERVED USE]").unwrap());
    let p = write_prompt(&json!({"query":"new task"}), &["revised lesson".into()]);
    assert!(p.contains("revised lesson"));
}
#[test]
fn model_output_must_be_finished_strict_json_and_nonempty() {
    assert!(reflection_json("{\"reflection\":\"\"}", "reflection").is_err());
    assert!(
        reflection_json(
            "{\"reflection\":\"ok\",\"reasoning\":\"secret\"}",
            "reflection"
        )
        .is_err()
    );
    assert_eq!(
        reflection_json(
            "{\"revised_reflection\":\"supported\"}",
            "revised_reflection"
        )
        .unwrap(),
        "supported"
    );
}
#[test]
fn experiment_endpoint_and_namespace_do_not_allow_remote_or_traversal() {
    assert!(local_endpoint("http://127.0.0.1:8011").is_ok());
    assert!(local_endpoint("http://localhost:8011").is_ok());
    assert!(local_endpoint("https://icp0.io").is_err());
    assert!(local_endpoint("http://localhost.evil.test").is_err());
    assert!(state_path("../project", "stream").is_err());
    assert!(state_path("00000000000000000000000000000000", "../stream").is_err());
}
#[tokio::test]
async fn stream_checkpoints_are_compare_and_swap_and_retry_safe() {
    let temp = tempfile::tempdir().unwrap();
    let client = StoreClient::new(temp.path());
    let path = state_path("00000000000000000000000000000000", "test").unwrap();
    let mut etag = None;
    checkpoint(&client, "db", &path, &json!({"step":0}), &mut etag)
        .await
        .unwrap();
    let mut stale = etag.clone();
    checkpoint(&client, "db", &path, &json!({"step":1}), &mut etag)
        .await
        .unwrap();
    assert!(
        checkpoint(&client, "db", &path, &json!({"step":2}), &mut stale)
            .await
            .is_err()
    );
    checkpoint(&client, "db", &path, &json!({"step":1}), &mut stale)
        .await
        .unwrap();
    assert_eq!(stale, etag);
}

#[test]
fn private_reasoning_and_verifier_commands_are_excluded_from_source() {
    let execution = Execution {
        events: vec![
            json!({"type":"item.completed","item":{"type":"reasoning","text":"PRIVATE_CHAIN"}}),
            json!({"type":"item.completed","item":{"type":"command_execution","command":"python app.py","aggregated_output":"PUBLIC_TOOL_RESULT","exit_code":0}}),
        ],
        output: "FINAL".into(),
        exit_reason: "completed".into(),
        complete: true,
        elapsed_ms: 1,
        input_tokens: None,
        output_tokens: None,
    };
    let check = evaluation::VerificationResult {
        argv: vec!["SECRET_ANSWER_PATH".into()],
        passed: true,
        exit_code: Some(0),
        stdout: "FEEDBACK".into(),
        stderr: String::new(),
        timed_out: false,
        output_truncated: false,
    };
    let value = public_trajectory("TASK", &execution, &[check], true).to_string();
    assert!(value.contains("PUBLIC_TOOL_RESULT") && value.contains("FEEDBACK"));
    assert!(!value.contains("PRIVATE_CHAIN") && !value.contains("SECRET_ANSWER_PATH"));
}

#[tokio::test]
async fn online_stream_revises_then_writes_without_replaying_decisions() {
    use std::os::unix::fs::PermissionsExt;
    let base = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/stream-tests");
    std::fs::create_dir_all(&base).unwrap();
    let root = tempfile::tempdir_in(base).unwrap();
    let root = root.path().canonicalize().unwrap();
    let repo = root.join("repo");
    std::fs::create_dir(&repo).unwrap();
    let git = |args: &[&str]| {
        let o = std::process::Command::new("git")
            .args(args)
            .current_dir(&repo)
            .output()
            .unwrap();
        assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
        String::from_utf8(o.stdout).unwrap().trim().to_string()
    };
    git(&["init", "-q"]);
    std::fs::write(repo.join("README.md"), "write result.txt").unwrap();
    git(&["add", "."]);
    git(&[
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-qm",
        "baseline",
    ]);
    let commit = git(&["rev-parse", "HEAD"]);
    let script = root.join("model.py");
    let log = root.join("calls.jsonl");
    std::fs::write(
        &script,
        r#"#!/usr/bin/env python3
import json,sys,os
from pathlib import Path
prompt=sys.stdin.read()
with open(os.environ['CALL_LOG'],'a') as f: f.write(json.dumps(prompt)+'\n')
if 'You are SelectionAgent' in prompt:
    rows=[{'memory_id':'historical','action':'revise','reason':'contradiction','evidence':[{'source':'original','pointer':'/evidence','quote':'OLD_ONLY'}]},
          {'memory_id':'unrelated','action':'keep','reason':'supported','evidence':[{'source':'original','pointer':'/evidence','quote':'Authorization: [REDACTED]'}]}]
    text=json.dumps({'wrong':[]} if os.environ.get('INVALID_SELECTION') else {'selection':rows})
elif 'You are RevisionAgent' in prompt:
    text=json.dumps({'revised_reflection':'revised only from ORIGINAL'})
elif 'You are ReflectionAgent' in prompt:
    text=json.dumps({'reflection':'ORIGINAL reflection'})
else:
    Path('result.txt').write_text('ok')
    text='task completed'
print(json.dumps({'type':'item.completed','item':{'type':'reasoning','text':'PRIVATE_CHAIN'}}))
print(json.dumps({'type':'item.completed','item':{'type':'agent_message','text':text}}))
if os.environ.get('FAILED_SELECTION'):
    print(json.dumps({'type':'turn.failed','error':{'message':'unavailable'}}))
else:
    print(json.dumps({'type':'turn.completed','usage':{'input_tokens':2,'output_tokens':1}}))
"#,
    )
    .unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
    let runner = RunnerConfig {
        executable: script,
        model: Some("scripted-test-only".into()),
        environment: std::collections::BTreeMap::from([(
            "CALL_LOG".into(),
            log.to_string_lossy().into_owned(),
        )]),
        ..Default::default()
    };
    let suite = json!({"suite_id":"online","tasks":(0..3).map(|i|json!({"id":format!("task-{i}"),"family":"pilot","split":"train","repo":repo,"start_commit":commit,"prompt":format!("Write result.txt for task {i}"),"verification":[["python3","-c","from pathlib import Path; assert Path('result.txt').read_text() == 'ok'; print('ORIGINAL feedback')"]],"allowed_paths":["result.txt"]})).collect::<Vec<_>>()});
    let suite_path = root.join("suite.json");
    let runner_path = root.join("runner.json");
    std::fs::write(&suite_path, suite.to_string()).unwrap();
    std::fs::write(&runner_path, serde_json::to_vec(&runner).unwrap()).unwrap();
    let client = StoreClient::new(&root);
    let c = ResolvedConnection {
        replica_host: "http://localhost:8011".into(),
        canister_id: "canister".into(),
        database_id: Some("db".into()),
        replica_host_source: "test".into(),
        canister_id_source: "test".into(),
        database_id_source: Some("test".into()),
    };
    let args = StreamArgs {
        suite: suite_path,
        runner_file: runner_path,
        project_id: "00000000000000000000000000000000".into(),
        stream_id: "stream".into(),
        policy: StreamPolicy::Reharness,
        retrieval: StreamRetrieval::Lexical,
        embedding_config: None,
        top_k: 1,
        output: root.join("output"),
        json: true,
    };
    let report = run(&client, &c, &args).await.unwrap();
    assert_eq!(report["completed"], true);
    let calls: Vec<String> = std::fs::read_to_string(&log)
        .unwrap()
        .lines()
        .map(|s| serde_json::from_str(s).unwrap())
        .collect();
    assert_eq!(calls.len(), 8); // 3 decision, 2 revision, 3 write
    assert!(
        calls[1].contains("ReflectionAgent")
            && calls[3].contains("RevisionAgent")
            && calls[4].contains("ReflectionAgent")
    );
    assert!(calls[4].contains("revised only from ORIGINAL"));
    assert!(calls.iter().all(|p| !p.contains("PRIVATE_CHAIN")));
    let node = client
        .read_node("db", report["state_path"].as_str().unwrap())
        .await
        .unwrap()
        .unwrap();
    let mut state: StreamState = serde_json::from_str(&node.content).unwrap();
    hydrate_payloads(
        &client,
        "db",
        report["state_path"].as_str().unwrap(),
        &mut state,
    )
    .await
    .unwrap();
    assert_eq!(state.memories.len(), 3);
    assert_eq!(
        state.memories[0].original["query"],
        "Write result.txt for task 0"
    );
    assert_eq!(state.memories[1].reflection, "ORIGINAL reflection"); // top-1 tie chose first; unretrieved memory unchanged
    let again = run(&client, &c, &args).await.unwrap();
    assert_eq!(report, again);
    assert_eq!(std::fs::read_to_string(&log).unwrap().lines().count(), 8);
    let mut changed = args.clone();
    changed.top_k = 2;
    assert!(run(&client, &c, &changed).await.is_err());
    let mut raw = args.clone();
    raw.policy = StreamPolicy::Raw;
    raw.stream_id = "raw-cold-start".into();
    raw.output = root.join("raw-output");
    let raw_report = run(&client, &c, &raw).await.unwrap();
    assert_eq!(raw_report["steps"][0]["supplied_context"], "");
    let prompts: Vec<String> = std::fs::read_to_string(&log)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert!(!prompts[8].contains("<supplied_knowledge"));
    assert!(prompts[9].contains("<supplied_knowledge"));
    let mut paired_suite = suite.clone();
    paired_suite["tasks"] = json!([suite["tasks"][0].clone()]);
    let paired_suite_path = root.join("paired-suite.json");
    std::fs::write(&paired_suite_path, paired_suite.to_string()).unwrap();
    let history_path = root.join("histories.json");
    std::fs::write(&history_path,json!({"task-0":{"selected":[{"id":"historical","query":"previous","original":{"evidence":"OLD_ONLY"},"reflection":"frozen original"}],"latest":{"evidence":"LATEST_ONLY"},"new_reflection":"SHARED_NEW"}}).to_string()).unwrap();
    let paired_args = paired::PairedArgs {
        suite: paired_suite_path,
        histories: history_path,
        runner_file: args.runner_file.clone(),
        project_id: args.project_id.clone(),
        experiment_id: "paired".into(),
        revision_policy: paired::RevisionPolicy::All,
        isolation_config: None,
        unisolated_test_only: true,
        output: root.join("paired"),
        trials: 2,
        max_context_bytes: 65536,
        json: true,
    };
    let count_before = std::fs::read_to_string(&log).unwrap().lines().count();
    let paired_report = paired::run(&client, &c, &paired_args).await.unwrap();
    assert_eq!(paired_report["status"], "complete");
    let rows: evaluation::EvaluationReport =
        read_json(&paired_args.output.join("evaluation/report.json")).unwrap();
    assert_eq!(rows.samples.len(), 8);
    assert!(!rows.quality_eligible);
    assert_eq!(rows.schema_version, 2);
    assert!(
        evaluation::compare_modes(
            &rows,
            EvaluationMode::Current,
            EvaluationMode::Revision,
            evaluation::TaskSplit::Train
        )
        .is_err()
    );
    assert!(rows.samples.iter().all(|s| s.success));
    assert_eq!(rows.samples[0].mode, EvaluationMode::None);
    assert_eq!(rows.samples[4].mode, EvaluationMode::Revision);
    let count_after = std::fs::read_to_string(&log).unwrap().lines().count();
    assert_eq!(count_after - count_before, 9);
    assert!(paired::run(&client, &c, &paired_args).await.is_err());
    assert_eq!(
        std::fs::read_to_string(&log).unwrap().lines().count(),
        count_after
    );
    let path = state_path(&args.project_id, "paired")
        .unwrap()
        .replace("/reharness/", "/paired/");
    let reference: PayloadRef =
        serde_json::from_value(paired_report["contexts_ref"].clone()).unwrap();
    let canonical = load_payload(&client, "db", &path, &reference)
        .await
        .unwrap();
    assert!(canonical.contains("SHARED_NEW"));
    assert!(canonical.contains("frozen original"));
    assert!(canonical.contains("revised only from ORIGINAL"));
    let mut selective = paired_args.clone();
    selective.revision_policy = paired::RevisionPolicy::Selective;
    selective.experiment_id = "selective".into();
    selective.output = root.join("selective");
    let mut histories: Value = read_json(&selective.histories).unwrap();
    histories["task-0"]["selected"].as_array_mut().unwrap().push(json!({"id":"unrelated","query":"other","original":{"evidence":"Authorization: [REDACTED]"},"reflection":"keep these exact bytes"}));
    std::fs::write(&selective.histories, histories.to_string()).unwrap();
    let selected = paired::run(&client, &c, &selective).await.unwrap();
    assert_eq!(selected["selection_calls"].as_array().unwrap().len(), 1);
    assert_eq!(selected["revision_calls"].as_array().unwrap().len(), 1);
    assert_eq!(selected["revision_policy"], "selective");
    assert_eq!(
        std::fs::read_to_string(&log).unwrap().lines().count() - count_after,
        10
    );
    let path = state_path(&args.project_id, "selective")
        .unwrap()
        .replace("/reharness/", "/paired/");
    let reference: PayloadRef = serde_json::from_value(selected["contexts_ref"].clone()).unwrap();
    let saved: Value = serde_json::from_str(
        &load_payload(&client, "db", &path, &reference)
            .await
            .unwrap(),
    )
    .unwrap();
    let supplied: Value =
        serde_json::from_str(saved["task-0"]["revision"]["content"].as_str().unwrap()).unwrap();
    assert_eq!(
        supplied["memories"][1]["reflection"],
        "keep these exact bytes"
    );
    assert_eq!(
        supplied["memories"][0]["reflection"],
        "revised only from ORIGINAL"
    );
    assert!(paired::run(&client, &c, &selective).await.is_err());
    let mut bad_runner = runner.clone();
    bad_runner
        .environment
        .insert("INVALID_SELECTION".into(), "1".into());
    let bad_path = root.join("bad-runner.json");
    std::fs::write(&bad_path, serde_json::to_vec(&bad_runner).unwrap()).unwrap();
    let mut failed = selective.clone();
    failed.runner_file = bad_path;
    failed.experiment_id = "selection-failed".into();
    failed.output = root.join("selection-failed");
    assert!(paired::run(&client, &c, &failed).await.is_err());
    let path = state_path(&args.project_id, "selection-failed")
        .unwrap()
        .replace("/reharness/", "/paired/");
    let node = client.read_node("db", &path).await.unwrap().unwrap();
    let state: Value = serde_json::from_str(&node.content).unwrap();
    assert_eq!(state["selection_calls"][0]["call"]["input_tokens"], 2);
    assert_eq!(state["selection_calls"][0]["output_status"], "rejected");
    let diagnostic: Value = read_json(&failed.output.join("selection-0/failure.json")).unwrap();
    assert_eq!(diagnostic["role"], "selection");
    assert!(!state["pending"].is_null());
    assert_eq!(state["revision_calls"].as_array().unwrap().len(), 0);
    assert!(paired::run(&client, &c, &failed).await.is_err());
    bad_runner.environment.remove("INVALID_SELECTION");
    bad_runner
        .environment
        .insert("FAILED_SELECTION".into(), "1".into());
    std::fs::write(
        &failed.runner_file,
        serde_json::to_vec(&bad_runner).unwrap(),
    )
    .unwrap();
    failed.experiment_id = "selection-execution-failed".into();
    failed.output = root.join("selection-execution-failed");
    assert!(paired::run(&client, &c, &failed).await.is_err());
    let diagnostic: Value = read_json(&failed.output.join("selection-0/failure.json")).unwrap();
    assert_eq!(diagnostic["phase"], "execution");
}

#[tokio::test]
async fn two_controllers_cannot_share_a_decision_reservation() {
    let temp = tempfile::tempdir().unwrap();
    let client = StoreClient::new(temp.path());
    let path = state_path("00000000000000000000000000000000", "race").unwrap();
    let mut etag = None;
    checkpoint(&client, "db", &path, &json!({"phase":"ready"}), &mut etag)
        .await
        .unwrap();
    let mut other = etag.clone();
    let a = reservation(0, "owner-a");
    let b = reservation(0, "owner-b");
    assert_ne!(
        serde_json::to_value(&a).unwrap(),
        serde_json::to_value(&b).unwrap()
    );
    checkpoint(&client, "db", &path, &a, &mut etag)
        .await
        .unwrap();
    assert!(
        checkpoint(&client, "db", &path, &b, &mut other)
            .await
            .is_err()
    );
}

#[test]
fn dsh_public_tool_results_are_available_without_assistant_reasoning() {
    let execution = Execution {
        events: vec![
            json!({"method":"session.event","params":{"event":{"type":"tool/result","data":{"message":{"content":[{"type":"text","text":"DSH_PUBLIC"},{"type":"reasoning","text":"PRIVATE"}]}}}}}),
            json!({"method":"session.event","params":{"event":{"type":"assistant/message","data":{"message":{"reasoning":"PRIVATE"}}}}}),
        ],
        output: "done".into(),
        exit_reason: "completed".into(),
        complete: true,
        elapsed_ms: 1,
        input_tokens: None,
        output_tokens: None,
    };
    let source = public_trajectory("q", &execution, &[], false).to_string();
    assert!(source.contains("DSH_PUBLIC"));
    assert!(!source.contains("PRIVATE"));
}

#[test]
fn external_verifier_changes_are_bound_even_when_argv_is_unchanged() {
    let tmp = tempfile::tempdir().unwrap();
    let verifier = tmp.path().join("verifier.py");
    std::fs::write(&verifier, "assert False").unwrap();
    let before = content_bindings(&[verifier.clone()]).unwrap();
    std::fs::write(&verifier, "assert True").unwrap();
    assert_ne!(before, content_bindings(&[verifier]).unwrap());
}

#[test]
fn runner_path_is_resolved_before_artifact_binding() {
    let tmp = tempfile::tempdir().unwrap();
    let executable = tmp.path().join("my-runner");
    std::fs::write(&executable, "fake binary").unwrap();
    let mut runner = RunnerConfig::default();
    runner.executable = "my-runner".into();
    runner
        .environment
        .insert("PATH".into(), tmp.path().to_string_lossy().into_owned());
    assert_eq!(
        resolve_runner(&runner).unwrap(),
        executable.canonicalize().unwrap()
    );
    runner.executable = "missing-runner".into();
    assert!(resolve_runner(&runner).is_err());
}

#[test]
fn interrupted_memory_inference_is_never_silently_replayed() {
    let mut pending: Pending = serde_json::from_value(json!({
        "index":0,"selected":[],"context":"","query_embedding":null,
        "decision_started":null,"inference_started":null,"trajectory":{},
        "success":false,"calls":[],"revised":[],"fresh":null
    }))
    .unwrap();
    claim_inference(&mut pending, "first").unwrap();
    let persisted = serde_json::to_vec(&pending).unwrap();
    let mut recovered: Pending = serde_json::from_slice(&persisted).unwrap();
    assert!(claim_inference(&mut recovered, "second").is_err());
    assert_eq!(recovered.inference_started.unwrap()["owner"], "first");
}

#[tokio::test]
async fn embedding_sidecars_shrink_checkpoints_preserve_bits_and_resume() {
    let temp = tempfile::tempdir().unwrap();
    let client = StoreClient::new(temp.path());
    let path = state_path("00000000000000000000000000000000", "embedding").unwrap();
    let vector: Vec<f64> = (0..4096)
        .map(|i| (i as f64 + 0.123456789012345) / 4097.0)
        .collect();
    let mut memory = entry("a", "query", "reflection");
    memory.embedding = Some(vector.clone());
    let mut state = StreamState {
        schema_version: 1,
        binding: "same".into(),
        memories: vec![memory],
        steps: vec![],
        pending: None,
    };
    state.pending = Some(serde_json::from_value(json!({"index":1,"selected":[],"context":"", "query_embedding":vector,"decision_started":{"owner":"existing-controller"},"inference_started":null,"trajectory":null,"success":false,"calls":[],"revised":[],"fresh":null})).unwrap());
    let inline = serde_json::to_string(&state).unwrap();
    let legacy = inline.replace(",\"embedding_ref\":null", "");
    let mut old: StreamState = serde_json::from_str(&legacy).unwrap();
    hydrate_embeddings(&client, "db", &path, &mut old)
        .await
        .unwrap();
    assert!(old.memories[0].embedding_ref.is_none());
    let mut etag = None;
    checkpoint_state(&client, "db", &path, &mut state, &mut etag)
        .await
        .unwrap();
    let saved = client.read_node("db", &path).await.unwrap().unwrap();
    assert!(saved.content.len() * 10 < inline.len());
    assert_eq!(
        serde_json::from_str::<Value>(&saved.content).unwrap()["schema_version"],
        2
    );
    let mut resumed: StreamState = serde_json::from_str(&saved.content).unwrap();
    assert!(resumed.memories[0].embedding.is_none());
    assert!(resumed.pending.as_ref().unwrap().query_embedding.is_none());
    assert!(
        resumed
            .pending
            .as_ref()
            .unwrap()
            .query_embedding_ref
            .is_some()
    );
    hydrate_embeddings(&client, "db", &path, &mut resumed)
        .await
        .unwrap();
    hydrate_payloads(&client, "db", &path, &mut resumed)
        .await
        .unwrap();
    let restored = resumed.memories[0].embedding.as_ref().unwrap();
    assert_eq!(
        vector.iter().map(|x| x.to_bits()).collect::<Vec<_>>(),
        restored.iter().map(|x| x.to_bits()).collect::<Vec<_>>()
    );
    assert_eq!(
        cosine(&vector, &vector).unwrap(),
        cosine(&vector, restored).unwrap()
    );
    assert_eq!(resumed.memories[0].original, state.memories[0].original);
    assert_eq!(
        resumed.pending.as_ref().unwrap().decision_started,
        state.pending.as_ref().unwrap().decision_started
    );
    assert_eq!(
        resumed
            .pending
            .as_ref()
            .unwrap()
            .query_embedding
            .as_ref()
            .unwrap()
            .iter()
            .map(|v| v.to_bits())
            .collect::<Vec<_>>(),
        vector.iter().map(|v| v.to_bits()).collect::<Vec<_>>()
    );
    let reversed: Vec<f64> = vector.iter().copied().rev().collect();
    assert_eq!(
        cosine(&vector, &vector).unwrap() > cosine(&vector, &reversed).unwrap(),
        cosine(restored, &vector).unwrap() > cosine(restored, &reversed).unwrap()
    );
    let mut stale = Some("stale-etag".to_owned());
    let mut competing = resumed.clone();
    competing.binding = "competing-controller".into();
    assert!(
        checkpoint_state(&client, "db", &path, &mut competing, &mut stale)
            .await
            .is_err()
    );
    assert_eq!(
        client.read_node("db", &path).await.unwrap().unwrap().etag,
        etag.clone().unwrap()
    );
    let mut missing = resumed.clone();
    missing.memories[0].embedding_ref.as_mut().unwrap().sha256 = "0".repeat(64);
    assert!(
        hydrate_embeddings(&client, "db", &path, &mut missing)
            .await
            .is_err()
    );
    println!(
        "inline bytes={}, checkpoint bytes={}",
        inline.len(),
        saved.content.len()
    );
    let reference = resumed.memories[0].embedding_ref.clone().unwrap();
    resumed.memories[0]
        .embedding_ref
        .as_mut()
        .unwrap()
        .dimensions += 1;
    assert!(
        hydrate_embeddings(&client, "db", &path, &mut resumed)
            .await
            .is_err()
    );
    resumed.memories[0].embedding_ref = Some(reference.clone());
    let blob_path = embedding_path(&path, &reference).unwrap();
    let node = client.read_node("db", &blob_path).await.unwrap().unwrap();
    client
        .write_node(WriteNodeRequest {
            database_id: "db".into(),
            path: blob_path,
            kind: NodeKind::File,
            content: "tampered".into(),
            metadata_json: "{}".into(),
            expected_etag: Some(node.etag),
        })
        .await
        .unwrap();
    assert!(
        hydrate_embeddings(&client, "db", &path, &mut resumed)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn payload_sidecars_preserve_large_sources_contexts_and_reservations() {
    let temp = tempfile::tempdir().unwrap();
    let client = StoreClient::new(temp.path());
    let path = state_path("00000000000000000000000000000000", "payload").unwrap();
    let original = json!({"query":"original", "observations":"日本語\n\"exact\"".repeat(14000)});
    let context = serde_json::to_string(&vec![original.clone(); 3]).unwrap();
    let value = json!({"schema_version":1,"binding":"same","memories":[{"id":"a","query":"original","original":original,"reflection":"source-grounded","embedding":null}],"steps":[{"task_id":"a","success":true,"selected_ids":[],"supplied_context":context,"decision_elapsed_ms":1,"revision_elapsed_ms":0,"write_elapsed_ms":0,"model_calls":1,"input_tokens":null,"output_tokens":null}],"pending":{"index":1,"selected":[],"context":context,"query_embedding":null,"decision_started":{"owner":"existing"},"inference_started":null,"trajectory":original,"success":false,"calls":[],"revised":[],"fresh":null}});
    let mut state: StreamState = serde_json::from_value(value.clone()).unwrap();
    let original_bytes = serde_json::to_string(&state).unwrap().len();
    assert!(original_bytes > 900_000);
    hydrate_payloads(&client, "db", &path, &mut state)
        .await
        .unwrap(); // legacy inline
    let mut etag = None;
    checkpoint_state(&client, "db", &path, &mut state, &mut etag)
        .await
        .unwrap();
    let saved = client.read_node("db", &path).await.unwrap().unwrap();
    assert!(saved.content.len() * 10 < original_bytes);
    assert_eq!(
        serde_json::from_str::<Value>(&saved.content).unwrap()["schema_version"],
        2
    );
    let mut resumed: StreamState = serde_json::from_str(&saved.content).unwrap();
    assert!(resumed.memories[0].original.is_null());
    assert_eq!(resumed.steps[0].supplied_context, "");
    assert!(resumed.pending.as_ref().unwrap().trajectory.is_none());
    hydrate_payloads(&client, "db", &path, &mut resumed)
        .await
        .unwrap();
    assert_eq!(
        resumed.memories[0].original,
        value["memories"][0]["original"]
    );
    assert_eq!(resumed.steps[0].supplied_context, context);
    assert_eq!(resumed.pending.as_ref().unwrap().context, context);
    assert_eq!(resumed.pending.as_ref().unwrap().trajectory, Some(original));
    assert_eq!(
        resumed.pending.as_ref().unwrap().decision_started,
        Some(json!({"owner":"existing"}))
    );
    let reference = resumed.memories[0].original_ref.clone().unwrap();
    assert!(reference.chunks.len() > 1);
    assert!(
        load_payload(
            &client,
            "db",
            &state_path("00000000000000000000000000000000", "other").unwrap(),
            &reference
        )
        .await
        .is_err()
    );
    let mut invalid = reference.clone();
    invalid.sha256 = "../outside".into();
    assert!(load_payload(&client, "db", &path, &invalid).await.is_err());
    invalid = reference.clone();
    invalid.chunks.pop();
    assert!(load_payload(&client, "db", &path, &invalid).await.is_err());
    invalid = reference.clone();
    invalid.bytes = usize::MAX;
    assert!(load_payload(&client, "db", &path, &invalid).await.is_err());
    let blob_path = payload_path(&path, &reference.chunks[0].sha256).unwrap();
    let node = client.read_node("db", &blob_path).await.unwrap().unwrap();
    client
        .write_node(WriteNodeRequest {
            database_id: "db".into(),
            path: blob_path,
            kind: NodeKind::File,
            content: "tampered".into(),
            metadata_json: "{}".into(),
            expected_etag: Some(node.etag),
        })
        .await
        .unwrap();
    assert!(
        hydrate_payloads(&client, "db", &path, &mut resumed)
            .await
            .is_err()
    );
    println!(
        "large inline bytes={original_bytes}, payload checkpoint bytes={}",
        saved.content.len()
    );
}

#[test]
fn stream_schema_accepts_legacy_and_rejects_unknown() {
    assert!(validate_stream_schema(1).is_ok());
    assert!(validate_stream_schema(2).is_ok());
    assert!(validate_stream_schema(0).is_err());
    assert!(validate_stream_schema(3).is_err());
}

#[tokio::test]
async fn numeric_source_sidecar_roundtrips_and_can_checkpoint_again() {
    let temp = tempfile::tempdir().unwrap();
    let client = StoreClient::new(temp.path());
    let path = state_path("00000000000000000000000000000000", "numeric").unwrap();
    let original = json!({"argument":0.0022268627749602986_f64});
    let mut memory = entry("a", "query", "reflection");
    memory.original = original.clone();
    let mut state = StreamState {
        schema_version: 1,
        binding: "legacy".into(),
        memories: vec![memory],
        steps: vec![],
        pending: None,
    };
    let mut etag = None;
    checkpoint_state(&client, "db", &path, &mut state, &mut etag)
        .await
        .unwrap();
    let node = client.read_node("db", &path).await.unwrap().unwrap();
    let mut resumed: StreamState = serde_json::from_str(&node.content).unwrap();
    hydrate_payloads(&client, "db", &path, &mut resumed)
        .await
        .unwrap();
    assert_eq!(resumed.memories[0].original, original);
    checkpoint_state(&client, "db", &path, &mut resumed, &mut etag)
        .await
        .unwrap();
}

#[test]
fn memory_execution_rejects_observed_tools_and_accepts_plain_messages() {
    let execution = |events, complete| Execution {
        events,
        output: r#"{"reflection":"source only"}"#.into(),
        exit_reason: "completed".into(),
        complete,
        elapsed_ms: 1,
        input_tokens: None,
        output_tokens: None,
    };
    for kind in [
        "command_execution",
        "file_change",
        "mcp_tool_call",
        "web_search",
        "image_generation",
        "collab_tool_call",
        "future_tool",
    ] {
        for phase in ["item.started", "item.updated", "item.completed"] {
            let result = execution(vec![json!({"type":phase,"item":{"type":kind}})], true);
            assert!(
                validate_memory_execution(&result, "revision").is_err(),
                "accepted {kind} in {phase}"
            );
        }
    }
    for kind in ["tool/call", "tool/result"] {
        let result = execution(
            vec![
                json!({"jsonrpc":"2.0","method":"session.event","params":{"sessionId":"owned","event":{"type":kind,"data":{"name":"bash"}}}}),
            ],
            true,
        );
        assert!(validate_memory_execution(&result, "write").is_err());
    }
    let benign = execution(
        vec![
            json!({"type":"item.completed","item":{"type":"reasoning","text":"private"}}),
            json!({"type":"item.completed","item":{"type":"agent_message","text":"tool/call is just quoted text"}}),
            json!({"jsonrpc":"2.0","method":"session.event","params":{"event":{"type":"assistant/message","data":{"message":{"content":[{"type":"text","text":"answer"}]}}}}}),
        ],
        true,
    );
    assert!(validate_memory_execution(&benign, "write").is_ok());
    assert!(validate_memory_execution(&execution(vec![], false), "revision").is_err());
}

#[tokio::test]
async fn memory_infer_rejects_tool_assisted_json_before_adoption() {
    use std::os::unix::fs::PermissionsExt;
    let temp = tempfile::tempdir().unwrap();
    let script = temp.path().join("memory-agent.py");
    std::fs::write(&script,r#"#!/usr/bin/env python3
import json,os,sys
sys.stdin.read()
if os.environ.get('OBSERVED_TOOL'):
 print(json.dumps({'type':'item.completed','item':{'type':'command_execution','command':'cat external.txt','aggregated_output':'external evidence','exit_code':0}}))
print(json.dumps({'type':'item.completed','item':{'type':'agent_message','text':'{"reflection":"apparently valid memory"}'}}))
print(json.dumps({'type':'turn.completed','usage':{'input_tokens':1,'output_tokens':1}}))
"#).unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
    let mut config = RunnerConfig {
        executable: script,
        model: Some("scripted-test-only".into()),
        ..Default::default()
    };
    config
        .environment
        .insert("OBSERVED_TOOL".into(), "1".into());
    let failure = infer(&config, temp.path(), "source only", "reflection", "write")
        .await
        .unwrap_err();
    assert!(failure.to_string().contains("observed tool"));
    let diagnostic: Value =
        serde_json::from_slice(&std::fs::read(temp.path().join("failure.json")).unwrap()).unwrap();
    assert_eq!(diagnostic["phase"], "execution_validation");
    assert_eq!(diagnostic["input_tokens"], 1);
    assert_eq!(diagnostic["output_tokens"], 1);
    config.environment.remove("OBSERVED_TOOL");
    let clean = infer(&config, temp.path(), "source only", "reflection", "write")
        .await
        .unwrap();
    assert_eq!(clean.output, "apparently valid memory");
}

// Removing failure persistence or copying provider envelopes loses actionable
// cause or leaks private data; exercise the real infer/runner subprocess path.
#[cfg(unix)]
#[tokio::test]
async fn memory_infer_persists_only_safe_correlated_failure_diagnostics() {
    use std::os::unix::fs::PermissionsExt;
    for (mode, expected, category) in [
        ("quota", "turn_error", "QUOTA"),
        ("hostile", "unknown", "unknown"),
        ("timeout", "timeout", "unknown"),
        ("child", "turn_error", "unknown"),
        ("invalid", "completed", "unknown"),
        ("success", "completed", "unknown"),
        ("launch", "unavailable", "unknown"),
    ] {
        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("sdk.py");
        std::fs::write(&script, r#"#!/usr/bin/env python3
import sys,json,time,os
def emit(x): print(json.dumps(x),flush=True)
def event(s,t,d): emit({'jsonrpc':'2.0','method':'session.event','params':{'sessionId':s,'event':{'type':t,'data':d}}})
i=json.loads(sys.stdin.readline());emit({'jsonrpc':'2.0','id':1,'result':{'serverInfo':{'name':'deepseek-harness-sdk-runtime'}}})
p=json.loads(sys.stdin.readline());s=p['params']['sessionId'];mode=os.environ['MODE']
emit({'jsonrpc':'2.0','id':2,'result':{'messageId':'private-request-id'}})
event(s,'agent/inbox/spliced',{'inserted':[{'id':'private-request-id'}]})
if mode=='timeout': time.sleep(10)
error={'code':'QUOTA','status':402,'message':'secret-error-text bearer-secret private-request-id'}
if mode=='child':
 emit({'jsonrpc':'2.0','method':'subagent.started','params':{'parentSessionId':s,'childSessionId':'child'}})
 event('child','turn/end',{'reason':{'kind':'error','error':error}})
 error={'code':'hostile-secret','status':'402'}
kind='completed' if mode in ['success','invalid'] else ('hostile-secret' if mode=='hostile' else 'error')
if mode=='hostile': error={'code':'hostile-secret','status':9999}
answer='{"reflection":"ok"}' if mode=='success' else 'private-model-output'
event(s,'assistant/message',{'message':{'content':[{'type':'text','text':answer},{'type':'reasoning','text':'private-reasoning'}]},'usage':{'inputTokens':3,'outputTokens':2}})
event(s,'turn/end',{'reason':{'kind':kind,'error':error}})
emit({'jsonrpc':'2.0','method':'session.status','params':{'sessionId':s,'status':'idle'}})
sys.stdin.read()
"#).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
        let config = RunnerConfig {
            engine: crate::learning_runner::AgentEngine::Dsh,
            executable: if mode == "launch" {
                temp.path().join("missing-secret-path")
            } else {
                script
            },
            timeout_seconds: 1,
            environment: [("MODE".into(), mode.into())].into(),
            ..Default::default()
        };
        let result = infer(
            &config,
            temp.path(),
            "private-prompt",
            "reflection",
            "write",
        )
        .await;
        let artifact = temp.path().join("failure.json");
        if mode == "success" {
            assert_eq!(result.unwrap().output, "ok");
            assert!(!artifact.exists());
            continue;
        }
        assert!(result.is_err());
        assert!(artifact.exists(), "missing failure artifact for {mode}");
        let bytes = std::fs::read_to_string(artifact).unwrap();
        for secret in ["secret", "private-", "bearer", "messageId", "reasoning"] {
            assert!(
                !bytes.contains(secret),
                "diagnostic leaked {secret} for {mode}"
            );
        }
        let diagnostic: Value = serde_json::from_str(&bytes).unwrap();
        assert_eq!(diagnostic["exit_reason"], expected, "{mode}");
        assert_eq!(diagnostic["provider_category"], category, "{mode}");
        assert_eq!(
            diagnostic["http_status"],
            if mode == "quota" {
                json!(402)
            } else {
                Value::Null
            },
            "{mode}"
        );
        assert_eq!(diagnostic["role"], "write");
        assert_eq!(
            diagnostic["phase"],
            if mode == "invalid" {
                "output_validation"
            } else if mode == "launch" {
                "launch_or_configuration"
            } else {
                "execution"
            }
        );
    }
}

#[cfg(unix)]
#[tokio::test]
async fn memory_infer_failure_preserves_existing_files_and_original_error() {
    use std::os::unix::fs::symlink;
    for path in ["failure.json", "failure.json.pending"] {
        for link in [false, true] {
            let temp = tempfile::tempdir().unwrap();
            let target = temp.path().join("keep.txt");
            std::fs::write(&target, "preserve me").unwrap();
            let reserved = temp.path().join(path);
            if link {
                symlink(&target, &reserved).unwrap();
            } else {
                std::fs::write(&reserved, "preserve me").unwrap();
            }
            let config = RunnerConfig {
                timeout_seconds: 0,
                ..Default::default()
            };
            let error = infer(&config, temp.path(), "private", "reflection", "revision")
                .await
                .unwrap_err();
            assert!(
                error
                    .to_string()
                    .contains("diagnostic could not be persisted")
            );
            assert!(
                error
                    .chain()
                    .any(|e| e.to_string().contains("timeout_seconds must be positive"))
            );
            assert_eq!(std::fs::read_to_string(&reserved).unwrap(), "preserve me");
            assert_eq!(std::fs::read_to_string(&target).unwrap(), "preserve me");
        }
    }
}

#[test]
fn paired_contexts_freeze_new_reflection_order_and_originals() {
    let history = paired::History {
        selected: vec![paired::HistoricalMemory {
            id: "old".into(),
            query: "q".into(),
            original: json!({"checks": [false,false]}),
            reflection: "one passed".into(),
        }],
        latest: json!({"id":"later","observations":"changed scope"}),
        new_reflection: "SHARED_NEW".into(),
    };
    let contexts = paired::contexts(&history, &["zero passed".into()], 10000).unwrap();
    let frozen: Value = serde_json::from_str(&contexts[&EvaluationMode::Current].content).unwrap();
    let revised: Value =
        serde_json::from_str(&contexts[&EvaluationMode::Revision].content).unwrap();
    assert_eq!(frozen["new_reflection"], revised["new_reflection"]);
    assert_eq!(frozen["memories"][0]["id"], revised["memories"][0]["id"]);
    assert_eq!(frozen["memories"][0]["reflection"], "one passed");
    assert_eq!(revised["memories"][0]["reflection"], "zero passed");
    assert!(contexts[&EvaluationMode::Raw].content.contains("false"));
    assert!(paired::contexts(&history, &[], 10000).is_err());
    assert!(paired::contexts(&history, &["long".repeat(100)], 50).is_err());
    let mut duplicate = history.clone();
    duplicate.selected.push(duplicate.selected[0].clone());
    assert!(paired::contexts(&duplicate, &["a".into(), "b".into()], 10000).is_err());
}

#[test]
fn selective_revision_requires_complete_anchored_decisions() {
    let h: paired::History = serde_json::from_value(json!({"selected":[
        {"id":"a","query":"old","original":{"checks":[false]},"reflection":"passed"},
        {"id":"b","query":"other","original":{"rule":"unchanged"},"reflection":"unchanged"}],
        "latest":{"rule":"new"},"new_reflection":"shared"}))
    .unwrap();
    let rows = json!([
        {"memory_id":"b","action":"keep","reason":"Matches original, unrelated to new evidence","evidence":[{"source":"original","pointer":"/rule","quote":"unchanged"}]},
        {"memory_id":"a","action":"uncertain","reason":"Check contradicts claim","evidence":[{"source":"original","pointer":"/checks/0","quote":"false"}]}]);
    let result = paired::parse_selection(&h, &rows.to_string()).unwrap();
    assert_eq!(
        result
            .iter()
            .map(|r| r.requires_revision())
            .collect::<Vec<_>>(),
        vec![true, false]
    );
    for bad in [json!([]), json!([rows[0].clone(), rows[0].clone()])] {
        assert!(paired::parse_selection(&h, &bad.to_string()).is_err());
    }
    let mut bad = rows.clone();
    bad[1]["evidence"][0]["quote"] = json!("true");
    assert!(paired::parse_selection(&h, &bad.to_string()).is_err());
    bad = rows.clone();
    bad[1]["evidence"][0]["pointer"] = json!("/missing");
    assert!(paired::parse_selection(&h, &bad.to_string()).is_err());
    bad = rows.clone();
    bad[0]["reason"] = json!("");
    assert!(paired::parse_selection(&h, &bad.to_string()).is_err());
    bad = rows.clone();
    bad[0]["evidence"] = json!([]);
    assert!(paired::parse_selection(&h, &bad.to_string()).is_err());
}

#[test]
fn selector_redaction_preserves_json_and_reports_failed_usage() {
    let output=json!({"selection":json!([{"memory_id":"a","action":"keep","reason":"supported","evidence":[{"source":"original","pointer":"/message","quote":"Authorization: [REDACTED]"}]}])}).to_string();
    let result = paired::sanitize_selection(&output, &RunnerConfig::default()).unwrap();
    let rows: Value = serde_json::from_str(&result).unwrap();
    assert_eq!(rows[0]["evidence"][0]["quote"], "Authorization: [REDACTED]");
    assert!(paired::sanitize_selection(r#"{"wrong":[]}"#, &RunnerConfig::default()).is_err());
}
