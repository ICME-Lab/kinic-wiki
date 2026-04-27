// Where: crates/vfs_cli_app/src/beam_bench/mod.rs
// What: End-to-end BEAM harness for deterministic retrieval and extraction evaluation.
// Why: Retrieval quality must be measurable without coupling the headline metric to model reasoning variance.
mod agent_scoring;
mod answer_match;
pub(crate) mod dataset;
mod deterministic;
mod gold_paths;
mod import;
mod manifest;
mod model;
mod navigation;
mod note_extract;
pub(crate) mod note_support;
mod note_views;
mod notes;
mod plan_extract;
mod prepare;
mod question_types;
mod report;

use anyhow::{Result, anyhow};
use dataset::{BeamConversation, extract_questions, load_dataset};
use import::plan_imported_conversation;
use manifest::{
    PrepareManifest, manifest_path_for_namespace, parse_prepare_manifest,
    validate_manifest_identity,
};
use model::{CodexQuestionContext, run_codex_question};
use navigation::{conversation_index_path, namespace_index_path};
pub use prepare::{BeamPrepareArgs, run_beam_prepare};
use report::{append_result_artifacts, init_streaming_artifacts, load_existing_results};
use serde_json::json;
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::Semaphore;
use tokio::task::JoinSet;
use vfs_cli::connection::ResolvedConnection;
use vfs_client::{CanisterVfsClient, VfsApi};

pub use dataset::BeamQuestionClass;
pub use report::{BenchmarkSummary, FailureReason, QuestionResult, summarize, write_artifacts};

