use rusqlite::Connection;
use tempfile::tempdir;
use vfs_store::FsStore;
use vfs_types::{
    DeleteNodeRequest, ExportSnapshotRequest, FetchUpdatesRequest, MoveNodeRequest, NodeKind,
    WriteNodeRequest,
};

fn new_store() -> (tempfile::TempDir, FsStore) {
    let dir = tempdir().expect("temp dir should exist");
    let store = FsStore::new(dir.path().join("wiki.sqlite3"));
    store
        .run_fs_migrations()
        .expect("fs migrations should succeed");
    (dir, store)
}

fn write_node(
    store: &FsStore,
    path: &str,
    content: &str,
    expected_etag: Option<&str>,
    now: i64,
) -> String {
    store
        .write_node(
            WriteNodeRequest {
                path: path.to_string(),
                kind: NodeKind::File,
                content: content.to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: expected_etag.map(str::to_string),
            },
            now,
        )
        .expect("write should succeed")
        .node
        .etag
}

fn expire_snapshot_session(store: &FsStore, session_id: &str) {
    let conn = Connection::open(store.database_path()).expect("db should open");
    conn.execute(
        "UPDATE fs_snapshot_sessions SET expires_at = 0 WHERE session_id = ?1",
        [session_id],
    )
    .expect("session should expire");
}

fn snapshot_session_count(store: &FsStore) -> i64 {
    let conn = Connection::open(store.database_path()).expect("db should open");
    conn.query_row("SELECT COUNT(*) FROM fs_snapshot_sessions", [], |row| {
        row.get(0)
    })
    .expect("count should succeed")
}

#[test]
fn snapshot_revision_is_stable_for_same_state() {
    let (_dir, store) = new_store();
    write_node(&store, "/Wiki/alpha.md", "alpha", None, 10);
    write_node(&store, "/Wiki/beta.md", "beta", None, 11);

    let first = store
        .export_snapshot(ExportSnapshotRequest {
            prefix: Some("/Wiki".to_string()),
            limit: 100,
            cursor: None,
            snapshot_revision: None,
            snapshot_session_id: None,
        })
        .expect("first snapshot should succeed");
    let second = store
        .export_snapshot(ExportSnapshotRequest {
            prefix: Some("/Wiki".to_string()),
            limit: 100,
            cursor: None,
            snapshot_revision: None,
            snapshot_session_id: None,
        })
        .expect("second snapshot should succeed");
    assert_eq!(first.snapshot_revision, second.snapshot_revision);
    assert_eq!(first.nodes, second.nodes);
}

#[test]
fn fetch_updates_returns_empty_when_snapshot_matches() {
    let (_dir, store) = new_store();
    write_node(&store, "/Wiki/alpha.md", "alpha", None, 10);
    let snapshot = store
        .export_snapshot(ExportSnapshotRequest {
            prefix: Some("/Wiki".to_string()),
            limit: 100,
            cursor: None,
            snapshot_revision: None,
            snapshot_session_id: None,
        })
        .expect("snapshot should succeed");

    let updates = store
        .fetch_updates(FetchUpdatesRequest {
            known_snapshot_revision: snapshot.snapshot_revision.clone(),
            prefix: Some("/Wiki".to_string()),
            limit: 100,
            cursor: None,
            target_snapshot_revision: None,
        })
        .expect("updates should succeed");
    assert_eq!(updates.snapshot_revision, snapshot.snapshot_revision);
    assert!(updates.changed_nodes.is_empty());
    assert!(updates.removed_paths.is_empty());
}

#[test]
fn fetch_updates_returns_delta_from_old_retained_revision() {
    let (_dir, store) = new_store();
    write_node(&store, "/Wiki/base.md", "base", None, 10);
    write_node(&store, "/Wiki/unchanged.md", "unchanged", None, 11);
    let base = store
        .export_snapshot(ExportSnapshotRequest {
            prefix: Some("/Wiki".to_string()),
            limit: 100,
            cursor: None,
            snapshot_revision: None,
            snapshot_session_id: None,
        })
        .expect("base snapshot should succeed");

    for now in 12..=320 {
        let path = format!("/Wiki/history-{now}.md");
        let content = format!("revision {now}");
        write_node(&store, &path, &content, None, now);
    }

    let mut cursor = None;
    let mut target_snapshot_revision = None;
    let mut changed_nodes = Vec::new();
    loop {
        let page = store
            .fetch_updates(FetchUpdatesRequest {
                known_snapshot_revision: base.snapshot_revision.clone(),
                prefix: Some("/Wiki".to_string()),
                limit: 100,
                cursor,
                target_snapshot_revision,
            })
            .expect("updates should succeed");
        changed_nodes.extend(page.changed_nodes);
        if page.next_cursor.is_none() {
            break;
        }
        cursor = page.next_cursor;
        target_snapshot_revision = Some(page.snapshot_revision);
    }

    assert_eq!(changed_nodes.len(), 309);
    assert!(
        !changed_nodes
            .iter()
            .any(|node| node.path == "/Wiki/unchanged.md")
    );
    assert!(
        changed_nodes
            .iter()
            .any(|node| node.path == "/Wiki/history-270.md")
    );
}

