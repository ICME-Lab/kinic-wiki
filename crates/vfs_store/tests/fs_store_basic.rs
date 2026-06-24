use rusqlite::{Connection, params};
use std::path::Path;
use tempfile::tempdir;
use vfs_store::FsStore;
use vfs_types::{
    DeleteNodeRequest, ExportSnapshotRequest, FetchUpdatesRequest, ListChildrenRequest,
    ListNodesRequest, MkdirNodeRequest, MoveNodeRequest, NodeEntryKind, NodeKind,
    OutgoingLinksRequest, SearchNodePathsRequest, SearchNodesRequest, SearchPreviewField,
    SearchPreviewMode, WriteNodeItem, WriteNodeRequest, WriteNodesRequest,
};

fn new_store() -> (tempfile::TempDir, FsStore) {
    let dir = tempdir().expect("temp dir should exist");
    let store = FsStore::new(dir.path().join("wiki.sqlite3"));
    store
        .run_fs_migrations()
        .expect("fs migrations should succeed");
    (dir, store)
}

#[test]
fn logical_size_bytes_rejects_missing_database_without_creating_file() {
    let dir = tempdir().expect("temp dir should exist");
    let database_path = dir.path().join("missing.sqlite3");
    let store = FsStore::new(database_path.clone());

    let error = store
        .logical_size_bytes()
        .expect_err("missing database should fail");

    assert!(!error.is_empty());
    assert!(!database_path.exists());
}

#[test]
fn logical_size_bytes_uses_sqlite_page_size() {
    let (_dir, store) = new_store();
    let database_path = store.database_path().to_path_buf();
    let empty_size = store
        .logical_size_bytes()
        .expect("empty logical size should load");

    assert!(empty_size > 0);
    assert_eq!(
        empty_size,
        std::fs::metadata(&database_path)
            .expect("database file should exist")
            .len()
    );

    write_file(&store, "/Wiki/size.md", None, 10);
    let written_size = store
        .logical_size_bytes()
        .expect("written logical size should load");

    assert!(written_size >= empty_size);
    assert_eq!(
        written_size,
        std::fs::metadata(database_path)
            .expect("database file should exist")
            .len()
    );
}

fn old_fs_schema_store() -> (tempfile::TempDir, FsStore) {
    let dir = tempdir().expect("temp dir should exist");
    let database_path = dir.path().join("wiki.sqlite3");
    let conn = Connection::open(&database_path).expect("db should open");
    conn.execute_batch(include_str!("../migrations/000_schema_migrations.sql"))
        .expect("schema migrations table should create");
    conn.execute_batch(include_str!("../migrations/000_fs_schema.sql"))
        .expect("base schema should create");
    conn.execute(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (?1, 1)",
        ["wiki_store:000_fs_schema"],
    )
    .expect("base migration version should insert");
    drop(conn);
    (dir, FsStore::new(database_path))
}

fn insert_legacy_node(
    conn: &Connection,
    path: &str,
    kind: &str,
    content: &str,
    metadata_json: &str,
) {
    conn.execute(
        "INSERT INTO fs_nodes
         (path, kind, content, created_at, updated_at, etag, metadata_json)
         VALUES (?1, ?2, ?3, 10, 20, ?4, ?5)",
        params![path, kind, content, format!("etag-{path}"), metadata_json],
    )
    .expect("legacy node should insert");
}

fn record_legacy_change(conn: &Connection, path: &str) -> i64 {
    conn.execute(
        "INSERT INTO fs_change_log (path, change_kind) VALUES (?1, 'upsert')",
        [path],
    )
    .expect("legacy change should insert");
    let revision = conn.last_insert_rowid();
    conn.execute(
        "INSERT INTO fs_path_state (path, last_change_revision) VALUES (?1, ?2)",
        params![path, revision],
    )
    .expect("legacy path state should insert");
    revision
}

fn write_file(store: &FsStore, path: &str, expected_etag: Option<&str>, now: i64) -> String {
    ensure_parent_folders(store, path, now - 1);
    store
        .write_node(
            WriteNodeRequest {
                database_id: "default".to_string(),
                path: path.to_string(),
                kind: NodeKind::File,
                content: format!("content revision {now}"),
                metadata_json: "{}".to_string(),
                expected_etag: expected_etag.map(str::to_string),
            },
            now,
        )
        .expect("write should succeed")
        .node
        .etag
}

fn ensure_parent_folders(store: &FsStore, path: &str, now: i64) {
    let segments = path
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    let mut current = String::new();
    for segment in segments.iter().take(segments.len().saturating_sub(1)) {
        current.push('/');
        current.push_str(segment);
        store
            .mkdir_node(
                MkdirNodeRequest {
                    database_id: "default".to_string(),
                    path: current.clone(),
                },
                now,
            )
            .expect("parent folder should exist or be created");
    }
}

fn seed_sql_budget_rows(database_path: &Path, count: i64) {
    let mut conn = Connection::open(database_path).expect("db should open");
    let tx = conn.transaction().expect("seed transaction should start");
    {
        let mut insert = tx
            .prepare(
                "INSERT INTO fs_nodes
                 (path, kind, content, created_at, updated_at, etag, metadata_json, name)
                 VALUES (?1, 'file', ?2, ?3, ?3, ?4, '{}', ?5)",
            )
            .expect("seed insert should prepare");
        for index in 0_i64..count {
            let name = format!("node-{index:05}.md");
            insert
                .execute(params![
                    format!("/Wiki/budget/{name}"),
                    format!("budget content row {index}"),
                    index,
                    format!("etag-{index}"),
                    name,
                ])
                .expect("seed row should insert");
        }
    }
    tx.commit().expect("seed transaction should commit");
}

fn heavy_missing_sql() -> String {
    let predicates = vec!["length(content) >= 0"; 50].join(" AND ");
    format!(
        "SELECT json_object('path', path) FROM fs_nodes WHERE {predicates} AND content LIKE '%missing-budget-token%' LIMIT 1"
    )
}

#[test]
fn fs_migrations_create_tables() {
    let (_dir, store) = new_store();
    let conn = Connection::open(store.database_path()).expect("db should open");
    let tables = [
        "fs_nodes",
        "fs_nodes_fts",
        "fs_change_log",
        "fs_path_state",
        "schema_migrations",
    ];
    for table in tables {
        let exists = conn
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE name = ?1 LIMIT 1",
                [table],
                |row| row.get::<_, i64>(0),
            )
            .expect("table lookup should succeed");
        assert_eq!(exists, 1);
    }

    let fs_nodes_columns: Vec<(String, String, i64)> = conn
        .prepare("PRAGMA table_info(fs_nodes)")
        .expect("pragma should prepare")
        .query_map([], |row| Ok((row.get(1)?, row.get(2)?, row.get(5)?)))
        .expect("pragma should query")
        .collect::<Result<Vec<_>, _>>()
        .expect("pragma rows should collect");
    assert!(
        fs_nodes_columns.iter().any(|(name, ty, pk)| {
            name == "id" && ty.eq_ignore_ascii_case("INTEGER") && *pk == 1
        })
    );
    assert!(fs_nodes_columns.iter().any(|(name, _, _)| name == "path"));

    let fts_sql: String = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE name = 'fs_nodes_fts'",
            [],
            |row| row.get(0),
        )
        .expect("fts sql lookup should succeed");
    assert!(fts_sql.contains("fts5(\n    path,"));
    assert!(fts_sql.contains("title,"));
    assert!(fts_sql.contains("content\n"));

    let versions: Vec<String> = conn
        .prepare("SELECT version FROM schema_migrations ORDER BY version ASC")
        .expect("version query should prepare")
        .query_map([], |row| row.get(0))
        .expect("version query should run")
        .collect::<Result<Vec<_>, _>>()
        .expect("versions should collect");
    assert_eq!(
        versions,
        vec![
            "wiki_store:000_fs_schema".to_string(),
            "wiki_store:001_fs_links".to_string(),
            "wiki_store:002_fs_folders".to_string(),
            "wiki_store:003_wikilink_alias_links".to_string(),
            "wiki_store:004_rebuild_links_after_code_filter".to_string()
        ]
    );

    {
        let table = "fs_links";
        let exists = conn
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1 LIMIT 1",
                [table],
                |row| row.get::<_, i64>(0),
            )
            .expect("snapshot table lookup should succeed");
        assert_eq!(exists, 1);
    }

    for index in [
        "fs_nodes_path_covering_idx",
        "fs_nodes_recent_covering_idx",
        "fs_links_target_path_idx",
        "fs_links_source_path_idx",
    ] {
        let exists = conn
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?1 LIMIT 1",
                [index],
                |row| row.get::<_, i64>(0),
            )
            .expect("index lookup should succeed");
        assert_eq!(exists, 1);
    }
}

#[test]
fn list_queries_use_covering_indexes() {
    let (_dir, store) = new_store();
    write_file(&store, "/Wiki/indexed.md", None, 10);
    let conn = Connection::open(store.database_path()).expect("db should open");

    let list_plan = explain_query_plan(
        &conn,
        "SELECT path, kind, updated_at, etag
         FROM fs_nodes
         WHERE path = ?1 OR path LIKE ?2 ESCAPE '\\'
         ORDER BY path ASC",
        ["/Wiki", "/Wiki/%"],
    );
    assert!(
        list_plan.contains("COVERING INDEX fs_nodes_path_covering_idx"),
        "list should avoid table lookups: {list_plan}"
    );
}

#[test]
fn list_children_queries_use_parent_indexes() {
    let (_dir, store) = new_store();
    write_file(&store, "/Wiki/indexed.md", None, 10);
    write_file(&store, "/Wiki/nested/child.md", None, 11);
    let conn = Connection::open(store.database_path()).expect("db should open");
    let wiki_id = conn
        .query_row("SELECT id FROM fs_nodes WHERE path = '/Wiki'", [], |row| {
            row.get::<_, i64>(0)
        })
        .expect("wiki id should exist");

    let folder_plan = explain_query_plan_dynamic(
        &conn,
        "SELECT child.path, child.kind, child.updated_at, child.etag, length(CAST(child.content AS BLOB))
         FROM fs_nodes child
         WHERE child.parent_id = ?1
         ORDER BY child.name ASC",
        &[&wiki_id as &dyn rusqlite::ToSql],
    );
    assert!(
        folder_plan.contains("USING INDEX fs_nodes_parent_name_idx")
            || folder_plan.contains("USING INDEX fs_nodes_parent_idx"),
        "folder child query should use parent index: {folder_plan}"
    );

    let root_plan = explain_query_plan_dynamic(
        &conn,
        "SELECT child.path, child.kind, child.updated_at, child.etag, length(CAST(child.content AS BLOB))
         FROM fs_nodes child
         WHERE child.parent_id IS NULL
         ORDER BY child.name ASC",
        &[],
    );
    assert!(
        root_plan.contains("USING INDEX fs_nodes_parent_name_idx")
            || root_plan.contains("USING INDEX fs_nodes_parent_idx"),
        "root child query should use parent index: {root_plan}"
    );
}

#[test]
fn folder_move_subtree_query_uses_path_range_scan() {
    let (_dir, store) = new_store();
    write_file(&store, "/Wiki/move/a.md", None, 10);
    write_file(&store, "/Wiki/move/deep/b.md", None, 11);
    let conn = Connection::open(store.database_path()).expect("db should open");
    let prefix = "/Wiki/move/".to_string();
    let upper = "/Wiki/move/\u{10ffff}".to_string();

    let plan = explain_query_plan_dynamic(
        &conn,
        "SELECT path FROM fs_nodes
         WHERE path = ?1 OR (path >= ?2 AND path < ?3)
         ORDER BY length(path), path",
        &[&"/Wiki/move" as &dyn rusqlite::ToSql, &prefix, &upper],
    );
    assert!(
        plan.contains("path>? AND path<?") || plan.contains("MULTI-INDEX OR"),
        "folder move subtree query should use path range scan: {plan}"
    );
}

#[test]
fn prefix_filters_escape_sql_like_wildcards() {
    assert_prefix_scope_with_wildcards("/Wiki/a_b", "/Wiki/a_b/page.md", "/Wiki/axb/page.md", 100);
    assert_prefix_scope_with_wildcards(
        "/Wiki/a%b",
        "/Wiki/a%b/page.md",
        "/Wiki/azzzb/page.md",
        200,
    );
}

