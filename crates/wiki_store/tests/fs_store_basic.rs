use rusqlite::Connection;
use tempfile::tempdir;
use wiki_store::FsStore;
use wiki_types::{
    DeleteNodeRequest, ExportSnapshotRequest, ListNodesRequest, NodeEntryKind, NodeKind,
    SearchNodesRequest, WriteNodeRequest,
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
                content: format!("content at {path}"),
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
        "fs_snapshots",
        "fs_snapshot_nodes",
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
}

#[test]
fn status_counts_files_sources_and_tombstones() {
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
                path: "/Wiki/source.txt".to_string(),
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
    assert_eq!(status.deleted_count, 1);
    assert_eq!(source.node.kind, NodeKind::Source);
}

#[test]
fn write_update_delete_and_revive_follow_etag_rules() {
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
        Some(first.node.clone())
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
    assert_eq!(second.node.created_at, first.node.created_at);

    let deleted = store
        .delete_node(
            DeleteNodeRequest {
                path: "/Wiki/foo.md".to_string(),
                expected_etag: Some(second.node.etag.clone()),
            },
            13,
        )
        .expect("delete should succeed");
    assert_eq!(deleted.deleted_at, 13);
    let stale_delete = store
        .delete_node(
            DeleteNodeRequest {
                path: "/Wiki/foo.md".to_string(),
                expected_etag: Some(second.node.etag),
            },
            14,
        )
        .expect_err("stale delete should fail");
    assert!(stale_delete.contains("already deleted"));
    assert!(
        store
            .read_node("/Wiki/foo.md")
            .expect("read after delete should succeed")
            .is_none()
    );

    let revive = store
        .write_node(
            WriteNodeRequest {
                path: "/Wiki/foo.md".to_string(),
                kind: NodeKind::File,
                content: "gamma".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: Some(deleted.etag),
            },
            15,
        )
        .expect("revive should succeed");
    assert_eq!(revive.node.created_at, first.node.created_at);
    assert_eq!(revive.node.updated_at, 15);
    assert!(revive.node.deleted_at.is_none());
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
            include_deleted: false,
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
            include_deleted: false,
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
    let deleted_tombstone = store
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
        .expect("deleted leaf tombstone should succeed");
    assert_eq!(deleted_tombstone.deleted_at, 14);
    let visible_after_delete = store
        .list_nodes(ListNodesRequest {
            prefix: "/Wiki".to_string(),
            recursive: true,
            include_deleted: false,
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

    let root_after_tombstone = store
        .list_nodes(ListNodesRequest {
            prefix: "/Wiki".to_string(),
            recursive: false,
            include_deleted: false,
        })
        .expect("root list after tombstone should succeed");
    assert!(
        !root_after_tombstone
            .iter()
            .any(|entry| entry.path == "/Wiki/deleted")
    );

    let deleted_entries = store
        .list_nodes(ListNodesRequest {
            prefix: "/Wiki".to_string(),
            recursive: true,
            include_deleted: true,
        })
        .expect("deleted list should succeed");
    assert_eq!(deleted_entries.len(), 5);
    assert!(
        deleted_entries
            .iter()
            .any(|entry| entry.path == "/Wiki/alpha.md")
    );
    assert!(
        deleted_entries
            .iter()
            .any(|entry| entry.path == "/Wiki/deleted/leaf.md")
    );

    let deleted_root_entries = store
        .list_nodes(ListNodesRequest {
            prefix: "/Wiki".to_string(),
            recursive: false,
            include_deleted: true,
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
        })
        .expect("search should succeed");
    assert_eq!(search_hits.len(), 1);
    assert_eq!(search_hits[0].path, "/Wiki/nested/beta.md");
    assert_eq!(search_hits[0].match_reasons, vec!["fts5_bm25".to_string()]);

    let missing_hits = store
        .search_nodes(SearchNodesRequest {
            query_text: "alpha".to_string(),
            prefix: Some("/Wiki".to_string()),
            top_k: 5,
        })
        .expect("search should succeed");
    assert!(missing_hits.is_empty());

    let snapshot = store
        .export_snapshot(ExportSnapshotRequest {
            prefix: Some("/Wiki".to_string()),
            include_deleted: true,
        })
        .expect("snapshot should succeed");
    assert_eq!(snapshot.nodes.len(), 5);
    assert!(
        snapshot
            .nodes
            .iter()
            .any(|node| node.path == "/Wiki/alpha.md")
    );
    assert!(
        snapshot
            .nodes
            .iter()
            .any(|node| node.path == "/Wiki/nested/beta.md")
    );
    assert_eq!(snapshot.snapshot_revision.len(), beta.len());
}
