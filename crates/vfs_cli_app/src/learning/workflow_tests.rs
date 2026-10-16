use super::super::integration_tests::StoreClient;
use super::*;
use std::sync::atomic::Ordering;

fn connection() -> ResolvedConnection {
    ResolvedConnection {
        replica_host: "http://localhost:4943".into(),
        canister_id: "canister".into(),
        database_id: Some("db".into()),
        replica_host_source: "test".into(),
        canister_id_source: "test".into(),
        database_id_source: Some("test".into()),
    }
}
fn state(root: &Path) -> StateArgs {
    StateArgs {
        state_dir: Some(root.into()),
        json: true,
    }
}

#[test]
fn attestations_reject_changed_payload_and_different_connection_scope() {
    let root = tempfile::tempdir().unwrap();
    let client = StoreClient::new(root.path());
    let connection = connection();
    let mut record = json!({"candidate_hash":"candidate", "grounded":true, "report":{"checks":[0]}, "attestation":""});
    record["attestation"] = json!(attest(&record, root.path(), &connection, &client).unwrap());
    verify_attestation(&record, root.path(), &connection, &client).unwrap();
    let mut changed = record.clone();
    changed["report"]["checks"][0] = json!(1);
    assert!(verify_attestation(&changed, root.path(), &connection, &client).is_err());
    let mut forged = record.clone();
    forged["attestation"] = json!("00".repeat(32));
    assert!(verify_attestation(&forged, root.path(), &connection, &client).is_err());
    let mut other_database = connection.clone();
    other_database.database_id = Some("other".into());
    assert!(verify_attestation(&record, root.path(), &other_database, &client).is_err());
    let mut other_endpoint = connection.clone();
    other_endpoint.replica_host = "https://other.invalid".into();
    assert!(verify_attestation(&record, root.path(), &other_endpoint, &client).is_err());
}

async fn signed_intent(client: &StoreClient, local: &Path) -> (String, String, String) {
    client
        .write_node(WriteNodeRequest {
            database_id: "db".into(),
            path: "/Knowledge/lesson.md".into(),
            kind: NodeKind::File,
            content: "original advice".into(),
            metadata_json: r#"{"authority":"agent"}"#.into(),
            expected_etag: None,
        })
        .await
        .unwrap();
    let original = client
        .read_node("db", "/Knowledge/lesson.md")
        .await
        .unwrap()
        .unwrap();
    let source = reference(client, "db", &original.path).await.unwrap();
    let target = WriteNodeItem {
        path: original.path.clone(),
        kind: original.kind.clone(),
        content: "revised advice".into(),
        metadata_json: original.metadata_json.clone(),
        expected_etag: Some(original.etag.clone()),
    };
    let candidate = RevisionCandidate {
        project_id: None,
        historical_evidence: vec![source.clone()],
        id: "candidate".into(),
        source_run: "run".into(),
        operation: "correct".into(),
        rationale: "source-backed correction".into(),
        targets: vec![target.clone()],
        evidence: vec![source.clone()],
        baseline: vec![original.clone()],
        dependency_paths: vec![],
    };
    let fingerprint = candidate.fingerprint().unwrap();
    let candidate_path = format!("/Sources/learning-candidates/{fingerprint}.json");
    write_immutable(
        client,
        "db",
        &candidate_path,
        &serde_json::to_string(&candidate).unwrap(),
    )
    .await
    .unwrap();
    let evaluation_path = "/Sources/learning-evaluations/trusted.json".to_string();
    let mut intent = PublicationIntent {
        candidate,
        request: LearningPublicationRequest {
            scope_guards: vec![ScopeRevisionGuard {
                prefix: "/Knowledge".into(),
                revision: client.store.scope_revision("/Knowledge").unwrap(),
            }],
            database_id: "db".into(),
            operation_id: fingerprint.clone(),
            targets: vec![target],
            evidence: vec![source],
        },
        evaluation_path: evaluation_path.clone(),
        preimages: vec![original],
        attestation: String::new(),
    };
    intent.attestation = attest(&intent, local, &connection(), client).unwrap();
    let intent_path = publication_intent_path(&fingerprint, &evaluation_path);
    write_immutable(
        client,
        "db",
        &intent_path,
        &serde_json::to_string(&intent).unwrap(),
    )
    .await
    .unwrap();
    (
        candidate_path,
        evaluation_path,
        format!("/Sources/learning-publications/{fingerprint}.json"),
    )
}

