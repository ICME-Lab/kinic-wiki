// Where: crates/vfs_store/src/fs_store/sync.rs
// What: Snapshot export and incremental fetch for client sync.
// Why: Mechanical split out of fs_store.rs; a child module keeps private access.
use super::*;

const SYNC_INTERNAL_SCAN_BATCH_SIZE: i64 = 100;
const SYNC_INTERNAL_SCAN_BATCH_LEN: usize = 100;

impl FsStore {
    pub fn export_snapshot(
        &self,
        request: ExportSnapshotRequest,
    ) -> Result<ExportSnapshotResponse, String> {
        self.export_snapshot_with_filter(request, |_| true, false)
    }

    pub fn export_snapshot_filtered(
        &self,
        request: ExportSnapshotRequest,
        mut allow_path: impl FnMut(&str) -> bool,
    ) -> Result<ExportSnapshotResponse, String> {
        self.export_snapshot_with_filter(request, &mut allow_path, true)
    }

    fn export_snapshot_with_filter(
        &self,
        request: ExportSnapshotRequest,
        mut allow_path: impl FnMut(&str) -> bool,
        filter_revision_changes: bool,
    ) -> Result<ExportSnapshotResponse, String> {
        let limit = sync_page_limit(request.limit)?;
        let prefix = request
            .prefix
            .as_deref()
            .map(|value| normalize_node_path(value, true))
            .transpose()?;
        let prefix = prefix.unwrap_or_else(|| "/".to_string());
        if request.snapshot_session_id.is_some() {
            return Err(SNAPSHOT_SESSION_INVALID.to_string());
        }
        let cursor = normalize_sync_cursor(request.cursor.as_deref(), &prefix)?;
        if cursor.is_some() && request.snapshot_revision.is_none() {
            return Err(SNAPSHOT_REVISION_CURSOR_REQUIRED.to_string());
        }
        self.read_conn(|conn| {
            let current_revision = current_snapshot_revision_number(conn)?;
            let snapshot = match request.snapshot_revision.as_deref() {
                Some(snapshot_revision) => parse_target_snapshot_revision(
                    snapshot_revision,
                    &prefix,
                    current_revision,
                    "snapshot_revision",
                )?,
                None => KnownSnapshotRevision {
                    revision: current_revision,
                    prefix: prefix.clone(),
                },
            };
            if !filter_revision_changes
                && request.snapshot_revision.is_some()
                && has_prefix_changes_after_revision(conn, &prefix, snapshot.revision)?
            {
                return Err(SNAPSHOT_REVISION_NO_LONGER_CURRENT.to_string());
            }
            if filter_revision_changes
                && request.snapshot_revision.is_some()
                && has_allowed_changes_after_revision(
                    conn,
                    &prefix,
                    snapshot.revision,
                    &mut allow_path,
                )?
            {
                return Err(SNAPSHOT_REVISION_NO_LONGER_CURRENT.to_string());
            }
            let allowed_limit = usize::try_from(limit + 1).map_err(|error| error.to_string())?;
            let mut paths = load_allowed_sync_paths(
                cursor.as_deref(),
                allowed_limit,
                &mut allow_path,
                |scan_cursor, batch_size| {
                    load_snapshot_paths_page(conn, &prefix, scan_cursor, batch_size)
                },
            )?;
            let limit = usize::try_from(limit).map_err(|error| error.to_string())?;
            let limit_had_more = paths.len() > limit;
            if limit_had_more {
                paths.truncate(limit);
            }
            let mut nodes = Vec::new();
            let mut used_bytes = sync_response_base_bytes("");
            for path in paths {
                let node = load_snapshot_node(conn, &path, snapshot.revision)?;
                let item_bytes = estimated_node_response_bytes(&node);
                if !sync_item_fits_budget(used_bytes, item_bytes) {
                    if nodes.is_empty() {
                        return Err(SYNC_RESPONSE_ITEM_TOO_LARGE.to_string());
                    }
                    return Ok(ExportSnapshotResponse {
                        snapshot_revision: scoped_snapshot_revision(&prefix, snapshot.revision),
                        snapshot_session_id: None,
                        next_cursor: nodes.last().map(PageCursorPath::cursor_path),
                        nodes,
                    });
                }
                used_bytes = used_bytes.saturating_add(item_bytes);
                nodes.push(node);
            }
            let next_cursor = if limit_had_more {
                nodes.last().map(PageCursorPath::cursor_path)
            } else {
                None
            };
            Ok(ExportSnapshotResponse {
                snapshot_revision: scoped_snapshot_revision(&prefix, snapshot.revision),
                snapshot_session_id: None,
                nodes,
                next_cursor,
            })
        })
    }

