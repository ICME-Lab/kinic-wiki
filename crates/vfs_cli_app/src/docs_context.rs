// Where: crates/vfs_cli_app/src/docs_context.rs
// What: Read-only docs-source context adapter for /Wiki/sources chunks.
// Why: LLM docs packs need citation metadata, not raw VFS node paths.
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;

use anyhow::{Result, anyhow};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use vfs_client::VfsApi;
use vfs_types::{
    ListNodesRequest, Node, NodeEntryKind, SearchNodeHit, SearchNodesRequest, SearchPreviewMode,
};
use wiki_domain::WIKI_SOURCES_PREFIX;

use crate::cli::{DocsCommand, DocsContextCommand, DocsSourceCommand};

const TOKEN_CHAR_APPROX: usize = 4;

pub async fn run_docs_command(
    client: &impl VfsApi,
    database_id: &str,
    command: DocsCommand,
) -> Result<()> {
    match command {
        DocsCommand::Source { command } => match command {
            DocsSourceCommand::List { json } => {
                let result = list_sources(client, database_id).await?;
                print_source_list(&result, json)?;
            }
            DocsSourceCommand::Resolve { query, top_k, json } => {
                let result = resolve_sources(client, database_id, &query, top_k).await?;
                print_source_resolve(&result, json)?;
            }
            DocsSourceCommand::Query {
                query,
                source_id,
                version,
                top_k,
                max_tokens,
                json,
            } => {
                let result = query_source(
                    client,
                    database_id,
                    &source_id,
                    version.as_deref(),
                    &query,
                    top_k,
                    max_tokens,
                )
                .await?;
                print_source_query(&result, json)?;
            }
        },
        DocsCommand::Context { command } => match command {
            DocsContextCommand::Pack {
                query,
                top_sources,
                top_k_per_source,
                max_tokens,
                json,
            } => {
                let result = pack_context(
                    client,
                    database_id,
                    &query,
                    top_sources,
                    top_k_per_source,
                    max_tokens,
                )
                .await?;
                print_pack(&result, json)?;
            }
        },
        DocsCommand::Cite { input, json } => run_docs_cite(&input, json)?,
    }
    Ok(())
}

pub fn run_docs_cite(input: &Path, json: bool) -> Result<()> {
    let content = fs::read_to_string(input)
        .map_err(|error| anyhow!("failed to read {}: {error}", input.display()))?;
    let pack: DocsEvidencePack = serde_json::from_str(&content)
        .map_err(|error| anyhow!("invalid evidence pack JSON: {error}"))?;
    let result = citations_from_pack(&pack);
    print_citations(&result, json)
}

async fn list_sources(client: &impl VfsApi, database_id: &str) -> Result<DocsSourceList> {
    let entries = client
        .list_nodes(ListNodesRequest {
            database_id: database_id.to_string(),
            prefix: WIKI_SOURCES_PREFIX.to_string(),
            recursive: true,
        })
        .await?;
    let mut sources = Vec::new();
    let mut warnings = Vec::new();
    for entry in entries {
        if entry.kind != NodeEntryKind::File || !is_top_level_source_index_path(&entry.path) {
            continue;
        }
        let Some(node) = client.read_node(database_id, &entry.path).await? else {
            warnings.push(format!(
                "source index disappeared before read: {}",
                entry.path
            ));
            continue;
        };
        match source_from_index_node(&node) {
            Ok(source) => sources.push(source),
            Err(error) => warnings.push(format!("{}: {error}", node.path)),
        }
    }
    sources.sort_by(|left, right| left.source_id.cmp(&right.source_id));
    Ok(DocsSourceList { sources, warnings })
}

async fn resolve_sources(
    client: &impl VfsApi,
    database_id: &str,
    query: &str,
    top_k: u32,
) -> Result<DocsSourceResolve> {
    let hits = search_docs(client, database_id, query, WIKI_SOURCES_PREFIX, top_k).await?;
    let mut grouped: BTreeMap<String, SourceResolveCandidate> = BTreeMap::new();
    let mut warnings = Vec::new();
    for hit in hits {
        let Some(node) = client.read_node(database_id, &hit.path).await? else {
            warnings.push(format!("search hit disappeared before read: {}", hit.path));
            continue;
        };
        let metadata = match parse_metadata(&node.metadata_json) {
            Ok(metadata) => metadata,
            Err(error) => {
                warnings.push(format!("{}: invalid metadata_json: {error}", node.path));
                continue;
            }
        };
        let Some(source_id) = metadata
            .source_id
            .clone()
            .filter(|value| !value.trim().is_empty())
        else {
            warnings.push(format!("{}: missing source_id", node.path));
            continue;
        };
        if !grouped.contains_key(&source_id) {
            let source = match source_from_metadata(source_id.clone(), None, None, None, None) {
                Ok(source) => source,
                Err(error) => {
                    warnings.push(format!("{}: {error}", node.path));
                    continue;
                }
            };
            grouped.insert(
                source_id.clone(),
                SourceResolveCandidate {
                    source,
                    score: hit.score,
                },
            );
        }
        let candidate = grouped
            .get_mut(&source_id)
            .ok_or_else(|| anyhow!("failed to group source_id: {source_id}"))?;
        if compare_search_score(hit.score, candidate.score).is_lt() {
            candidate.score = hit.score;
        }
    }

    let mut candidates = grouped.into_values().collect::<Vec<_>>();
    for candidate in &mut candidates {
        load_source_index_metadata(client, database_id, candidate, &mut warnings).await?;
    }
    candidates.sort_by(|left, right| {
        compare_search_score(left.score, right.score)
            .then_with(|| left.source.source_id.cmp(&right.source.source_id))
    });
    let limit = usize::try_from(top_k).unwrap_or(usize::MAX);
    let sources = candidates
        .into_iter()
        .take(limit)
        .map(|candidate| candidate.source)
        .collect();
    Ok(DocsSourceResolve {
        query: query.to_string(),
        sources,
        warnings,
    })
}