#[test]
fn fetch_updates_rejects_revision_before_available_change_log() {
    let (_dir, store) = new_store();
    write_node(&store, "/Wiki/base.md", "base", None, 10);
    let base = store
        .export_snapshot(ExportSnapshotRequest {
            prefix: Some("/Wiki".to_string()),
            limit: 100,
            cursor: None,
            snapshot_revision: None,
            snapshot_session_id: None,
        })
        .expect("base snapshot should succeed");

    for now in 11..=20 {
        let path = format!("/Wiki/history-{now}.md");
        let content = format!("revision {now}");
        write_node(&store, &path, &content, None, now);
    }
    let conn = Connection::open(store.database_path()).expect("db should open");
    conn.execute("DELETE FROM fs_change_log WHERE revision < ?1", [6_i64])
        .expect("manual compaction should succeed");

    let error = store
        .fetch_updates(FetchUpdatesRequest {
            known_snapshot_revision: base.snapshot_revision,
            prefix: Some("/Wiki".to_string()),
            limit: 100,
            cursor: None,
            target_snapshot_revision: None,
        })
        .expect_err("missing historical change log should fail");

    assert_eq!(error, "known_snapshot_revision is no longer available");
}

#[test]
fn fetch_updates_returns_delta_from_recent_revision() {
    let (_dir, store) = new_store();
    for now in 10..=19 {
        let path = format!("/Wiki/seed-{now}.md");
        let content = format!("seed {now}");
        write_node(&store, &path, &content, None, now);
    }
    let base = store
        .export_snapshot(ExportSnapshotRequest {
            prefix: Some("/Wiki".to_string()),
            limit: 100,
            cursor: None,
            snapshot_revision: None,
            snapshot_session_id: None,
        })
        .expect("base snapshot should succeed");

    write_node(&store, "/Wiki/live.md", "live", None, 20);

    let updates = store
        .fetch_updates(FetchUpdatesRequest {
            known_snapshot_revision: base.snapshot_revision,
            prefix: Some("/Wiki".to_string()),
            limit: 100,
            cursor: None,
            target_snapshot_revision: None,
        })
        .expect("updates should succeed");

    assert_eq!(updates.changed_nodes.len(), 1);
    assert_eq!(updates.changed_nodes[0].path, "/Wiki/live.md");
    assert!(updates.removed_paths.is_empty());
}

#[test]
fn fetch_updates_noop_uses_revision_scope_without_reading_state_hash() {
    let (_dir, store) = new_store();
    write_node(&store, "/Wiki/alpha.md", "alpha", None, 10);
    let snapshot = store
        .export_snapshot(ExportSnapshotRequest {
            prefix: Some("/Wiki".to_string()),
            limit: 100,
            cursor: None,
            snapshot_revision: None,
            snapshot_session_id: None,
        })
        .expect("snapshot should succeed");
    assert_v5_snapshot_revision_without_state_hash(&snapshot.snapshot_revision);

    let conn = Connection::open(store.database_path()).expect("db should open");
    conn.execute(
        "UPDATE fs_nodes SET content = ?1 WHERE path = ?2",
        ["changed without revision", "/Wiki/alpha.md"],
    )
    .expect("direct content change should succeed");

    let updates = store
        .fetch_updates(FetchUpdatesRequest {
            known_snapshot_revision: snapshot.snapshot_revision.clone(),
            prefix: Some("/Wiki".to_string()),
            limit: 100,
            cursor: None,
            target_snapshot_revision: None,
        })
        .expect("updates should succeed");
    assert_eq!(updates.snapshot_revision, snapshot.snapshot_revision);
    assert!(updates.changed_nodes.is_empty());
    assert!(updates.removed_paths.is_empty());
}

fn assert_v5_snapshot_revision_without_state_hash(snapshot_revision: &str) {
    let parts = snapshot_revision.split(':').collect::<Vec<_>>();
    assert_eq!(parts.len(), 3);
    assert_eq!(parts[0], "v5");
    assert!(parts[1].parse::<i64>().expect("revision should parse") >= 0);
    assert!(!parts[2].is_empty());
}

