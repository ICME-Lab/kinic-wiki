// Where: crates/vfs_store/src/fs_store.rs
// What: FS-first node store over SQLite for phase-2 persistence and search.
// Why: The VFS layer needs one SQLite-backed store for file-like CRUD, search, and sync.
//
// Search keeps ranking and preview generation separate.
// That prevents SQLite `snippet()` cost from scaling with all matched rows.
// Only returned hits pay preview generation cost.
mod context;
mod history;
mod marketplace;
mod sql_json;
mod sync;
pub use sql_json::validate_sql_json_select;
use std::collections::{BTreeMap, BTreeSet};
#[cfg(not(target_arch = "wasm32"))]
use std::path::{Path, PathBuf};

#[cfg(not(target_arch = "wasm32"))]
use crate::sqlite::OpenFlags;
use crate::sqlite::{Connection, OptionalExtension, Transaction, params};
#[cfg(target_arch = "wasm32")]
use ic_sqlite_vfs::{DbError, DbHandle};
use vfs_types::{
    AppendNodeRequest, ChildNode, DeleteNodeRequest, DeleteNodeResult, EditNodeRequest,
    EditNodeResult, ExportSnapshotRequest, ExportSnapshotResponse, FetchUpdatesRequest,
    FetchUpdatesResponse, GitObjectChunk, GitRepositorySnapshot, GlobNodeHit, GlobNodeType,
    GlobNodesRequest, GraphLinksRequest, GraphNeighborhoodRequest, IncomingLinksRequest,
    IndexSqlJsonQueryResult, LinkEdge, ListChildrenRequest, ListDeletedNodesRequest,
    ListDeletedNodesResponse, ListGitObjectsRequest, ListGitObjectsResponse,
    ListNodeHistoryRequest, ListNodeHistoryResponse, ListNodesRequest, MarketCategoryGraph,
    MarketCategoryGraphEdge, MarketCategoryGraphNode, MarketListingPreview,
    MarketListingVerifiedStats, MarketPreviewExcerpt, MkdirNodeRequest, MkdirNodeResult,
    MoveNodeRequest, MoveNodeResult, MultiEdit, MultiEditNodeRequest, MultiEditNodeResult,
    MutateNodesBatchRequest, Node, NodeContext, NodeContextRequest, NodeEntry, NodeEntryKind,
    NodeHistoryTarget, NodeKind, NodeMutation, NodeMutationError, NodeMutationResult, NodeVersion,
    OutgoingLinksRequest, QueryContext, QueryContextRequest, ReadGitObjectChunkRequest,
    ReadNodeVersionRequest, RestoreNodeVersionRequest, SearchNodeHit, SearchNodePathsRequest,
    SearchNodesRequest, SearchPreviewMode, SourceEvidence, SourceEvidenceRef,
    SourceEvidenceRequest, Status, WriteNodeItem, WriteNodeRequest, WriteNodeResult,
    WriteNodesRequest,
};

use crate::{
    fs_helpers::{
        StoredNode, build_entries_from_rows, build_glob_entries_from_rows, compute_node_etag,
        file_search_title, load_node, load_scoped_entry_rows, load_stored_node, node_ack,
        node_kind_from_db, node_kind_to_db, normalize_node_path, prefix_filter_sql,
        prefix_filter_sql_for_column, relative_to_prefix, snapshot_revision_token,
    },
    fs_links::{
        delete_source_links, load_graph_links, load_graph_neighborhood, load_incoming_links,
        load_outgoing_links, move_source_links, sync_node_links,
    },
    fs_search::{
        SearchCandidate, build_previews_for_hits, build_search_query_plan, finalize_hits,
        load_content_substring_candidates, load_path_candidates, load_ranked_fts_candidates,
        path_match_score, rerank_candidates, sort_candidates,
    },
    fs_search_bench::{self, SearchBenchStage},
    glob_match::{matches_path, validate_pattern},
    hashing::sha256_hex,
    schema,
};

const QUERY_RESULT_LIMIT_MAX: u32 = 100;
const WIKI_ROOT_PATH: &str = "/Knowledge";
const CONTEXT_LINK_LIMIT: u32 = 20;
const CONTEXT_SEARCH_LIMIT: u32 = 10;
const WRITE_NODES_BATCH_LIMIT_MAX: usize = 100;
const MUTATE_NODES_BATCH_LIMIT_MAX: usize = 100;
const MARKETPLACE_PREVIEW_NODE_LIMIT: i64 = 12;
const TOKEN_CHAR_APPROX: usize = 4;
const SYNC_RESPONSE_BYTE_BUDGET: usize = 1_500_000;
const SQL_JSON_SQL_BYTES_MAX: usize = 4_096;
const SQL_JSON_ROW_BYTES_MAX: usize = 256 * 1024;
const SQL_JSON_RESPONSE_BYTES_MAX: usize = 1024 * 1024;
const SQL_JSON_PROGRESS_OP_INTERVAL: i32 = 1_000;
const SQL_JSON_PROGRESS_CALLBACK_BUDGET: u32 = 200;
const SQL_JSON_EXECUTION_BUDGET_EXCEEDED: &str = "database SQL execution budget exceeded";
const SNAPSHOT_REVISION_NO_LONGER_CURRENT: &str = "snapshot_revision is no longer current";
const SNAPSHOT_SESSION_INVALID: &str = "snapshot_session_id is invalid";
const SNAPSHOT_REVISION_CURSOR_REQUIRED: &str = "snapshot_revision is required when cursor is set";
const TARGET_SNAPSHOT_CURSOR_REQUIRED: &str =
    "target_snapshot_revision is required when cursor is set";
const SYNC_RESPONSE_ITEM_TOO_LARGE: &str = "sync response item exceeds byte budget";
const LIST_ROOT_CHILD_ROWS_SQL: &str = "\
SELECT child.path,
       child.kind,
       child.updated_at,
       child.etag,
       length(CAST(child.content AS BLOB)),
       EXISTS (
           SELECT 1
           FROM fs_nodes descendant
           WHERE descendant.parent_id = child.id
             AND NOT (descendant.kind = 'file' AND descendant.name = 'index.md')
           LIMIT 1
       )
FROM fs_nodes child
WHERE child.parent_id IS NULL
ORDER BY child.name ASC";
const LIST_FOLDER_CHILD_ROWS_SQL: &str = "\
SELECT child.path,
       child.kind,
       child.updated_at,
       child.etag,
       length(CAST(child.content AS BLOB)),
       EXISTS (
           SELECT 1
           FROM fs_nodes descendant
           WHERE descendant.parent_id = child.id
             AND NOT (descendant.kind = 'file' AND descendant.name = 'index.md')
           LIMIT 1
       )
FROM fs_nodes child
WHERE child.parent_id = ?1
ORDER BY child.name ASC";

fn history_id(value: u64, label: &str) -> Result<i64, String> {
    i64::try_from(value).map_err(|_| format!("{label} is out of range: {value}"))
}

struct ChildRow {
    path: String,
    kind: NodeKind,
    updated_at: i64,
    etag: String,
    size_bytes: u64,
    has_children: bool,
}

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
    #[cfg(not(target_arch = "wasm32"))]
    database_path: PathBuf,
    #[cfg(target_arch = "wasm32")]
    handle: DbHandle,
}

#[cfg(target_arch = "wasm32")]
pub type StableFsStore = FsStore;

impl FsStore {
    #[cfg(not(target_arch = "wasm32"))]
    pub fn new(database_path: PathBuf) -> Self {
        Self { database_path }
    }

