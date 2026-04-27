// Where: crates/vfs_store/src/fs_helpers.rs
// What: Shared FS-first helpers for path validation, row loading, etags, and sync cursors.
// Why: FsStore behavior must stay deterministic across CRUD, list, search, and sync flows.
use std::collections::BTreeMap;

use rusqlite::{Connection, OptionalExtension, params};
use vfs_types::{Node, NodeEntry, NodeEntryKind, NodeKind, NodeMutationAck};

use crate::hashing::sha256_hex;

pub(crate) fn normalize_node_path(path: &str, allow_root: bool) -> Result<String, String> {
    if path.is_empty() {
        return Err("path must not be empty".to_string());
    }
    if !path.starts_with('/') {
        return Err(format!("path must start with '/': {path}"));
    }
    if path.contains("//") {
        return Err(format!("path must not contain '//': {path}"));
    }
    if path.len() > 1 && path.ends_with('/') {
        return Err(format!("path must not end with '/': {path}"));
    }
    if path == "/" {
        return if allow_root {
            Ok("/".to_string())
        } else {
            Err("root path is not allowed".to_string())
        };
    }
    for segment in path.split('/').skip(1) {
        if segment.is_empty() || segment == "." || segment == ".." {
            return Err(format!("path contains invalid segment: {path}"));
        }
    }
    Ok(path.to_string())
}

pub(crate) fn compute_node_etag(node: &Node) -> String {
    let payload = format!(
        "{}\n{}\n{}\n{}",
        node.path,
        node_kind_tag(&node.kind),
        node.content,
        node.metadata_json,
    );
    format!("v4h:{}", sha256_hex(&payload))
}

pub(crate) fn node_ack(node: &Node) -> NodeMutationAck {
    NodeMutationAck {
        path: node.path.clone(),
        kind: node.kind.clone(),
        updated_at: node.updated_at,
        etag: node.etag.clone(),
    }
}

pub(crate) struct StoredNode {
    pub(crate) row_id: i64,
    pub(crate) node: Node,
}

#[derive(Clone)]
pub(crate) struct ScopedEntryRow {
    pub(crate) path: String,
    pub(crate) kind: NodeKind,
    pub(crate) updated_at: i64,
    pub(crate) etag: String,
}

#[derive(Clone, Copy, Default)]
struct DirectoryStats {
    updated_at: i64,
}

fn node_kind_tag(kind: &NodeKind) -> &'static str {
    match kind {
        NodeKind::File => "file",
        NodeKind::Source => "source",
    }
}

pub(crate) fn load_node(conn: &Connection, path: &str) -> Result<Option<Node>, String> {
    Ok(load_stored_node(conn, path)?.map(|stored| stored.node))
}

pub(crate) fn load_stored_node(
    conn: &Connection,
    path: &str,
) -> Result<Option<StoredNode>, String> {
    conn.query_row(
        "SELECT id, path, kind, content, created_at, updated_at, etag, metadata_json
         FROM fs_nodes WHERE path = ?1",
        params![path],
        map_stored_node,
    )
    .optional()
    .map_err(|error| error.to_string())
}

pub(crate) fn load_scoped_entry_rows(
    conn: &Connection,
    prefix: &str,
) -> Result<Vec<ScopedEntryRow>, String> {
    let mut sql = String::from(
        "SELECT path, kind, updated_at, etag
         FROM fs_nodes WHERE 1 = 1",
    );
    let mut values = Vec::new();
    if prefix != "/" {
        let (scope_sql, scope_values) = prefix_filter_sql(prefix, values.len() + 1);
        sql.push_str(&scope_sql);
        values.extend(scope_values);
    }
    sql.push_str(" ORDER BY path ASC");
    let mut stmt = conn.prepare(&sql).map_err(|error| error.to_string())?;
    stmt.query_map(
        rusqlite::params_from_iter(values.iter()),
        map_scoped_entry_row,
    )
    .map_err(|error| error.to_string())?
    .collect::<Result<Vec<_>, _>>()
    .map_err(|error| error.to_string())
}