fn assert_prefix_scope_with_wildcards(
    prefix: &str,
    expected_path: &str,
    lookalike_path: &str,
    now_base: i64,
) {
    let (_dir, store) = new_store();
    let expected_etag = write_searchable_file(&store, expected_path, now_base);
    let lookalike_etag = write_searchable_file(&store, lookalike_path, now_base + 1);
    write_searchable_file(&store, "/Wiki/a_b/other.md", now_base + 2);
    write_searchable_file(&store, "/Wiki/a%b/other.md", now_base + 3);

    let list_paths = store
        .list_nodes(ListNodesRequest {
            database_id: "default".to_string(),
            prefix: prefix.to_string(),
            recursive: true,
        })
        .expect("list should succeed")
        .into_iter()
        .map(|entry| entry.path)
        .collect::<Vec<_>>();
    assert!(list_paths.contains(&expected_path.to_string()));
    assert!(!list_paths.contains(&lookalike_path.to_string()));

    let search_paths = store
        .search_nodes(SearchNodesRequest {
            database_id: "default".to_string(),
            query_text: "wildcard-token".to_string(),
            prefix: Some(prefix.to_string()),
            top_k: 100,
            preview_mode: Some(SearchPreviewMode::None),
        })
        .expect("search should succeed")
        .into_iter()
        .map(|hit| hit.path)
        .collect::<Vec<_>>();
    assert!(search_paths.contains(&expected_path.to_string()));
    assert!(!search_paths.contains(&lookalike_path.to_string()));

    let path_search_paths = store
        .search_node_paths(SearchNodePathsRequest {
            database_id: "default".to_string(),
            query_text: "page".to_string(),
            prefix: Some(prefix.to_string()),
            top_k: 100,
            preview_mode: None,
        })
        .expect("path search should succeed")
        .into_iter()
        .map(|hit| hit.path)
        .collect::<Vec<_>>();
    assert!(path_search_paths.contains(&expected_path.to_string()));
    assert!(!path_search_paths.contains(&lookalike_path.to_string()));

    let snapshot = store
        .export_snapshot(ExportSnapshotRequest {
            database_id: "default".to_string(),
            prefix: Some(prefix.to_string()),
            limit: 100,
            cursor: None,
            snapshot_revision: None,
            snapshot_session_id: None,
        })
        .expect("snapshot should succeed");
    let snapshot_paths = snapshot
        .nodes
        .iter()
        .map(|node| node.path.clone())
        .collect::<Vec<_>>();
    assert!(snapshot_paths.contains(&expected_path.to_string()));
    assert!(!snapshot_paths.contains(&lookalike_path.to_string()));

    update_searchable_file(&store, expected_path, &expected_etag, now_base + 10);
    update_searchable_file(&store, lookalike_path, &lookalike_etag, now_base + 11);
    let updates = store
        .fetch_updates(FetchUpdatesRequest {
            database_id: "default".to_string(),
            known_snapshot_revision: snapshot.snapshot_revision,
            prefix: Some(prefix.to_string()),
            limit: 100,
            cursor: None,
            target_snapshot_revision: None,
        })
        .expect("updates should succeed");
    let update_paths = updates
        .changed_nodes
        .into_iter()
        .map(|node| node.path)
        .collect::<Vec<_>>();
    assert!(update_paths.contains(&expected_path.to_string()));
    assert!(!update_paths.contains(&lookalike_path.to_string()));
}

