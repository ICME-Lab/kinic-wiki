// Where: crates/vfs_store/src/fs_store/context.rs
// What: Memory context assembly and source evidence.
// Why: Mechanical split out of fs_store.rs; a child module keeps private access.
use super::*;

impl FsStore {
    pub fn read_node_context(
        &self,
        request: NodeContextRequest,
    ) -> Result<Option<NodeContext>, String> {
        let path = normalize_node_path(&request.path, false)?;
        self.read_conn(|conn| {
            let Some(node) = load_node(conn, &path)? else {
                return Ok(None);
            };
            let limit = capped_query_limit(request.link_limit);
            Ok(Some(NodeContext {
                incoming_links: load_incoming_links(conn, &path, limit)?,
                outgoing_links: load_outgoing_links(conn, &path, limit)?,
                node,
            }))
        })
    }

    pub fn query_context(&self, request: QueryContextRequest) -> Result<QueryContext, String> {
        if request.depth > 2 {
            return Err("depth must be 0, 1, or 2".to_string());
        }
        let namespace = normalize_memory_namespace(request.namespace.as_deref())?;
        let budget_chars = budget_chars(request.budget_tokens);
        let query_text = context_query_text(&request.task, &request.entities)?;
        let search_hits = self.search_nodes(SearchNodesRequest {
            database_id: request.database_id.clone(),
            query_text,
            prefix: Some(namespace.clone()),
            top_k: CONTEXT_SEARCH_LIMIT,
            preview_mode: Some(SearchPreviewMode::Light),
        })?;
        let paths = ordered_context_candidate_paths(&namespace, &search_hits);

        self.read_conn(|conn| {
            let mut nodes = Vec::new();
            let mut used_chars = 0usize;
            let mut truncated = false;
            for path in paths {
                let Some(context) = load_node_context_for_memory(conn, &path, CONTEXT_LINK_LIMIT)?
                else {
                    continue;
                };
                let context_chars = estimate_node_context_chars(&context);
                if !nodes.is_empty() && used_chars.saturating_add(context_chars) > budget_chars {
                    truncated = true;
                    break;
                }
                used_chars = used_chars.saturating_add(context_chars);
                nodes.push(context);
                if used_chars > budget_chars {
                    truncated = true;
                    break;
                }
            }

            let mut graph_links = Vec::new();
            if request.depth > 0 {
                let mut seen_edges = BTreeSet::new();
                for context in &nodes {
                    for edge in load_graph_neighborhood(
                        conn,
                        &context.node.path,
                        request.depth,
                        capped_query_limit(CONTEXT_LINK_LIMIT),
                    )? {
                        let key = (
                            edge.source_path.clone(),
                            edge.target_path.clone(),
                            edge.raw_href.clone(),
                        );
                        if seen_edges.insert(key) {
                            let edge_chars = estimate_link_edge_chars(&edge);
                            if used_chars.saturating_add(edge_chars) > budget_chars {
                                truncated = true;
                                break;
                            }
                            used_chars = used_chars.saturating_add(edge_chars);
                            graph_links.push(edge);
                        }
                        if graph_links.len() >= QUERY_RESULT_LIMIT_MAX as usize {
                            truncated = true;
                            break;
                        }
                    }
                    if graph_links.len() >= QUERY_RESULT_LIMIT_MAX as usize {
                        break;
                    }
                }
            }

            let evidence = if request.include_evidence {
                let mut items = Vec::new();
                for context in &nodes {
                    let evidence = source_evidence_for_path(conn, &context.node.path)?;
                    let evidence_chars = estimate_source_evidence_chars(&evidence);
                    if !items.is_empty() && used_chars.saturating_add(evidence_chars) > budget_chars
                    {
                        truncated = true;
                        break;
                    }
                    used_chars = used_chars.saturating_add(evidence_chars);
                    items.push(evidence);
                }
                items
            } else {
                Vec::new()
            };
            let (search_hits, search_chars, search_truncated) =
                trim_search_hits_to_remaining_budget(search_hits, used_chars, budget_chars);
            used_chars = used_chars.saturating_add(search_chars);
            if search_truncated || used_chars > budget_chars {
                truncated = true;
            }

            Ok(QueryContext {
                namespace,
                task: request.task,
                search_hits,
                nodes,
                graph_links,
                evidence,
                truncated,
            })
        })
    }

