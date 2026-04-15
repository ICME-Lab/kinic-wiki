// Where: crates/wiki_cli/src/workflow.rs
// What: CLI-side workflow context builders and validated apply routines for ingest, crystallize, integrate, query, and lint.
// Why: Skill-side LLMs should decide content, while CLI remains the deterministic executor of path policy and write order.
use anyhow::{Result, anyhow};
use chrono::Local;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashSet;
use std::path::Path;
use wiki_types::{
    ListNodesRequest, Node, NodeEntry, NodeEntryKind, NodeKind, RecentNodesRequest,
    SearchNodesRequest, WriteNodeRequest,
};

use crate::client::WikiApi;

const WIKI_PREFIX: &str = "/Wiki";
const RAW_SOURCES_PREFIX: &str = "/Sources/raw";
const SESSION_SOURCES_PREFIX: &str = "/Sources/sessions";
const INDEX_PATH: &str = "/Wiki/index.md";
const LOG_PATH: &str = "/Wiki/log.md";
const CANDIDATE_PAGE_LIMIT: usize = 8;
const RECENT_PAGE_LIMIT: usize = 5;
const SEARCH_PAGE_LIMIT: usize = 5;
const PAGE_CONTENT_CHAR_LIMIT: usize = 2000;
const INDEX_CHAR_LIMIT: usize = 6000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WorkflowLogKind {
    Ingest,
    Crystallize,
    Query,
    Integrate,
    Lint,
}