async fn query_source(
    client: &impl VfsApi,
    database_id: &str,
    source_id: &str,
    version: Option<&str>,
    query: &str,
    top_k: u32,
    max_tokens: u32,
) -> Result<DocsSourceQuery> {
    let source_prefix = source_prefix_for(source_id, version)?;
    let hits = search_docs(client, database_id, query, &source_prefix, top_k).await?;
    let mut warnings = Vec::new();
    let mut evidence = Vec::new();
    let mut used_chars = 0usize;
    let budget_chars = token_budget_chars(max_tokens);
    let mut truncated = false;
    let mut source = source_from_metadata(
        source_id.to_string(),
        None,
        None,
        version.map(str::to_string),
        None,
    )?;
    enrich_source_from_index(client, database_id, &mut source, &mut warnings).await?;

    for hit in hits {
        if hit.path.ends_with("/index.md") {
            warnings.push(format!(
                "{}: index node excluded from docs evidence",
                hit.path
            ));
            continue;
        }
        let Some(node) = client.read_node(database_id, &hit.path).await? else {
            warnings.push(format!("search hit disappeared before read: {}", hit.path));
            continue;
        };
        let next = match evidence_from_hit(&hit, &node, &source) {
            Ok(item) => item,
            Err(error) => {
                warnings.push(format!("{}: {error}", node.path));
                continue;
            }
        };
        let next_chars = evidence_chars(&next);
        if used_chars.saturating_add(next_chars) > budget_chars {
            truncated = true;
            break;
        }
        used_chars = used_chars.saturating_add(next_chars);
        evidence.push(next);
    }

    Ok(DocsSourceQuery {
        query: query.to_string(),
        source,
        max_tokens,
        estimated_tokens: estimate_tokens_from_chars(used_chars),
        evidence,
        warnings,
        truncated,
    })
}

async fn pack_context(
    client: &impl VfsApi,
    database_id: &str,
    query: &str,
    top_sources: u32,
    top_k_per_source: u32,
    max_tokens: u32,
) -> Result<DocsEvidencePack> {
    let resolved = resolve_sources(client, database_id, query, top_sources).await?;
    let mut warnings = resolved.warnings;
    let mut sources = Vec::new();
    let mut evidence = Vec::new();
    let mut seen = BTreeSet::new();
    let mut truncated = false;
    for source in &resolved.sources {
        sources.push(source.clone());
        let result = query_source(
            client,
            database_id,
            &source.source_id,
            source.version.as_deref(),
            query,
            top_k_per_source,
            u32::MAX,
        )
        .await?;
        if result.truncated {
            truncated = true;
        }
        warnings.extend(result.warnings);
        for item in result.evidence {
            let key = (
                item.source_id.clone(),
                item.title.clone(),
                item.citation.clone(),
                item.version.clone(),
                item.chunk_id.clone(),
            );
            if seen.insert(key) {
                evidence.push(item);
            }
        }
    }
    evidence.sort_by(|left, right| {
        compare_search_score(left.score, right.score).then_with(|| left.path.cmp(&right.path))
    });

    let budget_chars = token_budget_chars(max_tokens);
    let mut used_chars = 0usize;
    let mut packed = Vec::new();
    for item in evidence {
        let next_chars = evidence_chars(&item);
        if used_chars.saturating_add(next_chars) > budget_chars {
            truncated = true;
            break;
        }
        used_chars = used_chars.saturating_add(next_chars);
        packed.push(item);
    }
    let citations = citations_from_evidence(&packed);
    Ok(DocsEvidencePack {
        query: query.to_string(),
        max_tokens,
        estimated_tokens: estimate_tokens_from_chars(used_chars),
        sources,
        evidence: packed,
        citations,
        warnings,
        truncated,
    })
}

async fn search_docs(
    client: &impl VfsApi,
    database_id: &str,
    query: &str,
    prefix: &str,
    top_k: u32,
) -> Result<Vec<SearchNodeHit>> {
    client
        .search_nodes(SearchNodesRequest {
            database_id: database_id.to_string(),
            query_text: query.to_string(),
            prefix: Some(prefix.to_string()),
            top_k,
            preview_mode: Some(SearchPreviewMode::ContentStart),
        })
        .await
}

async fn enrich_source_from_index(
    client: &impl VfsApi,
    database_id: &str,
    source: &mut DocsSource,
    warnings: &mut Vec<String>,
) -> Result<()> {
    let Some(index) = client.read_node(database_id, &source.index_path).await? else {
        return Ok(());
    };
    match parse_metadata(&index.metadata_json) {
        Ok(metadata) => merge_source_metadata(source, &metadata),
        Err(error) => warnings.push(format!("{}: invalid metadata_json: {error}", index.path)),
    }
    Ok(())
}