#[tokio::test]
async fn promotion_replays_exact_signed_intent_after_committed_response_is_lost() {
    let root = tempfile::tempdir().unwrap();
    let client = StoreClient::new(root.path());
    let local = root.path().join("local");
    let (candidate_path, evaluation_path, publication_path) = signed_intent(&client, &local).await;
    client.fail_after_publication.store(true, Ordering::SeqCst);
    let command = || LearnCommand::Promote {
        candidate_path: candidate_path.clone(),
        evaluation_path: evaluation_path.clone(),
        state: state(&local),
    };
    assert!(
        run_learn(&client, &connection(), command())
            .await
            .unwrap_err()
            .to_string()
            .contains("lost publication response")
    );
    let committed = client
        .current_node_revision(NodeRevisionRequest {
            database_id: "db".into(),
            path: "/Knowledge/lesson.md".into(),
        })
        .await
        .unwrap()
        .unwrap();
    assert_eq!(committed.node.content, "revised advice");
    run_learn(&client, &connection(), command()).await.unwrap();
    let replayed = client
        .current_node_revision(NodeRevisionRequest {
            database_id: "db".into(),
            path: "/Knowledge/lesson.md".into(),
        })
        .await
        .unwrap()
        .unwrap();
    assert_eq!(committed, replayed);
    let publication: Publication = remote_json(&client, "db", &publication_path).await.unwrap();
    verify_attestation(&publication, &local, &connection(), &client).unwrap();
    assert_eq!(publication.preimages[0].content, "original advice");
}

