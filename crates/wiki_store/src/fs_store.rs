// Where: crates/wiki_store/src/fs_store.rs
// What: FS-first node store over SQLite for phase-2 persistence and search.
// Why: The new agent-facing model needs file-like CRUD and sync without changing the old wiki store yet.
use std::path::{Path, PathBuf};

use rusqlite::{Connection, Transaction, params};
use wiki_types::{
    AppendNodeRequest, DeleteNodeRequest, DeleteNodeResult, EditNodeRequest, EditNodeResult,
    ExportSnapshotRequest, ExportSnapshotResponse, FetchUpdatesRequest, FetchUpdatesResponse,
    GlobNodeHit, GlobNodeType, GlobNodesRequest, ListNodesRequest, MkdirNodeRequest,
    MkdirNodeResult, MoveNodeRequest, MoveNodeResult, MultiEdit, MultiEditNodeRequest,
    MultiEditNodeResult, Node, NodeEntry, NodeEntryKind, NodeKind, RecentNodeHit,
    RecentNodesRequest, SearchNodeHit, SearchNodePathsRequest, SearchNodesRequest, Status,
    WriteNodeRequest, WriteNodeResult,
};

use crate::{
    fs_helpers::{
        StoredNode, build_entries_from_rows, build_fts_query, build_glob_entries_from_rows,
        compute_node_etag, load_node, load_scoped_entry_rows, load_scoped_nodes, load_stored_node,
        node_ack, node_kind_from_db, node_kind_to_db, normalize_node_path, prefix_filter_sql,
        prefix_filter_sql_for_column, relative_to_prefix, snapshot_revision_token,
    },
    glob_match::{matches_path, validate_pattern},
    schema,
};

const SEARCH_SNIPPET_MAX_CHARS: usize = 240;
const SEARCH_SNIPPET_MAX_BYTES: usize = 512;
const SEARCH_SNIPPET_ELLIPSIS: &str = "...";
// `fs_nodes_fts` is defined as `fts5(content, ...)`, so the searched content column is index 0.
// Keep this in sync with the FTS schema if additional indexed columns are ever added.
const FS_NODES_FTS_CONTENT_COLUMN_INDEX: i32 = 0;
const QUERY_RESULT_LIMIT_MAX: u32 = 100;
const MAX_RETAINED_REVISIONS: i64 = 256;

// Where: crates/wiki_store/src/fs_store.rs
// What: Change-log semantics used by delta sync visibility checks.
// Why: Upserts and physical removals need distinct history meanings.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ChangeKind {
    Upsert,
    PathRemoval,
}

impl ChangeKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Upsert => "upsert",
            Self::PathRemoval => "path_removal",
        }
    }
}

pub struct FsStore {
    database_path: PathBuf,
}

impl FsStore {
    pub fn new(database_path: PathBuf) -> Self {
        Self { database_path }
    }

    pub fn database_path(&self) -> &Path {
        &self.database_path
    }

    pub fn run_fs_migrations(&self) -> Result<(), String> {
        let mut conn = self.open()?;
        schema::run_fs_migrations(&mut conn)
    }

    pub fn status(&self) -> Result<Status, String> {
        let conn = self.open()?;
        Ok(Status {
            file_count: count_nodes(&conn, "file")?,
            source_count: count_nodes(&conn, "source")?,
        })
    }

    pub fn read_node(&self, path: &str) -> Result<Option<Node>, String> {
        let normalized = normalize_node_path(path, false)?;
        let conn = self.open()?;
        load_node(&conn, &normalized)
    }

    pub fn list_nodes(&self, request: ListNodesRequest) -> Result<Vec<NodeEntry>, String> {
        let prefix = normalize_node_path(&request.prefix, true)?;
        let conn = self.open()?;
        let rows = load_scoped_entry_rows(&conn, &prefix)?;
        Ok(build_entries_from_rows(&rows, &prefix, request.recursive))
    }

