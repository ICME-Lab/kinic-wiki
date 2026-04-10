// Where: crates/wiki_cli/src/beam_bench/model.rs
// What: OpenAI Responses integration and provider abstraction for BEAM benchmark runs.
// Why: The benchmark must be able to replay tool-calling conversations in tests and against one production provider.
use anyhow::{Context, Result, anyhow};
use async_trait::async_trait;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::future::Future;
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use crate::cli::ConnectionArgs;

#[derive(Debug, Clone)]
pub struct ModelRequest {
    pub model: String,
    pub input: Vec<Value>,
    pub tools: Vec<Value>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ToolCallRecord {
    pub name: String,
    pub arguments: String,
    pub is_error: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ModelRun {
    pub answer: String,
    pub tool_calls: Vec<ToolCallRecord>,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub total_tokens: Option<u64>,
    pub latency_ms: u128,
    pub raw_events: Vec<Value>,
}

#[derive(Debug, Clone)]
pub struct ToolLoopConfig {
    pub max_roundtrips: usize,
}

#[async_trait]
pub trait BenchmarkModel: Send + Sync {
    async fn create_response(&self, request: ModelRequest) -> Result<ModelResponse>;
}

pub async fn run_tool_loop<F, Fut>(
    provider: &impl BenchmarkModel,
    request: ModelRequest,
    config: &ToolLoopConfig,
    mut execute_tool: F,
) -> Result<ModelRun>
where
    F: FnMut(&str, &str) -> Fut,
    Fut: Future<Output = Result<String>>,
{
    let started_at = Instant::now();
    let mut accumulated_input = request.input;
    let mut tool_calls = Vec::new();
    let mut usage = Usage::default();
    for _ in 0..config.max_roundtrips {
        let response = provider
            .create_response(ModelRequest {
                model: request.model.clone(),
                input: accumulated_input.clone(),
                tools: request.tools.clone(),
            })
            .await?;
        usage.merge(response.usage);
        if response.function_calls.is_empty() {
            return Ok(ModelRun {
                answer: response.output_text,
                tool_calls,
                input_tokens: usage.input_tokens,
                output_tokens: usage.output_tokens,
                total_tokens: usage.total_tokens,
                latency_ms: started_at.elapsed().as_millis(),
                raw_events: Vec::new(),
            });
        }

        for function_call in response.function_calls {
            let output = execute_tool(&function_call.name, &function_call.arguments).await?;
            accumulated_input.push(json!({
                "type": "function_call_output",
                "call_id": function_call.call_id,
                "output": output
            }));
            tool_calls.push(ToolCallRecord {
                name: function_call.name,
                arguments: function_call.arguments,
                is_error: output.contains("\"error\""),
            });
        }
    }
    Err(anyhow!("tool loop exceeded max roundtrips"))
}

pub struct OpenAiResponsesModel {
    base_url: String,
    api_key: String,
    client: Client,
}

static CODEX_SCHEMA_COUNTER: AtomicU64 = AtomicU64::new(0);

pub async fn run_codex_question(
    codex_bin: &Path,
    model: &str,
    base_path: &str,
    question: &str,
    connection: &ConnectionArgs,
    codex_sandbox: &str,
) -> Result<ModelRun> {
    let started_at = Instant::now();
    let schema_path = next_codex_schema_path();
    tokio::fs::write(&schema_path, codex_answer_schema().to_string())
        .await
        .with_context(|| "failed to write Codex output schema")?;
    let prompt = codex_prompt(base_path, question, connection);
    let mut child = Command::new(codex_bin)
        .arg("exec")
        .arg("--json")
        .arg("--cd")
        .arg(std::env::current_dir().with_context(|| "failed to resolve current dir")?)
        .arg("--sandbox")
        .arg(codex_sandbox)
        .arg("--output-schema")
        .arg(&schema_path)
        .arg("--model")
        .arg(model)
        .arg("-")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| "failed to spawn Codex CLI")?;
    {
        let stdin = child
            .stdin
            .as_mut()
            .ok_or_else(|| anyhow!("failed to open Codex stdin"))?;
        stdin
            .write_all(prompt.as_bytes())
            .await
            .with_context(|| "failed to write Codex prompt")?;
    }
    let output = child
        .wait_with_output()
        .await
        .with_context(|| "failed to wait for Codex CLI")?;
    let _ = tokio::fs::remove_file(&schema_path).await;
    if !output.status.success() {
        return Err(anyhow!(
            "Codex CLI failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let raw_events = parse_jsonl_events(&stdout);
    let answer = parse_codex_answer(&raw_events)?;
    let usage = parse_codex_usage(&raw_events);
    let tool_calls = parse_codex_tool_calls(&raw_events);
    Ok(ModelRun {
        answer,
        tool_calls,
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        total_tokens: usage.total_tokens,
        latency_ms: started_at.elapsed().as_millis(),
        raw_events,
    })
}

fn next_codex_schema_path() -> std::path::PathBuf {
    let counter = CODEX_SCHEMA_COUNTER.fetch_add(1, Ordering::Relaxed);
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    std::env::temp_dir().join(format!(
        "llm-wiki-beam-codex-schema-{}-{timestamp}-{counter}.json",
        std::process::id()
    ))
}

fn codex_prompt(base_path: &str, question: &str, connection: &ConnectionArgs) -> String {
    format!(
        r#"You are answering a BEAM benchmark question using llm-wiki on the local PocketIC canister.

Use shell commands only through `cargo run -p wiki-cli -- ...` and only these read-only subcommands:
- read-node
- list-nodes
- search-remote
- recent-nodes

Use this exact argument order. Do not put connection flags after the subcommand:

```bash
cargo run -p wiki-cli --bin wiki-cli -- --replica-host {replica_host} --canister-id {canister_id} list-nodes --prefix {base_path} --recursive --json
cargo run -p wiki-cli --bin wiki-cli -- --replica-host {replica_host} --canister-id {canister_id} search-remote --prefix {base_path} "query text" --json
cargo run -p wiki-cli --bin wiki-cli -- --replica-host {replica_host} --canister-id {canister_id} read-node --path {base_path}/conversation.md --json
```

Connection:
- replica host: {replica_host}
- canister id: {canister_id}
- wiki prefix: {base_path}

Question:
{question}

Answer with JSON matching the provided output schema. The `answer` field must be the shortest complete answer grounded in the wiki notes. If there is not enough evidence, set `answer` to exactly `insufficient evidence`.
"#,
        replica_host = connection.replica_host,
        canister_id = connection.canister_id,
        base_path = base_path,
        question = question
    )
}

fn codex_answer_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "answer": {
                "type": "string"
            }
        },
        "required": ["answer"],
        "additionalProperties": false
    })
}