#[test]
fn fetch_updates_returns_only_changed_nodes_since_known_snapshot() {
    let (_dir, store) = new_store();
    let alpha = write_node(&store, "/Wiki/alpha.md", "alpha", None, 10);
    let beta = write_node(&store, "/Wiki/beta.md", "beta", None, 11);
    let base = store
        .export_snapshot(ExportSnapshotRequest {
            prefix: Some("/Wiki".to_string()),
            limit: 100,
            cursor: None,
            snapshot_revision: None,
            snapshot_session_id: None,
        })
        .expect("base snapshot should succeed");

    write_node(&store, "/Wiki/alpha.md", "alpha updated", Some(&alpha), 12);
    write_node(&store, "/Wiki/gamma.md", "gamma", None, 13);
    store
        .delete_node(
            DeleteNodeRequest {
                path: "/Wiki/beta.md".to_string(),
                expected_etag: Some(beta),
            },
            14,
        )
        .expect("delete should succeed");

    let updates = store
        .fetch_updates(FetchUpdatesRequest {
            known_snapshot_revision: base.snapshot_revision,
            prefix: Some("/Wiki".to_string()),
            limit: 100,
            cursor: None,
            target_snapshot_revision: None,
        })
        .expect("updates should succeed");
    assert_eq!(updates.changed_nodes.len(), 2);
    assert!(
        updates
            .changed_nodes
            .iter()
            .any(|node| node.path == "/Wiki/alpha.md")
    );
    assert!(
        updates
            .changed_nodes
            .iter()
            .any(|node| node.path == "/Wiki/gamma.md")
    );
    assert!(
        !updates
            .changed_nodes
            .iter()
            .any(|node| node.path == "/Wiki/beta.md")
    );
    assert_eq!(updates.removed_paths, vec!["/Wiki/beta.md".to_string()]);
}

#[test]
fn fetch_updates_rejects_invalid_snapshot_revision() {
    let (_dir, store) = new_store();
    write_node(&store, "/Wiki/alpha.md", "alpha", None, 10);
    write_node(&store, "/Wiki/beta.md", "beta", None, 11);

    for known_snapshot_revision in [
        "unknown".to_string(),
        "v3:1:0:2f57696b69:old-state-hash".to_string(),
    ] {
        let error = store
            .fetch_updates(FetchUpdatesRequest {
                known_snapshot_revision,
                prefix: Some("/Wiki".to_string()),
                limit: 100,
                cursor: None,
                target_snapshot_revision: None,
            })
            .expect_err("invalid snapshot should fail");
        assert_eq!(error, "known_snapshot_revision is invalid");
    }
}

#[test]
fn fetch_updates_rejects_future_snapshot_revision() {
    let (_dir, store) = new_store();
    write_node(&store, "/Wiki/alpha.md", "alpha", None, 10);

    let error = store
        .fetch_updates(FetchUpdatesRequest {
            known_snapshot_revision: "v5:999999:2f57696b69".to_string(),
            prefix: Some("/Wiki".to_string()),
            limit: 100,
            cursor: None,
            target_snapshot_revision: None,
        })
        .expect_err("future snapshot should fail");

    assert_eq!(
        error,
        "known_snapshot_revision is newer than current revision"
    );
}

#[test]
fn fetch_updates_reports_old_path_when_node_is_moved() {
    let (_dir, store) = new_store();
    let alpha = write_node(&store, "/Wiki/alpha.md", "alpha", None, 10);
    let base = store
        .export_snapshot(ExportSnapshotRequest {
            prefix: Some("/Wiki".to_string()),
            limit: 100,
            cursor: None,
            snapshot_revision: None,
            snapshot_session_id: None,
        })
        .expect("base snapshot should succeed");

    store
        .move_node(
            MoveNodeRequest {
                from_path: "/Wiki/alpha.md".to_string(),
                to_path: "/Wiki/archive/alpha.md".to_string(),
                expected_etag: Some(alpha),
                overwrite: false,
            },
            11,
        )
        .expect("move should succeed");

    let updates = store
        .fetch_updates(FetchUpdatesRequest {
            known_snapshot_revision: base.snapshot_revision,
            prefix: Some("/Wiki".to_string()),
            limit: 100,
            cursor: None,
            target_snapshot_revision: None,
        })
        .expect("updates should succeed");
    assert_eq!(updates.changed_nodes.len(), 1);
    assert_eq!(updates.changed_nodes[0].path, "/Wiki/archive/alpha.md");
    assert_eq!(updates.removed_paths, vec!["/Wiki/alpha.md".to_string()]);
}

