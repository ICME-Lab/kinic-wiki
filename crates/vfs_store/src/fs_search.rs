// Where: crates/vfs_store/src/fs_search.rs
// What: Search-specific helpers for FTS schema, query expansion, ranking, and light preview.
// Why: Search behavior blends content, path, and title signals, so isolate it here.
use std::collections::{BTreeMap, BTreeSet};

use rusqlite::Connection;
use vfs_types::{NodeKind, SearchNodeHit, SearchPreview, SearchPreviewField, SearchPreviewMode};

use crate::fs_helpers::{file_search_title, prefix_filter_sql_for_column};

const SEARCH_CANDIDATE_MULTIPLIER: u32 = 4;
const FTS_RANK_SCALE: f32 = 10_000.0;
const PATH_EXACT_SCORE: f32 = -600_000_000.0;
const BASENAME_EXACT_SCORE: f32 = -500_000_000.0;
const BASENAME_PREFIX_SCORE: f32 = -400_000_000.0;
const TITLE_SCORE: f32 = -300_000_000.0;
const PATH_SCORE: f32 = -200_000_000.0;
const CONTENT_SUBSTRING_SCORE: f32 = -100_000_000.0;
const LIGHT_PREVIEW_CONTEXT_CHARS: usize = 24;
const LIGHT_PREVIEW_MAX_CHARS: usize = 96;

#[derive(Clone, Debug)]
pub(crate) struct SearchQueryPlan {
    pub(crate) raw_query: String,
    pub(crate) lowered_query: String,
    pub(crate) path_terms: Vec<String>,
    exact_fts: Option<String>,
    recall_fts: Option<String>,
    has_cjk: bool,
}

#[derive(Clone, Debug)]
pub(crate) struct SearchPathHit {
    pub(crate) row_id: i64,
    pub(crate) path: String,
    pub(crate) kind: NodeKind,
    pub(crate) score: f32,
}

#[derive(Clone, Debug)]
pub(crate) struct SearchCandidate {
    pub(crate) row_id: i64,
    pub(crate) path: String,
    pub(crate) kind: NodeKind,
    pub(crate) score: f32,
    pub(crate) snippet: Option<String>,
    pub(crate) preview: Option<SearchPreview>,
    pub(crate) match_reasons: BTreeSet<String>,
    pub(crate) has_content_match: bool,
}

pub(crate) fn build_search_query_plan(query_text: &str) -> Option<SearchQueryPlan> {
    let raw_query = query_text.trim().to_string();
    if raw_query.is_empty() {
        return None;
    }
    let whitespace_terms = raw_query
        .split_whitespace()
        .map(str::trim)
        .filter(|term| !term.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();
    if whitespace_terms.is_empty() {
        return None;
    }
    let lowered_query = raw_query.to_lowercase();
    let path_terms = whitespace_terms
        .iter()
        .map(|term| term.to_lowercase())
        .collect::<Vec<_>>();
    let mut recall_terms = Vec::new();
    let mut has_cjk = false;
    for term in &whitespace_terms {
        recall_terms.push(term.clone());
        if contains_cjk(term) {
            has_cjk = true;
            recall_terms.extend(cjk_bigrams(term));
        }
    }
    recall_terms.sort();
    recall_terms.dedup();
    let exact_fts = join_fts_terms(&whitespace_terms, " ");
    let recall_fts = join_fts_terms(&recall_terms, " OR ");
    Some(SearchQueryPlan {
        raw_query,
        lowered_query,
        path_terms,
        exact_fts: Some(exact_fts.clone()),
        recall_fts: (exact_fts != recall_fts).then_some(recall_fts),
        has_cjk,
    })
}

pub(crate) fn load_ranked_fts_candidates(
    conn: &Connection,
    plan: &SearchQueryPlan,
    prefix: Option<&str>,
    top_k: i64,
) -> Result<Vec<SearchCandidate>, String> {
    let limit = candidate_limit(top_k);
    let mut candidates = BTreeMap::new();
    for query in [&plan.exact_fts, &plan.recall_fts].into_iter().flatten() {
        let mut values = vec![rusqlite::types::Value::from(query.clone())];
        let (scope_sql, scope_values) = non_root_prefix(prefix)
            .map(|prefix| prefix_filter_sql_for_column("fs_nodes.path", prefix, values.len() + 1))
            .unwrap_or_else(|| (String::new(), Vec::new()));
        values.extend(scope_values);
        let sql = format!(
            "SELECT fs_nodes.id,
                    fs_nodes.path,
                    fs_nodes.kind,
                    bm25(fs_nodes_fts, 0.1, 2.0, 1.0) AS rank
             FROM fs_nodes_fts
             JOIN fs_nodes ON fs_nodes.id = fs_nodes_fts.rowid
             WHERE fs_nodes_fts MATCH ?1{}
             ORDER BY rank ASC, fs_nodes.path ASC
             LIMIT {limit}",
            scope_sql
        );
        let mut stmt = conn.prepare(&sql).map_err(|error| error.to_string())?;
        let rows = stmt
            .query_map(rusqlite::params_from_iter(values.iter()), |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, f32>(3)?,
                ))
            })
            .map_err(|error| error.to_string())?;
        for row in rows {
            let (row_id, path, kind, rank) = row.map_err(|error| error.to_string())?;
            let kind = node_kind_from_db(&kind).map_err(|error| error.to_string())?;
            candidates.entry(row_id).or_insert_with(|| SearchCandidate {
                row_id,
                path,
                kind,
                score: rank * FTS_RANK_SCALE,
                snippet: None,
                preview: None,
                match_reasons: BTreeSet::from(["content_fts".to_string()]),
                has_content_match: true,
            });
        }
    }
    Ok(candidates.into_values().collect())
}