#[derive(Debug, Clone)]
pub struct BeamBenchArgs {
    pub dataset_path: PathBuf,
    pub split: String,
    pub model: String,
    pub output_dir: PathBuf,
    pub eval_mode: BeamBenchEvalMode,
    pub limit: usize,
    pub parallelism: usize,
    pub top_k: u32,
    pub questions_per_conversation: Option<usize>,
    pub question_id: Option<String>,
    pub include_question_classes: Vec<BeamQuestionClass>,
    pub include_tags: Vec<String>,
    pub include_question_types: Vec<String>,
    pub namespace: Option<String>,
    pub codex_bin: PathBuf,
    pub codex_sandbox: String,
    pub resume: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BeamBenchEvalMode {
    RetrievalOnly,
    RetrieveAndExtract,
}

pub async fn run_beam_bench(connection: ResolvedConnection, args: BeamBenchArgs) -> Result<()> {
    let dataset = load_dataset(&args.dataset_path, &args.split, args.limit)?;
    let namespace = args.namespace.clone().unwrap_or_else(default_namespace);
    let config = Arc::new(with_defaults(args));
    let existing_results = if config.resume {
        load_existing_results(&config.output_dir)?
    } else {
        Vec::new()
    };
    let completed_questions = Arc::new(completed_question_keys(&existing_results)?);
    init_streaming_artifacts(&config.output_dir, config.resume)?;
    let validation_client =
        CanisterVfsClient::new(&connection.replica_host, &connection.canister_id).await?;
    validate_prepared_namespace(&validation_client, &namespace, &config.split, &dataset).await?;
    let gate = Arc::new(Semaphore::new(config.parallelism.max(1)));
    let mut tasks = JoinSet::new();

    for conversation in dataset {
        let connection = connection.clone();
        let config = Arc::clone(&config);
        let namespace = namespace.clone();
        let gate = Arc::clone(&gate);
        let completed_questions = Arc::clone(&completed_questions);
        tasks.spawn(async move {
            let _permit = gate.acquire_owned().await?;
            run_conversation_benchmark(
                &connection,
                &config,
                &namespace,
                conversation,
                &completed_questions,
            )
            .await
        });
    }

    let mut results = existing_results;
    while let Some(task) = tasks.join_next().await {
        let question_results =
            task.map_err(|error| anyhow!("benchmark task failed: {error}"))??;
        results.extend(question_results);
    }
    results.sort_by(|left, right| {
        (&left.conversation_id, &left.question_id)
            .cmp(&(&right.conversation_id, &right.question_id))
    });

    let mut summary: BenchmarkSummary = summarize(&results, config.top_k);
    summary.read_only_eval = true;
    write_artifacts(&config.output_dir, &summary, &results)?;
    println!("{}", serde_json::to_string_pretty(&summary)?);
    Ok(())
}

fn with_defaults(mut args: BeamBenchArgs) -> BeamBenchArgs {
    if args.model.trim().is_empty() {
        args.model = "gpt-5.4-mini".to_string();
    }
    if args.include_question_classes.is_empty() && args.include_question_types.is_empty() {
        args.include_question_classes = vec![BeamQuestionClass::Factoid];
    }
    args
}

async fn run_conversation_benchmark(
    connection: &ResolvedConnection,
    config: &BeamBenchArgs,
    namespace: &str,
    conversation: BeamConversation,
    completed_questions: &HashSet<String>,
) -> Result<Vec<QuestionResult>> {
    let client = CanisterVfsClient::new(&connection.replica_host, &connection.canister_id).await?;
    let imported = plan_imported_conversation(namespace, &conversation);
    let mut questions = extract_questions(&conversation)?
        .into_iter()
        .filter(|question| {
            config.include_question_classes.is_empty()
                || config
                    .include_question_classes
                    .contains(&question.question_class)
        })
        .filter(|question| matches_question_filters(config, question))
        .filter(|question| {
            config
                .question_id
                .as_ref()
                .is_none_or(|target| question.question_id == *target)
        })
        .filter(|question| {
            !completed_questions.contains(&completed_question_key(
                &imported.conversation_id,
                &question.question_id,
            ))
        })
        .collect::<Vec<_>>();
    if let Some(limit) = config.questions_per_conversation {
        questions.truncate(limit);
    }
    let mut results = Vec::with_capacity(questions.len());
    for question in questions {
        let result = match config.eval_mode {
            BeamBenchEvalMode::RetrievalOnly => {
                deterministic::run_question(
                    &client,
                    &imported.conversation_id,
                    &imported,
                    question,
                    config.top_k,
                    true,
                    false,
                )
                .await?
            }
            BeamBenchEvalMode::RetrieveAndExtract => {
                let context = CodexQuestionContext {
                    namespace_path: &imported.namespace_path,
                    namespace_index_path: &imported.namespace_index_path,
                    base_path: &imported.base_path,
                    conversation_id: &imported.conversation_id,
                    question_id: &question.question_id,
                    question_type: &question.question_type,
                    question_class: question.question_class,
                    question: &question.query,
                    codex_sandbox: &config.codex_sandbox,
                };
                match run_agent_question(connection, config, context).await {
                    Ok(run) => agent_scoring::score_question(
                        imported.conversation_id.clone(),
                        &imported,
                        question,
                        run,
                    ),
                    Err(error) => {
                        score_legacy_failure(imported.conversation_id.clone(), question, error)
                    }
                }
            }
        };
        append_result_artifacts(&config.output_dir, &result)?;
        results.push(result);
    }
    Ok(results)
}

fn completed_question_key(conversation_id: &str, question_id: &str) -> String {
    format!("{conversation_id}:{question_id}")
}

fn completed_question_keys(results: &[QuestionResult]) -> Result<HashSet<String>> {
    let mut keys = HashSet::with_capacity(results.len());
    for result in results {
        let key = completed_question_key(&result.conversation_id, &result.question_id);
        if !keys.insert(key.clone()) {
            return Err(anyhow!("duplicate existing result: {key}"));
        }
    }
    Ok(keys)
}

async fn validate_prepared_namespace(
    client: &impl VfsApi,
    namespace: &str,
    split: &str,
    dataset: &[BeamConversation],
) -> Result<()> {
    if dataset.is_empty() {
        return Ok(());
    }
    let namespace_index = namespace_index_path(namespace);
    if client.read_node(&namespace_index).await?.is_none() {
        return Err(anyhow!("missing prepare: {}", namespace_index));
    }
    let manifest = read_prepare_manifest(client, namespace).await?;
    validate_manifest_identity(&manifest, namespace, split, dataset)?;
    validate_prepared_notes(client, namespace, dataset, &manifest).await
}

async fn read_prepare_manifest(client: &impl VfsApi, namespace: &str) -> Result<PrepareManifest> {
    let path = manifest_path_for_namespace(namespace);
    let content = client
        .read_node(&path)
        .await?
        .ok_or_else(|| anyhow!("missing prepare: {}", path))?
        .content;
    parse_prepare_manifest(&content)
}

async fn validate_prepared_notes(
    client: &impl VfsApi,
    namespace: &str,
    dataset: &[BeamConversation],
    manifest: &PrepareManifest,
) -> Result<()> {
    for conversation in dataset {
        let expected = plan_imported_conversation(namespace, conversation);
        let mut expected_paths = expected.note_paths.clone();
        expected_paths.sort();
        let manifest_paths = manifest
            .conversation_note_paths
            .get(&conversation.conversation_id)
            .ok_or_else(|| {
                anyhow!(
                    "stale namespace: manifest is missing conversation {}",
                    conversation.conversation_id
                )
            })?;
        if manifest_paths != &expected_paths {
            return Err(anyhow!(
                "note mismatch: manifest note paths differ for conversation {}",
                conversation.conversation_id
            ));
        }
        let conversation_index = conversation_index_path(namespace, &conversation.conversation_id);
        if client.read_node(&conversation_index).await?.is_none() {
            return Err(anyhow!("missing prepare: {}", conversation_index));
        }
        for note in &expected.notes {
            if client.read_node(&note.path).await?.is_none() {
                return Err(anyhow!("missing prepare: {}", note.path));
            }
        }
    }
    Ok(())
}

fn matches_question_filters(config: &BeamBenchArgs, question: &dataset::BeamQuestion) -> bool {
    let tag_ok = if config.include_tags.is_empty() {
        true
    } else {
        question.tags.iter().any(|tag| {
            config
                .include_tags
                .iter()
                .any(|allowed| allowed.eq_ignore_ascii_case(tag))
        })
    };
    let type_ok = if config.include_question_types.is_empty() {
        true
    } else {
        config
            .include_question_types
            .iter()
            .any(|allowed| allowed.eq_ignore_ascii_case(&question.question_type))
    };
    tag_ok && type_ok
}

async fn run_agent_question(
    connection: &ResolvedConnection,
    config: &BeamBenchArgs,
    context: CodexQuestionContext<'_>,
) -> Result<model::ModelRun> {
    if config.model.trim().is_empty() {
        return Err(anyhow!("--model is required for retrieve-and-extract mode"));
    }
    run_codex_question(&config.codex_bin, &config.model, connection, context).await
}

fn score_legacy_failure(
    conversation_id: String,
    question: dataset::BeamQuestion,
    error: anyhow::Error,
) -> QuestionResult {
    let reason = if error.to_string().contains("max roundtrips") {
        FailureReason::RoundtripLimit
    } else {
        FailureReason::ToolError
    };
    QuestionResult {
        conversation_id,
        question_id: question.question_id,
        question_type: question.question_type,
        question_class: question.question_class,
        query: question.query,
        as_of: question.as_of,
        reference_answer: question.reference_answer,
        gold_answers: question.gold_answers,
        predicted_answer: None,
        gold_paths: question.gold_paths,
        gold_spans: question.gold_spans,
        expects_abstention: question.expects_abstention,
        tags: question.tags,
        retrieved_paths: Vec::new(),
        matched_gold_path: None,
        matched_gold_span: None,
        source_note_type: None,
        answered: false,
        grounded: false,
        answered_without_grounding: false,
        retrieved_paths_nonempty: false,
        read_before_answer: false,
        included_in_primary_metrics: !question.expects_abstention,
        retrieval_evaluable: false,
        retrieval_hit: false,
        gold_path_hit_at_1: false,
        gold_path_hit_at_3: false,
        gold_span_hit_at_1: false,
        gold_span_hit_at_3: false,
        answer_exact_match: false,
        answer_normalized_match: false,
        answer_match_given_span_hit: false,
        abstention_correct: false,
        tool_call_count: 0,
        tool_error_count: 1,
        docs_read_count: 0,
        input_tokens: Some(0),
        output_tokens: Some(0),
        total_tokens: Some(0),
        latency_ms: 0,
        spawned_at_ms: None,
        pid: None,
        exit_status: None,
        timed_out: false,
        stderr: Some(error.to_string()),
        schema_path: None,
        last_tool_name: None,
        last_tool_arguments: None,
        failure_reason: Some(reason),
        tool_calls: Vec::new(),
        raw_events: vec![json!({"error": error.to_string()})],
    }
}

fn default_namespace() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock should be after unix epoch")
        .as_secs();
    format!("bench-run-{seconds}")
}

