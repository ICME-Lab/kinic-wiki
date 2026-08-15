// Where: crates/vfs_store/src/fs_store/history.rs
// What: Immutable per-node version history stored beside the live VFS rows.
// Why: User-facing audit, diff, and restore must share the live mutation transaction.
use crate::fs_helpers::node_kind_from_db;
use crate::sqlite::{Connection, OptionalExtension, Transaction, params};
use vfs_types::{
    DeletedNodeSummary, ListDeletedNodesResponse, ListNodeHistoryResponse, NodeHistoryChangeKind,
    NodeHistoryEntry, NodeVersion, NodeVersionSummary,
};

pub(super) const HISTORY_PAGE_LIMIT_MAX: u32 = 100;

pub(super) fn begin_change(
    tx: &Transaction<'_>,
    author_principal: &str,
    operation: &str,
    changed_at: i64,
    forced_kind: Option<&str>,
    restore_page_id: Option<i64>,
) -> Result<i64, String> {
    tx.execute(
        "INSERT INTO fs_history_changes (author_principal, operation, changed_at)
         VALUES (?1, ?2, ?3)",
        params![author_principal, operation, changed_at],
    )
    .map_err(|error| error.to_string())?;
    let change_id = crate::sqlite::last_insert_rowid(tx).map_err(|error| error.to_string())?;
    let active_change_values = vec![
        crate::sqlite::integer_value(change_id),
        crate::sqlite::integer_value(changed_at),
        crate::sqlite::nullable_text_value(forced_kind.map(str::to_owned)),
        crate::sqlite::nullable_integer_value(restore_page_id),
    ];
    crate::sqlite::execute_values(
        tx,
        "INSERT INTO fs_history_active_change
         (singleton, change_id, changed_at, forced_kind, restore_page_id)
         VALUES (1, ?1, ?2, ?3, ?4)",
        &active_change_values,
    )
    .map_err(|error| error.to_string())?;
    Ok(change_id)
}

pub(super) fn finish_change(tx: &Transaction<'_>, change_id: i64) -> Result<(), String> {
    let item_count = tx
        .query_row(
            "SELECT COUNT(*) FROM fs_history_items WHERE change_id = ?1",
            params![change_id],
            |row| crate::sqlite::row_get::<i64>(row, 0),
        )
        .map_err(|error| error.to_string())?;
    if item_count > 0 {
        crate::git_repository::finalize_change(tx, change_id)?;
    }
    tx.execute(
        "DELETE FROM fs_history_active_change WHERE singleton = 1 AND change_id = ?1",
        params![change_id],
    )
    .map_err(|error| error.to_string())?;
    tx.execute(
        "DELETE FROM fs_history_changes
         WHERE id = ?1 AND NOT EXISTS (
             SELECT 1 FROM fs_history_items WHERE change_id = ?1
         )",
        params![change_id],
    )
    .map(|_| ())
    .map_err(|error| error.to_string())
}

pub(super) fn resolve_page_id_by_path(
    conn: &Connection,
    path: &str,
) -> Result<Option<i64>, String> {
    conn.query_row(
        "SELECT id FROM fs_history_pages WHERE current_path = ?1 AND current_node_id IS NOT NULL",
        params![path],
        |row| crate::sqlite::row_get::<i64>(row, 0),
    )
    .optional()
    .map_err(|error| error.to_string())
}

pub(super) fn page_exists(conn: &Connection, page_id: i64) -> Result<bool, String> {
    conn.query_row(
        "SELECT 1 FROM fs_history_pages WHERE id = ?1",
        params![page_id],
        |row| crate::sqlite::row_get::<i64>(row, 0),
    )
    .optional()
    .map(|value| value.is_some())
    .map_err(|error| error.to_string())
}

pub(super) fn live_path(conn: &Connection, page_id: i64) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT page.current_path
         FROM fs_history_pages page
         JOIN fs_nodes node
           ON node.id = page.current_node_id AND node.path = page.current_path
         WHERE page.id = ?1",
        params![page_id],
        |row| crate::sqlite::row_get(row, 0),
    )
    .optional()
    .map_err(|error| error.to_string())
}