#[tokio::test]
async fn rejected_scope_attempt_allows_fresh_evaluation_but_committed_candidate_cannot_change() {
    let root = tempfile::tempdir().unwrap();
    let client = StoreClient::new(root.path());
    let local = root.path().join("local");
    let (candidate_path, old_evaluation, publication_path) = signed_intent(&client, &local).await;
    let candidate: RevisionCandidate = remote_json(&client, "db", &candidate_path).await.unwrap();
    let fingerprint = candidate.fingerprint().unwrap();
    let old_path = publication_intent_path(&fingerprint, &old_evaluation);
    let old_node = client.read_node("db", &old_path).await.unwrap().unwrap();
    let mut attempt: PublicationIntent = serde_json::from_str(&old_node.content).unwrap();

    client
        .write_node(WriteNodeRequest {
            database_id: "db".into(),
            path: "/Knowledge/unrelated.md".into(),
            kind: NodeKind::File,
            content: "new knowledge changes retrieval".into(),
            metadata_json: r#"{"authority":"agent"}"#.into(),
            expected_etag: None,
        })
        .await
        .unwrap();
    let promote = |evaluation_path: String| LearnCommand::Promote {
        candidate_path: candidate_path.clone(),
        evaluation_path,
        state: state(&local),
    };
    let rejected = run_learn(&client, &connection(), promote(old_evaluation.clone()))
        .await
        .unwrap_err();
    assert!(rejected.to_string().contains("retrieval scope changed"));
    assert_eq!(
        client
            .read_node("db", "/Knowledge/lesson.md")
            .await
            .unwrap()
            .unwrap()
            .content,
        "original advice"
    );
    assert!(
        client
            .read_node("db", &publication_path)
            .await
            .unwrap()
            .is_none()
    );

    // Model the durable intent produced by a fresh eligible evaluation. It has
    // its own signed scope snapshot but reserves the same candidate operation.
    let fresh_evaluation = "/Sources/learning-evaluations/fresh.json".to_string();
    attempt.evaluation_path = fresh_evaluation.clone();
    attempt.request.scope_guards[0].revision = client.store.scope_revision("/Knowledge").unwrap();
    assert_eq!(attempt.request.operation_id, fingerprint);
    attempt.attestation = attest(&attempt, &local, &connection(), &client).unwrap();
    let fresh_path = publication_intent_path(&fingerprint, &fresh_evaluation);
    assert_ne!(old_path, fresh_path);
    write_immutable(
        &client,
        "db",
        &fresh_path,
        &serde_json::to_string(&attempt).unwrap(),
    )
    .await
    .unwrap();
    run_learn(&client, &connection(), promote(fresh_evaluation.clone()))
        .await
        .unwrap();
    let committed = reference(&client, "db", "/Knowledge/lesson.md")
        .await
        .unwrap();
    let publication: Publication = remote_json(&client, "db", &publication_path).await.unwrap();
    assert_eq!(publication.evaluation_path, fresh_evaluation);
    assert_eq!(publication.result.operation_id, fingerprint);
    assert_eq!(
        client
            .read_node("db", &old_path)
            .await
            .unwrap()
            .unwrap()
            .content,
        old_node.content
    );

    run_learn(&client, &connection(), promote(fresh_evaluation))
        .await
        .unwrap();
    assert_eq!(
        reference(&client, "db", "/Knowledge/lesson.md")
            .await
            .unwrap(),
        committed
    );

    // A different, correctly signed attempt must not commit after the first
    // success, even when its scope and target guards match current state.
    let other_evaluation = "/Sources/learning-evaluations/other.json".to_string();
    attempt.evaluation_path = other_evaluation.clone();
    attempt.request.scope_guards[0].revision = client.store.scope_revision("/Knowledge").unwrap();
    attempt.request.targets[0].expected_etag = Some(committed.etag.clone());
    attempt.request.evidence = vec![committed.clone()];
    attempt.attestation = attest(&attempt, &local, &connection(), &client).unwrap();
    write_immutable(
        &client,
        "db",
        &publication_intent_path(&fingerprint, &other_evaluation),
        &serde_json::to_string(&attempt).unwrap(),
    )
    .await
    .unwrap();
    let rejected = run_learn(&client, &connection(), promote(other_evaluation))
        .await
        .unwrap_err();
    assert!(
        rejected
            .to_string()
            .contains("operation id reused with different payload")
    );
    assert_eq!(
        reference(&client, "db", "/Knowledge/lesson.md")
            .await
            .unwrap(),
        committed
    );
}