#[cfg(test)]
mod tests {
    use super::{
        BeamBenchArgs, BeamBenchEvalMode, QuestionResult, completed_question_key,
        completed_question_keys, default_namespace, validate_prepared_namespace, with_defaults,
    };
    use crate::beam_bench::BeamQuestionClass;
    use crate::beam_bench::dataset::BeamConversation;
    use crate::beam_bench::import::plan_imported_conversation;
    use crate::beam_bench::manifest::{build_prepare_manifest, manifest_path_for_namespace};
    use anyhow::Result;
    use async_trait::async_trait;
    use serde_json::json;
    use std::collections::HashSet;
    use std::path::PathBuf;
    use vfs_client::VfsApi;
    use vfs_types::{
        AppendNodeRequest, DeleteNodeRequest, DeleteNodeResult, EditNodeRequest, EditNodeResult,
        ExportSnapshotRequest, ExportSnapshotResponse, FetchUpdatesRequest, FetchUpdatesResponse,
        GlobNodeHit, GlobNodesRequest, ListNodesRequest, MkdirNodeRequest, MkdirNodeResult,
        MoveNodeRequest, MoveNodeResult, MultiEditNodeRequest, MultiEditNodeResult, Node,
        NodeEntry, RecentNodeHit, RecentNodesRequest, SearchNodeHit, SearchNodePathsRequest,
        SearchNodesRequest, Status, WriteNodeRequest, WriteNodeResult,
    };