    pub fn fetch_updates(
        &self,
        request: FetchUpdatesRequest,
    ) -> Result<FetchUpdatesResponse, String> {
        self.fetch_updates_with_filter(request, |_| true)
    }

    pub fn fetch_updates_filtered(
        &self,
        request: FetchUpdatesRequest,
        mut allow_path: impl FnMut(&str) -> bool,
    ) -> Result<FetchUpdatesResponse, String> {
        self.fetch_updates_with_filter(request, &mut allow_path)
    }

    fn fetch_updates_with_filter(
        &self,
        request: FetchUpdatesRequest,
        mut allow_path: impl FnMut(&str) -> bool,
    ) -> Result<FetchUpdatesResponse, String> {
        let limit = sync_page_limit(request.limit)?;
        let prefix = request
            .prefix
            .as_deref()
            .map(|value| normalize_node_path(value, true))
            .transpose()?;
        let prefix = prefix.unwrap_or_else(|| "/".to_string());
        let cursor = normalize_sync_cursor(request.cursor.as_deref(), &prefix)?;
        self.read_conn(|conn| {
            let current_change_revision = current_snapshot_revision_number(conn)?;
            let known_snapshot = parse_known_snapshot_revision(&request.known_snapshot_revision);
            let Some(known_snapshot) = known_snapshot else {
                return Err("known_snapshot_revision is invalid".to_string());
            };
            if known_snapshot.prefix != prefix {
                return Err(
                    "known_snapshot_revision prefix does not match request prefix".to_string(),
                );
            }
            if known_snapshot.revision > current_change_revision {
                return Err("known_snapshot_revision is newer than current revision".to_string());
            }
            if cursor.is_some() && request.target_snapshot_revision.is_none() {
                return Err(TARGET_SNAPSHOT_CURSOR_REQUIRED.to_string());
            }
            let target_snapshot = match request.target_snapshot_revision.as_deref() {
                Some(snapshot_revision) => parse_target_snapshot_revision(
                    snapshot_revision,
                    &prefix,
                    current_change_revision,
                    "target_snapshot_revision",
                )?,
                None => KnownSnapshotRevision {
                    revision: current_change_revision,
                    prefix: prefix.clone(),
                },
            };
            if target_snapshot.revision < known_snapshot.revision {
                return Err(
                    "target_snapshot_revision is older than known_snapshot_revision".to_string(),
                );
            }
            let target_snapshot_revision =
                scoped_snapshot_revision(&prefix, target_snapshot.revision);
            if known_snapshot.revision == target_snapshot.revision {
                return Ok(FetchUpdatesResponse {
                    snapshot_revision: target_snapshot_revision,
                    changed_nodes: Vec::new(),
                    removed_paths: Vec::new(),
                    next_cursor: None,
                });
            }
            let oldest_change_revision = oldest_snapshot_revision_number(conn)?;
            if known_snapshot.revision < oldest_change_revision.saturating_sub(1) {
                return Err("known_snapshot_revision is no longer available".to_string());
            }
            let mut changed_nodes = Vec::new();
            let mut removed_paths = Vec::new();
            let allowed_limit = usize::try_from(limit + 1).map_err(|error| error.to_string())?;
            let mut paths = load_allowed_sync_paths(
                cursor.as_deref(),
                allowed_limit,
                &mut allow_path,
                |scan_cursor, batch_size| {
                    load_changed_paths_page(
                        conn,
                        known_snapshot.revision,
                        target_snapshot.revision,
                        &prefix,
                        scan_cursor,
                        batch_size,
                    )
                },
            )?;
            let limit = usize::try_from(limit).map_err(|error| error.to_string())?;
            let limit_had_more = paths.len() > limit;
            if limit_had_more {
                paths.truncate(limit);
            }
            let mut next_cursor = None;
            let mut used_bytes = sync_response_base_bytes(&target_snapshot_revision);
            for path in paths {
                if load_path_last_change_revision(conn, &path)? > target_snapshot.revision {
                    return Err(
                        "target_snapshot_revision is no longer current for changed path"
                            .to_string(),
                    );
                }
                let current_node = load_node(conn, &path)?;
                let item_bytes = current_node
                    .as_ref()
                    .map(estimated_node_response_bytes)
                    .unwrap_or_else(|| estimated_removed_path_response_bytes(&path));
                if !sync_item_fits_budget(used_bytes, item_bytes) {
                    if changed_nodes.is_empty() && removed_paths.is_empty() {
                        return Err(SYNC_RESPONSE_ITEM_TOO_LARGE.to_string());
                    }
                    next_cursor = last_sync_response_path(&changed_nodes, &removed_paths);
                    break;
                }
                used_bytes = used_bytes.saturating_add(item_bytes);
                match current_node {
                    Some(node) => changed_nodes.push(node),
                    None => removed_paths.push(path),
                }
            }
            if next_cursor.is_none() && limit_had_more {
                next_cursor = last_sync_response_path(&changed_nodes, &removed_paths);
            }
            Ok(FetchUpdatesResponse {
                snapshot_revision: target_snapshot_revision,
                changed_nodes,
                removed_paths,
                next_cursor,
            })
        })
    }
}

