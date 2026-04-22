use rusqlite::Connection;
use tempfile::tempdir;
use vfs_store::FsStore;
use vfs_types::{
    DeleteNodeRequest, ExportSnapshotRequest, ListNodesRequest, MoveNodeRequest, NodeEntryKind,
    NodeKind, RecentNodesRequest, SearchNodePathsRequest, SearchNodesRequest, SearchPreviewField,
    SearchPreviewMode, WriteNodeRequest,
};

fn new_store() -> (tempfile::TempDir, FsStore) {
    let dir = tempdir().expect("temp dir should exist");
    let store = FsStore::new(dir.path().join("wiki.sqlite3"));
    store
        .run_fs_migrations()
        .expect("fs migrations should succeed");
    (dir, store)
}

fn write_file(store: &FsStore, path: &str, expected_etag: Option<&str>, now: i64) -> String {
    store
        .write_node(
            WriteNodeRequest {
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
    assert_eq!(versions, vec!["wiki_store:000_fs_schema".to_string()]);

    for table in ["fs_snapshot_sessions", "fs_snapshot_session_paths"] {
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
        "fs_snapshot_sessions_expires_at_idx",
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
fn list_and_recent_queries_use_covering_indexes() {
    let (_dir, store) = new_store();
    write_file(&store, "/Wiki/indexed.md", None, 10);
    let conn = Connection::open(store.database_path()).expect("db should open");

    let list_plan = explain_query_plan(
        &conn,
        "SELECT path, kind, updated_at, etag
         FROM fs_nodes
         WHERE path = ?1 OR path LIKE ?2
         ORDER BY path ASC",
        ["/Wiki", "/Wiki/%"],
    );
    assert!(
        list_plan.contains("COVERING INDEX fs_nodes_path_covering_idx"),
        "list should avoid table lookups: {list_plan}"
    );

    let recent_plan = explain_query_plan(
        &conn,
        "SELECT path, kind, updated_at, etag
         FROM fs_nodes
         WHERE path = ?1 OR path LIKE ?2
         ORDER BY updated_at DESC, path ASC
         LIMIT 10",
        ["/Wiki", "/Wiki/%"],
    );
    assert!(
        recent_plan.contains("COVERING INDEX fs_nodes_recent_covering_idx"),
        "recent should avoid table lookups: {recent_plan}"
    );
}

fn explain_query_plan(conn: &Connection, sql: &str, params: [&str; 2]) -> String {
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
                path: "/Wiki/file.md".to_string(),
                kind: NodeKind::File,
                content: "alpha".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            10,
        )
        .expect("file write should succeed");
    let source = store
        .write_node(
            WriteNodeRequest {
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
                path: "/Wiki/file.md".to_string(),
                expected_etag: Some(file.node.etag),
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

    assert_eq!(revision_count, 261);
    assert_eq!(oldest_revision, 1);
    assert_eq!(newest_revision, 261);
}

#[test]
fn fs_path_state_tracks_latest_change_revision() {
    let (_dir, store) = new_store();
    let first = write_file(&store, "/Wiki/file.md", None, 10);
    let second = write_file(&store, "/Wiki/file.md", Some(&first), 11);
    store
        .delete_node(
            DeleteNodeRequest {
                path: "/Wiki/file.md".to_string(),
                expected_etag: Some(second),
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
    assert_eq!(revision, 3);
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
    assert_eq!(versions, vec!["wiki_store:000_fs_schema".to_string()]);

    let tracked_paths = conn
        .query_row("SELECT COUNT(*) FROM fs_path_state", [], |row| {
            row.get::<_, i64>(0)
        })
        .expect("path state count should succeed");
    assert_eq!(tracked_paths, 2);
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
fn search_nodes_returns_error_for_invalid_stored_kind() {
    let (_dir, store) = new_store();
    let conn = Connection::open(store.database_path()).expect("db should open");
    conn.execute(
        "INSERT INTO fs_nodes (id, path, kind, content, created_at, updated_at, etag, metadata_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        rusqlite::params![
            1_i64,
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
            1_i64,
            "/Wiki/broken.md",
            "broken",
            "searchable broken content"
        ],
    )
    .expect("fts row should insert");

    let error = store
        .search_nodes(SearchNodesRequest {
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
    store
        .write_node(
            WriteNodeRequest {
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
                path: "/Wiki/foo.md".to_string(),
                expected_etag: Some(second.node.etag.clone()),
            },
            13,
        )
        .expect("delete should succeed");
    let stale_delete = store
        .delete_node(
            DeleteNodeRequest {
                path: "/Wiki/foo.md".to_string(),
                expected_etag: Some(second.node.etag),
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
    write_file(&store, "/Wiki/tree", None, 9);
    write_file(&store, "/Wiki/tree/leaf.md", None, 12);
    write_file(&store, "/Wiki/deleted/leaf.md", None, 13);
    let root_entries = store
        .list_nodes(ListNodesRequest {
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
            && entry.kind == NodeEntryKind::Directory
            && entry.etag.is_empty()
            && entry.has_children
            && entry.updated_at == 11
    }));
    assert!(root_entries.iter().any(|entry| {
        entry.path == "/Wiki/deleted"
            && entry.kind == NodeEntryKind::Directory
            && entry.etag.is_empty()
            && entry.has_children
            && entry.updated_at == 13
    }));
    assert!(
        root_entries
            .iter()
            .any(|entry| entry.path == "/Wiki/tree" && entry.has_children)
    );

    let nested_entries = store
        .list_nodes(ListNodesRequest {
            prefix: "/Wiki/nested".to_string(),
            recursive: true,
        })
        .expect("nested list should succeed");
    assert_eq!(nested_entries.len(), 1);
    assert_eq!(nested_entries[0].path, "/Wiki/nested/beta.md");
    assert_eq!(nested_entries[0].kind, NodeEntryKind::File);

    store
        .delete_node(
            DeleteNodeRequest {
                path: "/Wiki/alpha.md".to_string(),
                expected_etag: Some(alpha),
            },
            12,
        )
        .expect("delete should succeed");
    let _deleted_leaf = store
        .delete_node(
            DeleteNodeRequest {
                path: "/Wiki/deleted/leaf.md".to_string(),
                expected_etag: Some(
                    store
                        .read_node("/Wiki/deleted/leaf.md")
                        .expect("deleted leaf read should succeed")
                        .expect("deleted leaf should exist")
                        .etag,
                ),
            },
            14,
        )
        .expect("deleted leaf delete should succeed");
    let visible_after_delete = store
        .list_nodes(ListNodesRequest {
            prefix: "/Wiki".to_string(),
            recursive: true,
        })
        .expect("visible list should succeed");
    assert_eq!(visible_after_delete.len(), 3);
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
            prefix: "/Wiki".to_string(),
            recursive: false,
        })
        .expect("root list after delete should succeed");
    assert!(
        !root_after_delete
            .iter()
            .any(|entry| entry.path == "/Wiki/deleted")
    );

    let deleted_entries = store
        .list_nodes(ListNodesRequest {
            prefix: "/Wiki".to_string(),
            recursive: true,
        })
        .expect("deleted list should succeed");
    assert_eq!(deleted_entries.len(), 3);

    let deleted_root_entries = store
        .list_nodes(ListNodesRequest {
            prefix: "/Wiki".to_string(),
            recursive: false,
        })
        .expect("deleted root list should succeed");
    assert!(
        !deleted_root_entries
            .iter()
            .any(|entry| entry.path == "/Wiki/deleted")
    );

    let search_hits = store
        .search_nodes(SearchNodesRequest {
            query_text: "nested".to_string(),
            prefix: Some("/Wiki/nested".to_string()),
            top_k: 5,
            preview_mode: Some(SearchPreviewMode::None),
        })
        .expect("search should succeed");
    assert_eq!(search_hits.len(), 1);
    assert_eq!(search_hits[0].path, "/Wiki/nested/beta.md");
    assert_eq!(
        search_hits[0].snippet.as_deref(),
        Some("/Wiki/nested/beta.md")
    );
    assert!(
        search_hits[0]
            .match_reasons
            .contains(&"path_substring".to_string())
    );

    let path_hits = store
        .search_node_paths(SearchNodePathsRequest {
            query_text: "NeStEd".to_string(),
            prefix: Some("/Wiki".to_string()),
            top_k: 5,
        })
        .expect("path search should succeed");
    assert_eq!(path_hits.len(), 1);
    assert_eq!(path_hits[0].path, "/Wiki/nested/beta.md");
    assert_eq!(
        path_hits[0].snippet.as_deref(),
        Some("/Wiki/nested/beta.md")
    );
    assert_eq!(
        path_hits[0].match_reasons,
        vec!["path_substring".to_string()]
    );

    let missing_hits = store
        .search_nodes(SearchNodesRequest {
            query_text: "alpha".to_string(),
            prefix: Some("/Wiki".to_string()),
            top_k: 5,
            preview_mode: Some(SearchPreviewMode::None),
        })
        .expect("search should succeed");
    assert!(missing_hits.is_empty());

    let snapshot = store
        .export_snapshot(ExportSnapshotRequest {
            prefix: Some("/Wiki".to_string()),
            limit: 100,
            cursor: None,
            snapshot_revision: None,
            snapshot_session_id: None,
        })
        .expect("snapshot should succeed");
    assert_eq!(snapshot.nodes.len(), 3);
    assert!(
        snapshot
            .nodes
            .iter()
            .any(|node| node.path == "/Wiki/nested/beta.md")
    );
    assert_v5_snapshot_revision_without_state_hash(&snapshot.snapshot_revision);
    assert!(beta.starts_with("v4h:"));
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
fn search_nodes_handles_ten_large_hits_without_loading_full_content() {
    let (_dir, store) = new_store();
    let payload = format!("shared-bench-search {}", "x".repeat(1024 * 1024 - 20));
    for index in 0..100 {
        store
            .write_node(
                WriteNodeRequest {
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
    let large_payload = format!("shared-bench-search {}", "x".repeat(1024 * 1024 - 20));
    let small_payload = "shared-bench-search compact preview".to_string();

    store
        .write_node(
            WriteNodeRequest {
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
    store
        .write_node(
            WriteNodeRequest {
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
    for (index, content) in ["alpha beta gamma", "alpha beta", "alpha only", "gamma only"]
        .into_iter()
        .enumerate()
    {
        store
            .write_node(
                WriteNodeRequest {
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
    store
        .write_node(
            WriteNodeRequest {
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
    store
        .write_node(
            WriteNodeRequest {
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
    for index in 0..12 {
        store
            .write_node(
                WriteNodeRequest {
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
    let created = store
        .write_node(
            WriteNodeRequest {
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
            query_text: "source-name".to_string(),
            prefix: Some("/Wiki/move".to_string()),
            top_k: 5,
            preview_mode: Some(SearchPreviewMode::None),
        })
        .expect("search should succeed");
    assert!(stale_hits.is_empty());

    let path_hits = store
        .search_node_paths(SearchNodePathsRequest {
            query_text: "renamed-note".to_string(),
            prefix: Some("/Wiki/move".to_string()),
            top_k: 5,
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
    let created = store
        .write_node(
            WriteNodeRequest {
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
    let created = store
        .write_node(
            WriteNodeRequest {
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
fn source_nodes_reject_prefix_lookalike_paths() {
    let (_dir, store) = new_store();
    for path in ["/Sources/rawfoo/foo.md", "/Sources/sessions-foo/x.md"] {
        let error = store
            .write_node(
                WriteNodeRequest {
                    path: path.to_string(),
                    kind: NodeKind::Source,
                    content: "source body".to_string(),
                    metadata_json: "{}".to_string(),
                    expected_etag: None,
                },
                1_930,
            )
            .expect_err("write should fail");

        assert!(error.contains("source path must stay under"));
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
        let result = store.write_node(
            WriteNodeRequest {
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
    for index in 0..150 {
        store
            .write_node(
                WriteNodeRequest {
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

    let recent = store
        .recent_nodes(RecentNodesRequest {
            limit: 1_000,
            path: Some("/Wiki/capped".to_string()),
        })
        .expect("recent should succeed");
    assert_eq!(recent.len(), 100);

    let search = store
        .search_nodes(SearchNodesRequest {
            query_text: "shared-cap-token".to_string(),
            prefix: Some("/Wiki/capped".to_string()),
            top_k: 1_000,
            preview_mode: Some(SearchPreviewMode::None),
        })
        .expect("search should succeed");
    assert_eq!(search.len(), 100);

    let path_search = store
        .search_node_paths(SearchNodePathsRequest {
            query_text: "node".to_string(),
            prefix: Some("/Wiki/capped".to_string()),
            top_k: 1_000,
        })
        .expect("path search should succeed");
    assert_eq!(path_search.len(), 100);
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
                path: "/Wiki/zzz/nested-note.md".to_string(),
                expected_etag: Some(first),
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
                path: "/Wiki/zzz/nested-note.md".to_string(),
                expected_etag: Some(latest.etag),
            },
            14,
        )
        .expect("delete should succeed");

    let hits = store
        .search_node_paths(SearchNodePathsRequest {
            query_text: "NESTED note".to_string(),
            prefix: Some("/Wiki".to_string()),
            top_k: 10,
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
