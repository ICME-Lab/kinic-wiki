// Where: crates/vfs_store/src/fs_store.rs
// What: FS-first node store over SQLite for phase-2 persistence and search.
// Why: The VFS layer needs one SQLite-backed store for file-like CRUD, search, and sync.
//
// Search keeps ranking and preview generation separate.
// That prevents SQLite `snippet()` cost from scaling with all matched rows.
// Only returned hits pay preview generation cost.
use std::collections::{BTreeMap, BTreeSet};
#[cfg(not(target_arch = "wasm32"))]
use std::path::{Path, PathBuf};

use crate::sqlite::{Connection, OptionalExtension, Transaction, params};
#[cfg(target_arch = "wasm32")]
use ic_sqlite_vfs::{DbError, DbHandle};
use vfs_types::{
    AppendNodeRequest, ChildNode, DeleteNodeRequest, DeleteNodeResult, EditNodeRequest,
    EditNodeResult, ExportSnapshotRequest, ExportSnapshotResponse, FetchUpdatesRequest,
    FetchUpdatesResponse, GlobNodeHit, GlobNodeType, GlobNodesRequest, GraphLinksRequest,
    GraphNeighborhoodRequest, IncomingLinksRequest, LinkEdge, ListChildrenRequest,
    ListNodesRequest, MkdirNodeRequest, MkdirNodeResult, MoveNodeRequest, MoveNodeResult,
    MultiEdit, MultiEditNodeRequest, MultiEditNodeResult, Node, NodeContext, NodeContextRequest,
    NodeEntry, NodeEntryKind, NodeKind, OutgoingLinksRequest, QueryContext, QueryContextRequest,
    RecentNodeHit, RecentNodesRequest, SearchNodeHit, SearchNodePathsRequest, SearchNodesRequest,
    SearchPreviewMode, SourceEvidence, SourceEvidenceRef, SourceEvidenceRequest, Status,
    WriteNodeItem, WriteNodeRequest, WriteNodeResult, WriteNodesRequest,
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
        load_outgoing_links, sync_node_links,
    },
    fs_search::{
        SearchCandidate, build_previews_for_hits, build_search_query_plan, finalize_hits,
        load_content_substring_candidates, load_path_candidates, load_ranked_fts_candidates,
        path_match_score, rerank_candidates, sort_candidates,
    },
    fs_search_bench::{self, SearchBenchStage},
    glob_match::{matches_path, validate_pattern},
    schema,
};