impl WorkflowLogKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ingest => "ingest",
            Self::Crystallize => "crystallize",
            Self::Query => "query",
            Self::Integrate => "integrate",
            Self::Lint => "lint",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WorkflowTaskKind {
    Ingest,
    Crystallize,
    Integrate,
    Lint,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkflowNodeContext {
    pub path: String,
    pub etag: String,
    pub title: Option<String>,
    pub summary_line: String,
    pub content: Option<String>,
    pub content_truncated: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkflowStructuralStats {
    pub file_count: usize,
    pub has_index: bool,
    pub has_log: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct WorkflowContext {
    pub task: String,
    pub title: Option<String>,
    pub query_text: Option<String>,
    pub source_path: Option<String>,
    pub source_id: Option<String>,
    pub source_etag: Option<String>,
    pub source_content: Option<String>,
    pub source_content_truncated: bool,
    pub index_markdown: Option<String>,
    pub index_etag: Option<String>,
    pub index_truncated: bool,
    pub candidate_paths: Vec<String>,
    pub candidate_pages: Vec<WorkflowNodeContext>,
    pub recent_pages: Vec<WorkflowNodeContext>,
    pub search_pages: Vec<WorkflowNodeContext>,
    pub structural_stats: Option<WorkflowStructuralStats>,
    pub allowed_write_paths: Vec<String>,
    pub response_schema: Value,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkflowRelatedUpdate {
    pub path: String,
    pub markdown: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkflowIngestResult {
    pub source_path: String,
    pub source_id: String,
    pub source_etag: String,
    pub index_etag: Option<String>,
    pub source_summary_markdown: String,
    pub related_updates: Vec<WorkflowRelatedUpdate>,
    pub rationale: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkflowCrystallizeResult {
    pub session_path: String,
    pub session_id: String,
    pub session_etag: String,
    pub index_etag: Option<String>,
    pub durable_updates: Vec<WorkflowRelatedUpdate>,
    pub rationale: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkflowIntegrateResult {
    pub target_paths: Vec<String>,
    pub index_etag: Option<String>,
    pub page_updates: Vec<WorkflowRelatedUpdate>,
    pub rationale: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkflowLintResult {
    pub index_etag: Option<String>,
    pub report_markdown: String,
    pub checked_paths: Vec<String>,
}

pub async fn ingest_source(
    client: &impl WikiApi,
    input_path: &Path,
    remote_path: Option<String>,
    _title: Option<String>,
) -> Result<String> {
    let content = std::fs::read_to_string(input_path)?;
    let path = remote_path.unwrap_or_else(|| default_raw_source_path(input_path));
    upsert_node(client, &path, NodeKind::Source, &content).await?;
    Ok(path)
}

pub async fn ingest_session_source(
    client: &impl WikiApi,
    input_path: &Path,
    remote_path: Option<String>,
    _title: Option<String>,
) -> Result<String> {
    let content = std::fs::read_to_string(input_path)?;
    let path = remote_path.unwrap_or_else(|| default_session_source_path(input_path));
    upsert_node(client, &path, NodeKind::Source, &content).await?;
    Ok(path)
}

pub async fn build_ingest_context(
    client: &impl WikiApi,
    source_ref: &str,
    title_override: Option<String>,
) -> Result<WorkflowContext> {
    let source_path = normalize_raw_source_ref(source_ref);
    validate_raw_source_path(&source_path)?;
    let source = client
        .read_node(&source_path)
        .await?
        .ok_or_else(|| anyhow!("source not found: {source_path}"))?;
    if source.kind != NodeKind::Source {
        return Err(anyhow!("path is not a source node: {source_path}"));
    }
    let source_id = source_id_from_path(&source.path);
    let title = title_override.or_else(|| title_from_content(&source.content));
    Ok(WorkflowContext {
        task: "ingest".to_string(),
        title,
        query_text: None,
        source_path: Some(source.path.clone()),
        source_id: Some(source_id.clone()),
        source_etag: Some(source.etag.clone()),
        source_content: Some(truncate_text(&source.content, PAGE_CONTENT_CHAR_LIMIT).0),
        source_content_truncated: source.content.chars().count() > PAGE_CONTENT_CHAR_LIMIT,
        index_markdown: read_optional_content(client, INDEX_PATH)
            .await?
            .map(|content| truncate_text(&content, INDEX_CHAR_LIMIT).0),
        index_etag: read_optional_etag(client, INDEX_PATH).await?,
        index_truncated: read_optional_content(client, INDEX_PATH)
            .await?
            .map(|content| content.chars().count() > INDEX_CHAR_LIMIT)
            .unwrap_or(false),
        candidate_paths: list_candidate_paths(client).await?,
        candidate_pages: gather_candidate_pages(client, WIKI_PREFIX, CANDIDATE_PAGE_LIMIT).await?,
        recent_pages: gather_recent_pages(client, RECENT_PAGE_LIMIT).await?,
        search_pages: Vec::new(),
        structural_stats: None,
        allowed_write_paths: vec![
            format!("/Wiki/sources/{source_id}.md"),
            "/Wiki/...".to_string(),
        ],
        response_schema: ingest_response_schema(),
    })
}

pub async fn build_crystallize_context(
    client: &impl WikiApi,
    session_ref: &str,
    title_override: Option<String>,
) -> Result<WorkflowContext> {
    let session_path = normalize_session_source_ref(session_ref);
    validate_session_source_path(&session_path)?;
    let session = client
        .read_node(&session_path)
        .await?
        .ok_or_else(|| anyhow!("session not found: {session_path}"))?;
    if session.kind != NodeKind::Source {
        return Err(anyhow!("path is not a session source node: {session_path}"));
    }
    let session_id = source_id_from_path(&session.path);
    let title = title_override.or_else(|| title_from_content(&session.content));
    Ok(WorkflowContext {
        task: "crystallize".to_string(),
        title,
        query_text: None,
        source_path: Some(session.path.clone()),
        source_id: Some(session_id),
        source_etag: Some(session.etag.clone()),
        source_content: Some(truncate_text(&session.content, PAGE_CONTENT_CHAR_LIMIT).0),
        source_content_truncated: session.content.chars().count() > PAGE_CONTENT_CHAR_LIMIT,
        index_markdown: read_optional_content(client, INDEX_PATH)
            .await?
            .map(|content| truncate_text(&content, INDEX_CHAR_LIMIT).0),
        index_etag: read_optional_etag(client, INDEX_PATH).await?,
        index_truncated: read_optional_content(client, INDEX_PATH)
            .await?
            .map(|content| content.chars().count() > INDEX_CHAR_LIMIT)
            .unwrap_or(false),
        candidate_paths: list_candidate_paths(client).await?,
        candidate_pages: Vec::new(),
        recent_pages: gather_recent_pages(client, RECENT_PAGE_LIMIT).await?,
        search_pages: gather_search_pages(client, &session.path, SEARCH_PAGE_LIMIT).await?,
        structural_stats: None,
        allowed_write_paths: vec!["/Wiki/...".to_string()],
        response_schema: crystallize_response_schema(),
    })
}

pub async fn build_query_context(
    client: &impl WikiApi,
    query_text: &str,
    title: Option<String>,
) -> Result<WorkflowContext> {
    Ok(WorkflowContext {
        task: "query".to_string(),
        title,
        query_text: Some(query_text.to_string()),
        source_path: None,
        source_id: None,
        source_etag: None,
        source_content: None,
        source_content_truncated: false,
        index_markdown: read_optional_content(client, INDEX_PATH)
            .await?
            .map(|content| truncate_text(&content, INDEX_CHAR_LIMIT).0),
        index_etag: read_optional_etag(client, INDEX_PATH).await?,
        index_truncated: read_optional_content(client, INDEX_PATH)
            .await?
            .map(|content| content.chars().count() > INDEX_CHAR_LIMIT)
            .unwrap_or(false),
        candidate_paths: list_candidate_paths(client).await?,
        candidate_pages: Vec::new(),
        recent_pages: gather_recent_pages(client, RECENT_PAGE_LIMIT).await?,
        search_pages: gather_search_pages(client, query_text, SEARCH_PAGE_LIMIT).await?,
        structural_stats: None,
        allowed_write_paths: Vec::new(),
        response_schema: Value::Null,
    })
}

pub async fn build_integrate_context(
    client: &impl WikiApi,
    target_paths: &[String],
    title: Option<String>,
    query_text: Option<String>,
) -> Result<WorkflowContext> {
    if target_paths.is_empty() {
        return Err(anyhow!("target_paths must not be empty"));
    }
    for path in target_paths {
        validate_wiki_path(path)?;
    }
    let mut seen = HashSet::new();
    let mut normalized = Vec::new();
    for path in target_paths {
        if seen.insert(path.clone()) {
            normalized.push(path.clone());
        }
    }
    let search_pages = match query_text.as_deref() {
        Some(query) if !query.trim().is_empty() => {
            gather_search_pages(client, query, SEARCH_PAGE_LIMIT).await?
        }
        _ => Vec::new(),
    };
    Ok(WorkflowContext {
        task: "integrate".to_string(),
        title,
        query_text,
        source_path: None,
        source_id: None,
        source_etag: None,
        source_content: None,
        source_content_truncated: false,
        index_markdown: read_optional_content(client, INDEX_PATH)
            .await?
            .map(|content| truncate_text(&content, INDEX_CHAR_LIMIT).0),
        index_etag: read_optional_etag(client, INDEX_PATH).await?,
        index_truncated: read_optional_content(client, INDEX_PATH)
            .await?
            .map(|content| content.chars().count() > INDEX_CHAR_LIMIT)
            .unwrap_or(false),
        candidate_paths: normalized.clone(),
        candidate_pages: gather_target_pages(client, &normalized).await?,
        recent_pages: gather_recent_pages(client, RECENT_PAGE_LIMIT).await?,
        search_pages,
        structural_stats: None,
        allowed_write_paths: normalized,
        response_schema: integrate_response_schema(),
    })
}

pub async fn build_lint_context(client: &impl WikiApi) -> Result<WorkflowContext> {
    let entries = client
        .list_nodes(ListNodesRequest {
            prefix: WIKI_PREFIX.to_string(),
            recursive: true,
        })
        .await?;
    Ok(WorkflowContext {
        task: "lint".to_string(),
        title: Some("wiki lint".to_string()),
        query_text: None,
        source_path: None,
        source_id: None,
        source_etag: None,
        source_content: None,
        source_content_truncated: false,
        index_markdown: read_optional_content(client, INDEX_PATH)
            .await?
            .map(|content| truncate_text(&content, INDEX_CHAR_LIMIT).0),
        index_etag: read_optional_etag(client, INDEX_PATH).await?,
        index_truncated: read_optional_content(client, INDEX_PATH)
            .await?
            .map(|content| content.chars().count() > INDEX_CHAR_LIMIT)
            .unwrap_or(false),
        candidate_paths: entries.iter().map(|entry| entry.path.clone()).collect(),
        candidate_pages: gather_nodes_for_entries(client, &entries, CANDIDATE_PAGE_LIMIT, false)
            .await?,
        recent_pages: gather_recent_pages(client, RECENT_PAGE_LIMIT).await?,
        search_pages: Vec::new(),
        structural_stats: Some(WorkflowStructuralStats {
            file_count: entries
                .iter()
                .filter(|entry| entry.kind == NodeEntryKind::File)
                .count(),
            has_index: entries.iter().any(|entry| entry.path == INDEX_PATH),
            has_log: entries.iter().any(|entry| entry.path == LOG_PATH),
        }),
        allowed_write_paths: vec!["/Wiki/lint/<timestamp>.md".to_string()],
        response_schema: lint_response_schema(),
    })
}

pub async fn apply_workflow_result(
    client: &impl WikiApi,
    task: WorkflowTaskKind,
    input_path: &Path,
) -> Result<Vec<String>> {
    let content = std::fs::read_to_string(input_path)?;
    apply_workflow_result_json(client, task, &content).await
}

pub async fn apply_workflow_result_json(
    client: &impl WikiApi,
    task: WorkflowTaskKind,
    input_json: &str,
) -> Result<Vec<String>> {
    match task {
        WorkflowTaskKind::Ingest => {
            let result: WorkflowIngestResult = serde_json::from_str(input_json)
                .map_err(|error| anyhow!("invalid ingest workflow result: {error}"))?;
            apply_ingest_result(client, &result).await
        }
        WorkflowTaskKind::Crystallize => {
            let result: WorkflowCrystallizeResult = serde_json::from_str(input_json)
                .map_err(|error| anyhow!("invalid crystallize workflow result: {error}"))?;
            apply_crystallize_result(client, &result).await
        }
        WorkflowTaskKind::Integrate => {
            let result: WorkflowIntegrateResult = serde_json::from_str(input_json)
                .map_err(|error| anyhow!("invalid integrate workflow result: {error}"))?;
            apply_integrate_result(client, &result).await
        }
        WorkflowTaskKind::Lint => {
            let result: WorkflowLintResult = serde_json::from_str(input_json)
                .map_err(|error| anyhow!("invalid lint workflow result: {error}"))?;
            apply_lint_result(client, &result).await
        }
    }
}

pub async fn rebuild_index(client: &impl WikiApi) -> Result<()> {
    let entries = client
        .list_nodes(ListNodesRequest {
            prefix: WIKI_PREFIX.to_string(),
            recursive: true,
        })
        .await?;
    let mut sources = Vec::new();
    let mut entities = Vec::new();
    let mut concepts = Vec::new();
    for entry in entries {
        if entry.kind != NodeEntryKind::File || entry.path == INDEX_PATH || entry.path == LOG_PATH {
            continue;
        }
        let node = match client.read_node(&entry.path).await? {
            Some(node) => node,
            None => continue,
        };
        let rendered = render_index_item(&node);
        if entry.path.starts_with("/Wiki/sources/") {
            sources.push(rendered);
        } else if entry.path.starts_with("/Wiki/entities/") {
            entities.push(rendered);
        } else if entry.path.starts_with("/Wiki/concepts/") {
            concepts.push(rendered);
        }
    }
    let body = render_index(&sources, &entities, &concepts);
    upsert_node(client, INDEX_PATH, NodeKind::File, &body).await
}

pub async fn append_log(
    client: &impl WikiApi,
    kind: WorkflowLogKind,
    title: &str,
    target_paths: &[String],
    updated_paths: &[String],
    failure: Option<String>,
) -> Result<()> {
    let existing = client.read_node(LOG_PATH).await?;
    let mut content = existing
        .map(|node| node.content)
        .unwrap_or_else(|| "# Log\n".to_string());
    if !content.ends_with('\n') {
        content.push('\n');
    }
    let stamp = Local::now().format("%Y-%m-%d %H:%M").to_string();
    content.push_str(&format!("## [{stamp}] {} | {title}\n", kind.as_str()));
    if !target_paths.is_empty() {
        content.push_str(&format!("target_paths: {}\n", target_paths.join(", ")));
    }
    if !updated_paths.is_empty() {
        content.push_str(&format!("updated_paths: {}\n", updated_paths.join(", ")));
    }
    if let Some(reason) = failure {
        content.push_str(&format!("failure: {reason}\n"));
    }
    content.push('\n');
    upsert_node(client, LOG_PATH, NodeKind::File, &content).await
}

async fn apply_ingest_result(
    client: &impl WikiApi,
    result: &WorkflowIngestResult,
) -> Result<Vec<String>> {
    validate_ingest_result(result)?;
    let source_context = source_context_for_path(client, &result.source_path).await?;
    validate_index_etag(client, result.index_etag.as_deref()).await?;
    if result.source_id != source_context.source_id {
        return Err(anyhow!(
            "source_id mismatch for ingest apply: expected {}, got {}",
            source_context.source_id,
            result.source_id
        ));
    }
    if result.source_etag != source_context.source_etag {
        return Err(anyhow!(
            "source_etag mismatch for ingest apply: expected {}, got {}",
            source_context.source_etag,
            result.source_etag
        ));
    }
    let summary_path = format!("/Wiki/sources/{}.md", source_context.source_id);
    let mut updated_paths = Vec::with_capacity(result.related_updates.len() + 2);
    upsert_node(
        client,
        &summary_path,
        NodeKind::File,
        result.source_summary_markdown.trim(),
    )
    .await?;
    updated_paths.push(summary_path.clone());
    for update in &result.related_updates {
        upsert_node(client, &update.path, NodeKind::File, update.markdown.trim()).await?;
        updated_paths.push(update.path.clone());
    }
    rebuild_index(client).await?;
    updated_paths.push(INDEX_PATH.to_string());
    append_log(
        client,
        WorkflowLogKind::Ingest,
        &source_context.title,
        &[source_context.source_path],
        &updated_paths,
        None,
    )
    .await?;
    Ok(updated_paths)
}

async fn apply_crystallize_result(
    client: &impl WikiApi,
    result: &WorkflowCrystallizeResult,
) -> Result<Vec<String>> {
    validate_crystallize_result(result)?;
    let session_context = session_context_for_path(client, &result.session_path).await?;
    validate_index_etag(client, result.index_etag.as_deref()).await?;
    if result.session_id != session_context.source_id {
        return Err(anyhow!(
            "session_id mismatch for crystallize apply: expected {}, got {}",
            session_context.source_id,
            result.session_id
        ));
    }
    if result.session_etag != session_context.source_etag {
        return Err(anyhow!(
            "session_etag mismatch for crystallize apply: expected {}, got {}",
            session_context.source_etag,
            result.session_etag
        ));
    }
    let mut updated_paths = Vec::with_capacity(result.durable_updates.len() + 2);
    for update in &result.durable_updates {
        upsert_node(client, &update.path, NodeKind::File, update.markdown.trim()).await?;
        updated_paths.push(update.path.clone());
    }
    rebuild_index(client).await?;
    updated_paths.push(INDEX_PATH.to_string());
    append_log(
        client,
        WorkflowLogKind::Crystallize,
        &session_context.title,
        &[session_context.source_path],
        &updated_paths,
        None,
    )
    .await?;
    Ok(updated_paths)
}

async fn apply_integrate_result(
    client: &impl WikiApi,
    result: &WorkflowIntegrateResult,
) -> Result<Vec<String>> {
    validate_integrate_result(result)?;
    validate_index_etag(client, result.index_etag.as_deref()).await?;
    let mut updated_paths = Vec::with_capacity(result.page_updates.len() + 2);
    for update in &result.page_updates {
        upsert_node(client, &update.path, NodeKind::File, update.markdown.trim()).await?;
        updated_paths.push(update.path.clone());
    }
    rebuild_index(client).await?;
    updated_paths.push(INDEX_PATH.to_string());
    append_log(
        client,
        WorkflowLogKind::Integrate,
        "wiki integrate",
        &result.target_paths,
        &updated_paths,
        None,
    )
    .await?;
    Ok(updated_paths)
}

async fn apply_lint_result(
    client: &impl WikiApi,
    result: &WorkflowLintResult,
) -> Result<Vec<String>> {
    validate_lint_result(result)?;
    validate_index_etag(client, result.index_etag.as_deref()).await?;
    let path = format!("/Wiki/lint/{}.md", timestamp_token());
    upsert_node(client, &path, NodeKind::File, result.report_markdown.trim()).await?;
    rebuild_index(client).await?;
    let updated_paths = vec![path.clone(), INDEX_PATH.to_string()];
    append_log(
        client,
        WorkflowLogKind::Lint,
        "wiki lint",
        &result.checked_paths,
        &updated_paths,
        None,
    )
    .await?;
    Ok(updated_paths)
}

async fn source_context_for_path(
    client: &impl WikiApi,
    source_path: &str,
) -> Result<LatestSourceContext> {
    validate_raw_source_path(source_path)?;
    let node = client
        .read_node(source_path)
        .await?
        .ok_or_else(|| anyhow!("source not found for ingest apply: {source_path}"))?;
    if node.kind != NodeKind::Source {
        return Err(anyhow!(
            "path is not a source node for ingest apply: {source_path}"
        ));
    }
    Ok(LatestSourceContext {
        source_id: source_id_from_path(&node.path),
        source_etag: node.etag.clone(),
        source_path: node.path,
        title: title_from_content(&node.content).unwrap_or_else(|| "source".to_string()),
    })
}

async fn session_context_for_path(
    client: &impl WikiApi,
    session_path: &str,
) -> Result<LatestSourceContext> {
    validate_session_source_path(session_path)?;
    let node = client
        .read_node(session_path)
        .await?
        .ok_or_else(|| anyhow!("session not found for crystallize apply: {session_path}"))?;
    if node.kind != NodeKind::Source {
        return Err(anyhow!(
            "path is not a session source node for crystallize apply: {session_path}"
        ));
    }
    Ok(LatestSourceContext {
        source_id: source_id_from_path(&node.path),
        source_etag: node.etag.clone(),
        source_path: node.path,
        title: title_from_content(&node.content).unwrap_or_else(|| "session".to_string()),
    })
}

struct LatestSourceContext {
    source_id: String,
    source_etag: String,
    source_path: String,
    title: String,
}

async fn upsert_node(
    client: &impl WikiApi,
    path: &str,
    kind: NodeKind,
    content: &str,
) -> Result<()> {
    let current = client.read_node(path).await?;
    client
        .write_node(WriteNodeRequest {
            path: path.to_string(),
            kind,
            content: content.to_string(),
            metadata_json: "{}".to_string(),
            expected_etag: current.map(|node| node.etag),
        })
        .await?;
    Ok(())
}

async fn read_optional_content(client: &impl WikiApi, path: &str) -> Result<Option<String>> {
    Ok(client.read_node(path).await?.map(|node| node.content))
}

async fn read_optional_etag(client: &impl WikiApi, path: &str) -> Result<Option<String>> {
    Ok(client.read_node(path).await?.map(|node| node.etag))
}

async fn list_candidate_paths(client: &impl WikiApi) -> Result<Vec<String>> {
    let entries = client
        .list_nodes(ListNodesRequest {
            prefix: WIKI_PREFIX.to_string(),
            recursive: true,
        })
        .await?;
    Ok(entries.into_iter().map(|entry| entry.path).collect())
}

async fn gather_candidate_pages(
    client: &impl WikiApi,
    prefix: &str,
    limit: usize,
) -> Result<Vec<WorkflowNodeContext>> {
    let entries = client
        .list_nodes(ListNodesRequest {
            prefix: prefix.to_string(),
            recursive: true,
        })
        .await?;
    gather_nodes_for_entries(client, &entries, limit, false).await
}

async fn gather_target_pages(
    client: &impl WikiApi,
    target_paths: &[String],
) -> Result<Vec<WorkflowNodeContext>> {
    let mut pages = Vec::new();
    for path in target_paths {
        if let Some(node) = client.read_node(path).await? {
            let (content, content_truncated) =
                truncate_text(&node.content, PAGE_CONTENT_CHAR_LIMIT);
            pages.push(WorkflowNodeContext {
                path: node.path,
                etag: node.etag,
                title: title_from_content(&node.content),
                summary_line: first_summary_line(&node.content),
                content: Some(content),
                content_truncated,
            });
        }
    }
    Ok(pages)
}

async fn gather_search_pages(
    client: &impl WikiApi,
    query_text: &str,
    limit: usize,
) -> Result<Vec<WorkflowNodeContext>> {
    let hits = client
        .search_nodes(SearchNodesRequest {
            query_text: query_text.to_string(),
            prefix: Some(WIKI_PREFIX.to_string()),
            top_k: limit as u32,
        })
        .await?;
    let mut pages = Vec::new();
    for hit in hits.into_iter().take(limit) {
        if let Some(node) = client.read_node(&hit.path).await? {
            pages.push(WorkflowNodeContext {
                path: node.path,
                etag: node.etag,
                title: title_from_content(&node.content),
                summary_line: first_summary_line(&node.content),
                content: Some(truncate_text(&node.content, PAGE_CONTENT_CHAR_LIMIT).0),
                content_truncated: node.content.chars().count() > PAGE_CONTENT_CHAR_LIMIT,
            });
        }
    }
    Ok(pages)
}

async fn gather_recent_pages(
    client: &impl WikiApi,
    limit: usize,
) -> Result<Vec<WorkflowNodeContext>> {
    let hits = client
        .recent_nodes(RecentNodesRequest {
            limit: limit as u32,
            path: Some(WIKI_PREFIX.to_string()),
        })
        .await?;
    let mut pages = Vec::new();
    for hit in hits {
        if let Some(node) = client.read_node(&hit.path).await? {
            pages.push(WorkflowNodeContext {
                path: node.path,
                etag: node.etag,
                title: title_from_content(&node.content),
                summary_line: first_summary_line(&node.content),
                content: Some(truncate_text(&node.content, PAGE_CONTENT_CHAR_LIMIT).0),
                content_truncated: node.content.chars().count() > PAGE_CONTENT_CHAR_LIMIT,
            });
        }
    }
    Ok(pages)
}

async fn gather_nodes_for_entries(
    client: &impl WikiApi,
    entries: &[NodeEntry],
    limit: usize,
    include_content: bool,
) -> Result<Vec<WorkflowNodeContext>> {
    let mut pages = Vec::new();
    for entry in entries {
        if pages.len() >= limit || entry.kind != NodeEntryKind::File {
            continue;
        }
        if entry.path == INDEX_PATH || entry.path == LOG_PATH {
            continue;
        }
        if let Some(node) = client.read_node(&entry.path).await? {
            let (content, content_truncated) = if include_content {
                let (truncated, changed) = truncate_text(&node.content, PAGE_CONTENT_CHAR_LIMIT);
                (Some(truncated), changed)
            } else {
                (None, false)
            };
            pages.push(WorkflowNodeContext {
                path: node.path,
                etag: node.etag,
                title: title_from_content(&node.content),
                summary_line: first_summary_line(&node.content),
                content,
                content_truncated,
            });
        }
    }
    Ok(pages)
}

fn validate_ingest_result(result: &WorkflowIngestResult) -> Result<()> {
    validate_raw_source_path(&result.source_path)?;
    if result.source_id != source_id_from_path(&result.source_path) {
        return Err(anyhow!(
            "source_id does not match source_path: {} vs {}",
            result.source_id,
            result.source_path
        ));
    }
    if result.source_etag.trim().is_empty() {
        return Err(anyhow!("source_etag must not be empty"));
    }
    if result.source_summary_markdown.trim().is_empty() {
        return Err(anyhow!("source_summary_markdown must not be empty"));
    }
    validate_related_updates(&result.related_updates, "related_updates")
}

fn validate_crystallize_result(result: &WorkflowCrystallizeResult) -> Result<()> {
    validate_session_source_path(&result.session_path)?;
    if result.session_id != source_id_from_path(&result.session_path) {
        return Err(anyhow!(
            "session_id does not match session_path: {} vs {}",
            result.session_id,
            result.session_path
        ));
    }
    if result.session_etag.trim().is_empty() {
        return Err(anyhow!("session_etag must not be empty"));
    }
    validate_related_updates(&result.durable_updates, "durable_updates")
}

fn validate_integrate_result(result: &WorkflowIntegrateResult) -> Result<()> {
    if result.target_paths.is_empty() {
        return Err(anyhow!("target_paths must not be empty"));
    }
    for path in &result.target_paths {
        validate_wiki_path(path)?;
    }
    validate_related_updates(&result.page_updates, "page_updates")
}

fn validate_lint_result(result: &WorkflowLintResult) -> Result<()> {
    if result.report_markdown.trim().is_empty() {
        return Err(anyhow!("report_markdown must not be empty"));
    }
    for path in &result.checked_paths {
        validate_wiki_path(path)?;
    }
    Ok(())
}

async fn validate_index_etag(client: &impl WikiApi, expected: Option<&str>) -> Result<()> {
    let current = client.read_node(INDEX_PATH).await?;
    let current_etag = current.as_ref().map(|node| node.etag.as_str());
    if current_etag != expected {
        return Err(anyhow!(
            "index_etag is stale: expected {:?}, current {:?}",
            expected,
            current_etag
        ));
    }
    Ok(())
}

fn validate_wiki_path(path: &str) -> Result<()> {
    if !path.starts_with(WIKI_PREFIX) {
        return Err(anyhow!("path must stay under /Wiki: {path}"));
    }
    Ok(())
}

fn validate_raw_source_path(path: &str) -> Result<()> {
    validate_canonical_source_path(path, RAW_SOURCES_PREFIX, "source_path")
}

fn validate_session_source_path(path: &str) -> Result<()> {
    validate_canonical_source_path(path, SESSION_SOURCES_PREFIX, "session_path")
}

fn validate_canonical_source_path(path: &str, prefix: &str, label: &str) -> Result<()> {
    if !path.starts_with(prefix) {
        return Err(anyhow!("{label} must stay under {prefix}: {path}"));
    }
    let normalized = path.trim_end_matches('/');
    let mut segments = normalized.rsplit('/');
    let file_name = segments.next().unwrap_or_default();
    let directory_name = segments.next().unwrap_or_default();
    if directory_name.is_empty() || file_name != format!("{directory_name}.md") {
        return Err(anyhow!(
            "{label} must use canonical form {prefix}/<id>/<id>.md: {path}"
        ));
    }
    Ok(())
}

fn validate_related_updates(updates: &[WorkflowRelatedUpdate], field_name: &str) -> Result<()> {
    let mut seen = HashSet::new();
    for update in updates {
        validate_wiki_path(&update.path)?;
        if update.path == INDEX_PATH || update.path == LOG_PATH {
            return Err(anyhow!(
                "system file update is not allowed: {}",
                update.path
            ));
        }
        if update.markdown.trim().is_empty() {
            return Err(anyhow!(
                "{field_name} markdown must not be empty: {}",
                update.path
            ));
        }
        if !seen.insert(update.path.clone()) {
            return Err(anyhow!(
                "duplicate update path in {field_name}: {}",
                update.path
            ));
        }
    }
    Ok(())
}

fn ingest_response_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "source_path": { "type": "string" },
            "source_id": { "type": "string" },
            "source_etag": { "type": "string" },
            "index_etag": { "type": ["string", "null"] },
            "source_summary_markdown": { "type": "string" },
            "related_updates": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string" },
                        "markdown": { "type": "string" }
                    },
                    "required": ["path", "markdown"],
                    "additionalProperties": false
                }
            },
            "rationale": { "type": "string" }
        },
        "required": ["source_path", "source_id", "source_etag", "index_etag", "source_summary_markdown", "related_updates", "rationale"],
        "additionalProperties": false
    })
}

fn crystallize_response_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "session_path": { "type": "string" },
            "session_id": { "type": "string" },
            "session_etag": { "type": "string" },
            "index_etag": { "type": ["string", "null"] },
            "durable_updates": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string" },
                        "markdown": { "type": "string" }
                    },
                    "required": ["path", "markdown"],
                    "additionalProperties": false
                }
            },
            "rationale": { "type": "string" }
        },
        "required": ["session_path", "session_id", "session_etag", "index_etag", "durable_updates", "rationale"],
        "additionalProperties": false
    })
}