    pub fn write_node(
        &self,
        request: WriteNodeRequest,
        now: i64,
    ) -> Result<WriteNodeResult, String> {
        let path = normalize_node_path(&request.path, false)?;
        let mut conn = self.open()?;
        let tx = conn.transaction().map_err(|error| error.to_string())?;
        let existing = load_stored_node(&tx, &path)?;
        let created = existing.is_none();
        let mut node = match existing.as_ref() {
            Some(current) => update_existing_node(current.node.clone(), request, now)?,
            None => create_new_node(path, request, now)?,
        };
        record_change(&tx, &node)?;
        node.etag = compute_node_etag(&node);
        let row_id = save_node(&tx, existing.as_ref().map(|stored| stored.row_id), &node)?;
        sync_node_fts(&tx, existing.as_ref(), Some((row_id, &node)))?;
        compact_change_log(&tx)?;
        tx.commit().map_err(|error| error.to_string())?;
        Ok(WriteNodeResult {
            node: node_ack(&node),
            created,
        })
    }

    pub fn append_node(
        &self,
        request: AppendNodeRequest,
        now: i64,
    ) -> Result<WriteNodeResult, String> {
        let path = normalize_node_path(&request.path, false)?;
        let mut conn = self.open()?;
        let tx = conn.transaction().map_err(|error| error.to_string())?;
        let existing = load_stored_node(&tx, &path)?;
        let created = existing.is_none();
        let mut node = match existing.as_ref() {
            Some(current) => append_existing_node(current.node.clone(), request, now)?,
            None => create_appended_node(path, request, now)?,
        };
        record_change(&tx, &node)?;
        node.etag = compute_node_etag(&node);
        let row_id = save_node(&tx, existing.as_ref().map(|stored| stored.row_id), &node)?;
        sync_node_fts(&tx, existing.as_ref(), Some((row_id, &node)))?;
        compact_change_log(&tx)?;
        tx.commit().map_err(|error| error.to_string())?;
        Ok(WriteNodeResult {
            node: node_ack(&node),
            created,
        })
    }

    pub fn edit_node(&self, request: EditNodeRequest, now: i64) -> Result<EditNodeResult, String> {
        if request.old_text.is_empty() {
            return Err("old_text must not be empty".to_string());
        }
        let path = normalize_node_path(&request.path, false)?;
        let mut conn = self.open()?;
        let tx = conn.transaction().map_err(|error| error.to_string())?;
        let current =
            load_stored_node(&tx, &path)?.ok_or_else(|| format!("node does not exist: {path}"))?;
        if current.node.etag != request.expected_etag.unwrap_or_default() {
            return Err(format!("expected_etag does not match current etag: {path}"));
        }
        let (content, replacement_count) = replace_text(
            &current.node.content,
            &request.old_text,
            &request.new_text,
            request.replace_all,
        )?;
        let mut node = current.node.clone();
        node.content = content;
        node.updated_at = now;
        record_change(&tx, &node)?;
        node.etag = compute_node_etag(&node);
        save_node(&tx, Some(current.row_id), &node)?;
        sync_node_fts(&tx, Some(&current), Some((current.row_id, &node)))?;
        compact_change_log(&tx)?;
        tx.commit().map_err(|error| error.to_string())?;
        Ok(EditNodeResult {
            node: node_ack(&node),
            replacement_count,
        })
    }

    pub fn mkdir_node(&self, request: MkdirNodeRequest) -> Result<MkdirNodeResult, String> {
        let path = normalize_node_path(&request.path, false)?;
        Ok(MkdirNodeResult {
            path,
            created: true,
        })
    }

