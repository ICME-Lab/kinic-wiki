// Where: crates/vfs_cli_app/src/beam_bench/model.rs
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
use vfs_cli::connection::ResolvedConnection;

use super::dataset::BeamQuestionClass;
use super::question_types::{canonical_note_candidates, normalize_question_type};

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
        .arg("model_reasoning_effort=\"low\"")
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
    let benchmark_workflow = benchmark_workflow_rules(context);
    let answer_shape = benchmark_answer_shape_rules(context.question_type);
    format!(
        r#"You are answering a BEAM-derived wiki benchmark question using llm-wiki.

Follow the embedded query skill contract. This run is stateless. Do not rely on prior turns.

{skill}

Benchmark-specific workflow overrides:
{benchmark_workflow}

Benchmark-specific answer-shape rules:
{answer_shape}

Runtime constraints:
- Use shell commands only through `cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- ...`
- Allowed read-only subcommands only:
  - read-node
  - read-node-context
  - list-nodes
  - search-remote
  - search-path-remote
  - recent-nodes
  - graph-neighborhood
  - graph-links
  - incoming-links
  - outgoing-links
- Do not use write-node, append-node, edit-node, multi-edit-node, delete-node, delete-tree, or rebuild-index
- If evidence is insufficient, answer exactly `insufficient evidence`
- Return the final answer in the same language and terminology as the supporting note span. Do not translate note content into Japanese or another language unless the note itself uses that language.

Use this exact argument order. Do not put connection flags after the subcommand. Always request JSON output:

```bash
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- {connection_args} read-node --path /Wiki/index.md --json
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- {connection_args} read-node-context --path {namespace_index_path} --link-limit 20 --json
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- {connection_args} list-nodes --prefix {namespace_path} --recursive --json
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- {connection_args} list-nodes --prefix {base_path} --recursive --json
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- {connection_args} search-remote --prefix {base_path} "query text" --json
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- {connection_args} search-path-remote "query text" --prefix {base_path} --json
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- {connection_args} read-node-context --path {base_path}/index.md --link-limit 20 --json
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- {connection_args} read-node-context --path <discovered path> --link-limit 20 --json
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- {connection_args} graph-neighborhood --center-path <discovered path> --depth 1 --limit 100 --json
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
        benchmark_workflow = benchmark_workflow,
        answer_shape = answer_shape,
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

fn benchmark_workflow_rules(context: &CodexQuestionContext<'_>) -> String {
    let canonical = canonical_note_candidates(context.question_type)
        .iter()
        .map(|note| format!("{}/{}", context.base_path, note))
        .collect::<Vec<_>>();
    let primary = canonical
        .first()
        .cloned()
        .unwrap_or_else(|| format!("{}/{}", context.base_path, "facts.md"));
    format!(
        "- Read `{}` first after the namespace and conversation index.
- Treat that canonical note as the primary evidence target for question type `{}`.
- Do not run broad `search-path-remote` or `search-remote` before reading the canonical note.
- Use search only if the canonical note is missing, ambiguous, or clearly insufficient.
- Keep the read set narrow. For summary-like questions, expand only to the minimum supporting notes after reading `summary.md`.
- `summary.md` is a recap note, not the source of exact extraction for attribute or single-fact questions.
- `facts.md` is for stable facts, `events.md` is for chronology, `plans.md` is for directives and plans, `preferences.md` is for preferences, and `open_questions.md` is for contradictions and unresolved state.
- If you need extra support, prefer these canonical notes in order: {}.",
        primary,
        normalize_question_type(context.question_type),
        canonical.join(", "),
    )
}

fn benchmark_answer_shape_rules(question_type: &str) -> &'static str {
    match normalize_question_type(question_type).as_str() {
        "abstention" => {
            "- Only an explicit note statement that directly answers the requested detail counts as evidence.\n- If the notes mention the topic, entity, meeting, event, project, or person but do not state the requested detail, answer exactly `insufficient evidence`.\n- Do not infer discussion contents, rationale, criteria, advice, feedback, background, or prior projects from adjacent context.\n- Do not relabel a generic habit, plan, or reminder as a named technique unless the note explicitly does so."
        }
        "contradiction_resolution" => {
            "- If the notes show conflicting statements, do not pick one side as settled fact.\n- Explicitly say there is contradictory information and ask which statement is correct.\n- Do not answer with a flat yes/no unless the contradiction is explicitly resolved in the notes."
        }
        "temporal_reasoning" => {
            "- Extract the relevant dates, times, or sequence anchors from the notes before answering.\n- Compute the ordering or time difference from those explicit anchors.\n- Return the final temporal answer directly, without a recap paragraph."
        }
        "event_ordering" => {
            "- Return only the ordered events.\n- Keep the answer brief and sequence-focused.\n- Do not replace the order with a thematic summary."
        }
        "summarization" | "multi_session_reasoning" => {
            "- Use `summary.md` as the base note and add only the minimum supporting notes needed to complete the answer.\n- Compress the answer into 2-4 short points or sentences.\n- Prefer cross-session synthesis over single-event detail dumps."
        }
        "preference_following" | "instruction_following" => {
            "- Return a short recommendation or instruction that directly follows the note guidance.\n- Prefer concrete action wording over explanation-heavy summaries.\n- Keep the answer practical and immediately usable."
        }
        "information_extraction" => {
            "- Prefer exact extraction from `facts.md` when it directly answers the question.\n- Preserve the source-note language, wording, and value formatting; do not translate or paraphrase an exact span.\n- For pure slot questions such as `when`, `where`, `how many`, `which`, `what profession`, or `what amount`, prefer answer-only output and keep the smallest supported span.\n- For explanatory extraction questions such as `how did`, `what approach`, `what steps`, or `how did X influence Y`, answer with one short grounded sentence or two short clauses using note wording instead of a generic recap.\n- For multi-value extraction questions, return the requested values in the same order as the question instead of collapsing them into a generic summary.\n- If the question asks for plural values such as days, dates, or items, include every explicitly listed requested value, not just the first one.\n- For paired slot questions such as `when and where`, `age and role`, or several named dates, answer every requested slot in one short answer.\n- If the note confirms that a meeting, feedback, or advice existed but does not state the requested contents, answer exactly `insufficient evidence`."
        }
        "knowledge_update" => {
            "- Prefer exact extraction from `facts.md` when it directly answers the question.\n- For updates, return only the current or most recently scheduled value explicitly stated in the notes, not an inferred or older superseded value.\n- When multiple values appear for the same field, prefer the one tied to words like `current`, `latest`, `most recently`, `final`, `updated`, `should`, `aim`, `plan`, or the newest explicit date.\n- Preserve the source-note language and formatting for the updated value, including adjacent units or qualifiers when they are part of the value span.\n- Do not shorten an updated value to a nearby partial field such as just the number when the supported span is `4 hours of overtime` or `$4,000 for initial patent filing fees`.\n- If the notes describe an update event but do not state the resulting current value, answer exactly `insufficient evidence`."
        }
        _ => {
            "- Return the shortest grounded answer that matches the question shape.\n- Avoid unnecessary recap or speculation."
        }
    }
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
            if !command.contains("kinic-vfs-cli") && !command.contains("target/debug/kinic-vfs-cli")
            {
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
            "--canister-id" | "--path" | "--prefix" | "--top-k" | "--link-limit"
            | "--center-path" | "--depth" | "--limit" => {
                index += 2;
            }
            "read-node" => return Some("read-node"),
            "read-node-context" => return Some("read-node-context"),
            "list-nodes" => return Some("list-nodes"),
            "search-remote" => return Some("search-remote"),
            "search-path-remote" => return Some("search-path-remote"),
            "recent-nodes" => return Some("recent-nodes"),
            "graph-neighborhood" => return Some("graph-neighborhood"),
            "graph-links" => return Some("graph-links"),
            "incoming-links" => return Some("incoming-links"),
            "outgoing-links" => return Some("outgoing-links"),
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
    use std::collections::HashSet;
    use vfs_cli::connection::ResolvedConnection;

    fn test_context<'a>() -> CodexQuestionContext<'a> {
        test_context_with_type("information_extraction")
    }

    fn test_context_with_type<'a>(question_type: &'a str) -> CodexQuestionContext<'a> {
        CodexQuestionContext {
            namespace_path: "/Wiki/run-a",
            namespace_index_path: "/Wiki/run-a/index.md",
            base_path: "/Wiki/run-a/conv-1",
            conversation_id: "conv-1",
            question_id: "factoid-000",
            question_type,
            question_class: BeamQuestionClass::Factoid,
            question: "When is the meeting?",
            codex_sandbox: "workspace-write",
        }
    }

    fn test_connection() -> ResolvedConnection {
        ResolvedConnection {
            replica_host: "http://127.0.0.1:8000".to_string(),
            canister_id: "aaaaa-aa".to_string(),
            database_id: Some("default".to_string()),
            replica_host_source: "test".to_string(),
            canister_id_source: "test".to_string(),
            database_id_source: Some("test".to_string()),
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
    fn codex_prompt_includes_benchmark_routing_guidance() {
        let prompt = codex_prompt(&test_context(), &test_connection());
        assert!(!prompt.contains("structured notes are preferred"));
        assert!(!prompt.contains("Stay within the wiki prefix"));
        assert!(!prompt.contains("Start from `/Wiki/index.md`"));
        assert!(prompt.contains("Do not use write-node"));
        assert!(prompt.contains("insufficient evidence"));
        assert!(prompt.contains("Do not translate note content into Japanese"));
        assert!(!prompt.contains("Query skill contract could not be loaded"));
        assert!(!prompt.contains(&format!("{}/beam", "/Wiki")));
        assert!(
            prompt.contains("read-node-context --path /Wiki/run-a/index.md --link-limit 20 --json")
        );
        assert!(prompt.contains(
            "graph-neighborhood --center-path <discovered path> --depth 1 --limit 100 --json"
        ));
        assert!(prompt.contains("Benchmark-specific workflow overrides:"));
        assert!(prompt.contains(
            "Read `/Wiki/run-a/conv-1/facts.md` first after the namespace and conversation index."
        ));
        assert!(prompt.contains("Do not run broad `search-path-remote` or `search-remote` before reading the canonical note."));
    }

    #[test]
    fn codex_prompt_embeds_scope_and_abstention_rules_from_skill() {
        let prompt = codex_prompt(&test_context(), &test_connection());
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
            "For pure slot questions such as `when`, `where`, `how many`, `which`, `what profession`, or `what amount`, prefer answer-only output"
        ));
        assert!(prompt.contains(
            "Do not return `insufficient evidence` while a higher-priority canonical note remains unread."
        ));
        assert!(prompt.contains(
            "For pure slot questions such as `when`, `where`, `how many`, `which`, `what profession`, or `what amount`, prefer answer-only output"
        ));
        assert!(prompt.contains(
            "For multi-value extraction questions, return the requested values in the same order as the question instead of collapsing them into a generic summary."
        ));
        assert!(prompt.contains(
            "For paired slot questions such as `when and where`, `age and role`, or several named dates, answer every requested slot in one short answer."
        ));
        assert!(prompt.contains(
            "Preserve the source-note language, wording, and value formatting; do not translate or paraphrase an exact span."
        ));
        assert!(!prompt.contains("Benchmark-specific extraction exemplars:"));

        let abstention_prompt =
            codex_prompt(&test_context_with_type("abstention"), &test_connection());
        assert!(abstention_prompt.contains(
            "For abstention questions, only an explicit statement in a note counts as evidence."
        ));
        assert!(abstention_prompt.contains(
            "If the notes mention the topic, entity, meeting, event, project, or person but do not state the requested detail, answer exactly `insufficient evidence`."
        ));
        assert!(abstention_prompt.contains(
            "Do not infer discussion contents, rationale, criteria, advice, feedback, background, or prior projects from adjacent context."
        ));
        assert!(abstention_prompt.contains(
            "Do not relabel a generic habit, plan, or reminder as a named technique unless the note explicitly does so."
        ));

        let update_prompt = codex_prompt(
            &test_context_with_type("knowledge_update"),
            &test_connection(),
        );
        assert!(update_prompt.contains(
            "If the notes describe an update event but do not state the resulting current value, answer exactly `insufficient evidence`."
        ));
        assert!(update_prompt.contains(
            "For updates, return only the current or most recently scheduled value explicitly stated in the notes"
        ));
        assert!(
            update_prompt.contains("Do not shorten an updated value to a nearby partial field")
        );
    }

    #[test]
    fn codex_prompt_includes_question_type_specific_answer_shapes() {
        let contradiction_prompt = codex_prompt(
            &test_context_with_type("contradiction_resolution"),
            &test_connection(),
        );
        assert!(contradiction_prompt.contains(
            "Explicitly say there is contradictory information and ask which statement is correct."
        ));
        assert!(contradiction_prompt.contains("/Wiki/run-a/conv-1/open_questions.md"));

        let temporal_prompt = codex_prompt(
            &test_context_with_type("temporal_reasoning"),
            &test_connection(),
        );
        assert!(temporal_prompt.contains(
            "Extract the relevant dates, times, or sequence anchors from the notes before answering."
        ));
        assert!(temporal_prompt.contains("/Wiki/run-a/conv-1/events.md"));

        let summary_prompt = codex_prompt(
            &test_context_with_type("multi_session_reasoning"),
            &test_connection(),
        );
        assert!(summary_prompt.contains(
            "Use `summary.md` as the base note and add only the minimum supporting notes needed to complete the answer."
        ));
        assert!(summary_prompt.contains("/Wiki/run-a/conv-1/summary.md"));

        let extraction_prompt = codex_prompt(
            &test_context_with_type("information_extraction"),
            &test_connection(),
        );
        assert!(extraction_prompt.contains(
            "For explanatory extraction questions such as `how did`, `what approach`, `what steps`, or `how did X influence Y`, answer with one short grounded sentence or two short clauses"
        ));
        assert!(extraction_prompt.contains(
            "If the question asks for plural values such as days, dates, or items, include every explicitly listed requested value, not just the first one."
        ));
    }
}