fn integrate_response_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "target_paths": {
                "type": "array",
                "items": { "type": "string" }
            },
            "index_etag": { "type": ["string", "null"] },
            "page_updates": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string" },
                        "markdown": { "type": "string" }
                    },
                    "required": ["path", "markdown"],
                    "additionalProperties": false
                }
            },
            "rationale": { "type": "string" }
        },
        "required": ["target_paths", "index_etag", "page_updates", "rationale"],
        "additionalProperties": false
    })
}

fn lint_response_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "index_etag": { "type": ["string", "null"] },
            "report_markdown": { "type": "string" },
            "checked_paths": {
                "type": "array",
                "items": { "type": "string" }
            }
        },
        "required": ["index_etag", "report_markdown", "checked_paths"],
        "additionalProperties": false
    })
}

fn truncate_text(content: &str, max_chars: usize) -> (String, bool) {
    if content.chars().count() <= max_chars {
        return (content.to_string(), false);
    }
    (content.chars().take(max_chars).collect(), true)
}

fn render_index(sources: &[String], entities: &[String], concepts: &[String]) -> String {
    let mut out = String::from("# Index\n\n");
    push_index_section(&mut out, "Sources", sources);
    push_index_section(&mut out, "Entities", entities);
    push_index_section(&mut out, "Concepts", concepts);
    out
}