#[tokio::test]
async fn tampered_intent_and_rollback_preimages_cannot_authorize_writes() {
    let root = tempfile::tempdir().unwrap();
    let client = StoreClient::new(root.path());
    let local = root.path().join("local");
    let (candidate_path, evaluation_path, publication_path) = signed_intent(&client, &local).await;
    let candidate: RevisionCandidate = remote_json(&client, "db", &candidate_path).await.unwrap();
    let intent_path = publication_intent_path(&candidate.fingerprint().unwrap(), &evaluation_path);
    let stored_intent = client.read_node("db", &intent_path).await.unwrap().unwrap();
    let mut intent: PublicationIntent = serde_json::from_str(&stored_intent.content).unwrap();
    intent.request.targets[0].content = "forged advice".into();
    let overwritten = client
        .write_node(WriteNodeRequest {
            database_id: "db".into(),
            path: intent_path.clone(),
            kind: NodeKind::Source,
            content: serde_json::to_string(&intent).unwrap(),
            metadata_json: stored_intent.metadata_json.clone(),
            expected_etag: Some(stored_intent.etag),
        })
        .await
        .unwrap();
    let command = || LearnCommand::Promote {
        candidate_path: candidate_path.clone(),
        evaluation_path: evaluation_path.clone(),
        state: state(&local),
    };
    assert!(run_learn(&client, &connection(), command()).await.is_err());
    assert_eq!(
        client
            .read_node("db", "/Knowledge/lesson.md")
            .await
            .unwrap()
            .unwrap()
            .content,
        "original advice"
    );
    client
        .write_node(WriteNodeRequest {
            database_id: "db".into(),
            path: intent_path,
            kind: NodeKind::Source,
            content: stored_intent.content,
            metadata_json: stored_intent.metadata_json,
            expected_etag: Some(overwritten.node.etag),
        })
        .await
        .unwrap();
    run_learn(&client, &connection(), command()).await.unwrap();
    let stored_publication = client
        .read_node("db", &publication_path)
        .await
        .unwrap()
        .unwrap();
    let mut publication: Publication = serde_json::from_str(&stored_publication.content).unwrap();
    publication.preimages[0].content = "forged rollback advice".into();
    client
        .write_node(WriteNodeRequest {
            database_id: "db".into(),
            path: publication_path.clone(),
            kind: NodeKind::Source,
            content: serde_json::to_string(&publication).unwrap(),
            metadata_json: stored_publication.metadata_json,
            expected_etag: Some(stored_publication.etag),
        })
        .await
        .unwrap();
    assert!(
        run_learn(
            &client,
            &connection(),
            LearnCommand::Rollback {
                publication_path,
                state: state(&local)
            }
        )
        .await
        .is_err()
    );
    assert_eq!(
        client
            .read_node("db", "/Knowledge/lesson.md")
            .await
            .unwrap()
            .unwrap()
            .content,
        "revised advice"
    );
}

#[tokio::test]
async fn rollback_replays_exact_signed_request_after_committed_response_is_lost() {
    let root = tempfile::tempdir().unwrap();
    let client = StoreClient::new(root.path());
    let local = root.path().join("local");
    let (candidate_path, evaluation_path, publication_path) = signed_intent(&client, &local).await;
    run_learn(
        &client,
        &connection(),
        LearnCommand::Promote {
            candidate_path,
            evaluation_path,
            state: state(&local),
        },
    )
    .await
    .unwrap();
    client.fail_after_publication.store(true, Ordering::SeqCst);
    let command = || LearnCommand::Rollback {
        publication_path: publication_path.clone(),
        state: state(&local),
    };
    assert!(
        run_learn(&client, &connection(), command())
            .await
            .unwrap_err()
            .to_string()
            .contains("lost publication response")
    );
    let restored = client
        .current_node_revision(NodeRevisionRequest {
            database_id: "db".into(),
            path: "/Knowledge/lesson.md".into(),
        })
        .await
        .unwrap()
        .unwrap();
    assert_eq!(restored.node.content, "original advice");
    run_learn(&client, &connection(), command()).await.unwrap();
    let replayed = client
        .current_node_revision(NodeRevisionRequest {
            database_id: "db".into(),
            path: "/Knowledge/lesson.md".into(),
        })
        .await
        .unwrap()
        .unwrap();
    assert_eq!(restored, replayed);
}