pub(crate) fn load_path_candidates(
    conn: &Connection,
    terms: &[String],
    prefix: Option<&str>,
    top_k: i64,
) -> Result<Vec<SearchPathHit>, String> {
    let mut sql = String::from(
        "SELECT id, path, kind, instr(lower(path), ?1) AS first_match_position, length(path) AS path_length
         FROM fs_nodes
         WHERE 1 = 1",
    );
    let mut values = vec![rusqlite::types::Value::from(terms[0].clone())];
    for term in terms {
        let index = values.len() + 1;
        sql.push_str(&format!(" AND instr(lower(path), ?{index}) > 0"));
        values.push(rusqlite::types::Value::from(term.clone()));
    }
    if let Some(prefix) = non_root_prefix(prefix) {
        let (scope_sql, scope_values) =
            prefix_filter_sql_for_column("fs_nodes.path", prefix, values.len() + 1);
        sql.push_str(&scope_sql);
        values.extend(scope_values);
    }
    sql.push_str(&format!(
        " ORDER BY first_match_position ASC, path_length ASC, path ASC LIMIT {}",
        candidate_limit(top_k)
    ));
    let mut stmt = conn.prepare(&sql).map_err(|error| error.to_string())?;
    stmt.query_map(rusqlite::params_from_iter(values.iter()), |row| {
        Ok(SearchPathHit {
            row_id: row.get(0)?,
            path: row.get(1)?,
            kind: node_kind_from_db(&row.get::<_, String>(2)?)?,
            score: path_match_score(row.get::<_, i64>(3)?, row.get::<_, i64>(4)?),
        })
    })
    .map_err(|error| error.to_string())?
    .collect::<Result<Vec<_>, _>>()
    .map_err(|error| error.to_string())
}

pub(crate) fn load_content_substring_candidates(
    conn: &Connection,
    plan: &SearchQueryPlan,
    prefix: Option<&str>,
    top_k: i64,
) -> Result<Vec<SearchCandidate>, String> {
    if !plan.has_cjk {
        return Ok(Vec::new());
    }
    let mut values = vec![rusqlite::types::Value::from(plan.raw_query.clone())];
    let (scope_sql, scope_values) = non_root_prefix(prefix)
        .map(|prefix| prefix_filter_sql_for_column("path", prefix, values.len() + 1))
        .unwrap_or_else(|| (String::new(), Vec::new()));
    values.extend(scope_values);
    let sql = format!(
        "SELECT id, path, kind
         FROM fs_nodes
         WHERE instr(content, ?1) > 0{}
         ORDER BY path ASC
         LIMIT {}",
        scope_sql,
        candidate_limit(top_k)
    );
    let mut candidates = Vec::new();
    let mut stmt = conn.prepare(&sql).map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(values.iter()), |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|error| error.to_string())?;
    for row in rows {
        let (row_id, path, kind) = row.map_err(|error| error.to_string())?;
        candidates.push(SearchCandidate {
            row_id,
            path,
            kind: node_kind_from_db(&kind).map_err(|error| error.to_string())?,
            score: CONTENT_SUBSTRING_SCORE,
            snippet: None,
            preview: None,
            match_reasons: BTreeSet::from(["content_substring".to_string()]),
            has_content_match: true,
        });
    }
    Ok(candidates)
}