fn push_index_section(out: &mut String, title: &str, items: &[String]) {
    out.push_str(&format!("## {title}\n\n"));
    if items.is_empty() {
        out.push_str("- none\n\n");
        return;
    }
    for item in items {
        out.push_str(item);
        out.push('\n');
    }
    out.push('\n');
}

fn render_index_item(node: &Node) -> String {
    let label =
        title_from_content(&node.content).unwrap_or_else(|| source_id_from_path(&node.path));
    format!(
        "- [{}]({}) — {}",
        label,
        node.path,
        first_summary_line(&node.content)
    )
}

fn default_raw_source_path(input_path: &Path) -> String {
    let name = input_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("source.md");
    let source_id = source_id_from_name(name);
    format!("{RAW_SOURCES_PREFIX}/{source_id}/{source_id}.md")
}

fn default_session_source_path(input_path: &Path) -> String {
    let name = input_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("session.md");
    let session_id = source_id_from_name(name);
    format!("{SESSION_SOURCES_PREFIX}/{session_id}/{session_id}.md")
}

fn normalize_raw_source_ref(source_ref: &str) -> String {
    if source_ref.starts_with("/Sources/") {
        source_ref.to_string()
    } else {
        format!("{RAW_SOURCES_PREFIX}/{source_ref}/{source_ref}.md")
    }
}