const QUERY_RESULT_LIMIT_MAX: u32 = 100;
const WIKI_ROOT_PATH: &str = "/Wiki";
const CONTEXT_LINK_LIMIT: u32 = 20;
const CONTEXT_SEARCH_LIMIT: u32 = 10;
const WRITE_NODES_BATCH_LIMIT_MAX: usize = 100;
const TOKEN_CHAR_APPROX: usize = 4;
const SNAPSHOT_REVISION_NO_LONGER_CURRENT: &str = "snapshot_revision is no longer current";
const SNAPSHOT_SESSION_INVALID: &str = "snapshot_session_id is invalid";
const SNAPSHOT_REVISION_CURSOR_REQUIRED: &str = "snapshot_revision is required when cursor is set";
const TARGET_SNAPSHOT_CURSOR_REQUIRED: &str =
    "target_snapshot_revision is required when cursor is set";
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

    pub fn status(&self) -> Result<Status, String> {
        self.read_conn(|conn| {
            Ok(Status {
                file_count: count_nodes(conn, "file")?,
                source_count: count_nodes(conn, "source")?,
            })
        })
    }

    pub fn read_node(&self, path: &str) -> Result<Option<Node>, String> {
        let normalized = normalize_node_path(path, false)?;
        self.read_conn(|conn| load_node(conn, &normalized))
    }

    pub fn list_nodes(&self, request: ListNodesRequest) -> Result<Vec<NodeEntry>, String> {
        let prefix = normalize_node_path(&request.prefix, true)?;
        self.read_conn(|conn| {
            let rows = load_scoped_entry_rows(conn, &prefix)?;
            Ok(build_entries_from_rows(&rows, &prefix, request.recursive))
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

    pub fn write_node(
        &self,
        request: WriteNodeRequest,
        now: i64,
    ) -> Result<WriteNodeResult, String> {
        self.write_conn(|tx| write_node_in_tx(tx, request, now))
    }

    pub fn write_nodes(
        &self,
        request: WriteNodesRequest,
        now: i64,
    ) -> Result<Vec<WriteNodeResult>, String> {
        validate_write_nodes_count(request.nodes.len())?;
        self.write_conn(|tx| {
            let mut results = Vec::with_capacity(request.nodes.len());
            for item in request.nodes {
                results.push(write_node_in_tx(
                    tx,
                    write_node_request_from_item(&request.database_id, item),
                    now,
                )?);
            }
            Ok(results)
        })
    }

    pub fn append_node(
        &self,
        request: AppendNodeRequest,
        now: i64,
    ) -> Result<WriteNodeResult, String> {
        let path = normalize_node_path(&request.path, false)?;
        self.write_conn(|tx| {
            let existing = load_stored_node(tx, &path)?;
            if existing
                .as_ref()
                .is_some_and(|stored| stored.node.kind == NodeKind::Folder)
            {
                return Err(format!("cannot append to folder: {path}"));
            }
            let created = existing.is_none();
            let mut node = match existing.as_ref() {
                Some(current) => append_existing_node(current.node.clone(), request, now)?,
                None => create_appended_node(path, request, now)?,
            };
            let revision = record_change(tx, &node)?;
            update_path_state(tx, &node.path, revision)?;
            node.etag = compute_node_etag(&node);
            let row_id = save_node(tx, existing.as_ref().map(|stored| stored.row_id), &node)?;
            sync_node_fts(tx, existing.as_ref(), Some((row_id, &node)))?;
            sync_node_links(tx, &node)?;
            Ok(WriteNodeResult {
                node: node_ack(&node),
                created,
            })
        })
    }

    pub fn edit_node(&self, request: EditNodeRequest, now: i64) -> Result<EditNodeResult, String> {
        if request.old_text.is_empty() {
            return Err("old_text must not be empty".to_string());
        }
        let path = normalize_node_path(&request.path, false)?;
        self.write_conn(|tx| {
            let current = load_stored_node(tx, &path)?
                .ok_or_else(|| format!("node does not exist: {path}"))?;
            if current.node.kind == NodeKind::Folder {
                return Err(format!("cannot edit folder: {path}"));
            }
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
            let revision = record_change(tx, &node)?;
            update_path_state(tx, &node.path, revision)?;
            node.etag = compute_node_etag(&node);
            save_node(tx, Some(current.row_id), &node)?;
            sync_node_fts(tx, Some(&current), Some((current.row_id, &node)))?;
            sync_node_links(tx, &node)?;
            Ok(EditNodeResult {
                node: node_ack(&node),
                replacement_count,
            })
        })
    }

    pub fn mkdir_node(
        &self,
        request: MkdirNodeRequest,
        now: i64,
    ) -> Result<MkdirNodeResult, String> {
        let path = normalize_node_path(&request.path, false)?;
        self.write_conn(|tx| {
            if let Some(existing) = load_stored_node(tx, &path)? {
                if existing.node.kind == NodeKind::Folder {
                    return Ok(MkdirNodeResult {
                        path,
                        created: false,
                    });
                }
                return Err(format!("node already exists and is not a folder: {path}"));
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
            let revision = record_change(tx, &node)?;
            update_path_state(tx, &node.path, revision)?;
            node.etag = compute_node_etag(&node);
            save_node(tx, None, &node)?;
            Ok(MkdirNodeResult {
                path,
                created: true,
            })
        })
    }

    pub fn move_node(&self, request: MoveNodeRequest, now: i64) -> Result<MoveNodeResult, String> {
        let from_path = normalize_node_path(&request.from_path, false)?;
        let to_path = normalize_node_path(&request.to_path, false)?;
        if from_path == to_path {
            return Err("from_path and to_path must differ".to_string());
        }
        self.write_conn(|tx| {
            let current = load_stored_node(tx, &from_path)?
                .ok_or_else(|| format!("node does not exist: {from_path}"))?;
            if current.node.etag != request.expected_etag.unwrap_or_default() {
                return Err(format!(
                    "expected_etag does not match current etag: {from_path}"
                ));
            }
            if current.node.kind == NodeKind::Folder {
                if is_protected_root_folder(&from_path) {
                    return Err(format!("cannot move protected folder: {from_path}"));
                }
                if to_path.starts_with(&format!("{from_path}/")) {
                    return Err("cannot move folder into itself".to_string());
                }
            }
            let target = load_stored_node(tx, &to_path)?;
            let overwrote = target.is_some();
            if current.node.kind == NodeKind::Folder && overwrote {
                return Err(format!("target node already exists: {to_path}"));
            }
            if overwrote && !request.overwrite {
                return Err(format!("target node already exists: {to_path}"));
            }
            if target
                .as_ref()
                .is_some_and(|stored| stored.node.kind == NodeKind::Folder)
            {
                return Err(format!("cannot overwrite folder: {to_path}"));
            }
            if current.node.kind == NodeKind::Folder {
                let subtree = load_stored_subtree(tx, &from_path)?;
                for stored in &subtree {
                    let next_path = rebase_path(&stored.node.path, &from_path, &to_path)?;
                    if next_path != stored.node.path && load_stored_node(tx, &next_path)?.is_some()
                    {
                        return Err(format!("target node already exists: {next_path}"));
                    }
                }
                for stored in subtree {
                    let mut moved = stored.node.clone();
                    let old_path = moved.path.clone();
                    moved.path = rebase_path(&old_path, &from_path, &to_path)?;
                    moved.updated_at = now;
                    let from_revision = record_path_removal(tx, &old_path)?;
                    update_path_state(tx, &old_path, from_revision)?;
                    let to_revision = record_change(tx, &moved)?;
                    update_path_state(tx, &moved.path, to_revision)?;
                    moved.etag = compute_node_etag(&moved);
                    save_moved_node(tx, stored.row_id, &moved)?;
                    sync_node_fts(tx, Some(&stored), Some((stored.row_id, &moved)))?;
                    delete_source_links(tx, &old_path)?;
                    sync_node_links(tx, &moved)?;
                }
                let moved = load_node(tx, &to_path)?
                    .ok_or_else(|| format!("node does not exist: {to_path}"))?;
                return Ok(MoveNodeResult {
                    node: node_ack(&moved),
                    from_path,
                    overwrote: false,
                });
            }
            if let Some(target) = target.as_ref() {
                delete_source_links(tx, &target.node.path)?;
                delete_node_row(tx, target)?;
            }
            let mut moved = current.node.clone();
            moved.path = to_path.clone();
            moved.updated_at = now;
            let from_revision = record_path_removal(tx, &from_path)?;
            update_path_state(tx, &from_path, from_revision)?;
            let to_revision = record_change(tx, &moved)?;
            update_path_state(tx, &to_path, to_revision)?;
            moved.etag = compute_node_etag(&moved);
            save_moved_node(tx, current.row_id, &moved)?;
            sync_node_fts(tx, Some(&current), Some((current.row_id, &moved)))?;
            delete_source_links(tx, &from_path)?;
            sync_node_links(tx, &moved)?;
            Ok(MoveNodeResult {
                node: node_ack(&moved),
                from_path,
                overwrote,
            })
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
            .unwrap_or_else(|| "/".to_string());
        let node_type = request.node_type.unwrap_or(GlobNodeType::Any);
        self.read_conn(|conn| {
            let rows = load_scoped_entry_rows(conn, &prefix)?;
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

    pub fn recent_nodes(&self, request: RecentNodesRequest) -> Result<Vec<RecentNodeHit>, String> {
        let prefix = request
            .path
            .as_deref()
            .map(|value| normalize_node_path(value, true))
            .transpose()?
            .unwrap_or_else(|| "/".to_string());
        self.read_conn(|conn| {
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
            crate::sqlite::query_map(
                &mut stmt,
                crate::sqlite::params_from_values(&values),
                |row| {
                    Ok(RecentNodeHit {
                        path: crate::sqlite::row_get::<String>(row, 0)?,
                        kind: node_kind_from_db(&crate::sqlite::row_get::<String>(row, 1)?)?,
                        updated_at: crate::sqlite::row_get::<i64>(row, 2)?,
                        etag: crate::sqlite::row_get::<String>(row, 3)?,
                    })
                },
            )
            .map_err(|error| error.to_string())
        })
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
        self.write_conn(|tx| {
            let current = load_stored_node(tx, &path)?
                .ok_or_else(|| format!("node does not exist: {path}"))?;
            if current.node.kind == NodeKind::Folder {
                return Err(format!("cannot edit folder: {path}"));
            }
            if current.node.etag != request.expected_etag.unwrap_or_default() {
                return Err(format!("expected_etag does not match current etag: {path}"));
            }
            let (content, replacement_count) =
                apply_multi_edit(&current.node.content, &request.edits)?;
            let mut node = current.node.clone();
            node.content = content;
            node.updated_at = now;
            let revision = record_change(tx, &node)?;
            update_path_state(tx, &node.path, revision)?;
            node.etag = compute_node_etag(&node);
            save_node(tx, Some(current.row_id), &node)?;
            sync_node_fts(tx, Some(&current), Some((current.row_id, &node)))?;
            sync_node_links(tx, &node)?;
            Ok(MultiEditNodeResult {
                node: node_ack(&node),
                replacement_count,
            })
        })
    }

    pub fn delete_node(
        &self,
        request: DeleteNodeRequest,
        _now: i64,
    ) -> Result<DeleteNodeResult, String> {
        let path = normalize_node_path(&request.path, false)?;
        self.write_conn(|tx| {
        let current =
            load_stored_node(tx, &path)?.ok_or_else(|| format!("node does not exist: {path}"))?;
        if current.node.etag != request.expected_etag.unwrap_or_default() {
            return Err(format!("expected_etag does not match current etag: {path}"));
        }
        if current.node.kind == NodeKind::Folder {
            if is_protected_root_folder(&path) {
                return Err(format!("cannot delete protected folder: {path}"));
            }
            let index_path = folder_index_path(&path);
            let index_node = load_folder_index_child(tx, current.row_id, &index_path)?;
            if has_visible_folder_children(tx, current.row_id, &index_path)? {
                return Err(format!("folder is not empty: {path}"));
            }
            match index_node {
                Some(index_node) => {
                    let expected_index_etag = request
                        .expected_folder_index_etag
                        .as_deref()
                        .ok_or_else(|| {
                            format!("expected_folder_index_etag is required: {index_path}")
                        })?;
                    if index_node.node.etag != expected_index_etag {
                        return Err(format!(
                            "expected_folder_index_etag does not match current etag: {index_path}"
                        ));
                    }
                    delete_node_with_history(tx, &index_node)?;
                }
                None if request.expected_folder_index_etag.is_some() => {
                    return Err(format!("folder index node does not exist: {index_path}"));
                }
                None => {}
            }
        } else if request.expected_folder_index_etag.is_some() {
            return Err(format!(
                "expected_folder_index_etag is only valid for folder deletes: {path}"
            ));
        }
        delete_node_with_history(tx, &current)?;
        Ok(DeleteNodeResult { path })
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
        let (search_hits, mut used_chars, mut truncated) =
            trim_search_hits_to_budget(search_hits, budget_chars);
        let paths = ordered_context_candidate_paths(&namespace, &search_hits);

        self.read_conn(|conn| {
            let mut nodes = Vec::new();
            for path in paths {
                let Some(context) = load_node_context_for_memory(conn, &path, CONTEXT_LINK_LIMIT)?
                else {
                    continue;
                };
                let context_chars = estimate_node_context_chars(&context);
                if used_chars.saturating_add(context_chars) > budget_chars {
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
                    if used_chars.saturating_add(evidence_chars) > budget_chars {
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
            if request.snapshot_revision.is_some()
                && has_prefix_changes_after_revision(conn, &prefix, snapshot.revision)?
            {
                return Err(SNAPSHOT_REVISION_NO_LONGER_CURRENT.to_string());
            }
            let mut nodes = load_snapshot_nodes_page(
                conn,
                &prefix,
                cursor.as_deref(),
                snapshot.revision,
                limit + 1,
            )?;
            let next_cursor = page_next_cursor(&mut nodes, limit);
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
            let mut paths = load_changed_paths_page(
                conn,
                known_snapshot.revision,
                target_snapshot.revision,
                &prefix,
                cursor.as_deref(),
                limit + 1,
            )?;
            let next_cursor = page_next_cursor(&mut paths, limit);
            for path in paths {
                if load_path_last_change_revision(conn, &path)? > target_snapshot.revision {
                    return Err(
                        "target_snapshot_revision is no longer current for changed path"
                            .to_string(),
                    );
                }
                let current_node = load_node(conn, &path)?;
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

    #[cfg(not(target_arch = "wasm32"))]
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
    crate::sqlite::last_insert_rowid(tx).map_err(|error| error.to_string())
}

fn write_node_in_tx(
    tx: &Transaction<'_>,
    request: WriteNodeRequest,
    now: i64,
) -> Result<WriteNodeResult, String> {
    let path = normalize_node_path(&request.path, false)?;
    let existing = load_stored_node(tx, &path)?;
    if existing
        .as_ref()
        .is_some_and(|stored| stored.node.kind == NodeKind::Folder)
    {
        return Err(format!("cannot overwrite folder with file node: {path}"));
    }
    let created = existing.is_none();
    let mut node = match existing.as_ref() {
        Some(current) => update_existing_node(current.node.clone(), request, now)?,
        None => create_new_node(path, request, now)?,
    };
    let revision = record_change(tx, &node)?;
    update_path_state(tx, &node.path, revision)?;
    node.etag = compute_node_etag(&node);
    let row_id = save_node(tx, existing.as_ref().map(|stored| stored.row_id), &node)?;
    sync_node_fts(tx, existing.as_ref(), Some((row_id, &node)))?;
    sync_node_links(tx, &node)?;
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

fn validate_write_nodes_count(count: usize) -> Result<(), String> {
    if count == 0 || count > WRITE_NODES_BATCH_LIMIT_MAX {
        return Err(format!(
            "write_nodes node count must be between 1 and {WRITE_NODES_BATCH_LIMIT_MAX}"
        ));
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

fn current_snapshot_revision_number(conn: &Connection) -> Result<i64, String> {
    conn.query_row(
        "SELECT COALESCE(MAX(revision), 0) FROM fs_change_log",
        params![],
        |row| crate::sqlite::row_get::<i64>(row, 0),
    )
    .map_err(|error| error.to_string())
}

fn oldest_snapshot_revision_number(conn: &Connection) -> Result<i64, String> {
    conn.query_row(
        "SELECT COALESCE(MIN(revision), 0) FROM fs_change_log",
        params![],
        |row| crate::sqlite::row_get::<i64>(row, 0),
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
    matches!(path, "/" | "/Wiki" | "/Sources")
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
    if request.kind == NodeKind::Folder {
        return Err("write_node cannot create folders; use mkdir_node".to_string());
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
) -> Result<Node, String> {
    if current.etag != request.expected_etag.unwrap_or_default() {
        return Err(format!(
            "expected_etag does not match current etag: {}",
            current.path
        ));
    }
    if current.kind == NodeKind::Folder {
        return Err(format!("cannot append to folder: {}", current.path));
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
    if request.kind == NodeKind::Folder {
        return Err("write_node cannot create folders; use mkdir_node".to_string());
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

fn save_moved_node(tx: &Transaction<'_>, row_id: i64, node: &Node) -> Result<i64, String> {
    let (parent_id, name) = parent_fields_for_path(tx, &node.path)?;
    let values = vec![
        crate::sqlite::text_value(node.path.clone()),
        crate::sqlite::text_value(node_kind_to_db(&node.kind)),
        crate::sqlite::text_value(node.content.clone()),
        crate::sqlite::integer_value(node.created_at),
        crate::sqlite::integer_value(node.updated_at),
        crate::sqlite::text_value(node.etag.clone()),
        crate::sqlite::text_value(node.metadata_json.clone()),
        crate::sqlite::nullable_integer_value(parent_id),
        crate::sqlite::text_value(name),
        crate::sqlite::integer_value(row_id),
    ];
    crate::sqlite::execute_values(
        tx,
        "UPDATE fs_nodes
         SET path = ?1,
             kind = ?2,
             content = ?3,
             created_at = ?4,
             updated_at = ?5,
             etag = ?6,
             metadata_json = ?7,
             parent_id = ?8,
             name = ?9
         WHERE id = ?10",
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

fn load_stored_subtree(tx: &Transaction<'_>, path: &str) -> Result<Vec<StoredNode>, String> {
    let mut stmt = tx
        .prepare(
            "SELECT path FROM fs_nodes
             WHERE path = ?1 OR (path >= ?2 AND path < ?3)
             ORDER BY length(path), path",
        )
        .map_err(|error| error.to_string())?;
    let prefix = format!("{path}/");
    let upper = prefix_upper_bound(&prefix);
    let paths = crate::sqlite::query_map(&mut stmt, params![path, prefix, upper], |row| {
        crate::sqlite::row_get::<String>(row, 0)
    })
    .map_err(|error| error.to_string())?;
    paths
        .into_iter()
        .map(|node_path| {
            load_stored_node(tx, &node_path)?
                .ok_or_else(|| format!("node does not exist: {node_path}"))
        })
        .collect()
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

fn is_protected_root_folder(path: &str) -> bool {
    matches!(path, "/Wiki" | "/Sources")
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

fn normalize_memory_namespace(namespace: Option<&str>) -> Result<String, String> {
    namespace
        .map(|value| normalize_node_path(value, true))
        .transpose()
        .map(|value| value.unwrap_or_else(|| WIKI_ROOT_PATH.to_string()))
}

fn budget_chars(token_budget: u32) -> usize {
    let tokens = if token_budget == 0 {
        1_000
    } else {
        token_budget
    };
    tokens as usize * TOKEN_CHAR_APPROX
}

fn context_query_text(task: &str, entities: &[String]) -> Result<String, String> {
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

fn canonical_context_paths(namespace: &str) -> Vec<String> {
    ["index.md", "overview.md", "schema.md"]
        .into_iter()
        .map(|name| format!("{}/{}", namespace.trim_end_matches('/'), name))
        .collect()
}

fn trim_search_hits_to_budget(
    hits: Vec<SearchNodeHit>,
    budget_chars: usize,
) -> (Vec<SearchNodeHit>, usize, bool) {
    let mut kept = Vec::new();
    let mut used_chars = 0usize;
    let mut truncated = false;
    for hit in hits {
        let hit_chars = estimate_search_hit_chars(&hit);
        if used_chars.saturating_add(hit_chars) > budget_chars {
            truncated = true;
            break;
        }
        used_chars = used_chars.saturating_add(hit_chars);
        kept.push(hit);
    }
    (kept, used_chars, truncated)
}

fn ordered_context_candidate_paths(namespace: &str, search_hits: &[SearchNodeHit]) -> Vec<String> {
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

fn provenance_path_for(node_path: &str) -> Option<String> {
    let parent = node_path.rsplit_once('/')?.0;
    if parent.is_empty() {
        return None;
    }
    Some(format!("{parent}/provenance.md"))
}

fn scope_root_provenance_path_for(node_path: &str) -> Option<String> {
    let mut parts = node_path.trim_matches('/').split('/');
    let root = parts.next()?;
    let scope = parts.next()?;
    if root != "Wiki" {
        return None;
    }
    Some(format!("/{root}/{scope}/provenance.md"))
}

fn load_node_context_for_memory(
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

fn source_evidence_for_path(conn: &Connection, node_path: &str) -> Result<SourceEvidence, String> {
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

fn collect_source_refs_from_path(
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
            refs.push(SourceEvidenceRef {
                source_path: edge.target_path,
                via_path: edge.source_path,
                raw_href: edge.raw_href,
                link_text: edge.link_text,
            });
        }
    }
    Ok(())
}

fn estimate_search_hit_chars(hit: &SearchNodeHit) -> usize {
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

fn estimate_node_context_chars(context: &NodeContext) -> usize {
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

fn estimate_link_edge_chars(edge: &LinkEdge) -> usize {
    edge.source_path.chars().count()
        + edge.target_path.chars().count()
        + edge.raw_href.chars().count()
        + edge.link_text.chars().count()
        + edge.link_kind.chars().count()
}

fn estimate_source_evidence_chars(evidence: &SourceEvidence) -> usize {
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