#[test]
fn snapshot_revision_changes_when_scope_changes_without_new_writes() {
    let (_dir, store) = new_store();
    write_node(&store, "/Wiki/alpha.md", "alpha", None, 10);
    write_node(&store, "/Wiki/nested/beta.md", "beta", None, 11);

    let root_snapshot = store
        .export_snapshot(ExportSnapshotRequest {
            prefix: Some("/Wiki".to_string()),
            limit: 100,
            cursor: None,
            snapshot_revision: None,
            snapshot_session_id: None,
        })
        .expect("root snapshot should succeed");
    let nested_snapshot = store
        .export_snapshot(ExportSnapshotRequest {
            prefix: Some("/Wiki/nested".to_string()),
            limit: 100,
            cursor: None,
            snapshot_revision: None,
            snapshot_session_id: None,
        })
        .expect("nested snapshot should succeed");

    assert_ne!(
        root_snapshot.snapshot_revision,
        nested_snapshot.snapshot_revision
    );
}

#[test]
fn fetch_updates_rejects_prefix_change_without_new_writes() {
    let (_dir, store) = new_store();
    write_node(&store, "/Wiki/alpha.md", "alpha", None, 10);
    write_node(&store, "/Wiki/nested/beta.md", "beta", None, 11);

    let nested_snapshot = store
        .export_snapshot(ExportSnapshotRequest {
            prefix: Some("/Wiki/nested".to_string()),
            limit: 100,
            cursor: None,
            snapshot_revision: None,
            snapshot_session_id: None,
        })
        .expect("nested snapshot should succeed");
    let error = store
        .fetch_updates(FetchUpdatesRequest {
            known_snapshot_revision: nested_snapshot.snapshot_revision,
            prefix: Some("/Wiki".to_string()),
            limit: 100,
            cursor: None,
            target_snapshot_revision: None,
        })
        .expect_err("prefix change should fail");

    assert_eq!(
        error,
        "known_snapshot_revision prefix does not match request prefix"
    );
}

#[test]
fn fetch_updates_rejects_prefix_shrink_without_new_writes() {
    let (_dir, store) = new_store();
    write_node(&store, "/Wiki/alpha.md", "alpha", None, 10);
    write_node(&store, "/Wiki/nested/beta.md", "beta", None, 11);

    let root_snapshot = store
        .export_snapshot(ExportSnapshotRequest {
            prefix: Some("/Wiki".to_string()),
            limit: 100,
            cursor: None,
            snapshot_revision: None,
            snapshot_session_id: None,
        })
        .expect("root snapshot should succeed");
    let error = store
        .fetch_updates(FetchUpdatesRequest {
            known_snapshot_revision: root_snapshot.snapshot_revision,
            prefix: Some("/Wiki/nested".to_string()),
            limit: 100,
            cursor: None,
            target_snapshot_revision: None,
        })
        .expect_err("prefix shrink should fail");

    assert_eq!(
        error,
        "known_snapshot_revision prefix does not match request prefix"
    );
}

#[test]
fn fetch_updates_rejects_scope_change_after_move() {
    let (_dir, store) = new_store();
    let source = write_node(&store, "/Wiki/a.md", "alpha", None, 10);
    store
        .move_node(
            MoveNodeRequest {
                from_path: "/Wiki/a.md".to_string(),
                to_path: "/Wiki/archive/a.md".to_string(),
                expected_etag: Some(source),
                overwrite: false,
            },
            11,
        )
        .expect("move should succeed");

    let known = store
        .export_snapshot(ExportSnapshotRequest {
            prefix: Some("/Wiki".to_string()),
            limit: 100,
            cursor: None,
            snapshot_revision: None,
            snapshot_session_id: None,
        })
        .expect("snapshot should succeed");
    let error = store
        .fetch_updates(FetchUpdatesRequest {
            known_snapshot_revision: known.snapshot_revision,
            prefix: Some("/Wiki/archive".to_string()),
            limit: 100,
            cursor: None,
            target_snapshot_revision: None,
        })
        .expect_err("scope change should fail");

    assert_eq!(
        error,
        "known_snapshot_revision prefix does not match request prefix"
    );
}

#[test]
fn fetch_updates_reports_move_overwrite_of_live_target() {
    let (_dir, store) = new_store();
    let source = write_node(&store, "/Wiki/source.md", "source", None, 10);
    write_node(&store, "/Wiki/target.md", "target", None, 11);
    let base = store
        .export_snapshot(ExportSnapshotRequest {
            prefix: Some("/Wiki".to_string()),
            limit: 100,
            cursor: None,
            snapshot_revision: None,
            snapshot_session_id: None,
        })
        .expect("snapshot should succeed");

    store
        .move_node(
            MoveNodeRequest {
                from_path: "/Wiki/source.md".to_string(),
                to_path: "/Wiki/target.md".to_string(),
                expected_etag: Some(source),
                overwrite: true,
            },
            12,
        )
        .expect("move should succeed");

    let updates = store
        .fetch_updates(FetchUpdatesRequest {
            known_snapshot_revision: base.snapshot_revision,
            prefix: Some("/Wiki".to_string()),
            limit: 100,
            cursor: None,
            target_snapshot_revision: None,
        })
        .expect("updates should succeed");

    assert_eq!(updates.changed_nodes.len(), 1);
    assert_eq!(updates.changed_nodes[0].path, "/Wiki/target.md");
    assert_eq!(updates.changed_nodes[0].content, "source");
    assert_eq!(updates.removed_paths, vec!["/Wiki/source.md".to_string()]);
}