async fn load_source_index_metadata(
    client: &impl VfsApi,
    database_id: &str,
    candidate: &mut SourceResolveCandidate,
    warnings: &mut Vec<String>,
) -> Result<()> {
    let Some(index) = client
        .read_node(database_id, &candidate.source.index_path)
        .await?
    else {
        warnings.push(format!(
            "{}: source index missing",
            candidate.source.index_path
        ));
        return Ok(());
    };
    match source_from_index_node(&index) {
        Ok(source) => {
            candidate.source = source;
        }
        Err(error) => warnings.push(format!("{}: {error}", index.path)),
    }
    Ok(())
}

fn source_from_index_node(node: &Node) -> Result<DocsSource> {
    let metadata = parse_metadata(&node.metadata_json)?;
    let Some(source_id) = metadata
        .source_id
        .clone()
        .filter(|value| !value.trim().is_empty())
    else {
        return Err(anyhow!("missing source_id"));
    };
    let mut source = source_from_metadata(
        source_id,
        metadata.title.clone(),
        metadata.citation.clone(),
        metadata.version.clone(),
        metadata.trust.clone(),
    )?;
    source.index_path = node.path.clone();
    Ok(source)
}

fn evidence_from_hit(
    hit: &SearchNodeHit,
    node: &Node,
    source: &DocsSource,
) -> Result<DocsEvidence> {
    let metadata = parse_metadata(&node.metadata_json)?;
    let source_id = metadata
        .source_id
        .clone()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| anyhow!("missing source_id"))?;
    if source_id != source.source_id {
        return Err(anyhow!(
            "source_id mismatch: expected {}, got {}",
            source.source_id,
            source_id
        ));
    }
    let citation = metadata
        .citation
        .clone()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| anyhow!("missing citation"))?;
    let chunk_id = metadata
        .chunk_id
        .clone()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| anyhow!("missing chunk_id"))?;
    Ok(DocsEvidence {
        path: node.path.clone(),
        score: hit.score,
        snippet: hit_snippet(hit),
        content: node.content.clone(),
        source_id,
        title: metadata
            .title
            .clone()
            .or_else(|| (!source.title.is_empty()).then_some(source.title.clone()))
            .unwrap_or_else(|| node.path.clone()),
        citation,
        version: metadata.version.clone().or_else(|| source.version.clone()),
        chunk_id,
        trust: metadata.trust.clone().or_else(|| source.trust.clone()),
    })
}

fn source_from_metadata(
    source_id: String,
    title: Option<String>,
    citation: Option<String>,
    version: Option<String>,
    trust: Option<String>,
) -> Result<DocsSource> {
    let index_path = format!("{}/index.md", docs_source_prefix(&source_id)?);
    Ok(DocsSource {
        source_id: source_id.clone(),
        title: title.unwrap_or_else(|| source_id.clone()),
        citation,
        version,
        trust,
        index_path,
    })
}

fn merge_source_metadata(source: &mut DocsSource, metadata: &DocsMetadata) {
    if source.title == source.source_id {
        if let Some(title) = metadata
            .title
            .clone()
            .filter(|value| !value.trim().is_empty())
        {
            source.title = title;
        }
    }
    if source.citation.is_none() {
        source.citation = metadata.citation.clone();
    }
    if source.version.is_none() {
        source.version = metadata.version.clone();
    }
    if source.trust.is_none() {
        source.trust = metadata.trust.clone();
    }
}

fn source_prefix_for(source_id: &str, version: Option<&str>) -> Result<String> {
    let mut prefix = docs_source_prefix(source_id)?;
    if let Some(value) = version {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            validate_safe_path_segment(trimmed)?;
            prefix.push('/');
            prefix.push_str(trimmed);
        }
    }
    Ok(prefix)
}

fn docs_source_prefix(source_id: &str) -> Result<String> {
    let trimmed = source_id.trim();
    if !trimmed.starts_with('/') {
        return Err(anyhow!("source_id must start with /: {source_id}"));
    }
    let segments = trimmed
        .split('/')
        .filter(|segment| !segment.is_empty())
        .map(encode_source_id_segment)
        .collect::<Result<Vec<_>>>()?;
    if segments.is_empty() {
        return Err(anyhow!("source_id must include at least one segment"));
    }
    Ok(format!("{}/{}", WIKI_SOURCES_PREFIX, segments.join("__")))
}

fn encode_source_id_segment(segment: &str) -> Result<String> {
    if segment.is_empty() {
        return Err(anyhow!("empty source_id segment"));
    }
    let mut encoded = String::new();
    for ch in segment.chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' {
            encoded.push(ch);
        } else if ch == '.' {
            encoded.push('_');
        } else {
            return Err(anyhow!("unsupported source_id character: {ch}"));
        }
    }
    Ok(encoded)
}

fn is_top_level_source_index_path(path: &str) -> bool {
    let Some(rest) = path.strip_prefix(&format!("{WIKI_SOURCES_PREFIX}/")) else {
        return false;
    };
    let Some(source_dir) = rest.strip_suffix("/index.md") else {
        return false;
    };
    !source_dir.is_empty() && !source_dir.contains('/')
}

fn compare_search_score(left: f32, right: f32) -> std::cmp::Ordering {
    left.total_cmp(&right)
}

fn validate_safe_path_segment(value: &str) -> Result<()> {
    if value
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '.' || ch == '_' || ch == '-')
    {
        Ok(())
    } else {
        Err(anyhow!("version must be a single safe path segment"))
    }
}