    #[derive(Default)]
    struct MockClient {
        nodes: std::collections::BTreeMap<String, String>,
    }

    #[async_trait]
    impl VfsApi for MockClient {
        async fn status(&self) -> Result<Status> {
            unreachable!()
        }
        async fn read_node(&self, path: &str) -> Result<Option<Node>> {
            Ok(self.nodes.get(path).map(|content| Node {
                path: path.to_string(),
                kind: vfs_types::NodeKind::File,
                content: content.clone(),
                created_at: 0,
                metadata_json: "{}".to_string(),
                updated_at: 0,
                etag: format!("etag-{path}"),
            }))
        }
        async fn list_nodes(&self, _request: ListNodesRequest) -> Result<Vec<NodeEntry>> {
            unreachable!()
        }
        async fn list_children(
            &self,
            _request: vfs_types::ListChildrenRequest,
        ) -> Result<Vec<vfs_types::ChildNode>> {
            unreachable!()
        }
        async fn write_node(&self, _request: WriteNodeRequest) -> Result<WriteNodeResult> {
            unreachable!()
        }
        async fn append_node(&self, _request: AppendNodeRequest) -> Result<WriteNodeResult> {
            unreachable!()
        }
        async fn edit_node(&self, _request: EditNodeRequest) -> Result<EditNodeResult> {
            unreachable!()
        }
        async fn delete_node(&self, _request: DeleteNodeRequest) -> Result<DeleteNodeResult> {
            unreachable!()
        }
        async fn move_node(&self, _request: MoveNodeRequest) -> Result<MoveNodeResult> {
            unreachable!()
        }
        async fn mkdir_node(&self, _request: MkdirNodeRequest) -> Result<MkdirNodeResult> {
            unreachable!()
        }
        async fn glob_nodes(&self, _request: GlobNodesRequest) -> Result<Vec<GlobNodeHit>> {
            unreachable!()
        }
        async fn recent_nodes(&self, _request: RecentNodesRequest) -> Result<Vec<RecentNodeHit>> {
            unreachable!()
        }
        async fn multi_edit_node(
            &self,
            _request: MultiEditNodeRequest,
        ) -> Result<MultiEditNodeResult> {
            unreachable!()
        }
        async fn search_nodes(&self, _request: SearchNodesRequest) -> Result<Vec<SearchNodeHit>> {
            unreachable!()
        }
        async fn search_node_paths(
            &self,
            _request: SearchNodePathsRequest,
        ) -> Result<Vec<SearchNodeHit>> {
            unreachable!()
        }
        async fn export_snapshot(
            &self,
            _request: ExportSnapshotRequest,
        ) -> Result<ExportSnapshotResponse> {
            unreachable!()
        }
        async fn fetch_updates(
            &self,
            _request: FetchUpdatesRequest,
        ) -> Result<FetchUpdatesResponse> {
            unreachable!()
        }
    }