    pub fn source_evidence(
        &self,
        request: SourceEvidenceRequest,
    ) -> Result<SourceEvidence, String> {
        let node_path = normalize_node_path(&request.node_path, false)?;
        self.read_conn(|conn| {
            let Some(_) = load_node(conn, &node_path)? else {
                return Err(format!("node does not exist: {node_path}"));
            };
            source_evidence_for_path(conn, &node_path)
        })
    }
}

pub(crate) fn normalize_memory_namespace(namespace: Option<&str>) -> Result<String, String> {
    namespace
        .map(|value| normalize_node_path(value, true))
        .transpose()
        .map(|value| value.unwrap_or_else(|| WIKI_ROOT_PATH.to_string()))
}

pub(crate) fn budget_chars(token_budget: u32) -> usize {
    let tokens = if token_budget == 0 {
        1_000
    } else {
        token_budget
    };
    tokens as usize * TOKEN_CHAR_APPROX
}

pub(crate) fn context_query_text(task: &str, entities: &[String]) -> Result<String, String> {
    let mut parts = Vec::new();
    let task = task.trim();
    if !task.is_empty() {
        parts.push(task.to_string());
    }
    parts.extend(
        entities
            .iter()
            .map(|entity| entity.trim())
            .filter(|entity| !entity.is_empty())
            .map(str::to_string),
    );
    if parts.is_empty() {
        return Err("task or entities must not be empty".to_string());
    }
    Ok(parts.join(" "))
}

pub(crate) fn canonical_context_paths(namespace: &str) -> Vec<String> {
    [
        "index.md",
        "facts.md",
        "preferences.md",
        "plans.md",
        "open_questions.md",
        "overview.md",
        "schema.md",
        "events.md",
        "summary.md",
        "provenance.md",
    ]
    .into_iter()
    .map(|name| format!("{}/{}", namespace.trim_end_matches('/'), name))
    .collect()
}

pub(crate) fn trim_search_hits_to_remaining_budget(
    hits: Vec<SearchNodeHit>,
    used_chars: usize,
    budget_chars: usize,
) -> (Vec<SearchNodeHit>, usize, bool) {
    let mut kept = Vec::new();
    let mut used_search_chars = 0usize;
    let mut truncated = false;
    for hit in hits {
        let hit_chars = estimate_search_hit_chars(&hit);
        if used_chars
            .saturating_add(used_search_chars)
            .saturating_add(hit_chars)
            > budget_chars
        {
            truncated = true;
            break;
        }
        used_search_chars = used_search_chars.saturating_add(hit_chars);
        kept.push(hit);
    }
    (kept, used_search_chars, truncated)
}

pub(crate) fn ordered_context_candidate_paths(
    namespace: &str,
    search_hits: &[SearchNodeHit],
) -> Vec<String> {
    let mut paths = Vec::new();
    let mut seen = BTreeSet::new();
    for path in canonical_context_paths(namespace)
        .into_iter()
        .chain(search_hits.iter().map(|hit| hit.path.clone()))
    {
        if seen.insert(path.clone()) {
            paths.push(path);
        }
    }
    paths
}

pub(crate) fn provenance_path_for(node_path: &str) -> Option<String> {
    let parent = node_path.rsplit_once('/')?.0;
    if parent.is_empty() {
        return None;
    }
    Some(format!("{parent}/provenance.md"))
}

pub(crate) fn scope_root_provenance_path_for(node_path: &str) -> Option<String> {
    let mut parts = node_path.trim_matches('/').split('/');
    let root = parts.next()?;
    let scope = parts.next()?;
    if root != "Knowledge" {
        return None;
    }
    Some(format!("/{root}/{scope}/provenance.md"))
}