fn parse_metadata(metadata_json: &str) -> Result<DocsMetadata> {
    let value: Value = serde_json::from_str(metadata_json)?;
    let object = value
        .as_object()
        .ok_or_else(|| anyhow!("metadata_json must be an object"))?;
    Ok(DocsMetadata {
        source_id: string_field(object, "source_id"),
        title: string_field(object, "title"),
        citation: string_field(object, "citation"),
        version: string_field(object, "version"),
        chunk_id: string_field(object, "chunk_id"),
        trust: string_field(object, "trust"),
    })
}

fn string_field(object: &serde_json::Map<String, Value>, key: &str) -> Option<String> {
    object
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn hit_snippet(hit: &SearchNodeHit) -> String {
    hit.preview
        .as_ref()
        .and_then(|preview| preview.excerpt.clone())
        .or_else(|| hit.snippet.clone())
        .unwrap_or_default()
}

fn evidence_chars(item: &DocsEvidence) -> usize {
    item.path.chars().count()
        + item.snippet.chars().count()
        + item.content.chars().count()
        + item.source_id.chars().count()
        + item.title.chars().count()
        + item.citation.chars().count()
        + item.chunk_id.chars().count()
}

fn token_budget_chars(max_tokens: u32) -> usize {
    usize::try_from(max_tokens)
        .unwrap_or(usize::MAX / TOKEN_CHAR_APPROX)
        .saturating_mul(TOKEN_CHAR_APPROX)
}

fn estimate_tokens_from_chars(chars: usize) -> u32 {
    u32::try_from(chars.div_ceil(TOKEN_CHAR_APPROX)).unwrap_or(u32::MAX)
}

fn citations_from_pack(pack: &DocsEvidencePack) -> DocsCitationList {
    DocsCitationList {
        citations: citations_from_evidence(&pack.evidence),
        warnings: Vec::new(),
    }
}

fn citations_from_evidence(evidence: &[DocsEvidence]) -> Vec<DocsCitation> {
    let mut seen = BTreeSet::new();
    let mut citations = Vec::new();
    for item in evidence {
        let citation = DocsCitation {
            source_id: item.source_id.clone(),
            title: item.title.clone(),
            citation: item.citation.clone(),
            version: item.version.clone(),
            trust: item.trust.clone(),
        };
        let key = (
            citation.source_id.clone(),
            citation.title.clone(),
            citation.citation.clone(),
            citation.version.clone(),
        );
        if seen.insert(key) {
            citations.push(citation);
        }
    }
    citations
}

fn print_source_list(result: &DocsSourceList, json: bool) -> Result<()> {
    if json {
        println!("{}", serde_json::to_string_pretty(result)?);
        return Ok(());
    }
    for source in &result.sources {
        println!(
            "{}\t{}\t{}",
            source.source_id, source.title, source.index_path
        );
    }
    Ok(())
}

fn print_source_resolve(result: &DocsSourceResolve, json: bool) -> Result<()> {
    if json {
        println!("{}", serde_json::to_string_pretty(result)?);
        return Ok(());
    }
    for source in &result.sources {
        println!(
            "{}\t{}\t{}",
            source.source_id, source.title, source.index_path
        );
    }
    Ok(())
}

fn print_source_query(result: &DocsSourceQuery, json: bool) -> Result<()> {
    if json {
        println!("{}", serde_json::to_string_pretty(result)?);
        return Ok(());
    }
    for item in &result.evidence {
        println!("{}\t{}\t{}", item.source_id, item.citation, item.path);
    }
    Ok(())
}

fn print_pack(result: &DocsEvidencePack, json: bool) -> Result<()> {
    if json {
        println!("{}", serde_json::to_string_pretty(result)?);
        return Ok(());
    }
    for item in &result.evidence {
        println!("{}\t{}\t{}", item.source_id, item.citation, item.path);
    }
    Ok(())
}

fn print_citations(result: &DocsCitationList, json: bool) -> Result<()> {
    if json {
        println!("{}", serde_json::to_string_pretty(result)?);
        return Ok(());
    }
    for item in &result.citations {
        println!("{}\t{}\t{}", item.source_id, item.title, item.citation);
    }
    Ok(())
}

#[derive(Debug)]
struct DocsMetadata {
    source_id: Option<String>,
    title: Option<String>,
    citation: Option<String>,
    version: Option<String>,
    chunk_id: Option<String>,
    trust: Option<String>,
}

#[derive(Debug)]
struct SourceResolveCandidate {
    source: DocsSource,
    score: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DocsSource {
    pub source_id: String,
    pub title: String,
    pub citation: Option<String>,
    pub version: Option<String>,
    pub trust: Option<String>,
    pub index_path: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct DocsSourceList {
    pub sources: Vec<DocsSource>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct DocsSourceResolve {
    pub query: String,
    pub sources: Vec<DocsSource>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct DocsSourceQuery {
    pub query: String,
    pub source: DocsSource,
    pub max_tokens: u32,
    pub estimated_tokens: u32,
    pub evidence: Vec<DocsEvidence>,
    pub warnings: Vec<String>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DocsEvidence {
    pub path: String,
    pub score: f32,
    pub snippet: String,
    pub content: String,
    pub source_id: String,
    pub title: String,
    pub citation: String,
    pub version: Option<String>,
    pub chunk_id: String,
    pub trust: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct DocsEvidencePack {
    pub query: String,
    pub max_tokens: u32,
    pub estimated_tokens: u32,
    pub sources: Vec<DocsSource>,
    pub evidence: Vec<DocsEvidence>,
    pub citations: Vec<DocsCitation>,
    #[serde(default)]
    pub warnings: Vec<String>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DocsCitation {
    pub source_id: String,
    pub title: String,
    pub citation: String,
    pub version: Option<String>,
    pub trust: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct DocsCitationList {
    pub citations: Vec<DocsCitation>,
    pub warnings: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use anyhow::Result;
    use async_trait::async_trait;
    use std::sync::Mutex;
    use vfs_types::{
        AppendNodeRequest, ChildNode, DatabaseSummary, DeleteNodeRequest, DeleteNodeResult,
        EditNodeRequest, EditNodeResult, ExportSnapshotRequest, ExportSnapshotResponse,
        FetchUpdatesRequest, FetchUpdatesResponse, GlobNodeHit, GlobNodesRequest,
        ListChildrenRequest, MkdirNodeRequest, MkdirNodeResult, MoveNodeRequest, MoveNodeResult,
        MultiEditNodeRequest, MultiEditNodeResult, NodeKind, RecentNodeHit, RecentNodesRequest,
        SearchNodePathsRequest, SearchPreview, SearchPreviewField, Status, WriteNodeRequest,
        WriteNodeResult,
    };

    #[test]
    fn source_id_maps_to_docs_source_prefix() {
        assert_eq!(
            docs_source_prefix("/vercel/next.js").expect("source id should encode"),
            "/Wiki/sources/vercel__next_js"
        );
        assert_eq!(
            source_prefix_for("/vercel/next.js", Some("16")).expect("version should append"),
            "/Wiki/sources/vercel__next_js/16"
        );
        assert!(docs_source_prefix("vercel/next.js").is_err());
        assert!(docs_source_prefix("/vercel/next_js").is_err());
        assert!(source_prefix_for("/vercel/next.js", Some("../16")).is_err());
    }

    #[test]
    fn top_level_source_index_path_recognizes_only_source_root_index() {
        assert!(is_top_level_source_index_path(
            "/Wiki/sources/vercel__next_js/index.md"
        ));
        assert!(!is_top_level_source_index_path(
            "/Wiki/sources/vercel__next_js/16/index.md"
        ));
        assert!(!is_top_level_source_index_path("/Wiki/sources/index.md"));
        assert!(!is_top_level_source_index_path(
            "/Wiki/other/vercel__next_js/index.md"
        ));
    }

    #[test]
    fn metadata_parsing_keeps_expected_fields() {
        let metadata = parse_metadata(
            r#"{"source_id":"/vercel/next.js","title":"Next.js","citation":"https://nextjs.org/docs","version":"16","chunk_id":"abc","trust":"official"}"#,
        )
        .expect("metadata should parse");
        assert_eq!(metadata.source_id.as_deref(), Some("/vercel/next.js"));
        assert_eq!(metadata.chunk_id.as_deref(), Some("abc"));
        assert!(parse_metadata("[]").is_err());
        assert!(parse_metadata("{not json").is_err());
    }

    #[test]
    fn citation_list_deduplicates_pack_evidence() {
        let evidence = vec![
            evidence("a", "c1", "https://nextjs.org/docs/a", 0.9),
            evidence("a", "c1", "https://nextjs.org/docs/a", 0.8),
            evidence("b", "c2", "https://nextjs.org/docs/b", 0.7),
        ];
        let citations = citations_from_evidence(&evidence);
        assert_eq!(citations.len(), 2);
        assert_eq!(citations[0].citation, "https://nextjs.org/docs/a");
        assert_eq!(citations[1].citation, "https://nextjs.org/docs/b");
    }

    #[tokio::test]
    async fn source_list_reads_index_metadata_only() {
        let client = DocsMockClient::new()
            .with_node(index_node())
            .with_node(Node {
                path: "/Wiki/sources/vercel__next_js/16/index.md".to_string(),
                kind: NodeKind::File,
                content: "# Next.js 16".to_string(),
                created_at: 0,
                updated_at: 0,
                etag: "version-index".to_string(),
                metadata_json: r#"{"source_id":"/vercel/next.js","title":"Next.js 16","citation":"https://nextjs.org/docs/app","version":"16","trust":"official"}"#.to_string(),
            })
            .with_node(chunk_node("abc", "https://nextjs.org/docs/a", "middleware"));
        let result = list_sources(&client, "db").await.expect("list should work");

        assert_eq!(result.sources.len(), 1);
        assert_eq!(result.sources[0].source_id, "/vercel/next.js");
        assert_eq!(result.sources[0].title, "Next.js");
        assert_eq!(
            result.sources[0].index_path,
            "/Wiki/sources/vercel__next_js/index.md"
        );
    }

    #[tokio::test]
    async fn source_query_excludes_source_id_mismatch() {
        let client = DocsMockClient::new()
            .with_node(index_node())
            .with_node(chunk_node("abc", "https://nextjs.org/docs/a", "middleware"))
            .with_node(chunk_node_for(
                "/Wiki/sources/vercel__next_js/16/wrong-source.md",
                "/supabase/docs",
                "wrong-source",
                "https://supabase.com/docs/guides/auth",
                "middleware",
            ))
            .with_hit("/Wiki/sources/vercel__next_js/16/wrong-source.md", -300.0)
            .with_hit("/Wiki/sources/vercel__next_js/16/abc.md", -100.0);

        let result = query_source(
            &client,
            "db",
            "/vercel/next.js",
            Some("16"),
            "middleware",
            10,
            4_000,
        )
        .await
        .expect("query should work");

        assert_eq!(result.evidence.len(), 1);
        assert_eq!(result.evidence[0].chunk_id, "abc");
        assert!(
            result
                .warnings
                .iter()
                .any(|warning| warning.contains("source_id mismatch"))
        );
    }

    #[tokio::test]
    async fn source_resolve_prefers_index_metadata_over_chunk_metadata() {
        let client = DocsMockClient::new()
            .with_node(index_node())
            .with_node(chunk_node("abc", "https://nextjs.org/docs/a", "middleware"))
            .with_hit("/Wiki/sources/vercel__next_js/16/abc.md", 0.9);

        let result = resolve_sources(&client, "db", "middleware", 10)
            .await
            .expect("resolve should work");

        assert_eq!(result.sources.len(), 1);
        assert_eq!(result.sources[0].title, "Next.js");
        assert_eq!(
            result.sources[0].citation.as_deref(),
            Some("https://nextjs.org/docs")
        );
        assert!(result.warnings.is_empty());
    }

    #[tokio::test]
    async fn source_resolve_missing_index_keeps_minimal_source_without_chunk_citation() {
        let client = DocsMockClient::new()
            .with_node(chunk_node("abc", "https://nextjs.org/docs/a", "middleware"))
            .with_hit("/Wiki/sources/vercel__next_js/16/abc.md", 0.9);

        let result = resolve_sources(&client, "db", "middleware", 10)
            .await
            .expect("resolve should work");

        assert_eq!(result.sources.len(), 1);
        assert_eq!(result.sources[0].title, "/vercel/next.js");
        assert_eq!(result.sources[0].citation, None);
        assert!(
            result
                .warnings
                .iter()
                .any(|warning| warning.contains("source index missing"))
        );
    }

    #[tokio::test]
    async fn source_resolve_orders_sources_by_lowest_search_score() {
        let client = DocsMockClient::new()
            .with_node(index_node())
            .with_node(index_node_for(
                "/Wiki/sources/supabase__docs/index.md",
                "/supabase/docs",
                "Supabase Docs",
                "https://supabase.com/docs",
                "2026",
            ))
            .with_node(chunk_node("abc", "https://nextjs.org/docs/a", "middleware"))
            .with_node(chunk_node_for(
                "/Wiki/sources/vercel__next_js/16/def.md",
                "/vercel/next.js",
                "def",
                "https://nextjs.org/docs/def",
                "middleware",
            ))
            .with_node(chunk_node_for(
                "/Wiki/sources/supabase__docs/2026/auth.md",
                "/supabase/docs",
                "auth",
                "https://supabase.com/docs/guides/auth",
                "middleware",
            ))
            .with_hit("/Wiki/sources/vercel__next_js/16/abc.md", -100.0)
            .with_hit("/Wiki/sources/supabase__docs/2026/auth.md", -200.0)
            .with_hit("/Wiki/sources/vercel__next_js/16/def.md", -300.0);

        let result = resolve_sources(&client, "db", "middleware", 10)
            .await
            .expect("resolve should work");

        assert_eq!(result.sources.len(), 2);
        assert_eq!(result.sources[0].source_id, "/vercel/next.js");
        assert_eq!(result.sources[1].source_id, "/supabase/docs");
    }

    #[tokio::test]
    async fn source_query_excludes_index_and_bad_metadata() {
        let client = DocsMockClient::new()
            .with_node(index_node())
            .with_node(Node {
                path: "/Wiki/sources/vercel__next_js/16/index.md".to_string(),
                kind: NodeKind::File,
                content: "# Next.js 16".to_string(),
                created_at: 0,
                updated_at: 0,
                etag: "version-index".to_string(),
                metadata_json: r#"{"source_id":"/vercel/next.js","title":"Next.js 16","citation":"https://nextjs.org/docs","version":"16","trust":"official"}"#.to_string(),
            })
            .with_node(chunk_node("abc", "https://nextjs.org/docs/a", "middleware"))
            .with_node(Node {
                path: "/Wiki/sources/vercel__next_js/16/bad.md".to_string(),
                kind: NodeKind::File,
                content: "bad".to_string(),
                created_at: 0,
                updated_at: 0,
                etag: "bad".to_string(),
                metadata_json: r#"{"source_id":"/vercel/next.js"}"#.to_string(),
            })
            .with_hit("/Wiki/sources/vercel__next_js/16/index.md", 1.0)
            .with_hit("/Wiki/sources/vercel__next_js/16/abc.md", 0.9)
            .with_hit("/Wiki/sources/vercel__next_js/16/bad.md", 0.8);

        let result = query_source(
            &client,
            "db",
            "/vercel/next.js",
            Some("16"),
            "middleware",
            10,
            4_000,
        )
        .await
        .expect("query should work");

        assert_eq!(result.evidence.len(), 1);
        assert_eq!(result.evidence[0].chunk_id, "abc");
        assert!(
            result
                .warnings
                .iter()
                .any(|warning| warning.contains("index node excluded"))
        );
        assert!(
            result
                .warnings
                .iter()
                .any(|warning| warning.contains("missing citation"))
        );
        let searches = client.searches.lock().expect("searches lock");
        assert_eq!(
            searches[0].prefix.as_deref(),
            Some("/Wiki/sources/vercel__next_js/16")
        );
    }

    #[tokio::test]
    async fn context_pack_deduplicates_repeated_chunks() {
        let client = DocsMockClient::new()
            .with_node(index_node())
            .with_node(chunk_node("abc", "https://nextjs.org/docs/a", "middleware"))
            .with_hit("/Wiki/sources/vercel__next_js/16/abc.md", 0.9)
            .with_hit("/Wiki/sources/vercel__next_js/16/abc.md", 0.8);

        let pack = pack_context(&client, "db", "middleware", 3, 10, 4_000)
            .await
            .expect("pack should work");

        assert_eq!(pack.evidence.len(), 1);
        assert!(!pack.truncated);
        assert_eq!(pack.citations.len(), 1);
    }

    #[tokio::test]
    async fn context_pack_truncates_by_budget() {
        let client = DocsMockClient::new()
            .with_node(index_node())
            .with_node(chunk_node(
                "abc",
                "https://nextjs.org/docs/a",
                &"x".repeat(80),
            ))
            .with_node(chunk_node(
                "abc-duplicate",
                "https://nextjs.org/docs/a",
                &"x".repeat(80),
            ))
            .with_hit("/Wiki/sources/vercel__next_js/16/abc.md", -100.0)
            .with_hit("/Wiki/sources/vercel__next_js/16/abc-duplicate.md", -300.0);

        let pack = pack_context(&client, "db", "middleware", 3, 10, 60)
            .await
            .expect("pack should work");

        assert_eq!(pack.evidence.len(), 1);
        assert_eq!(pack.evidence[0].chunk_id, "abc-duplicate");
        assert!(pack.truncated);
        assert_eq!(pack.citations.len(), 1);
    }

    #[tokio::test]
    async fn context_pack_orders_evidence_by_lowest_search_score() {
        let client = DocsMockClient::new()
            .with_node(index_node())
            .with_node(chunk_node("abc", "https://nextjs.org/docs/a", "middleware"))
            .with_node(chunk_node(
                "def",
                "https://nextjs.org/docs/def",
                "middleware",
            ))
            .with_hit("/Wiki/sources/vercel__next_js/16/abc.md", -100.0)
            .with_hit("/Wiki/sources/vercel__next_js/16/def.md", -300.0);

        let pack = pack_context(&client, "db", "middleware", 3, 10, 4_000)
            .await
            .expect("pack should work");

        assert_eq!(pack.evidence.len(), 2);
        assert_eq!(pack.evidence[0].chunk_id, "def");
        assert_eq!(pack.evidence[1].chunk_id, "abc");
    }

    #[tokio::test]
    async fn context_pack_excludes_source_id_mismatch_from_evidence_and_citations() {
        let client = DocsMockClient::new()
            .with_node(index_node())
            .with_node(chunk_node("abc", "https://nextjs.org/docs/a", "middleware"))
            .with_node(chunk_node_for(
                "/Wiki/sources/vercel__next_js/16/wrong-source.md",
                "/supabase/docs",
                "wrong-source",
                "https://supabase.com/docs/guides/auth",
                "middleware",
            ))
            .with_hit("/Wiki/sources/vercel__next_js/16/abc.md", -400.0)
            .with_hit("/Wiki/sources/vercel__next_js/16/wrong-source.md", -300.0);

        let pack = pack_context(&client, "db", "middleware", 1, 10, 4_000)
            .await
            .expect("pack should work");

        assert_eq!(pack.evidence.len(), 1);
        assert_eq!(pack.evidence[0].chunk_id, "abc");
        assert_eq!(pack.citations.len(), 1);
        assert_eq!(pack.citations[0].citation, "https://nextjs.org/docs/a");
        assert!(
            pack.warnings
                .iter()
                .any(|warning| warning.contains("source_id mismatch"))
        );
    }

    fn evidence(chunk_id: &str, citation_suffix: &str, citation: &str, score: f32) -> DocsEvidence {
        DocsEvidence {
            path: format!("/Wiki/sources/vercel__next_js/16/{chunk_id}.md"),
            score,
            snippet: "snippet".to_string(),
            content: "content".to_string(),
            source_id: "/vercel/next.js".to_string(),
            title: "Next.js".to_string(),
            citation: citation.to_string(),
            version: Some("16".to_string()),
            chunk_id: citation_suffix.to_string(),
            trust: Some("official".to_string()),
        }
    }

    fn index_node() -> Node {
        index_node_for(
            "/Wiki/sources/vercel__next_js/index.md",
            "/vercel/next.js",
            "Next.js",
            "https://nextjs.org/docs",
            "16",
        )
    }

    fn chunk_node(chunk_id: &str, citation: &str, content: &str) -> Node {
        chunk_node_for(
            &format!("/Wiki/sources/vercel__next_js/16/{chunk_id}.md"),
            "/vercel/next.js",
            chunk_id,
            citation,
            content,
        )
    }

    fn index_node_for(
        path: &str,
        source_id: &str,
        title: &str,
        citation: &str,
        version: &str,
    ) -> Node {
        Node {
            path: path.to_string(),
            kind: NodeKind::File,
            content: format!("# {title}"),
            created_at: 0,
            updated_at: 0,
            etag: path.to_string(),
            metadata_json: format!(
                r#"{{"source_id":"{source_id}","title":"{title}","citation":"{citation}","version":"{version}","trust":"official"}}"#
            ),
        }
    }

    fn chunk_node_for(
        path: &str,
        source_id: &str,
        chunk_id: &str,
        citation: &str,
        content: &str,
    ) -> Node {
        Node {
            path: path.to_string(),
            kind: NodeKind::File,
            content: content.to_string(),
            created_at: 0,
            updated_at: 0,
            etag: chunk_id.to_string(),
            metadata_json: format!(
                r#"{{"source_id":"{source_id}","title":"Next.js Middleware","citation":"{citation}","version":"16","chunk_id":"{chunk_id}","trust":"official"}}"#
            ),
        }
    }

    struct DocsMockClient {
        nodes: BTreeMap<String, Node>,
        hits: Vec<SearchNodeHit>,
        searches: Mutex<Vec<SearchNodesRequest>>,
    }

    impl DocsMockClient {
        fn new() -> Self {
            Self {
                nodes: BTreeMap::new(),
                hits: Vec::new(),
                searches: Mutex::new(Vec::new()),
            }
        }

        fn with_node(mut self, node: Node) -> Self {
            self.nodes.insert(node.path.clone(), node);
            self
        }

        fn with_hit(mut self, path: &str, score: f32) -> Self {
            self.hits.push(SearchNodeHit {
                path: path.to_string(),
                kind: NodeKind::File,
                snippet: Some("snippet".to_string()),
                preview: Some(SearchPreview {
                    field: SearchPreviewField::Content,
                    match_reason: "content".to_string(),
                    char_offset: 0,
                    excerpt: Some("preview".to_string()),
                }),
                score,
                match_reasons: vec!["content".to_string()],
            });
            self
        }
    }

    #[async_trait]
    impl VfsApi for DocsMockClient {
        async fn status(&self, _database_id: &str) -> Result<Status> {
            Err(anyhow!("not implemented"))
        }

        async fn read_node(&self, _database_id: &str, path: &str) -> Result<Option<Node>> {
            Ok(self.nodes.get(path).cloned())
        }

        async fn list_nodes(&self, request: ListNodesRequest) -> Result<Vec<vfs_types::NodeEntry>> {
            Ok(self
                .nodes
                .values()
                .filter(|node| node.path.starts_with(&request.prefix))
                .map(|node| vfs_types::NodeEntry {
                    path: node.path.clone(),
                    kind: NodeEntryKind::File,
                    updated_at: node.updated_at,
                    etag: node.etag.clone(),
                    has_children: false,
                })
                .collect())
        }

        async fn list_children(&self, _request: ListChildrenRequest) -> Result<Vec<ChildNode>> {
            Err(anyhow!("not implemented"))
        }

        async fn write_node(&self, _request: WriteNodeRequest) -> Result<WriteNodeResult> {
            Err(anyhow!("not implemented"))
        }

        async fn append_node(&self, _request: AppendNodeRequest) -> Result<WriteNodeResult> {
            Err(anyhow!("not implemented"))
        }

        async fn edit_node(&self, _request: EditNodeRequest) -> Result<EditNodeResult> {
            Err(anyhow!("not implemented"))
        }

        async fn delete_node(&self, _request: DeleteNodeRequest) -> Result<DeleteNodeResult> {
            Err(anyhow!("not implemented"))
        }

        async fn move_node(&self, _request: MoveNodeRequest) -> Result<MoveNodeResult> {
            Err(anyhow!("not implemented"))
        }

        async fn mkdir_node(&self, _request: MkdirNodeRequest) -> Result<MkdirNodeResult> {
            Err(anyhow!("not implemented"))
        }

        async fn glob_nodes(&self, _request: GlobNodesRequest) -> Result<Vec<GlobNodeHit>> {
            Err(anyhow!("not implemented"))
        }

        async fn recent_nodes(&self, _request: RecentNodesRequest) -> Result<Vec<RecentNodeHit>> {
            Err(anyhow!("not implemented"))
        }

        async fn multi_edit_node(
            &self,
            _request: MultiEditNodeRequest,
        ) -> Result<MultiEditNodeResult> {
            Err(anyhow!("not implemented"))
        }

        async fn search_nodes(&self, request: SearchNodesRequest) -> Result<Vec<SearchNodeHit>> {
            self.searches
                .lock()
                .expect("searches lock")
                .push(request.clone());
            Ok(self
                .hits
                .iter()
                .filter(|hit| {
                    request
                        .prefix
                        .as_ref()
                        .is_none_or(|prefix| hit.path.starts_with(prefix))
                })
                .cloned()
                .collect())
        }

        async fn search_node_paths(
            &self,
            _request: SearchNodePathsRequest,
        ) -> Result<Vec<SearchNodeHit>> {
            Err(anyhow!("not implemented"))
        }

        async fn export_snapshot(
            &self,
            _request: ExportSnapshotRequest,
        ) -> Result<ExportSnapshotResponse> {
            Err(anyhow!("not implemented"))
        }

        async fn fetch_updates(
            &self,
            _request: FetchUpdatesRequest,
        ) -> Result<FetchUpdatesResponse> {
            Err(anyhow!("not implemented"))
        }

        async fn list_databases(&self) -> Result<Vec<DatabaseSummary>> {
            Err(anyhow!("not implemented"))
        }
    }
}