#[test]
fn export_snapshot_pages_nodes_by_path() {
    let (_dir, store) = new_store();
    for index in 0..101 {
        write_node(
            &store,
            &format!("/Wiki/{index:03}.md"),
            "content",
            None,
            index,
        );
    }

    let first = store
        .export_snapshot(ExportSnapshotRequest {
            prefix: Some("/Wiki".to_string()),
            limit: 100,
            cursor: None,
            snapshot_revision: None,
            snapshot_session_id: None,
        })
        .expect("first page should succeed");
    assert!(first.snapshot_session_id.is_some());
    assert_eq!(first.nodes.len(), 100);
    assert_eq!(first.nodes[0].path, "/Wiki/000.md");
    assert_eq!(first.next_cursor, Some("/Wiki/099.md".to_string()));

    let second = store
        .export_snapshot(ExportSnapshotRequest {
            prefix: Some("/Wiki".to_string()),
            limit: 100,
            cursor: first.next_cursor,
            snapshot_revision: Some(first.snapshot_revision.clone()),
            snapshot_session_id: first.snapshot_session_id.clone(),
        })
        .expect("second page should succeed");
    assert_eq!(second.snapshot_revision, first.snapshot_revision);
    assert_eq!(second.nodes.len(), 1);
    assert_eq!(second.nodes[0].path, "/Wiki/100.md");
    assert_eq!(second.next_cursor, None);
}

#[test]
fn export_snapshot_excludes_paths_created_after_session_start() {
    let (_dir, store) = new_store();
    for index in 0..101 {
        write_node(
            &store,
            &format!("/Wiki/{index:03}.md"),
            "content",
            None,
            index,
        );
    }

    let first = store
        .export_snapshot(ExportSnapshotRequest {
            prefix: Some("/Wiki".to_string()),
            limit: 100,
            cursor: None,
            snapshot_revision: None,
            snapshot_session_id: None,
        })
        .expect("first page should succeed");
    write_node(&store, "/Wiki/zzz.md", "new content", None, 500);

    let second = store
        .export_snapshot(ExportSnapshotRequest {
            prefix: Some("/Wiki".to_string()),
            limit: 100,
            cursor: first.next_cursor,
            snapshot_revision: Some(first.snapshot_revision.clone()),
            snapshot_session_id: first.snapshot_session_id.clone(),
        })
        .expect("paged snapshot should stay stable");
    assert_eq!(second.snapshot_revision, first.snapshot_revision);
    assert_eq!(second.snapshot_session_id, first.snapshot_session_id);
    assert_eq!(second.nodes.len(), 1);
    assert_eq!(second.nodes[0].path, "/Wiki/100.md");
}

#[test]
fn export_snapshot_rejects_deleted_session_path() {
    let (_dir, store) = new_store();
    for index in 0..101 {
        write_node(
            &store,
            &format!("/Wiki/{index:03}.md"),
            "content",
            None,
            index,
        );
    }

    let first = store
        .export_snapshot(ExportSnapshotRequest {
            prefix: Some("/Wiki".to_string()),
            limit: 100,
            cursor: None,
            snapshot_revision: None,
            snapshot_session_id: None,
        })
        .expect("first page should succeed");
    let etag = store
        .read_node("/Wiki/100.md")
        .expect("read should succeed")
        .expect("node should exist")
        .etag;
    store
        .delete_node(
            DeleteNodeRequest {
                path: "/Wiki/100.md".to_string(),
                expected_etag: Some(etag),
            },
            500,
        )
        .expect("delete should succeed");

    let error = store
        .export_snapshot(ExportSnapshotRequest {
            prefix: Some("/Wiki".to_string()),
            limit: 100,
            cursor: first.next_cursor,
            snapshot_revision: Some(first.snapshot_revision),
            snapshot_session_id: first.snapshot_session_id,
        })
        .expect_err("deleted path should invalidate session page");
    assert_eq!(error, "snapshot_revision is no longer current");
}