pub(crate) fn load_node_context_for_memory(
    conn: &Connection,
    path: &str,
    limit: u32,
) -> Result<Option<NodeContext>, String> {
    let Some(node) = load_node(conn, path)? else {
        return Ok(None);
    };
    Ok(Some(NodeContext {
        incoming_links: load_incoming_links(conn, path, capped_query_limit(limit))?,
        outgoing_links: load_outgoing_links(conn, path, capped_query_limit(limit))?,
        node,
    }))
}

pub(crate) fn source_evidence_for_path(
    conn: &Connection,
    node_path: &str,
) -> Result<SourceEvidence, String> {
    let mut refs = Vec::new();
    let mut seen = BTreeSet::new();
    collect_source_refs_from_path(conn, node_path, &mut refs, &mut seen)?;
    if let Some(provenance_path) = provenance_path_for(node_path) {
        collect_source_refs_from_path(conn, &provenance_path, &mut refs, &mut seen)?;
    }
    if let Some(provenance_path) = scope_root_provenance_path_for(node_path) {
        collect_source_refs_from_path(conn, &provenance_path, &mut refs, &mut seen)?;
    }
    Ok(SourceEvidence {
        node_path: node_path.to_string(),
        refs,
    })
}

pub(crate) fn collect_source_refs_from_path(
    conn: &Connection,
    path: &str,
    refs: &mut Vec<SourceEvidenceRef>,
    seen: &mut BTreeSet<(String, String, String)>,
) -> Result<(), String> {
    let Some(_) = load_node(conn, path)? else {
        return Ok(());
    };
    for edge in load_outgoing_links(conn, path, capped_query_limit(QUERY_RESULT_LIMIT_MAX))? {
        if !edge.target_path.starts_with("/Sources/") {
            continue;
        }
        let key = (
            edge.target_path.clone(),
            edge.source_path.clone(),
            edge.raw_href.clone(),
        );
        if seen.insert(key) {
            let source_node = load_node(conn, &edge.target_path)?;
            refs.push(SourceEvidenceRef {
                source_path: edge.target_path,
                via_path: edge.source_path,
                raw_href: edge.raw_href,
                link_text: edge.link_text,
                source_etag: source_node.as_ref().map(|node| node.etag.clone()),
                source_updated_at: source_node.as_ref().map(|node| node.updated_at),
                source_content_hash: source_node.as_ref().map(|node| sha256_hex(&node.content)),
            });
        }
    }
    Ok(())
}

pub(crate) fn estimate_search_hit_chars(hit: &SearchNodeHit) -> usize {
    hit.path.chars().count()
        + hit.snippet.as_deref().map(str::len).unwrap_or_default()
        + hit
            .preview
            .as_ref()
            .and_then(|preview| preview.excerpt.as_deref())
            .map(str::len)
            .unwrap_or_default()
        + hit.match_reasons.iter().map(String::len).sum::<usize>()
}

pub(crate) fn estimate_node_context_chars(context: &NodeContext) -> usize {
    context.node.path.chars().count()
        + context.node.content.chars().count()
        + context.node.metadata_json.chars().count()
        + context
            .incoming_links
            .iter()
            .chain(context.outgoing_links.iter())
            .map(estimate_link_edge_chars)
            .sum::<usize>()
}

pub(crate) fn estimate_link_edge_chars(edge: &LinkEdge) -> usize {
    edge.source_path.chars().count()
        + edge.target_path.chars().count()
        + edge.raw_href.chars().count()
        + edge.link_text.chars().count()
        + edge.link_kind.chars().count()
}

pub(crate) fn estimate_source_evidence_chars(evidence: &SourceEvidence) -> usize {
    evidence.node_path.chars().count()
        + evidence
            .refs
            .iter()
            .map(|item| {
                item.source_path.chars().count()
                    + item.via_path.chars().count()
                    + item.raw_href.chars().count()
                    + item.link_text.chars().count()
            })
            .sum::<usize>()
}