fn parse_jsonl_events(stdout: &str) -> Vec<Value> {
    stdout
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .collect()
}

fn parse_codex_answer(events: &[Value]) -> Result<String> {
    let text = events
        .iter()
        .filter(|event| event.get("type").and_then(Value::as_str) == Some("item.completed"))
        .filter_map(|event| event.get("item"))
        .filter(|item| item.get("type").and_then(Value::as_str) == Some("agent_message"))
        .filter_map(|item| item.get("text").and_then(Value::as_str))
        .next_back()
        .ok_or_else(|| anyhow!("Codex output did not include an agent_message"))?;
    let value: Value =
        serde_json::from_str(text).with_context(|| "Codex agent_message was not JSON")?;
    value
        .get("answer")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .ok_or_else(|| anyhow!("Codex output JSON did not contain answer"))
}

fn parse_codex_usage(events: &[Value]) -> Usage {
    events
        .iter()
        .filter(|event| event.get("type").and_then(Value::as_str) == Some("turn.completed"))
        .filter_map(|event| event.get("usage"))
        .filter_map(|usage| serde_json::from_value::<CodexUsage>(usage.clone()).ok())
        .fold(Usage::default(), |mut acc, usage| {
            acc.input_tokens = sum_optional(acc.input_tokens, usage.input_tokens);
            acc.output_tokens = sum_optional(acc.output_tokens, usage.output_tokens);
            acc.total_tokens = sum_optional(
                acc.total_tokens,
                match (usage.input_tokens, usage.output_tokens) {
                    (Some(input), Some(output)) => Some(input + output),
                    _ => None,
                },
            );
            acc
        })
}

