// Where: crates/vfs_store/src/fs_links.rs
// What: Markdown link extraction and SQLite backlink index helpers.
// Why: Backlinks should be cheap to query, so writes maintain a small edge table.
use std::collections::{BTreeSet, VecDeque};

use crate::sqlite::{Connection, Transaction, params};
use vfs_types::{LinkEdge, Node};

use crate::fs_helpers::{normalize_node_path, prefix_filter_sql_for_column};

pub(crate) fn sync_node_links(tx: &Transaction<'_>, node: &Node) -> Result<(), String> {
    delete_source_links(tx, &node.path)?;
    for edge in extract_link_edges(&node.path, &node.content, node.updated_at) {
        tx.execute(
            "INSERT OR REPLACE INTO fs_links
             (source_path, target_path, raw_href, link_text, link_kind, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                edge.source_path,
                edge.target_path,
                edge.raw_href,
                edge.link_text,
                edge.link_kind,
                edge.updated_at
            ],
        )
        .map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub(crate) fn backfill_node_links(tx: &Transaction<'_>) -> Result<(), String> {
    let mut stmt = tx
        .prepare("SELECT path, content, updated_at FROM fs_nodes ORDER BY path ASC")
        .map_err(|error| error.to_string())?;
    let rows = crate::sqlite::query_map(&mut stmt, params![], |row| {
        Ok((
            crate::sqlite::row_get::<String>(row, 0)?,
            crate::sqlite::row_get::<String>(row, 1)?,
            crate::sqlite::row_get::<i64>(row, 2)?,
        ))
    })
    .map_err(|error| error.to_string())?;
    for (source_path, content, updated_at) in rows {
        for edge in extract_link_edges(&source_path, &content, updated_at) {
            tx.execute(
                "INSERT OR REPLACE INTO fs_links
                 (source_path, target_path, raw_href, link_text, link_kind, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    edge.source_path,
                    edge.target_path,
                    edge.raw_href,
                    edge.link_text,
                    edge.link_kind,
                    edge.updated_at
                ],
            )
            .map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

pub(crate) fn delete_source_links(tx: &Transaction<'_>, source_path: &str) -> Result<(), String> {
    tx.execute(
        "DELETE FROM fs_links WHERE source_path = ?1",
        params![source_path],
    )
    .map(|_| ())
    .map_err(|error| error.to_string())
}

pub(crate) fn load_incoming_links(
    conn: &Connection,
    target_path: &str,
    limit: i64,
) -> Result<Vec<LinkEdge>, String> {
    load_links(
        conn,
        "SELECT source_path, target_path, raw_href, link_text, link_kind, updated_at
         FROM fs_links
         WHERE target_path = ?1
         ORDER BY source_path ASC, raw_href ASC
         LIMIT ?2",
        params![target_path, limit],
    )
}

pub(crate) fn load_outgoing_links(
    conn: &Connection,
    source_path: &str,
    limit: i64,
) -> Result<Vec<LinkEdge>, String> {
    load_links(
        conn,
        "SELECT source_path, target_path, raw_href, link_text, link_kind, updated_at
         FROM fs_links
         WHERE source_path = ?1
         ORDER BY target_path ASC, raw_href ASC
         LIMIT ?2",
        params![source_path, limit],
    )
}

pub(crate) fn load_graph_links(
    conn: &Connection,
    prefix: &str,
    limit: i64,
) -> Result<Vec<LinkEdge>, String> {
    let mut sql = String::from(
        "SELECT source_path, target_path, raw_href, link_text, link_kind, updated_at
         FROM fs_links WHERE 1 = 1",
    );
    let mut values = Vec::new();
    if prefix != "/" {
        let (scope_sql, scope_values) =
            prefix_filter_sql_for_column("source_path", prefix, values.len() + 1);
        sql.push_str(&scope_sql);
        values.extend(scope_values);
    }
    sql.push_str(" ORDER BY source_path ASC, target_path ASC, raw_href ASC LIMIT ?");
    values.push(crate::sqlite::types::Value::from(limit));
    let mut stmt = conn.prepare(&sql).map_err(|error| error.to_string())?;
    crate::sqlite::query_map(
        &mut stmt,
        crate::sqlite::params_from_values(&values),
        edge_from_row,
    )
    .map_err(|error| error.to_string())
}

pub(crate) fn load_graph_neighborhood(
    conn: &Connection,
    center_path: &str,
    depth: u32,
    limit: i64,
) -> Result<Vec<LinkEdge>, String> {
    if !(1..=2).contains(&depth) {
        return Err("depth must be 1 or 2".to_string());
    }
    let mut seen_edges = BTreeSet::new();
    let mut seen_nodes = BTreeSet::from([center_path.to_string()]);
    let mut frontier = VecDeque::from([(center_path.to_string(), 0_u32)]);
    let mut edges = Vec::new();
    while let Some((path, distance)) = frontier.pop_front() {
        if edges.len() >= limit as usize {
            break;
        }
        let adjacent = load_adjacent_links(conn, &path, limit)?;
        for edge in adjacent {
            let edge_key = (
                edge.source_path.clone(),
                edge.target_path.clone(),
                edge.raw_href.clone(),
            );
            if seen_edges.insert(edge_key) {
                if distance + 1 < depth {
                    for next_path in [&edge.source_path, &edge.target_path] {
                        if seen_nodes.insert(next_path.clone()) {
                            frontier.push_back((next_path.clone(), distance + 1));
                        }
                    }
                }
                edges.push(edge);
                if edges.len() >= limit as usize {
                    break;
                }
            }
        }
    }
    Ok(edges)
}

fn load_adjacent_links(conn: &Connection, path: &str, limit: i64) -> Result<Vec<LinkEdge>, String> {
    load_links(
        conn,
        "SELECT source_path, target_path, raw_href, link_text, link_kind, updated_at
         FROM fs_links
         WHERE source_path = ?1 OR target_path = ?1
         ORDER BY source_path ASC, target_path ASC, raw_href ASC
         LIMIT ?2",
        params![path, limit],
    )
}

fn load_links<P>(conn: &Connection, sql: &str, params: P) -> Result<Vec<LinkEdge>, String>
where
    P: crate::sqlite::Params,
{
    let mut stmt = conn.prepare(sql).map_err(|error| error.to_string())?;
    crate::sqlite::query_map(&mut stmt, params, edge_from_row).map_err(|error| error.to_string())
}

fn edge_from_row(row: &crate::sqlite::Row<'_>) -> crate::sqlite::Result<LinkEdge> {
    Ok(LinkEdge {
        source_path: crate::sqlite::row_get::<String>(row, 0)?,
        target_path: crate::sqlite::row_get::<String>(row, 1)?,
        raw_href: crate::sqlite::row_get::<String>(row, 2)?,
        link_text: crate::sqlite::row_get::<String>(row, 3)?,
        link_kind: crate::sqlite::row_get::<String>(row, 4)?,
        updated_at: crate::sqlite::row_get::<i64>(row, 5)?,
    })
}

fn extract_link_edges(source_path: &str, content: &str, updated_at: i64) -> Vec<LinkEdge> {
    let mut edges = Vec::new();
    let excluded_ranges = link_excluded_ranges(content);
    extract_markdown_links(
        source_path,
        content,
        updated_at,
        &excluded_ranges,
        &mut edges,
    );
    extract_wikilinks(
        source_path,
        content,
        updated_at,
        &excluded_ranges,
        &mut edges,
    );
    edges
}

fn extract_markdown_links(
    source_path: &str,
    content: &str,
    updated_at: i64,
    excluded_ranges: &[TextRange],
    edges: &mut Vec<LinkEdge>,
) {
    let mut offset = 0;
    while let Some(open) = content[offset..].find('[').map(|index| offset + index) {
        if is_excluded_position(excluded_ranges, open) {
            offset = open + 1;
            continue;
        }
        if open > 0 && content.as_bytes()[open - 1] == b'!' {
            offset = open + 1;
            continue;
        }
        let Some(close) = content[open + 1..].find(']').map(|index| open + 1 + index) else {
            break;
        };
        if !content[close + 1..].starts_with('(') {
            offset = close + 1;
            continue;
        }
        let href_start = close + 2;
        let Some(href_end) = find_markdown_href_end(content, href_start) else {
            break;
        };
        let text = &content[open + 1..close];
        let raw_href = &content[href_start..href_end];
        push_edge(
            source_path,
            raw_href,
            raw_href,
            text,
            "markdown",
            updated_at,
            edges,
        );
        offset = href_end + 1;
    }
}

fn extract_wikilinks(
    source_path: &str,
    content: &str,
    updated_at: i64,
    excluded_ranges: &[TextRange],
    edges: &mut Vec<LinkEdge>,
) {
    let mut offset = 0;
    while let Some(open) = content[offset..].find("[[").map(|index| offset + index) {
        if is_excluded_position(excluded_ranges, open) {
            offset = open + 2;
            continue;
        }
        let href_start = open + 2;
        let Some(close) = content[href_start..]
            .find("]]")
            .map(|index| href_start + index)
        else {
            break;
        };
        let raw_href = &content[href_start..close];
        let (target_href, link_text) = split_wikilink_alias(raw_href);
        push_edge(
            source_path,
            raw_href,
            target_href,
            link_text,
            "wikilink",
            updated_at,
            edges,
        );
        offset = close + 2;
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct TextRange {
    start: usize,
    end: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct MarkdownFence {
    marker: u8,
    length: usize,
}

fn link_excluded_ranges(content: &str) -> Vec<TextRange> {
    let mut ranges = Vec::new();
    let mut offset = 0;
    let mut fence = None;
    for line in content.split_inclusive('\n') {
        let line_start = offset;
        let line_end = offset + line.len();
        let line_body = trim_line_ending(line);
        if let Some(open_fence) = fence {
            ranges.push(TextRange {
                start: line_start,
                end: line_end,
            });
            if is_closing_fence_line(line_body, open_fence) {
                fence = None;
            }
        } else if let Some(open_fence) = parse_opening_fence_line(line_body) {
            ranges.push(TextRange {
                start: line_start,
                end: line_end,
            });
            fence = Some(open_fence);
        } else if is_indented_code_line(line_body) {
            ranges.push(TextRange {
                start: line_start,
                end: line_end,
            });
        } else {
            collect_inline_code_ranges(line_body, line_start, &mut ranges);
        }
        offset = line_end;
    }
    ranges
}

fn trim_line_ending(line: &str) -> &str {
    line.trim_end_matches(['\r', '\n'])
}

fn is_excluded_position(ranges: &[TextRange], position: usize) -> bool {
    ranges
        .iter()
        .any(|range| range.start <= position && position < range.end)
}

fn collect_inline_code_ranges(line: &str, line_start: usize, ranges: &mut Vec<TextRange>) {
    let mut index = 0;
    let bytes = line.as_bytes();
    while index < bytes.len() {
        if bytes[index] == b'`' && let Some(end) = find_inline_code_end(line, index) {
            ranges.push(TextRange {
                start: line_start + index,
                end: line_start + end,
            });
            index = end;
            continue;
        }
        index += 1;
    }
}

fn find_inline_code_end(line: &str, start: usize) -> Option<usize> {
    let run_length = count_backtick_run(line.as_bytes(), start);
    let needle = "`".repeat(run_length);
    line[start + run_length..]
        .find(&needle)
        .map(|index| start + run_length + index + run_length)
}

fn count_backtick_run(bytes: &[u8], start: usize) -> usize {
    let mut index = start;
    while index < bytes.len() && bytes[index] == b'`' {
        index += 1;
    }
    index - start
}

fn parse_opening_fence_line(line: &str) -> Option<MarkdownFence> {
    let bytes = line.as_bytes();
    let spaces = count_leading_spaces(bytes);
    if spaces > 3 {
        return None;
    }
    let marker = *bytes.get(spaces)?;
    if marker != b'`' && marker != b'~' {
        return None;
    }
    let length = count_marker_run(bytes, spaces, marker);
    if length < 3 {
        return None;
    }
    Some(MarkdownFence { marker, length })
}

fn is_closing_fence_line(line: &str, fence: MarkdownFence) -> bool {
    let bytes = line.as_bytes();
    let spaces = count_leading_spaces(bytes);
    if spaces > 3 || bytes.get(spaces) != Some(&fence.marker) {
        return false;
    }
    let length = count_marker_run(bytes, spaces, fence.marker);
    if length < fence.length {
        return false;
    }
    bytes[spaces + length..]
        .iter()
        .all(|byte| *byte == b' ' || *byte == b'\t')
}

fn count_leading_spaces(bytes: &[u8]) -> usize {
    bytes.iter().take_while(|byte| **byte == b' ').count()
}

fn count_marker_run(bytes: &[u8], start: usize, marker: u8) -> usize {
    bytes[start..]
        .iter()
        .take_while(|byte| **byte == marker)
        .count()
}

fn is_indented_code_line(line: &str) -> bool {
    line.starts_with('\t') || line.starts_with("    ")
}

fn push_edge(
    source_path: &str,
    raw_href: &str,
    target_href: &str,
    link_text: &str,
    link_kind: &str,
    updated_at: i64,
    edges: &mut Vec<LinkEdge>,
) {
    let strip_title = link_kind == "markdown";
    let Some(target_path) = resolve_link_target(source_path, target_href, strip_title) else {
        return;
    };
    edges.push(LinkEdge {
        source_path: source_path.to_string(),
        target_path,
        raw_href: raw_href.trim().to_string(),
        link_text: link_text.trim().to_string(),
        link_kind: link_kind.to_string(),
        updated_at,
    });
}

fn split_wikilink_alias(raw_href: &str) -> (&str, &str) {
    let Some((target, alias)) = raw_href.split_once('|') else {
        return (raw_href, raw_href);
    };
    if alias.trim().is_empty() {
        return (target, target);
    }
    (target, alias)
}

fn resolve_link_target(source_path: &str, raw_href: &str, strip_title: bool) -> Option<String> {
    let trimmed = raw_href.trim();
    let link_href = if strip_title {
        strip_markdown_title(trimmed)
    } else {
        trimmed
    };
    if link_href.is_empty() || link_href.starts_with('#') || is_external_href(link_href) {
        return None;
    }
    let path_part = split_href_path(link_href);
    if path_part.is_empty() {
        return None;
    }
    let resolved = if is_internal_wiki_path(path_part) {
        path_part.to_string()
    } else if path_part.starts_with('/') {
        return None;
    } else {
        resolve_relative_path(source_path, path_part)
    };
    normalize_node_path(&resolved, false).ok()
}

fn is_internal_wiki_path(path: &str) -> bool {
    path == "/Wiki"
        || path.starts_with("/Wiki/")
        || path == "/Sources"
        || path.starts_with("/Sources/")
}

fn find_markdown_href_end(content: &str, href_start: usize) -> Option<usize> {
    let bytes = content.as_bytes();
    let mut index = href_start;
    let mut paren_depth = 0_u32;
    while index < bytes.len() {
        if bytes[index] == b')' {
            if paren_depth == 0 {
                return Some(index);
            }
            paren_depth -= 1;
        }
        if bytes[index] == b'(' {
            paren_depth += 1;
        }
        index += 1;
    }
    None
}

fn split_href_path(href: &str) -> &str {
    let query = href.find('?');
    let hash = href.find('#');
    let end = match (query, hash) {
        (Some(query), Some(hash)) => query.min(hash),
        (Some(query), None) => query,
        (None, Some(hash)) => hash,
        (None, None) => href.len(),
    };
    &href[..end]
}

fn strip_markdown_title(href: &str) -> &str {
    strip_quoted_markdown_title(href)
        .or_else(|| strip_parenthesized_markdown_title(href))
        .unwrap_or(href)
}

fn strip_quoted_markdown_title(href: &str) -> Option<&str> {
    let quote = href.chars().last()?;
    if !matches!(quote, '"' | '\'') {
        return None;
    }
    let title_start = href[..href.len() - quote.len_utf8()].rfind(quote)?;
    if title_start == 0 || !href[..title_start].chars().last()?.is_whitespace() {
        return None;
    }
    Some(href[..title_start].trim_end())
}

fn strip_parenthesized_markdown_title(href: &str) -> Option<&str> {
    if !href.ends_with(')') {
        return None;
    }
    let mut depth = 0_u32;
    for (index, ch) in href.char_indices().rev() {
        if ch == ')' {
            depth += 1;
            continue;
        }
        if ch == '(' {
            depth -= 1;
            if depth == 0 {
                if index == 0 || !href[..index].chars().last()?.is_whitespace() {
                    return None;
                }
                return Some(href[..index].trim_end());
            }
        }
    }
    None
}

fn resolve_relative_path(source_path: &str, href: &str) -> String {
    let parent =
        source_path.rsplit_once('/').map_or(
            "/",
            |(parent, _name)| {
                if parent.is_empty() { "/" } else { parent }
            },
        );
    let parts = parent
        .split('/')
        .chain(href.split('/'))
        .filter(|part| !part.is_empty())
        .fold(Vec::new(), |mut parts, part| {
            if part == "." {
                return parts;
            }
            if part == ".." {
                parts.pop();
                return parts;
            }
            parts.push(part);
            parts
        });
    format!("/{}", parts.join("/"))
}

fn is_external_href(href: &str) -> bool {
    href.starts_with("//")
        || href.split_once(':').is_some_and(|(scheme, _)| {
            let mut chars = scheme.chars();
            chars.next().is_some_and(|ch| ch.is_ascii_alphabetic())
                && chars.all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '+' | '.' | '-'))
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn edges_for(content: &str) -> Vec<LinkEdge> {
        extract_link_edges("/Wiki/topic/source.md", content, 10)
    }

    #[test]
    fn markdown_parser_preserves_titles_and_continues_after_parenthesized_title() {
        let edges = edges_for(
            "[Quoted](../alpha.md \"Alpha title\") [Paren](../paren.md (Paren title)) [After](../after.md)",
        );

        assert_eq!(edges.len(), 3);
        assert_eq!(edges[0].target_path, "/Wiki/alpha.md");
        assert_eq!(edges[0].raw_href, "../alpha.md \"Alpha title\"");
        assert_eq!(edges[1].target_path, "/Wiki/paren.md");
        assert_eq!(edges[1].raw_href, "../paren.md (Paren title)");
        assert_eq!(edges[2].target_path, "/Wiki/after.md");
        assert_eq!(edges[2].raw_href, "../after.md");
    }

    #[test]
    fn markdown_parser_keeps_spaces_and_parentheses_in_target_path() {
        let edges = edges_for("[Project](Project (Alpha).md) [Nested](Project (Alpha (Draft)).md)");

        assert_eq!(edges.len(), 2);
        assert_eq!(edges[0].target_path, "/Wiki/topic/Project (Alpha).md");
        assert_eq!(edges[0].raw_href, "Project (Alpha).md");
        assert_eq!(
            edges[1].target_path,
            "/Wiki/topic/Project (Alpha (Draft)).md"
        );
        assert_eq!(edges[1].raw_href, "Project (Alpha (Draft)).md");
    }

    #[test]
    fn markdown_parser_strips_query_hash_and_external_schemes_from_targets() {
        let edges = edges_for(
            "[Query](../gamma.md?view=raw#section \"Gamma\") [Web](web+foo:bar) [Git](git+ssh://example/repo) [Urn](urn:isbn:123) [Anchor](#top)",
        );

        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].target_path, "/Wiki/gamma.md");
        assert_eq!(edges[0].raw_href, "../gamma.md?view=raw#section \"Gamma\"");
    }

    #[test]
    fn wikilink_parser_keeps_spaces_quotes_and_parentheses_in_target_path() {
        let edges = edges_for("[[Project \"Alpha\".md]] [[Project (Alpha).md]]");

        assert_eq!(edges.len(), 2);
        assert_eq!(edges[0].target_path, "/Wiki/topic/Project \"Alpha\".md");
        assert_eq!(edges[0].raw_href, "Project \"Alpha\".md");
        assert_eq!(edges[1].target_path, "/Wiki/topic/Project (Alpha).md");
        assert_eq!(edges[1].raw_href, "Project (Alpha).md");
    }

    #[test]
    fn wikilink_parser_splits_alias_from_target_path() {
        let edges = edges_for(
            "[[/Sources/raw/a/a.md|opencode.ai/DESIGN.md]] [[relative.md|]] [[note.md|A|B]]",
        );

        assert_eq!(edges.len(), 3);
        assert_eq!(edges[0].target_path, "/Sources/raw/a/a.md");
        assert_eq!(
            edges[0].raw_href,
            "/Sources/raw/a/a.md|opencode.ai/DESIGN.md"
        );
        assert_eq!(edges[0].link_text, "opencode.ai/DESIGN.md");
        assert_eq!(edges[1].target_path, "/Wiki/topic/relative.md");
        assert_eq!(edges[1].raw_href, "relative.md|");
        assert_eq!(edges[1].link_text, "relative.md");
        assert_eq!(edges[2].target_path, "/Wiki/topic/note.md");
        assert_eq!(edges[2].raw_href, "note.md|A|B");
        assert_eq!(edges[2].link_text, "A|B");
    }

    #[test]
    fn link_parser_ignores_links_inside_fenced_code_blocks() {
        let edges = edges_for(
            "```md\n[[alpha.md|Alpha]]\n[Alpha](alpha.md)\n``` not close\n[[still-code.md|Still]]\n```\n[[beta.md|Beta]]",
        );

        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].target_path, "/Wiki/topic/beta.md");
        assert_eq!(edges[0].link_text, "Beta");
    }

    #[test]
    fn link_parser_ignores_links_inside_inline_code() {
        let edges = edges_for(
            "`[[alpha.md|Alpha]]` `[Alpha](alpha.md)` [[beta.md|Beta]] [Gamma](gamma.md)",
        );

        assert_eq!(edges.len(), 2);
        assert_eq!(edges[0].target_path, "/Wiki/topic/gamma.md");
        assert_eq!(edges[1].target_path, "/Wiki/topic/beta.md");
    }

    #[test]
    fn link_parser_ignores_links_inside_indented_code_lines() {
        let edges = edges_for("    [[alpha.md|Alpha]]\n\t[Alpha](alpha.md)\n[[beta.md|Beta]]");

        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].target_path, "/Wiki/topic/beta.md");
    }

    #[test]
    fn absolute_internal_link_targets_require_segment_boundary() {
        let edges = edges_for(
            "[Wiki](/Wiki) [Wiki page](/Wiki/a.md) [Sources](/Sources) [Source](/Sources/a.md) [Bad wiki](/Wikipedia/a.md) [Bad source](/SourcesBackup/a.md)",
        );

        assert_eq!(edges.len(), 4);
        assert_eq!(edges[0].target_path, "/Wiki");
        assert_eq!(edges[1].target_path, "/Wiki/a.md");
        assert_eq!(edges[2].target_path, "/Sources");
        assert_eq!(edges[3].target_path, "/Sources/a.md");
    }
}
