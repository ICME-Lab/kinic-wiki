// Where: crates/vfs_store/src/fs_store.rs
// What: FS-first node store over SQLite for phase-2 persistence and search.
// Why: The new agent-facing model needs file-like CRUD and sync without changing the old wiki store yet.
//
// Search keeps ranking and preview generation separate.
// That prevents SQLite `snippet()` cost from scaling with all matched rows.
// Only returned hits pay preview generation cost.
use std::{
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use rusqlite::{Connection, OptionalExtension, Transaction, params};
use uuid::Uuid;
use vfs_types::{
    AppendNodeRequest, DeleteNodeRequest, DeleteNodeResult, EditNodeRequest, EditNodeResult,
    ExportSnapshotRequest, ExportSnapshotResponse, FetchUpdatesRequest, FetchUpdatesResponse,
    GlobNodeHit, GlobNodeType, GlobNodesRequest, ListNodesRequest, MkdirNodeRequest,
    MkdirNodeResult, MoveNodeRequest, MoveNodeResult, MultiEdit, MultiEditNodeRequest,
    MultiEditNodeResult, Node, NodeEntry, NodeEntryKind, NodeKind, RecentNodeHit,
    RecentNodesRequest, SearchNodeHit, SearchNodePathsRequest, SearchNodesRequest,
    SearchPreviewMode, Status, WriteNodeRequest, WriteNodeResult,
};
use wiki_domain::validate_source_path_for_kind;

use crate::{
    fs_helpers::{
        StoredNode, build_entries_from_rows, build_glob_entries_from_rows, compute_node_etag,
        file_search_title, load_node, load_scoped_entry_rows, load_stored_node, node_ack,
        node_kind_from_db, node_kind_to_db, normalize_node_path, prefix_filter_sql,
        prefix_filter_sql_for_column, relative_to_prefix, snapshot_revision_token,
    },
    fs_search::{
        build_light_previews_for_hits, build_search_query_plan, finalize_hits,
        load_content_substring_candidates, load_path_candidates, load_ranked_fts_candidates,
        path_match_score, rerank_candidates, sort_candidates,
    },
    fs_search_bench::{self, SearchBenchStage},
    glob_match::{matches_path, validate_pattern},
    schema,
};
use wiki_domain::WIKI_ROOT_PATH;

const QUERY_RESULT_LIMIT_MAX: u32 = 100;
const SNAPSHOT_REVISION_NO_LONGER_CURRENT: &str = "snapshot_revision is no longer current";
const SNAPSHOT_SESSION_INVALID: &str = "snapshot_session_id is invalid";
const SNAPSHOT_SESSION_EXPIRED: &str = "snapshot_session_id has expired";
const SNAPSHOT_SESSION_PREFIX_MISMATCH: &str =
    "snapshot_session_id prefix does not match request prefix";
const SNAPSHOT_SESSION_CURSOR_REQUIRED: &str = "snapshot_session_id is required when cursor is set";
const SNAPSHOT_SESSION_CURSOR_FORBIDDEN: &str =
    "snapshot_session_id cannot be used when cursor is absent";
const SNAPSHOT_SESSION_CURSOR_INVALID: &str = "cursor is invalid for snapshot_session_id";
const TARGET_SNAPSHOT_CURSOR_REQUIRED: &str =
    "target_snapshot_revision is required when cursor is set";
const SNAPSHOT_SESSION_TTL_SECS: i64 = 300;

// Where: crates/vfs_store/src/fs_store.rs
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
        validate_source_path_for_kind(&request.path, &request.kind)?;
        let path = normalize_node_path(&request.path, false)?;
        let mut conn = self.open()?;
        let tx = conn.transaction().map_err(|error| error.to_string())?;
        let existing = load_stored_node(&tx, &path)?;
        let created = existing.is_none();
        let mut node = match existing.as_ref() {
            Some(current) => update_existing_node(current.node.clone(), request, now)?,
            None => create_new_node(path, request, now)?,
        };
        let revision = record_change(&tx, &node)?;
        update_path_state(&tx, &node.path, revision)?;
        node.etag = compute_node_etag(&node);
        let row_id = save_node(&tx, existing.as_ref().map(|stored| stored.row_id), &node)?;
        sync_node_fts(&tx, existing.as_ref(), Some((row_id, &node)))?;
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
        match existing.as_ref() {
            Some(current) => validate_source_path_for_kind(&path, &current.node.kind)?,
            None => {
                if let Some(kind) = request.kind.as_ref() {
                    validate_source_path_for_kind(&path, kind)?;
                }
            }
        }
        let created = existing.is_none();
        let mut node = match existing.as_ref() {
            Some(current) => append_existing_node(current.node.clone(), request, now)?,
            None => create_appended_node(path, request, now)?,
        };
        let revision = record_change(&tx, &node)?;
        update_path_state(&tx, &node.path, revision)?;
        node.etag = compute_node_etag(&node);
        let row_id = save_node(&tx, existing.as_ref().map(|stored| stored.row_id), &node)?;
        sync_node_fts(&tx, existing.as_ref(), Some((row_id, &node)))?;
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
        let revision = record_change(&tx, &node)?;
        update_path_state(&tx, &node.path, revision)?;
        node.etag = compute_node_etag(&node);
        save_node(&tx, Some(current.row_id), &node)?;
        sync_node_fts(&tx, Some(&current), Some((current.row_id, &node)))?;
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
        let from_revision = record_path_removal(&tx, &from_path)?;
        update_path_state(&tx, &from_path, from_revision)?;
        let to_revision = record_change(&tx, &moved)?;
        update_path_state(&tx, &to_path, to_revision)?;
        moved.etag = compute_node_etag(&moved);
        save_node(&tx, Some(current.row_id), &moved)?;
        sync_node_fts(&tx, Some(&current), Some((current.row_id, &moved)))?;
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
            .unwrap_or_else(|| WIKI_ROOT_PATH.to_string());
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
            .unwrap_or_else(|| WIKI_ROOT_PATH.to_string());
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
        let revision = record_change(&tx, &node)?;
        update_path_state(&tx, &node.path, revision)?;
        node.etag = compute_node_etag(&node);
        save_node(&tx, Some(current.row_id), &node)?;
        sync_node_fts(&tx, Some(&current), Some((current.row_id, &node)))?;
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
        let revision = record_path_removal(&tx, &path)?;
        update_path_state(&tx, &path, revision)?;
        delete_node_row(&tx, &current)?;
        tx.commit().map_err(|error| error.to_string())?;
        Ok(DeleteNodeResult { path })
    }

    pub fn search_nodes(&self, request: SearchNodesRequest) -> Result<Vec<SearchNodeHit>, String> {
        let prefix = request
            .prefix
            .as_ref()
            .map(|value| normalize_node_path(value, true))
            .transpose()?;
        let plan = build_search_query_plan(&request.query_text)
            .ok_or_else(|| "query_text must not be empty".to_string())?;
        let conn = self.open()?;
        let top_k = capped_query_limit(request.top_k);
        let preview_mode = request.preview_mode.unwrap_or(SearchPreviewMode::Light);
        let mut candidates = if fs_search_bench::stage_enabled(SearchBenchStage::FtsCandidates) {
            load_ranked_fts_candidates(&conn, &plan, prefix.as_deref(), top_k)?
                .into_iter()
                .map(|candidate| (candidate.row_id, candidate))
                .collect::<std::collections::BTreeMap<_, _>>()
        } else {
            std::collections::BTreeMap::new()
        };
        if fs_search_bench::stage_enabled(SearchBenchStage::ContentSubstringCandidates) {
            for candidate in
                load_content_substring_candidates(&conn, &plan, prefix.as_deref(), top_k)?
            {
                candidates.entry(candidate.row_id).or_insert(candidate);
            }
        }
        let path_hits = if fs_search_bench::stage_enabled(SearchBenchStage::PathCandidates) {
            load_path_candidates(&conn, &plan.path_terms, prefix.as_deref(), top_k)?
        } else {
            Vec::new()
        };
        let mut ranked = if fs_search_bench::stage_enabled(SearchBenchStage::RerankAdjustment) {
            rerank_candidates(candidates, &plan, path_hits)
        } else {
            sort_candidates(candidates.into_values().collect())
        };
        ranked.truncate(top_k as usize);
        build_light_previews_for_hits(&conn, &mut ranked, &plan, preview_mode)?;
        Ok(finalize_hits(ranked, top_k))
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
            let title = file_search_title(&path).to_lowercase();
            let lowered_query = request.query_text.to_lowercase();
            let mut match_reasons = vec!["path_substring".to_string()];
            if title == lowered_query {
                match_reasons.push("basename_exact".to_string());
            } else if title.starts_with(&lowered_query) {
                match_reasons.push("basename_prefix".to_string());
            }
            Ok(SearchNodeHit {
                path: path.clone(),
                kind: node_kind_from_db(&row.get::<_, String>(1)?)?,
                snippet: Some(path),
                preview: None,
                score: path_match_score(first_match_position, path_length),
                match_reasons,
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
        let limit = sync_page_limit(request.limit)?;
        let prefix = request
            .prefix
            .as_deref()
            .map(|value| normalize_node_path(value, true))
            .transpose()?;
        let prefix = prefix.unwrap_or_else(|| "/".to_string());
        let _legacy_snapshot_revision = request.snapshot_revision;
        match (request.cursor, request.snapshot_session_id) {
            (None, None) => self.start_snapshot_session(prefix, limit),
            (Some(cursor), Some(session_id)) => {
                self.resume_snapshot_session(prefix, cursor, session_id, limit)
            }
            (Some(_), None) => Err(SNAPSHOT_SESSION_CURSOR_REQUIRED.to_string()),
            (None, Some(_)) => Err(SNAPSHOT_SESSION_CURSOR_FORBIDDEN.to_string()),
        }
    }

    pub fn fetch_updates(
        &self,
        request: FetchUpdatesRequest,
    ) -> Result<FetchUpdatesResponse, String> {
        let limit = sync_page_limit(request.limit)?;
        let prefix = request
            .prefix
            .as_deref()
            .map(|value| normalize_node_path(value, true))
            .transpose()?;
        let prefix = prefix.unwrap_or_else(|| "/".to_string());
        let cursor = normalize_sync_cursor(request.cursor.as_deref(), &prefix)?;
        let conn = self.open()?;
        let current_change_revision = current_snapshot_revision_number(&conn)?;
        let known_snapshot = parse_known_snapshot_revision(&request.known_snapshot_revision);
        let Some(known_snapshot) = known_snapshot else {
            return Err("known_snapshot_revision is invalid".to_string());
        };
        if known_snapshot.prefix != prefix {
            return Err("known_snapshot_revision prefix does not match request prefix".to_string());
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
        let target_snapshot_revision = scoped_snapshot_revision(&prefix, target_snapshot.revision);
        if known_snapshot.revision == target_snapshot.revision {
            return Ok(FetchUpdatesResponse {
                snapshot_revision: target_snapshot_revision,
                changed_nodes: Vec::new(),
                removed_paths: Vec::new(),
                next_cursor: None,
            });
        }
        let oldest_change_revision = oldest_snapshot_revision_number(&conn)?;
        if known_snapshot.revision < oldest_change_revision.saturating_sub(1) {
            return Err("known_snapshot_revision is no longer available".to_string());
        }
        let mut changed_nodes = Vec::new();
        let mut removed_paths = Vec::new();
        let mut paths = load_changed_paths_page(
            &conn,
            known_snapshot.revision,
            target_snapshot.revision,
            &prefix,
            cursor.as_deref(),
            limit + 1,
        )?;
        let next_cursor = page_next_cursor(&mut paths, limit);
        for path in paths {
            if load_path_last_change_revision(&conn, &path)? > target_snapshot.revision {
                return Err(
                    "target_snapshot_revision is no longer current for changed path".to_string(),
                );
            }
            let current_node = load_node(&conn, &path)?;
            match current_node {
                Some(node) => changed_nodes.push(node),
                None => removed_paths.push(path),
            }
        }
        Ok(FetchUpdatesResponse {
            snapshot_revision: target_snapshot_revision,
            changed_nodes,
            removed_paths,
            next_cursor,
        })
    }

    fn open(&self) -> Result<Connection, String> {
        Connection::open(&self.database_path).map_err(|error| error.to_string())
    }
}

#[derive(Debug, PartialEq, Eq)]
struct SnapshotSession {
    session_id: String,
    prefix: String,
    snapshot_revision: i64,
    expires_at: i64,
}

#[derive(Debug, PartialEq, Eq)]
struct SnapshotPage {
    snapshot_revision: String,
    snapshot_session_id: String,
    nodes: Vec<Node>,
    next_cursor: Option<String>,
}

impl FsStore {
    fn start_snapshot_session(
        &self,
        prefix: String,
        limit: i64,
    ) -> Result<ExportSnapshotResponse, String> {
        let mut conn = self.open()?;
        let tx = conn.transaction().map_err(|error| error.to_string())?;
        let now = unix_timestamp_secs()?;
        delete_expired_snapshot_sessions(&tx, now)?;
        let snapshot_revision = current_snapshot_revision_number(&tx)?;
        let session_id = Uuid::new_v4().to_string();
        let expires_at = now + SNAPSHOT_SESSION_TTL_SECS;
        insert_snapshot_session(&tx, &session_id, &prefix, snapshot_revision, expires_at)?;
        let page = build_snapshot_page_from_live_paths(
            &tx,
            &session_id,
            &prefix,
            snapshot_revision,
            limit,
        )?;
        tx.commit().map_err(|error| error.to_string())?;
        Ok(ExportSnapshotResponse {
            snapshot_revision: page.snapshot_revision,
            snapshot_session_id: Some(page.snapshot_session_id),
            nodes: page.nodes,
            next_cursor: page.next_cursor,
        })
    }

    fn resume_snapshot_session(
        &self,
        prefix: String,
        cursor: String,
        session_id: String,
        limit: i64,
    ) -> Result<ExportSnapshotResponse, String> {
        let mut conn = self.open()?;
        let tx = conn.transaction().map_err(|error| error.to_string())?;
        let now = unix_timestamp_secs()?;
        let session = load_snapshot_session(&tx, &session_id)?
            .ok_or_else(|| SNAPSHOT_SESSION_INVALID.to_string())?;
        delete_expired_snapshot_sessions(&tx, now)?;
        if session.expires_at <= now {
            delete_snapshot_session(&tx, &session.session_id)?;
            return Err(SNAPSHOT_SESSION_EXPIRED.to_string());
        }
        let normalized_prefix = normalize_node_path(&prefix, true)?;
        if session.prefix != normalized_prefix {
            return Err(SNAPSHOT_SESSION_PREFIX_MISMATCH.to_string());
        }
        let cursor = normalize_snapshot_session_cursor(&cursor, &session.prefix)?;
        let page = build_snapshot_page_from_session(&tx, &session, &cursor, limit)?;
        tx.commit().map_err(|error| error.to_string())?;
        Ok(ExportSnapshotResponse {
            snapshot_revision: page.snapshot_revision,
            snapshot_session_id: Some(page.snapshot_session_id),
            nodes: page.nodes,
            next_cursor: page.next_cursor,
        })
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

fn record_path_removal(tx: &Transaction<'_>, path: &str) -> Result<i64, String> {
    tx.execute(
        "INSERT INTO fs_change_log (path, change_kind) VALUES (?1, ?2)",
        params![path, ChangeKind::PathRemoval.as_str()],
    )
    .map_err(|error| error.to_string())?;
    Ok(tx.last_insert_rowid())
}

fn update_path_state(tx: &Transaction<'_>, path: &str, revision: i64) -> Result<(), String> {
    tx.execute(
        "INSERT INTO fs_path_state (path, last_change_revision)
         VALUES (?1, ?2)
         ON CONFLICT(path) DO UPDATE SET last_change_revision = excluded.last_change_revision",
        params![path, revision],
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

fn oldest_snapshot_revision_number(conn: &Connection) -> Result<i64, String> {
    conn.query_row(
        "SELECT COALESCE(MIN(revision), 0) FROM fs_change_log",
        [],
        |row| row.get::<_, i64>(0),
    )
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

fn parse_target_snapshot_revision(
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

fn capped_query_limit(requested: u32) -> i64 {
    i64::from(requested.clamp(1, QUERY_RESULT_LIMIT_MAX))
}

fn sync_page_limit(requested: u32) -> Result<i64, String> {
    if !(1..=QUERY_RESULT_LIMIT_MAX).contains(&requested) {
        return Err(format!(
            "limit must be between 1 and {QUERY_RESULT_LIMIT_MAX}"
        ));
    }
    Ok(i64::from(requested))
}

fn normalize_sync_cursor(cursor: Option<&str>, prefix: &str) -> Result<Option<String>, String> {
    let Some(cursor) = cursor else {
        return Ok(None);
    };
    let cursor = normalize_node_path(cursor, false)?;
    if !path_in_prefix(&cursor, prefix) {
        return Err("cursor must be within request prefix".to_string());
    }
    Ok(Some(cursor))
}

fn normalize_snapshot_session_cursor(cursor: &str, prefix: &str) -> Result<String, String> {
    let cursor = normalize_node_path(cursor, false)?;
    if !path_in_prefix(&cursor, prefix) {
        return Err(SNAPSHOT_SESSION_CURSOR_INVALID.to_string());
    }
    Ok(cursor)
}

fn unix_timestamp_secs() -> Result<i64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .map_err(|error| error.to_string())
}

fn path_in_prefix(path: &str, prefix: &str) -> bool {
    prefix == "/" || path == prefix || path.starts_with(&format!("{prefix}/"))
}

fn page_next_cursor<T>(items: &mut Vec<T>, limit: i64) -> Option<String>
where
    T: PageCursorPath,
{
    if items.len() <= limit as usize {
        return None;
    }
    items.truncate(limit as usize);
    items.last().map(PageCursorPath::cursor_path)
}

trait PageCursorPath {
    fn cursor_path(&self) -> String;
}

impl PageCursorPath for Node {
    fn cursor_path(&self) -> String {
        self.path.clone()
    }
}

impl PageCursorPath for String {
    fn cursor_path(&self) -> String {
        self.clone()
    }
}

fn insert_snapshot_session(
    tx: &Transaction<'_>,
    session_id: &str,
    prefix: &str,
    snapshot_revision: i64,
    expires_at: i64,
) -> Result<(), String> {
    tx.execute(
        "INSERT INTO fs_snapshot_sessions (session_id, prefix, snapshot_revision, expires_at)
         VALUES (?1, ?2, ?3, ?4)",
        params![session_id, prefix, snapshot_revision, expires_at],
    )
    .map(|_| ())
    .map_err(|error| error.to_string())
}

fn build_snapshot_page_from_live_paths(
    tx: &Transaction<'_>,
    session_id: &str,
    prefix: &str,
    snapshot_revision: i64,
    limit: i64,
) -> Result<SnapshotPage, String> {
    let mut sql = String::from("SELECT path FROM fs_nodes WHERE 1 = 1");
    let mut values = Vec::new();
    if prefix != "/" {
        let (scope_sql, scope_values) = prefix_filter_sql(prefix, 1);
        sql.push_str(&scope_sql);
        values.extend(scope_values);
    }
    sql.push_str(" ORDER BY path ASC");
    let mut stmt = tx.prepare(&sql).map_err(|error| error.to_string())?;
    let mut rows = stmt
        .query(rusqlite::params_from_iter(values.iter()))
        .map_err(|error| error.to_string())?;
    let mut page_paths = Vec::new();
    let mut ordinal = 0_i64;
    while let Some(row) = rows.next().map_err(|error| error.to_string())? {
        let path = row.get::<_, String>(0).map_err(|error| error.to_string())?;
        tx.execute(
            "INSERT INTO fs_snapshot_session_paths (session_id, ordinal, path)
             VALUES (?1, ?2, ?3)",
            params![session_id, ordinal, path],
        )
        .map_err(|error| error.to_string())?;
        if ordinal <= limit {
            page_paths.push(path);
        }
        ordinal += 1;
    }
    let next_cursor = page_next_cursor(&mut page_paths, limit);
    Ok(SnapshotPage {
        snapshot_revision: scoped_snapshot_revision(prefix, snapshot_revision),
        snapshot_session_id: session_id.to_string(),
        nodes: load_snapshot_nodes(tx, &page_paths, snapshot_revision)?,
        next_cursor,
    })
}

fn load_snapshot_session(
    tx: &Transaction<'_>,
    session_id: &str,
) -> Result<Option<SnapshotSession>, String> {
    tx.query_row(
        "SELECT session_id, prefix, snapshot_revision, expires_at
         FROM fs_snapshot_sessions
         WHERE session_id = ?1",
        params![session_id],
        |row| {
            Ok(SnapshotSession {
                session_id: row.get(0)?,
                prefix: row.get(1)?,
                snapshot_revision: row.get(2)?,
                expires_at: row.get(3)?,
            })
        },
    )
    .optional()
    .map_err(|error| error.to_string())
}

fn build_snapshot_page_from_session(
    tx: &Transaction<'_>,
    session: &SnapshotSession,
    cursor: &str,
    limit: i64,
) -> Result<SnapshotPage, String> {
    let start_ordinal = load_snapshot_cursor_ordinal(tx, &session.session_id, cursor)?
        .ok_or_else(|| SNAPSHOT_SESSION_CURSOR_INVALID.to_string())?
        + 1;
    let mut stmt = tx
        .prepare(
            "SELECT path
             FROM fs_snapshot_session_paths
             WHERE session_id = ?1 AND ordinal >= ?2
             ORDER BY ordinal ASC
             LIMIT ?3",
        )
        .map_err(|error| error.to_string())?;
    let page_paths = stmt
        .query_map(
            params![session.session_id, start_ordinal, limit + 1],
            |row| row.get::<_, String>(0),
        )
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    let mut page_paths = page_paths;
    let next_cursor = page_next_cursor(&mut page_paths, limit);
    Ok(SnapshotPage {
        snapshot_revision: scoped_snapshot_revision(&session.prefix, session.snapshot_revision),
        snapshot_session_id: session.session_id.clone(),
        nodes: load_snapshot_nodes(tx, &page_paths, session.snapshot_revision)?,
        next_cursor,
    })
}

fn load_snapshot_cursor_ordinal(
    tx: &Transaction<'_>,
    session_id: &str,
    cursor: &str,
) -> Result<Option<i64>, String> {
    tx.query_row(
        "SELECT ordinal
         FROM fs_snapshot_session_paths
         WHERE session_id = ?1 AND path = ?2",
        params![session_id, cursor],
        |row| row.get::<_, i64>(0),
    )
    .optional()
    .map_err(|error| error.to_string())
}

fn load_snapshot_nodes(
    tx: &Transaction<'_>,
    paths: &[String],
    snapshot_revision: i64,
) -> Result<Vec<Node>, String> {
    let mut nodes = Vec::with_capacity(paths.len());
    for path in paths {
        if load_path_last_change_revision(tx, path)? > snapshot_revision {
            return Err(SNAPSHOT_REVISION_NO_LONGER_CURRENT.to_string());
        }
        let node =
            load_node(tx, path)?.ok_or_else(|| SNAPSHOT_REVISION_NO_LONGER_CURRENT.to_string())?;
        nodes.push(node);
    }
    Ok(nodes)
}

fn delete_expired_snapshot_sessions(tx: &Transaction<'_>, now: i64) -> Result<(), String> {
    let expired = {
        let mut stmt = tx
            .prepare(
                "SELECT session_id
                 FROM fs_snapshot_sessions
                 WHERE expires_at <= ?1",
            )
            .map_err(|error| error.to_string())?;
        stmt.query_map(params![now], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?
    };
    for session_id in expired {
        delete_snapshot_session(tx, &session_id)?;
    }
    Ok(())
}

fn delete_snapshot_session(tx: &Transaction<'_>, session_id: &str) -> Result<(), String> {
    tx.execute(
        "DELETE FROM fs_snapshot_sessions WHERE session_id = ?1",
        params![session_id],
    )
    .map_err(|error| error.to_string())?;
    tx.execute(
        "DELETE FROM fs_snapshot_session_paths WHERE session_id = ?1",
        params![session_id],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn load_changed_paths_page(
    conn: &Connection,
    known_revision: i64,
    target_revision: i64,
    prefix: &str,
    cursor: Option<&str>,
    limit: i64,
) -> Result<Vec<String>, String> {
    let mut sql = String::from(
        "SELECT DISTINCT path
         FROM fs_change_log
         WHERE revision > ?1 AND revision <= ?2",
    );
    let mut values = vec![
        rusqlite::types::Value::from(known_revision),
        rusqlite::types::Value::from(target_revision),
    ];
    if prefix != "/" {
        let (scope_sql, scope_values) = prefix_filter_sql(prefix, values.len() + 1);
        sql.push_str(&scope_sql);
        values.extend(scope_values);
    }
    if let Some(cursor) = cursor {
        let index = values.len() + 1;
        sql.push_str(&format!(" AND path > ?{index}"));
        values.push(rusqlite::types::Value::from(cursor.to_string()));
    }
    sql.push_str(&format!(" ORDER BY path ASC LIMIT {limit}"));
    let mut stmt = conn.prepare(&sql).map_err(|error| error.to_string())?;
    stmt.query_map(rusqlite::params_from_iter(values.iter()), |row| row.get(0))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

fn load_path_last_change_revision(conn: &Connection, path: &str) -> Result<i64, String> {
    conn.query_row(
        "SELECT last_change_revision FROM fs_path_state WHERE path = ?1",
        params![path],
        |row| row.get::<_, i64>(0),
    )
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

#[cfg(not(feature = "bench-disable-fts"))]
fn sync_node_fts(
    tx: &Transaction<'_>,
    old: Option<&StoredNode>,
    new: Option<(i64, &Node)>,
) -> Result<(), String> {
    let unchanged = match (old, new) {
        (Some(stored), Some((row_id, node))) => {
            stored.row_id == row_id
                && stored.node.path == node.path
                && file_search_title(&stored.node.path) == file_search_title(&node.path)
                && stored.node.content == node.content
        }
        _ => false,
    };

    if unchanged {
        return Ok(());
    }

    if let Some(stored) = old {
        tx.execute(
            "DELETE FROM fs_nodes_fts WHERE rowid = ?1",
            params![stored.row_id],
        )
        .map_err(|error| error.to_string())?;
    }
    if let Some((row_id, node)) = new {
        let title = file_search_title(&node.path);
        tx.execute(
            "INSERT INTO fs_nodes_fts(rowid, path, title, content) VALUES(?1, ?2, ?3, ?4)",
            params![row_id, node.path, title, node.content],
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

fn glob_type_matches(node_type: &GlobNodeType, entry_kind: &NodeEntryKind) -> bool {
    match node_type {
        GlobNodeType::Any => true,
        GlobNodeType::File => {
            matches!(entry_kind, NodeEntryKind::File | NodeEntryKind::Source)
        }
        GlobNodeType::Directory => *entry_kind == NodeEntryKind::Directory,
    }
}