fn parse_codex_tool_calls(events: &[Value]) -> Vec<ToolCallRecord> {
    events
        .iter()
        .filter(|event| event.get("type").and_then(Value::as_str) == Some("item.completed"))
        .filter_map(|event| event.get("item"))
        .filter_map(|item| {
            let command = item.get("command").and_then(Value::as_str)?;
            if !command.contains("wiki-cli") && !command.contains("target/debug/wiki-cli") {
                return None;
            }
            Some(ToolCallRecord {
                name: "codex_shell".to_string(),
                arguments: command.to_string(),
                is_error: item
                    .get("status")
                    .and_then(Value::as_str)
                    .map(|status| status != "completed")
                    .unwrap_or(false),
            })
        })
        .collect()
}

#[derive(Debug, Deserialize)]
struct CodexUsage {
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
}

impl OpenAiResponsesModel {
    pub fn new(base_url: String, api_key: String) -> Self {
        Self {
            base_url,
            api_key,
            client: Client::new(),
        }
    }
}

#[async_trait]
impl BenchmarkModel for OpenAiResponsesModel {
    async fn create_response(&self, request: ModelRequest) -> Result<ModelResponse> {
        let payload = json!({
            "model": request.model,
            "input": request.input,
            "tools": request.tools,
        });
        let endpoint = format!("{}/responses", self.base_url.trim_end_matches('/'));
        let response = self
            .client
            .post(endpoint)
            .bearer_auth(&self.api_key)
            .json(&payload)
            .send()
            .await
            .with_context(|| "failed to call OpenAI Responses API")?;
        let response = response
            .error_for_status()
            .with_context(|| "OpenAI Responses API returned an error status")?;
        let body: OpenAiResponseBody = response
            .json()
            .await
            .with_context(|| "failed to decode OpenAI Responses API response")?;
        Ok(ModelResponse::from_openai(body))
    }
}

#[derive(Debug, Clone)]
pub struct ModelResponse {
    pub output_text: String,
    pub function_calls: Vec<FunctionCall>,
    pub usage: Usage,
}

impl ModelResponse {
    fn from_openai(body: OpenAiResponseBody) -> Self {
        let mut text_parts = Vec::new();
        let mut function_calls = Vec::new();
        for item in body.output {
            if let Some(function_call) = item.as_function_call() {
                function_calls.push(function_call);
                continue;
            }
            text_parts.extend(item.text_segments());
        }
        Self {
            output_text: text_parts.join("\n").trim().to_string(),
            function_calls,
            usage: body.usage.unwrap_or_default(),
        }
    }
}

