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
use std::time::Instant;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use crate::connection::ResolvedConnection;

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

static CODEX_SCHEMA_COUNTER: AtomicU64 = AtomicU64::new(0);

pub async fn run_codex_question(
    codex_bin: &Path,
    model: &str,
    namespace_path: &str,
    namespace_index_path: &str,
    base_path: &str,
    question: &str,
    connection: &ResolvedConnection,
    codex_sandbox: &str,
) -> Result<ModelRun> {
    let started_at = Instant::now();
    let schema_path = next_codex_schema_path();
    tokio::fs::write(&schema_path, codex_answer_schema().to_string())
        .await
        .with_context(|| "failed to write Codex output schema")?;
    let prompt = codex_prompt(
        namespace_path,
        namespace_index_path,
        base_path,
        question,
        connection,
    );
    let mut child = Command::new(codex_bin)
        .arg("exec")
        .arg("--json")
        .arg("--ephemeral")
        .arg("--cd")
        .arg(std::env::current_dir().with_context(|| "failed to resolve current dir")?)
        .arg("--sandbox")
        .arg(codex_sandbox)
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

fn codex_prompt(
    namespace_path: &str,
    namespace_index_path: &str,
    base_path: &str,
    question: &str,
    connection: &ResolvedConnection,
) -> String {
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
- Use shell commands only through `cargo run -p wiki-cli --bin wiki-cli -- ...`
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
cargo run -p wiki-cli --bin wiki-cli -- {connection_args} read-node --path /Wiki/index.md --json
cargo run -p wiki-cli --bin wiki-cli -- {connection_args} read-node --path {namespace_index_path} --json
cargo run -p wiki-cli --bin wiki-cli -- {connection_args} list-nodes --prefix {namespace_path} --recursive --json
cargo run -p wiki-cli --bin wiki-cli -- {connection_args} list-nodes --prefix {base_path} --recursive --json
cargo run -p wiki-cli --bin wiki-cli -- {connection_args} search-remote --prefix {base_path} "query text" --json
cargo run -p wiki-cli --bin wiki-cli -- {connection_args} search-path-remote "query text" --prefix {base_path} --json
cargo run -p wiki-cli --bin wiki-cli -- {connection_args} read-node --path {base_path}/index.md --json
cargo run -p wiki-cli --bin wiki-cli -- {connection_args} read-node --path <discovered path> --json
```

Connection:
- replica host: {replica_host}
- canister id: {canister_id}
- wiki namespace: {namespace_path}
- wiki prefix: {base_path}

Question:
{question}

Answer with JSON matching the provided output schema. The `answer` field must be the shortest complete answer grounded in the wiki notes. If there is not enough evidence, set `answer` to exactly `insufficient evidence`.
"#,
        skill = skill,
        connection_args = connection_args,
        replica_host = connection.replica_host,
        canister_id = connection.canister_id,
        namespace_path = namespace_path,
        namespace_index_path = namespace_index_path,
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

fn load_query_skill_contract() -> Result<String> {
    let repo_root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .with_context(|| "failed to resolve workspace root from CARGO_MANIFEST_DIR")?;
    let skill_path = repo_root.join(".agents/skills/query/SKILL.md");
    let workflow_path = repo_root.join(".agents/skills/query/query.md");
    let skill = fs::read_to_string(&skill_path)
        .with_context(|| format!("failed to read {}", skill_path.display()))?;
    let workflow = fs::read_to_string(&workflow_path)
        .with_context(|| format!("failed to read {}", workflow_path.display()))?;
    Ok(format!(
        "=== query/SKILL.md ===\n{skill}\n\n=== query/query.md ===\n{workflow}"
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
    use super::{codex_prompt, next_codex_schema_path};
    use crate::connection::ResolvedConnection;
    use std::collections::HashSet;

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
            "/Wiki/run-a",
            "/Wiki/run-a/index.md",
            "/Wiki/run-a/conv-1",
            "When is the meeting?",
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
            "/Wiki/run-a",
            "/Wiki/run-a/index.md",
            "/Wiki/run-a/conv-1",
            "When is the meeting?",
            &ResolvedConnection {
                replica_host: "http://127.0.0.1:8000".to_string(),
                canister_id: "aaaaa-aa".to_string(),
            },
        );
        assert!(prompt.contains("Prefer scope-first exploration."));
        assert!(prompt.contains("Preserve exact value formatting"));
        assert!(prompt.contains("answer exactly `insufficient evidence`"));
        assert!(prompt.contains("do not answer from the index alone"));
        assert!(prompt.contains("Read `events.md` at least once before answering"));
        assert!(prompt.contains("prefer extraction over summarization"));
        assert!(prompt.contains("smallest answer span"));
        assert!(!prompt.contains("facts.md を先に読め"));
    }
}
