// Where: crates/wiki_cli/src/beam_bench/mod.rs
// What: End-to-end BEAM harness for deterministic RAG scoring plus legacy agent-answer comparison.
// Why: Retrieval quality must be measurable without coupling the headline metric to model reasoning variance.
mod dataset;
mod deterministic;
mod import;
mod model;
mod report;

use crate::agent_tools::{create_openai_read_only_tools, handle_openai_tool_call};
use crate::client::CanisterWikiClient;
use crate::connection::ResolvedConnection;
use anyhow::{Context, Result, anyhow};
use dataset::{BeamConversation, extract_questions, load_dataset};
use import::import_conversation;
use model::{BenchmarkModel, ModelRequest, OpenAiResponsesModel, ToolLoopConfig, run_tool_loop};
use report::{BenchmarkSummary, FailureReason, QuestionResult, summarize, write_artifacts};
use serde_json::json;
use std::env;
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
    pub provider: BeamBenchProvider,
    pub eval_mode: BeamBenchEvalMode,
    pub limit: usize,
    pub parallelism: usize,
    pub top_k: u32,
    pub openai_base_url: String,
    pub openai_api_key_env: String,
    pub max_tool_roundtrips: usize,
    pub questions_per_conversation: Option<usize>,
    pub include_question_classes: Vec<BeamQuestionClass>,
    pub namespace: Option<String>,
    pub codex_bin: PathBuf,
    pub codex_sandbox: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BeamBenchProvider {
    Codex,
    OpenAi,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BeamBenchEvalMode {
    RetrievalOnly,
    RetrieveAndExtract,
    LegacyAgentAnswer,
}

pub async fn run_beam_bench(connection: ResolvedConnection, args: BeamBenchArgs) -> Result<()> {
    let dataset = load_dataset(&args.dataset_path, &args.split, args.limit)?;
    let namespace = args.namespace.clone().unwrap_or_else(default_namespace);
    let config = Arc::new(with_defaults(args));
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
    let tools = create_openai_read_only_tools();
    let tool_loop = ToolLoopConfig {
        max_roundtrips: config.max_tool_roundtrips,
    };
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
                deterministic::run_question(
                    &client,
                    &imported.conversation_id,
                    &imported,
                    question,
                    config.top_k,
                    true,
                    true,
                )
                .await?
            }
            BeamBenchEvalMode::LegacyAgentAnswer => {
                match run_legacy_question(
                    connection,
                    &client,
                    &tools,
                    &tool_loop,
                    config,
                    &imported.base_path,
                    &question.prompt,
                )
                .await
                {
                    Ok(run) => {
                        score_legacy_question(imported.conversation_id.clone(), question, run)
                    }
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

async fn run_legacy_question(
    connection: &ResolvedConnection,
    client: &CanisterWikiClient,
    tools: &[serde_json::Value],
    tool_loop: &ToolLoopConfig,
    config: &BeamBenchArgs,
    base_path: &str,
    question: &str,
) -> Result<model::ModelRun> {
    match config.provider {
        BeamBenchProvider::OpenAi => {
            let api_key = env::var(&config.openai_api_key_env).with_context(|| {
                format!(
                    "failed to read OpenAI API key from environment variable {}",
                    config.openai_api_key_env
                )
            })?;
            let provider = OpenAiResponsesModel::new(config.openai_base_url.clone(), api_key);
            run_openai_question(
                client, &provider, tools, tool_loop, config, base_path, question,
            )
            .await
        }
        BeamBenchProvider::Codex => {
            if config.model.trim().is_empty() {
                return Err(anyhow!("--model is required for legacy-agent-answer mode"));
            }
            model::run_codex_question(
                &config.codex_bin,
                &config.model,
                base_path,
                question,
                connection,
                &config.codex_sandbox,
            )
            .await
        }
    }
}

async fn run_openai_question(
    client: &CanisterWikiClient,
    provider: &impl BenchmarkModel,
    tools: &[serde_json::Value],
    tool_loop: &ToolLoopConfig,
    config: &BeamBenchArgs,
    base_path: &str,
    question: &str,
) -> Result<model::ModelRun> {
    if config.model.trim().is_empty() {
        return Err(anyhow!("--model is required for legacy-agent-answer mode"));
    }
    let tool_client = client.clone();
    let prompt = format!(
        "You are answering a BEAM benchmark question using llm-wiki. Use only the provided tools. Answer with the shortest complete answer grounded in the wiki notes under {base_path}. If the wiki does not contain enough evidence, answer exactly: insufficient evidence."
    );
    let request = ModelRequest {
        model: config.model.clone(),
        input: vec![
            json!({"role": "system", "content": prompt}),
            json!({"role": "user", "content": question}),
        ],
        tools: tools.to_vec(),
    };
    run_tool_loop(provider, request, tool_loop, |name, arguments| {
        let tool_name = name.to_string();
        let tool_arguments = arguments.to_string();
        let call_client = tool_client.clone();
        async move {
            Ok(
                handle_openai_tool_call(&call_client, &tool_name, &tool_arguments)
                    .await?
                    .text,
            )
        }
    })
    .await
}

fn score_legacy_question(
    conversation_id: String,
    question: dataset::BeamQuestion,
    run: model::ModelRun,
) -> QuestionResult {
    let predicted_answer = if run.answer.trim().is_empty() {
        None
    } else {
        Some(run.answer.clone())
    };
    let answer_exact_match = question
        .reference_answer
        .as_deref()
        .zip(predicted_answer.as_deref())
        .map(|(expected, actual)| expected.trim() == actual.trim())
        .unwrap_or(false);
    let answer_normalized_match = question
        .reference_answer
        .as_deref()
        .zip(predicted_answer.as_deref())
        .map(|(expected, actual)| normalize_answer(expected) == normalize_answer(actual))
        .unwrap_or(false);
    let tool_error_count = run.tool_calls.iter().filter(|call| call.is_error).count();
    let failure_reason = if tool_error_count > 0 {
        Some(FailureReason::ToolError)
    } else if predicted_answer.is_some() && !answer_normalized_match {
        Some(FailureReason::WrongShortAnswer)
    } else {
        None
    };
    QuestionResult {
        conversation_id,
        question_id: question.question_id,
        question_type: question.question_type,
        question_class: question.question_class,
        prompt: question.prompt,
        reference_answer: question.reference_answer,
        predicted_answer,
        gold_paths: question.gold_paths,
        gold_spans: question.gold_spans,
        retrieved_paths: Vec::new(),
        matched_gold_path: None,
        matched_gold_span: None,
        source_note_type: None,
        included_in_primary_metrics: true,
        retrieval_evaluable: false,
        retrieval_hit: false,
        answer_exact_match,
        answer_normalized_match,
        tool_call_count: run.tool_calls.len(),
        tool_error_count,
        docs_read_count: run.tool_calls.len(),
        input_tokens: run.input_tokens,
        output_tokens: run.output_tokens,
        total_tokens: run.total_tokens,
        latency_ms: run.latency_ms,
        failure_reason,
        tool_calls: run.tool_calls,
        raw_events: run.raw_events,
    }
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
        prompt: question.prompt,
        reference_answer: question.reference_answer,
        predicted_answer: None,
        gold_paths: question.gold_paths,
        gold_spans: question.gold_spans,
        retrieved_paths: Vec::new(),
        matched_gold_path: None,
        matched_gold_span: None,
        source_note_type: None,
        included_in_primary_metrics: true,
        retrieval_evaluable: false,
        retrieval_hit: false,
        answer_exact_match: false,
        answer_normalized_match: false,
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

fn normalize_answer(value: &str) -> String {
    let mut normalized = String::new();
    let mut last_was_space = false;
    for character in value.trim().chars().flat_map(char::to_lowercase) {
        if character.is_alphanumeric() {
            normalized.push(character);
            last_was_space = false;
            continue;
        }
        if !last_was_space {
            normalized.push(' ');
            last_was_space = true;
        }
    }
    normalized.trim().to_string()
}

fn default_namespace() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock should be after unix epoch")
        .as_secs();
    format!("beam-run-{seconds}")
}

#[cfg(test)]
mod tests {
    use super::{
        BeamBenchArgs, BeamBenchEvalMode, BeamBenchProvider, default_namespace, normalize_answer,
        score_legacy_question, with_defaults,
    };
    use crate::beam_bench::dataset::{BeamQuestion, BeamQuestionClass};
    use crate::beam_bench::model::{ModelRun, ToolCallRecord};
    use serde_json::json;
    use std::path::PathBuf;

    #[test]
    fn normalize_answer_collapses_case_and_punctuation() {
        assert_eq!(normalize_answer(" March 15, 2024! "), "march 15 2024");
    }

    #[test]
    fn defaults_factoid_class_when_unspecified() {
        let args = with_defaults(BeamBenchArgs {
            dataset_path: PathBuf::from("beam.json"),
            split: "100K".to_string(),
            model: String::new(),
            output_dir: PathBuf::from("artifacts"),
            provider: BeamBenchProvider::Codex,
            eval_mode: BeamBenchEvalMode::RetrieveAndExtract,
            limit: 1,
            parallelism: 1,
            top_k: 5,
            openai_base_url: "https://api.openai.com/v1".to_string(),
            openai_api_key_env: "OPENAI_API_KEY".to_string(),
            max_tool_roundtrips: 8,
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
    fn default_namespace_uses_beam_prefix() {
        assert!(default_namespace().starts_with("beam-run-"));
    }

    #[test]
    fn legacy_question_is_not_marked_retrieval_evaluable() {
        let result = score_legacy_question(
            "conv".to_string(),
            BeamQuestion {
                question_id: "factoid-000".to_string(),
                question_type: "factoid".to_string(),
                question_class: BeamQuestionClass::Factoid,
                prompt: "When?".to_string(),
                reference_answer: Some("March 15, 2024".to_string()),
                gold_paths: vec!["/Wiki/beam/run/conv/messages/0002-assistant.md".to_string()],
                gold_spans: vec!["March 15, 2024".to_string()],
                raw: json!({}),
            },
            ModelRun {
                answer: "March 15, 2024".to_string(),
                tool_calls: vec![ToolCallRecord {
                    name: "read".to_string(),
                    arguments: "{}".to_string(),
                    is_error: false,
                }],
                input_tokens: Some(1),
                output_tokens: Some(1),
                total_tokens: Some(2),
                latency_ms: 10,
                raw_events: Vec::new(),
            },
        );
        assert!(result.answer_normalized_match);
        assert!(!result.retrieval_evaluable);
        assert!(!result.retrieval_hit);
    }
}