#[test]
fn export_snapshot_rejects_updated_session_path() {
    let (_dir, store) = new_store();
    for index in 0..101 {
        write_node(
            &store,
            &format!("/Wiki/{index:03}.md"),
            "content",
            None,
            index,
        );
    }

    let first = store
        .export_snapshot(ExportSnapshotRequest {
            prefix: Some("/Wiki".to_string()),
            limit: 100,
            cursor: None,
            snapshot_revision: None,
            snapshot_session_id: None,
        })
        .expect("first page should succeed");
    let etag = store
        .read_node("/Wiki/100.md")
        .expect("read should succeed")
        .expect("node should exist")
        .etag;
    store
        .write_node(
            WriteNodeRequest {
                path: "/Wiki/100.md".to_string(),
                kind: NodeKind::File,
                content: "updated".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: Some(etag),
            },
            500,
        )
        .expect("write should succeed");

    let error = store
        .export_snapshot(ExportSnapshotRequest {
            prefix: Some("/Wiki".to_string()),
            limit: 100,
            cursor: first.next_cursor,
            snapshot_revision: Some(first.snapshot_revision),
            snapshot_session_id: first.snapshot_session_id,
        })
        .expect_err("updated path should invalidate session page");
    assert_eq!(error, "snapshot_revision is no longer current");
}

#[test]
fn export_snapshot_rejects_expired_session() {
    let (_dir, store) = new_store();
    for index in 0..101 {
        write_node(
            &store,
            &format!("/Wiki/{index:03}.md"),
            "content",
            None,
            index,
        );
    }
    let first = store
        .export_snapshot(ExportSnapshotRequest {
            prefix: Some("/Wiki".to_string()),
            limit: 100,
            cursor: None,
            snapshot_revision: None,
            snapshot_session_id: None,
        })
        .expect("first page should succeed");
    expire_snapshot_session(
        &store,
        first
            .snapshot_session_id
            .as_deref()
            .expect("session id should exist"),
    );

    let error = store
        .export_snapshot(ExportSnapshotRequest {
            prefix: Some("/Wiki".to_string()),
            limit: 100,
            cursor: first.next_cursor,
            snapshot_revision: Some(first.snapshot_revision),
            snapshot_session_id: first.snapshot_session_id,
        })
        .expect_err("expired session should fail");
    assert_eq!(error, "snapshot_session_id has expired");
}

#[test]
fn export_snapshot_rejects_invalid_or_mismatched_session() {
    let (_dir, store) = new_store();
    write_node(&store, "/Wiki/alpha.md", "alpha", None, 10);
    let first = store
        .export_snapshot(ExportSnapshotRequest {
            prefix: Some("/Wiki".to_string()),
            limit: 1,
            cursor: None,
            snapshot_revision: None,
            snapshot_session_id: None,
        })
        .expect("first page should succeed");
    let first_snapshot_revision = first.snapshot_revision.clone();
    let first_snapshot_session_id = first.snapshot_session_id.clone();

    let invalid = store
        .export_snapshot(ExportSnapshotRequest {
            prefix: Some("/Wiki".to_string()),
            limit: 1,
            cursor: Some("/Wiki/alpha.md".to_string()),
            snapshot_revision: Some(first.snapshot_revision.clone()),
            snapshot_session_id: Some("missing".to_string()),
        })
        .expect_err("missing session should fail");
    assert_eq!(invalid, "snapshot_session_id is invalid");

    let mismatch = store
        .export_snapshot(ExportSnapshotRequest {
            prefix: Some("/".to_string()),
            limit: 1,
            cursor: Some("/Wiki/alpha.md".to_string()),
            snapshot_revision: Some(first_snapshot_revision.clone()),
            snapshot_session_id: first_snapshot_session_id.clone(),
        })
        .expect_err("prefix mismatch should fail");
    assert_eq!(
        mismatch,
        "snapshot_session_id prefix does not match request prefix"
    );

    let invalid_cursor = store
        .export_snapshot(ExportSnapshotRequest {
            prefix: Some("/Wiki".to_string()),
            limit: 1,
            cursor: Some("/Wiki/missing.md".to_string()),
            snapshot_revision: Some(first_snapshot_revision),
            snapshot_session_id: first_snapshot_session_id,
        })
        .expect_err("session cursor mismatch should fail");
    assert_eq!(invalid_cursor, "cursor is invalid for snapshot_session_id");
}

#[test]
fn export_snapshot_lazy_cleanup_removes_expired_sessions() {
    let (_dir, store) = new_store();
    for index in 0..101 {
        write_node(
            &store,
            &format!("/Wiki/{index:03}.md"),
            "content",
            None,
            index,
        );
    }
    let first = store
        .export_snapshot(ExportSnapshotRequest {
            prefix: Some("/Wiki".to_string()),
            limit: 100,
            cursor: None,
            snapshot_revision: None,
            snapshot_session_id: None,
        })
        .expect("first page should succeed");
    expire_snapshot_session(
        &store,
        first
            .snapshot_session_id
            .as_deref()
            .expect("session id should exist"),
    );
    assert_eq!(snapshot_session_count(&store), 1);

    let _ = store
        .export_snapshot(ExportSnapshotRequest {
            prefix: Some("/Wiki".to_string()),
            limit: 100,
            cursor: None,
            snapshot_revision: None,
            snapshot_session_id: None,
        })
        .expect("new session should succeed");
    assert_eq!(snapshot_session_count(&store), 1);
}

