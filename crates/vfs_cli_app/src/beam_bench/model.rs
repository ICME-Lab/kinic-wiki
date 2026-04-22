// Where: crates/wiki_cli/src/beam_bench/model.rs
// What: Codex CLI integration for BEAM benchmark runs.
// Why: The harness now executes only the Codex-based read-only retrieval flow.
use anyhow::{Context, Result, anyhow};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::fs;
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;

use super::dataset::BeamQuestionClass;
use crate::connection::ResolvedConnection;

#[derive(Debug, Clone, Serialize, Deserialize)]
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
    pub spawned_at_ms: u64,
    pub pid: Option<u32>,
    pub exit_status: Option<i32>,
    pub timed_out: bool,
    pub failure_message: Option<String>,
    pub stderr: String,
    pub schema_path: String,
    pub last_tool_name: Option<String>,
    pub last_tool_arguments: Option<String>,
}

static CODEX_SCHEMA_COUNTER: AtomicU64 = AtomicU64::new(0);
const CODEX_TIMEOUT: Duration = Duration::from_secs(120);

pub(crate) struct CodexQuestionContext<'a> {
    pub namespace_path: &'a str,
    pub namespace_index_path: &'a str,
    pub base_path: &'a str,
    pub conversation_id: &'a str,
    pub question_id: &'a str,
    pub question_type: &'a str,
    pub question_class: BeamQuestionClass,
    pub question: &'a str,
    pub codex_sandbox: &'a str,
}

pub(crate) async fn run_codex_question(
    codex_bin: &Path,
    model: &str,
    connection: &ResolvedConnection,
    context: CodexQuestionContext<'_>,
) -> Result<ModelRun> {
    let started_at = Instant::now();
    let schema_path = next_codex_schema_path();
    let spawned_at_ms = unix_timestamp_ms();
    tokio::fs::write(&schema_path, codex_answer_schema().to_string())
        .await
        .with_context(|| "failed to write Codex output schema")?;
    let prompt = codex_prompt(&context, connection);
    let mut child = Command::new(codex_bin)
        .arg("exec")
        .arg("--json")
        .arg("--ephemeral")
        .arg("--cd")
        .arg(std::env::current_dir().with_context(|| "failed to resolve current dir")?)
        .arg("--sandbox")
        .arg(context.codex_sandbox)
        .arg("-c")
        .arg("model_reasoning_effort=\"none\"")
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
    let pid = child.id();
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
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow!("failed to capture Codex stdout"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| anyhow!("failed to capture Codex stderr"))?;
    let stdout_task = tokio::spawn(read_pipe(stdout));
    let stderr_task = tokio::spawn(read_pipe(stderr));
    let (status, timed_out) = match tokio::time::timeout(CODEX_TIMEOUT, child.wait()).await {
        Ok(status) => (
            status.with_context(|| "failed to wait for Codex CLI")?,
            false,
        ),
        Err(_) => {
            let _ = child.start_kill();
            let status = child
                .wait()
                .await
                .with_context(|| "failed to reap timed out Codex CLI")?;
            (status, true)
        }
    };
    let stdout = join_pipe(stdout_task).await?;
    let stderr = join_pipe(stderr_task).await?;
    let _ = tokio::fs::remove_file(&schema_path).await;
    let stderr_text = String::from_utf8_lossy(&stderr).into_owned();
    let stdout_text = String::from_utf8_lossy(&stdout);
    let raw_events = parse_jsonl_events(&stdout_text);
    let tool_calls = parse_codex_tool_calls(&raw_events);
    let usage = parse_codex_usage(&raw_events);
    let (last_tool_name, last_tool_arguments) = last_tool_call(&tool_calls);
    let failure_message = if timed_out {
        Some(format!(
            "Codex CLI timed out after {}s",
            CODEX_TIMEOUT.as_secs()
        ))
    } else if !status.success() {
        Some(format!("Codex CLI failed: {}", stderr_text))
    } else {
        None
    };
    let answer = if failure_message.is_none() {
        match parse_codex_answer(&raw_events) {
            Ok(answer) => answer,
            Err(error) => {
                return Ok(ModelRun {
                    answer: String::new(),
                    tool_calls,
                    input_tokens: usage.input_tokens,
                    output_tokens: usage.output_tokens,
                    total_tokens: usage.total_tokens,
                    latency_ms: started_at.elapsed().as_millis(),
                    raw_events,
                    spawned_at_ms,
                    pid,
                    exit_status: status.code(),
                    timed_out,
                    failure_message: Some(error.to_string()),
                    stderr: stderr_text,
                    schema_path: schema_path.display().to_string(),
                    last_tool_name,
                    last_tool_arguments,
                });
            }
        }
    } else {
        String::new()
    };
    Ok(ModelRun {
        answer,
        tool_calls,
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        total_tokens: usage.total_tokens,
        latency_ms: started_at.elapsed().as_millis(),
        raw_events,
        spawned_at_ms,
        pid,
        exit_status: status.code(),
        timed_out,
        failure_message,
        stderr: stderr_text,
        schema_path: schema_path.display().to_string(),
        last_tool_name,
        last_tool_arguments,
    })
}