#[test]
fn recall_environment_uses_explicit_repository_instead_of_callers_directory() {
    let root = tempfile::tempdir().unwrap();
    let client = StoreClient::new(root.path());
    let target = root.path().join("task-repository");
    std::fs::create_dir(&target).unwrap();
    std::fs::write(
        target.join("Cargo.toml"),
        "[package]\nname='target-task'\nversion='1.0.0'\n",
    )
    .unwrap();
    let config = root.path().join("recall.json");
    std::fs::write(&config, r#"{"budget_tokens":100}"#).unwrap();
    let opts = load_recall(
        &config,
        "task",
        &client,
        &connection(),
        &state(root.path()),
        &target,
        None,
    )
    .unwrap();
    assert!(opts.environment.iter().any(|v| v.contains("target-task")));
    assert!(
        opts.environment
            .iter()
            .any(|v| v == &target.display().to_string())
    );
    assert!(
        !opts
            .environment
            .iter()
            .any(|v| v.contains("kinic-wiki-monorepo"))
    );
}

#[tokio::test]
async fn evaluated_mutation_set_contains_dependency_invalidations() {
    let root = tempfile::tempdir().unwrap();
    let client = StoreClient::new(root.path());
    let local = root.path().join("local");
    let (candidate_path, _, _) = signed_intent(&client, &local).await;
    let mut candidate: RevisionCandidate =
        remote_json(&client, "db", &candidate_path).await.unwrap();
    client
        .write_node(WriteNodeRequest {
            database_id: "db".into(),
            path: "/Knowledge/dependent.md".into(),
            kind: NodeKind::File,
            content: "derived advice".into(),
            metadata_json: r#"{"authority":"agent"}"#.into(),
            expected_etag: None,
        })
        .await
        .unwrap();
    candidate
        .dependency_paths
        .push("/Knowledge/dependent.md".into());
    let targets = effective_targets(&client, "db", &candidate).await.unwrap();
    assert_eq!(targets.len(), 2);
    let dependency = targets
        .iter()
        .find(|t| t.path.ends_with("dependent.md"))
        .unwrap();
    let metadata: Value = serde_json::from_str(&dependency.metadata_json).unwrap();
    assert_eq!(metadata["state"], "invalidated");
    assert!(dependency.expected_etag.is_some());
    assert_eq!(
        client
            .read_node("db", "/Knowledge/dependent.md")
            .await
            .unwrap()
            .unwrap()
            .metadata_json,
        r#"{"authority":"agent"}"#
    );
}

#[test]
fn engine_only_run_uses_legacy_recall_while_explicit_runner_keeps_empty_context() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(
        root.path().join(".kinic-learning.json"),
        r#"{"budget_tokens":2048}"#,
    )
    .unwrap();
    let config =
        crate::agent_config::AgentConfig::load(root.path(), &root.path().join("home")).unwrap();
    assert!(run_needs_recall(&config, None, None).unwrap());
    assert!(!run_needs_recall(&config, Some(Path::new("runner.json")), None).unwrap());
    assert!(
        run_needs_recall(
            &config,
            Some(Path::new("runner.json")),
            Some(Path::new("recall.json"))
        )
        .unwrap()
    );
}
#[tokio::test]
async fn hook_rejects_different_actual_caller_binding_before_any_record_or_queue_write() {
    let root = tempfile::tempdir().unwrap();
    let client = StoreClient::new(root.path());
    let state_path = root.path().join("no-queue");
    let c = connection();
    std::fs::write(
        root.path().join(".kinic-learning.json"),
        r#"{"budget_tokens":2048}"#,
    )
    .unwrap();
    let before = client.status("db").await.unwrap();
    run_agent(&client,&c,AgentCommand::Hook {
        engine:"codex".into(),recall_config:None,cwd:None,
        request:Some(json!({"cwd":root.path(),"session_id":"session","event":"record","run_id":"run","expected_routing_binding":"different-caller"})),
        state:state(&state_path),
    }).await.unwrap();
    assert!(!state_path.exists());
    assert_eq!(client.status("db").await.unwrap(), before);
}

#[tokio::test]
async fn prepared_stdin_settings_reach_real_recall_without_rereading_the_stream() {
    let root = tempfile::tempdir().unwrap();
    let client = StoreClient::new(root.path());
    let resolved=crate::agent_config::AgentConfig::load(root.path(),&root.path().join("home")).unwrap()
        .with_stdin_recall(Some(json!({"budget_tokens":1234,"namespace":"/Knowledge","fts":true,"graph":false,"semantic":false})));
    for run in ["stdin-first", "stdin-second"] {
        let options = load_recall_resolved(
            &resolved,
            Some(Path::new("-")),
            "past decisions",
            &client,
            &connection(),
            &state(&root.path().join("state")),
            root.path(),
            None,
        )
        .unwrap();
        assert_eq!(options.budget_tokens, 1234);
        let receipt = recall(&client, "db", run, &options).await.unwrap();
        assert_eq!(receipt.run_id, run);
    }
    assert!(!root.path().join("-").exists());
}
