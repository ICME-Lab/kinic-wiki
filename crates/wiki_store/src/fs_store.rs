// Where: crates/wiki_store/src/fs_store.rs
// What: FS-first node store over SQLite for phase-2 persistence and search.
// Why: The new agent-facing model needs file-like CRUD and sync without changing the old wiki store yet.
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OptionalExtension, Transaction, params};
use wiki_types::{
    DeleteNodeRequest, DeleteNodeResult, ExportSnapshotRequest, ExportSnapshotResponse,
    FetchUpdatesRequest, FetchUpdatesResponse, ListNodesRequest, Node, NodeEntry, SearchNodeHit,
    SearchNodesRequest, Status, WriteNodeRequest, WriteNodeResult,
};

use crate::{
    fs_helpers::{
        build_entries, build_fts_query, compute_node_etag, load_node, load_scoped_nodes,
        node_kind_from_db, node_kind_to_db, normalize_node_path, prefix_filter_sql,
        snapshot_revision,
    },
    schema,
};

pub struct FsStore {
    database_path: PathBuf,
}

#[derive(Clone, Debug)]
struct SnapshotNodeRow {
    path: String,
    etag: String,
    deleted_at: Option<i64>,
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
            file_count: count_nodes(&conn, "file", false)?,
            source_count: count_nodes(&conn, "source", false)?,
            deleted_count: count_deleted_nodes(&conn)?,
        })
    }

    pub fn read_node(&self, path: &str) -> Result<Option<Node>, String> {
        let normalized = normalize_node_path(path, false)?;
        let conn = self.open()?;
        Ok(load_node(&conn, &normalized)?.filter(|node| node.deleted_at.is_none()))
    }

    pub fn list_nodes(&self, request: ListNodesRequest) -> Result<Vec<NodeEntry>, String> {
        let prefix = normalize_node_path(&request.prefix, true)?;
        let conn = self.open()?;
        let nodes = load_scoped_nodes(&conn, &prefix, request.include_deleted)?;
        Ok(build_entries(&nodes, &prefix, request.recursive))
    }

    pub fn write_node(
        &self,
        request: WriteNodeRequest,
        now: i64,
    ) -> Result<WriteNodeResult, String> {
        let path = normalize_node_path(&request.path, false)?;
        let mut conn = self.open()?;
        let tx = conn.transaction().map_err(|error| error.to_string())?;
        let existing = load_node(&tx, &path)?;
        let created = existing.is_none();
        let mut node = match existing {
            Some(current) => update_existing_node(current, request, now)?,
            None => create_new_node(path, request, now)?,
        };
        node.etag = compute_node_etag(&node);
        upsert_node(&tx, &node)?;
        sync_node_fts(&tx, &node)?;
        tx.commit().map_err(|error| error.to_string())?;
        Ok(WriteNodeResult { node, created })
    }

    pub fn delete_node(
        &self,
        request: DeleteNodeRequest,
        now: i64,
    ) -> Result<DeleteNodeResult, String> {
        let path = normalize_node_path(&request.path, false)?;
        let mut conn = self.open()?;
        let tx = conn.transaction().map_err(|error| error.to_string())?;
        let mut node =
            load_node(&tx, &path)?.ok_or_else(|| format!("node does not exist: {path}"))?;
        if node.deleted_at.is_some() {
            return Err(format!("node is already deleted: {path}"));
        }
        if node.etag != request.expected_etag.unwrap_or_default() {
            return Err(format!("expected_etag does not match current etag: {path}"));
        }
        node.updated_at = now;
        node.deleted_at = Some(now);
        node.etag = compute_node_etag(&node);
        upsert_node(&tx, &node)?;
        sync_node_fts(&tx, &node)?;
        tx.commit().map_err(|error| error.to_string())?;
        Ok(DeleteNodeResult {
            path,
            etag: node.etag,
            deleted_at: now,
        })
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
        let top_k = i64::from(request.top_k.max(1));
        let mut sql = String::from(
            "SELECT path, kind, snippet(fs_nodes_fts, 2, '[', ']', '...', 12) AS snippet, bm25(fs_nodes_fts) AS score
             FROM fs_nodes_fts WHERE fs_nodes_fts MATCH ?1",
        );
        let mut values = vec![rusqlite::types::Value::from(query)];
        if let Some(prefix) = prefix {
            let (scope_sql, scope_values) = prefix_filter_sql(&prefix, 2);
            sql.push_str(&scope_sql);
            values.extend(scope_values);
        }
        sql.push_str(&format!(" ORDER BY score ASC, path ASC LIMIT {top_k}"));
        let mut stmt = conn.prepare(&sql).map_err(|error| error.to_string())?;
        stmt.query_map(rusqlite::params_from_iter(values.iter()), |row| {
            Ok(SearchNodeHit {
                path: row.get(0)?,
                kind: node_kind_from_db(&row.get::<_, String>(1)?)?,
                snippet: row.get(2)?,
                score: row.get(3)?,
                match_reasons: vec!["fts5_bm25".to_string()],
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
        let mut conn = self.open()?;
        let nodes = load_scoped_nodes(&conn, &prefix, request.include_deleted)?;
        let revision = snapshot_revision(&nodes);
        persist_snapshot_rows(&mut conn, &revision, &nodes)?;
        Ok(ExportSnapshotResponse {
            snapshot_revision: revision,
            nodes,
        })
    }

    pub fn fetch_updates(
        &self,
        request: FetchUpdatesRequest,
    ) -> Result<FetchUpdatesResponse, String> {
        let current = self.export_snapshot(ExportSnapshotRequest {
            prefix: request.prefix.clone(),
            include_deleted: request.include_deleted,
        })?;
        if current.snapshot_revision == request.known_snapshot_revision {
            return Ok(FetchUpdatesResponse {
                snapshot_revision: current.snapshot_revision,
                changed_nodes: Vec::new(),
                removed_paths: Vec::new(),
            });
        }
        let prefix = request
            .prefix
            .as_deref()
            .map(|value| normalize_node_path(value, true))
            .transpose()?;
        let prefix = prefix.unwrap_or_else(|| "/".to_string());
        let conn = self.open()?;
        let baseline = load_snapshot_rows(&conn, &request.known_snapshot_revision)?;
        let (changed_nodes, removed_paths) = match baseline {
            Some(baseline) => {
                let changed_nodes = current
                    .nodes
                    .iter()
                    .filter(|node| snapshot_row_changed(&baseline, node))
                    .cloned()
                    .collect();
                let removed_paths = load_scoped_nodes(&conn, &prefix, true)?
                    .into_iter()
                    .filter_map(|node| {
                        let deleted_at = node.deleted_at?;
                        let previous = baseline.iter().find(|entry| entry.path == node.path)?;
                        (previous.deleted_at != Some(deleted_at)).then_some(node.path)
                    })
                    .collect();
                (changed_nodes, removed_paths)
            }
            None => (current.nodes.clone(), Vec::new()),
        };
        Ok(FetchUpdatesResponse {
            snapshot_revision: current.snapshot_revision,
            changed_nodes,
            removed_paths,
        })
    }

    fn open(&self) -> Result<Connection, String> {
        Connection::open(&self.database_path).map_err(|error| error.to_string())
    }
}

fn persist_snapshot_rows(
    conn: &mut Connection,
    snapshot_revision: &str,
    nodes: &[Node],
) -> Result<(), String> {
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    let exists = tx
        .query_row(
            "SELECT 1 FROM fs_snapshots WHERE snapshot_revision = ?1 LIMIT 1",
            params![snapshot_revision],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .is_some();
    if exists {
        tx.commit().map_err(|error| error.to_string())?;
        return Ok(());
    }

    tx.execute(
        "INSERT INTO fs_snapshots (snapshot_revision, created_at)
         VALUES (?1, strftime('%s','now'))",
        params![snapshot_revision],
    )
    .map_err(|error| error.to_string())?;
    for node in nodes {
        tx.execute(
            "INSERT INTO fs_snapshot_nodes (snapshot_revision, path, etag, deleted_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![snapshot_revision, node.path, node.etag, node.deleted_at],
        )
        .map_err(|error| error.to_string())?;
    }
    tx.commit().map_err(|error| error.to_string())
}

fn load_snapshot_rows(
    conn: &Connection,
    snapshot_revision: &str,
) -> Result<Option<Vec<SnapshotNodeRow>>, String> {
    let exists = conn
        .query_row(
            "SELECT 1 FROM fs_snapshots WHERE snapshot_revision = ?1 LIMIT 1",
            params![snapshot_revision],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .is_some();
    if !exists {
        return Ok(None);
    }

    let mut stmt = conn
        .prepare(
            "SELECT path, etag, deleted_at
             FROM fs_snapshot_nodes
             WHERE snapshot_revision = ?1
             ORDER BY path ASC",
        )
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map(params![snapshot_revision], |row| {
            Ok(SnapshotNodeRow {
                path: row.get(0)?,
                etag: row.get(1)?,
                deleted_at: row.get(2)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(Some(rows))
}

fn snapshot_row_changed(baseline: &[SnapshotNodeRow], node: &Node) -> bool {
    match baseline.iter().find(|entry| entry.path == node.path) {
        Some(entry) => entry.etag != node.etag || entry.deleted_at != node.deleted_at,
        None => true,
    }
}

fn count_nodes(conn: &Connection, kind: &str, deleted_only: bool) -> Result<u64, String> {
    let sql = if deleted_only {
        "SELECT COUNT(*) FROM fs_nodes WHERE kind = ?1 AND deleted_at IS NOT NULL"
    } else {
        "SELECT COUNT(*) FROM fs_nodes WHERE kind = ?1 AND deleted_at IS NULL"
    };
    conn.query_row(sql, params![kind], |row| row.get::<_, u64>(0))
        .map_err(|error| error.to_string())
}

fn count_deleted_nodes(conn: &Connection) -> Result<u64, String> {
    conn.query_row(
        "SELECT COUNT(*) FROM fs_nodes WHERE deleted_at IS NOT NULL",
        [],
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
        deleted_at: None,
        metadata_json: request.metadata_json,
    })
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
    current.deleted_at = None;
    current.metadata_json = request.metadata_json;
    Ok(current)
}

fn upsert_node(tx: &Transaction<'_>, node: &Node) -> Result<(), String> {
    tx.execute(
        "INSERT INTO fs_nodes (path, kind, content, created_at, updated_at, etag, deleted_at, metadata_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(path) DO UPDATE SET
            kind = excluded.kind,
            content = excluded.content,
            created_at = excluded.created_at,
            updated_at = excluded.updated_at,
            etag = excluded.etag,
            deleted_at = excluded.deleted_at,
            metadata_json = excluded.metadata_json",
        params![node.path, node_kind_to_db(&node.kind), node.content, node.created_at, node.updated_at, node.etag, node.deleted_at, node.metadata_json],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn sync_node_fts(tx: &Transaction<'_>, node: &Node) -> Result<(), String> {
    tx.execute(
        "DELETE FROM fs_nodes_fts WHERE path = ?1",
        params![node.path],
    )
    .map_err(|error| error.to_string())?;
    if node.deleted_at.is_none() {
        tx.execute(
            "INSERT INTO fs_nodes_fts (path, kind, content) VALUES (?1, ?2, ?3)",
            params![node.path, node_kind_to_db(&node.kind), node.content],
        )
        .map_err(|error| error.to_string())?;
    }
    Ok(())
}