#[test]
fn fetch_updates_pages_changed_and_removed_paths_to_fixed_target() {
    let (_dir, store) = new_store();
    let stale = write_node(&store, "/Wiki/000.md", "stale", None, 0);
    let base = store
        .export_snapshot(ExportSnapshotRequest {
            prefix: Some("/Wiki".to_string()),
            limit: 100,
            cursor: None,
            snapshot_revision: None,
            snapshot_session_id: None,
        })
        .expect("base snapshot should succeed");
    store
        .delete_node(
            DeleteNodeRequest {
                path: "/Wiki/000.md".to_string(),
                expected_etag: Some(stale),
            },
            1,
        )
        .expect("delete should succeed");
    for index in 1..101 {
        write_node(
            &store,
            &format!("/Wiki/{index:03}.md"),
            "content",
            None,
            index,
        );
    }

    let first = store
        .fetch_updates(FetchUpdatesRequest {
            known_snapshot_revision: base.snapshot_revision.clone(),
            prefix: Some("/Wiki".to_string()),
            limit: 100,
            cursor: None,
            target_snapshot_revision: None,
        })
        .expect("first updates page should succeed");
    assert_eq!(first.changed_nodes.len() + first.removed_paths.len(), 100);
    assert_eq!(first.removed_paths, vec!["/Wiki/000.md".to_string()]);
    assert_eq!(first.next_cursor, Some("/Wiki/099.md".to_string()));

    write_node(&store, "/Wiki/zzz.md", "future", None, 200);
    let second = store
        .fetch_updates(FetchUpdatesRequest {
            known_snapshot_revision: base.snapshot_revision,
            prefix: Some("/Wiki".to_string()),
            limit: 100,
            cursor: first.next_cursor,
            target_snapshot_revision: Some(first.snapshot_revision.clone()),
        })
        .expect("second updates page should succeed");
    assert_eq!(second.snapshot_revision, first.snapshot_revision);
    assert_eq!(second.changed_nodes.len(), 1);
    assert_eq!(second.changed_nodes[0].path, "/Wiki/100.md");
    assert_eq!(second.removed_paths, Vec::<String>::new());
    assert_eq!(second.next_cursor, None);
}

#[test]
fn fetch_updates_rejects_when_paged_target_path_changes_after_target() {
    let (_dir, store) = new_store();
    let base = store
        .export_snapshot(ExportSnapshotRequest {
            prefix: Some("/Wiki".to_string()),
            limit: 100,
            cursor: None,
            snapshot_revision: None,
            snapshot_session_id: None,
        })
        .expect("base snapshot should succeed");
    for index in 0..101 {
        write_node(
            &store,
            &format!("/Wiki/{index:03}.md"),
            "content",
            None,
            index,
        );
    }

    let first = store
        .fetch_updates(FetchUpdatesRequest {
            known_snapshot_revision: base.snapshot_revision.clone(),
            prefix: Some("/Wiki".to_string()),
            limit: 100,
            cursor: None,
            target_snapshot_revision: None,
        })
        .expect("first page should succeed");
    let next_path = "/Wiki/100.md";
    let etag = store
        .read_node(next_path)
        .expect("read should succeed")
        .expect("node should exist")
        .etag;
    write_node(&store, next_path, "newer content", Some(&etag), 200);

    let error = store
        .fetch_updates(FetchUpdatesRequest {
            known_snapshot_revision: base.snapshot_revision,
            prefix: Some("/Wiki".to_string()),
            limit: 100,
            cursor: first.next_cursor,
            target_snapshot_revision: Some(first.snapshot_revision),
        })
        .expect_err("changed path after target should fail");
    assert_eq!(
        error,
        "target_snapshot_revision is no longer current for changed path"
    );
}