fn non_root_prefix(prefix: Option<&str>) -> Option<&str> {
    prefix.filter(|value| *value != "/")
}

pub(crate) fn rerank_candidates(
    mut candidates: BTreeMap<i64, SearchCandidate>,
    plan: &SearchQueryPlan,
    path_hits: Vec<SearchPathHit>,
) -> Vec<SearchCandidate> {
    for hit in path_hits {
        let title = file_search_title(&hit.path);
        let path_lower = hit.path.to_lowercase();
        let title_lower = title.to_lowercase();
        let candidate = candidates
            .entry(hit.row_id)
            .or_insert_with(|| SearchCandidate {
                row_id: hit.row_id,
                path: hit.path.clone(),
                kind: hit.kind.clone(),
                score: hit.score,
                snippet: Some(hit.path.clone()),
                preview: None,
                match_reasons: BTreeSet::new(),
                has_content_match: false,
            });
        let mut score = candidate.score.min(hit.score);
        if path_lower == plan.lowered_query {
            score = score.min(PATH_EXACT_SCORE);
            candidate.match_reasons.insert("path_exact".to_string());
        }
        if title_lower == plan.lowered_query {
            score = score.min(BASENAME_EXACT_SCORE);
            candidate.match_reasons.insert("basename_exact".to_string());
        } else if title_lower.starts_with(&plan.lowered_query) {
            score = score.min(BASENAME_PREFIX_SCORE);
            candidate
                .match_reasons
                .insert("basename_prefix".to_string());
        }
        if plan
            .path_terms
            .iter()
            .all(|term| title_lower.contains(term))
        {
            score = score.min(TITLE_SCORE);
            candidate.match_reasons.insert("title_fts".to_string());
        }
        if plan.path_terms.iter().all(|term| path_lower.contains(term)) {
            score = score.min(PATH_SCORE);
            candidate.match_reasons.insert("path_substring".to_string());
            if candidate.snippet.is_none() || !candidate.has_content_match {
                candidate.snippet = Some(candidate.path.clone());
            }
        }
        candidate.score = score;
    }
    sort_candidates(candidates.into_values().collect())
}

pub(crate) fn sort_candidates(mut ranked: Vec<SearchCandidate>) -> Vec<SearchCandidate> {
    ranked.sort_by(|left, right| {
        left.score
            .total_cmp(&right.score)
            .then_with(|| left.path.cmp(&right.path))
    });
    ranked
}

pub(crate) fn build_light_previews_for_hits(
    conn: &Connection,
    candidates: &mut [SearchCandidate],
    plan: &SearchQueryPlan,
    preview_mode: SearchPreviewMode,
) -> Result<(), String> {
    if matches!(preview_mode, SearchPreviewMode::None) {
        return Ok(());
    }
    let content_ids = candidates
        .iter_mut()
        .filter_map(|candidate| {
            if let Some(preview) = build_path_preview(candidate, plan) {
                candidate.preview = Some(preview);
                return None;
            }
            if candidate.has_content_match {
                Some(candidate.row_id)
            } else {
                None
            }
        })
        .collect::<Vec<_>>();
    if content_ids.is_empty() {
        return Ok(());
    }
    let contents = load_contents_by_id(conn, &content_ids)?;
    for candidate in candidates
        .iter_mut()
        .filter(|candidate| candidate.preview.is_none())
    {
        let Some(content) = contents.get(&candidate.row_id) else {
            continue;
        };
        candidate.preview = build_content_preview(candidate, content, plan);
    }
    Ok(())
}

pub(crate) fn finalize_hits(candidates: Vec<SearchCandidate>, top_k: i64) -> Vec<SearchNodeHit> {
    candidates
        .into_iter()
        .take(top_k as usize)
        .map(|candidate| SearchNodeHit {
            path: candidate.path,
            kind: candidate.kind,
            snippet: candidate.snippet,
            preview: candidate.preview,
            score: candidate.score,
            match_reasons: candidate.match_reasons.into_iter().collect(),
        })
        .collect()
}