    fn sample_conversation() -> BeamConversation {
        BeamConversation {
            conversation_id: "Conv 1".to_string(),
            conversation_seed: json!({"category":"General","title":"Calendar planning"}),
            narratives: "A short planning conversation.".to_string(),
            user_profile: json!({"user_info":"Sample profile"}),
            conversation_plan: "Confirm the meeting date.".to_string(),
            user_questions: json!([{"messages":["When is the meeting?"]}]),
            chat: json!([[{"role":"user","content":"Meeting is on March 15, 2024."}]]),
            probing_questions: "{}".to_string(),
        }
    }

    #[test]
    fn defaults_factoid_class_when_unspecified() {
        let args = with_defaults(BeamBenchArgs {
            dataset_path: PathBuf::from("beam.json"),
            split: "100K".to_string(),
            model: String::new(),
            output_dir: PathBuf::from("artifacts"),
            eval_mode: BeamBenchEvalMode::RetrieveAndExtract,
            limit: 1,
            parallelism: 1,
            top_k: 5,
            questions_per_conversation: None,
            question_id: None,
            include_question_classes: Vec::new(),
            include_tags: Vec::new(),
            include_question_types: Vec::new(),
            namespace: None,
            codex_bin: PathBuf::from("codex"),
            codex_sandbox: "danger-full-access".to_string(),
            resume: false,
        });
        assert_eq!(
            args.include_question_classes,
            vec![BeamQuestionClass::Factoid]
        );
    }

    #[test]
    fn explicit_question_type_keeps_question_class_open() {
        let args = with_defaults(BeamBenchArgs {
            dataset_path: PathBuf::from("beam.json"),
            split: "100K".to_string(),
            model: String::new(),
            output_dir: PathBuf::from("artifacts"),
            eval_mode: BeamBenchEvalMode::RetrieveAndExtract,
            limit: 1,
            parallelism: 1,
            top_k: 5,
            questions_per_conversation: None,
            question_id: None,
            include_question_classes: Vec::new(),
            include_tags: Vec::new(),
            include_question_types: vec!["temporal_reasoning".to_string()],
            namespace: None,
            codex_bin: PathBuf::from("codex"),
            codex_sandbox: "danger-full-access".to_string(),
            resume: false,
        });
        assert!(args.include_question_classes.is_empty());
    }