    pub fn move_node(&self, request: MoveNodeRequest, now: i64) -> Result<MoveNodeResult, String> {
        let from_path = normalize_node_path(&request.from_path, false)?;
        let to_path = normalize_node_path(&request.to_path, false)?;
        if from_path == to_path {
            return Err("from_path and to_path must differ".to_string());
        }
        let mut conn = self.open()?;
        let tx = conn.transaction().map_err(|error| error.to_string())?;
        let current = load_stored_node(&tx, &from_path)?
            .ok_or_else(|| format!("node does not exist: {from_path}"))?;
        if current.node.etag != request.expected_etag.unwrap_or_default() {
            return Err(format!(
                "expected_etag does not match current etag: {from_path}"
            ));
        }
        let target = load_stored_node(&tx, &to_path)?;
        let overwrote = target.is_some();
        if overwrote && !request.overwrite {
            return Err(format!("target node already exists: {to_path}"));
        }
        if let Some(target) = target.as_ref() {
            delete_node_row(&tx, target)?;
        }
        let mut moved = current.node.clone();
        moved.path = to_path.clone();
        moved.updated_at = now;
        record_path_removal(&tx, &from_path)?;
        record_change(&tx, &moved)?;
        moved.etag = compute_node_etag(&moved);
        save_node(&tx, Some(current.row_id), &moved)?;
        sync_node_fts(&tx, Some(&current), Some((current.row_id, &moved)))?;
        compact_change_log(&tx)?;
        tx.commit().map_err(|error| error.to_string())?;
        Ok(MoveNodeResult {
            node: node_ack(&moved),
            from_path,
            overwrote,
        })
    }

    pub fn glob_nodes(&self, request: GlobNodesRequest) -> Result<Vec<GlobNodeHit>, String> {
        if request.pattern.trim().is_empty() {
            return Err("pattern must not be empty".to_string());
        }
        validate_pattern(&request.pattern)?;
        let prefix = request
            .path
            .as_deref()
            .map(|value| normalize_node_path(value, true))
            .transpose()?
            .unwrap_or_else(|| "/Wiki".to_string());
        let node_type = request.node_type.unwrap_or(GlobNodeType::Any);
        let conn = self.open()?;
        let rows = load_scoped_entry_rows(&conn, &prefix)?;
        let entries = build_glob_entries_from_rows(&rows, &prefix);
        let mut hits = Vec::new();
        for entry in entries {
            if !glob_type_matches(&node_type, &entry.kind) {
                continue;
            }
            let Some(relative) = relative_to_prefix(&prefix, &entry.path) else {
                continue;
            };
            if matches_path(&request.pattern, &relative)? {
                hits.push(GlobNodeHit {
                    path: entry.path,
                    kind: entry.kind,
                    has_children: entry.has_children,
                });
            }
        }
        Ok(hits)
    }