fn normalize_session_source_ref(session_ref: &str) -> String {
    if session_ref.starts_with("/Sources/") {
        session_ref.to_string()
    } else {
        format!("{SESSION_SOURCES_PREFIX}/{session_ref}/{session_ref}.md")
    }
}

fn source_id_from_path(path: &str) -> String {
    let normalized = path.trim_end_matches('/');
    let mut segments = normalized.rsplit('/');
    let file_name = segments.next().unwrap_or(normalized);
    let directory_name = segments.next().unwrap_or_default();
    let expected_file_name = format!("{directory_name}.md");
    if !directory_name.is_empty() && file_name == expected_file_name {
        directory_name.to_string()
    } else {
        source_id_from_name(file_name)
    }
}

fn source_id_from_name(name: &str) -> String {
    match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() && !ext.is_empty() => stem.to_string(),
        _ => name.to_string(),
    }
}

fn title_from_content(content: &str) -> Option<String> {
    content
        .lines()
        .find_map(|line| line.strip_prefix("# ").map(str::to_string))
}

fn first_summary_line(content: &str) -> String {
    content
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && !line.starts_with('#') && *line != "---")
        .unwrap_or("No summary available.")
        .to_string()
}

fn timestamp_token() -> String {
    Local::now().format("%Y%m%d%H%M%S").to_string()
}
