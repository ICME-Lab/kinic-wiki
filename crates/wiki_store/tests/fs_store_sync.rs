use rusqlite::Connection;
use tempfile::tempdir;
use wiki_store::FsStore;
use wiki_types::{
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

#[test]
fn snapshot_revision_is_stable_for_same_state() {
    let (_dir, store) = new_store();
    write_node(&store, "/Wiki/alpha.md", "alpha", None, 10);
    write_node(&store, "/Wiki/beta.md", "beta", None, 11);

    let first = store
        .export_snapshot(ExportSnapshotRequest {
            prefix: Some("/Wiki".to_string()),
        })
        .expect("first snapshot should succeed");
    let second = store
        .export_snapshot(ExportSnapshotRequest {
            prefix: Some("/Wiki".to_string()),
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
        })
        .expect("snapshot should succeed");

    let updates = store
        .fetch_updates(FetchUpdatesRequest {
            known_snapshot_revision: snapshot.snapshot_revision.clone(),
            prefix: Some("/Wiki".to_string()),
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
        })
        .expect("base snapshot should succeed");

    for now in 12..=320 {
        let path = format!("/Wiki/history-{now}.md");
        let content = format!("revision {now}");
        write_node(&store, &path, &content, None, now);
    }

    let updates = store
        .fetch_updates(FetchUpdatesRequest {
            known_snapshot_revision: base.snapshot_revision,
            prefix: Some("/Wiki".to_string()),
        })
        .expect("updates should succeed");

    assert_eq!(updates.changed_nodes.len(), 309);
    assert!(updates.removed_paths.is_empty());
    assert!(
        !updates
            .changed_nodes
            .iter()
            .any(|node| node.path == "/Wiki/unchanged.md")
    );
    assert!(
        updates
            .changed_nodes
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
        })
        .expect("base snapshot should succeed");

    write_node(&store, "/Wiki/live.md", "live", None, 20);

    let updates = store
        .fetch_updates(FetchUpdatesRequest {
            known_snapshot_revision: base.snapshot_revision,
            prefix: Some("/Wiki".to_string()),
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
        })
        .expect("root snapshot should succeed");
    let nested_snapshot = store
        .export_snapshot(ExportSnapshotRequest {
            prefix: Some("/Wiki/nested".to_string()),
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
        })
        .expect("nested snapshot should succeed");
    let error = store
        .fetch_updates(FetchUpdatesRequest {
            known_snapshot_revision: nested_snapshot.snapshot_revision,
            prefix: Some("/Wiki".to_string()),
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
        })
        .expect("root snapshot should succeed");
    let error = store
        .fetch_updates(FetchUpdatesRequest {
            known_snapshot_revision: root_snapshot.snapshot_revision,
            prefix: Some("/Wiki/nested".to_string()),
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
        })
        .expect("snapshot should succeed");
    let error = store
        .fetch_updates(FetchUpdatesRequest {
            known_snapshot_revision: known.snapshot_revision,
            prefix: Some("/Wiki/archive".to_string()),
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
        })
        .expect("updates should succeed");

    assert_eq!(updates.changed_nodes.len(), 1);
    assert_eq!(updates.changed_nodes[0].path, "/Wiki/target.md");
    assert_eq!(updates.changed_nodes[0].content, "source");
    assert_eq!(updates.removed_paths, vec!["/Wiki/source.md".to_string()]);
}