    #[test]
    fn completed_question_keys_reject_duplicates() {
        let first = QuestionResult {
            conversation_id: "conv".to_string(),
            question_id: "q".to_string(),
            question_type: "information_extraction".to_string(),
            question_class: BeamQuestionClass::Factoid,
            query: "Q".to_string(),
            as_of: None,
            reference_answer: None,
            gold_answers: Vec::new(),
            predicted_answer: None,
            gold_paths: Vec::new(),
            gold_spans: Vec::new(),
            expects_abstention: false,
            tags: Vec::new(),
            retrieved_paths: Vec::new(),
            matched_gold_path: None,
            matched_gold_span: None,
            source_note_type: None,
            answered: false,
            grounded: false,
            answered_without_grounding: false,
            retrieved_paths_nonempty: false,
            read_before_answer: false,
            included_in_primary_metrics: true,
            retrieval_evaluable: false,
            retrieval_hit: false,
            gold_path_hit_at_1: false,
            gold_path_hit_at_3: false,
            gold_span_hit_at_1: false,
            gold_span_hit_at_3: false,
            answer_exact_match: false,
            answer_normalized_match: false,
            answer_match_given_span_hit: false,
            abstention_correct: false,
            tool_call_count: 0,
            tool_error_count: 0,
            docs_read_count: 0,
            input_tokens: None,
            output_tokens: None,
            total_tokens: None,
            latency_ms: 0,
            spawned_at_ms: None,
            pid: None,
            exit_status: None,
            timed_out: false,
            stderr: None,
            schema_path: None,
            last_tool_name: None,
            last_tool_arguments: None,
            failure_reason: None,
            tool_calls: Vec::new(),
            raw_events: Vec::new(),
        };

        let error =
            completed_question_keys(&[first.clone(), first]).expect_err("duplicates must fail");

        assert!(error.to_string().contains("duplicate existing result"));
    }

    #[test]
    fn completed_questions_are_filtered_before_slice_limit() {
        let completed = HashSet::from([completed_question_key("conv", "q1")]);
        let remaining = ["q1", "q2", "q3"]
            .into_iter()
            .filter(|question_id| !completed.contains(&completed_question_key("conv", question_id)))
            .take(1)
            .collect::<Vec<_>>();

        assert_eq!(remaining, vec!["q2"]);
    }

    #[test]
    fn default_namespace_uses_benchmark_prefix() {
        assert!(default_namespace().starts_with("bench-run-"));
    }

    #[tokio::test]
    async fn prepared_namespace_validation_fails_when_namespace_index_missing() {
        let client = MockClient::default();
        let error = validate_prepared_namespace(&client, "run-a", "100K", &[sample_conversation()])
            .await
            .expect_err("missing namespace should fail");

        assert!(error.to_string().contains("missing prepare"));
    }

    #[tokio::test]
    async fn prepared_namespace_validation_passes_when_indexes_exist() {
        let conversation = sample_conversation();
        let imported = plan_imported_conversation("run-a", &conversation);
        let manifest = build_prepare_manifest(
            "run-a",
            "100K",
            std::slice::from_ref(&conversation),
            std::slice::from_ref(&imported),
        );
        let mut nodes = std::collections::BTreeMap::new();
        nodes.insert(
            "/Wiki/run-a/index.md".to_string(),
            "# Benchmark".to_string(),
        );
        nodes.insert(
            manifest_path_for_namespace("run-a"),
            serde_json::to_string(&manifest).expect("manifest should serialize"),
        );
        for note in &imported.notes {
            nodes.insert(note.path.clone(), note.content.clone());
        }
        let client = MockClient { nodes };

        validate_prepared_namespace(&client, "run-a", "100K", &[conversation])
            .await
            .expect("prepared namespace should validate");
    }

