//! Local, strictly online experimental memory. Production promotion is separate.
use super::workflow::read_json;
use super::{ensure_parents, hash};
use crate::learning_evaluation::{
    self as evaluation, EvaluationMode, PreparedContext, SuiteManifest,
};
use crate::learning_runner::{self, Execution, RunnerConfig};
use anyhow::{Context, Result, ensure};
use clap::{Args, ValueEnum};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use vfs_cli::connection::ResolvedConnection;
use vfs_client::VfsApi;
use vfs_types::{NodeKind, WriteNodeRequest};
#[path = "stream_diagnostics.rs"]
mod diagnostics;
#[path = "stream_memory.rs"]
mod memory;
#[path = "paired.rs"]
pub mod paired;
use memory::*;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, ValueEnum, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum StreamPolicy {
    None,
    Raw,
    AppendOnly,
    Reharness,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, ValueEnum, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum StreamRetrieval {
    Lexical,
    Embedding,
}
#[derive(Clone, Debug, Args)]
pub struct StreamArgs {
    #[arg(long)]
    pub suite: PathBuf,
    #[arg(long)]
    pub runner_file: PathBuf,
    #[arg(long)]
    pub project_id: String,
    #[arg(long)]
    pub stream_id: String,
    #[arg(long, value_enum, default_value = "reharness")]
    pub policy: StreamPolicy,
    #[arg(long, value_enum, default_value = "embedding")]
    pub retrieval: StreamRetrieval,
    #[arg(long)]
    pub embedding_config: Option<PathBuf>,
    #[arg(long, default_value_t = 5)]
    pub top_k: usize,
    #[arg(long)]
    pub output: PathBuf,
    #[arg(long)]
    pub json: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Selected {
    index: usize,
    id: String,
    reflection: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Call {
    role: String,
    elapsed_ms: u64,
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    output: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Pending {
    index: usize,
    selected: Vec<Selected>,
    context: String,
    #[serde(default)]
    context_ref: Option<PayloadRef>,
    query_embedding: Option<Vec<f64>>,
    #[serde(default)]
    query_embedding_ref: Option<EmbeddingRef>,
    decision_started: Option<Value>,
    inference_started: Option<Value>,
    trajectory: Option<Value>,
    #[serde(default)]
    trajectory_ref: Option<PayloadRef>,
    success: bool,
    calls: Vec<Call>,
    revised: Vec<String>,
    fresh: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Step {
    task_id: String,
    success: bool,
    selected_ids: Vec<String>,
    supplied_context: String,
    #[serde(default)]
    supplied_context_ref: Option<PayloadRef>,
    decision_elapsed_ms: u64,
    revision_elapsed_ms: u64,
    write_elapsed_ms: u64,
    model_calls: usize,
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
struct StreamState {
    schema_version: u32,
    binding: String,
    memories: Vec<Memory>,
    steps: Vec<Step>,
    pending: Option<Pending>,
}
fn validate_stream_schema(version: u32) -> Result<()> {
    ensure!(
        matches!(version, 1 | 2),
        "unsupported stream state schema version {version}"
    );
    Ok(())
}
pub(super) fn local_endpoint(endpoint: &str) -> Result<()> {
    let url = reqwest::Url::parse(endpoint)?;
    ensure!(
        matches!(url.scheme(), "http" | "https")
            && url.username().is_empty()
            && url.password().is_none(),
        "invalid local endpoint"
    );
    ensure!(
        matches!(
            url.host_str(),
            Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
        ),
        "stream experiments require a loopback replica"
    );
    Ok(())
}
fn state_path(project: &str, stream: &str) -> Result<String> {
    ensure!(
        project.len() == 32 && project.bytes().all(|c| c.is_ascii_hexdigit()),
        "project id must be 32 hex characters"
    );
    ensure!(
        !stream.is_empty()
            && stream.len() <= 96
            && stream
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_')),
        "invalid stream id"
    );
    Ok(format!(
        "/Memory/projects/{project}/reharness/{stream}/state.json"
    ))
}
// Sidecars preserve exact IEEE-754 bits, avoiding decimal-parser roundoff.
#[derive(Clone, Debug, Serialize, Deserialize)]
struct EmbeddingRef {
    sha256: String,
    dimensions: usize,
}
#[derive(Serialize, Deserialize)]
struct EmbeddingBlob {
    schema_version: u32,
    bits: Vec<u64>,
}
fn embedding_path(state_path: &str, reference: &EmbeddingRef) -> Result<String> {
    ensure!(
        reference.sha256.len() == 64 && reference.sha256.bytes().all(|b| b.is_ascii_hexdigit()),
        "invalid embedding hash"
    );
    let parent = state_path
        .strip_suffix("/state.json")
        .context("invalid stream state path")?;
    Ok(format!("{parent}/embeddings/{}.json", reference.sha256))
}
fn embedding_body(vector: &[f64]) -> Result<String> {
    cosine(vector, vector)?;
    Ok(serde_json::to_string(&EmbeddingBlob {
        schema_version: 1,
        bits: vector.iter().map(|v| v.to_bits()).collect(),
    })?)
}
async fn store_embedding(
    client: &impl VfsApi,
    db: &str,
    path: &str,
    vector: &Option<Vec<f64>>,
    reference: &mut Option<EmbeddingRef>,
) -> Result<()> {
    let Some(vector) = vector else {
        ensure!(reference.is_none(), "embedding reference not hydrated");
        return Ok(());
    };
    let body = embedding_body(vector)?;
    let digest = hash(&body);
    if let Some(existing) = reference {
        ensure!(
            existing.sha256 == digest && existing.dimensions == vector.len(),
            "embedding reference/content mismatch"
        );
        return Ok(());
    }
    let new_ref = EmbeddingRef {
        sha256: digest,
        dimensions: vector.len(),
    };
    let blob_path = embedding_path(path, &new_ref)?;
    if let Some(existing) = client.read_node(db, &blob_path).await? {
        ensure!(
            existing.content == body,
            "immutable embedding sidecar was modified"
        );
    } else {
        let mut etag = None;
        // Concurrent identical content-addressed creation is harmless. State CAS
        // remains the sole execution ownership boundary; orphan blobs are inert.
        checkpoint(
            client,
            db,
            &blob_path,
            &EmbeddingBlob {
                schema_version: 1,
                bits: vector.iter().map(|v| v.to_bits()).collect(),
            },
            &mut etag,
        )
        .await?;
    }
    *reference = Some(new_ref);
    Ok(())
}
async fn load_embedding(
    client: &impl VfsApi,
    db: &str,
    path: &str,
    vector: &mut Option<Vec<f64>>,
    reference: &Option<EmbeddingRef>,
) -> Result<()> {
    let Some(reference) = reference else {
        if let Some(vector) = vector {
            cosine(vector, vector)?;
        }
        return Ok(());
    };
    let node = client
        .read_node(db, &embedding_path(path, reference)?)
        .await?
        .context("missing embedding sidecar")?;
    ensure!(
        hash(&node.content) == reference.sha256,
        "embedding sidecar hash mismatch"
    );
    let blob: EmbeddingBlob = serde_json::from_str(&node.content)?;
    ensure!(
        blob.schema_version == 1 && blob.bits.len() == reference.dimensions,
        "embedding sidecar dimension/schema mismatch"
    );
    let restored: Vec<f64> = blob.bits.into_iter().map(f64::from_bits).collect();
    cosine(&restored, &restored)?;
    if let Some(inline) = vector {
        ensure!(
            embedding_body(inline)? == embedding_body(&restored)?,
            "inline/reference embedding mismatch"
        );
    }
    *vector = Some(restored);
    Ok(())
}
async fn hydrate_embeddings(
    client: &impl VfsApi,
    db: &str,
    path: &str,
    state: &mut StreamState,
) -> Result<()> {
    for memory in &mut state.memories {
        load_embedding(
            client,
            db,
            path,
            &mut memory.embedding,
            &memory.embedding_ref,
        )
        .await?;
    }
    if let Some(pending) = &mut state.pending {
        load_embedding(
            client,
            db,
            path,
            &mut pending.query_embedding,
            &pending.query_embedding_ref,
        )
        .await?;
    }
    Ok(())
}
// Bounded immutable payloads keep original evidence and exact supplied text out
// of repeated state revisions. Every reference resolves only within this stream.
const PAYLOAD_CHUNK_BYTES: usize = 64 * 1024;
const MAX_PAYLOAD_BYTES: usize = 16 * 1024 * 1024;
const MAX_PAYLOAD_CHUNKS: usize = 512;
const MAX_STATE_PAYLOAD_BYTES: usize = 64 * 1024 * 1024;
#[derive(Clone, Debug, Serialize, Deserialize)]
struct PayloadChunkRef {
    sha256: String,
    bytes: usize,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
struct PayloadRef {
    sha256: String,
    bytes: usize,
    chunks: Vec<PayloadChunkRef>,
}
#[derive(Serialize, Deserialize)]
struct PayloadChunk {
    schema_version: u32,
    text: String,
}
fn valid_payload_hash(digest: &str) -> bool {
    digest.len() == 64
        && digest
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn payload_path(state_path: &str, digest: &str) -> Result<String> {
    ensure!(valid_payload_hash(digest), "invalid payload hash");
    let parent = state_path
        .strip_suffix("/state.json")
        .context("invalid stream state path")?;
    Ok(format!("{parent}/payloads/{digest}.json"))
}
fn validate_payload_ref(reference: &PayloadRef) -> Result<()> {
    ensure!(
        valid_payload_hash(&reference.sha256)
            && reference.bytes <= MAX_PAYLOAD_BYTES
            && !reference.chunks.is_empty()
            && reference.chunks.len() <= MAX_PAYLOAD_CHUNKS,
        "invalid or oversized payload reference"
    );
    let mut total = 0usize;
    for chunk in &reference.chunks {
        ensure!(
            valid_payload_hash(&chunk.sha256)
                && chunk.bytes > 0
                && chunk.bytes <= PAYLOAD_CHUNK_BYTES,
            "invalid payload chunk reference"
        );
        total = total
            .checked_add(chunk.bytes)
            .context("payload length overflow")?;
    }
    ensure!(
        total == reference.bytes,
        "payload reference length mismatch"
    );
    Ok(())
}
async fn store_payload(
    client: &impl VfsApi,
    db: &str,
    path: &str,
    text: &str,
    reference: &mut Option<PayloadRef>,
) -> Result<()> {
    ensure!(
        text.len() <= MAX_PAYLOAD_BYTES,
        "payload exceeds 16 MiB (no truncation performed)"
    );
    if let Some(existing) = reference {
        validate_payload_ref(existing)?;
        ensure!(
            existing.bytes == text.len() && existing.sha256 == hash(text),
            "immutable payload/reference mismatch"
        );
        return Ok(());
    }
    if text.is_empty() {
        return Ok(());
    }
    let mut chunks = vec![];
    let mut remaining = text;
    while !remaining.is_empty() {
        let mut end = remaining.len().min(PAYLOAD_CHUNK_BYTES);
        while !remaining.is_char_boundary(end) {
            end -= 1;
        }
        let part = &remaining[..end];
        let chunk = PayloadChunk {
            schema_version: 1,
            text: part.into(),
        };
        let body = serde_json::to_string(&chunk)?;
        let digest = hash(&body);
        let blob_path = payload_path(path, &digest)?;
        if let Some(existing) = client.read_node(db, &blob_path).await? {
            ensure!(
                existing.content == body,
                "immutable payload sidecar was modified"
            );
        } else {
            checkpoint(client, db, &blob_path, &chunk, &mut None).await?;
        }
        chunks.push(PayloadChunkRef {
            sha256: digest,
            bytes: part.len(),
        });
        remaining = &remaining[end..];
    }
    let value = PayloadRef {
        sha256: hash(text),
        bytes: text.len(),
        chunks,
    };
    validate_payload_ref(&value)?;
    *reference = Some(value);
    Ok(())
}
async fn load_payload(
    client: &impl VfsApi,
    db: &str,
    path: &str,
    reference: &PayloadRef,
) -> Result<String> {
    validate_payload_ref(reference)?; // Before allocation or remote reads.
    let mut text = String::with_capacity(reference.bytes);
    for chunk in &reference.chunks {
        let node = client
            .read_node(db, &payload_path(path, &chunk.sha256)?)
            .await?
            .context("missing payload sidecar")?;
        ensure!(
            node.content.len() <= PAYLOAD_CHUNK_BYTES * 6 + 128
                && hash(&node.content) == chunk.sha256,
            "payload chunk hash/size mismatch"
        );
        let payload: PayloadChunk = serde_json::from_str(&node.content)?;
        ensure!(
            payload.schema_version == 1 && payload.text.len() == chunk.bytes,
            "payload chunk schema/length mismatch"
        );
        text.push_str(&payload.text);
    }
    ensure!(
        text.len() == reference.bytes && hash(&text) == reference.sha256,
        "payload content hash/length mismatch"
    );
    Ok(text)
}
fn add_payload_budget(total: &mut usize, bytes: usize) -> Result<()> {
    *total = total
        .checked_add(bytes)
        .context("stream payload length overflow")?;
    ensure!(
        *total <= MAX_STATE_PAYLOAD_BYTES,
        "stream payloads exceed 64 MiB (no truncation performed)"
    );
    Ok(())
}
async fn hydrate_payloads(
    client: &impl VfsApi,
    db: &str,
    path: &str,
    state: &mut StreamState,
) -> Result<()> {
    let refs = state
        .memories
        .iter()
        .filter_map(|m| m.original_ref.as_ref())
        .chain(
            state
                .steps
                .iter()
                .filter_map(|s| s.supplied_context_ref.as_ref()),
        )
        .chain(
            state
                .pending
                .iter()
                .flat_map(|p| [p.context_ref.as_ref(), p.trajectory_ref.as_ref()])
                .flatten(),
        );
    let mut total = 0;
    for reference in refs {
        validate_payload_ref(reference)?;
        add_payload_budget(&mut total, reference.bytes)?;
    }
    for memory in &mut state.memories {
        if let Some(reference) = &memory.original_ref {
            let restored: Value =
                serde_json::from_str(&load_payload(client, db, path, reference).await?)?;
            ensure!(
                memory.original.is_null() || memory.original == restored,
                "inline/reference source mismatch"
            );
            memory.original = restored;
        }
    }
    for step in &mut state.steps {
        if let Some(reference) = &step.supplied_context_ref {
            let restored = load_payload(client, db, path, reference).await?;
            ensure!(
                step.supplied_context.is_empty() || step.supplied_context == restored,
                "inline/reference context mismatch"
            );
            step.supplied_context = restored;
        }
    }
    if let Some(pending) = &mut state.pending {
        if let Some(reference) = &pending.context_ref {
            let restored = load_payload(client, db, path, reference).await?;
            ensure!(
                pending.context.is_empty() || pending.context == restored,
                "inline/reference pending context mismatch"
            );
            pending.context = restored;
        }
        if let Some(reference) = &pending.trajectory_ref {
            let restored: Value =
                serde_json::from_str(&load_payload(client, db, path, reference).await?)?;
            ensure!(
                pending
                    .trajectory
                    .as_ref()
                    .is_none_or(|inline| *inline == restored),
                "inline/reference pending source mismatch"
            );
            pending.trajectory = Some(restored);
        }
    }
    Ok(())
}
async fn store_payloads(
    client: &impl VfsApi,
    db: &str,
    path: &str,
    state: &mut StreamState,
) -> Result<()> {
    let mut total = 0;
    for memory in &state.memories {
        add_payload_budget(&mut total, serde_json::to_string(&memory.original)?.len())?;
    }
    for step in &state.steps {
        add_payload_budget(&mut total, step.supplied_context.len())?;
    }
    if let Some(pending) = &state.pending {
        add_payload_budget(&mut total, pending.context.len())?;
        if let Some(source) = &pending.trajectory {
            add_payload_budget(&mut total, serde_json::to_string(source)?.len())?;
        }
    }
    for memory in &mut state.memories {
        store_payload(
            client,
            db,
            path,
            &serde_json::to_string(&memory.original)?,
            &mut memory.original_ref,
        )
        .await?;
    }
    for step in &mut state.steps {
        store_payload(
            client,
            db,
            path,
            &step.supplied_context,
            &mut step.supplied_context_ref,
        )
        .await?;
    }
    if let Some(pending) = &mut state.pending {
        store_payload(client, db, path, &pending.context, &mut pending.context_ref).await?;
        if let Some(source) = &pending.trajectory {
            store_payload(
                client,
                db,
                path,
                &serde_json::to_string(source)?,
                &mut pending.trajectory_ref,
            )
            .await?;
        } else {
            ensure!(
                pending.trajectory_ref.is_none(),
                "pending source reference not hydrated"
            );
        }
    }
    Ok(())
}

async fn checkpoint_state(
    client: &impl VfsApi,
    db: &str,
    path: &str,
    state: &mut StreamState,
    etag: &mut Option<String>,
) -> Result<()> {
    store_payloads(client, db, path, state).await?;
    for memory in &mut state.memories {
        store_embedding(
            client,
            db,
            path,
            &memory.embedding,
            &mut memory.embedding_ref,
        )
        .await?;
    }
    if let Some(pending) = &mut state.pending {
        store_embedding(
            client,
            db,
            path,
            &pending.query_embedding,
            &mut pending.query_embedding_ref,
        )
        .await?;
    }
    // v1 readers ignore source/context references. Mark every new checkpoint
    // v2 so those readers reject it rather than consuming stripped placeholders.
    state.schema_version = 2;
    let mut stored = state.clone();
    for memory in &mut stored.memories {
        if memory.original_ref.is_some() {
            memory.original = Value::Null;
        }
        if memory.embedding_ref.is_some() {
            memory.embedding = None;
        }
    }
    for step in &mut stored.steps {
        if step.supplied_context_ref.is_some() {
            step.supplied_context.clear();
        }
    }
    if let Some(pending) = &mut stored.pending {
        if pending.context_ref.is_some() {
            pending.context.clear();
        }
        if pending.trajectory_ref.is_some() {
            pending.trajectory = None;
        }
        if pending.query_embedding_ref.is_some() {
            pending.query_embedding = None;
        }
    }
    checkpoint(client, db, path, &stored, etag).await
}

async fn checkpoint(
    client: &impl VfsApi,
    db: &str,
    path: &str,
    value: &impl Serialize,
    etag: &mut Option<String>,
) -> Result<()> {
    let body = serde_json::to_string(value)?;
    ensure!(
        body.len() <= 900_000,
        "stream checkpoint exceeds 900 KB; start a shorter independent stream (no truncation performed)"
    );
    if etag.is_none() {
        ensure_parents(client, db, path).await?;
    }
    match client
        .write_node(WriteNodeRequest {
            database_id: db.into(),
            path: path.into(),
            kind: NodeKind::File,
            content: body.clone(),
            metadata_json: "{\"authority\":\"agent\",\"kind\":\"reharness.experimental.stream\"}"
                .into(),
            expected_etag: etag.clone(),
        })
        .await
    {
        Ok(result) => {
            *etag = Some(result.node.etag);
            Ok(())
        }
        Err(error) => {
            let current = client.read_node(db, path).await?;
            if let Some(current) = current.filter(|n| n.content == body) {
                *etag = Some(current.etag);
                Ok(())
            } else {
                Err(error)
            }
        }
    }
}
fn public_trajectory(
    task: &str,
    execution: &Execution,
    checks: &[evaluation::VerificationResult],
    success: bool,
) -> Value {
    // Deliberate allowlist: no hidden reasoning, provider event envelopes, or
    // verifier argv/answer-file paths are supplied to the memory agents.
    let tools:Vec<_>=execution.events.iter().filter_map(|event| {
        if event.get("method").and_then(Value::as_str) == Some("session.event") {
            let ev = event.get("params")?.get("event")?;
            let data = ev.get("data")?;
            return match ev.get("type").and_then(Value::as_str) {
                Some("tool/call") => Some(json!({"tool":data.get("name"),"arguments":data.get("arguments")})),
                Some("tool/result") => {
                    let message = data.get("message")?;
                    let content:Vec<_> = message.get("content")?.as_array()?.iter()
                        .filter(|part| part.get("type").and_then(Value::as_str)==Some("text"))
                        .filter_map(|part|part.get("text")).collect();
                    Some(json!({"result":content,"is_error":message.get("isError")}))
                }
                _ => None,
            };
        }
        let item=event.get("item")?;
        if item.get("type").and_then(Value::as_str)!=Some("command_execution") {return None;}
        if event.get("type").and_then(Value::as_str)!=Some("item.completed") {return None;}
        Some(json!({"command":item.get("command"),"output":item.get("aggregated_output"),"exit_code":item.get("exit_code")}))
    }).collect();
    json!({"query":task,"observations":tools,"answer":execution.output,"reward":if success {1}else{0},
        "feedback":checks.iter().map(|c|json!({"passed":c.passed,"stdout":c.stdout,"stderr":c.stderr,"timed_out":c.timed_out,"output_truncated":c.output_truncated})).collect::<Vec<_>>()})
}
fn validate_memory_execution(result: &Execution, role: &str) -> Result<()> {
    ensure!(
        result.complete,
        "{role} agent did not complete: {}",
        result.exit_reason
    );
    // Acceptance boundary only: the runner may already have executed the tool.
    // Do not publish tool-assisted memory or claim this proves factual grounding.
    for event in &result.events {
        if matches!(
            event["type"].as_str(),
            Some("item.started" | "item.updated" | "item.completed")
        ) {
            // Known Codex non-tool items. Unknown/new item types fail closed;
            // command, file, MCP, web, image and delegation items cannot pass.
            ensure!(
                matches!(
                    event["item"]["type"].as_str(),
                    Some("agent_message" | "reasoning" | "error")
                ),
                "{role} memory inference rejected observed tool or unsupported item activity"
            );
        }
        if event["method"] == "session.event" {
            let kind = event["params"]["event"]["type"].as_str().unwrap_or("");
            ensure!(
                !kind.starts_with("tool/"),
                "{role} memory inference rejected observed tool activity"
            );
        }
        ensure!(
            !matches!(
                event["method"].as_str(),
                Some("subagent.started" | "subagent.finished")
            ),
            "{role} memory inference rejected observed delegated tool activity"
        );
    }
    Ok(())
}
async fn infer(
    config: &RunnerConfig,
    dir: &Path,
    prompt: &str,
    key: &str,
    role: &str,
) -> Result<Call> {
    let mut config = config.clone();
    config.read_only = true;
    let result = learning_runner::execute(&config, dir, prompt)
        .await
        .map_err(|error| {
            diagnostics::record(
                dir,
                &config.engine,
                role,
                "launch_or_configuration",
                None,
                error,
            )
        })?;
    validate_memory_execution(&result, role).map_err(|error| {
        diagnostics::record(
            dir,
            &config.engine,
            role,
            if result.complete {
                "execution_validation"
            } else {
                "execution"
            },
            Some(&result),
            error,
        )
    })?;
    let mut public = Value::String(reflection_json(&result.output, key).map_err(|error| {
        diagnostics::record(
            dir,
            &config.engine,
            role,
            "output_validation",
            Some(&result),
            error,
        )
    })?);
    super::redaction::redact(&mut public);
    super::redaction::redact_with_secrets(&mut public, &evaluation::secret_values(&config));
    let output = public.as_str().unwrap().to_string();
    Ok(Call {
        role: role.into(),
        output,
        elapsed_ms: result.elapsed_ms,
        input_tokens: result.input_tokens,
        output_tokens: result.output_tokens,
    })
}
fn write_report(
    output: &Path,
    args: &StreamArgs,
    path: &str,
    state: &StreamState,
    total: usize,
    embedding: Option<&StreamEmbedding>,
    runner: &RunnerConfig,
) -> Result<Value> {
    let report = json!({"schema_version":1,"runner":{"engine":runner.engine,"model":runner.model,"reasoning_effort":runner.reasoning_effort,"timeout_seconds":runner.timeout_seconds},"stream_id":args.stream_id,"project_id":args.project_id,
        "policy":args.policy,"retrieval":args.retrieval,"top_k":args.top_k,"state_path":path,
        "binding":state.binding,"completed":state.pending.is_none() && state.steps.len()==total,"steps":state.steps,
        "fidelity":{"protocol":"read-decision-feedback-per-memory-revision-forward-write","retrieval_model":embedding.map(|e|e.model.as_str()),"retrieval_model_revision":embedding.and_then(|e|e.model_revision.as_deref()),"retrieval_revision_verification":"caller-declared; endpoint artifacts require independent verification",
        "lexical_deviation":args.retrieval==StreamRetrieval::Lexical,"benchmark":"caller supplied; not verified as paper dataset","source_grounding":"paper prompt constraint; not a factual proof","decision_interface":"native coding agent; not paper structured-action prompt"}});
    let tmp = output.join("report.json.pending");
    std::fs::write(&tmp, serde_json::to_vec_pretty(&report)?)?;
    std::fs::rename(tmp, output.join("report.json"))?;
    Ok(report)
}
fn claim_inference(pending: &mut Pending, owner: &str) -> Result<()> {
    ensure!(
        pending.inference_started.is_none(),
        "memory inference was interrupted; accounting is incomplete, start a new stream"
    );
    pending.inference_started = Some(reservation(pending.calls.len(), owner));
    Ok(())
}
fn resolve_runner(runner: &RunnerConfig) -> Result<PathBuf> {
    if runner.executable.components().count() > 1 {
        return Ok(runner.executable.canonicalize()?);
    }
    let search = runner
        .environment
        .get("PATH")
        .cloned()
        .or_else(|| {
            if runner.env_clear {
                None
            } else {
                std::env::var("PATH").ok()
            }
        })
        .context("bare runner command requires an explicit or inherited PATH")?;
    for directory in std::env::split_paths(&search) {
        let candidate = directory.join(&runner.executable);
        if candidate.is_file() {
            return Ok(candidate.canonicalize()?);
        }
    }
    anyhow::bail!("runner executable not found in effective PATH")
}
fn content_bindings(paths: &[PathBuf]) -> Result<Value> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let mut entries = std::collections::BTreeMap::new();
    for path in paths.iter().filter(|p| p.is_file()) {
        let path = path.canonicalize()?;
        let mut file = std::fs::File::open(&path)?;
        let mut hasher = Sha256::new();
        let mut buffer = [0u8; 65536];
        loop {
            let n = file.read(&mut buffer)?;
            if n == 0 {
                break;
            }
            hasher.update(&buffer[..n]);
        }
        entries.insert(
            path.to_string_lossy().into_owned(),
            format!("{:x}", hasher.finalize()),
        );
    }
    Ok(serde_json::to_value(entries)?)
}
fn reservation(index: usize, owner: &str) -> Value {
    json!({"index":index,"owner":owner})
}
pub async fn run(client: &impl VfsApi, c: &ResolvedConnection, args: &StreamArgs) -> Result<Value> {
    let controller = hash(&format!(
        "{}:{}",
        std::process::id(),
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
    ));
    local_endpoint(&c.replica_host)?;
    let db = c.database_id.as_deref().context("database required")?;
    let principal = client
        .caller_principal()
        .context("authenticated caller required")?;
    let path = state_path(&args.project_id, &args.stream_id)?;
    ensure!((1..=32).contains(&args.top_k), "top-k must be 1..32");
    let mut suite: SuiteManifest = read_json(&args.suite)?;
    suite.resolve_paths(args.suite.parent().unwrap_or(Path::new(".")))?;
    suite.validate()?;
    ensure!(suite.tasks.len() <= 100, "stream exceeds 100 instances");
    let mut runner: RunnerConfig = read_json(&args.runner_file)?;
    ensure!(
        runner.model.is_some(),
        "stream runner must pin model explicitly"
    );
    runner.executable = resolve_runner(&runner)?;
    let embedding: Option<StreamEmbedding> = args
        .embedding_config
        .as_deref()
        .map(read_json)
        .transpose()?;
    ensure!(
        args.retrieval != StreamRetrieval::Embedding || embedding.is_some(),
        "embedding retrieval requires --embedding-config; lexical pilot must be explicit"
    );
    let mut bound_files = vec![runner.executable.clone()];
    for task in &suite.tasks {
        for argv in &task.verification {
            bound_files.extend(argv.iter().map(PathBuf::from));
        }
    }
    let artifacts = content_bindings(&bound_files)?;
    let binding = hash(&serde_json::to_string(
        &json!({"schema":1,"suite":suite,"runner":runner,"embedding":embedding,"artifacts":artifacts,
        "policy":args.policy,"retrieval":args.retrieval,"top_k":args.top_k,"project":args.project_id,"stream":args.stream_id,
        "endpoint":c.replica_host,"canister":c.canister_id,"db":db,"principal":principal}),
    )?);
    let existing = client.read_node(db, &path).await?;
    let mut etag = existing.as_ref().map(|n| n.etag.clone());
    let mut state = match existing {
        Some(node) => serde_json::from_str::<StreamState>(&node.content)?,
        None => StreamState {
            schema_version: 2,
            binding: binding.clone(),
            memories: vec![],
            steps: vec![],
            pending: None,
        },
    };
    validate_stream_schema(state.schema_version)?;
    ensure!(
        state.binding == binding,
        "stream binding changed; use a new stream id"
    );
    hydrate_embeddings(client, db, &path, &mut state).await?;
    hydrate_payloads(client, db, &path, &mut state).await?;
    if args.output.exists() {
        let saved: Value = read_json(&args.output.join("report.json"))
            .context("existing output is not this stream's report")?;
        ensure!(
            saved["binding"] == binding,
            "output belongs to another stream"
        );
    } else {
        std::fs::create_dir_all(&args.output)?;
    }
    let output = args.output.canonicalize()?;
    ensure!(
        !output.starts_with("/private/tmp"),
        "experiment output cannot be in /private/tmp"
    );
    let inference = output.join("inference");
    std::fs::create_dir_all(&inference)?;
    // No repository or evaluation files are copied into the memory-agent cwd.
    let mut memory_runner = runner.clone();
    memory_runner.env_clear = true;
    memory_runner.read_only = true;
    if memory_runner.engine == learning_runner::AgentEngine::Codex {
        memory_runner
            .extra_args
            .push("--skip-git-repo-check".into());
    }
    for (key, folder) in [("HOME", "inference-home"), ("TMPDIR", "inference-tmp")] {
        let dir = output.join(folder);
        std::fs::create_dir_all(&dir)?;
        memory_runner
            .environment
            .insert(key.into(), dir.to_string_lossy().into_owned());
    }
    if !memory_runner.environment.contains_key("PATH") {
        memory_runner.environment.insert(
            "PATH".into(),
            std::env::var("PATH").unwrap_or("/usr/bin:/bin".into()),
        );
    }
    write_report(
        &output,
        args,
        &path,
        &state,
        suite.tasks.len(),
        embedding.as_ref(),
        &runner,
    )?;
    if etag.is_none() {
        checkpoint_state(client, db, &path, &mut state, &mut etag).await?;
    }
    while state.steps.len() < suite.tasks.len() {
        ensure!(
            content_bindings(&bound_files)? == artifacts,
            "evaluator or runner changed during rollout"
        );
        let index = state.steps.len();
        let task = &suite.tasks[index];
        if state.pending.is_none() {
            let query_embedding = if args.retrieval == StreamRetrieval::Embedding
                && args.policy != StreamPolicy::None
            {
                Some(embedding.as_ref().unwrap().embed(&task.prompt).await?)
            } else {
                None
            };
            let indices = if args.policy == StreamPolicy::None {
                vec![]
            } else if let Some(q) = &query_embedding {
                let mut scores = state
                    .memories
                    .iter()
                    .enumerate()
                    .map(|(i, m)| {
                        Ok((
                            i,
                            cosine(
                                q,
                                m.embedding
                                    .as_deref()
                                    .context("stored query embedding missing")?,
                            )?,
                        ))
                    })
                    .collect::<Result<Vec<_>>>()?;
                rank(&mut scores, args.top_k)
            } else {
                lexical_rank(&task.prompt, &state.memories, args.top_k)
            };
            let selected: Vec<_> = indices
                .iter()
                .map(|&i| Selected {
                    index: i,
                    id: state.memories[i].id.clone(),
                    reflection: state.memories[i].reflection.clone(),
                })
                .collect();
            let context = if selected.is_empty() {
                String::new()
            } else if args.policy == StreamPolicy::Raw {
                serde_json::to_string(
                    &indices
                        .iter()
                        .map(|&i| &state.memories[i].original)
                        .collect::<Vec<_>>(),
                )?
            } else {
                format!("[RANKED REFLECTIONS]\n{}",serde_json::to_string(&selected.iter().enumerate().map(|(rank,m)|json!({"rank":rank+1,"id":m.id,"reflection":m.reflection})).collect::<Vec<_>>())?)
            };
            state.pending = Some(Pending {
                index,
                selected,
                context,
                context_ref: None,
                query_embedding,
                query_embedding_ref: None,
                decision_started: None,
                inference_started: None,
                trajectory: None,
                trajectory_ref: None,
                success: false,
                calls: vec![],
                revised: vec![],
                fresh: None,
            });
            checkpoint_state(client, db, &path, &mut state, &mut etag).await?;
        }
        let pending = state.pending.as_ref().unwrap();
        ensure!(pending.index == index, "invalid pending task index");
        if pending.trajectory.is_none() {
            // An uncertain task execution must never be silently replayed in a
            // strictly-online rollout. Start a new independent stream to retry.
            ensure!(
                pending.decision_started.is_none(),
                "decision was interrupted; task will not be replayed (start a new stream)"
            );
            let context = PreparedContext {
                snapshot_id: hash(&pending.context),
                content: pending.context.clone(),
            };
            state.pending.as_mut().unwrap().decision_started =
                Some(reservation(index, &controller));
            checkpoint_state(client, db, &path, &mut state, &mut etag).await?;
            let sample = evaluation::evaluate_one(
                task,
                &runner,
                &context,
                EvaluationMode::Current,
                0,
                &output.join(format!("instance-{index:04}")),
            )
            .await?;
            let execution = sample
                .execution
                .as_ref()
                .context("decision execution unavailable")?;
            ensure!(
                execution.complete,
                "decision incomplete; rollout halted without inventing feedback"
            );
            ensure!(
                sample.error.is_none()
                    && sample
                        .checks
                        .iter()
                        .all(|c| !c.timed_out && !c.output_truncated),
                "incomplete evaluator evidence; rollout halted"
            );
            let pending = state.pending.as_mut().unwrap();
            pending.success = sample.success;
            let mut trajectory =
                public_trajectory(&task.prompt, execution, &sample.checks, sample.success);
            super::redaction::redact(&mut trajectory);
            super::redaction::redact_with_secrets(
                &mut trajectory,
                &evaluation::secret_values(&runner),
            );
            pending.trajectory = Some(trajectory);
            pending.calls.push(Call {
                role: "decision".into(),
                output: execution.output.clone(),
                elapsed_ms: execution.elapsed_ms,
                input_tokens: execution.input_tokens,
                output_tokens: execution.output_tokens,
            });
            checkpoint_state(client, db, &path, &mut state, &mut etag).await?;
        }
        if args.policy == StreamPolicy::Reharness {
            while state.pending.as_ref().unwrap().revised.len()
                < state.pending.as_ref().unwrap().selected.len()
            {
                let pending = state.pending.as_ref().unwrap();
                let selection = &pending.selected[pending.revised.len()];
                let prompt = revision_prompt(
                    &state.memories[selection.index],
                    pending.trajectory.as_ref().unwrap(),
                );
                claim_inference(state.pending.as_mut().unwrap(), &controller)?;
                checkpoint_state(client, db, &path, &mut state, &mut etag).await?;
                let call = infer(
                    &memory_runner,
                    &inference,
                    &prompt,
                    "revised_reflection",
                    "revision",
                )
                .await?;
                let pending = state.pending.as_mut().unwrap();
                pending.inference_started = None;
                pending.revised.push(call.output.clone());
                pending.calls.push(call);
                checkpoint_state(client, db, &path, &mut state, &mut etag).await?;
            }
        }
        if matches!(
            args.policy,
            StreamPolicy::Reharness | StreamPolicy::AppendOnly
        ) && state.pending.as_ref().unwrap().fresh.is_none()
        {
            let pending = state.pending.as_ref().unwrap();
            let demonstrations = if args.policy == StreamPolicy::Reharness {
                pending.revised.clone()
            } else {
                pending
                    .selected
                    .iter()
                    .map(|m| m.reflection.clone())
                    .collect()
            };
            let prompt = write_prompt(pending.trajectory.as_ref().unwrap(), &demonstrations);
            claim_inference(state.pending.as_mut().unwrap(), &controller)?;
            checkpoint_state(client, db, &path, &mut state, &mut etag).await?;
            let call = infer(&memory_runner, &inference, &prompt, "reflection", "write").await?;
            let pending = state.pending.as_mut().unwrap();
            pending.inference_started = None;
            pending.fresh = Some(call.output.clone());
            pending.calls.push(call);
            checkpoint_state(client, db, &path, &mut state, &mut etag).await?;
        }
        let pending = state.pending.take().unwrap();
        for (selection, revised) in pending.selected.iter().zip(&pending.revised) {
            state.memories[selection.index].reflection = revised.clone();
        }
        if args.policy != StreamPolicy::None {
            state.memories.push(Memory {
                id: task.id.clone(),
                query: task.prompt.clone(),
                original: pending.trajectory.unwrap(),
                original_ref: pending.trajectory_ref,
                reflection: pending.fresh.unwrap_or_default(),
                embedding: pending.query_embedding,
                embedding_ref: pending.query_embedding_ref,
            });
        }
        let elapsed = |role: &str| {
            pending
                .calls
                .iter()
                .filter(|c| c.role == role)
                .map(|c| c.elapsed_ms)
                .sum()
        };
        state.steps.push(Step {
            task_id: task.id.clone(),
            success: pending.success,
            selected_ids: pending.selected.iter().map(|m| m.id.clone()).collect(),
            supplied_context: pending.context,
            supplied_context_ref: pending.context_ref,
            decision_elapsed_ms: elapsed("decision"),
            revision_elapsed_ms: elapsed("revision"),
            write_elapsed_ms: elapsed("write"),
            model_calls: pending.calls.len(),
            input_tokens: pending.calls.iter().map(|c| c.input_tokens).sum(),
            output_tokens: pending.calls.iter().map(|c| c.output_tokens).sum(),
        });
        checkpoint_state(client, db, &path, &mut state, &mut etag).await?;
        write_report(
            &output,
            args,
            &path,
            &state,
            suite.tasks.len(),
            embedding.as_ref(),
            &runner,
        )?;
    }
    write_report(
        &output,
        args,
        &path,
        &state,
        suite.tasks.len(),
        embedding.as_ref(),
        &runner,
    )
}
#[cfg(test)]
#[path = "stream_tests.rs"]
mod tests;
