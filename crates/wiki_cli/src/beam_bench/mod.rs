// Where: crates/wiki_cli/src/beam_bench/mod.rs
// What: End-to-end BEAM harness for deterministic retrieval and extraction evaluation.
// Why: Retrieval quality must be measurable without coupling the headline metric to model reasoning variance.
mod agent_scoring;
mod dataset;
mod deterministic;
mod gold_paths;
mod import;
mod model;
mod navigation;
mod note_support;
mod notes;
mod report;

use crate::client::CanisterWikiClient;
use crate::connection::ResolvedConnection;
use anyhow::{Result, anyhow};
use dataset::{BeamConversation, extract_questions, load_dataset};
use import::import_conversation;
use model::run_codex_question;
use navigation::sync_beam_indexes;
use report::{BenchmarkSummary, FailureReason, QuestionResult, summarize, write_artifacts};
use serde_json::json;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

pub use dataset::BeamQuestionClass;

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
    pub include_question_classes: Vec<BeamQuestionClass>,
    pub namespace: Option<String>,
    pub codex_bin: PathBuf,
    pub codex_sandbox: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BeamBenchEvalMode {
    RetrievalOnly,
    RetrieveAndExtract,
}

pub async fn run_beam_bench(connection: ResolvedConnection, args: BeamBenchArgs) -> Result<()> {
    let dataset = load_dataset(&args.dataset_path, &args.split, args.limit)?;
    let conversation_ids = dataset
        .iter()
        .map(|conversation| conversation.conversation_id.clone())
        .collect::<Vec<_>>();
    let namespace = args.namespace.clone().unwrap_or_else(default_namespace);
    let config = Arc::new(with_defaults(args));
    let index_client =
        CanisterWikiClient::new(&connection.replica_host, &connection.canister_id).await?;
    if !conversation_ids.is_empty() {
        sync_beam_indexes(&index_client, &namespace).await?;
    }
    let gate = Arc::new(Semaphore::new(config.parallelism.max(1)));
    let mut tasks = JoinSet::new();

    for conversation in dataset {
        let connection = connection.clone();
        let config = Arc::clone(&config);
        let namespace = namespace.clone();
        let gate = Arc::clone(&gate);
        tasks.spawn(async move {
            let _permit = gate.acquire_owned().await?;
            run_conversation_benchmark(&connection, &config, &namespace, conversation).await
        });
    }

    let mut results = Vec::new();
    while let Some(task) = tasks.join_next().await {
        let question_results =
            task.map_err(|error| anyhow!("benchmark task failed: {error}"))??;
        results.extend(question_results);
    }
    if !conversation_ids.is_empty() {
        sync_beam_indexes(&index_client, &namespace).await?;
    }
    results.sort_by(|left, right| {
        (&left.conversation_id, &left.question_id)
            .cmp(&(&right.conversation_id, &right.question_id))
    });

    let summary: BenchmarkSummary = summarize(&results, config.top_k);
    write_artifacts(&config.output_dir, &summary, &results)?;
    println!("{}", serde_json::to_string_pretty(&summary)?);
    Ok(())
}

fn with_defaults(mut args: BeamBenchArgs) -> BeamBenchArgs {
    if args.model.trim().is_empty() {
        args.model = "gpt-5.4-mini".to_string();
    }
    if args.include_question_classes.is_empty() {
        args.include_question_classes = vec![BeamQuestionClass::Factoid];
    }
    args
}

async fn run_conversation_benchmark(
    connection: &ResolvedConnection,
    config: &BeamBenchArgs,
    namespace: &str,
    conversation: BeamConversation,
) -> Result<Vec<QuestionResult>> {
    let client = CanisterWikiClient::new(&connection.replica_host, &connection.canister_id).await?;
    let imported = import_conversation(&client, namespace, &conversation).await?;
    let mut questions = extract_questions(&conversation)?
        .into_iter()
        .filter(|question| {
            config
                .include_question_classes
                .contains(&question.question_class)
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
                match run_agent_question(
                    connection,
                    config,
                    &imported.namespace_path,
                    &imported.namespace_index_path,
                    &imported.base_path,
                    &question.query,
                )
                .await
                {
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
        results.push(result);
    }
    Ok(results)
}

async fn run_agent_question(
    connection: &ResolvedConnection,
    config: &BeamBenchArgs,
    namespace_path: &str,
    namespace_index_path: &str,
    base_path: &str,
    question: &str,
) -> Result<model::ModelRun> {
    if config.model.trim().is_empty() {
        return Err(anyhow!("--model is required for retrieve-and-extract mode"));
    }
    run_codex_question(
        &config.codex_bin,
        &config.model,
        namespace_path,
        namespace_index_path,
        base_path,
        question,
        connection,
        &config.codex_sandbox,
    )
    .await
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
    use super::{BeamBenchArgs, BeamBenchEvalMode, default_namespace, with_defaults};
    use crate::beam_bench::BeamQuestionClass;
    use std::path::PathBuf;

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
            include_question_classes: Vec::new(),
            namespace: None,
            codex_bin: PathBuf::from("codex"),
            codex_sandbox: "danger-full-access".to_string(),
        });
        assert_eq!(
            args.include_question_classes,
            vec![BeamQuestionClass::Factoid]
        );
    }

    #[test]
    fn default_namespace_uses_benchmark_prefix() {
        assert!(default_namespace().starts_with("bench-run-"));
    }
}
