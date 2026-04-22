use rusqlite::Connection;
use tempfile::tempdir;
use vfs_store::FsStore;
use vfs_types::{
    AppendNodeRequest, EditNodeRequest, GlobNodeType, GlobNodesRequest, ListNodesRequest,
    MkdirNodeRequest, MoveNodeRequest, MultiEdit, MultiEditNodeRequest, NodeEntryKind, NodeKind,
    RecentNodesRequest, SearchNodePathsRequest, SearchPreviewMode,
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
fn append_node_creates_updates_and_checks_etag() {
    let (_dir, store) = new_store();

    let created = store
        .append_node(
            AppendNodeRequest {
                path: "/Wiki/log.md".to_string(),
                content: "alpha".to_string(),
                expected_etag: None,
                separator: None,
                metadata_json: Some("{\"t\":1}".to_string()),
                kind: Some(NodeKind::File),
            },
            10,
        )
        .expect("append create should succeed");
    assert!(created.created);
    assert_eq!(
        store
            .read_node("/Wiki/log.md")
            .expect("read should succeed")
            .expect("node should exist")
            .content,
        "alpha"
    );

    let updated = store
        .append_node(
            AppendNodeRequest {
                path: "/Wiki/log.md".to_string(),
                content: "beta".to_string(),
                expected_etag: Some(created.node.etag.clone()),
                separator: Some("\n".to_string()),
                metadata_json: None,
                kind: None,
            },
            11,
        )
        .expect("append update should succeed");
    assert_eq!(
        store
            .read_node("/Wiki/log.md")
            .expect("read should succeed")
            .expect("node should exist")
            .content,
        "alpha\nbeta"
    );
    assert_ne!(updated.node.etag, created.node.etag);

    let stale = store
        .append_node(
            AppendNodeRequest {
                path: "/Wiki/log.md".to_string(),
                content: "gamma".to_string(),
                expected_etag: Some("stale".to_string()),
                separator: None,
                metadata_json: None,
                kind: None,
            },
            12,
        )
        .expect_err("stale append should fail");
    assert!(stale.contains("expected_etag"));
}

#[test]
fn append_node_preserves_existing_kind_and_metadata() {
    let (_dir, store) = new_store();

    let created = store
        .append_node(
            AppendNodeRequest {
                path: "/Sources/raw/log/log.md".to_string(),
                content: "alpha".to_string(),
                expected_etag: None,
                separator: None,
                metadata_json: Some("{\"v\":1}".to_string()),
                kind: Some(NodeKind::Source),
            },
            10,
        )
        .expect("append create should succeed");

    let _updated = store
        .append_node(
            AppendNodeRequest {
                path: "/Sources/raw/log/log.md".to_string(),
                content: "beta".to_string(),
                expected_etag: Some(created.node.etag),
                separator: Some("\n".to_string()),
                metadata_json: Some("{\"v\":2}".to_string()),
                kind: Some(NodeKind::File),
            },
            11,
        )
        .expect("append update should succeed");

    let current = store
        .read_node("/Sources/raw/log/log.md")
        .expect("read should succeed")
        .expect("node should exist");
    assert_eq!(current.kind, NodeKind::Source);
    assert_eq!(current.metadata_json, "{\"v\":1}");
    assert_eq!(current.content, "alpha\nbeta");
}

#[test]
fn edit_node_enforces_plain_text_replacement_rules() {
    let (_dir, store) = new_store();
    let created = store
        .append_node(
            AppendNodeRequest {
                path: "/Wiki/edit.md".to_string(),
                content: "one two one".to_string(),
                expected_etag: None,
                separator: None,
                metadata_json: None,
                kind: None,
            },
            10,
        )
        .expect("append create should succeed");

    let ambiguous = store
        .edit_node(
            EditNodeRequest {
                path: "/Wiki/edit.md".to_string(),
                old_text: "one".to_string(),
                new_text: "three".to_string(),
                expected_etag: Some(created.node.etag.clone()),
                replace_all: false,
            },
            11,
        )
        .expect_err("ambiguous edit should fail");
    assert!(ambiguous.contains("multiple"));

    let edited = store
        .edit_node(
            EditNodeRequest {
                path: "/Wiki/edit.md".to_string(),
                old_text: "one".to_string(),
                new_text: "three".to_string(),
                expected_etag: Some(created.node.etag.clone()),
                replace_all: true,
            },
            12,
        )
        .expect("replace_all edit should succeed");
    assert_eq!(edited.replacement_count, 2);
    assert_eq!(
        store
            .read_node("/Wiki/edit.md")
            .expect("read should succeed")
            .expect("node should exist")
            .content,
        "three two three"
    );

    let missing = store
        .edit_node(
            EditNodeRequest {
                path: "/Wiki/edit.md".to_string(),
                old_text: "absent".to_string(),
                new_text: "x".to_string(),
                expected_etag: Some(edited.node.etag),
                replace_all: true,
            },
            13,
        )
        .expect_err("missing edit should fail");
    assert!(missing.contains("did not match"));
}

#[test]
fn mkdir_node_is_validation_only() {
    let (_dir, store) = new_store();
    let mkdir = store
        .mkdir_node(MkdirNodeRequest {
            path: "/Wiki/folder".to_string(),
        })
        .expect("mkdir should succeed");
    assert!(mkdir.created);

    let invalid = store
        .mkdir_node(MkdirNodeRequest {
            path: "/Wiki/folder/".to_string(),
        })
        .expect_err("invalid mkdir path should fail");
    assert!(invalid.contains("must not end with"));

    let conn = Connection::open(store.database_path()).expect("db should open");
    let count = conn
        .query_row("SELECT COUNT(*) FROM fs_nodes", [], |row| {
            row.get::<_, i64>(0)
        })
        .expect("count should succeed");
    assert_eq!(count, 0);

    let list = store
        .list_nodes(ListNodesRequest {
            prefix: "/Wiki".to_string(),
            recursive: false,
        })
        .expect("list should succeed");
    assert!(list.is_empty());
}

#[test]
fn move_node_renames_and_updates_search() {
    let (_dir, store) = new_store();
    let created = store
        .append_node(
            AppendNodeRequest {
                path: "/Wiki/from.md".to_string(),
                content: "alpha".to_string(),
                expected_etag: None,
                separator: None,
                metadata_json: None,
                kind: None,
            },
            10,
        )
        .expect("create should succeed");
    let conn = Connection::open(store.database_path()).expect("db should open");
    let before_row_id: i64 = conn
        .query_row(
            "SELECT id FROM fs_nodes WHERE path = ?1",
            ["/Wiki/from.md"],
            |row| row.get(0),
        )
        .expect("source row id should exist");
    drop(conn);

    let moved = store
        .move_node(
            MoveNodeRequest {
                from_path: "/Wiki/from.md".to_string(),
                to_path: "/Wiki/to.md".to_string(),
                expected_etag: Some(created.node.etag.clone()),
                overwrite: false,
            },
            11,
        )
        .expect("move should succeed");
    assert_eq!(moved.from_path, "/Wiki/from.md");
    assert_eq!(moved.node.path, "/Wiki/to.md");
    assert!(!moved.overwrote);

    let old = store
        .read_node("/Wiki/from.md")
        .expect("old read should succeed");
    assert!(old.is_none());

    let new = store
        .read_node("/Wiki/to.md")
        .expect("new read should succeed")
        .expect("new node should exist");
    assert_eq!(new.content, "alpha");

    let conn = Connection::open(store.database_path()).expect("db should open");
    let current_row_id: i64 = conn
        .query_row(
            "SELECT id FROM fs_nodes WHERE path = ?1",
            ["/Wiki/to.md"],
            |row| row.get(0),
        )
        .expect("moved row id should exist");
    assert_eq!(current_row_id, before_row_id);

    let hits = store
        .search_nodes(vfs_types::SearchNodesRequest {
            query_text: "alpha".to_string(),
            prefix: Some("/Wiki".to_string()),
            top_k: 5,
            preview_mode: Some(SearchPreviewMode::None),
        })
        .expect("search should succeed");
    #[cfg(feature = "bench-disable-fts")]
    assert!(hits.is_empty());
    #[cfg(not(feature = "bench-disable-fts"))]
    assert_eq!(hits.len(), 1);
    #[cfg(not(feature = "bench-disable-fts"))]
    assert_eq!(hits[0].path, "/Wiki/to.md");

    let path_hits = store
        .search_node_paths(SearchNodePathsRequest {
            query_text: "TO".to_string(),
            prefix: Some("/Wiki".to_string()),
            top_k: 5,
        })
        .expect("path search should succeed");
    assert_eq!(path_hits.len(), 1);
    assert_eq!(path_hits[0].path, "/Wiki/to.md");
}

#[test]
fn move_node_overwrite_replaces_live_target() {
    let (_dir, store) = new_store();
    let source = store
        .append_node(
            AppendNodeRequest {
                path: "/Wiki/from.md".to_string(),
                content: "source".to_string(),
                expected_etag: None,
                separator: None,
                metadata_json: None,
                kind: None,
            },
            10,
        )
        .expect("source create should succeed");
    store
        .append_node(
            AppendNodeRequest {
                path: "/Wiki/to.md".to_string(),
                content: "target".to_string(),
                expected_etag: None,
                separator: None,
                metadata_json: None,
                kind: None,
            },
            11,
        )
        .expect("target create should succeed");

    let moved = store
        .move_node(
            MoveNodeRequest {
                from_path: "/Wiki/from.md".to_string(),
                to_path: "/Wiki/to.md".to_string(),
                expected_etag: Some(source.node.etag),
                overwrite: true,
            },
            12,
        )
        .expect("move should succeed");

    assert!(moved.overwrote);
    assert_eq!(moved.node.path, "/Wiki/to.md");
    assert!(
        store
            .read_node("/Wiki/from.md")
            .expect("read should succeed")
            .is_none()
    );
    assert_eq!(
        store
            .read_node("/Wiki/to.md")
            .expect("read should succeed")
            .expect("node should exist")
            .content,
        "source"
    );
}

#[test]
fn move_node_overwrite_reuses_deleted_target_path() {
    let (_dir, store) = new_store();
    let source = store
        .append_node(
            AppendNodeRequest {
                path: "/Wiki/from.md".to_string(),
                content: "source".to_string(),
                expected_etag: None,
                separator: None,
                metadata_json: None,
                kind: None,
            },
            10,
        )
        .expect("source create should succeed");
    let target = store
        .append_node(
            AppendNodeRequest {
                path: "/Wiki/to.md".to_string(),
                content: "target".to_string(),
                expected_etag: None,
                separator: None,
                metadata_json: None,
                kind: None,
            },
            11,
        )
        .expect("target create should succeed");
    store
        .delete_node(
            vfs_types::DeleteNodeRequest {
                path: "/Wiki/to.md".to_string(),
                expected_etag: Some(target.node.etag),
            },
            12,
        )
        .expect("delete should succeed");

    let moved = store
        .move_node(
            MoveNodeRequest {
                from_path: "/Wiki/from.md".to_string(),
                to_path: "/Wiki/to.md".to_string(),
                expected_etag: Some(source.node.etag),
                overwrite: true,
            },
            13,
        )
        .expect("move should succeed");

    assert!(!moved.overwrote);
    assert_eq!(
        store
            .read_node("/Wiki/to.md")
            .expect("read should succeed")
            .expect("node should exist")
            .content,
        "source"
    );
}

#[test]
fn glob_nodes_matches_files_and_virtual_directories() {
    let (_dir, store) = new_store();
    store
        .append_node(
            AppendNodeRequest {
                path: "/Wiki/root.md".to_string(),
                content: "root".to_string(),
                expected_etag: None,
                separator: None,
                metadata_json: None,
                kind: None,
            },
            10,
        )
        .expect("root create should succeed");
    store
        .append_node(
            AppendNodeRequest {
                path: "/Wiki/nested/deep.md".to_string(),
                content: "deep".to_string(),
                expected_etag: None,
                separator: None,
                metadata_json: None,
                kind: None,
            },
            11,
        )
        .expect("nested create should succeed");

    let direct_files = store
        .glob_nodes(GlobNodesRequest {
            pattern: "*.md".to_string(),
            path: Some("/Wiki".to_string()),
            node_type: Some(GlobNodeType::File),
        })
        .expect("direct glob should succeed");
    assert_eq!(direct_files.len(), 1);
    assert_eq!(direct_files[0].path, "/Wiki/root.md");

    let nested_files = store
        .glob_nodes(GlobNodesRequest {
            pattern: "**/*.md".to_string(),
            path: Some("/Wiki".to_string()),
            node_type: Some(GlobNodeType::File),
        })
        .expect("nested glob should succeed");
    assert_eq!(nested_files.len(), 2);

    let directories = store
        .glob_nodes(GlobNodesRequest {
            pattern: "**".to_string(),
            path: Some("/Wiki".to_string()),
            node_type: Some(GlobNodeType::Directory),
        })
        .expect("directory glob should succeed");
    assert!(
        directories
            .iter()
            .any(|hit| hit.path == "/Wiki/nested" && hit.kind == NodeEntryKind::Directory)
    );
}

#[test]
fn list_and_glob_do_not_depend_on_large_content_loading() {
    let (_dir, store) = new_store();
    let large = "x".repeat(128 * 1024);
    store
        .append_node(
            AppendNodeRequest {
                path: "/Wiki/large.md".to_string(),
                content: large,
                expected_etag: None,
                separator: None,
                metadata_json: None,
                kind: None,
            },
            10,
        )
        .expect("large create should succeed");
    store
        .append_node(
            AppendNodeRequest {
                path: "/Wiki/nested/child.md".to_string(),
                content: "child".to_string(),
                expected_etag: None,
                separator: None,
                metadata_json: None,
                kind: None,
            },
            11,
        )
        .expect("nested create should succeed");

    let list = store
        .list_nodes(ListNodesRequest {
            prefix: "/Wiki".to_string(),
            recursive: false,
        })
        .expect("list should succeed");
    assert!(list.iter().any(|entry| entry.path == "/Wiki/large.md"));
    assert!(list.iter().any(|entry| entry.path == "/Wiki/nested"));

    let glob = store
        .glob_nodes(GlobNodesRequest {
            pattern: "**/*.md".to_string(),
            path: Some("/Wiki".to_string()),
            node_type: Some(GlobNodeType::File),
        })
        .expect("glob should succeed");
    assert!(glob.iter().any(|hit| hit.path == "/Wiki/large.md"));
    assert!(glob.iter().any(|hit| hit.path == "/Wiki/nested/child.md"));
}

#[test]
fn glob_nodes_rejects_overlong_patterns() {
    let (_dir, store) = new_store();
    let error = store
        .glob_nodes(GlobNodesRequest {
            pattern: "*".repeat(513),
            path: Some("/Wiki".to_string()),
            node_type: Some(GlobNodeType::Any),
        })
        .expect_err("glob should reject long pattern");
    assert!(error.contains("pattern is too long"));
}

#[test]
fn glob_nodes_tolerates_existing_paths_longer_than_previous_match_limit() {
    let (_dir, store) = new_store();
    let long_segment = "a".repeat(4097);
    let long_path = format!("/Wiki/{long_segment}.md");
    store
        .append_node(
            AppendNodeRequest {
                path: long_path,
                content: "long".to_string(),
                expected_etag: None,
                separator: None,
                metadata_json: None,
                kind: None,
            },
            10,
        )
        .expect("long path create should succeed");
    store
        .append_node(
            AppendNodeRequest {
                path: "/Wiki/short.md".to_string(),
                content: "short".to_string(),
                expected_etag: None,
                separator: None,
                metadata_json: None,
                kind: None,
            },
            11,
        )
        .expect("short path create should succeed");

    let hits = store
        .glob_nodes(GlobNodesRequest {
            pattern: "*.md".to_string(),
            path: Some("/Wiki".to_string()),
            node_type: Some(GlobNodeType::File),
        })
        .expect("glob should succeed even with long stored paths");
    assert_eq!(hits.len(), 2);
    assert!(hits.iter().any(|hit| hit.path == "/Wiki/short.md"));
}

#[test]
fn recent_nodes_orders_by_updated_at_after_delete_removes_old_entry() {
    let (_dir, store) = new_store();
    let first = store
        .append_node(
            AppendNodeRequest {
                path: "/Wiki/one.md".to_string(),
                content: "one".to_string(),
                expected_etag: None,
                separator: None,
                metadata_json: None,
                kind: None,
            },
            10,
        )
        .expect("first create should succeed");
    let second = store
        .append_node(
            AppendNodeRequest {
                path: "/Wiki/two.md".to_string(),
                content: "two".to_string(),
                expected_etag: None,
                separator: None,
                metadata_json: None,
                kind: None,
            },
            20,
        )
        .expect("second create should succeed");
    store
        .delete_node(
            vfs_types::DeleteNodeRequest {
                path: "/Wiki/one.md".to_string(),
                expected_etag: Some(first.node.etag),
            },
            30,
        )
        .expect("delete should succeed");

    let visible = store
        .recent_nodes(RecentNodesRequest {
            limit: 5,
            path: Some("/Wiki".to_string()),
        })
        .expect("recent visible should succeed");
    assert_eq!(visible.len(), 1);
    assert_eq!(visible[0].path, "/Wiki/two.md");
    assert_eq!(visible[0].etag, second.node.etag);

    let all = store
        .recent_nodes(RecentNodesRequest {
            limit: 5,
            path: Some("/Wiki".to_string()),
        })
        .expect("recent all should succeed");
    assert_eq!(all.len(), 1);
    assert_eq!(all[0].path, "/Wiki/two.md");
}

#[test]
fn multi_edit_node_is_atomic() {
    let (_dir, store) = new_store();
    let created = store
        .append_node(
            AppendNodeRequest {
                path: "/Wiki/multi.md".to_string(),
                content: "alpha beta gamma".to_string(),
                expected_etag: None,
                separator: None,
                metadata_json: None,
                kind: None,
            },
            10,
        )
        .expect("create should succeed");

    let updated = store
        .multi_edit_node(
            MultiEditNodeRequest {
                path: "/Wiki/multi.md".to_string(),
                edits: vec![
                    MultiEdit {
                        old_text: "alpha".to_string(),
                        new_text: "one".to_string(),
                    },
                    MultiEdit {
                        old_text: "gamma".to_string(),
                        new_text: "three".to_string(),
                    },
                ],
                expected_etag: Some(created.node.etag.clone()),
            },
            11,
        )
        .expect("multi edit should succeed");
    assert_eq!(updated.replacement_count, 2);
    assert_eq!(
        store
            .read_node("/Wiki/multi.md")
            .expect("read should succeed")
            .expect("node should exist")
            .content,
        "one beta three"
    );

    let failed = store
        .multi_edit_node(
            MultiEditNodeRequest {
                path: "/Wiki/multi.md".to_string(),
                edits: vec![
                    MultiEdit {
                        old_text: "one".to_string(),
                        new_text: "uno".to_string(),
                    },
                    MultiEdit {
                        old_text: "missing".to_string(),
                        new_text: "x".to_string(),
                    },
                ],
                expected_etag: Some(updated.node.etag.clone()),
            },
            12,
        )
        .expect_err("multi edit should rollback on missing text");
    assert!(failed.contains("did not match"));

    let current = store
        .read_node("/Wiki/multi.md")
        .expect("read should succeed")
        .expect("node should exist");
    assert_eq!(current.content, "one beta three");
    assert_eq!(current.etag, updated.node.etag);
}