pub(crate) fn build_entries_from_rows(
    rows: &[ScopedEntryRow],
    prefix: &str,
    recursive: bool,
) -> Vec<NodeEntry> {
    let directory_stats = directory_stats_by_path(rows, prefix);
    if recursive {
        return rows
            .iter()
            .map(|row| NodeEntry {
                path: row.path.clone(),
                kind: entry_kind_from_node_kind(&row.kind),
                updated_at: row.updated_at,
                etag: row.etag.clone(),
                has_children: directory_stats.contains_key(&row.path),
            })
            .collect();
    }

    let mut entries = BTreeMap::new();
    for row in rows {
        if let Some(child_path) = direct_child_path(prefix, &row.path) {
            entries
                .entry(child_path.clone())
                .and_modify(|entry: &mut NodeEntry| {
                    if child_path == row.path {
                        entry.kind = entry_kind_from_node_kind(&row.kind);
                        entry.updated_at = row.updated_at;
                        entry.etag = row.etag.clone();
                    } else if entry.kind == NodeEntryKind::Directory {
                        entry.updated_at = directory_stats
                            .get(&child_path)
                            .map(|stats| stats.updated_at)
                            .unwrap_or(entry.updated_at);
                    }
                    entry.has_children = directory_stats.contains_key(&child_path);
                })
                .or_insert_with(|| match child_path == row.path {
                    true => NodeEntry {
                        path: row.path.clone(),
                        kind: entry_kind_from_node_kind(&row.kind),
                        updated_at: row.updated_at,
                        etag: row.etag.clone(),
                        has_children: directory_stats.contains_key(&row.path),
                    },
                    false => NodeEntry {
                        path: child_path.clone(),
                        kind: NodeEntryKind::Directory,
                        updated_at: directory_stats
                            .get(&child_path)
                            .map(|stats| stats.updated_at)
                            .unwrap_or(0),
                        etag: String::new(),
                        has_children: true,
                    },
                });
        }
    }

    entries.into_values().collect()
}

pub(crate) fn build_glob_entries_from_rows(
    rows: &[ScopedEntryRow],
    prefix: &str,
) -> Vec<NodeEntry> {
    let directory_stats = directory_stats_by_path(rows, prefix);
    let mut entries = BTreeMap::new();
    for row in rows {
        entries.insert(
            row.path.clone(),
            NodeEntry {
                path: row.path.clone(),
                kind: entry_kind_from_node_kind(&row.kind),
                updated_at: row.updated_at,
                etag: row.etag.clone(),
                has_children: directory_stats.contains_key(&row.path),
            },
        );
        for directory_path in ancestor_directory_paths(prefix, &row.path) {
            entries
                .entry(directory_path.clone())
                .or_insert_with(|| NodeEntry {
                    path: directory_path.clone(),
                    kind: NodeEntryKind::Directory,
                    updated_at: directory_stats
                        .get(&directory_path)
                        .map(|stats| stats.updated_at)
                        .unwrap_or(0),
                    etag: String::new(),
                    has_children: true,
                });
        }
    }
    entries.into_values().collect()
}

pub(crate) fn snapshot_revision_token(prefix: &str, revision: i64) -> String {
    let prefix_hex = hex_encode(prefix.as_bytes());
    format!("v5:{revision}:{prefix_hex}")
}

pub(crate) fn relative_to_prefix(prefix: &str, path: &str) -> Option<String> {
    if prefix == "/" {
        return path.strip_prefix('/').map(str::to_string);
    }
    if path == prefix {
        return path.rsplit('/').next().map(str::to_string);
    }
    path.strip_prefix(&format!("{prefix}/")).map(str::to_string)
}

pub(crate) fn file_search_title(path: &str) -> String {
    let basename = path.rsplit('/').next().unwrap_or(path);
    match basename.rsplit_once('.') {
        Some((stem, extension)) if !stem.is_empty() && !extension.is_empty() => stem.to_string(),
        _ => basename.to_string(),
    }
}

pub(crate) fn prefix_filter_sql(
    prefix: &str,
    start_index: usize,
) -> (String, Vec<rusqlite::types::Value>) {
    prefix_filter_sql_for_column("path", prefix, start_index)
}