#[derive(Debug, Deserialize)]
struct OpenAiResponseBody {
    output: Vec<ResponseItem>,
    usage: Option<Usage>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct Usage {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub total_tokens: Option<u64>,
}

impl Usage {
    fn merge(&mut self, other: Usage) {
        self.input_tokens = sum_optional(self.input_tokens, other.input_tokens);
        self.output_tokens = sum_optional(self.output_tokens, other.output_tokens);
        self.total_tokens = sum_optional(self.total_tokens, other.total_tokens);
    }
}

fn sum_optional(left: Option<u64>, right: Option<u64>) -> Option<u64> {
    match (left, right) {
        (Some(lhs), Some(rhs)) => Some(lhs + rhs),
        (Some(lhs), None) => Some(lhs),
        (None, Some(rhs)) => Some(rhs),
        (None, None) => None,
    }
}

#[derive(Debug, Clone, Deserialize)]
struct ResponseItem {
    #[serde(rename = "type")]
    item_type: String,
    name: Option<String>,
    arguments: Option<String>,
    call_id: Option<String>,
    content: Option<Vec<ResponseContent>>,
}

impl ResponseItem {
    fn as_function_call(&self) -> Option<FunctionCall> {
        if self.item_type != "function_call" {
            return None;
        }
        Some(FunctionCall {
            name: self.name.clone().unwrap_or_default(),
            arguments: self.arguments.clone().unwrap_or_else(|| "{}".to_string()),
            call_id: self.call_id.clone().unwrap_or_default(),
        })
    }

    fn text_segments(&self) -> Vec<String> {
        self.content
            .clone()
            .unwrap_or_default()
            .into_iter()
            .filter(|item| item.content_type == "output_text")
            .filter_map(|item| item.text)
            .collect()
    }
}

#[derive(Debug, Clone, Deserialize)]
struct ResponseContent {
    #[serde(rename = "type")]
    content_type: String,
    text: Option<String>,
}

#[derive(Debug, Clone)]
pub struct FunctionCall {
    pub name: String,
    pub arguments: String,
    pub call_id: String,
}

#[cfg(test)]
mod tests {
    use super::{
        BenchmarkModel, FunctionCall, ModelRequest, ModelResponse, ToolLoopConfig, Usage,
        next_codex_schema_path, run_tool_loop,
    };
    use anyhow::Result;
    use async_trait::async_trait;
    use serde_json::json;
    use std::collections::HashSet;
    use std::sync::Mutex;

    struct MockModel {
        responses: Mutex<Vec<ModelResponse>>,
    }

    #[async_trait]
    impl BenchmarkModel for MockModel {
        async fn create_response(&self, _request: ModelRequest) -> Result<ModelResponse> {
            let mut responses = self
                .responses
                .lock()
                .expect("responses lock should succeed");
            Ok(responses.remove(0))
        }
    }

    #[tokio::test]
    async fn run_tool_loop_replays_function_call_outputs() {
        let provider = MockModel {
            responses: Mutex::new(vec![
                ModelResponse {
                    output_text: String::new(),
                    function_calls: vec![FunctionCall {
                        name: "search".to_string(),
                        arguments: "{\"query_text\":\"meeting\"}".to_string(),
                        call_id: "call-1".to_string(),
                    }],
                    usage: Usage {
                        input_tokens: Some(10),
                        output_tokens: Some(5),
                        total_tokens: Some(15),
                    },
                },
                ModelResponse {
                    output_text: "March 15, 2024".to_string(),
                    function_calls: Vec::new(),
                    usage: Usage {
                        input_tokens: Some(4),
                        output_tokens: Some(3),
                        total_tokens: Some(7),
                    },
                },
            ]),
        };
        let run = run_tool_loop(
            &provider,
            ModelRequest {
                model: "gpt-5".to_string(),
                input: vec![json!({"role":"user","content":"When is the meeting?"})],
                tools: vec![json!({"type":"function","name":"search"})],
            },
            &ToolLoopConfig { max_roundtrips: 4 },
            |_name, _arguments| async { Ok("{\"hits\":[{\"path\":\"/Wiki/a.md\"}]}".to_string()) },
        )
        .await
        .expect("tool loop should finish");
        assert_eq!(run.answer, "March 15, 2024");
        assert_eq!(run.tool_calls.len(), 1);
        assert_eq!(run.total_tokens, Some(22));
    }

    #[test]
    fn codex_schema_paths_are_unique() {
        let paths = (0..16)
            .map(|_| next_codex_schema_path())
            .collect::<Vec<_>>();
        let unique = paths.iter().collect::<HashSet<_>>();
        assert_eq!(paths.len(), unique.len());
    }
}