async fn read_pipe<R>(mut pipe: R) -> std::io::Result<Vec<u8>>
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut buffer = Vec::new();
    pipe.read_to_end(&mut buffer).await?;
    Ok(buffer)
}

async fn join_pipe(task: tokio::task::JoinHandle<std::io::Result<Vec<u8>>>) -> Result<Vec<u8>> {
    task.await
        .with_context(|| "failed to join Codex pipe reader")?
        .with_context(|| "failed to read Codex pipe")
}

fn unix_timestamp_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
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

fn codex_prompt(context: &CodexQuestionContext<'_>, connection: &ResolvedConnection) -> String {
    let connection_args = if connection.replica_host == "http://127.0.0.1:8000" {
        format!("--local --canister-id {}", connection.canister_id)
    } else {
        format!("--canister-id {}", connection.canister_id)
    };
    let skill = load_query_skill_contract()
        .unwrap_or_else(|error| format!("Query skill contract could not be loaded: {error}"));
    format!(
        r#"You are answering a BEAM-derived wiki benchmark question using llm-wiki.

Follow the embedded query skill contract. This run is stateless. Do not rely on prior turns.

{skill}

Runtime constraints:
- Use shell commands only through `cargo run -p vfs-cli --bin vfs-cli -- ...`
- Allowed read-only subcommands only:
  - read-node
  - list-nodes
  - search-remote
  - search-path-remote
  - recent-nodes
- Do not use write-node, append-node, edit-node, multi-edit-node, delete-node, delete-tree, rebuild-index, pull, or push
- If evidence is insufficient, answer exactly `insufficient evidence`

Use this exact argument order. Do not put connection flags after the subcommand. Always request JSON output:

```bash
cargo run -p vfs-cli --bin vfs-cli -- {connection_args} read-node --path /Wiki/index.md --json
cargo run -p vfs-cli --bin vfs-cli -- {connection_args} read-node --path {namespace_index_path} --json
cargo run -p vfs-cli --bin vfs-cli -- {connection_args} list-nodes --prefix {namespace_path} --recursive --json
cargo run -p vfs-cli --bin vfs-cli -- {connection_args} list-nodes --prefix {base_path} --recursive --json
cargo run -p vfs-cli --bin vfs-cli -- {connection_args} search-remote --prefix {base_path} "query text" --json
cargo run -p vfs-cli --bin vfs-cli -- {connection_args} search-path-remote "query text" --prefix {base_path} --json
cargo run -p vfs-cli --bin vfs-cli -- {connection_args} read-node --path {base_path}/index.md --json
cargo run -p vfs-cli --bin vfs-cli -- {connection_args} read-node --path <discovered path> --json
```

Connection:
- replica host: {replica_host}
- canister id: {canister_id}
- wiki namespace: {namespace_path}
- wiki prefix: {base_path}
- conversation id: {conversation_id}
- question id: {question_id}
- question type: {question_type}
- question class: {question_class}

Question:
{question}

Answer with JSON matching the provided output schema.
The `answer` field must match the question shape and stay grounded in the wiki notes.
"#,
        skill = skill,
        connection_args = connection_args,
        replica_host = connection.replica_host,
        canister_id = connection.canister_id,
        namespace_path = context.namespace_path,
        namespace_index_path = context.namespace_index_path,
        base_path = context.base_path,
        conversation_id = context.conversation_id,
        question_id = context.question_id,
        question_type = context.question_type,
        question_class = serde_json::to_string(&context.question_class)
            .unwrap_or_else(|_| "\"unknown\"".to_string()),
        question = context.question
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
            if !command.contains("vfs-cli") && !command.contains("target/debug/vfs-cli") {
                return None;
            }
            Some(ToolCallRecord {
                name: parse_wiki_cli_subcommand(command)
                    .unwrap_or("codex_shell")
                    .to_string(),
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

fn last_tool_call(tool_calls: &[ToolCallRecord]) -> (Option<String>, Option<String>) {
    tool_calls
        .last()
        .map(|call| (Some(call.name.clone()), Some(call.arguments.clone())))
        .unwrap_or((None, None))
}

fn load_query_skill_contract() -> Result<String> {
    let repo_root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .with_context(|| "failed to resolve workspace root from CARGO_MANIFEST_DIR")?;
    let skill_path = repo_root.join(".agents/skills/kinic-wiki-query/SKILL.md");
    let workflow_path = repo_root.join(".agents/skills/kinic-wiki-query/query.md");
    let answer_rules_path = repo_root.join(".agents/skills/references/query-rules.md");
    let skill = fs::read_to_string(&skill_path)
        .with_context(|| format!("failed to read {}", skill_path.display()))?;
    let workflow = fs::read_to_string(&workflow_path)
        .with_context(|| format!("failed to read {}", workflow_path.display()))?;
    let answer_rules = fs::read_to_string(&answer_rules_path)
        .with_context(|| format!("failed to read {}", answer_rules_path.display()))?;
    Ok(format!(
        "=== kinic-wiki-query/SKILL.md ===\n{skill}\n\n=== kinic-wiki-query/query.md ===\n{workflow}\n\n=== references/query-rules.md ===\n{answer_rules}"
    ))
}

fn parse_wiki_cli_subcommand(command: &str) -> Option<&'static str> {
    let args = command.split_whitespace().collect::<Vec<_>>();
    let separator = args.iter().position(|arg| *arg == "--")?;
    let mut index = separator + 1;
    while index < args.len() {
        let arg = args[index].trim_matches('\'').trim_matches('"');
        match arg {
            "--local" | "--json" | "--recursive" => {
                index += 1;
            }
            "--canister-id" | "--path" | "--prefix" | "--top-k" => {
                index += 2;
            }
            "read-node" => return Some("read-node"),
            "list-nodes" => return Some("list-nodes"),
            "search-remote" => return Some("search-remote"),
            "search-path-remote" => return Some("search-path-remote"),
            "recent-nodes" => return Some("recent-nodes"),
            _ => {
                index += 1;
            }
        }
    }
    None
}

#[derive(Debug, Deserialize)]
struct CodexUsage {
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct Usage {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub total_tokens: Option<u64>,
}

fn sum_optional(left: Option<u64>, right: Option<u64>) -> Option<u64> {
    match (left, right) {
        (Some(lhs), Some(rhs)) => Some(lhs + rhs),
        (Some(lhs), None) => Some(lhs),
        (None, Some(rhs)) => Some(rhs),
        (None, None) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::{CodexQuestionContext, codex_prompt, next_codex_schema_path};
    use crate::beam_bench::dataset::BeamQuestionClass;
    use crate::connection::ResolvedConnection;
    use std::collections::HashSet;

    fn test_context<'a>() -> CodexQuestionContext<'a> {
        CodexQuestionContext {
            namespace_path: "/Wiki/run-a",
            namespace_index_path: "/Wiki/run-a/index.md",
            base_path: "/Wiki/run-a/conv-1",
            conversation_id: "conv-1",
            question_id: "factoid-000",
            question_type: "information_extraction",
            question_class: BeamQuestionClass::Factoid,
            question: "When is the meeting?",
            codex_sandbox: "workspace-write",
        }
    }

    #[test]
    fn codex_schema_paths_are_unique() {
        let paths = (0..16)
            .map(|_| next_codex_schema_path())
            .collect::<Vec<_>>();
        let unique = paths.iter().collect::<HashSet<_>>();
        assert_eq!(paths.len(), unique.len());
    }

    #[test]
    fn codex_prompt_excludes_benchmark_specific_guidance() {
        let prompt = codex_prompt(
            &test_context(),
            &ResolvedConnection {
                replica_host: "http://127.0.0.1:8000".to_string(),
                canister_id: "aaaaa-aa".to_string(),
            },
        );
        assert!(!prompt.contains("structured notes are preferred"));
        assert!(!prompt.contains("Stay within the wiki prefix"));
        assert!(!prompt.contains("Start from `/Wiki/index.md`"));
        assert!(prompt.contains("Do not use write-node"));
        assert!(prompt.contains("insufficient evidence"));
        assert!(!prompt.contains("Query skill contract could not be loaded"));
        assert!(!prompt.contains(&format!("{}/beam", "/Wiki")));
        assert!(prompt.contains("read-node --path /Wiki/run-a/index.md --json"));
    }

    #[test]
    fn codex_prompt_embeds_scope_and_abstention_rules_from_skill() {
        let prompt = codex_prompt(
            &test_context(),
            &ResolvedConnection {
                replica_host: "http://127.0.0.1:8000".to_string(),
                canister_id: "aaaaa-aa".to_string(),
            },
        );
        assert!(prompt.contains("Prefer scope-first exploration."));
        assert!(prompt.contains("Preserve exact value formatting"));
        assert!(prompt.contains("Do not answer from an index, list, or search result alone."));
        assert!(prompt.contains("docs/internal/WIKI_CANONICALITY.md"));
        assert!(prompt.contains("=== references/query-rules.md ==="));
        assert!(prompt.contains(
            "Before the final answer, read at least one note that directly supports the answer."
        ));
        assert!(prompt.contains(
            "Treat the final answer as invalid until it is anchored to a note you actually read."
        ));
        assert!(prompt.contains("answer exactly `insufficient evidence`"));
        assert!(prompt.contains("do not answer from the index alone"));
        assert!(prompt.contains("prefer extraction over summarization"));
        assert!(prompt.contains("smallest answer span"));
        assert!(prompt.contains("- question type: information_extraction"));
        assert!(prompt.contains(
            "For abstention questions, only an explicit statement in a note counts as evidence."
        ));
        assert!(prompt.contains(
            "For abstention questions, do not treat recap notes or cross-note synthesis as direct evidence"
        ));
        assert!(!prompt.contains("facts.md を先に読め"));
    }
}