fn build_path_preview(
    candidate: &SearchCandidate,
    plan: &SearchQueryPlan,
) -> Option<SearchPreview> {
    let reason = best_path_reason(&candidate.match_reasons)?;
    let offset = find_path_offset(&candidate.path, reason, plan)?;
    Some(SearchPreview {
        field: SearchPreviewField::Path,
        match_reason: reason.to_string(),
        char_offset: offset,
        excerpt: None,
    })
}

fn build_content_preview(
    candidate: &SearchCandidate,
    content: &str,
    plan: &SearchQueryPlan,
) -> Option<SearchPreview> {
    let reason = best_content_reason(&candidate.match_reasons)?;
    let (offset, matched_len) = match reason {
        "content_substring" => find_query_anchor(content, &plan.raw_query),
        "content_fts" => find_fts_anchor(content, plan),
        _ => None,
    }?;
    Some(SearchPreview {
        field: SearchPreviewField::Content,
        match_reason: reason.to_string(),
        char_offset: offset as u32,
        excerpt: build_excerpt(content, offset, matched_len),
    })
}

fn best_path_reason(reasons: &BTreeSet<String>) -> Option<&'static str> {
    [
        "path_exact",
        "basename_exact",
        "basename_prefix",
        "title_fts",
        "path_substring",
    ]
    .into_iter()
    .find(|reason| reasons.contains(*reason))
}

fn best_content_reason(reasons: &BTreeSet<String>) -> Option<&'static str> {
    ["content_substring", "content_fts"]
        .into_iter()
        .find(|reason| reasons.contains(*reason))
}

fn find_path_offset(path: &str, reason: &str, plan: &SearchQueryPlan) -> Option<u32> {
    match reason {
        "path_exact" => Some(0),
        "basename_exact" | "basename_prefix" | "title_fts" => {
            let title = file_search_title(path);
            let title_offset = find_query_anchor(&title, &plan.raw_query)
                .or_else(|| find_terms_anchor(&title, &plan.path_terms))?
                .0;
            let base_start = path.rfind('/').map(|index| index + 1).unwrap_or(0);
            Some(path[..base_start].chars().count() as u32 + title_offset as u32)
        }
        "path_substring" => {
            let (offset, _) = find_terms_anchor(path, &plan.path_terms)?;
            Some(offset as u32)
        }
        _ => None,
    }
}

fn load_contents_by_id(conn: &Connection, ids: &[i64]) -> Result<BTreeMap<i64, String>, String> {
    if ids.is_empty() {
        return Ok(BTreeMap::new());
    }
    let placeholders = (1..=ids.len())
        .map(|index| format!("?{index}"))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!("SELECT id, content FROM fs_nodes WHERE id IN ({placeholders})");
    let mut stmt = conn.prepare(&sql).map_err(|error| error.to_string())?;
    stmt.query_map(rusqlite::params_from_iter(ids.iter().copied()), |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
    })
    .map_err(|error| error.to_string())?
    .collect::<Result<BTreeMap<_, _>, _>>()
    .map_err(|error| error.to_string())
}

fn find_fts_anchor(content: &str, plan: &SearchQueryPlan) -> Option<(usize, usize)> {
    find_query_anchor(content, &plan.raw_query)
        .or_else(|| find_terms_anchor(content, &plan.path_terms))
}

fn find_query_anchor(content: &str, query: &str) -> Option<(usize, usize)> {
    if query.is_empty() {
        return None;
    }
    find_exact_anchor(content, query).or_else(|| {
        if query.is_ascii() {
            find_ascii_case_insensitive_anchor(content, query)
        } else {
            None
        }
    })
}

fn find_terms_anchor(content: &str, terms: &[String]) -> Option<(usize, usize)> {
    terms
        .iter()
        .find_map(|term| find_query_anchor(content, term))
}

fn find_exact_anchor(content: &str, needle: &str) -> Option<(usize, usize)> {
    let byte_offset = content.find(needle)?;
    let char_offset = content[..byte_offset].chars().count();
    Some((char_offset, needle.chars().count()))
}