    #[cfg(target_arch = "wasm32")]
    pub fn stable(handle: DbHandle) -> Self {
        Self { handle }
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub fn database_path(&self) -> &Path {
        &self.database_path
    }

    pub fn run_fs_migrations(&self) -> Result<(), String> {
        #[cfg(not(target_arch = "wasm32"))]
        {
            let mut conn = self.open()?;
            schema::run_fs_migrations(&mut conn)
        }
        #[cfg(target_arch = "wasm32")]
        {
            self.write_conn(schema::run_fs_migrations_in_tx)
        }
    }

    #[cfg(feature = "canbench-rs")]
    pub fn prepare_git_migration_benchmark_fixture(
        &self,
        node_count: usize,
        total_content_bytes: usize,
        max_content_bytes: usize,
        depth: usize,
    ) -> Result<(), String> {
        if node_count == 0 || total_content_bytes < max_content_bytes || depth == 0 {
            return Err("invalid Git migration benchmark fixture dimensions".to_string());
        }
        self.write_conn(|tx| {
            tx.execute(
                "DELETE FROM fs_nodes WHERE path LIKE '/Knowledge/canbench-migration/%'",
                params![],
            )
            .map_err(|error| error.to_string())?;
            let knowledge_id = tx
                .query_row(
                    "SELECT id FROM fs_nodes WHERE path = '/Knowledge'",
                    params![],
                    |row| crate::sqlite::row_get::<i64>(row, 0),
                )
                .map_err(|error| error.to_string())?;
            let first_id = tx
                .query_row(
                    "SELECT COALESCE(MAX(id), 0) + 1 FROM fs_nodes",
                    params![],
                    |row| crate::sqlite::row_get::<i64>(row, 0),
                )
                .map_err(|error| error.to_string())?;
            let remaining_bytes = total_content_bytes.saturating_sub(max_content_bytes);
            let remaining_nodes = node_count.saturating_sub(1);
            for index in 0..node_count {
                let content_bytes = if index == 0 {
                    max_content_bytes
                } else {
                    let base = remaining_bytes
                        .checked_div(remaining_nodes)
                        .ok_or_else(|| {
                            "invalid Git migration benchmark fixture node count".to_string()
                        })?;
                    let remainder =
                        remaining_bytes
                            .checked_rem(remaining_nodes)
                            .ok_or_else(|| {
                                "invalid Git migration benchmark fixture node count".to_string()
                            })?;
                    let extra = usize::from(index <= remainder);
                    base + extra
                };
                let mut path = String::from("/Knowledge/canbench-migration");
                for level in 0..depth.saturating_sub(2) {
                    path.push_str(&format!("/d{level}-{:02}", index % 10));
                }
                path.push_str(&format!("/node-{index:06}.md"));
                tx.execute(
                    "INSERT INTO fs_nodes
                         (id, path, kind, content, created_at, updated_at, etag,
                          metadata_json, parent_id, name)
                     VALUES (?1, ?2, 'file', ?3, 1, 1, ?4, '{}', ?5, ?6)",
                    params![
                        first_id + i64::try_from(index).map_err(|error| error.to_string())?,
                        path,
                        "x".repeat(content_bytes),
                        format!("canbench-v002-{index:06}"),
                        knowledge_id,
                        format!("node-{index:06}.md"),
                    ],
                )
                .map_err(|error| error.to_string())?;
            }
            for table in [
                "git_index_entries",
                "git_refs",
                "git_objects",
                "fs_history_items",
                "fs_history_active_change",
                "fs_history_changes",
                "fs_history_versions",
                "fs_history_blobs",
                "fs_history_pages",
            ] {
                tx.execute(&format!("DELETE FROM {table}"), params![])
                    .map_err(|error| error.to_string())?;
            }
            Ok(())
        })
    }

    #[cfg(feature = "canbench-rs")]
    pub fn run_git_migration_benchmark(&self) -> Result<(), String> {
        self.write_conn(crate::git_repository::seed_repository)
    }

    pub fn status(&self) -> Result<Status, String> {
        self.read_conn(|conn| {
            Ok(Status {
                file_count: count_nodes(conn, "file")?,
                source_count: count_nodes(conn, "source")?,
            })
        })
    }

    pub fn logical_size_bytes(&self) -> Result<u64, String> {
        #[cfg(not(target_arch = "wasm32"))]
        {
            let conn = Connection::open_with_flags(
                &self.database_path,
                OpenFlags::SQLITE_OPEN_READ_ONLY
                    | OpenFlags::SQLITE_OPEN_URI
                    | OpenFlags::SQLITE_OPEN_NO_MUTEX,
            )
            .map_err(|error| error.to_string())?;
            logical_size_bytes_for_conn(&conn)
        }
        #[cfg(target_arch = "wasm32")]
        {
            self.read_conn(logical_size_bytes_for_conn)
        }
    }

    pub fn read_node(&self, path: &str) -> Result<Option<Node>, String> {
        let normalized = normalize_node_path(path, false)?;
        self.read_conn(|conn| load_node(conn, &normalized))
    }

    pub fn list_nodes(&self, request: ListNodesRequest) -> Result<Vec<NodeEntry>, String> {
        let prefix = normalize_node_path(&request.prefix, true)?;
        let limit = capped_list_nodes_limit(request.limit);
        self.read_conn(|conn| {
            let rows = load_scoped_entry_rows(conn, &prefix, request.recursive.then_some(limit))?;
            let mut entries = build_entries_from_rows(&rows, &prefix, request.recursive);
            if !request.recursive {
                entries.truncate(limit as usize);
            }
            Ok(entries)
        })
    }

    pub fn list_children(&self, request: ListChildrenRequest) -> Result<Vec<ChildNode>, String> {
        let path = normalize_list_children_path(&request.path)?;
        self.read_conn(|conn| {
            let concrete_node = load_stored_node(conn, &path)?;
            if concrete_node
                .as_ref()
                .is_some_and(|stored| stored.node.kind != NodeKind::Folder)
            {
                return Err(format!("not a directory: {path}"));
            }
            let rows =
                load_child_rows(conn, &path, concrete_node.as_ref().map(|node| node.row_id))?;
            if rows.is_empty() && !allows_empty_directory_listing(&path) && concrete_node.is_none()
            {
                return Err(format!("path not found: {path}"));
            }
            build_child_nodes(&path, rows)
        })
    }

    pub fn list_node_history(
        &self,
        request: ListNodeHistoryRequest,
    ) -> Result<ListNodeHistoryResponse, String> {
        let limit = request.limit.min(history::HISTORY_PAGE_LIMIT_MAX);
        if limit == 0 {
            return Err("limit must be greater than zero".to_string());
        }
        self.read_conn(|conn| {
            let page_id = match request.target {
                NodeHistoryTarget::CurrentPath(path) => {
                    let path = normalize_node_path(&path, false)?;
                    history::resolve_page_id_by_path(conn, &path)?
                        .ok_or_else(|| format!("history page does not exist: {path}"))?
                }
                NodeHistoryTarget::PageId(page_id) => {
                    let page_id = history_id(page_id, "page id")?;
                    if !history::page_exists(conn, page_id)? {
                        return Err(format!("history page does not exist: {page_id}"));
                    }
                    page_id
                }
            };
            history::list_history(
                conn,
                page_id,
                request
                    .cursor
                    .map(|cursor| history_id(cursor, "cursor"))
                    .transpose()?,
                limit,
            )
        })
    }

    pub fn read_node_version(
        &self,
        request: ReadNodeVersionRequest,
    ) -> Result<Option<NodeVersion>, String> {
        let page_id = history_id(request.page_id, "page id")?;
        let version_id = history_id(request.version_id, "version id")?;
        self.read_conn(|conn| history::read_version(conn, page_id, version_id))
    }

    pub fn node_history_live_path(&self, page_id: u64) -> Result<Option<String>, String> {
        let page_id = history_id(page_id, "page id")?;
        self.read_conn(|conn| history::live_path(conn, page_id))
    }

    pub fn list_deleted_nodes(
        &self,
        request: ListDeletedNodesRequest,
    ) -> Result<ListDeletedNodesResponse, String> {
        let limit = request.limit.min(history::HISTORY_PAGE_LIMIT_MAX);
        if limit == 0 {
            return Err("limit must be greater than zero".to_string());
        }
        let cursor = request
            .cursor
            .map(|cursor| history_id(cursor, "cursor"))
            .transpose()?;
        self.read_conn(|conn| history::list_deleted(conn, cursor, limit))
    }

    pub fn git_repository_snapshot(&self) -> Result<GitRepositorySnapshot, String> {
        self.read_conn(crate::git_repository::repository_snapshot)
    }

    pub fn list_git_objects(
        &self,
        request: ListGitObjectsRequest,
    ) -> Result<ListGitObjectsResponse, String> {
        let snapshot_change_id = i64::try_from(request.snapshot_change_id)
            .map_err(|_| "snapshot_change_id is too large".to_string())?;
        self.read_conn(|conn| {
            crate::git_repository::list_objects(
                conn,
                snapshot_change_id,
                request.cursor.as_deref(),
                request.limit,
            )
        })
    }

    pub fn read_git_object_chunk(
        &self,
        request: ReadGitObjectChunkRequest,
    ) -> Result<Option<GitObjectChunk>, String> {
        let snapshot_change_id = i64::try_from(request.snapshot_change_id)
            .map_err(|_| "snapshot_change_id is too large".to_string())?;
        self.read_conn(|conn| {
            crate::git_repository::read_object_chunk(
                conn,
                snapshot_change_id,
                &request.oid,
                request.offset,
                request.limit,
            )
        })
    }

    pub fn restore_node_version_as(
        &self,
        request: RestoreNodeVersionRequest,
        now: i64,
        publication_operation_id: Option<i64>,
        author_principal: &str,
    ) -> Result<WriteNodeResult, NodeMutationError> {
        let page_id =
            history_id(request.page_id, "page id").map_err(NodeMutationError::invalid_operation)?;
        let version_id = history_id(request.version_id, "version id")
            .map_err(NodeMutationError::invalid_operation)?;
        self.write_mutation_conn_with_publication_commit(publication_operation_id, |tx| {
            let selected = history::read_version(tx, page_id, version_id)
                .map_err(NodeMutationError::write_unavailable)?
                .ok_or_else(|| {
                    NodeMutationError::not_found_with_path(
                        format!("history version does not exist: {version_id}"),
                        request.page_id.to_string(),
                    )
                })?;
            let (current_node_id, current_path): (Option<i64>, String) = tx
                .query_row(
                    "SELECT current_node_id, current_path FROM fs_history_pages WHERE id = ?1",
                    params![page_id],
                    |row| {
                        Ok((
                            crate::sqlite::row_get(row, 0)?,
                            crate::sqlite::row_get(row, 1)?,
                        ))
                    },
                )
                .map_err(|error| NodeMutationError::write_unavailable(error.to_string()))?;
            let existing = match current_node_id {
                Some(current_node_id) => load_stored_node(tx, &current_path)
                    .map_err(NodeMutationError::write_unavailable)?
                    .filter(|stored| stored.row_id == current_node_id),
                None => None,
            };
            match (&existing, request.expected_current_etag.as_deref()) {
                (Some(current), Some(expected)) if current.node.etag == expected => {}
                (Some(current), _) => {
                    return Err(NodeMutationError::etag_conflict(
                        format!(
                            "expected_current_etag does not match current etag: {}",
                            current.node.path
                        ),
                        current.node.path.clone(),
                    ));
                }
                (None, Some(_)) => {
                    return Err(NodeMutationError::invalid_operation(
                        "expected_current_etag must be None when restoring a deleted node",
                    ));
                }
                (None, None) => {}
            }
            let path = existing
                .as_ref()
                .map(|stored| stored.node.path.clone())
                .unwrap_or_else(|| selected.summary.path.clone());
            if existing.is_none()
                && load_stored_node(tx, &path)
                    .map_err(NodeMutationError::write_unavailable)?
                    .is_some()
            {
                return Err(NodeMutationError::invalid_operation_with_path(
                    format!("restore path already exists: {path}"),
                    path,
                ));
            }
            let mut node = Node {
                path,
                kind: selected.summary.kind,
                content: selected.content,
                created_at: existing
                    .as_ref()
                    .map(|stored| stored.node.created_at)
                    .unwrap_or(selected.summary.node_created_at),
                updated_at: now,
                etag: String::new(),
                metadata_json: selected.metadata_json,
            };
            let changed_bytes = crate::git_repository::node_mutation_bytes(
                "restore",
                existing.as_ref().map(|stored| &stored.node),
                Some(&node),
            )
            .map_err(NodeMutationError::invalid_operation)?;
            crate::git_repository::validate_mutation_budget(1, changed_bytes)
                .map_err(NodeMutationError::invalid_operation)?;
            ensure_missing_store_root_for_path(tx, &node.path, now)
                .map_err(NodeMutationError::write_unavailable)?;
            require_parent_folder_for_mutation(tx, &node.path)?;
            let change_id = history::begin_change(
                tx,
                author_principal,
                "restore",
                now,
                Some("restore"),
                existing.is_none().then_some(page_id),
            )
            .map_err(NodeMutationError::write_unavailable)?;
            let revision =
                record_change(tx, &node).map_err(NodeMutationError::write_unavailable)?;
            update_path_state(tx, &node.path, revision)
                .map_err(NodeMutationError::write_unavailable)?;
            node.etag = compute_node_etag(&node);
            let row_id = save_node(tx, existing.as_ref().map(|stored| stored.row_id), &node)
                .map_err(NodeMutationError::write_unavailable)?;
            sync_node_fts(tx, existing.as_ref(), Some((row_id, &node)))
                .map_err(NodeMutationError::write_unavailable)?;
            sync_node_links(tx, &node).map_err(NodeMutationError::write_unavailable)?;
            history::finish_change(tx, change_id).map_err(NodeMutationError::write_unavailable)?;
            Ok(WriteNodeResult {
                node: node_ack(&node),
                created: existing.is_none(),
            })
        })
    }

    pub fn write_node(
        &self,
        request: WriteNodeRequest,
        now: i64,
    ) -> Result<WriteNodeResult, NodeMutationError> {
        self.write_node_with_publication_commit(request, now, None)
    }

    pub fn write_node_with_publication_commit(
        &self,
        request: WriteNodeRequest,
        now: i64,
        publication_operation_id: Option<i64>,
    ) -> Result<WriteNodeResult, NodeMutationError> {
        self.write_node_with_publication_commit_as(request, now, publication_operation_id, "system")
    }

    pub fn write_node_with_publication_commit_as(
        &self,
        request: WriteNodeRequest,
        now: i64,
        publication_operation_id: Option<i64>,
        author_principal: &str,
    ) -> Result<WriteNodeResult, NodeMutationError> {
        let WriteNodeRequest {
            database_id,
            path,
            kind,
            content,
            metadata_json,
            expected_etag,
        } = request;
        self.write_history_mutation_conn(
            publication_operation_id,
            author_principal,
            "write",
            now,
            None,
            |tx| {
                write_node_item_in_tx(
                    tx,
                    &database_id,
                    WriteNodeItem {
                        path,
                        kind,
                        content,
                        metadata_json,
                        expected_etag,
                    },
                    now,
                )
            },
        )
    }

    pub fn write_nodes(
        &self,
        request: WriteNodesRequest,
        now: i64,
    ) -> Result<Vec<WriteNodeResult>, NodeMutationError> {
        self.write_nodes_with_publication_commit(request, now, None)
    }

    pub fn write_nodes_with_publication_commit(
        &self,
        request: WriteNodesRequest,
        now: i64,
        publication_operation_id: Option<i64>,
    ) -> Result<Vec<WriteNodeResult>, NodeMutationError> {
        self.write_nodes_with_publication_commit_as(
            request,
            now,
            publication_operation_id,
            "system",
        )
    }

    pub fn write_nodes_with_publication_commit_as(
        &self,
        request: WriteNodesRequest,
        now: i64,
        publication_operation_id: Option<i64>,
        author_principal: &str,
    ) -> Result<Vec<WriteNodeResult>, NodeMutationError> {
        validate_write_nodes_count(request.nodes.len())
            .map_err(NodeMutationError::invalid_operation)?;
        preflight_write_nodes_budget(&request.nodes)?;
        let database_id = request.database_id;
        let nodes = request.nodes;
        self.write_history_mutation_conn(
            publication_operation_id,
            author_principal,
            "write_nodes",
            now,
            None,
            |tx| {
                let mut results = Vec::with_capacity(nodes.len());
                for (index, item) in nodes.into_iter().enumerate() {
                    results.push(
                        write_node_item_in_tx(tx, &database_id, item, now)
                            .map_err(|error| error.with_failed_index(index))?,
                    );
                }
                Ok(results)
            },
        )
    }

    pub fn append_node(
        &self,
        request: AppendNodeRequest,
        now: i64,
    ) -> Result<WriteNodeResult, NodeMutationError> {
        self.append_node_as(request, now, "system")
    }

    pub fn append_node_as(
        &self,
        request: AppendNodeRequest,
        now: i64,
        author_principal: &str,
    ) -> Result<WriteNodeResult, NodeMutationError> {
        self.write_history_mutation_conn(None, author_principal, "append", now, None, |tx| {
            append_node_in_tx(tx, request, now)
        })
    }

    pub fn edit_node(
        &self,
        request: EditNodeRequest,
        now: i64,
    ) -> Result<EditNodeResult, NodeMutationError> {
        self.edit_node_as(request, now, "system")
    }

    pub fn edit_node_as(
        &self,
        request: EditNodeRequest,
        now: i64,
        author_principal: &str,
    ) -> Result<EditNodeResult, NodeMutationError> {
        self.write_history_mutation_conn(None, author_principal, "edit", now, None, |tx| {
            edit_node_in_tx(tx, request, now)
        })
    }

    pub fn mkdir_node(
        &self,
        request: MkdirNodeRequest,
        now: i64,
    ) -> Result<MkdirNodeResult, NodeMutationError> {
        self.mkdir_node_as(request, now, "system")
    }

    pub fn mkdir_node_as(
        &self,
        request: MkdirNodeRequest,
        now: i64,
        author_principal: &str,
    ) -> Result<MkdirNodeResult, NodeMutationError> {
        self.write_history_mutation_conn(None, author_principal, "mkdir", now, None, |tx| {
            mkdir_node_in_tx(tx, request, now)
        })
    }

    pub fn move_node(
        &self,
        request: MoveNodeRequest,
        now: i64,
    ) -> Result<MoveNodeResult, NodeMutationError> {
        self.move_node_with_publication_commit(request, now, None)
    }

    pub fn move_node_with_publication_commit(
        &self,
        request: MoveNodeRequest,
        now: i64,
        publication_operation_id: Option<i64>,
    ) -> Result<MoveNodeResult, NodeMutationError> {
        self.move_node_with_publication_commit_as(request, now, publication_operation_id, "system")
    }

    pub fn move_node_with_publication_commit_as(
        &self,
        request: MoveNodeRequest,
        now: i64,
        publication_operation_id: Option<i64>,
        author_principal: &str,
    ) -> Result<MoveNodeResult, NodeMutationError> {
        self.write_history_mutation_conn(
            publication_operation_id,
            author_principal,
            "move",
            now,
            None,
            |tx| move_node_in_tx(tx, request, now),
        )
    }

    pub fn mutate_nodes_batch(
        &self,
        request: MutateNodesBatchRequest,
        now: i64,
    ) -> Result<Vec<NodeMutationResult>, NodeMutationError> {
        self.mutate_nodes_batch_with_publication_commit(request, now, None)
    }

    pub fn mutate_nodes_batch_with_publication_commit(
        &self,
        request: MutateNodesBatchRequest,
        now: i64,
        publication_operation_id: Option<i64>,
    ) -> Result<Vec<NodeMutationResult>, NodeMutationError> {
        self.mutate_nodes_batch_with_publication_commit_as(
            request,
            now,
            publication_operation_id,
            "system",
        )
    }

    pub fn mutate_nodes_batch_with_publication_commit_as(
        &self,
        request: MutateNodesBatchRequest,
        now: i64,
        publication_operation_id: Option<i64>,
        author_principal: &str,
    ) -> Result<Vec<NodeMutationResult>, NodeMutationError> {
        validate_mutate_nodes_batch_count(request.operations.len())
            .map_err(NodeMutationError::invalid_operation)?;
        let database_id = request.database_id;
        let operations = request.operations;
        let preflight_operations = operations.clone();
        self.write_history_mutation_conn_with_preflight(
            publication_operation_id,
            author_principal,
            "batch",
            now,
            None,
            move |_| preflight_mutate_nodes_batch_budget(&preflight_operations),
            |tx| {
                operations
                    .into_iter()
                    .enumerate()
                    .map(|(index, operation)| {
                        mutate_node_in_tx(tx, &database_id, operation, now)
                            .map_err(|error| error.with_failed_index(index))
                    })
                    .collect()
            },
        )
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
            .unwrap_or_else(|| "/".to_string());
        let node_type = request.node_type.unwrap_or(GlobNodeType::Any);
        self.read_conn(|conn| {
            let rows = load_scoped_entry_rows(conn, &prefix, None)?;
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
        })
    }

    pub fn multi_edit_node(
        &self,
        request: MultiEditNodeRequest,
        now: i64,
    ) -> Result<MultiEditNodeResult, NodeMutationError> {
        self.multi_edit_node_as(request, now, "system")
    }

    pub fn multi_edit_node_as(
        &self,
        request: MultiEditNodeRequest,
        now: i64,
        author_principal: &str,
    ) -> Result<MultiEditNodeResult, NodeMutationError> {
        self.write_history_mutation_conn(None, author_principal, "multi_edit", now, None, |tx| {
            multi_edit_node_in_tx(tx, request, now)
        })
    }

    pub fn delete_node(
        &self,
        request: DeleteNodeRequest,
        now: i64,
    ) -> Result<DeleteNodeResult, NodeMutationError> {
        self.delete_node_with_publication_commit_as(request, now, None, "system")
    }

    pub fn delete_node_with_publication_commit_as(
        &self,
        request: DeleteNodeRequest,
        now: i64,
        publication_operation_id: Option<i64>,
        author_principal: &str,
    ) -> Result<DeleteNodeResult, NodeMutationError> {
        self.write_history_mutation_conn(
            publication_operation_id,
            author_principal,
            "delete",
            now,
            None,
            |tx| delete_node_in_tx(tx, request),
        )
    }

    pub fn publication_mutation_committed(&self, operation_id: i64) -> Result<bool, String> {
        self.read_conn(|conn| {
            conn.query_row(
                "SELECT 1 FROM publication_mutation_commits WHERE operation_id = ?1",
                params![operation_id],
                |row| crate::sqlite::row_get::<i64>(row, 0),
            )
            .optional()
            .map(|row| row.is_some())
            .map_err(|error| error.to_string())
        })
    }

    pub fn clear_publication_mutation_commit(&self, operation_id: i64) -> Result<(), String> {
        self.write_conn(|tx| {
            tx.execute(
                "DELETE FROM publication_mutation_commits WHERE operation_id = ?1",
                params![operation_id],
            )
            .map(|_| ())
            .map_err(|error| error.to_string())
        })
    }

    pub fn incoming_links(&self, request: IncomingLinksRequest) -> Result<Vec<LinkEdge>, String> {
        let path = normalize_node_path(&request.path, false)?;
        self.read_conn(|conn| load_incoming_links(conn, &path, capped_query_limit(request.limit)))
    }

    pub fn outgoing_links(&self, request: OutgoingLinksRequest) -> Result<Vec<LinkEdge>, String> {
        let path = normalize_node_path(&request.path, false)?;
        self.read_conn(|conn| load_outgoing_links(conn, &path, capped_query_limit(request.limit)))
    }

    pub fn graph_links(&self, request: GraphLinksRequest) -> Result<Vec<LinkEdge>, String> {
        let prefix = normalize_node_path(&request.prefix, true)?;
        self.read_conn(|conn| load_graph_links(conn, &prefix, capped_query_limit(request.limit)))
    }

    pub fn graph_neighborhood(
        &self,
        request: GraphNeighborhoodRequest,
    ) -> Result<Vec<LinkEdge>, String> {
        let center_path = normalize_node_path(&request.center_path, false)?;
        self.read_conn(|conn| {
            load_graph_neighborhood(
                conn,
                &center_path,
                request.depth,
                capped_query_limit(request.limit),
            )
        })
    }

    pub fn search_nodes(&self, request: SearchNodesRequest) -> Result<Vec<SearchNodeHit>, String> {
        let prefix = request
            .prefix
            .as_ref()
            .map(|value| normalize_node_path(value, true))
            .transpose()?;
        let plan = build_search_query_plan(&request.query_text)
            .ok_or_else(|| "query_text must not be empty".to_string())?;
        self.read_conn(|conn| {
            let top_k = capped_query_limit(request.top_k);
            let preview_mode = request.preview_mode.unwrap_or(SearchPreviewMode::Light);
            let mut candidates = if fs_search_bench::stage_enabled(SearchBenchStage::FtsCandidates)
            {
                load_ranked_fts_candidates(conn, &plan, prefix.as_deref(), top_k)?
                    .into_iter()
                    .map(|candidate| (candidate.row_id, candidate))
                    .collect::<std::collections::BTreeMap<_, _>>()
            } else {
                std::collections::BTreeMap::new()
            };
            if fs_search_bench::stage_enabled(SearchBenchStage::ContentSubstringCandidates) {
                for candidate in
                    load_content_substring_candidates(conn, &plan, prefix.as_deref(), top_k)?
                {
                    candidates.entry(candidate.row_id).or_insert(candidate);
                }
            }
            let path_hits = if fs_search_bench::stage_enabled(SearchBenchStage::PathCandidates) {
                load_path_candidates(conn, &plan.path_terms, prefix.as_deref(), top_k)?
            } else {
                Vec::new()
            };
            let mut ranked = if fs_search_bench::stage_enabled(SearchBenchStage::RerankAdjustment) {
                rerank_candidates(candidates, &plan, path_hits)
            } else {
                sort_candidates(candidates.into_values().collect())
            };
            ranked.truncate(top_k as usize);
            build_previews_for_hits(conn, &mut ranked, &plan, preview_mode)?;
            Ok(finalize_hits(ranked, top_k))
        })
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
        self.read_conn(|conn| {
            let top_k = capped_query_limit(request.top_k);
            let preview_mode = request.preview_mode.unwrap_or(SearchPreviewMode::None);
            let mut sql = String::from(
                "SELECT id,
                    path,
                    kind,
                    instr(lower(path), ?1) AS first_match_position,
                    length(path) AS path_length
             FROM fs_nodes
             WHERE 1 = 1",
            );
            let mut values = vec![crate::sqlite::types::Value::from(terms[0].clone())];
            for term in &terms {
                let index = values.len() + 1;
                sql.push_str(&format!(" AND instr(lower(path), ?{index}) > 0"));
                values.push(crate::sqlite::types::Value::from(term.clone()));
            }
            if let Some(prefix) = prefix.filter(|value| value != "/") {
                let (scope_sql, scope_values) =
                    prefix_filter_sql_for_column("fs_nodes.path", &prefix, values.len() + 1);
                sql.push_str(&scope_sql);
                values.extend(scope_values);
            }
            sql.push_str(&format!(
                " ORDER BY first_match_position ASC, path_length ASC, path ASC LIMIT {top_k}"
            ));
            let mut stmt = conn.prepare(&sql).map_err(|error| error.to_string())?;
            let mut candidates = crate::sqlite::query_map(
                &mut stmt,
                crate::sqlite::params_from_values(&values),
                |row| {
                    let path = crate::sqlite::row_get::<String>(row, 1)?;
                    let first_match_position = crate::sqlite::row_get::<i64>(row, 3)?;
                    let path_length = crate::sqlite::row_get::<i64>(row, 4)?;
                    let title = file_search_title(&path).to_lowercase();
                    let lowered_query = request.query_text.to_lowercase();
                    let mut match_reasons = BTreeSet::from(["path_substring".to_string()]);
                    if title == lowered_query {
                        match_reasons.insert("basename_exact".to_string());
                    } else if title.starts_with(&lowered_query) {
                        match_reasons.insert("basename_prefix".to_string());
                    }
                    Ok(SearchCandidate {
                        row_id: crate::sqlite::row_get::<i64>(row, 0)?,
                        path: path.clone(),
                        kind: node_kind_from_db(&crate::sqlite::row_get::<String>(row, 2)?)?,
                        snippet: Some(path),
                        preview: None,
                        score: path_match_score(first_match_position, path_length),
                        match_reasons,
                        has_content_match: false,
                    })
                },
            )
            .map_err(|error| error.to_string())?;
            build_previews_for_hits(
                conn,
                &mut candidates,
                &build_search_query_plan(&request.query_text)
                    .expect("path terms already validated"),
                preview_mode,
            )?;
            Ok(finalize_hits(candidates, top_k))
        })
    }

    fn read_conn<T>(&self, f: impl FnOnce(&Connection) -> Result<T, String>) -> Result<T, String> {
        #[cfg(not(target_arch = "wasm32"))]
        {
            let conn = self.open()?;
            f(&conn)
        }
        #[cfg(target_arch = "wasm32")]
        {
            self.handle
                .query(|conn| f(conn).map_err(|error| DbError::Sqlite(1, error)))
                .map_err(|error| error.to_string())
        }
    }

    fn write_conn<T>(
        &self,
        f: impl FnOnce(&Transaction<'_>) -> Result<T, String>,
    ) -> Result<T, String> {
        #[cfg(not(target_arch = "wasm32"))]
        {
            let mut conn = self.open()?;
            let tx = conn.transaction().map_err(|error| error.to_string())?;
            let value = f(&tx)?;
            tx.commit().map_err(|error| error.to_string())?;
            Ok(value)
        }
        #[cfg(target_arch = "wasm32")]
        {
            self.handle
                .update(|tx| f(tx).map_err(|error| DbError::Sqlite(1, error)))
                .map_err(|error| error.to_string())
        }
    }

    fn write_mutation_conn_with_publication_commit<T>(
        &self,
        publication_operation_id: Option<i64>,
        f: impl FnOnce(&Transaction<'_>) -> Result<T, NodeMutationError>,
    ) -> Result<T, NodeMutationError> {
        #[cfg(not(target_arch = "wasm32"))]
        {
            let mut conn = self.open().map_err(NodeMutationError::write_unavailable)?;
            let tx = conn
                .transaction()
                .map_err(|error| NodeMutationError::write_unavailable(error.to_string()))?;
            let value = f(&tx)?;
            if let Some(operation_id) = publication_operation_id {
                record_publication_mutation_commit(&tx, operation_id)
                    .map_err(NodeMutationError::write_unavailable)?;
            }
            tx.commit()
                .map_err(|error| NodeMutationError::write_unavailable(error.to_string()))?;
            Ok(value)
        }
        #[cfg(target_arch = "wasm32")]
        {
            let mut mutation_error = None;
            let result = self.handle.update(|tx| {
                match f(tx).and_then(|value| {
                    if let Some(operation_id) = publication_operation_id {
                        record_publication_mutation_commit(tx, operation_id)
                            .map_err(NodeMutationError::write_unavailable)?;
                    }
                    Ok(value)
                }) {
                    Ok(value) => Ok(value),
                    Err(error) => {
                        mutation_error = Some(error);
                        Err(DbError::Sqlite(1, "node mutation aborted".to_string()))
                    }
                }
            });
            if let Some(error) = mutation_error {
                return Err(error);
            }
            result.map_err(|error| NodeMutationError::write_unavailable(error.to_string()))
        }
    }

    fn write_history_mutation_conn<T>(
        &self,
        publication_operation_id: Option<i64>,
        author_principal: &str,
        operation: &str,
        changed_at: i64,
        forced_kind: Option<&str>,
        f: impl FnOnce(&Transaction<'_>) -> Result<T, NodeMutationError>,
    ) -> Result<T, NodeMutationError> {
        self.write_history_mutation_conn_with_preflight(
            publication_operation_id,
            author_principal,
            operation,
            changed_at,
            forced_kind,
            |_| Ok(()),
            f,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn write_history_mutation_conn_with_preflight<T>(
        &self,
        publication_operation_id: Option<i64>,
        author_principal: &str,
        operation: &str,
        changed_at: i64,
        forced_kind: Option<&str>,
        preflight: impl FnOnce(&Transaction<'_>) -> Result<(), NodeMutationError>,
        f: impl FnOnce(&Transaction<'_>) -> Result<T, NodeMutationError>,
    ) -> Result<T, NodeMutationError> {
        self.write_mutation_conn_with_publication_commit(publication_operation_id, |tx| {
            preflight(tx)?;
            let change_id = history::begin_change(
                tx,
                author_principal,
                operation,
                changed_at,
                forced_kind,
                None,
            )
            .map_err(NodeMutationError::write_unavailable)?;
            let value = f(tx)?;
            history::finish_change(tx, change_id).map_err(NodeMutationError::write_unavailable)?;
            Ok(value)
        })
    }

    #[cfg(not(target_arch = "wasm32"))]
    fn open(&self) -> Result<Connection, String> {
        Connection::open(&self.database_path).map_err(|error| error.to_string())
    }
}

fn append_node_in_tx(
    tx: &Transaction<'_>,
    request: AppendNodeRequest,
    now: i64,
) -> Result<WriteNodeResult, NodeMutationError> {
    let path =
        normalize_node_path(&request.path, false).map_err(NodeMutationError::invalid_operation)?;
    let existing = load_stored_node(tx, &path).map_err(NodeMutationError::write_unavailable)?;
    if existing
        .as_ref()
        .is_some_and(|stored| stored.node.kind == NodeKind::Folder)
    {
        return Err(NodeMutationError::invalid_operation(format!(
            "cannot append to folder: {path}"
        )));
    }
    let created = existing.is_none();
    let mut node = match existing.as_ref() {
        Some(current) => append_existing_node(current.node.clone(), request, now)?,
        None if request.expected_etag.is_some() => {
            return Err(NodeMutationError::not_found(&path));
        }
        None => create_appended_node(path, request, now)
            .map_err(NodeMutationError::invalid_operation)?,
    };
    let change_kind = if created { "create" } else { "update" };
    let changed_bytes = crate::git_repository::node_mutation_bytes(
        change_kind,
        existing.as_ref().map(|stored| &stored.node),
        Some(&node),
    )
    .map_err(NodeMutationError::invalid_operation)?;
    crate::git_repository::validate_mutation_budget(1, changed_bytes)
        .map_err(NodeMutationError::invalid_operation)?;
    ensure_missing_store_root_for_path(tx, &node.path, now)
        .map_err(NodeMutationError::write_unavailable)?;
    require_parent_folder_for_mutation(tx, &node.path)?;
    let revision = record_change(tx, &node).map_err(NodeMutationError::write_unavailable)?;
    update_path_state(tx, &node.path, revision).map_err(NodeMutationError::write_unavailable)?;
    node.etag = compute_node_etag(&node);
    let row_id = save_node(tx, existing.as_ref().map(|stored| stored.row_id), &node)
        .map_err(NodeMutationError::write_unavailable)?;
    sync_node_fts(tx, existing.as_ref(), Some((row_id, &node)))
        .map_err(NodeMutationError::write_unavailable)?;
    sync_node_links(tx, &node).map_err(NodeMutationError::write_unavailable)?;
    Ok(WriteNodeResult {
        node: node_ack(&node),
        created,
    })
}

fn edit_node_in_tx(
    tx: &Transaction<'_>,
    request: EditNodeRequest,
    now: i64,
) -> Result<EditNodeResult, NodeMutationError> {
    if request.old_text.is_empty() {
        return Err(NodeMutationError::invalid_operation(
            "old_text must not be empty",
        ));
    }
    let path =
        normalize_node_path(&request.path, false).map_err(NodeMutationError::invalid_operation)?;
    let current = load_stored_node(tx, &path)
        .map_err(NodeMutationError::write_unavailable)?
        .ok_or_else(|| NodeMutationError::not_found(&path))?;
    if current.node.kind == NodeKind::Folder {
        return Err(NodeMutationError::invalid_operation(format!(
            "cannot edit folder: {path}"
        )));
    }
    if current.node.etag != request.expected_etag.unwrap_or_default() {
        return Err(NodeMutationError::etag_conflict(
            format!("expected_etag does not match current etag: {path}"),
            path,
        ));
    }
    let (content, replacement_count) = replace_text(
        &current.node.content,
        &request.old_text,
        &request.new_text,
        request.replace_all,
    )
    .map_err(NodeMutationError::invalid_operation)?;
    let mut node = current.node.clone();
    node.content = content;
    node.updated_at = now;
    let changed_bytes =
        crate::git_repository::node_mutation_bytes("update", Some(&current.node), Some(&node))
            .map_err(NodeMutationError::invalid_operation)?;
    crate::git_repository::validate_mutation_budget(1, changed_bytes)
        .map_err(NodeMutationError::invalid_operation)?;
    let revision = record_change(tx, &node).map_err(NodeMutationError::write_unavailable)?;
    update_path_state(tx, &node.path, revision).map_err(NodeMutationError::write_unavailable)?;
    node.etag = compute_node_etag(&node);
    save_node(tx, Some(current.row_id), &node).map_err(NodeMutationError::write_unavailable)?;
    sync_node_fts(tx, Some(&current), Some((current.row_id, &node)))
        .map_err(NodeMutationError::write_unavailable)?;
    sync_node_links(tx, &node).map_err(NodeMutationError::write_unavailable)?;
    Ok(EditNodeResult {
        node: node_ack(&node),
        replacement_count,
    })
}

fn mkdir_node_in_tx(
    tx: &Transaction<'_>,
    request: MkdirNodeRequest,
    now: i64,
) -> Result<MkdirNodeResult, NodeMutationError> {
    let path =
        normalize_node_path(&request.path, false).map_err(NodeMutationError::invalid_operation)?;
    if let Some(existing) =
        load_stored_node(tx, &path).map_err(NodeMutationError::write_unavailable)?
    {
        if existing.node.kind == NodeKind::Folder {
            return Ok(MkdirNodeResult {
                path,
                created: false,
            });
        }
        return Err(NodeMutationError::invalid_operation(format!(
            "node already exists and is not a folder: {path}"
        )));
    }
    if is_protected_root_folder(&path) {
        ensure_store_root_folder(tx, &path, now).map_err(NodeMutationError::write_unavailable)?;
        return Ok(MkdirNodeResult {
            path,
            created: true,
        });
    }
    let mut node = Node {
        path: path.clone(),
        kind: NodeKind::Folder,
        content: String::new(),
        created_at: now,
        updated_at: now,
        etag: String::new(),
        metadata_json: "{}".to_string(),
    };
    let changed_bytes = crate::git_repository::node_mutation_bytes("create", None, Some(&node))
        .map_err(NodeMutationError::invalid_operation)?;
    crate::git_repository::validate_mutation_budget(1, changed_bytes)
        .map_err(NodeMutationError::invalid_operation)?;
    ensure_missing_store_root_for_path(tx, &node.path, now)
        .map_err(NodeMutationError::write_unavailable)?;
    require_parent_folder_for_mutation(tx, &node.path)?;
    let revision = record_change(tx, &node).map_err(NodeMutationError::write_unavailable)?;
    update_path_state(tx, &node.path, revision).map_err(NodeMutationError::write_unavailable)?;
    node.etag = compute_node_etag(&node);
    save_node(tx, None, &node).map_err(NodeMutationError::write_unavailable)?;
    Ok(MkdirNodeResult {
        path,
        created: true,
    })
}

fn multi_edit_node_in_tx(
    tx: &Transaction<'_>,
    request: MultiEditNodeRequest,
    now: i64,
) -> Result<MultiEditNodeResult, NodeMutationError> {
    let path =
        normalize_node_path(&request.path, false).map_err(NodeMutationError::invalid_operation)?;
    if request.edits.is_empty() {
        return Err(NodeMutationError::invalid_operation(
            "edits must not be empty",
        ));
    }
    let current = load_stored_node(tx, &path)
        .map_err(NodeMutationError::write_unavailable)?
        .ok_or_else(|| NodeMutationError::not_found(&path))?;
    if current.node.kind == NodeKind::Folder {
        return Err(NodeMutationError::invalid_operation(format!(
            "cannot edit folder: {path}"
        )));
    }
    if current.node.etag != request.expected_etag.unwrap_or_default() {
        return Err(NodeMutationError::etag_conflict(
            format!("expected_etag does not match current etag: {path}"),
            path,
        ));
    }
    let (content, replacement_count) = apply_multi_edit(&current.node.content, &request.edits)
        .map_err(NodeMutationError::invalid_operation)?;
    let mut node = current.node.clone();
    node.content = content;
    node.updated_at = now;
    let changed_bytes =
        crate::git_repository::node_mutation_bytes("update", Some(&current.node), Some(&node))
            .map_err(NodeMutationError::invalid_operation)?;
    crate::git_repository::validate_mutation_budget(1, changed_bytes)
        .map_err(NodeMutationError::invalid_operation)?;
    let revision = record_change(tx, &node).map_err(NodeMutationError::write_unavailable)?;
    update_path_state(tx, &node.path, revision).map_err(NodeMutationError::write_unavailable)?;
    node.etag = compute_node_etag(&node);
    save_node(tx, Some(current.row_id), &node).map_err(NodeMutationError::write_unavailable)?;
    sync_node_fts(tx, Some(&current), Some((current.row_id, &node)))
        .map_err(NodeMutationError::write_unavailable)?;
    sync_node_links(tx, &node).map_err(NodeMutationError::write_unavailable)?;
    Ok(MultiEditNodeResult {
        node: node_ack(&node),
        replacement_count,
    })
}

fn delete_node_in_tx(
    tx: &Transaction<'_>,
    request: DeleteNodeRequest,
) -> Result<DeleteNodeResult, NodeMutationError> {
    let path =
        normalize_node_path(&request.path, false).map_err(NodeMutationError::invalid_operation)?;
    let current = load_stored_node(tx, &path)
        .map_err(NodeMutationError::write_unavailable)?
        .ok_or_else(|| NodeMutationError::not_found(&path))?;
    if current.node.etag != request.expected_etag.unwrap_or_default() {
        return Err(NodeMutationError::etag_conflict(
            format!("expected_etag does not match current etag: {path}"),
            path.clone(),
        ));
    }
    let folder_index = if current.node.kind == NodeKind::Folder {
        if is_protected_root_folder(&path) {
            return Err(NodeMutationError::invalid_operation(format!(
                "cannot delete protected folder: {path}"
            )));
        }
        let index_path = folder_index_path(&path);
        let index_node = load_folder_index_child(tx, current.row_id, &index_path)
            .map_err(NodeMutationError::write_unavailable)?;
        if has_visible_folder_children(tx, current.row_id, &index_path)
            .map_err(NodeMutationError::write_unavailable)?
        {
            return Err(NodeMutationError::invalid_operation(format!(
                "folder is not empty: {path}"
            )));
        }
        match index_node {
            Some(index_node) => {
                let expected_index_etag = request
                    .expected_folder_index_etag
                    .as_deref()
                    .ok_or_else(|| {
                        NodeMutationError::invalid_operation(format!(
                            "expected_folder_index_etag is required: {index_path}"
                        ))
                    })?;
                if index_node.node.etag != expected_index_etag {
                    return Err(NodeMutationError::etag_conflict(
                        format!(
                            "expected_folder_index_etag does not match current etag: {index_path}"
                        ),
                        index_path,
                    ));
                }
                Some(index_node)
            }
            None if request.expected_folder_index_etag.is_some() => {
                return Err(NodeMutationError::not_found(&index_path));
            }
            None => None,
        }
    } else if request.expected_folder_index_etag.is_some() {
        return Err(NodeMutationError::invalid_operation(format!(
            "expected_folder_index_etag is only valid for folder deletes: {path}"
        )));
    } else {
        None
    };
    let mut changed_bytes =
        crate::git_repository::node_mutation_bytes("delete", Some(&current.node), None)
            .map_err(NodeMutationError::invalid_operation)?;
    if let Some(index_node) = folder_index.as_ref() {
        changed_bytes = changed_bytes
            .checked_add(
                crate::git_repository::node_mutation_bytes("delete", Some(&index_node.node), None)
                    .map_err(NodeMutationError::invalid_operation)?,
            )
            .ok_or_else(|| {
                NodeMutationError::invalid_operation("Git mutation byte length is too large")
            })?;
    }
    crate::git_repository::validate_mutation_budget(
        if folder_index.is_some() { 2 } else { 1 },
        changed_bytes,
    )
    .map_err(NodeMutationError::invalid_operation)?;
    if let Some(index_node) = folder_index.as_ref() {
        delete_node_with_history(tx, index_node).map_err(NodeMutationError::write_unavailable)?;
    }
    delete_node_with_history(tx, &current).map_err(NodeMutationError::write_unavailable)?;
    Ok(DeleteNodeResult { path })
}

fn move_node_in_tx(
    tx: &Transaction<'_>,
    request: MoveNodeRequest,
    now: i64,
) -> Result<MoveNodeResult, NodeMutationError> {
    let from_path = normalize_node_path(&request.from_path, false)
        .map_err(NodeMutationError::invalid_operation)?;
    let to_path = normalize_node_path(&request.to_path, false)
        .map_err(NodeMutationError::invalid_operation)?;
    if from_path == to_path {
        return Err(NodeMutationError::invalid_operation(
            "from_path and to_path must differ",
        ));
    }
    let current = load_stored_node(tx, &from_path)
        .map_err(NodeMutationError::write_unavailable)?
        .ok_or_else(|| NodeMutationError::not_found(&from_path))?;
    if current.node.etag != request.expected_etag.unwrap_or_default() {
        return Err(NodeMutationError::etag_conflict(
            format!("expected_etag does not match current etag: {from_path}"),
            from_path.clone(),
        ));
    }
    if current.node.kind == NodeKind::Folder {
        if is_protected_root_folder(&from_path) {
            return Err(NodeMutationError::invalid_operation(format!(
                "cannot move protected folder: {from_path}"
            )));
        }
        if to_path.starts_with(&format!("{from_path}/")) {
            return Err(NodeMutationError::invalid_operation(
                "cannot move folder into itself",
            ));
        }
    }
    let target = load_stored_node(tx, &to_path).map_err(NodeMutationError::write_unavailable)?;
    let overwrote = target.is_some();
    if !request.overwrite && request.expected_target_etag.is_some() {
        return Err(NodeMutationError::invalid_operation_with_path(
            "expected_target_etag requires overwrite=true",
            to_path,
        ));
    }
    if current.node.kind == NodeKind::Folder && overwrote {
        return Err(NodeMutationError::invalid_operation(format!(
            "target node already exists: {to_path}"
        )));
    }
    if overwrote && !request.overwrite {
        return Err(NodeMutationError::invalid_operation(format!(
            "target node already exists: {to_path}"
        )));
    }
    match (target.as_ref(), request.expected_target_etag.as_deref()) {
        (Some(target), Some(expected_target_etag))
            if request.overwrite && target.node.etag != expected_target_etag =>
        {
            return Err(NodeMutationError::etag_conflict(
                format!("expected_target_etag does not match current etag: {to_path}"),
                to_path,
            ));
        }
        (Some(_), None) if request.overwrite => {
            return Err(NodeMutationError::invalid_operation_with_path(
                format!("expected_target_etag is required to overwrite target: {to_path}"),
                to_path,
            ));
        }
        (None, Some(_)) if request.overwrite => {
            return Err(NodeMutationError::not_found_with_path(
                format!("target node does not exist: {to_path}"),
                to_path,
            ));
        }
        _ => {}
    }
    if target
        .as_ref()
        .is_some_and(|stored| stored.node.kind == NodeKind::Folder)
    {
        return Err(NodeMutationError::invalid_operation(format!(
            "cannot overwrite folder: {to_path}"
        )));
    }
    if current.node.kind == NodeKind::Folder {
        validate_folder_move_budget(tx, &from_path, &to_path)?;
    } else {
        let mut moved_preview = current.node.clone();
        moved_preview.path = to_path.clone();
        let mut changed_bytes = crate::git_repository::node_mutation_bytes(
            "move",
            Some(&current.node),
            Some(&moved_preview),
        )
        .map_err(NodeMutationError::invalid_operation)?;
        if let Some(target) = target.as_ref() {
            changed_bytes = changed_bytes
                .checked_add(
                    crate::git_repository::node_mutation_bytes("delete", Some(&target.node), None)
                        .map_err(NodeMutationError::invalid_operation)?,
                )
                .ok_or_else(|| {
                    NodeMutationError::invalid_operation("Git mutation byte length is too large")
                })?;
        }
        crate::git_repository::validate_mutation_budget(
            if target.is_some() { 2 } else { 1 },
            changed_bytes,
        )
        .map_err(NodeMutationError::invalid_operation)?;
    }
    ensure_missing_store_root_for_path(tx, &to_path, now)
        .map_err(NodeMutationError::write_unavailable)?;
    require_parent_folder_for_mutation(tx, &to_path)?;
    if current.node.kind == NodeKind::Folder {
        let subtree =
            load_move_subtree(tx, &from_path).map_err(NodeMutationError::write_unavailable)?;
        for stored in &subtree {
            let next_path = rebase_path(&stored.path, &from_path, &to_path)
                .map_err(NodeMutationError::invalid_operation)?;
            if next_path != stored.path
                && load_stored_node(tx, &next_path)
                    .map_err(NodeMutationError::write_unavailable)?
                    .is_some()
            {
                return Err(NodeMutationError::invalid_operation(format!(
                    "target node already exists: {next_path}"
                )));
            }
        }
        for stored in subtree {
            let old_path = stored.path;
            let moved_path = rebase_path(&old_path, &from_path, &to_path)
                .map_err(NodeMutationError::invalid_operation)?;
            let from_revision =
                record_path_removal(tx, &old_path).map_err(NodeMutationError::write_unavailable)?;
            update_path_state(tx, &old_path, from_revision)
                .map_err(NodeMutationError::write_unavailable)?;
            let to_revision = record_change_path(tx, &moved_path)
                .map_err(NodeMutationError::write_unavailable)?;
            update_path_state(tx, &moved_path, to_revision)
                .map_err(NodeMutationError::write_unavailable)?;
            let moved_etag = compute_moved_node_etag(&stored.etag, &moved_path);
            save_moved_node(tx, stored.row_id, &moved_path, now, &moved_etag)
                .map_err(NodeMutationError::write_unavailable)?;
            move_source_links(tx, &old_path, &moved_path, now)
                .map_err(NodeMutationError::write_unavailable)?;
        }
        let moved = load_node(tx, &to_path)
            .map_err(NodeMutationError::write_unavailable)?
            .ok_or_else(|| {
                NodeMutationError::write_unavailable(format!(
                    "node does not exist after move: {to_path}"
                ))
            })?;
        return Ok(MoveNodeResult {
            node: node_ack(&moved),
            from_path,
            overwrote: false,
        });
    }
    if let Some(target) = target.as_ref() {
        delete_source_links(tx, &target.node.path).map_err(NodeMutationError::write_unavailable)?;
        delete_node_row(tx, target).map_err(NodeMutationError::write_unavailable)?;
    }
    let mut moved = current.node.clone();
    moved.path = to_path.clone();
    moved.updated_at = now;
    let from_revision =
        record_path_removal(tx, &from_path).map_err(NodeMutationError::write_unavailable)?;
    update_path_state(tx, &from_path, from_revision)
        .map_err(NodeMutationError::write_unavailable)?;
    let to_revision = record_change(tx, &moved).map_err(NodeMutationError::write_unavailable)?;
    update_path_state(tx, &to_path, to_revision).map_err(NodeMutationError::write_unavailable)?;
    moved.etag = compute_node_etag(&moved);
    save_moved_node(
        tx,
        current.row_id,
        &moved.path,
        moved.updated_at,
        &moved.etag,
    )
    .map_err(NodeMutationError::write_unavailable)?;
    move_source_links(tx, &from_path, &moved.path, now)
        .map_err(NodeMutationError::write_unavailable)?;
    Ok(MoveNodeResult {
        node: node_ack(&moved),
        from_path,
        overwrote,
    })
}

fn mutate_node_in_tx(
    tx: &Transaction<'_>,
    database_id: &str,
    operation: NodeMutation,
    now: i64,
) -> Result<NodeMutationResult, NodeMutationError> {
    match operation {
        NodeMutation::Write(item) => {
            write_node_item_in_tx(tx, database_id, item, now).map(NodeMutationResult::Write)
        }
        NodeMutation::Append(item) => append_node_in_tx(
            tx,
            AppendNodeRequest {
                database_id: database_id.to_string(),
                path: item.path,
                content: item.content,
                expected_etag: item.expected_etag,
                separator: item.separator,
                metadata_json: item.metadata_json,
                kind: item.kind,
            },
            now,
        )
        .map(NodeMutationResult::Append),
        NodeMutation::Edit(item) => edit_node_in_tx(
            tx,
            EditNodeRequest {
                database_id: database_id.to_string(),
                path: item.path,
                old_text: item.old_text,
                new_text: item.new_text,
                expected_etag: item.expected_etag,
                replace_all: item.replace_all,
            },
            now,
        )
        .map(NodeMutationResult::Edit),
        NodeMutation::MultiEdit(item) => multi_edit_node_in_tx(
            tx,
            MultiEditNodeRequest {
                database_id: database_id.to_string(),
                path: item.path,
                edits: item.edits,
                expected_etag: item.expected_etag,
            },
            now,
        )
        .map(NodeMutationResult::MultiEdit),
        NodeMutation::Mkdir(path) => mkdir_node_in_tx(
            tx,
            MkdirNodeRequest {
                database_id: database_id.to_string(),
                path,
            },
            now,
        )
        .map(NodeMutationResult::Mkdir),
        NodeMutation::Move(item) => move_node_in_tx(
            tx,
            MoveNodeRequest {
                database_id: database_id.to_string(),
                from_path: item.from_path,
                to_path: item.to_path,
                expected_etag: item.expected_etag,
                expected_target_etag: item.expected_target_etag,
                overwrite: item.overwrite,
            },
            now,
        )
        .map(NodeMutationResult::Move),
        NodeMutation::Delete(item) => delete_node_in_tx(
            tx,
            DeleteNodeRequest {
                database_id: database_id.to_string(),
                path: item.path,
                expected_etag: item.expected_etag,
                expected_folder_index_etag: item.expected_folder_index_etag,
            },
        )
        .map(NodeMutationResult::Delete),
    }
}

fn record_change(tx: &Transaction<'_>, node: &Node) -> Result<i64, String> {
    record_change_path(tx, &node.path)
}

fn record_change_path(tx: &Transaction<'_>, path: &str) -> Result<i64, String> {
    tx.execute(
        "INSERT INTO fs_change_log (path, change_kind) VALUES (?1, ?2)",
        params![path, ChangeKind::Upsert.as_str()],
    )
    .map_err(|error| error.to_string())?;
    crate::sqlite::last_insert_rowid(tx).map_err(|error| error.to_string())
}

fn record_publication_mutation_commit(
    tx: &Transaction<'_>,
    operation_id: i64,
) -> Result<(), String> {
    tx.execute(
        "INSERT INTO publication_mutation_commits (operation_id) VALUES (?1)",
        params![operation_id],
    )
    .map(|_| ())
    .map_err(|error| error.to_string())
}

fn write_node_in_tx(
    tx: &Transaction<'_>,
    request: WriteNodeRequest,
    now: i64,
) -> Result<WriteNodeResult, NodeMutationError> {
    let path =
        normalize_node_path(&request.path, false).map_err(NodeMutationError::invalid_operation)?;
    if request.kind == NodeKind::Folder {
        return write_folder_in_tx(
            tx,
            path,
            request.content,
            request.metadata_json,
            request.expected_etag,
            now,
        );
    }
    let existing = load_stored_node(tx, &path).map_err(NodeMutationError::write_unavailable)?;
    if existing
        .as_ref()
        .is_some_and(|stored| stored.node.kind == NodeKind::Folder)
    {
        return Err(NodeMutationError::invalid_operation(format!(
            "cannot overwrite folder with file node: {path}"
        )));
    }
    let created = existing.is_none();
    let mut node = match existing.as_ref() {
        Some(current) => update_existing_node(current.node.clone(), request, now)?,
        None if request.expected_etag.is_some() => {
            return Err(NodeMutationError::not_found(&path));
        }
        None => {
            create_new_node(path, request, now).map_err(NodeMutationError::invalid_operation)?
        }
    };
    let change_kind = if created { "create" } else { "update" };
    let changed_bytes = crate::git_repository::node_mutation_bytes(
        change_kind,
        existing.as_ref().map(|stored| &stored.node),
        Some(&node),
    )
    .map_err(NodeMutationError::invalid_operation)?;
    crate::git_repository::validate_mutation_budget(1, changed_bytes)
        .map_err(NodeMutationError::invalid_operation)?;
    ensure_missing_store_root_for_path(tx, &node.path, now)
        .map_err(NodeMutationError::write_unavailable)?;
    require_parent_folder_for_mutation(tx, &node.path)?;
    let revision = record_change(tx, &node).map_err(NodeMutationError::write_unavailable)?;
    update_path_state(tx, &node.path, revision).map_err(NodeMutationError::write_unavailable)?;
    node.etag = compute_node_etag(&node);
    let row_id = save_node(tx, existing.as_ref().map(|stored| stored.row_id), &node)
        .map_err(NodeMutationError::write_unavailable)?;
    sync_node_fts(tx, existing.as_ref(), Some((row_id, &node)))
        .map_err(NodeMutationError::write_unavailable)?;
    sync_node_links(tx, &node).map_err(NodeMutationError::write_unavailable)?;
    Ok(WriteNodeResult {
        node: node_ack(&node),
        created,
    })
}

fn write_node_request_from_item(database_id: &str, item: WriteNodeItem) -> WriteNodeRequest {
    WriteNodeRequest {
        database_id: database_id.to_string(),
        path: item.path,
        kind: item.kind,
        content: item.content,
        metadata_json: item.metadata_json,
        expected_etag: item.expected_etag,
    }
}

fn write_node_item_in_tx(
    tx: &Transaction<'_>,
    database_id: &str,
    item: WriteNodeItem,
    now: i64,
) -> Result<WriteNodeResult, NodeMutationError> {
    write_node_in_tx(tx, write_node_request_from_item(database_id, item), now)
}

fn write_folder_in_tx(
    tx: &Transaction<'_>,
    path: String,
    content: String,
    metadata_json: String,
    expected_etag: Option<String>,
    now: i64,
) -> Result<WriteNodeResult, NodeMutationError> {
    if expected_etag.is_some() {
        return Err(NodeMutationError::invalid_operation(format!(
            "expected_etag must be None for folder item: {path}"
        )));
    }
    if !content.is_empty() {
        return Err(NodeMutationError::invalid_operation(format!(
            "folder item content must be empty: {path}"
        )));
    }
    if metadata_json.trim() != "{}" {
        return Err(NodeMutationError::invalid_operation(format!(
            "folder item metadata_json must be empty object: {path}"
        )));
    }
    if let Some(existing) =
        load_stored_node(tx, &path).map_err(NodeMutationError::write_unavailable)?
    {
        if existing.node.kind == NodeKind::Folder {
            return Ok(WriteNodeResult {
                node: node_ack(&existing.node),
                created: false,
            });
        }
        return Err(NodeMutationError::invalid_operation(format!(
            "node already exists and is not a folder: {path}"
        )));
    }
    if is_protected_root_folder(&path) {
        ensure_store_root_folder(tx, &path, now).map_err(NodeMutationError::write_unavailable)?;
        let stored = load_stored_node(tx, &path)
            .map_err(NodeMutationError::write_unavailable)?
            .ok_or_else(|| {
                NodeMutationError::write_unavailable(format!("folder was not created: {path}"))
            })?;
        return Ok(WriteNodeResult {
            node: node_ack(&stored.node),
            created: true,
        });
    }
    let mut node = Node {
        path,
        kind: NodeKind::Folder,
        content: String::new(),
        created_at: now,
        updated_at: now,
        etag: String::new(),
        metadata_json: "{}".to_string(),
    };
    let changed_bytes = crate::git_repository::node_mutation_bytes("create", None, Some(&node))
        .map_err(NodeMutationError::invalid_operation)?;
    crate::git_repository::validate_mutation_budget(1, changed_bytes)
        .map_err(NodeMutationError::invalid_operation)?;
    ensure_missing_store_root_for_path(tx, &node.path, now)
        .map_err(NodeMutationError::write_unavailable)?;
    require_parent_folder_for_mutation(tx, &node.path)?;
    let revision = record_change(tx, &node).map_err(NodeMutationError::write_unavailable)?;
    update_path_state(tx, &node.path, revision).map_err(NodeMutationError::write_unavailable)?;
    node.etag = compute_node_etag(&node);
    save_node(tx, None, &node).map_err(NodeMutationError::write_unavailable)?;
    Ok(WriteNodeResult {
        node: node_ack(&node),
        created: true,
    })
}

fn validate_write_nodes_count(count: usize) -> Result<(), String> {
    if count == 0 || count > WRITE_NODES_BATCH_LIMIT_MAX {
        return Err(format!(
            "write_nodes node count must be between 1 and {WRITE_NODES_BATCH_LIMIT_MAX}"
        ));
    }
    Ok(())
}

fn validate_mutate_nodes_batch_count(count: usize) -> Result<(), String> {
    if count == 0 || count > MUTATE_NODES_BATCH_LIMIT_MAX {
        return Err(format!(
            "mutate_nodes_batch operation count must be between 1 and {MUTATE_NODES_BATCH_LIMIT_MAX}"
        ));
    }
    Ok(())
}

fn add_git_budget_bytes(total: &mut i64, value: &str) -> Result<(), NodeMutationError> {
    let value = i64::try_from(value.len()).map_err(|_| {
        NodeMutationError::invalid_operation("Git mutation byte length is too large")
    })?;
    *total = total.checked_add(value).ok_or_else(|| {
        NodeMutationError::invalid_operation("Git mutation byte length is too large")
    })?;
    Ok(())
}

fn preflight_write_nodes_budget(nodes: &[WriteNodeItem]) -> Result<(), NodeMutationError> {
    let mut changed_bytes = 0_i64;
    for node in nodes {
        add_git_budget_bytes(&mut changed_bytes, &node.path)?;
        add_git_budget_bytes(&mut changed_bytes, &node.content)?;
        add_git_budget_bytes(&mut changed_bytes, &node.metadata_json)?;
    }
    crate::git_repository::validate_mutation_budget(
        i64::try_from(nodes.len()).map_err(|_| {
            NodeMutationError::invalid_operation("write_nodes node count is too large")
        })?,
        changed_bytes,
    )
    .map_err(NodeMutationError::invalid_operation)
}

fn preflight_mutate_nodes_batch_budget(
    operations: &[NodeMutation],
) -> Result<(), NodeMutationError> {
    let mut changed_bytes = 0_i64;
    for (index, operation) in operations.iter().enumerate() {
        let mut operation_bytes = 0_i64;
        let result = match operation {
            NodeMutation::Write(item) => {
                add_git_budget_bytes(&mut operation_bytes, &item.path)?;
                add_git_budget_bytes(&mut operation_bytes, &item.content)?;
                add_git_budget_bytes(&mut operation_bytes, &item.metadata_json)
            }
            NodeMutation::Append(item) => {
                add_git_budget_bytes(&mut operation_bytes, &item.path)?;
                add_git_budget_bytes(&mut operation_bytes, &item.content)?;
                if let Some(metadata_json) = &item.metadata_json {
                    add_git_budget_bytes(&mut operation_bytes, metadata_json)?;
                }
                Ok(())
            }
            NodeMutation::Edit(item) => {
                add_git_budget_bytes(&mut operation_bytes, &item.path)?;
                add_git_budget_bytes(&mut operation_bytes, &item.new_text)
            }
            NodeMutation::MultiEdit(item) => {
                add_git_budget_bytes(&mut operation_bytes, &item.path)?;
                for edit in &item.edits {
                    add_git_budget_bytes(&mut operation_bytes, &edit.new_text)?;
                }
                Ok(())
            }
            NodeMutation::Mkdir(path) => add_git_budget_bytes(&mut operation_bytes, path),
            NodeMutation::Move(item) => add_git_budget_bytes(&mut operation_bytes, &item.to_path),
            NodeMutation::Delete(item) => add_git_budget_bytes(&mut operation_bytes, &item.path),
        };
        result.map_err(|error| error.with_failed_index(index))?;
        changed_bytes = changed_bytes.checked_add(operation_bytes).ok_or_else(|| {
            NodeMutationError::invalid_operation("Git mutation byte length is too large")
                .with_failed_index(index)
        })?;
        if changed_bytes > crate::git_repository::MUTATION_BYTES_MAX {
            return Err(NodeMutationError::invalid_operation(
                "Git history mutation exceeds the 1.5 MiB byte budget",
            )
            .with_failed_index(index));
        }
    }
    Ok(())
}

fn record_path_removal(tx: &Transaction<'_>, path: &str) -> Result<i64, String> {
    tx.execute(
        "INSERT INTO fs_change_log (path, change_kind) VALUES (?1, ?2)",
        params![path, ChangeKind::PathRemoval.as_str()],
    )
    .map_err(|error| error.to_string())?;
    crate::sqlite::last_insert_rowid(tx).map_err(|error| error.to_string())
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

fn delete_node_with_history(tx: &Transaction<'_>, stored: &StoredNode) -> Result<(), String> {
    let revision = record_path_removal(tx, &stored.node.path)?;
    update_path_state(tx, &stored.node.path, revision)?;
    delete_source_links(tx, &stored.node.path)?;
    delete_node_row(tx, stored)
}

fn capped_query_limit(requested: u32) -> i64 {
    i64::from(requested.clamp(1, QUERY_RESULT_LIMIT_MAX))
}

fn capped_list_nodes_limit(requested: u32) -> u32 {
    requested.clamp(1, QUERY_RESULT_LIMIT_MAX)
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

fn path_in_prefix(path: &str, prefix: &str) -> bool {
    prefix == "/" || path == prefix || path.starts_with(&format!("{prefix}/"))
}

fn page_nodes_by_limit_and_budget(
    nodes: &mut Vec<Node>,
    limit: i64,
) -> Result<Option<String>, String> {
    let limit_had_more = nodes.len() > limit as usize;
    if limit_had_more {
        nodes.truncate(limit as usize);
    }
    let mut used_bytes = sync_response_base_bytes("");
    let mut keep_len = 0_usize;
    for node in nodes.iter() {
        let item_bytes = estimated_node_response_bytes(node);
        if !sync_item_fits_budget(used_bytes, item_bytes) {
            if keep_len == 0 {
                return Err(SYNC_RESPONSE_ITEM_TOO_LARGE.to_string());
            }
            break;
        }
        used_bytes = used_bytes.saturating_add(item_bytes);
        keep_len += 1;
    }
    let budget_had_more = keep_len < nodes.len();
    if budget_had_more {
        nodes.truncate(keep_len);
    }
    if limit_had_more || budget_had_more {
        return Ok(nodes.last().map(PageCursorPath::cursor_path));
    }
    Ok(None)
}

fn sync_item_fits_budget(used_bytes: usize, item_bytes: usize) -> bool {
    used_bytes.saturating_add(item_bytes) <= SYNC_RESPONSE_BYTE_BUDGET
}

fn sync_response_base_bytes(revision: &str) -> usize {
    256_usize.saturating_add(revision.len())
}

fn estimated_removed_path_response_bytes(path: &str) -> usize {
    32_usize.saturating_add(path.len())
}

fn estimated_node_response_bytes(node: &Node) -> usize {
    128_usize
        .saturating_add(node.path.len())
        .saturating_add(node.content.len())
        .saturating_add(node.etag.len())
        .saturating_add(node.metadata_json.len())
        .saturating_add(std::mem::size_of_val(&node.created_at))
        .saturating_add(std::mem::size_of_val(&node.updated_at))
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

fn load_snapshot_nodes_page(
    conn: &Connection,
    prefix: &str,
    cursor: Option<&str>,
    snapshot_revision: i64,
    limit: i64,
) -> Result<Vec<Node>, String> {
    let mut sql = String::from("SELECT path FROM fs_nodes WHERE 1 = 1");
    let mut values = Vec::new();
    if prefix != "/" {
        let (scope_sql, scope_values) = prefix_filter_sql(prefix, 1);
        sql.push_str(&scope_sql);
        values.extend(scope_values);
    }
    if let Some(cursor) = cursor {
        let index = values.len() + 1;
        sql.push_str(&format!(" AND path > ?{index}"));
        values.push(crate::sqlite::types::Value::from(cursor.to_string()));
    }
    let index = values.len() + 1;
    sql.push_str(&format!(" ORDER BY path ASC LIMIT ?{index}"));
    values.push(crate::sqlite::types::Value::from(limit));
    let mut stmt = conn.prepare(&sql).map_err(|error| error.to_string())?;
    let paths = crate::sqlite::query_map(
        &mut stmt,
        crate::sqlite::params_from_values(&values),
        |row| crate::sqlite::row_get::<String>(row, 0),
    )
    .map_err(|error| error.to_string())?;
    load_snapshot_nodes(conn, &paths, snapshot_revision)
}

fn load_snapshot_nodes(
    conn: &Connection,
    paths: &[String],
    snapshot_revision: i64,
) -> Result<Vec<Node>, String> {
    let mut nodes = Vec::with_capacity(paths.len());
    for path in paths {
        if load_path_last_change_revision(conn, path)? > snapshot_revision {
            return Err(SNAPSHOT_REVISION_NO_LONGER_CURRENT.to_string());
        }
        let node = load_node(conn, path)?
            .ok_or_else(|| SNAPSHOT_REVISION_NO_LONGER_CURRENT.to_string())?;
        nodes.push(node);
    }
    Ok(nodes)
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
        crate::sqlite::types::Value::from(known_revision),
        crate::sqlite::types::Value::from(target_revision),
    ];
    if prefix != "/" {
        let (scope_sql, scope_values) = prefix_filter_sql(prefix, values.len() + 1);
        sql.push_str(&scope_sql);
        values.extend(scope_values);
    }
    if let Some(cursor) = cursor {
        let index = values.len() + 1;
        sql.push_str(&format!(" AND path > ?{index}"));
        values.push(crate::sqlite::types::Value::from(cursor.to_string()));
    }
    sql.push_str(&format!(" ORDER BY path ASC LIMIT {limit}"));
    let mut stmt = conn.prepare(&sql).map_err(|error| error.to_string())?;
    crate::sqlite::query_map(
        &mut stmt,
        crate::sqlite::params_from_values(&values),
        |row| crate::sqlite::row_get::<String>(row, 0),
    )
    .map_err(|error| error.to_string())
}

fn has_prefix_changes_after_revision(
    conn: &Connection,
    prefix: &str,
    snapshot_revision: i64,
) -> Result<bool, String> {
    let mut sql = String::from("SELECT 1 FROM fs_change_log WHERE revision > ?1");
    let mut values = vec![crate::sqlite::types::Value::from(snapshot_revision)];
    if prefix != "/" {
        let (scope_sql, scope_values) = prefix_filter_sql(prefix, values.len() + 1);
        sql.push_str(&scope_sql);
        values.extend(scope_values);
    }
    sql.push_str(" LIMIT 1");
    let mut stmt = conn.prepare(&sql).map_err(|error| error.to_string())?;
    crate::sqlite::statement_exists(&mut stmt, crate::sqlite::params_from_values(&values))
        .map_err(|error| error.to_string())
}

fn load_path_last_change_revision(conn: &Connection, path: &str) -> Result<i64, String> {
    conn.query_row(
        "SELECT last_change_revision FROM fs_path_state WHERE path = ?1",
        params![path],
        |row| crate::sqlite::row_get::<i64>(row, 0),
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
    let count = conn
        .query_row(
            "SELECT COUNT(*) FROM fs_nodes WHERE kind = ?1",
            params![kind],
            |row| crate::sqlite::row_get::<i64>(row, 0),
        )
        .map_err(|error| error.to_string())?;
    u64::try_from(count).map_err(|error| error.to_string())
}

fn load_marketplace_verified_stats(
    conn: &Connection,
) -> Result<MarketListingVerifiedStats, String> {
    let (
        total_nodes,
        wiki_nodes,
        source_nodes,
        folder_nodes,
        markdown_chars,
        source_chars,
        last_content_updated_at_ms,
    ) = conn
        .query_row(
            "SELECT COUNT(*),
                    SUM(CASE WHEN path = '/Knowledge' OR path LIKE '/Knowledge/%' THEN 1 ELSE 0 END),
                    SUM(CASE WHEN kind = 'source' THEN 1 ELSE 0 END),
                    SUM(CASE WHEN kind = 'folder' THEN 1 ELSE 0 END),
                    SUM(CASE WHEN kind = 'file' THEN length(content) ELSE 0 END),
                    SUM(CASE WHEN kind = 'source' THEN length(content) ELSE 0 END),
                    MAX(CASE WHEN kind IN ('file', 'source') THEN updated_at ELSE NULL END)
             FROM fs_nodes",
            params![],
            |row| {
                Ok((
                    crate::sqlite::row_get::<i64>(row, 0)?,
                    crate::sqlite::row_get::<Option<i64>>(row, 1)?,
                    crate::sqlite::row_get::<Option<i64>>(row, 2)?,
                    crate::sqlite::row_get::<Option<i64>>(row, 3)?,
                    crate::sqlite::row_get::<Option<i64>>(row, 4)?,
                    crate::sqlite::row_get::<Option<i64>>(row, 5)?,
                    crate::sqlite::row_get::<Option<i64>>(row, 6)?,
                ))
            },
        )
        .map_err(|error| error.to_string())?;
    let link_edges = conn
        .query_row("SELECT COUNT(*) FROM fs_links", params![], |row| {
            crate::sqlite::row_get::<i64>(row, 0)
        })
        .map_err(|error| error.to_string())?;
    Ok(MarketListingVerifiedStats {
        total_nodes: nonnegative_i64_to_u64(total_nodes)?,
        wiki_nodes: nonnegative_i64_to_u64(wiki_nodes.unwrap_or(0))?,
        source_nodes: nonnegative_i64_to_u64(source_nodes.unwrap_or(0))?,
        folder_nodes: nonnegative_i64_to_u64(folder_nodes.unwrap_or(0))?,
        markdown_chars: nonnegative_i64_to_u64(markdown_chars.unwrap_or(0))?,
        source_chars: nonnegative_i64_to_u64(source_chars.unwrap_or(0))?,
        link_edges: nonnegative_i64_to_u64(link_edges)?,
        logical_size_bytes: 0,
        last_content_updated_at_ms,
    })
}

fn nonnegative_i64_to_u64(value: i64) -> Result<u64, String> {
    u64::try_from(value.max(0)).map_err(|error| error.to_string())
}

fn logical_size_bytes_for_conn(conn: &Connection) -> Result<u64, String> {
    let page_count = conn
        .query_row("PRAGMA page_count", params![], |row| {
            crate::sqlite::row_get::<i64>(row, 0)
        })
        .map_err(|error| error.to_string())?;
    let page_size = conn
        .query_row("PRAGMA page_size", params![], |row| {
            crate::sqlite::row_get::<i64>(row, 0)
        })
        .map_err(|error| error.to_string())?;
    let page_count =
        u64::try_from(page_count).map_err(|_| "SQLite page_count is negative".to_string())?;
    let page_size =
        u64::try_from(page_size).map_err(|_| "SQLite page_size is negative".to_string())?;
    page_count
        .checked_mul(page_size)
        .ok_or_else(|| "SQLite logical size exceeds u64".to_string())
}

fn normalize_list_children_path(path: &str) -> Result<String, String> {
    let trimmed = if path.len() > 1 && path.ends_with('/') {
        &path[..path.len() - 1]
    } else {
        path
    };
    normalize_node_path(trimmed, true)
}

fn load_child_rows(
    conn: &Connection,
    path: &str,
    parent_id: Option<i64>,
) -> Result<Vec<ChildRow>, String> {
    if path != "/" && parent_id.is_none() {
        return Ok(Vec::new());
    }
    let sql = if parent_id.is_some() {
        LIST_FOLDER_CHILD_ROWS_SQL
    } else {
        LIST_ROOT_CHILD_ROWS_SQL
    };
    let mut stmt = conn.prepare(sql).map_err(|error| error.to_string())?;
    let map_row = |row: &crate::sqlite::Row<'_>| {
        let size_bytes = crate::sqlite::row_get::<i64>(row, 4)?;
        Ok(ChildRow {
            path: crate::sqlite::row_get::<String>(row, 0)?,
            kind: node_kind_from_db(&crate::sqlite::row_get::<String>(row, 1)?)?,
            updated_at: crate::sqlite::row_get::<i64>(row, 2)?,
            etag: crate::sqlite::row_get::<String>(row, 3)?,
            size_bytes: size_bytes.max(0) as u64,
            has_children: crate::sqlite::row_get::<i64>(row, 5)? != 0,
        })
    };
    match parent_id {
        Some(parent_id) => crate::sqlite::query_map(&mut stmt, params![parent_id], map_row)
            .map_err(|error| error.to_string()),
        None => crate::sqlite::query_map(&mut stmt, params![], map_row)
            .map_err(|error| error.to_string()),
    }
}

fn allows_empty_directory_listing(path: &str) -> bool {
    matches!(
        path,
        "/" | "/Memory" | "/Knowledge" | "/Skills" | "/Sessions" | "/Sources"
    )
}

fn build_child_nodes(parent_path: &str, rows: Vec<ChildRow>) -> Result<Vec<ChildNode>, String> {
    let mut children = BTreeMap::<String, ChildNode>::new();

    for row in rows {
        let (name, is_direct) = child_name(parent_path, &row.path)
            .ok_or_else(|| format!("invalid child path: {}", row.path))?;
        if !is_direct {
            return Err(format!("non-direct child row loaded: {}", row.path));
        }
        children.insert(
            name.clone(),
            ChildNode {
                has_children: row.has_children,
                path: row.path,
                name,
                kind: entry_kind_from_node_kind(&row.kind),
                updated_at: Some(row.updated_at),
                etag: Some(row.etag),
                size_bytes: Some(row.size_bytes),
                is_virtual: false,
                is_published: false,
            },
        );
    }

    let mut children = children.into_values().collect::<Vec<_>>();
    children.sort_by(|left, right| match (&left.kind, &right.kind) {
        (
            NodeEntryKind::Folder | NodeEntryKind::Directory,
            NodeEntryKind::Folder | NodeEntryKind::Directory,
        ) => left.name.cmp(&right.name),
        (NodeEntryKind::Folder | NodeEntryKind::Directory, _) => std::cmp::Ordering::Less,
        (_, NodeEntryKind::Folder | NodeEntryKind::Directory) => std::cmp::Ordering::Greater,
        _ => left.name.cmp(&right.name),
    });
    Ok(children)
}

fn prefix_upper_bound(prefix: &str) -> String {
    format!("{prefix}\u{10ffff}")
}

fn child_name(parent_path: &str, path: &str) -> Option<(String, bool)> {
    let relative = relative_to_prefix(parent_path, path)?;
    if relative.is_empty() {
        return None;
    }
    match relative.split_once('/') {
        Some((name, _)) if !name.is_empty() => Some((name.to_string(), false)),
        None => Some((relative, true)),
        _ => None,
    }
}

fn entry_kind_from_node_kind(kind: &NodeKind) -> NodeEntryKind {
    match kind {
        NodeKind::File => NodeEntryKind::File,
        NodeKind::Source => NodeEntryKind::Source,
        NodeKind::Folder => NodeEntryKind::Folder,
    }
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
    if request.kind == Some(NodeKind::Folder) {
        return Err("append_node cannot create folders; use mkdir_node".to_string());
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
) -> Result<Node, NodeMutationError> {
    if current.etag != request.expected_etag.unwrap_or_default() {
        let path = current.path.clone();
        return Err(NodeMutationError::etag_conflict(
            format!("expected_etag does not match current etag: {path}"),
            path,
        ));
    }
    if current.kind == NodeKind::Folder {
        return Err(NodeMutationError::invalid_operation(format!(
            "cannot append to folder: {}",
            current.path
        )));
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
) -> Result<Node, NodeMutationError> {
    if current.etag != request.expected_etag.unwrap_or_default() {
        let path = current.path.clone();
        return Err(NodeMutationError::etag_conflict(
            format!("expected_etag does not match current etag: {path}"),
            path,
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
            let (parent_id, name) = parent_fields_for_path(tx, &node.path)?;
            let parent_id_value = crate::sqlite::nullable_integer_value(parent_id);
            let values = vec![
                crate::sqlite::text_value(node.path.clone()),
                crate::sqlite::text_value(node_kind_to_db(&node.kind)),
                crate::sqlite::text_value(node.content.clone()),
                crate::sqlite::integer_value(node.created_at),
                crate::sqlite::integer_value(node.updated_at),
                crate::sqlite::text_value(node.etag.clone()),
                crate::sqlite::text_value(node.metadata_json.clone()),
                parent_id_value,
                crate::sqlite::text_value(name),
            ];
            crate::sqlite::execute_values(
                tx,
                "INSERT INTO fs_nodes (path, kind, content, created_at, updated_at, etag, metadata_json, parent_id, name)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                &values,
            )
            .map_err(|error| error.to_string())?;
            crate::sqlite::last_insert_rowid(tx).map_err(|error| error.to_string())
        }
    }
}

fn save_moved_node(
    tx: &Transaction<'_>,
    row_id: i64,
    path: &str,
    updated_at: i64,
    etag: &str,
) -> Result<i64, String> {
    let (parent_id, name) = parent_fields_for_path(tx, path)?;
    let values = vec![
        crate::sqlite::text_value(path.to_string()),
        crate::sqlite::integer_value(updated_at),
        crate::sqlite::text_value(etag.to_string()),
        crate::sqlite::nullable_integer_value(parent_id),
        crate::sqlite::text_value(name),
        crate::sqlite::integer_value(row_id),
    ];
    crate::sqlite::execute_values(
        tx,
        "UPDATE fs_nodes
         SET path = ?1,
             updated_at = ?2,
             etag = ?3,
             parent_id = ?4,
             name = ?5
         WHERE id = ?6",
        &values,
    )
    .map_err(|error| error.to_string())?;
    Ok(row_id)
}

fn parent_fields_for_path(
    tx: &Transaction<'_>,
    path: &str,
) -> Result<(Option<i64>, String), String> {
    let (parent_path, name) = split_parent_path_and_name(path)?;
    let Some(parent_path) = parent_path else {
        return Ok((None, name));
    };
    let parent = load_parent_folder_candidate(tx, &parent_path)?
        .ok_or_else(|| format!("parent folder does not exist: {parent_path}"))?;
    if parent.1 != NodeKind::Folder {
        return Err(format!("parent path is not a folder: {parent_path}"));
    }
    Ok((Some(parent.0), name))
}

fn require_parent_folder_for_mutation(
    tx: &Transaction<'_>,
    path: &str,
) -> Result<(), NodeMutationError> {
    let (parent_path, _) =
        split_parent_path_and_name(path).map_err(NodeMutationError::invalid_operation)?;
    let Some(parent_path) = parent_path else {
        return Ok(());
    };
    let parent = load_parent_folder_candidate(tx, &parent_path)
        .map_err(NodeMutationError::write_unavailable)?
        .ok_or_else(|| {
            NodeMutationError::not_found_with_path(
                format!("parent folder does not exist: {parent_path}"),
                parent_path.clone(),
            )
        })?;
    if parent.1 != NodeKind::Folder {
        return Err(NodeMutationError::invalid_operation_with_path(
            format!("parent path is not a folder: {parent_path}"),
            parent_path,
        ));
    }
    Ok(())
}

fn load_parent_folder_candidate(
    tx: &Transaction<'_>,
    path: &str,
) -> Result<Option<(i64, NodeKind)>, String> {
    tx.query_row(
        "SELECT id, kind FROM fs_nodes WHERE path = ?1",
        params![path],
        |row| {
            Ok((
                row.get(0)?,
                node_kind_from_db(&crate::sqlite::row_get::<String>(row, 1)?)?,
            ))
        },
    )
    .optional()
    .map_err(|error| error.to_string())
}

struct MoveNodeRow {
    row_id: i64,
    path: String,
    etag: String,
}

fn validate_folder_move_budget(
    tx: &Transaction<'_>,
    from_path: &str,
    to_path: &str,
) -> Result<(), NodeMutationError> {
    let (affected_nodes, changed_bytes) = folder_move_budget(tx, from_path, to_path)?;
    crate::git_repository::validate_mutation_budget(affected_nodes, changed_bytes)
        .map_err(NodeMutationError::invalid_operation)
}

fn folder_move_budget(
    tx: &Transaction<'_>,
    from_path: &str,
    to_path: &str,
) -> Result<(i64, i64), NodeMutationError> {
    let prefix = format!("{from_path}/");
    let upper = prefix_upper_bound(&prefix);
    tx.query_row(
        "SELECT COUNT(*),
                COALESCE(SUM(
                    length(CAST(?2 AS BLOB))
                    + length(CAST(path AS BLOB))
                    - length(CAST(?1 AS BLOB))
                    + length(CAST(metadata_json AS BLOB))
                ), 0)
         FROM fs_nodes
         WHERE path = ?1 OR (path >= ?3 AND path < ?4)",
        params![from_path, to_path, prefix, upper],
        |row| {
            Ok((
                crate::sqlite::row_get(row, 0)?,
                crate::sqlite::row_get(row, 1)?,
            ))
        },
    )
    .map_err(|error| NodeMutationError::write_unavailable(error.to_string()))
}

fn load_move_subtree(tx: &Transaction<'_>, path: &str) -> Result<Vec<MoveNodeRow>, String> {
    let mut stmt = tx
        .prepare(
            "SELECT id, path, etag FROM fs_nodes
             WHERE path = ?1 OR (path >= ?2 AND path < ?3)
             ORDER BY length(path), path",
        )
        .map_err(|error| error.to_string())?;
    let prefix = format!("{path}/");
    let upper = prefix_upper_bound(&prefix);
    crate::sqlite::query_map(&mut stmt, params![path, prefix, upper], |row| {
        Ok(MoveNodeRow {
            row_id: crate::sqlite::row_get(row, 0)?,
            path: crate::sqlite::row_get(row, 1)?,
            etag: crate::sqlite::row_get(row, 2)?,
        })
    })
    .map_err(|error| error.to_string())
}

fn compute_moved_node_etag(previous_etag: &str, path: &str) -> String {
    format!(
        "v4h:{}",
        sha256_hex(&format!("move\n{previous_etag}\n{path}"))
    )
}

fn rebase_path(path: &str, from_path: &str, to_path: &str) -> Result<String, String> {
    if path == from_path {
        return Ok(to_path.to_string());
    }
    let suffix = path
        .strip_prefix(&format!("{from_path}/"))
        .ok_or_else(|| format!("path is not in moved subtree: {path}"))?;
    Ok(format!("{to_path}/{suffix}"))
}

fn folder_index_path(folder_path: &str) -> String {
    format!("{folder_path}/index.md")
}

fn load_folder_index_child(
    tx: &Transaction<'_>,
    parent_id: i64,
    index_path: &str,
) -> Result<Option<StoredNode>, String> {
    let index = tx
        .query_row(
            "SELECT path FROM fs_nodes
             WHERE parent_id = ?1 AND path = ?2 AND kind = 'file'
             LIMIT 1",
            params![parent_id, index_path],
            |row| crate::sqlite::row_get::<String>(row, 0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    index
        .map(|path| {
            load_stored_node(tx, &path)?.ok_or_else(|| format!("node does not exist: {path}"))
        })
        .transpose()
}

fn has_visible_folder_children(
    tx: &Transaction<'_>,
    parent_id: i64,
    index_path: &str,
) -> Result<bool, String> {
    let mut stmt = tx
        .prepare(
            "SELECT 1 FROM fs_nodes
         WHERE parent_id = ?1
           AND NOT (path = ?2 AND kind = 'file')
         LIMIT 1",
        )
        .map_err(|error| error.to_string())?;
    crate::sqlite::statement_exists(&mut stmt, params![parent_id, index_path])
        .map_err(|error| error.to_string())
}

fn ensure_missing_store_root_for_path(
    tx: &Transaction<'_>,
    path: &str,
    now: i64,
) -> Result<(), String> {
    let Some(root_path) = store_root_for_child_path(path) else {
        return Ok(());
    };
    ensure_store_root_folder(tx, root_path, now)
}

fn ensure_store_root_folder(tx: &Transaction<'_>, path: &str, now: i64) -> Result<(), String> {
    if let Some(existing) = load_stored_node(tx, path)? {
        if existing.node.kind == NodeKind::Folder {
            return Ok(());
        }
        return Err(format!("protected root is not a folder: {path}"));
    }
    let mut node = Node {
        path: path.to_string(),
        kind: NodeKind::Folder,
        content: String::new(),
        created_at: now,
        updated_at: now,
        etag: String::new(),
        metadata_json: "{}".to_string(),
    };
    let revision = record_change(tx, &node)?;
    update_path_state(tx, &node.path, revision)?;
    node.etag = compute_node_etag(&node);
    save_node(tx, None, &node)?;
    Ok(())
}

fn store_root_for_child_path(path: &str) -> Option<&'static str> {
    let root = path.split('/').nth(1)?;
    let root_path = match root {
        "Memory" => "/Memory",
        "Knowledge" => "/Knowledge",
        "Skills" => "/Skills",
        "Sessions" => "/Sessions",
        "Sources" => "/Sources",
        _ => return None,
    };
    if path == root_path {
        None
    } else {
        Some(root_path)
    }
}

fn is_protected_root_folder(path: &str) -> bool {
    matches!(
        path,
        "/Memory"
            | "/Knowledge"
            | "/Skills"
            | "/Sessions"
            | "/Sources"
            | "/Sources/sessions"
            | "/Sources/skill-runs"
            | "/Sources/source-capture-requests"
    )
}

fn split_parent_path_and_name(path: &str) -> Result<(Option<String>, String), String> {
    let Some((parent, name)) = path.rsplit_once('/') else {
        return Err(format!("invalid node path: {path}"));
    };
    if name.is_empty() {
        return Err(format!("invalid node path: {path}"));
    }
    if parent.is_empty() {
        Ok((None, name.to_string()))
    } else {
        Ok((Some(parent.to_string()), name.to_string()))
    }
}

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
        GlobNodeType::Directory => {
            matches!(entry_kind, NodeEntryKind::Directory | NodeEntryKind::Folder)
        }
    }
}