pub(super) fn list_history(
    conn: &Connection,
    page_id: i64,
    cursor: Option<i64>,
    limit: u32,
) -> Result<ListNodeHistoryResponse, String> {
    let fetch_limit = i64::from(limit.min(HISTORY_PAGE_LIMIT_MAX)) + 1;
    let mut stmt = conn
        .prepare(
            "SELECT item.id, item.change_id, item.page_id, item.change_kind,
                    change.operation, change.author_principal, change.changed_at, change.commit_oid,
                    before_version.id, before_version.page_id, before_version.path,
                    before_blob.kind, before_version.etag, before_version.git_blob_oid,
                    before_version.node_created_at, before_version.node_updated_at,
                    after_version.id, after_version.page_id, after_version.path,
                    after_blob.kind, after_version.etag, after_version.git_blob_oid,
                    after_version.node_created_at, after_version.node_updated_at
             FROM fs_history_items item
             JOIN fs_history_changes change ON change.id = item.change_id
             LEFT JOIN fs_history_versions before_version
               ON before_version.id = item.before_version_id
             LEFT JOIN fs_history_blobs before_blob
               ON before_blob.hash = before_version.blob_hash
             LEFT JOIN fs_history_versions after_version
               ON after_version.id = item.after_version_id
             LEFT JOIN fs_history_blobs after_blob
               ON after_blob.hash = after_version.blob_hash
             WHERE item.page_id = ?1 AND (?2 IS NULL OR item.id < ?2)
             ORDER BY item.id DESC LIMIT ?3",
        )
        .map_err(|error| error.to_string())?;
    let history_params = vec![
        crate::sqlite::integer_value(page_id),
        crate::sqlite::nullable_integer_value(cursor),
        crate::sqlite::integer_value(fetch_limit),
    ];
    let history_params = crate::sqlite::params_from_values(&history_params);
    let mut rows = crate::sqlite::query_map(&mut stmt, history_params, |row| {
        Ok(HistoryRow {
            item_id: crate::sqlite::row_get(row, 0)?,
            change_id: crate::sqlite::row_get(row, 1)?,
            page_id: crate::sqlite::row_get(row, 2)?,
            change_kind: crate::sqlite::row_get(row, 3)?,
            operation: crate::sqlite::row_get(row, 4)?,
            author_principal: crate::sqlite::row_get(row, 5)?,
            changed_at: crate::sqlite::row_get(row, 6)?,
            commit_oid: crate::sqlite::row_get(row, 7)?,
            before_version: RawVersionSummary::from_row(row, 8)?,
            after_version: RawVersionSummary::from_row(row, 16)?,
        })
    })
    .map_err(|error| error.to_string())?;
    let has_more = rows.len() > limit as usize;
    rows.truncate(limit as usize);
    let entries = rows
        .into_iter()
        .map(HistoryRow::into_entry)
        .collect::<Result<Vec<_>, _>>()?;
    let next_cursor = has_more
        .then(|| entries.last().map(|entry| entry.item_id))
        .flatten();
    Ok(ListNodeHistoryResponse {
        page_id: to_u64(page_id, "page id")?,
        entries,
        next_cursor,
    })
}

struct HistoryRow {
    item_id: i64,
    change_id: i64,
    page_id: i64,
    change_kind: String,
    operation: String,
    author_principal: String,
    changed_at: i64,
    commit_oid: String,
    before_version: RawVersionSummary,
    after_version: RawVersionSummary,
}

impl HistoryRow {
    fn into_entry(self) -> Result<NodeHistoryEntry, String> {
        let page_id = to_u64(self.page_id, "history page id")?;
        let before_version = self.before_version.into_summary()?;
        let after_version = self.after_version.into_summary()?;
        for version in [&before_version, &after_version].into_iter().flatten() {
            if version.page_id != page_id {
                return Err(format!(
                    "history version {} belongs to page {}, expected {page_id}",
                    version.version_id, version.page_id
                ));
            }
        }
        Ok(NodeHistoryEntry {
            item_id: to_u64(self.item_id, "history item id")?,
            change_id: to_u64(self.change_id, "history change id")?,
            page_id,
            operation: self.operation,
            change_kind: parse_change_kind(&self.change_kind)?,
            author_principal: self.author_principal,
            changed_at: self.changed_at,
            commit_oid: self.commit_oid,
            before_version,
            after_version,
        })
    }
}

struct RawVersionSummary {
    version_id: Option<i64>,
    page_id: Option<i64>,
    path: Option<String>,
    kind: Option<String>,
    etag: Option<String>,
    blob_oid: Option<String>,
    node_created_at: Option<i64>,
    node_updated_at: Option<i64>,
}

impl RawVersionSummary {
    fn from_row(row: &crate::sqlite::Row<'_>, start: usize) -> crate::sqlite::Result<Self> {
        Ok(Self {
            version_id: crate::sqlite::row_get(row, start)?,
            page_id: crate::sqlite::row_get(row, start + 1)?,
            path: crate::sqlite::row_get(row, start + 2)?,
            kind: crate::sqlite::row_get(row, start + 3)?,
            etag: crate::sqlite::row_get(row, start + 4)?,
            blob_oid: crate::sqlite::row_get(row, start + 5)?,
            node_created_at: crate::sqlite::row_get(row, start + 6)?,
            node_updated_at: crate::sqlite::row_get(row, start + 7)?,
        })
    }

    fn into_summary(self) -> Result<Option<NodeVersionSummary>, String> {
        let Some(version_id) = self.version_id else {
            return Ok(None);
        };
        let missing = |field: &str| format!("history version {version_id} is missing its {field}");
        Ok(Some(NodeVersionSummary {
            version_id: to_u64(version_id, "version id")?,
            page_id: to_u64(self.page_id.ok_or_else(|| missing("page id"))?, "page id")?,
            path: self.path.ok_or_else(|| missing("path"))?,
            kind: node_kind_from_db(&self.kind.ok_or_else(|| missing("kind"))?)
                .map_err(|error| error.to_string())?,
            etag: self.etag.ok_or_else(|| missing("etag"))?,
            blob_oid: self.blob_oid.ok_or_else(|| missing("Git blob oid"))?,
            node_created_at: self
                .node_created_at
                .ok_or_else(|| missing("created timestamp"))?,
            node_updated_at: self
                .node_updated_at
                .ok_or_else(|| missing("updated timestamp"))?,
        }))
    }
}