fn find_ascii_case_insensitive_anchor(content: &str, needle: &str) -> Option<(usize, usize)> {
    if needle.is_empty() || !needle.is_ascii() {
        return None;
    }
    let needle_chars = needle.chars().collect::<Vec<_>>();
    for (char_offset, (byte_offset, _)) in content.char_indices().enumerate() {
        let mut content_chars = content[byte_offset..].chars();
        let mut matched = true;
        for needle_char in &needle_chars {
            match content_chars.next() {
                Some(content_char) if content_char.eq_ignore_ascii_case(needle_char) => {}
                _ => {
                    matched = false;
                    break;
                }
            }
        }
        if matched {
            return Some((char_offset, needle_chars.len()));
        }
    }
    None
}

fn build_excerpt(content: &str, start_char: usize, matched_len: usize) -> Option<String> {
    let total_chars = content.chars().count();
    if total_chars == 0 {
        return None;
    }
    let window_start = start_char.saturating_sub(LIGHT_PREVIEW_CONTEXT_CHARS);
    let window_end = (start_char + matched_len + LIGHT_PREVIEW_CONTEXT_CHARS).min(total_chars);
    let excerpt = content
        .chars()
        .skip(window_start)
        .take(window_end.saturating_sub(window_start))
        .take(LIGHT_PREVIEW_MAX_CHARS)
        .collect::<String>();
    (!excerpt.is_empty()).then_some(excerpt)
}

fn join_fts_terms(terms: &[String], separator: &str) -> String {
    terms
        .iter()
        .map(|term| format!("\"{}\"", term.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(separator)
}

fn cjk_bigrams(term: &str) -> Vec<String> {
    let chars = term.chars().collect::<Vec<_>>();
    chars
        .windows(2)
        .map(|window| window.iter().collect::<String>())
        .collect()
}

fn contains_cjk(value: &str) -> bool {
    value.chars().any(
        |ch| matches!(ch as u32, 0x3040..=0x30ff | 0x3400..=0x4dbf | 0x4e00..=0x9fff | 0xf900..=0xfaff),
    )
}

fn candidate_limit(top_k: i64) -> i64 {
    (top_k.saturating_mul(i64::from(SEARCH_CANDIDATE_MULTIPLIER))).clamp(1, 100)
}

pub(crate) fn path_match_score(first_match_position: i64, path_length: i64) -> f32 {
    ((first_match_position - 1) * 10_000 + path_length) as f32
}

fn node_kind_from_db(value: &str) -> Result<NodeKind, rusqlite::Error> {
    match value {
        "file" => Ok(NodeKind::File),
        "source" => Ok(NodeKind::Source),
        _ => Err(rusqlite::Error::InvalidColumnType(
            1,
            "kind".to_string(),
            rusqlite::types::Type::Text,
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        build_excerpt, build_search_query_plan, find_ascii_case_insensitive_anchor, find_fts_anchor,
    };

    #[test]
    fn ascii_query_plan_deduplicates_exact_and_recall_fts() {
        let plan =
            build_search_query_plan("shared-bench-search").expect("ascii query plan should exist");
        assert!(plan.exact_fts.is_some());
        assert!(plan.recall_fts.is_none());
    }

    #[test]
    fn cjk_query_plan_keeps_recall_fts() {
        let plan = build_search_query_plan("検索改善").expect("cjk query plan should exist");
        assert!(plan.exact_fts.is_some());
        assert!(plan.recall_fts.is_some());
    }

    #[test]
    fn ascii_anchor_supports_case_insensitive_preview() {
        let anchor = find_ascii_case_insensitive_anchor("prefix AlphaBeta suffix", "alphabeta")
            .expect("ascii preview anchor should exist");
        assert_eq!(anchor.0, 7);
        assert_eq!(anchor.1, 9);
    }

    #[test]
    fn excerpt_stays_bounded() {
        let excerpt = build_excerpt(&"x".repeat(500), 120, 5).expect("excerpt should exist");
        assert!(excerpt.chars().count() <= 96);
    }

    #[test]
    fn fts_anchor_falls_back_to_terms() {
        let plan = build_search_query_plan("alpha beta").expect("plan should exist");
        let anchor =
            find_fts_anchor("prefix beta suffix", &plan).expect("term anchor should exist");
        assert_eq!(anchor.0, 7);
    }
}
