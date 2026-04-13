// Where: crates/wiki_cli/src/beam_bench/mod.rs
// What: End-to-end BEAM benchmark harness that imports conversations into llm-wiki and evaluates read-only retrieval answers.
// Why: BEAM should measure memory quality through the existing wiki tool layer without changing the canister or store APIs.
mod dataset;
mod import;
mod model;
mod report;

use crate::agent_tools::{create_openai_read_only_tools, handle_openai_tool_call};
use crate::cli::ConnectionArgs;
use crate::client::CanisterWikiClient;
use anyhow::{Context, Result, anyhow};
use dataset::{BeamConversation, extract_questions, load_dataset};
use import::import_conversation;
use model::{BenchmarkModel, ModelRequest, OpenAiResponsesModel, ToolLoopConfig, run_tool_loop};
use report::{QuestionResult, summarize, write_artifacts};
use serde_json::json;
use std::env;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

#[derive(Debug, Clone)]
pub struct BeamBenchArgs {
    pub dataset_path: PathBuf,
    pub split: String,
    pub model: String,
    pub output_dir: PathBuf,
    pub provider: BeamBenchProvider,
    pub limit: usize,
    pub parallelism: usize,
    pub openai_base_url: String,
    pub openai_api_key_env: String,
    pub max_tool_roundtrips: usize,
    pub questions_per_conversation: Option<usize>,
    pub namespace: Option<String>,
    pub codex_bin: PathBuf,
    pub codex_sandbox: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BeamBenchProvider {
    Codex,
    OpenAi,
}

pub async fn run_beam_bench(connection: ConnectionArgs, args: BeamBenchArgs) -> Result<()> {
    let dataset = load_dataset(&args.dataset_path, &args.split, args.limit)?;
    let namespace = args.namespace.clone().unwrap_or_else(default_namespace);
    let config = Arc::new(args);
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

    let summary = summarize(&results);
    write_artifacts(&config.output_dir, &summary, &results)?;
    println!("{}", serde_json::to_string_pretty(&summary)?);
    Ok(())
}

async fn run_conversation_benchmark(
    connection: &ConnectionArgs,
    config: &BeamBenchArgs,
    namespace: &str,
    conversation: BeamConversation,
) -> Result<Vec<QuestionResult>> {
    let client = CanisterWikiClient::new(&connection.replica_host, &connection.canister_id).await?;
    let imported = import_conversation(&client, namespace, &conversation).await?;
    let mut questions = extract_questions(&conversation)?;
    if let Some(limit) = config.questions_per_conversation {
        questions.truncate(limit);
    }
    let tools = create_openai_read_only_tools();
    let tool_loop = ToolLoopConfig {
        max_roundtrips: config.max_tool_roundtrips,
    };
    let mut results = Vec::with_capacity(questions.len());
    for question in questions {
        let run = match config.provider {
            BeamBenchProvider::OpenAi => {
                let api_key = env::var(&config.openai_api_key_env).with_context(|| {
                    format!(
                        "failed to read OpenAI API key from environment variable {}",
                        config.openai_api_key_env
                    )
                })?;
                let provider = OpenAiResponsesModel::new(config.openai_base_url.clone(), api_key);
                run_openai_question(
                    &client,
                    &provider,
                    &tools,
                    &tool_loop,
                    config,
                    &imported.base_path,
                    &question.prompt,
                )
                .await?
            }
            BeamBenchProvider::Codex => {
                model::run_codex_question(
                    &config.codex_bin,
                    &config.model,
                    &imported.base_path,
                    &question.prompt,
                    connection,
                    &config.codex_sandbox,
                )
                .await?
            }
        };
        results.push(score_question(
            imported.conversation_id.clone(),
            question,
            run,
        ));
    }
    Ok(results)
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

fn score_question(
    conversation_id: String,
    question: dataset::BeamQuestion,
    run: model::ModelRun,
) -> QuestionResult {
    let predicted_normalized = normalize_answer(&run.answer);
    let reference_normalized = question.reference_answer.as_deref().map(normalize_answer);
    let exact_match = question
        .reference_answer
        .as_deref()
        .map(|answer| answer.trim() == run.answer.trim())
        .unwrap_or(false);
    let normalized_match = reference_normalized
        .as_deref()
        .map(|answer| answer == predicted_normalized)
        .unwrap_or(false);
    let tool_error_count = run.tool_calls.iter().filter(|call| call.is_error).count();
    QuestionResult {
        conversation_id,
        question_id: question.question_id,
        question_type: question.question_type,
        prompt: question.prompt,
        reference_answer: question.reference_answer,
        predicted_answer: run.answer,
        scorable: reference_normalized.is_some(),
        exact_match,
        normalized_match,
        tool_call_count: run.tool_calls.len(),
        tool_error_count,
        input_tokens: run.input_tokens,
        output_tokens: run.output_tokens,
        total_tokens: run.total_tokens,
        latency_ms: run.latency_ms,
        tool_calls: run.tool_calls,
        raw_events: run.raw_events,
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
    use super::{normalize_answer, score_question};
    use crate::beam_bench::dataset::BeamQuestion;
    use crate::beam_bench::model::{ModelRun, ToolCallRecord};
    use serde_json::json;

    #[test]
    fn normalize_answer_collapses_case_and_punctuation() {
        assert_eq!(normalize_answer(" March 15, 2024! "), "march 15 2024");
    }

    #[test]
    fn score_question_marks_unscorable_without_reference() {
        let result = score_question(
            "conv-1".to_string(),
            BeamQuestion {
                question_id: "abstention-000".to_string(),
                question_type: "abstention".to_string(),
                prompt: "Unknown?".to_string(),
                reference_answer: None,
                raw: json!({}),
            },
            ModelRun {
                answer: "insufficient evidence".to_string(),
                tool_calls: vec![ToolCallRecord {
                    name: "search".to_string(),
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
        assert!(!result.scorable);
        assert!(!result.normalized_match);
    }
}