pub(super) fn read_version(
    conn: &Connection,
    page_id: i64,
    version_id: i64,
) -> Result<Option<NodeVersion>, String> {
    conn.query_row(
        "SELECT version.id, version.page_id, version.path, blob.kind, version.etag,
                version.git_blob_oid, version.node_created_at, version.node_updated_at,
                blob.content, blob.metadata_json
         FROM fs_history_versions version
         JOIN fs_history_blobs blob ON blob.hash = version.blob_hash
         WHERE version.id = ?1 AND version.page_id = ?2",
        params![version_id, page_id],
        |row| {
            let kind = node_kind_from_db(&crate::sqlite::row_get::<String>(row, 3)?)?;
            Ok(NodeVersion {
                summary: NodeVersionSummary {
                    version_id: crate::sqlite::row_get::<i64>(row, 0)? as u64,
                    page_id: crate::sqlite::row_get::<i64>(row, 1)? as u64,
                    path: crate::sqlite::row_get(row, 2)?,
                    kind,
                    etag: crate::sqlite::row_get(row, 4)?,
                    blob_oid: crate::sqlite::row_get(row, 5)?,
                    node_created_at: crate::sqlite::row_get(row, 6)?,
                    node_updated_at: crate::sqlite::row_get(row, 7)?,
                },
                content: crate::sqlite::row_get(row, 8)?,
                metadata_json: crate::sqlite::row_get(row, 9)?,
            })
        },
    )
    .optional()
    .map_err(|error| error.to_string())
}

pub(super) fn list_deleted(
    conn: &Connection,
    cursor: Option<i64>,
    limit: u32,
) -> Result<ListDeletedNodesResponse, String> {
    let fetch_limit = i64::from(limit.min(HISTORY_PAGE_LIMIT_MAX)) + 1;
    let mut stmt = conn
        .prepare(
            "SELECT page.id, version.id, version.path, blob.kind, version.etag,
                    version.git_blob_oid, version.node_created_at, version.node_updated_at, page.deleted_at,
                    change.author_principal, page.last_item_id
             FROM fs_history_pages page
             JOIN fs_history_versions version ON version.id = page.current_version_id
             JOIN fs_history_blobs blob ON blob.hash = version.blob_hash
             JOIN fs_history_changes change ON change.id = page.last_change_id
             WHERE page.deleted_at IS NOT NULL AND (?1 IS NULL OR page.last_item_id < ?1)
             ORDER BY page.last_item_id DESC LIMIT ?2",
        )
        .map_err(|error| error.to_string())?;
    let deleted_params = vec![
        crate::sqlite::nullable_integer_value(cursor),
        crate::sqlite::integer_value(fetch_limit),
    ];
    let deleted_params = crate::sqlite::params_from_values(&deleted_params);
    let mut nodes = crate::sqlite::query_map(&mut stmt, deleted_params, |row| {
        Ok((
            DeletedNodeSummary {
                page_id: crate::sqlite::row_get::<i64>(row, 0)? as u64,
                version_id: crate::sqlite::row_get::<i64>(row, 1)? as u64,
                path: crate::sqlite::row_get(row, 2)?,
                kind: node_kind_from_db(&crate::sqlite::row_get::<String>(row, 3)?)?,
                etag: crate::sqlite::row_get(row, 4)?,
                blob_oid: crate::sqlite::row_get(row, 5)?,
                node_created_at: crate::sqlite::row_get(row, 6)?,
                node_updated_at: crate::sqlite::row_get(row, 7)?,
                deleted_at: crate::sqlite::row_get(row, 8)?,
                deleted_by: crate::sqlite::row_get(row, 9)?,
            },
            crate::sqlite::row_get::<i64>(row, 10)?,
        ))
    })
    .map_err(|error| error.to_string())?;
    let has_more = nodes.len() > limit as usize;
    nodes.truncate(limit as usize);
    let next_cursor = has_more
        .then(|| nodes.last().map(|(_, item_id)| *item_id as u64))
        .flatten();
    Ok(ListDeletedNodesResponse {
        nodes: nodes.into_iter().map(|(node, _)| node).collect(),
        next_cursor,
    })
}

fn parse_change_kind(value: &str) -> Result<NodeHistoryChangeKind, String> {
    match value {
        "create" => Ok(NodeHistoryChangeKind::Create),
        "update" => Ok(NodeHistoryChangeKind::Update),
        "move" => Ok(NodeHistoryChangeKind::Move),
        "delete" => Ok(NodeHistoryChangeKind::Delete),
        "restore" => Ok(NodeHistoryChangeKind::Restore),
        _ => Err(format!("invalid history change kind: {value}")),
    }
}

fn to_u64(value: i64, label: &str) -> Result<u64, String> {
    u64::try_from(value).map_err(|_| format!("invalid {label}: {value}"))
}