// Denied rows are consumed only inside the server. The returned paths are safe to reuse as
// client-visible cursors because every one passed the caller's access predicate.
fn load_allowed_sync_paths(
    cursor: Option<&str>,
    allowed_limit: usize,
    allow_path: &mut impl FnMut(&str) -> bool,
    mut load_page: impl FnMut(Option<&str>, i64) -> Result<Vec<String>, String>,
) -> Result<Vec<String>, String> {
    let mut allowed_paths = Vec::with_capacity(allowed_limit);
    let mut scan_cursor = cursor.map(str::to_string);
    while allowed_paths.len() < allowed_limit {
        let page = load_page(scan_cursor.as_deref(), SYNC_INTERNAL_SCAN_BATCH_SIZE)?;
        let page_len = page.len();
        if page_len == 0 {
            break;
        }
        for path in page {
            scan_cursor = Some(path.clone());
            if allow_path(&path) {
                allowed_paths.push(path);
                if allowed_paths.len() == allowed_limit {
                    break;
                }
            }
        }
        if page_len < SYNC_INTERNAL_SCAN_BATCH_LEN {
            break;
        }
    }
    Ok(allowed_paths)
}

fn last_sync_response_path(changed_nodes: &[Node], removed_paths: &[String]) -> Option<String> {
    match (
        changed_nodes.last().map(|node| node.path.as_str()),
        removed_paths.last().map(String::as_str),
    ) {
        (Some(changed), Some(removed)) => Some(changed.max(removed).to_string()),
        (Some(changed), None) => Some(changed.to_string()),
        (None, Some(removed)) => Some(removed.to_string()),
        (None, None) => None,
    }
}

pub(crate) fn current_snapshot_revision_number(conn: &Connection) -> Result<i64, String> {
    conn.query_row(
        "SELECT COALESCE(MAX(revision), 0) FROM fs_change_log",
        params![],
        |row| crate::sqlite::row_get::<i64>(row, 0),
    )
    .map_err(|error| error.to_string())
}

pub(crate) fn oldest_snapshot_revision_number(conn: &Connection) -> Result<i64, String> {
    conn.query_row(
        "SELECT COALESCE(MIN(revision), 0) FROM fs_change_log",
        params![],
        |row| crate::sqlite::row_get::<i64>(row, 0),
    )
    .map_err(|error| error.to_string())
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct KnownSnapshotRevision {
    revision: i64,
    prefix: String,
}

pub(crate) fn scoped_snapshot_revision(prefix: &str, revision: i64) -> String {
    snapshot_revision_token(prefix, revision)
}

pub(crate) fn parse_known_snapshot_revision(
    snapshot_revision: &str,
) -> Option<KnownSnapshotRevision> {
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

pub(crate) fn parse_target_snapshot_revision(
    snapshot_revision: &str,
    prefix: &str,
    current_revision: i64,
    field_name: &str,
) -> Result<KnownSnapshotRevision, String> {
    let parsed = parse_known_snapshot_revision(snapshot_revision)
        .ok_or_else(|| format!("{field_name} is invalid"))?;
    if parsed.prefix != prefix {
        return Err(format!("{field_name} prefix does not match request prefix"));
    }
    if parsed.revision > current_revision {
        return Err(format!("{field_name} is newer than current revision"));
    }
    Ok(parsed)
}