    pub fn recent_nodes(&self, request: RecentNodesRequest) -> Result<Vec<RecentNodeHit>, String> {
        let prefix = request
            .path
            .as_deref()
            .map(|value| normalize_node_path(value, true))
            .transpose()?
            .unwrap_or_else(|| "/Wiki".to_string());
        let conn = self.open()?;
        let mut sql = String::from(
            "SELECT path, kind, updated_at, etag
             FROM fs_nodes WHERE 1 = 1",
        );
        let mut values = Vec::new();
        if prefix != "/" {
            let (scope_sql, scope_values) = prefix_filter_sql(&prefix, values.len() + 1);
            sql.push_str(&scope_sql);
            values.extend(scope_values);
        }
        let limit = capped_query_limit(request.limit);
        sql.push_str(&format!(
            " ORDER BY updated_at DESC, path ASC LIMIT {limit}"
        ));
        let mut stmt = conn.prepare(&sql).map_err(|error| error.to_string())?;
        stmt.query_map(rusqlite::params_from_iter(values.iter()), |row| {
            Ok(RecentNodeHit {
                path: row.get(0)?,
                kind: node_kind_from_db(&row.get::<_, String>(1)?)?,
                updated_at: row.get(2)?,
                etag: row.get(3)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
    }

    pub fn multi_edit_node(
        &self,
        request: MultiEditNodeRequest,
        now: i64,
    ) -> Result<MultiEditNodeResult, String> {
        let path = normalize_node_path(&request.path, false)?;
        if request.edits.is_empty() {
            return Err("edits must not be empty".to_string());
        }
        let mut conn = self.open()?;
        let tx = conn.transaction().map_err(|error| error.to_string())?;
        let current =
            load_stored_node(&tx, &path)?.ok_or_else(|| format!("node does not exist: {path}"))?;
        if current.node.etag != request.expected_etag.unwrap_or_default() {
            return Err(format!("expected_etag does not match current etag: {path}"));
        }
        let (content, replacement_count) = apply_multi_edit(&current.node.content, &request.edits)?;
        let mut node = current.node.clone();
        node.content = content;
        node.updated_at = now;
        record_change(&tx, &node)?;
        node.etag = compute_node_etag(&node);
        save_node(&tx, Some(current.row_id), &node)?;
        sync_node_fts(&tx, Some(&current), Some((current.row_id, &node)))?;
        compact_change_log(&tx)?;
        tx.commit().map_err(|error| error.to_string())?;
        Ok(MultiEditNodeResult {
            node: node_ack(&node),
            replacement_count,
        })
    }

    pub fn delete_node(
        &self,
        request: DeleteNodeRequest,
        _now: i64,
    ) -> Result<DeleteNodeResult, String> {
        let path = normalize_node_path(&request.path, false)?;
        let mut conn = self.open()?;
        let tx = conn.transaction().map_err(|error| error.to_string())?;
        let current =
            load_stored_node(&tx, &path)?.ok_or_else(|| format!("node does not exist: {path}"))?;
        if current.node.etag != request.expected_etag.unwrap_or_default() {
            return Err(format!("expected_etag does not match current etag: {path}"));
        }
        record_path_removal(&tx, &path)?;
        delete_node_row(&tx, &current)?;
        compact_change_log(&tx)?;
        tx.commit().map_err(|error| error.to_string())?;
        Ok(DeleteNodeResult { path })
    }

    pub fn search_nodes(&self, request: SearchNodesRequest) -> Result<Vec<SearchNodeHit>, String> {
        let prefix = request
            .prefix
            .as_ref()
            .map(|value| normalize_node_path(value, true))
            .transpose()?;
        let query = build_fts_query(&request.query_text)
            .ok_or_else(|| "query_text must not be empty".to_string())?;
        let conn = self.open()?;
        let top_k = capped_query_limit(request.top_k);
        let mut sql = format!(
            "SELECT fs_nodes.path, fs_nodes.kind,
                    snippet(fs_nodes_fts, {FS_NODES_FTS_CONTENT_COLUMN_INDEX}, '[', ']', '...', 12) AS snippet,
                    bm25(fs_nodes_fts) AS score
             FROM fs_nodes_fts
             JOIN fs_nodes ON fs_nodes.id = fs_nodes_fts.rowid
             WHERE fs_nodes_fts MATCH ?1",
        );
        let mut values = vec![rusqlite::types::Value::from(query)];
        if let Some(prefix) = prefix {
            let (scope_sql, scope_values) =
                prefix_filter_sql_for_column("fs_nodes.path", &prefix, 2);
            sql.push_str(&scope_sql);
            values.extend(scope_values);
        }
        sql.push_str(&format!(" ORDER BY score ASC, path ASC LIMIT {top_k}"));
        let mut stmt = conn.prepare(&sql).map_err(|error| error.to_string())?;
        stmt.query_map(rusqlite::params_from_iter(values.iter()), |row| {
            let snippet = clamp_search_snippet(row.get(2)?);
            Ok(SearchNodeHit {
                path: row.get(0)?,
                kind: node_kind_from_db(&row.get::<_, String>(1)?)?,
                snippet,
                score: row.get(3)?,
                match_reasons: vec!["fts5_bm25".to_string()],
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
    }

    pub fn search_node_paths(
        &self,
        request: SearchNodePathsRequest,
    ) -> Result<Vec<SearchNodeHit>, String> {
        let prefix = request
            .prefix
            .as_ref()
            .map(|value| normalize_node_path(value, true))
            .transpose()?;
        let terms = split_path_search_terms(&request.query_text)
            .ok_or_else(|| "query_text must not be empty".to_string())?;
        let conn = self.open()?;
        let top_k = capped_query_limit(request.top_k);
        let mut sql = String::from(
            "SELECT path,
                    kind,
                    instr(lower(path), ?1) AS first_match_position,
                    length(path) AS path_length
             FROM fs_nodes
             WHERE 1 = 1",
        );
        let mut values = vec![rusqlite::types::Value::from(terms[0].clone())];
        for term in &terms {
            let index = values.len() + 1;
            sql.push_str(&format!(" AND instr(lower(path), ?{index}) > 0"));
            values.push(rusqlite::types::Value::from(term.clone()));
        }
        if let Some(prefix) = prefix {
            let (scope_sql, scope_values) =
                prefix_filter_sql_for_column("fs_nodes.path", &prefix, values.len() + 1);
            sql.push_str(&scope_sql);
            values.extend(scope_values);
        }
        sql.push_str(&format!(
            " ORDER BY first_match_position ASC, path_length ASC, path ASC LIMIT {top_k}"
        ));
        let mut stmt = conn.prepare(&sql).map_err(|error| error.to_string())?;
        stmt.query_map(rusqlite::params_from_iter(values.iter()), |row| {
            let path = row.get::<_, String>(0)?;
            let first_match_position = row.get::<_, i64>(2)?;
            let path_length = row.get::<_, i64>(3)?;
            Ok(SearchNodeHit {
                path: path.clone(),
                kind: node_kind_from_db(&row.get::<_, String>(1)?)?,
                snippet: path,
                score: path_match_score(first_match_position, path_length),
                match_reasons: vec!["path_substring".to_string()],
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
    }

    pub fn export_snapshot(
        &self,
        request: ExportSnapshotRequest,
    ) -> Result<ExportSnapshotResponse, String> {
        let prefix = request
            .prefix
            .as_deref()
            .map(|value| normalize_node_path(value, true))
            .transpose()?;
        let prefix = prefix.unwrap_or_else(|| "/".to_string());
        let conn = self.open()?;
        let current_change_revision = current_snapshot_revision_number(&conn)?;
        let nodes = load_scoped_nodes(&conn, &prefix)?;
        let revision = scoped_snapshot_revision(&prefix, current_change_revision);
        Ok(ExportSnapshotResponse {
            snapshot_revision: revision,
            nodes,
        })
    }

    pub fn fetch_updates(
        &self,
        request: FetchUpdatesRequest,
    ) -> Result<FetchUpdatesResponse, String> {
        let prefix = request
            .prefix
            .as_deref()
            .map(|value| normalize_node_path(value, true))
            .transpose()?;
        let prefix = prefix.unwrap_or_else(|| "/".to_string());
        let conn = self.open()?;
        let current_change_revision = current_snapshot_revision_number(&conn)?;
        let current_snapshot_revision = scoped_snapshot_revision(&prefix, current_change_revision);
        let known_snapshot = parse_known_snapshot_revision(&request.known_snapshot_revision);
        if let Some(known_snapshot) = known_snapshot.as_ref()
            && known_snapshot.revision == current_change_revision
            && known_snapshot.prefix == prefix
        {
            return Ok(FetchUpdatesResponse {
                snapshot_revision: current_snapshot_revision,
                changed_nodes: Vec::new(),
                removed_paths: Vec::new(),
            });
        }
        let Some(known_snapshot) = known_snapshot else {
            return Ok(FetchUpdatesResponse {
                snapshot_revision: current_snapshot_revision,
                changed_nodes: load_scoped_nodes(&conn, &prefix)?,
                removed_paths: Vec::new(),
            });
        };
        if known_snapshot.prefix != prefix || known_snapshot.revision > current_change_revision {
            return Ok(FetchUpdatesResponse {
                snapshot_revision: current_snapshot_revision,
                changed_nodes: load_scoped_nodes(&conn, &prefix)?,
                removed_paths: Vec::new(),
            });
        }
        if known_snapshot.revision < min_retained_revision(current_change_revision) {
            return Ok(FetchUpdatesResponse {
                snapshot_revision: current_snapshot_revision,
                changed_nodes: load_scoped_nodes(&conn, &prefix)?,
                removed_paths: Vec::new(),
            });
        }
        let mut changed_nodes = Vec::new();
        let mut removed_paths = Vec::new();
        for path in load_changed_paths_since(&conn, known_snapshot.revision, &prefix)? {
            let current_node = load_node(&conn, &path)?;
            match current_node {
                Some(node) => changed_nodes.push(node),
                None => removed_paths.push(path),
            }
        }
        Ok(FetchUpdatesResponse {
            snapshot_revision: current_snapshot_revision,
            changed_nodes,
            removed_paths,
        })
    }

    fn open(&self) -> Result<Connection, String> {
        Connection::open(&self.database_path).map_err(|error| error.to_string())
    }
}

fn record_change(tx: &Transaction<'_>, node: &Node) -> Result<i64, String> {
    tx.execute(
        "INSERT INTO fs_change_log (path, change_kind) VALUES (?1, ?2)",
        params![node.path, ChangeKind::Upsert.as_str()],
    )
    .map_err(|error| error.to_string())?;
    Ok(tx.last_insert_rowid())
}

fn record_path_removal(tx: &Transaction<'_>, path: &str) -> Result<(), String> {
    tx.execute(
        "INSERT INTO fs_change_log (path, change_kind) VALUES (?1, ?2)",
        params![path, ChangeKind::PathRemoval.as_str()],
    )
    .map(|_| ())
    .map_err(|error| error.to_string())
}

fn current_snapshot_revision_number(conn: &Connection) -> Result<i64, String> {
    conn.query_row(
        "SELECT COALESCE(MAX(revision), 0) FROM fs_change_log",
        [],
        |row| row.get::<_, i64>(0),
    )
    .map_err(|error| error.to_string())
}

fn min_retained_revision(current_revision: i64) -> i64 {
    if current_revision <= 0 {
        return 0;
    }
    (current_revision - MAX_RETAINED_REVISIONS + 1).max(0)
}

fn compact_change_log(tx: &Transaction<'_>) -> Result<(), String> {
    let current_revision = current_snapshot_revision_number(tx)?;
    let retained_revision = min_retained_revision(current_revision);
    tx.execute(
        "DELETE FROM fs_change_log WHERE revision < ?1",
        params![retained_revision],
    )
    .map(|_| ())
    .map_err(|error| error.to_string())
}

#[derive(Debug, PartialEq, Eq)]
struct KnownSnapshotRevision {
    revision: i64,
    prefix: String,
}

fn scoped_snapshot_revision(prefix: &str, revision: i64) -> String {
    snapshot_revision_token(prefix, revision)
}

fn parse_known_snapshot_revision(snapshot_revision: &str) -> Option<KnownSnapshotRevision> {
    let mut parts = snapshot_revision.split(':');
    let version = parts.next()?;
    let parsed = parts.next()?.parse::<i64>().ok()?;
    let prefix = decode_hex_to_string(parts.next()?)?;
    if version != "v5" || parsed < 0 || parts.next().is_some() {
        return None;
    }
    Some(KnownSnapshotRevision {
        revision: parsed,
        prefix,
    })
}

fn capped_query_limit(requested: u32) -> i64 {
    i64::from(requested.clamp(1, QUERY_RESULT_LIMIT_MAX))
}

fn load_changed_paths_since(
    conn: &Connection,
    known_revision: i64,
    prefix: &str,
) -> Result<Vec<String>, String> {
    let mut sql = String::from(
        "SELECT DISTINCT path
         FROM fs_change_log
         WHERE revision > ?1",
    );
    let mut values = vec![rusqlite::types::Value::from(known_revision)];
    if prefix != "/" {
        let (scope_sql, scope_values) = prefix_filter_sql(prefix, 2);
        sql.push_str(&scope_sql);
        values.extend(scope_values);
    }
    sql.push_str(" ORDER BY path ASC");
    let mut stmt = conn.prepare(&sql).map_err(|error| error.to_string())?;
    stmt.query_map(rusqlite::params_from_iter(values.iter()), |row| row.get(0))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

fn decode_hex_to_string(value: &str) -> Option<String> {
    if !value.len().is_multiple_of(2) {
        return None;
    }
    let mut bytes = Vec::with_capacity(value.len() / 2);
    let mut index = 0;
    while index < value.len() {
        let byte = u8::from_str_radix(&value[index..index + 2], 16).ok()?;
        bytes.push(byte);
        index += 2;
    }
    String::from_utf8(bytes).ok()
}

fn count_nodes(conn: &Connection, kind: &str) -> Result<u64, String> {
    conn.query_row(
        "SELECT COUNT(*) FROM fs_nodes WHERE kind = ?1",
        params![kind],
        |row| row.get::<_, u64>(0),
    )
    .map_err(|error| error.to_string())
}

fn create_new_node(path: String, request: WriteNodeRequest, now: i64) -> Result<Node, String> {
    if request.expected_etag.is_some() {
        return Err(format!("expected_etag must be None for new node: {path}"));
    }
    Ok(Node {
        path,
        kind: request.kind,
        content: request.content,
        created_at: now,
        updated_at: now,
        etag: String::new(),
        metadata_json: request.metadata_json,
    })
}

fn create_appended_node(
    path: String,
    request: AppendNodeRequest,
    now: i64,
) -> Result<Node, String> {
    if request.expected_etag.is_some() {
        return Err(format!("expected_etag must be None for new node: {path}"));
    }
    Ok(Node {
        path,
        kind: request.kind.unwrap_or(NodeKind::File),
        content: request.content,
        created_at: now,
        updated_at: now,
        etag: String::new(),
        metadata_json: request.metadata_json.unwrap_or_else(|| "{}".to_string()),
    })
}

fn append_existing_node(
    mut current: Node,
    request: AppendNodeRequest,
    now: i64,
) -> Result<Node, String> {
    if current.etag != request.expected_etag.unwrap_or_default() {
        return Err(format!(
            "expected_etag does not match current etag: {}",
            current.path
        ));
    }
    let separator = request.separator.unwrap_or_default();
    current.content = format!("{}{}{}", current.content, separator, request.content);
    current.updated_at = now;
    Ok(current)
}

fn replace_text(
    content: &str,
    old_text: &str,
    new_text: &str,
    replace_all: bool,
) -> Result<(String, u32), String> {
    let matches = content.matches(old_text).count();
    if matches == 0 {
        return Err("old_text did not match any content".to_string());
    }
    if !replace_all && matches > 1 {
        return Err("old_text matched multiple locations; set replace_all=true".to_string());
    }
    let updated = if replace_all {
        content.replace(old_text, new_text)
    } else {
        content.replacen(old_text, new_text, 1)
    };
    Ok((updated, matches.min(u32::MAX as usize) as u32))
}

fn replace_text_all_or_error(
    content: &str,
    old_text: &str,
    new_text: &str,
) -> Result<(String, u32), String> {
    if old_text.is_empty() {
        return Err("old_text must not be empty".to_string());
    }
    replace_text(content, old_text, new_text, true)
}

fn apply_multi_edit(content: &str, edits: &[MultiEdit]) -> Result<(String, u32), String> {
    let mut updated = content.to_string();
    let mut replacement_count = 0u32;
    for edit in edits {
        let (next, count) = replace_text_all_or_error(&updated, &edit.old_text, &edit.new_text)?;
        updated = next;
        replacement_count = replacement_count.saturating_add(count);
    }
    Ok((updated, replacement_count))
}

fn update_existing_node(
    mut current: Node,
    request: WriteNodeRequest,
    now: i64,
) -> Result<Node, String> {
    if current.etag != request.expected_etag.unwrap_or_default() {
        return Err(format!(
            "expected_etag does not match current etag: {}",
            current.path
        ));
    }
    current.kind = request.kind;
    current.content = request.content;
    current.updated_at = now;
    current.metadata_json = request.metadata_json;
    Ok(current)
}

fn save_node(tx: &Transaction<'_>, row_id: Option<i64>, node: &Node) -> Result<i64, String> {
    match row_id {
        Some(row_id) => {
            tx.execute(
                "UPDATE fs_nodes
                 SET path = ?1,
                     kind = ?2,
                     content = ?3,
                     created_at = ?4,
                     updated_at = ?5,
                     etag = ?6,
                     metadata_json = ?7
                 WHERE id = ?8",
                params![
                    node.path,
                    node_kind_to_db(&node.kind),
                    node.content,
                    node.created_at,
                    node.updated_at,
                    node.etag,
                    node.metadata_json,
                    row_id
                ],
            )
            .map_err(|error| error.to_string())?;
            Ok(row_id)
        }
        None => {
            tx.execute(
                "INSERT INTO fs_nodes (path, kind, content, created_at, updated_at, etag, metadata_json)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    node.path,
                    node_kind_to_db(&node.kind),
                    node.content,
                    node.created_at,
                    node.updated_at,
                    node.etag,
                    node.metadata_json
                ],
            )
            .map_err(|error| error.to_string())?;
            Ok(tx.last_insert_rowid())
        }
    }
}

// `snippet()` output can vary with token and marker placement, but the transport contract is fixed:
// always return valid UTF-8 bounded by bytes first, with chars as a secondary UI-friendly limit.
fn clamp_search_snippet(snippet: String) -> String {
    let mut out = if snippet.chars().count() > SEARCH_SNIPPET_MAX_CHARS {
        let mut shortened = snippet
            .chars()
            .take(SEARCH_SNIPPET_MAX_CHARS)
            .collect::<String>();
        shortened.push_str(SEARCH_SNIPPET_ELLIPSIS);
        shortened
    } else {
        snippet
    };

    if out.len() <= SEARCH_SNIPPET_MAX_BYTES {
        return out;
    }

    while out.len() + SEARCH_SNIPPET_ELLIPSIS.len() > SEARCH_SNIPPET_MAX_BYTES {
        if out.pop().is_none() {
            break;
        }
    }
    out.push_str(SEARCH_SNIPPET_ELLIPSIS);
    out
}

#[cfg(not(feature = "bench-disable-fts"))]
fn sync_node_fts(
    tx: &Transaction<'_>,
    old: Option<&StoredNode>,
    new: Option<(i64, &Node)>,
) -> Result<(), String> {
    let unchanged = match (old, new) {
        (Some(stored), Some((row_id, node))) => {
            stored.row_id == row_id && stored.node.content == node.content
        }
        _ => false,
    };

    if unchanged {
        return Ok(());
    }

    if let Some(stored) = old {
        tx.execute(
            "INSERT INTO fs_nodes_fts(fs_nodes_fts, rowid, content) VALUES('delete', ?1, ?2)",
            params![stored.row_id, stored.node.content],
        )
        .map_err(|error| error.to_string())?;
    }
    if let Some((row_id, node)) = new {
        tx.execute(
            "INSERT INTO fs_nodes_fts(rowid, content) VALUES(?1, ?2)",
            params![row_id, node.content],
        )
        .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(feature = "bench-disable-fts")]
fn sync_node_fts(
    _tx: &Transaction<'_>,
    _old: Option<&StoredNode>,
    _new: Option<(i64, &Node)>,
) -> Result<(), String> {
    Ok(())
}

fn delete_node_row(tx: &Transaction<'_>, stored: &StoredNode) -> Result<(), String> {
    sync_node_fts(tx, Some(stored), None)?;
    tx.execute("DELETE FROM fs_nodes WHERE id = ?1", params![stored.row_id])
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn split_search_terms(query_text: &str) -> Option<Vec<String>> {
    let terms = query_text
        .split_whitespace()
        .map(str::trim)
        .filter(|term| !term.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();
    if terms.is_empty() { None } else { Some(terms) }
}

fn split_path_search_terms(query_text: &str) -> Option<Vec<String>> {
    split_search_terms(query_text)
        .map(|terms| terms.into_iter().map(|term| term.to_lowercase()).collect())
}

fn path_match_score(first_match_position: i64, path_length: i64) -> f32 {
    ((first_match_position - 1) * 10_000 + path_length) as f32
}

fn glob_type_matches(node_type: &GlobNodeType, entry_kind: &NodeEntryKind) -> bool {
    match node_type {
        GlobNodeType::Any => true,
        GlobNodeType::File => {
            matches!(entry_kind, NodeEntryKind::File | NodeEntryKind::Source)
        }
        GlobNodeType::Directory => *entry_kind == NodeEntryKind::Directory,
    }
}