pub(crate) fn prefix_filter_sql_for_column(
    column_name: &str,
    prefix: &str,
    start_index: usize,
) -> (String, Vec<rusqlite::types::Value>) {
    let equal_index = start_index;
    let like_index = start_index + 1;
    (
        format!(
            " AND ({column_name} = ?{equal_index} OR {column_name} LIKE ?{like_index} ESCAPE '\\')"
        ),
        vec![
            rusqlite::types::Value::from(prefix.to_string()),
            rusqlite::types::Value::from(format!("{}/%", escape_like_pattern(prefix))),
        ],
    )
}

pub(crate) fn escape_like_pattern(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for ch in value.chars() {
        if matches!(ch, '\\' | '%' | '_') {
            escaped.push('\\');
        }
        escaped.push(ch);
    }
    escaped
}

pub(crate) fn node_kind_to_db(kind: &NodeKind) -> &'static str {
    match kind {
        NodeKind::File => "file",
        NodeKind::Source => "source",
    }
}

pub(crate) fn node_kind_from_db(value: &str) -> Result<NodeKind, rusqlite::Error> {
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

fn map_stored_node(row: &rusqlite::Row<'_>) -> rusqlite::Result<StoredNode> {
    Ok(StoredNode {
        row_id: row.get(0)?,
        node: Node {
            path: row.get(1)?,
            kind: node_kind_from_db(&row.get::<_, String>(2)?)?,
            content: row.get(3)?,
            created_at: row.get(4)?,
            updated_at: row.get(5)?,
            etag: row.get(6)?,
            metadata_json: row.get(7)?,
        },
    })
}

fn map_scoped_entry_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ScopedEntryRow> {
    Ok(ScopedEntryRow {
        path: row.get(0)?,
        kind: node_kind_from_db(&row.get::<_, String>(1)?)?,
        updated_at: row.get(2)?,
        etag: row.get(3)?,
    })
}

fn direct_child_path(prefix: &str, path: &str) -> Option<String> {
    if prefix == "/" {
        let remainder = path.strip_prefix('/')?;
        let child = remainder.split('/').next()?;
        if child.is_empty() {
            return None;
        }
        return Some(format!("/{child}"));
    }
    if !path.starts_with(&format!("{prefix}/")) {
        return None;
    }
    let remainder = &path[prefix.len() + 1..];
    let child = remainder.split('/').next()?;
    if child.is_empty() {
        return None;
    }
    Some(format!("{prefix}/{child}"))
}

fn ancestor_directory_paths(prefix: &str, path: &str) -> Vec<String> {
    let relative = match relative_to_prefix(prefix, path) {
        Some(value) => value,
        None => return Vec::new(),
    };
    let segments = relative.split('/').collect::<Vec<_>>();
    if segments.len() <= 1 {
        return Vec::new();
    }
    let mut directories = Vec::new();
    let mut current = if prefix == "/" {
        String::new()
    } else {
        prefix.to_string()
    };
    for segment in segments.iter().take(segments.len() - 1) {
        if current.is_empty() {
            current = format!("/{segment}");
        } else {
            current = format!("{current}/{segment}");
        }
        directories.push(current.clone());
    }
    directories
}

fn directory_stats_by_path(
    rows: &[ScopedEntryRow],
    prefix: &str,
) -> BTreeMap<String, DirectoryStats> {
    let mut stats_by_path = BTreeMap::new();
    for row in rows {
        for directory_path in ancestor_directory_paths(prefix, &row.path) {
            stats_by_path
                .entry(directory_path)
                .and_modify(|stats: &mut DirectoryStats| {
                    stats.updated_at = stats.updated_at.max(row.updated_at);
                })
                .or_insert(DirectoryStats {
                    updated_at: row.updated_at,
                });
        }
    }
    stats_by_path
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        encoded.push(HEX[(byte >> 4) as usize] as char);
        encoded.push(HEX[(byte & 0x0f) as usize] as char);
    }
    encoded
}

fn entry_kind_from_node_kind(kind: &NodeKind) -> NodeEntryKind {
    match kind {
        NodeKind::File => NodeEntryKind::File,
        NodeKind::Source => NodeEntryKind::Source,
    }
}