#[test]
fn fetch_updates_allows_returned_path_to_change_after_page_boundary() {
    let (_dir, store) = new_store();
    let base = store
        .export_snapshot(ExportSnapshotRequest {
            prefix: Some("/Wiki".to_string()),
            limit: 100,
            cursor: None,
            snapshot_revision: None,
            snapshot_session_id: None,
        })
        .expect("base snapshot should succeed");
    for index in 0..101 {
        write_node(
            &store,
            &format!("/Wiki/{index:03}.md"),
            "content",
            None,
            index,
        );
    }

    let first = store
        .fetch_updates(FetchUpdatesRequest {
            known_snapshot_revision: base.snapshot_revision.clone(),
            prefix: Some("/Wiki".to_string()),
            limit: 100,
            cursor: None,
            target_snapshot_revision: None,
        })
        .expect("first page should succeed");
    let first_path = "/Wiki/000.md";
    let first_etag = store
        .read_node(first_path)
        .expect("read should succeed")
        .expect("node should exist")
        .etag;
    write_node(&store, first_path, "newer content", Some(&first_etag), 200);

    let second = store
        .fetch_updates(FetchUpdatesRequest {
            known_snapshot_revision: base.snapshot_revision,
            prefix: Some("/Wiki".to_string()),
            limit: 100,
            cursor: first.next_cursor,
            target_snapshot_revision: Some(first.snapshot_revision),
        })
        .expect("second page should still succeed");
    assert_eq!(second.changed_nodes.len(), 1);
    assert_eq!(second.changed_nodes[0].path, "/Wiki/100.md");
    assert_eq!(second.next_cursor, None);
}

#[test]
fn sync_paging_rejects_invalid_limit_and_target_revision() {
    let (_dir, store) = new_store();
    write_node(&store, "/Wiki/alpha.md", "alpha", None, 10);
    let base = store
        .export_snapshot(ExportSnapshotRequest {
            prefix: Some("/Wiki".to_string()),
            limit: 100,
            cursor: None,
            snapshot_revision: None,
            snapshot_session_id: None,
        })
        .expect("base snapshot should succeed");

    let error = store
        .export_snapshot(ExportSnapshotRequest {
            prefix: Some("/Wiki".to_string()),
            limit: 0,
            cursor: None,
            snapshot_revision: None,
            snapshot_session_id: None,
        })
        .expect_err("zero limit should fail");
    assert_eq!(error, "limit must be between 1 and 100");

    let error = store
        .fetch_updates(FetchUpdatesRequest {
            known_snapshot_revision: base.snapshot_revision,
            prefix: Some("/Wiki".to_string()),
            limit: 101,
            cursor: None,
            target_snapshot_revision: None,
        })
        .expect_err("oversize limit should fail");
    assert_eq!(error, "limit must be between 1 and 100");

    let error = store
        .fetch_updates(FetchUpdatesRequest {
            known_snapshot_revision: "v5:1:2f57696b69".to_string(),
            prefix: Some("/Wiki".to_string()),
            limit: 100,
            cursor: None,
            target_snapshot_revision: Some("v5:1:2f4f74686572".to_string()),
        })
        .expect_err("target prefix mismatch should fail");
    assert_eq!(
        error,
        "target_snapshot_revision prefix does not match request prefix"
    );
}

#[test]
fn fetch_updates_requires_target_snapshot_revision_when_cursor_is_set() {
    let (_dir, store) = new_store();
    let base = store
        .export_snapshot(ExportSnapshotRequest {
            prefix: Some("/Wiki".to_string()),
            limit: 100,
            cursor: None,
            snapshot_revision: None,
            snapshot_session_id: None,
        })
        .expect("base snapshot should succeed");
    for index in 0..101 {
        write_node(
            &store,
            &format!("/Wiki/{index:03}.md"),
            "content",
            None,
            index,
        );
    }
    let first = store
        .fetch_updates(FetchUpdatesRequest {
            known_snapshot_revision: base.snapshot_revision,
            prefix: Some("/Wiki".to_string()),
            limit: 100,
            cursor: None,
            target_snapshot_revision: None,
        })
        .expect("first page should succeed");

    let error = store
        .fetch_updates(FetchUpdatesRequest {
            known_snapshot_revision: "v5:0:2f57696b69".to_string(),
            prefix: Some("/Wiki".to_string()),
            limit: 100,
            cursor: first.next_cursor,
            target_snapshot_revision: None,
        })
        .expect_err("paged fetch without target should fail");
    assert_eq!(
        error,
        "target_snapshot_revision is required when cursor is set"
    );
}

#[test]
fn fetch_updates_rejects_cursor_without_target_even_when_snapshot_is_current() {
    let (_dir, store) = new_store();
    write_node(&store, "/Wiki/live.md", "live", None, 10);
    let base = store
        .export_snapshot(ExportSnapshotRequest {
            prefix: Some("/Wiki".to_string()),
            limit: 100,
            cursor: None,
            snapshot_revision: None,
            snapshot_session_id: None,
        })
        .expect("base snapshot should succeed");

    let error = store
        .fetch_updates(FetchUpdatesRequest {
            known_snapshot_revision: base.snapshot_revision,
            prefix: Some("/Wiki".to_string()),
            limit: 100,
            cursor: Some("/Wiki/live.md".to_string()),
            target_snapshot_revision: None,
        })
        .expect_err("cursor without target should fail before noop return");
    assert_eq!(
        error,
        "target_snapshot_revision is required when cursor is set"
    );
}