fn write_searchable_file(store: &FsStore, path: &str, now: i64) -> String {
    ensure_parent_folders(store, path, now - 1);
    store
        .write_node(
            WriteNodeRequest {
                database_id: "default".to_string(),
                path: path.to_string(),
                kind: NodeKind::File,
                content: "wildcard-token body".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            now,
        )
        .expect("write should succeed")
        .node
        .etag
}

fn update_searchable_file(store: &FsStore, path: &str, etag: &str, now: i64) {
    ensure_parent_folders(store, path, now - 1);
    store
        .write_node(
            WriteNodeRequest {
                database_id: "default".to_string(),
                path: path.to_string(),
                kind: NodeKind::File,
                content: format!("wildcard-token updated {now}"),
                metadata_json: "{}".to_string(),
                expected_etag: Some(etag.to_string()),
            },
            now,
        )
        .expect("update should succeed");
}

fn explain_query_plan(conn: &Connection, sql: &str, params: [&str; 2]) -> String {
    explain_query_plan_dynamic(conn, sql, &[&params[0] as &dyn rusqlite::ToSql, &params[1]])
}

fn explain_query_plan_dynamic(
    conn: &Connection,
    sql: &str,
    params: &[&dyn rusqlite::ToSql],
) -> String {
    conn.prepare(&format!("EXPLAIN QUERY PLAN {sql}"))
        .expect("explain should prepare")
        .query_map(params, |row| row.get::<_, String>(3))
        .expect("explain should run")
        .collect::<Result<Vec<_>, _>>()
        .expect("explain rows should collect")
        .join("\n")
}

#[test]
fn status_counts_live_files_and_sources() {
    let (_dir, store) = new_store();
    let file = store
        .write_node(
            WriteNodeRequest {
                database_id: "default".to_string(),
                path: "/Wiki/file.md".to_string(),
                kind: NodeKind::File,
                content: "alpha".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            10,
        )
        .expect("file write should succeed");
    ensure_parent_folders(&store, "/Sources/raw/source/source.md", 10);
    let source = store
        .write_node(
            WriteNodeRequest {
                database_id: "default".to_string(),
                path: "/Sources/raw/source/source.md".to_string(),
                kind: NodeKind::Source,
                content: "source".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            11,
        )
        .expect("source write should succeed");
    store
        .delete_node(
            DeleteNodeRequest {
                database_id: "default".to_string(),
                path: "/Wiki/file.md".to_string(),
                expected_etag: Some(file.node.etag),
                expected_folder_index_etag: None,
            },
            12,
        )
        .expect("delete should succeed");

    let status = store.status().expect("status should succeed");
    assert_eq!(status.file_count, 0);
    assert_eq!(status.source_count, 1);
    assert_eq!(source.node.kind, NodeKind::Source);
}

#[test]
fn write_nodes_creates_files_and_sources_atomically() {
    let (_dir, store) = new_store();
    ensure_parent_folders(&store, "/Sources/raw/source/source.md", 9);

    let results = store
        .write_nodes(
            WriteNodesRequest {
                database_id: "default".to_string(),
                nodes: vec![
                    WriteNodeItem {
                        path: "/Wiki/batch-a.md".to_string(),
                        kind: NodeKind::File,
                        content: "alpha link [[batch-b]]".to_string(),
                        metadata_json: "{}".to_string(),
                        expected_etag: None,
                    },
                    WriteNodeItem {
                        path: "/Sources/raw/source/source.md".to_string(),
                        kind: NodeKind::Source,
                        content: "source alpha".to_string(),
                        metadata_json: "{}".to_string(),
                        expected_etag: None,
                    },
                ],
            },
            10,
        )
        .expect("batch write should succeed");

    assert_eq!(results.len(), 2);
    assert!(results.iter().all(|result| result.created));
    assert!(
        store
            .read_node("/Wiki/batch-a.md")
            .expect("read should succeed")
            .is_some()
    );
    assert!(
        store
            .read_node("/Sources/raw/source/source.md")
            .expect("read should succeed")
            .is_some()
    );
}

#[test]
fn write_nodes_rolls_back_when_later_item_fails() {
    let (_dir, store) = new_store();
    let existing = write_file(&store, "/Wiki/existing.md", None, 9);

    let error = store
        .write_nodes(
            WriteNodesRequest {
                database_id: "default".to_string(),
                nodes: vec![
                    WriteNodeItem {
                        path: "/Wiki/new-before-error.md".to_string(),
                        kind: NodeKind::File,
                        content: "new content".to_string(),
                        metadata_json: "{}".to_string(),
                        expected_etag: None,
                    },
                    WriteNodeItem {
                        path: "/Wiki/existing.md".to_string(),
                        kind: NodeKind::File,
                        content: "stale update".to_string(),
                        metadata_json: "{}".to_string(),
                        expected_etag: Some("stale".to_string()),
                    },
                ],
            },
            10,
        )
        .expect_err("stale item should fail");

    assert!(error.contains("expected_etag"));
    assert!(
        store
            .read_node("/Wiki/new-before-error.md")
            .expect("read should succeed")
            .is_none()
    );
    assert_eq!(
        store
            .read_node("/Wiki/existing.md")
            .expect("read should succeed")
            .expect("existing node should remain")
            .etag,
        existing
    );
}

#[test]
fn write_nodes_rejects_folder_item_without_partial_write() {
    let (_dir, store) = new_store();

    let error = store
        .write_nodes(
            WriteNodesRequest {
                database_id: "default".to_string(),
                nodes: vec![
                    WriteNodeItem {
                        path: "/Wiki/new-before-folder.md".to_string(),
                        kind: NodeKind::File,
                        content: "new content".to_string(),
                        metadata_json: "{}".to_string(),
                        expected_etag: None,
                    },
                    WriteNodeItem {
                        path: "/Wiki/folder".to_string(),
                        kind: NodeKind::Folder,
                        content: String::new(),
                        metadata_json: "{}".to_string(),
                        expected_etag: None,
                    },
                ],
            },
            10,
        )
        .expect_err("folder item should fail");

    assert!(error.contains("write_node cannot create folders"));
    assert!(
        store
            .read_node("/Wiki/new-before-folder.md")
            .expect("read should succeed")
            .is_none()
    );
}

#[test]
fn write_nodes_updates_search_and_links() {
    let (_dir, store) = new_store();

    store
        .write_nodes(
            WriteNodesRequest {
                database_id: "default".to_string(),
                nodes: vec![WriteNodeItem {
                    path: "/Wiki/linking.md".to_string(),
                    kind: NodeKind::File,
                    content: "batch-token links to [[target]]".to_string(),
                    metadata_json: "{}".to_string(),
                    expected_etag: None,
                }],
            },
            10,
        )
        .expect("batch write should succeed");

    let hits = store
        .search_nodes(SearchNodesRequest {
            database_id: "default".to_string(),
            query_text: "batch-token".to_string(),
            prefix: Some("/Wiki".to_string()),
            top_k: 10,
            preview_mode: Some(SearchPreviewMode::None),
        })
        .expect("search should succeed");
    assert!(hits.iter().any(|hit| hit.path == "/Wiki/linking.md"));
    let links = store
        .outgoing_links(OutgoingLinksRequest {
            database_id: "default".to_string(),
            path: "/Wiki/linking.md".to_string(),
            limit: 10,
        })
        .expect("links should load");
    assert!(links.iter().any(|link| link.target_path == "/Wiki/target"));
}

#[test]
fn change_log_retains_all_recorded_revisions() {
    let (_dir, store) = new_store();
    for now in 10..=270 {
        let path = format!("/Wiki/history-{now}.md");
        write_file(&store, &path, None, now);
    }

    let conn = Connection::open(store.database_path()).expect("db should open");
    let revision_count = conn
        .query_row("SELECT COUNT(*) FROM fs_change_log", [], |row| {
            row.get::<_, i64>(0)
        })
        .expect("count should succeed");
    let oldest_revision = conn
        .query_row("SELECT MIN(revision) FROM fs_change_log", [], |row| {
            row.get::<_, i64>(0)
        })
        .expect("min revision should succeed");
    let newest_revision = conn
        .query_row("SELECT MAX(revision) FROM fs_change_log", [], |row| {
            row.get::<_, i64>(0)
        })
        .expect("max revision should succeed");

    assert_eq!(revision_count, 265);
    assert_eq!(oldest_revision, 1);
    assert_eq!(newest_revision, 265);
}

#[test]
fn fs_path_state_tracks_latest_change_revision() {
    let (_dir, store) = new_store();
    let first = write_file(&store, "/Wiki/file.md", None, 10);
    let second = write_file(&store, "/Wiki/file.md", Some(&first), 11);
    store
        .delete_node(
            DeleteNodeRequest {
                database_id: "default".to_string(),
                path: "/Wiki/file.md".to_string(),
                expected_etag: Some(second),
                expected_folder_index_etag: None,
            },
            12,
        )
        .expect("delete should succeed");

    let conn = Connection::open(store.database_path()).expect("db should open");
    let revision = conn
        .query_row(
            "SELECT last_change_revision FROM fs_path_state WHERE path = '/Wiki/file.md'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .expect("path state should exist");
    assert_eq!(revision, 7);
}

#[test]
fn delete_folder_with_index_deletes_both_nodes() {
    let (_dir, store) = new_store();
    store
        .mkdir_node(
            MkdirNodeRequest {
                database_id: "default".to_string(),
                path: "/Wiki/topic".to_string(),
            },
            10,
        )
        .expect("folder should create");
    let folder = store
        .read_node("/Wiki/topic")
        .expect("folder should read")
        .expect("folder should exist");
    let index_etag = write_file(&store, "/Wiki/topic/index.md", None, 11);

    store
        .delete_node(
            DeleteNodeRequest {
                database_id: "default".to_string(),
                path: "/Wiki/topic".to_string(),
                expected_etag: Some(folder.etag),
                expected_folder_index_etag: Some(index_etag),
            },
            12,
        )
        .expect("folder delete should succeed");

    assert!(
        store
            .read_node("/Wiki/topic")
            .expect("folder read should succeed")
            .is_none()
    );
    assert!(
        store
            .read_node("/Wiki/topic/index.md")
            .expect("index read should succeed")
            .is_none()
    );
}

#[test]
fn delete_folder_with_index_and_visible_child_keeps_all_nodes() {
    let (_dir, store) = new_store();
    store
        .mkdir_node(
            MkdirNodeRequest {
                database_id: "default".to_string(),
                path: "/Wiki/topic".to_string(),
            },
            10,
        )
        .expect("folder should create");
    let folder = store
        .read_node("/Wiki/topic")
        .expect("folder should read")
        .expect("folder should exist");
    let index_etag = write_file(&store, "/Wiki/topic/index.md", None, 11);
    write_file(&store, "/Wiki/topic/child.md", None, 12);

    let error = store
        .delete_node(
            DeleteNodeRequest {
                database_id: "default".to_string(),
                path: "/Wiki/topic".to_string(),
                expected_etag: Some(folder.etag),
                expected_folder_index_etag: Some(index_etag),
            },
            13,
        )
        .expect_err("visible child should block folder delete");

    assert!(error.contains("folder is not empty"));
    for path in [
        "/Wiki/topic",
        "/Wiki/topic/index.md",
        "/Wiki/topic/child.md",
    ] {
        assert!(
            store
                .read_node(path)
                .expect("node read should succeed")
                .is_some(),
            "{path} should remain"
        );
    }
}

#[test]
fn delete_folder_with_stale_index_etag_keeps_folder_and_index() {
    let (_dir, store) = new_store();
    store
        .mkdir_node(
            MkdirNodeRequest {
                database_id: "default".to_string(),
                path: "/Wiki/topic".to_string(),
            },
            10,
        )
        .expect("folder should create");
    let folder = store
        .read_node("/Wiki/topic")
        .expect("folder should read")
        .expect("folder should exist");
    write_file(&store, "/Wiki/topic/index.md", None, 11);

    let error = store
        .delete_node(
            DeleteNodeRequest {
                database_id: "default".to_string(),
                path: "/Wiki/topic".to_string(),
                expected_etag: Some(folder.etag),
                expected_folder_index_etag: Some("stale".to_string()),
            },
            12,
        )
        .expect_err("stale index etag should fail");

    assert!(error.contains("expected_folder_index_etag"));
    assert!(
        store
            .read_node("/Wiki/topic")
            .expect("folder read should succeed")
            .is_some()
    );
    assert!(
        store
            .read_node("/Wiki/topic/index.md")
            .expect("index read should succeed")
            .is_some()
    );
}

#[test]
fn delete_empty_folder_without_index_still_succeeds() {
    let (_dir, store) = new_store();
    store
        .mkdir_node(
            MkdirNodeRequest {
                database_id: "default".to_string(),
                path: "/Wiki/topic".to_string(),
            },
            10,
        )
        .expect("folder should create");
    let folder = store
        .read_node("/Wiki/topic")
        .expect("folder should read")
        .expect("folder should exist");

    store
        .delete_node(
            DeleteNodeRequest {
                database_id: "default".to_string(),
                path: "/Wiki/topic".to_string(),
                expected_etag: Some(folder.etag),
                expected_folder_index_etag: None,
            },
            11,
        )
        .expect("empty folder delete should succeed");

    assert!(
        store
            .read_node("/Wiki/topic")
            .expect("folder read should succeed")
            .is_none()
    );
}

#[test]
fn delete_file_rejects_folder_index_etag() {
    let (_dir, store) = new_store();
    let etag = write_file(&store, "/Wiki/file.md", None, 10);

    let error = store
        .delete_node(
            DeleteNodeRequest {
                database_id: "default".to_string(),
                path: "/Wiki/file.md".to_string(),
                expected_etag: Some(etag),
                expected_folder_index_etag: Some("index".to_string()),
            },
            11,
        )
        .expect_err("file delete should reject folder index etag");

    assert!(error.contains("expected_folder_index_etag"));
    assert!(
        store
            .read_node("/Wiki/file.md")
            .expect("file read should succeed")
            .is_some()
    );
}

#[test]
fn fs_migrations_are_idempotent() {
    let (_dir, store) = new_store();
    write_file(&store, "/Wiki/alpha.md", None, 10);
    write_file(&store, "/Wiki/beta.md", None, 11);

    store
        .run_fs_migrations()
        .expect("rerunning migrations should be a no-op");

    let conn = Connection::open(store.database_path()).expect("db should open");
    let versions = conn
        .prepare("SELECT version FROM schema_migrations ORDER BY version ASC")
        .expect("version query should prepare")
        .query_map([], |row| row.get::<_, String>(0))
        .expect("version query should run")
        .collect::<Result<Vec<_>, _>>()
        .expect("versions should collect");
    assert_eq!(
        versions,
        vec![
            "wiki_store:000_fs_schema".to_string(),
            "wiki_store:001_fs_links".to_string(),
            "wiki_store:002_fs_folders".to_string(),
            "wiki_store:003_wikilink_alias_links".to_string(),
            "wiki_store:004_rebuild_links_after_code_filter".to_string()
        ]
    );

    let tracked_paths = conn
        .query_row("SELECT COUNT(*) FROM fs_path_state", [], |row| {
            row.get::<_, i64>(0)
        })
        .expect("path state count should succeed");
    assert_eq!(tracked_paths, 6);
}

#[test]
fn fs_links_migration_backfills_existing_nodes() {
    let dir = tempdir().expect("temp dir should exist");
    let database_path = dir.path().join("wiki.sqlite3");
    let conn = Connection::open(&database_path).expect("db should open");
    conn.execute_batch(include_str!("../migrations/000_schema_migrations.sql"))
        .expect("schema migrations table should create");
    conn.execute_batch(include_str!("../migrations/000_fs_schema.sql"))
        .expect("base schema should create");
    conn.execute(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (?1, 1)",
        ["wiki_store:000_fs_schema"],
    )
    .expect("base migration version should insert");
    conn.execute(
        "INSERT INTO fs_nodes
         (path, kind, content, created_at, updated_at, etag, metadata_json)
         VALUES (?1, 'file', ?2, 10, 20, 'etag-source', '{}')",
        params![
            "/Wiki/source.md",
            "[Target](/Wiki/target.md) and [[/Wiki/other.md]]",
        ],
    )
    .expect("first existing node should insert");
    let large_content = format!(
        "{}\n[Large Target](/Wiki/large-target.md)",
        "large body ".repeat(20_000)
    );
    conn.execute(
        "INSERT INTO fs_nodes
         (path, kind, content, created_at, updated_at, etag, metadata_json)
         VALUES (?1, 'file', ?2, 11, 21, 'etag-large', '{}')",
        params!["/Wiki/large.md", large_content],
    )
    .expect("large existing node should insert");
    let dense_links = (0..50)
        .map(|index| format!("[Node {index}](/Wiki/dense/{index}.md)"))
        .chain([
            "[Dup](/Wiki/dup.md)".to_string(),
            "[Dup again](/Wiki/dup.md)".to_string(),
        ])
        .collect::<Vec<_>>()
        .join("\n");
    conn.execute(
        "INSERT INTO fs_nodes
         (path, kind, content, created_at, updated_at, etag, metadata_json)
         VALUES (?1, 'file', ?2, 12, 22, 'etag-dense', '{}')",
        params!["/Wiki/dense.md", dense_links],
    )
    .expect("dense existing node should insert");
    conn.execute(
        "INSERT INTO fs_nodes
         (path, kind, content, created_at, updated_at, etag, metadata_json)
         VALUES (?1, 'file', ?2, 13, 23, 'etag-plain', '{}')",
        params!["/Wiki/plain.md", "plain body without links"],
    )
    .expect("plain existing node should insert");
    drop(conn);

    let store = FsStore::new(database_path.clone());
    store
        .run_fs_migrations()
        .expect("fs links migration should succeed");
    let conn = Connection::open(database_path).expect("db should reopen");
    let link_count = conn
        .query_row("SELECT COUNT(*) FROM fs_links", [], |row| {
            row.get::<_, i64>(0)
        })
        .expect("link count should load");
    assert_eq!(link_count, 54);
    let duplicate_count = conn
        .query_row(
            "SELECT COUNT(*) FROM fs_links
             WHERE source_path = '/Wiki/dense.md'
               AND target_path = '/Wiki/dup.md'
               AND raw_href = '/Wiki/dup.md'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .expect("duplicate link count should load");
    assert_eq!(duplicate_count, 1);

    let outgoing = store
        .outgoing_links(OutgoingLinksRequest {
            database_id: "default".to_string(),
            path: "/Wiki/source.md".to_string(),
            limit: 10,
        })
        .expect("outgoing links should load");
    let targets = outgoing
        .into_iter()
        .map(|edge| edge.target_path)
        .collect::<Vec<_>>();
    assert_eq!(
        targets,
        vec!["/Wiki/other.md".to_string(), "/Wiki/target.md".to_string()]
    );
    let large_outgoing = store
        .outgoing_links(OutgoingLinksRequest {
            database_id: "default".to_string(),
            path: "/Wiki/large.md".to_string(),
            limit: 10,
        })
        .expect("large outgoing links should load");
    assert_eq!(large_outgoing[0].target_path, "/Wiki/large-target.md");
    let dense_outgoing = store
        .outgoing_links(OutgoingLinksRequest {
            database_id: "default".to_string(),
            path: "/Wiki/dense.md".to_string(),
            limit: 100,
        })
        .expect("dense outgoing links should load");
    assert_eq!(dense_outgoing.len(), 51);
    let plain_outgoing = store
        .outgoing_links(OutgoingLinksRequest {
            database_id: "default".to_string(),
            path: "/Wiki/plain.md".to_string(),
            limit: 100,
        })
        .expect("plain outgoing links should load");
    assert!(plain_outgoing.is_empty());
}

#[test]
fn wikilink_alias_migration_rebuilds_existing_links() {
    let dir = tempdir().expect("temp dir should exist");
    let database_path = dir.path().join("wiki.sqlite3");
    let conn = Connection::open(&database_path).expect("db should open");
    conn.execute_batch(include_str!("../migrations/000_schema_migrations.sql"))
        .expect("schema migrations table should create");
    conn.execute_batch(include_str!("../migrations/000_fs_schema.sql"))
        .expect("base schema should create");
    conn.execute_batch(include_str!("../migrations/001_fs_links.sql"))
        .expect("links schema should create");
    conn.execute_batch(include_str!("../migrations/002_fs_folders.sql"))
        .expect("folder schema should create");
    conn.execute(
        "INSERT INTO fs_nodes
         (path, kind, content, created_at, updated_at, etag, metadata_json, parent_id, name)
         VALUES (?1, 'file', ?2, 10, 20, 'etag-source', '{}', NULL, 'source.md')",
        params![
            "/Wiki/source.md",
            "[[/Sources/raw/a/a.md|opencode.ai/DESIGN.md]]",
        ],
    )
    .expect("existing node should insert");
    conn.execute(
        "INSERT INTO fs_links
         (source_path, target_path, raw_href, link_text, link_kind, updated_at)
         VALUES (?1, ?2, ?2, ?2, 'wikilink', 20)",
        params![
            "/Wiki/source.md",
            "/Sources/raw/a/a.md|opencode.ai/DESIGN.md",
        ],
    )
    .expect("old link row should insert");
    for version in [
        "wiki_store:000_fs_schema",
        "wiki_store:001_fs_links",
        "wiki_store:002_fs_folders",
    ] {
        conn.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (?1, 0)",
            [version],
        )
        .expect("version should insert");
    }
    drop(conn);

    let store = FsStore::new(database_path.clone());
    store
        .run_fs_migrations()
        .expect("wikilink alias migration should succeed");

    let outgoing = store
        .outgoing_links(OutgoingLinksRequest {
            database_id: "default".to_string(),
            path: "/Wiki/source.md".to_string(),
            limit: 10,
        })
        .expect("outgoing links should load");
    assert_eq!(outgoing.len(), 1);
    assert_eq!(outgoing[0].target_path, "/Sources/raw/a/a.md");
    assert_eq!(
        outgoing[0].raw_href,
        "/Sources/raw/a/a.md|opencode.ai/DESIGN.md"
    );
    assert_eq!(outgoing[0].link_text, "opencode.ai/DESIGN.md");
}

#[test]
fn code_filter_migration_rebuilds_existing_links() {
    let dir = tempdir().expect("temp dir should exist");
    let database_path = dir.path().join("wiki.sqlite3");
    let conn = Connection::open(&database_path).expect("db should open");
    conn.execute_batch(include_str!("../migrations/000_schema_migrations.sql"))
        .expect("schema migrations table should create");
    conn.execute_batch(include_str!("../migrations/000_fs_schema.sql"))
        .expect("base schema should create");
    conn.execute_batch(include_str!("../migrations/001_fs_links.sql"))
        .expect("links schema should create");
    conn.execute_batch(include_str!("../migrations/002_fs_folders.sql"))
        .expect("folder schema should create");
    conn.execute_batch(include_str!("../migrations/003_wikilink_alias_links.sql"))
        .expect("alias migration should apply");
    conn.execute(
        "INSERT INTO fs_nodes
         (path, kind, content, created_at, updated_at, etag, metadata_json, parent_id, name)
         VALUES (?1, 'file', ?2, 10, 20, 'etag-source', '{}', NULL, 'source.md')",
        params![
            "/Wiki/source.md",
            "```md\n[[alpha.md|Alpha]]\n[Alpha](alpha.md)\n```\n[[beta.md|Beta]]",
        ],
    )
    .expect("existing node should insert");
    conn.execute(
        "INSERT INTO fs_links
         (source_path, target_path, raw_href, link_text, link_kind, updated_at)
         VALUES (?1, ?2, 'alpha.md|Alpha', 'Alpha', 'wikilink', 20)",
        params!["/Wiki/source.md", "/Wiki/alpha.md"],
    )
    .expect("old code link row should insert");
    for version in [
        "wiki_store:000_fs_schema",
        "wiki_store:001_fs_links",
        "wiki_store:002_fs_folders",
        "wiki_store:003_wikilink_alias_links",
    ] {
        conn.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (?1, 0)",
            [version],
        )
        .expect("version should insert");
    }
    drop(conn);

    let store = FsStore::new(database_path.clone());
    store
        .run_fs_migrations()
        .expect("code filter migration should succeed");

    let outgoing = store
        .outgoing_links(OutgoingLinksRequest {
            database_id: "default".to_string(),
            path: "/Wiki/source.md".to_string(),
            limit: 10,
        })
        .expect("outgoing links should load");
    assert_eq!(outgoing.len(), 1);
    assert_eq!(outgoing[0].target_path, "/Wiki/beta.md");
    assert_eq!(outgoing[0].raw_href, "beta.md|Beta");
    assert_eq!(outgoing[0].link_text, "Beta");
}

#[test]
fn fs_folder_migration_promotes_empty_file_parent_to_folder() {
    let (_dir, store) = old_fs_schema_store();
    let conn = Connection::open(store.database_path()).expect("db should open");
    insert_legacy_node(&conn, "/Wiki/foo", "file", "", "{}");
    insert_legacy_node(&conn, "/Wiki/foo/bar.md", "file", "bar", "{}");
    drop(conn);

    store
        .run_fs_migrations()
        .expect("folder migration should promote empty parent");

    let folder = store
        .read_node("/Wiki/foo")
        .expect("folder should read")
        .expect("folder should exist");
    assert_eq!(folder.kind, NodeKind::Folder);
    assert_eq!(folder.content, "");
    assert_eq!(folder.metadata_json, "{}");

    let children = store
        .list_children(ListChildrenRequest {
            database_id: "default".to_string(),
            path: "/Wiki/foo".to_string(),
        })
        .expect("promoted folder should list children");
    assert_eq!(children.len(), 1);
    assert_eq!(children[0].path, "/Wiki/foo/bar.md");
    assert_eq!(children[0].kind, NodeEntryKind::File);
}

#[test]
fn fs_folder_migration_keeps_existing_file_source_etags_out_of_sync_delta() {
    let (_dir, store) = old_fs_schema_store();
    let conn = Connection::open(store.database_path()).expect("db should open");
    insert_legacy_node(&conn, "/Wiki/existing.md", "file", "existing", "{}");
    insert_legacy_node(&conn, "/Sources/raw/source.md", "source", "raw", "{}");
    let wiki_revision = record_legacy_change(&conn, "/Wiki/existing.md");
    record_legacy_change(&conn, "/Sources/raw/source.md");
    drop(conn);

    store
        .run_fs_migrations()
        .expect("folder migration should succeed");

    let file = store
        .read_node("/Wiki/existing.md")
        .expect("file should read")
        .expect("file should exist");
    let source = store
        .read_node("/Sources/raw/source.md")
        .expect("source should read")
        .expect("source should exist");
    assert_eq!(file.etag, "etag-/Wiki/existing.md");
    assert_eq!(source.etag, "etag-/Sources/raw/source.md");

    let updates = store
        .fetch_updates(FetchUpdatesRequest {
            database_id: "default".to_string(),
            known_snapshot_revision: format!("v5:{wiki_revision}:2f57696b69"),
            prefix: Some("/Wiki".to_string()),
            limit: 100,
            cursor: None,
            target_snapshot_revision: None,
        })
        .expect("updates should succeed");
    assert!(
        updates
            .changed_nodes
            .iter()
            .any(|node| node.path == "/Wiki" && node.kind == NodeKind::Folder)
    );
    assert!(
        !updates
            .changed_nodes
            .iter()
            .any(|node| node.path == "/Wiki/existing.md")
    );
}

#[test]
fn fs_folder_migration_reports_promoted_folder_in_sync_delta() {
    let (_dir, store) = old_fs_schema_store();
    let conn = Connection::open(store.database_path()).expect("db should open");
    insert_legacy_node(&conn, "/Wiki/foo", "file", "", "{}");
    insert_legacy_node(&conn, "/Wiki/foo/bar.md", "file", "bar", "{}");
    record_legacy_change(&conn, "/Wiki/foo");
    let child_revision = record_legacy_change(&conn, "/Wiki/foo/bar.md");
    drop(conn);

    store
        .run_fs_migrations()
        .expect("folder migration should promote empty parent");

    let updates = store
        .fetch_updates(FetchUpdatesRequest {
            database_id: "default".to_string(),
            known_snapshot_revision: format!("v5:{child_revision}:2f57696b69"),
            prefix: Some("/Wiki".to_string()),
            limit: 100,
            cursor: None,
            target_snapshot_revision: None,
        })
        .expect("updates should succeed");
    assert!(
        updates
            .changed_nodes
            .iter()
            .any(|node| node.path == "/Wiki/foo" && node.kind == NodeKind::Folder)
    );
    assert!(
        !updates
            .changed_nodes
            .iter()
            .any(|node| node.path == "/Wiki/foo/bar.md")
    );
}

#[test]
fn fs_folder_migration_keeps_legacy_nodes_usable_with_current_etags() {
    let (_dir, store) = old_fs_schema_store();
    let conn = Connection::open(store.database_path()).expect("db should open");
    insert_legacy_node(&conn, "/Wiki/foo/bar.md", "file", "bar", "{}");
    insert_legacy_node(
        &conn,
        "/Sources/raw/web/web.md",
        "source",
        "raw",
        r#"{"source_type":"url"}"#,
    );
    drop(conn);

    store
        .run_fs_migrations()
        .expect("folder migration should succeed");

    let file = store
        .read_node("/Wiki/foo/bar.md")
        .expect("legacy file should read")
        .expect("legacy file should exist");
    assert_eq!(file.kind, NodeKind::File);
    assert_eq!(file.content, "bar");
    let source = store
        .read_node("/Sources/raw/web/web.md")
        .expect("legacy source should read")
        .expect("legacy source should exist");
    assert_eq!(source.kind, NodeKind::Source);
    assert_eq!(source.metadata_json, r#"{"source_type":"url"}"#);

    let children = store
        .list_children(ListChildrenRequest {
            database_id: "default".to_string(),
            path: "/Wiki/foo".to_string(),
        })
        .expect("backfilled folder should list children");
    assert_eq!(children.len(), 1);
    assert_eq!(children[0].path, "/Wiki/foo/bar.md");

    let updated = store
        .write_node(
            WriteNodeRequest {
                database_id: "default".to_string(),
                path: "/Wiki/foo/bar.md".to_string(),
                kind: NodeKind::File,
                content: "bar updated".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: Some(file.etag),
            },
            30,
        )
        .expect("legacy file update with migrated etag should succeed");
    store
        .move_node(
            MoveNodeRequest {
                database_id: "default".to_string(),
                from_path: "/Wiki/foo/bar.md".to_string(),
                to_path: "/Wiki/foo/baz.md".to_string(),
                expected_etag: Some(updated.node.etag),
                overwrite: false,
            },
            31,
        )
        .expect("legacy file move with updated etag should succeed");
    store
        .delete_node(
            DeleteNodeRequest {
                database_id: "default".to_string(),
                path: "/Sources/raw/web/web.md".to_string(),
                expected_etag: Some(source.etag),
                expected_folder_index_etag: None,
            },
            32,
        )
        .expect("legacy source delete with migrated etag should succeed");
}

#[test]
fn fs_folder_migration_rejects_content_file_parent_conflict() {
    let (_dir, store) = old_fs_schema_store();
    let conn = Connection::open(store.database_path()).expect("db should open");
    insert_legacy_node(&conn, "/Wiki/foo", "file", " ", "{}");
    insert_legacy_node(&conn, "/Wiki/foo/bar.md", "file", "bar", "{}");
    drop(conn);

    let error = store
        .run_fs_migrations()
        .expect_err("non-empty parent conflict should fail migration");
    assert!(error.contains("folder path conflicts with non-empty node: /Wiki/foo"));
}

#[test]
fn fs_folder_migration_rejects_metadata_file_parent_conflict() {
    let (_dir, store) = old_fs_schema_store();
    let conn = Connection::open(store.database_path()).expect("db should open");
    insert_legacy_node(&conn, "/Wiki/foo", "file", "", r#"{"note":true}"#);
    insert_legacy_node(&conn, "/Wiki/foo/bar.md", "file", "bar", "{}");
    drop(conn);

    let error = store
        .run_fs_migrations()
        .expect_err("metadata parent conflict should fail migration");
    assert!(error.contains("folder path conflicts with non-empty node: /Wiki/foo"));
}

#[test]
fn fs_migrations_reject_legacy_schema_history() {
    let (_dir, store) = new_store();
    let conn = Connection::open(store.database_path()).expect("db should open");
    conn.execute(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (?1, 0)",
        ["wiki_store:legacy_schema"],
    )
    .expect("legacy version should insert");

    let error = store
        .run_fs_migrations()
        .expect_err("legacy schema should be rejected");
    assert!(error.contains("legacy wiki_store schema is unsupported"));
}

#[test]
fn fs_migrations_reject_old_fs_schema_shape_even_with_current_version() {
    let dir = tempdir().expect("temp dir should exist");
    let store = FsStore::new(dir.path().join("wiki.sqlite3"));
    let conn = Connection::open(store.database_path()).expect("db should open");
    conn.execute_batch(
        "
        CREATE TABLE schema_migrations (
            version TEXT PRIMARY KEY,
            applied_at INTEGER NOT NULL
        );
        CREATE TABLE fs_nodes (
            id INTEGER PRIMARY KEY,
            path TEXT NOT NULL UNIQUE,
            kind TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            etag TEXT NOT NULL,
            metadata_json TEXT NOT NULL DEFAULT '{}'
        );
        CREATE VIRTUAL TABLE fs_nodes_fts USING fts5(
            content,
            content='fs_nodes',
            content_rowid='id'
        );
        CREATE TABLE fs_change_log (
            revision INTEGER PRIMARY KEY AUTOINCREMENT,
            path TEXT NOT NULL,
            change_kind TEXT NOT NULL
                CHECK (change_kind IN ('upsert', 'path_removal'))
        );
        CREATE INDEX fs_nodes_path_covering_idx
        ON fs_nodes (path, kind, updated_at, etag);
        CREATE INDEX fs_nodes_recent_covering_idx
        ON fs_nodes (updated_at DESC, path ASC, kind, etag);
        ",
    )
    .expect("legacy schema should create");
    conn.execute(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (?1, 0)",
        ["wiki_store:000_fs_schema"],
    )
    .expect("current version stamp should insert");

    let error = store
        .run_fs_migrations()
        .expect_err("old 000 schema shape should be rejected");
    assert!(error.contains("legacy wiki_store schema is unsupported"));
}

#[test]
fn fs_migrations_reject_current_schema_missing_parent_index() {
    let (_dir, store) = new_store();
    let conn = Connection::open(store.database_path()).expect("db should open");
    conn.execute("DROP INDEX fs_nodes_parent_idx", [])
        .expect("parent index should drop");

    let error = store
        .run_fs_migrations()
        .expect_err("current schema missing parent index should be rejected");
    assert!(error.contains("legacy wiki_store schema is unsupported"));
}

#[test]
fn fs_migrations_reject_current_schema_missing_parent_columns() {
    let dir = tempdir().expect("temp dir should exist");
    let store = FsStore::new(dir.path().join("wiki.sqlite3"));
    let conn = Connection::open(store.database_path()).expect("db should open");
    conn.execute_batch(include_str!("../migrations/000_schema_migrations.sql"))
        .expect("schema migrations table should create");
    conn.execute_batch(include_str!("../migrations/000_fs_schema.sql"))
        .expect("base schema should create");
    conn.execute_batch(include_str!("../migrations/001_fs_links.sql"))
        .expect("links schema should create");
    conn.execute_batch(
        "ALTER TABLE fs_nodes ADD COLUMN parent_id INTEGER;
         CREATE UNIQUE INDEX fs_nodes_parent_name_idx
         ON fs_nodes (COALESCE(parent_id, 0), path);
         CREATE INDEX fs_nodes_parent_idx ON fs_nodes(parent_id);",
    )
    .expect("partial parent schema should create");
    for version in [
        "wiki_store:000_fs_schema",
        "wiki_store:001_fs_links",
        "wiki_store:002_fs_folders",
        "wiki_store:003_wikilink_alias_links",
        "wiki_store:004_rebuild_links_after_code_filter",
    ] {
        conn.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (?1, 0)",
            [version],
        )
        .expect("version should insert");
    }

    let error = store
        .run_fs_migrations()
        .expect_err("current schema missing name column should be rejected");
    assert!(error.contains("legacy wiki_store schema is unsupported"));
}

#[test]
fn search_nodes_returns_error_for_invalid_stored_kind() {
    let (_dir, store) = new_store();
    let conn = Connection::open(store.database_path()).expect("db should open");
    conn.execute(
        "INSERT INTO fs_nodes (id, path, kind, content, created_at, updated_at, etag, metadata_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        rusqlite::params![
            100_i64,
            "/Wiki/broken.md",
            "broken",
            "searchable broken content",
            10_i64,
            10_i64,
            "etag-broken",
            "{}",
        ],
    )
    .expect("invalid kind row should insert");
    conn.execute(
        "INSERT INTO fs_nodes_fts (rowid, path, title, content) VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![
            100_i64,
            "/Wiki/broken.md",
            "broken",
            "searchable broken content"
        ],
    )
    .expect("fts row should insert");

    let error = store
        .search_nodes(SearchNodesRequest {
            database_id: "default".to_string(),
            query_text: "searchable".to_string(),
            prefix: Some("/Wiki".to_string()),
            top_k: 10,
            preview_mode: None,
        })
        .expect_err("invalid kind should return error");
    assert!(error.contains("Invalid column type"));
}

#[test]
fn fs_nodes_fts_stores_title_using_current_basename_rule() {
    let (_dir, store) = new_store();
    ensure_parent_folders(&store, "/Wiki/nested/archive.tar.gz", 19);
    store
        .write_node(
            WriteNodeRequest {
                database_id: "default".to_string(),
                path: "/Wiki/nested/archive.tar.gz".to_string(),
                kind: NodeKind::File,
                content: "payload".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            20,
        )
        .expect("write should succeed");
    store
        .write_node(
            WriteNodeRequest {
                database_id: "default".to_string(),
                path: "/Wiki/nested/.env".to_string(),
                kind: NodeKind::File,
                content: "payload".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            21,
        )
        .expect("write should succeed");
    store
        .write_node(
            WriteNodeRequest {
                database_id: "default".to_string(),
                path: "/Wiki/nested/trailing.".to_string(),
                kind: NodeKind::File,
                content: "payload".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            22,
        )
        .expect("write should succeed");

    let conn = Connection::open(store.database_path()).expect("db should open");
    let rows = conn
        .prepare("SELECT path, title FROM fs_nodes_fts ORDER BY path ASC")
        .expect("query should prepare")
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .expect("query should run")
        .collect::<Result<Vec<_>, _>>()
        .expect("rows should collect");
    assert_eq!(
        rows,
        vec![
            ("/Wiki/nested/.env".to_string(), ".env".to_string()),
            (
                "/Wiki/nested/archive.tar.gz".to_string(),
                "archive.tar".to_string()
            ),
            (
                "/Wiki/nested/trailing.".to_string(),
                "trailing.".to_string()
            ),
        ]
    );
}

#[test]
fn write_update_delete_and_recreate_follow_etag_rules() {
    let (_dir, store) = new_store();
    let first = store
        .write_node(
            WriteNodeRequest {
                database_id: "default".to_string(),
                path: "/Wiki/foo.md".to_string(),
                kind: NodeKind::File,
                content: "alpha".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            10,
        )
        .expect("first write should succeed");
    assert!(first.created);
    assert_eq!(
        store
            .read_node("/Wiki/foo.md")
            .expect("read should succeed"),
        Some(vfs_types::Node {
            path: first.node.path.clone(),
            kind: first.node.kind.clone(),
            content: "alpha".to_string(),
            created_at: 10,
            updated_at: 10,
            etag: first.node.etag.clone(),
            metadata_json: "{}".to_string(),
        })
    );

    let stale_error = store
        .write_node(
            WriteNodeRequest {
                database_id: "default".to_string(),
                path: "/Wiki/foo.md".to_string(),
                kind: NodeKind::File,
                content: "beta".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: Some("stale".to_string()),
            },
            11,
        )
        .expect_err("stale write should fail");
    assert!(stale_error.contains("expected_etag"));

    let second = store
        .write_node(
            WriteNodeRequest {
                database_id: "default".to_string(),
                path: "/Wiki/foo.md".to_string(),
                kind: NodeKind::File,
                content: "beta".to_string(),
                metadata_json: "{\"v\":2}".to_string(),
                expected_etag: Some(first.node.etag.clone()),
            },
            12,
        )
        .expect("update should succeed");
    assert!(!second.created);
    assert_ne!(first.node.etag, second.node.etag);
    let second_node = store
        .read_node("/Wiki/foo.md")
        .expect("read should succeed")
        .expect("node should exist");
    assert_eq!(second_node.created_at, 10);

    let _deleted = store
        .delete_node(
            DeleteNodeRequest {
                database_id: "default".to_string(),
                path: "/Wiki/foo.md".to_string(),
                expected_etag: Some(second.node.etag.clone()),
                expected_folder_index_etag: None,
            },
            13,
        )
        .expect("delete should succeed");
    let stale_delete = store
        .delete_node(
            DeleteNodeRequest {
                database_id: "default".to_string(),
                path: "/Wiki/foo.md".to_string(),
                expected_etag: Some(second.node.etag),
                expected_folder_index_etag: None,
            },
            14,
        )
        .expect_err("stale delete should fail");
    assert!(stale_delete.contains("node does not exist"));
    assert!(
        store
            .read_node("/Wiki/foo.md")
            .expect("read after delete should succeed")
            .is_none()
    );

    let recreated = store
        .write_node(
            WriteNodeRequest {
                database_id: "default".to_string(),
                path: "/Wiki/foo.md".to_string(),
                kind: NodeKind::File,
                content: "gamma".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            15,
        )
        .expect("recreate should succeed");
    let recreated_node = store
        .read_node("/Wiki/foo.md")
        .expect("read should succeed")
        .expect("node should exist");
    assert_eq!(recreated_node.created_at, 15);
    assert_eq!(recreated.node.updated_at, 15);
}

#[test]
fn list_search_and_export_respect_deleted_and_prefix() {
    let (_dir, store) = new_store();
    let alpha = write_file(&store, "/Wiki/alpha.md", None, 10);
    let beta = write_file(&store, "/Wiki/nested/beta.md", None, 11);
    write_file(&store, "/Wiki/tree/leaf.md", None, 12);
    write_file(&store, "/Wiki/deleted/leaf.md", None, 13);
    let root_entries = store
        .list_nodes(ListNodesRequest {
            database_id: "default".to_string(),
            prefix: "/Wiki".to_string(),
            recursive: false,
        })
        .expect("root list should succeed");
    assert_eq!(root_entries.len(), 4);
    assert!(
        root_entries
            .iter()
            .any(|entry| entry.path == "/Wiki/alpha.md" && !entry.has_children)
    );
    assert!(root_entries.iter().any(|entry| {
        entry.path == "/Wiki/nested"
            && entry.kind == NodeEntryKind::Folder
            && !entry.etag.is_empty()
            && entry.has_children
    }));
    assert!(root_entries.iter().any(|entry| {
        entry.path == "/Wiki/deleted"
            && entry.kind == NodeEntryKind::Folder
            && !entry.etag.is_empty()
            && entry.has_children
    }));
    assert!(
        root_entries
            .iter()
            .any(|entry| entry.path == "/Wiki/tree" && entry.has_children)
    );

    let nested_entries = store
        .list_nodes(ListNodesRequest {
            database_id: "default".to_string(),
            prefix: "/Wiki/nested".to_string(),
            recursive: true,
        })
        .expect("nested list should succeed");
    assert_eq!(nested_entries.len(), 2);
    assert!(
        nested_entries
            .iter()
            .any(|entry| entry.path == "/Wiki/nested" && entry.kind == NodeEntryKind::Folder)
    );
    assert!(
        nested_entries
            .iter()
            .any(|entry| entry.path == "/Wiki/nested/beta.md" && entry.kind == NodeEntryKind::File)
    );

    store
        .delete_node(
            DeleteNodeRequest {
                database_id: "default".to_string(),
                path: "/Wiki/alpha.md".to_string(),
                expected_etag: Some(alpha),
                expected_folder_index_etag: None,
            },
            12,
        )
        .expect("delete should succeed");
    let _deleted_leaf = store
        .delete_node(
            DeleteNodeRequest {
                database_id: "default".to_string(),
                path: "/Wiki/deleted/leaf.md".to_string(),
                expected_etag: Some(
                    store
                        .read_node("/Wiki/deleted/leaf.md")
                        .expect("deleted leaf read should succeed")
                        .expect("deleted leaf should exist")
                        .etag,
                ),
                expected_folder_index_etag: None,
            },
            14,
        )
        .expect("deleted leaf delete should succeed");
    let visible_after_delete = store
        .list_nodes(ListNodesRequest {
            database_id: "default".to_string(),
            prefix: "/Wiki".to_string(),
            recursive: true,
        })
        .expect("visible list should succeed");
    assert_eq!(visible_after_delete.len(), 6);
    assert!(
        visible_after_delete
            .iter()
            .any(|entry| entry.path == "/Wiki/nested/beta.md")
    );
    assert!(
        visible_after_delete
            .iter()
            .any(|entry| entry.path == "/Wiki/tree")
    );
    assert!(
        visible_after_delete
            .iter()
            .any(|entry| entry.path == "/Wiki/tree/leaf.md")
    );

    let root_after_delete = store
        .list_nodes(ListNodesRequest {
            database_id: "default".to_string(),
            prefix: "/Wiki".to_string(),
            recursive: false,
        })
        .expect("root list after delete should succeed");
    assert!(root_after_delete.iter().any(|entry| {
        entry.path == "/Wiki/deleted" && entry.kind == NodeEntryKind::Folder && !entry.has_children
    }));

    let deleted_entries = store
        .list_nodes(ListNodesRequest {
            database_id: "default".to_string(),
            prefix: "/Wiki".to_string(),
            recursive: true,
        })
        .expect("deleted list should succeed");
    assert_eq!(deleted_entries.len(), 6);

    let deleted_root_entries = store
        .list_nodes(ListNodesRequest {
            database_id: "default".to_string(),
            prefix: "/Wiki".to_string(),
            recursive: false,
        })
        .expect("deleted root list should succeed");
    assert!(deleted_root_entries.iter().any(|entry| {
        entry.path == "/Wiki/deleted" && entry.kind == NodeEntryKind::Folder && !entry.has_children
    }));

    let search_hits = store
        .search_nodes(SearchNodesRequest {
            database_id: "default".to_string(),
            query_text: "nested".to_string(),
            prefix: Some("/Wiki/nested".to_string()),
            top_k: 5,
            preview_mode: Some(SearchPreviewMode::None),
        })
        .expect("search should succeed");
    let beta_search_hit = search_hits
        .iter()
        .find(|hit| hit.path == "/Wiki/nested/beta.md")
        .expect("nested file search hit should exist");
    assert_eq!(
        beta_search_hit.snippet.as_deref(),
        Some("/Wiki/nested/beta.md")
    );
    assert!(
        beta_search_hit
            .match_reasons
            .contains(&"path_substring".to_string())
    );

    let path_hits = store
        .search_node_paths(SearchNodePathsRequest {
            database_id: "default".to_string(),
            query_text: "NeStEd".to_string(),
            prefix: Some("/Wiki".to_string()),
            top_k: 5,
            preview_mode: None,
        })
        .expect("path search should succeed");
    let beta_path_hit = path_hits
        .iter()
        .find(|hit| hit.path == "/Wiki/nested/beta.md")
        .expect("nested file path hit should exist");
    assert_eq!(
        beta_path_hit.snippet.as_deref(),
        Some("/Wiki/nested/beta.md")
    );
    assert_eq!(
        beta_path_hit.match_reasons,
        vec!["path_substring".to_string()]
    );

    let missing_hits = store
        .search_nodes(SearchNodesRequest {
            database_id: "default".to_string(),
            query_text: "alpha".to_string(),
            prefix: Some("/Wiki".to_string()),
            top_k: 5,
            preview_mode: Some(SearchPreviewMode::None),
        })
        .expect("search should succeed");
    assert!(missing_hits.is_empty());

    let snapshot = store
        .export_snapshot(ExportSnapshotRequest {
            database_id: "default".to_string(),
            prefix: Some("/Wiki".to_string()),
            limit: 100,
            cursor: None,
            snapshot_revision: None,
            snapshot_session_id: None,
        })
        .expect("snapshot should succeed");
    assert_eq!(snapshot.nodes.len(), 6);
    assert!(
        snapshot
            .nodes
            .iter()
            .any(|node| node.path == "/Wiki/nested/beta.md")
    );
    assert_v5_snapshot_revision_without_state_hash(&snapshot.snapshot_revision);
    assert!(beta.starts_with("v4h:"));
}

#[test]
fn list_children_returns_direct_children_with_folders() {
    let (_dir, store) = new_store();
    let alpha_etag = write_file(&store, "/Wiki/alpha.md", None, 10);
    write_file(&store, "/Wiki/zeta.md", None, 11);
    write_file(&store, "/Wiki/nested/beta.md", None, 12);
    write_file(&store, "/Wiki/aaa/gamma.md", None, 13);
    write_file(&store, "/Wiki/tree/leaf.md", None, 14);

    let children = store
        .list_children(ListChildrenRequest {
            database_id: "default".to_string(),
            path: "/Wiki/".to_string(),
        })
        .expect("children should list");
    let paths = children
        .iter()
        .map(|child| child.path.as_str())
        .collect::<Vec<_>>();
    assert_eq!(
        paths,
        vec![
            "/Wiki/aaa",
            "/Wiki/nested",
            "/Wiki/tree",
            "/Wiki/alpha.md",
            "/Wiki/zeta.md"
        ]
    );

    let directory = children
        .iter()
        .find(|child| child.path == "/Wiki/aaa")
        .expect("folder should exist");
    assert_eq!(directory.kind, NodeEntryKind::Folder);
    assert_eq!(directory.name, "aaa");
    assert!(directory.updated_at.is_some());
    assert!(directory.etag.is_some());
    assert_eq!(directory.size_bytes, Some(0));
    assert!(!directory.is_virtual);

    let alpha = children
        .iter()
        .find(|child| child.path == "/Wiki/alpha.md")
        .expect("file child should exist");
    assert_eq!(alpha.kind, NodeEntryKind::File);
    assert_eq!(alpha.name, "alpha.md");
    assert_eq!(alpha.updated_at, Some(10));
    assert_eq!(alpha.etag.as_deref(), Some(alpha_etag.as_str()));
    assert_eq!(alpha.size_bytes, Some("content revision 10".len() as u64));
    assert!(!alpha.is_virtual);

    let tree = children
        .iter()
        .find(|child| child.path == "/Wiki/tree")
        .expect("folder child with descendants should exist");
    assert_eq!(tree.kind, NodeEntryKind::Folder);
    assert_eq!(tree.name, "tree");
    assert!(tree.updated_at.is_some());
    assert!(tree.etag.is_some());
    assert_eq!(tree.size_bytes, Some(0));
    assert!(!tree.is_virtual);
    assert!(tree.has_children);

    let nested = children
        .iter()
        .find(|child| child.path == "/Wiki/nested")
        .expect("folder child with descendants should exist");
    assert!(nested.has_children);

    assert!(
        !children
            .iter()
            .find(|child| child.path == "/Wiki/alpha.md")
            .expect("leaf file child should exist")
            .has_children
    );

    let tree_children = store
        .list_children(ListChildrenRequest {
            database_id: "default".to_string(),
            path: "/Wiki/tree".to_string(),
        })
        .expect("concrete node with descendants should list children");
    assert_eq!(
        tree_children
            .iter()
            .map(|child| child.path.as_str())
            .collect::<Vec<_>>(),
        vec!["/Wiki/tree/leaf.md"]
    );
    assert!(!tree_children[0].has_children);
}

#[test]
fn list_children_excludes_folder_index_from_has_children() {
    let (_dir, store) = new_store();
    store
        .mkdir_node(
            MkdirNodeRequest {
                database_id: "default".to_string(),
                path: "/Wiki/topic".to_string(),
            },
            10,
        )
        .expect("folder should create");
    write_file(&store, "/Wiki/topic/index.md", None, 11);

    let children = store
        .list_children(ListChildrenRequest {
            database_id: "default".to_string(),
            path: "/Wiki".to_string(),
        })
        .expect("children should list");
    let topic = children
        .iter()
        .find(|child| child.path == "/Wiki/topic")
        .expect("topic folder should exist");
    assert_eq!(topic.kind, NodeEntryKind::Folder);
    assert!(!topic.has_children);
}

#[test]
fn list_children_reports_missing_directory_paths() {
    let (_dir, store) = new_store();

    let missing_error = store
        .list_children(ListChildrenRequest {
            database_id: "default".to_string(),
            path: "/Wiki/no-such-dir".to_string(),
        })
        .expect_err("missing directory should be rejected");
    assert_eq!(missing_error, "path not found: /Wiki/no-such-dir");

    let root_children = store
        .list_children(ListChildrenRequest {
            database_id: "default".to_string(),
            path: "/".to_string(),
        })
        .expect("root directory should list root folders");
    assert_eq!(
        root_children
            .iter()
            .map(|child| child.path.as_str())
            .collect::<Vec<_>>(),
        vec!["/Memory", "/Sessions", "/Sources", "/Wiki"]
    );
    for path in ["/Memory", "/Sessions", "/Wiki", "/Sources"] {
        let children = store
            .list_children(ListChildrenRequest {
                database_id: "default".to_string(),
                path: path.to_string(),
            })
            .expect("root-like directory should allow empty listing");
        assert!(children.is_empty());
    }
}

#[test]
fn list_children_reports_utf8_content_size_in_bytes() {
    let (_dir, store) = new_store();
    store
        .write_node(
            WriteNodeRequest {
                database_id: "default".to_string(),
                path: "/Wiki/japanese.md".to_string(),
                kind: NodeKind::File,
                content: "こんにちは".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            10,
        )
        .expect("write should succeed");

    let children = store
        .list_children(ListChildrenRequest {
            database_id: "default".to_string(),
            path: "/Wiki".to_string(),
        })
        .expect("children should list");
    let child = children
        .iter()
        .find(|child| child.path == "/Wiki/japanese.md")
        .expect("file child should exist");
    assert_eq!(child.size_bytes, Some("こんにちは".len() as u64));
}

#[test]
fn list_children_rejects_non_directory_paths() {
    let (_dir, store) = new_store();
    write_file(&store, "/Wiki/alpha.md", None, 10);

    let file_error = store
        .list_children(ListChildrenRequest {
            database_id: "default".to_string(),
            path: "/Wiki/alpha.md".to_string(),
        })
        .expect_err("file path should be rejected");
    assert_eq!(file_error, "not a directory: /Wiki/alpha.md");

    let relative_error = store
        .list_children(ListChildrenRequest {
            database_id: "default".to_string(),
            path: "Wiki".to_string(),
        })
        .expect_err("relative path should be rejected");
    assert_eq!(relative_error, "path must start with '/': Wiki");
}

#[test]
fn list_children_collapses_many_descendants_to_direct_entries() {
    let (_dir, store) = new_store();
    write_file(&store, "/Wiki/alpha.md", None, 10);
    for index in 0..300 {
        write_file(
            &store,
            &format!("/Wiki/bulk-{}/leaf-{}.md", index % 3, index),
            None,
            20 + index,
        );
    }

    let children = store
        .list_children(ListChildrenRequest {
            database_id: "default".to_string(),
            path: "/Wiki".to_string(),
        })
        .expect("children should list");
    let paths = children
        .iter()
        .map(|child| child.path.as_str())
        .collect::<Vec<_>>();
    assert_eq!(
        paths,
        vec![
            "/Wiki/bulk-0",
            "/Wiki/bulk-1",
            "/Wiki/bulk-2",
            "/Wiki/alpha.md"
        ]
    );
    assert_eq!(
        children
            .iter()
            .filter(|child| child.kind == NodeEntryKind::Folder)
            .count(),
        3
    );
}

#[test]
fn root_prefix_searches_all_nodes() {
    let (_dir, store) = new_store();
    write_file(&store, "/Wiki/root-search.md", None, 10);
    write_file(&store, "/Other/root-search.md", None, 11);

    let search_hits = store
        .search_nodes(SearchNodesRequest {
            database_id: "default".to_string(),
            query_text: "root-search".to_string(),
            prefix: Some("/".to_string()),
            top_k: 10,
            preview_mode: Some(SearchPreviewMode::None),
        })
        .expect("root search should succeed");
    let search_paths = search_hits
        .iter()
        .map(|hit| hit.path.as_str())
        .collect::<Vec<_>>();
    assert!(search_paths.contains(&"/Wiki/root-search.md"));
    assert!(search_paths.contains(&"/Other/root-search.md"));

    let path_hits = store
        .search_node_paths(SearchNodePathsRequest {
            database_id: "default".to_string(),
            query_text: "root-search".to_string(),
            prefix: Some("/".to_string()),
            top_k: 10,
            preview_mode: None,
        })
        .expect("root path search should succeed");
    let path_search_paths = path_hits
        .iter()
        .map(|hit| hit.path.as_str())
        .collect::<Vec<_>>();
    assert!(path_search_paths.contains(&"/Wiki/root-search.md"));
    assert!(path_search_paths.contains(&"/Other/root-search.md"));
}

fn assert_v5_snapshot_revision_without_state_hash(snapshot_revision: &str) {
    let parts = snapshot_revision.split(':').collect::<Vec<_>>();
    assert_eq!(parts.len(), 3);
    assert_eq!(parts[0], "v5");
    assert!(parts[1].parse::<i64>().expect("revision should parse") >= 0);
    assert!(!parts[2].is_empty());
}

#[test]
fn search_nodes_clamps_snippets_from_large_single_token_content() {
    let (_dir, store) = new_store();
    let ascii_content = "x".repeat(1024 * 1024);
    let multibyte_content = "検索".repeat(600);

    for (index, (path, content)) in [
        ("/Wiki/large-ascii.md", ascii_content),
        ("/Wiki/large-multibyte.md", multibyte_content),
    ]
    .into_iter()
    .enumerate()
    {
        store
            .write_node(
                WriteNodeRequest {
                    database_id: "default".to_string(),
                    path: path.to_string(),
                    kind: NodeKind::File,
                    content: content.clone(),
                    metadata_json: "{}".to_string(),
                    expected_etag: None,
                },
                100 + index as i64,
            )
            .expect("large token write should succeed");

        let hits = store
            .search_nodes(SearchNodesRequest {
                database_id: "default".to_string(),
                query_text: content,
                prefix: Some("/Wiki".to_string()),
                top_k: 5,
                preview_mode: Some(SearchPreviewMode::None),
            })
            .expect("large token search should succeed");

        assert!(
            hits.iter().any(|hit| hit.path == path),
            "large token search should return the written node"
        );
        for hit in hits {
            assert!(
                hit.snippet.is_none(),
                "content hits should not materialize content snippet"
            );
        }
    }
}

#[test]
fn search_nodes_light_preview_reports_content_offset_and_excerpt() {
    let (_dir, store) = new_store();
    store
        .write_node(
            WriteNodeRequest {
                database_id: "default".to_string(),
                path: "/Wiki/preview.md".to_string(),
                kind: NodeKind::File,
                content: "prefix text AlphaBeta suffix text".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            200,
        )
        .expect("write should succeed");

    let hits = store
        .search_nodes(SearchNodesRequest {
            database_id: "default".to_string(),
            query_text: "alphabeta".to_string(),
            prefix: Some("/Wiki".to_string()),
            top_k: 5,
            preview_mode: Some(SearchPreviewMode::Light),
        })
        .expect("search should succeed");

    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].path, "/Wiki/preview.md");
    assert!(hits[0].snippet.is_none());
    let preview = hits[0]
        .preview
        .as_ref()
        .expect("light preview should exist");
    assert_eq!(preview.field, SearchPreviewField::Content);
    assert_eq!(preview.match_reason, "content_fts");
    assert_eq!(preview.char_offset, 12);
    assert!(
        preview
            .excerpt
            .as_deref()
            .expect("excerpt should exist")
            .to_ascii_lowercase()
            .contains("alphabeta")
    );
}

#[test]
fn search_nodes_defaults_to_light_preview_when_mode_is_omitted() {
    let (_dir, store) = new_store();
    store
        .write_node(
            WriteNodeRequest {
                database_id: "default".to_string(),
                path: "/Wiki/default-preview.md".to_string(),
                kind: NodeKind::File,
                content: "prefix text AlphaBeta suffix text".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            201,
        )
        .expect("write should succeed");

    let hits = store
        .search_nodes(SearchNodesRequest {
            database_id: "default".to_string(),
            query_text: "alphabeta".to_string(),
            prefix: Some("/Wiki".to_string()),
            top_k: 5,
            preview_mode: None,
        })
        .expect("search should succeed");

    assert_eq!(hits.len(), 1);
    assert!(hits[0].preview.is_some());
}

#[test]
fn search_node_paths_content_start_preview_returns_body_prefix() {
    let (_dir, store) = new_store();
    ensure_parent_folders(&store, "/Wiki/path-preview/topic-note.md", 201);
    let content = format!("{}\n\nignored tail", "x".repeat(240));
    store
        .write_node(
            WriteNodeRequest {
                database_id: "default".to_string(),
                path: "/Wiki/path-preview/topic-note.md".to_string(),
                kind: NodeKind::File,
                content,
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            202,
        )
        .expect("write should succeed");

    let hits = store
        .search_node_paths(SearchNodePathsRequest {
            database_id: "default".to_string(),
            query_text: "topic-note".to_string(),
            prefix: Some("/Wiki".to_string()),
            top_k: 5,
            preview_mode: Some(SearchPreviewMode::ContentStart),
        })
        .expect("path search should succeed");

    assert_eq!(hits.len(), 1);
    let preview = hits[0]
        .preview
        .as_ref()
        .expect("content start preview should exist");
    assert_eq!(preview.field, SearchPreviewField::Content);
    assert_eq!(preview.match_reason, "content_start");
    assert_eq!(preview.char_offset, 0);
    assert_eq!(preview.excerpt.as_deref(), Some("x".repeat(200).as_str()));
}

#[test]
fn search_nodes_content_start_preview_covers_content_and_path_hits() {
    let (_dir, store) = new_store();
    ensure_parent_folders(&store, "/Wiki/content-start/path-hit.md", 202);
    store
        .write_node(
            WriteNodeRequest {
                database_id: "default".to_string(),
                path: "/Wiki/content-start/path-hit.md".to_string(),
                kind: NodeKind::File,
                content: "path body\nwith\tspacing".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            203,
        )
        .expect("path hit write should succeed");
    store
        .write_node(
            WriteNodeRequest {
                database_id: "default".to_string(),
                path: "/Wiki/content-start/content-hit.md".to_string(),
                kind: NodeKind::File,
                content: "shared-token content\nwith\tspacing".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            204,
        )
        .expect("content hit write should succeed");

    let path_hits = store
        .search_nodes(SearchNodesRequest {
            database_id: "default".to_string(),
            query_text: "path-hit".to_string(),
            prefix: Some("/Wiki/content-start".to_string()),
            top_k: 5,
            preview_mode: Some(SearchPreviewMode::ContentStart),
        })
        .expect("path hit search should succeed");
    let content_hits = store
        .search_nodes(SearchNodesRequest {
            database_id: "default".to_string(),
            query_text: "shared-token".to_string(),
            prefix: Some("/Wiki/content-start".to_string()),
            top_k: 5,
            preview_mode: Some(SearchPreviewMode::ContentStart),
        })
        .expect("content hit search should succeed");

    assert_eq!(
        path_hits[0]
            .preview
            .as_ref()
            .and_then(|preview| preview.excerpt.as_deref()),
        Some("path body with spacing")
    );
    assert_eq!(
        content_hits[0]
            .preview
            .as_ref()
            .and_then(|preview| preview.excerpt.as_deref()),
        Some("shared-token content with spacing")
    );
}

#[test]
fn search_content_start_preview_keeps_empty_body_excerpt_empty() {
    let (_dir, store) = new_store();
    store
        .write_node(
            WriteNodeRequest {
                database_id: "default".to_string(),
                path: "/Wiki/empty-body.md".to_string(),
                kind: NodeKind::File,
                content: " \n\t ".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            205,
        )
        .expect("write should succeed");

    let hits = store
        .search_node_paths(SearchNodePathsRequest {
            database_id: "default".to_string(),
            query_text: "empty-body".to_string(),
            prefix: Some("/Wiki".to_string()),
            top_k: 5,
            preview_mode: Some(SearchPreviewMode::ContentStart),
        })
        .expect("path search should succeed");

    assert_eq!(hits.len(), 1);
    assert_eq!(
        hits[0]
            .preview
            .as_ref()
            .and_then(|preview| preview.excerpt.as_ref()),
        None
    );
}

#[test]
fn search_nodes_handles_ten_large_hits_without_loading_full_content() {
    let (_dir, store) = new_store();
    ensure_parent_folders(&store, "/Wiki/large/node-000.md", 499);
    let payload = format!("shared-bench-search {}", "x".repeat(1024 * 1024 - 20));
    for index in 0..100 {
        store
            .write_node(
                WriteNodeRequest {
                    database_id: "default".to_string(),
                    path: format!("/Wiki/large/node-{index:03}.md"),
                    kind: NodeKind::File,
                    content: payload.clone(),
                    metadata_json: "{}".to_string(),
                    expected_etag: None,
                },
                500 + index as i64,
            )
            .expect("large write should succeed");
    }

    let hits = store
        .search_nodes(SearchNodesRequest {
            database_id: "default".to_string(),
            query_text: "shared-bench-search".to_string(),
            prefix: Some("/Wiki/large".to_string()),
            top_k: 10,
            preview_mode: Some(SearchPreviewMode::None),
        })
        .expect("search should succeed");

    assert_eq!(hits.len(), 10);
    for window in hits.windows(2) {
        assert!(window[0].score <= window[1].score);
    }
    for hit in hits {
        assert!(hit.path.starts_with("/Wiki/large/"));
        assert!(
            hit.snippet.is_none(),
            "large content hits should skip content snippet materialization"
        );
    }
}

#[test]
fn search_nodes_mixed_large_and_small_hits_can_omit_content_snippets() {
    let (_dir, store) = new_store();
    ensure_parent_folders(&store, "/Wiki/mixed/large.md", 1_399);
    let large_payload = format!("shared-bench-search {}", "x".repeat(1024 * 1024 - 20));
    let small_payload = "shared-bench-search compact preview".to_string();

    store
        .write_node(
            WriteNodeRequest {
                database_id: "default".to_string(),
                path: "/Wiki/mixed/large.md".to_string(),
                kind: NodeKind::File,
                content: large_payload,
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            1_400,
        )
        .expect("large write should succeed");
    store
        .write_node(
            WriteNodeRequest {
                database_id: "default".to_string(),
                path: "/Wiki/mixed/small.md".to_string(),
                kind: NodeKind::File,
                content: small_payload,
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            1_401,
        )
        .expect("small write should succeed");

    let hits = store
        .search_nodes(SearchNodesRequest {
            database_id: "default".to_string(),
            query_text: "shared-bench-search".to_string(),
            prefix: Some("/Wiki/mixed".to_string()),
            top_k: 10,
            preview_mode: Some(SearchPreviewMode::None),
        })
        .expect("search should succeed");

    let large_hit = hits
        .iter()
        .find(|hit| hit.path == "/Wiki/mixed/large.md")
        .expect("large hit should exist");
    let small_hit = hits
        .iter()
        .find(|hit| hit.path == "/Wiki/mixed/small.md")
        .expect("small hit should exist");

    assert!(large_hit.snippet.is_none());
    assert!(small_hit.snippet.is_none());
}

#[test]
fn search_nodes_prefers_basename_matches_over_content_only_hits() {
    let (_dir, store) = new_store();
    ensure_parent_folders(&store, "/Wiki/ranking/alpha-beta.md", 1_499);
    store
        .write_node(
            WriteNodeRequest {
                database_id: "default".to_string(),
                path: "/Wiki/ranking/alpha-beta.md".to_string(),
                kind: NodeKind::File,
                content: "ranking body".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            1_500,
        )
        .expect("write should succeed");
    store
        .write_node(
            WriteNodeRequest {
                database_id: "default".to_string(),
                path: "/Wiki/ranking/other.md".to_string(),
                kind: NodeKind::File,
                content: "alpha beta body only".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            1_501,
        )
        .expect("write should succeed");

    let hits = store
        .search_nodes(SearchNodesRequest {
            database_id: "default".to_string(),
            query_text: "alpha-beta".to_string(),
            prefix: Some("/Wiki/ranking".to_string()),
            top_k: 5,
            preview_mode: Some(SearchPreviewMode::None),
        })
        .expect("search should succeed");

    assert_eq!(hits[0].path, "/Wiki/ranking/alpha-beta.md");
    assert!(
        hits[0]
            .match_reasons
            .contains(&"basename_exact".to_string()),
        "basename exact should dominate ranking"
    );
}

#[test]
fn search_nodes_recovers_partial_multi_term_matches() {
    let (_dir, store) = new_store();
    ensure_parent_folders(&store, "/Wiki/recall/node-0.md", 1_599);
    for (index, content) in ["alpha beta gamma", "alpha beta", "alpha only", "gamma only"]
        .into_iter()
        .enumerate()
    {
        store
            .write_node(
                WriteNodeRequest {
                    database_id: "default".to_string(),
                    path: format!("/Wiki/recall/node-{index}.md"),
                    kind: NodeKind::File,
                    content: content.to_string(),
                    metadata_json: "{}".to_string(),
                    expected_etag: None,
                },
                1_600 + index as i64,
            )
            .expect("write should succeed");
    }

    let hits = store
        .search_nodes(SearchNodesRequest {
            database_id: "default".to_string(),
            query_text: "alpha beta missing".to_string(),
            prefix: Some("/Wiki/recall".to_string()),
            top_k: 10,
            preview_mode: Some(SearchPreviewMode::None),
        })
        .expect("search should succeed");

    assert!(
        hits.iter().any(|hit| hit.path == "/Wiki/recall/node-0.md"),
        "exact-ish match should remain"
    );
    assert!(
        hits.iter().any(|hit| hit.path == "/Wiki/recall/node-1.md"),
        "recall stage should keep partial multi-term match"
    );
}

#[test]
fn search_nodes_supports_japanese_queries_without_spaces() {
    let (_dir, store) = new_store();
    ensure_parent_folders(&store, "/Wiki/日本語/検索改善メモ.md", 1_699);
    store
        .write_node(
            WriteNodeRequest {
                database_id: "default".to_string(),
                path: "/Wiki/日本語/検索改善メモ.md".to_string(),
                kind: NodeKind::File,
                content: "検索精度改善の作業メモ".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            1_700,
        )
        .expect("write should succeed");

    let hits = store
        .search_nodes(SearchNodesRequest {
            database_id: "default".to_string(),
            query_text: "検索改善".to_string(),
            prefix: Some("/Wiki".to_string()),
            top_k: 10,
            preview_mode: Some(SearchPreviewMode::None),
        })
        .expect("search should succeed");

    assert_eq!(hits[0].path, "/Wiki/日本語/検索改善メモ.md");
    assert!(
        hits[0]
            .match_reasons
            .iter()
            .any(|reason| reason == "path_substring" || reason == "content_substring"),
        "japanese query should surface path or content recall reason"
    );
}

#[test]
fn search_nodes_path_only_hits_keep_path_snippets() {
    let (_dir, store) = new_store();
    ensure_parent_folders(&store, "/Wiki/path-only/unique-title.md", 1_799);
    store
        .write_node(
            WriteNodeRequest {
                database_id: "default".to_string(),
                path: "/Wiki/path-only/unique-title.md".to_string(),
                kind: NodeKind::File,
                content: "irrelevant body".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            1_800,
        )
        .expect("write should succeed");

    let hits = store
        .search_nodes(SearchNodesRequest {
            database_id: "default".to_string(),
            query_text: "unique-title".to_string(),
            prefix: Some("/Wiki/path-only".to_string()),
            top_k: 5,
            preview_mode: Some(SearchPreviewMode::Light),
        })
        .expect("search should succeed");

    assert_eq!(
        hits[0].snippet.as_deref(),
        Some("/Wiki/path-only/unique-title.md")
    );
    let preview = hits[0].preview.as_ref().expect("path preview should exist");
    assert_eq!(preview.field, SearchPreviewField::Path);
    assert_eq!(preview.match_reason, "basename_exact");
    assert_eq!(preview.char_offset, 16);
    assert!(preview.excerpt.is_none());
}

#[test]
fn search_nodes_keeps_basename_exact_hits_above_fts_only_hits() {
    let (_dir, store) = new_store();
    ensure_parent_folders(&store, "/Wiki/fts-heavy/doc-00.md", 1_849);
    for index in 0..12 {
        store
            .write_node(
                WriteNodeRequest {
                    database_id: "default".to_string(),
                    path: format!("/Wiki/fts-heavy/doc-{index:02}.md"),
                    kind: NodeKind::File,
                    content: "focus-token appears in the body".to_string(),
                    metadata_json: "{}".to_string(),
                    expected_etag: None,
                },
                1_850 + index as i64,
            )
            .expect("write should succeed");
    }
    store
        .write_node(
            WriteNodeRequest {
                database_id: "default".to_string(),
                path: "/Wiki/fts-heavy/focus-token.md".to_string(),
                kind: NodeKind::File,
                content: "body without the keyword".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            1_900,
        )
        .expect("write should succeed");

    let hits = store
        .search_nodes(SearchNodesRequest {
            database_id: "default".to_string(),
            query_text: "focus-token".to_string(),
            prefix: Some("/Wiki/fts-heavy".to_string()),
            top_k: 5,
            preview_mode: Some(SearchPreviewMode::None),
        })
        .expect("search should succeed");

    assert_eq!(hits[0].path, "/Wiki/fts-heavy/focus-token.md");
    assert!(
        hits[0]
            .match_reasons
            .contains(&"basename_exact".to_string()),
        "basename exact hit should survive FTS candidate truncation"
    );
}

#[test]
fn move_node_refreshes_search_indexes_for_path_and_basename_queries() {
    let (_dir, store) = new_store();
    ensure_parent_folders(&store, "/Wiki/move/source-name.md", 1_899);
    let created = store
        .write_node(
            WriteNodeRequest {
                database_id: "default".to_string(),
                path: "/Wiki/move/source-name.md".to_string(),
                kind: NodeKind::File,
                content: "stable body".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            1_900,
        )
        .expect("write should succeed");
    store
        .move_node(
            MoveNodeRequest {
                database_id: "default".to_string(),
                from_path: "/Wiki/move/source-name.md".to_string(),
                to_path: "/Wiki/move/renamed-note.md".to_string(),
                expected_etag: Some(created.node.etag),
                overwrite: false,
            },
            1_901,
        )
        .expect("move should succeed");

    let new_hits = store
        .search_nodes(SearchNodesRequest {
            database_id: "default".to_string(),
            query_text: "renamed-note".to_string(),
            prefix: Some("/Wiki/move".to_string()),
            top_k: 5,
            preview_mode: Some(SearchPreviewMode::None),
        })
        .expect("search should succeed");
    assert_eq!(new_hits.len(), 1);
    assert_eq!(new_hits[0].path, "/Wiki/move/renamed-note.md");
    assert!(
        new_hits[0]
            .match_reasons
            .contains(&"basename_exact".to_string())
    );

    let stale_hits = store
        .search_nodes(SearchNodesRequest {
            database_id: "default".to_string(),
            query_text: "source-name".to_string(),
            prefix: Some("/Wiki/move".to_string()),
            top_k: 5,
            preview_mode: Some(SearchPreviewMode::None),
        })
        .expect("search should succeed");
    assert!(stale_hits.is_empty());

    let path_hits = store
        .search_node_paths(SearchNodePathsRequest {
            database_id: "default".to_string(),
            query_text: "renamed-note".to_string(),
            prefix: Some("/Wiki/move".to_string()),
            top_k: 5,
            preview_mode: None,
        })
        .expect("path search should succeed");
    assert_eq!(path_hits.len(), 1);
    assert_eq!(path_hits[0].path, "/Wiki/move/renamed-note.md");
    assert!(
        path_hits[0]
            .match_reasons
            .contains(&"basename_exact".to_string())
    );
}

#[test]
fn move_node_allows_noncanonical_target_for_source_nodes() {
    let (_dir, store) = new_store();
    ensure_parent_folders(&store, "/Sources/raw/source/source.md", 1_909);
    ensure_parent_folders(&store, "/Sources/raw/renamed/wrong.md", 1_909);
    let created = store
        .write_node(
            WriteNodeRequest {
                database_id: "default".to_string(),
                path: "/Sources/raw/source/source.md".to_string(),
                kind: NodeKind::Source,
                content: "source body".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            1_910,
        )
        .expect("write should succeed");

    let moved = store
        .move_node(
            MoveNodeRequest {
                database_id: "default".to_string(),
                from_path: "/Sources/raw/source/source.md".to_string(),
                to_path: "/Sources/raw/renamed/wrong.md".to_string(),
                expected_etag: Some(created.node.etag),
                overwrite: false,
            },
            1_911,
        )
        .expect("move should succeed");

    assert_eq!(moved.node.path, "/Sources/raw/renamed/wrong.md");
}

#[test]
fn move_node_accepts_canonical_target_for_source_nodes() {
    let (_dir, store) = new_store();
    ensure_parent_folders(&store, "/Sources/raw/source/source.md", 1_919);
    ensure_parent_folders(&store, "/Sources/sessions/renamed/renamed.md", 1_919);
    let created = store
        .write_node(
            WriteNodeRequest {
                database_id: "default".to_string(),
                path: "/Sources/raw/source/source.md".to_string(),
                kind: NodeKind::Source,
                content: "source body".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            1_920,
        )
        .expect("write should succeed");

    let moved = store
        .move_node(
            MoveNodeRequest {
                database_id: "default".to_string(),
                from_path: "/Sources/raw/source/source.md".to_string(),
                to_path: "/Sources/sessions/renamed/renamed.md".to_string(),
                expected_etag: Some(created.node.etag),
                overwrite: false,
            },
            1_921,
        )
        .expect("move should succeed");

    assert_eq!(moved.node.path, "/Sources/sessions/renamed/renamed.md");
    let current = store
        .read_node("/Sources/sessions/renamed/renamed.md")
        .expect("read should succeed")
        .expect("moved source should exist");
    assert_eq!(current.kind, NodeKind::Source);
}

#[test]
fn source_nodes_allow_domain_specific_prefix_lookalike_paths() {
    let (_dir, store) = new_store();
    for path in ["/Sources/rawfoo/foo.md", "/Sources/sessions-foo/x.md"] {
        ensure_parent_folders(&store, path, 1_929);
        let result = store
            .write_node(
                WriteNodeRequest {
                    database_id: "default".to_string(),
                    path: path.to_string(),
                    kind: NodeKind::Source,
                    content: "source body".to_string(),
                    metadata_json: "{}".to_string(),
                    expected_etag: None,
                },
                1_930,
            )
            .expect("generic store should not enforce wiki source policy");

        assert_eq!(result.node.path, path);
    }
}

#[test]
fn source_nodes_accept_canonical_paths_under_both_roots() {
    let (_dir, store) = new_store();
    for (index, path) in [
        "/Sources/raw/source/source.md",
        "/Sources/sessions/session/session.md",
    ]
    .into_iter()
    .enumerate()
    {
        ensure_parent_folders(&store, path, 1_939 + index as i64);
        let result = store.write_node(
            WriteNodeRequest {
                database_id: "default".to_string(),
                path: path.to_string(),
                kind: NodeKind::Source,
                content: "source body".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            1_940 + index as i64,
        );

        assert!(
            result.is_ok(),
            "canonical source path should succeed: {path}"
        );
    }
}

#[test]
fn query_limits_are_capped_at_one_hundred() {
    let (_dir, store) = new_store();
    ensure_parent_folders(&store, "/Wiki/capped/node-000.md", 999);
    for index in 0..150 {
        store
            .write_node(
                WriteNodeRequest {
                    database_id: "default".to_string(),
                    path: format!("/Wiki/capped/node-{index:03}.md"),
                    kind: NodeKind::File,
                    content: format!("shared-cap-token path-cap-{index}"),
                    metadata_json: "{}".to_string(),
                    expected_etag: None,
                },
                1_000 + index,
            )
            .expect("write should succeed");
    }

    let search = store
        .search_nodes(SearchNodesRequest {
            database_id: "default".to_string(),
            query_text: "shared-cap-token".to_string(),
            prefix: Some("/Wiki/capped".to_string()),
            top_k: 1_000,
            preview_mode: Some(SearchPreviewMode::None),
        })
        .expect("search should succeed");
    assert_eq!(search.len(), 100);

    let path_search = store
        .search_node_paths(SearchNodePathsRequest {
            database_id: "default".to_string(),
            query_text: "node".to_string(),
            prefix: Some("/Wiki/capped".to_string()),
            top_k: 1_000,
            preview_mode: None,
        })
        .expect("path search should succeed");
    assert_eq!(path_search.len(), 100);
}

#[test]
fn database_sql_json_interrupts_heavy_scan_and_clears_progress_handler() {
    let (_dir, store) = new_store();
    seed_sql_budget_rows(store.database_path(), 10_000);

    let normal = store
        .query_sql_json(
            "SELECT json_object('path', path) FROM fs_nodes WHERE path >= '/Wiki/budget/node-00000.md' ORDER BY path ASC LIMIT 10",
            10,
        )
        .expect("indexed database SQL should succeed");

    assert_eq!(normal.row_count, 10);
    assert_eq!(normal.rows[0], r#"{"path":"/Wiki/budget/node-00000.md"}"#);

    let error = store
        .query_sql_json(&heavy_missing_sql(), 1)
        .expect_err("heavy database SQL should exceed budget");

    assert!(
        error.contains("database SQL execution budget exceeded"),
        "unexpected error: {error}"
    );

    let after_interrupt = store
        .query_sql_json(
            "SELECT json_object('path', path) FROM fs_nodes WHERE path = '/Wiki/budget/node-00001.md' LIMIT 1",
            1,
        )
        .expect("progress handler should be cleared after interrupt");

    assert_eq!(
        after_interrupt.rows,
        vec![r#"{"path":"/Wiki/budget/node-00001.md"}"#]
    );
}

#[test]
fn search_node_paths_filters_deleted_terms_and_orders_deterministically() {
    let (_dir, store) = new_store();
    let first = write_file(&store, "/Wiki/aaa/nested-note.md", None, 10);
    write_file(&store, "/Wiki/nested-note.md", None, 11);
    write_file(&store, "/Wiki/zzz/nested-note.md", None, 12);

    store
        .delete_node(
            DeleteNodeRequest {
                database_id: "default".to_string(),
                path: "/Wiki/zzz/nested-note.md".to_string(),
                expected_etag: Some(first),
                expected_folder_index_etag: None,
            },
            13,
        )
        .expect_err("mismatched etag should fail");

    let latest = store
        .read_node("/Wiki/zzz/nested-note.md")
        .expect("read should succeed")
        .expect("node should exist");
    store
        .delete_node(
            DeleteNodeRequest {
                database_id: "default".to_string(),
                path: "/Wiki/zzz/nested-note.md".to_string(),
                expected_etag: Some(latest.etag),
                expected_folder_index_etag: None,
            },
            14,
        )
        .expect("delete should succeed");

    let hits = store
        .search_node_paths(SearchNodePathsRequest {
            database_id: "default".to_string(),
            query_text: "NESTED note".to_string(),
            prefix: Some("/Wiki".to_string()),
            top_k: 10,
            preview_mode: None,
        })
        .expect("path search should succeed");
    let paths = hits.into_iter().map(|hit| hit.path).collect::<Vec<_>>();
    assert_eq!(
        paths,
        vec![
            "/Wiki/nested-note.md".to_string(),
            "/Wiki/aaa/nested-note.md".to_string()
        ]
    );
}