    #[tokio::test]
    async fn prepared_namespace_validation_fails_when_note_is_missing() {
        let conversation = sample_conversation();
        let imported = plan_imported_conversation("run-a", &conversation);
        let manifest = build_prepare_manifest(
            "run-a",
            "100K",
            std::slice::from_ref(&conversation),
            std::slice::from_ref(&imported),
        );
        let mut nodes = std::collections::BTreeMap::new();
        nodes.insert(
            "/Wiki/run-a/index.md".to_string(),
            "# Benchmark".to_string(),
        );
        nodes.insert(
            manifest_path_for_namespace("run-a"),
            serde_json::to_string(&manifest).expect("manifest should serialize"),
        );
        for note in &imported.notes {
            if note.path.ends_with("/facts.md") {
                continue;
            }
            nodes.insert(note.path.clone(), note.content.clone());
        }
        let client = MockClient { nodes };

        let error = validate_prepared_namespace(&client, "run-a", "100K", &[conversation])
            .await
            .expect_err("missing note should fail");
        assert!(error.to_string().contains("missing prepare"));
    }

    #[tokio::test]
    async fn prepared_namespace_validation_allows_manual_note_edits() {
        let conversation = sample_conversation();
        let imported = plan_imported_conversation("run-a", &conversation);
        let manifest = build_prepare_manifest(
            "run-a",
            "100K",
            std::slice::from_ref(&conversation),
            std::slice::from_ref(&imported),
        );
        let mut nodes = std::collections::BTreeMap::new();
        nodes.insert(
            "/Wiki/run-a/index.md".to_string(),
            "# Benchmark".to_string(),
        );
        nodes.insert(
            manifest_path_for_namespace("run-a"),
            serde_json::to_string(&manifest).expect("manifest should serialize"),
        );
        for note in &imported.notes {
            let content = if note.path.ends_with("/facts.md") {
                "tampered".to_string()
            } else {
                note.content.clone()
            };
            nodes.insert(note.path.clone(), content);
        }
        let client = MockClient { nodes };

        validate_prepared_namespace(&client, "run-a", "100K", &[conversation])
            .await
            .expect("manual edits should still allow eval");
    }

    #[tokio::test]
    async fn prepared_namespace_validation_fails_when_split_differs() {
        let conversation = sample_conversation();
        let imported = plan_imported_conversation("run-a", &conversation);
        let manifest = build_prepare_manifest(
            "run-a",
            "100K",
            std::slice::from_ref(&conversation),
            std::slice::from_ref(&imported),
        );
        let mut nodes = std::collections::BTreeMap::new();
        nodes.insert(
            "/Wiki/run-a/index.md".to_string(),
            "# Benchmark".to_string(),
        );
        nodes.insert(
            manifest_path_for_namespace("run-a"),
            serde_json::to_string(&manifest).expect("manifest should serialize"),
        );
        for note in &imported.notes {
            nodes.insert(note.path.clone(), note.content.clone());
        }
        let client = MockClient { nodes };

        let error = validate_prepared_namespace(&client, "run-a", "10K", &[conversation])
            .await
            .expect_err("split mismatch should fail");
        assert!(error.to_string().contains("dataset mismatch"));
    }

    #[tokio::test]
    async fn prepared_namespace_validation_fails_when_dataset_differs() {
        let first = sample_conversation();
        let second = BeamConversation {
            conversation_id: "Conv 2".to_string(),
            ..sample_conversation()
        };
        let first_imported = plan_imported_conversation("run-a", &first);
        let second_imported = plan_imported_conversation("run-a", &second);
        let manifest = build_prepare_manifest(
            "run-a",
            "100K",
            std::slice::from_ref(&second),
            std::slice::from_ref(&second_imported),
        );
        let mut nodes = std::collections::BTreeMap::new();
        nodes.insert(
            "/Wiki/run-a/index.md".to_string(),
            "# Benchmark".to_string(),
        );
        nodes.insert(
            manifest_path_for_namespace("run-a"),
            serde_json::to_string(&manifest).expect("manifest should serialize"),
        );
        for note in first_imported
            .notes
            .iter()
            .chain(second_imported.notes.iter())
        {
            nodes.insert(note.path.clone(), note.content.clone());
        }
        let client = MockClient { nodes };

        let error = validate_prepared_namespace(&client, "run-a", "100K", &[first])
            .await
            .expect_err("dataset mismatch should fail");
        assert!(error.to_string().contains("dataset mismatch"));
    }
}
