use tempfile::tempdir;
use wiki_store::FsStore;
use wiki_types::{
    DeleteNodeRequest, ExportSnapshotRequest, FetchUpdatesRequest, NodeKind, WriteNodeRequest,
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
            include_deleted: false,
        })
        .expect("first snapshot should succeed");
    let second = store
        .export_snapshot(ExportSnapshotRequest {
            prefix: Some("/Wiki".to_string()),
            include_deleted: false,
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
            include_deleted: false,
        })
        .expect("snapshot should succeed");

    let updates = store
        .fetch_updates(FetchUpdatesRequest {
            known_snapshot_revision: snapshot.snapshot_revision.clone(),
            prefix: Some("/Wiki".to_string()),
            include_deleted: false,
        })
        .expect("updates should succeed");
    assert_eq!(updates.snapshot_revision, snapshot.snapshot_revision);
    assert!(updates.changed_nodes.is_empty());
    assert!(updates.removed_paths.is_empty());
}

#[test]
fn fetch_updates_reports_tombstones_with_include_deleted() {
    let (_dir, store) = new_store();
    let alpha = write_node(&store, "/Wiki/alpha.md", "alpha", None, 10);
    let beta = write_node(&store, "/Wiki/beta.md", "beta", None, 11);
    let base = store
        .export_snapshot(ExportSnapshotRequest {
            prefix: Some("/Wiki".to_string()),
            include_deleted: false,
        })
        .expect("base snapshot should succeed");

    write_node(&store, "/Wiki/alpha.md", "alpha updated", Some(&alpha), 12);
    store
        .delete_node(
            DeleteNodeRequest {
                path: "/Wiki/beta.md".to_string(),
                expected_etag: Some(beta),
            },
            13,
        )
        .expect("delete should succeed");

    let without_deleted = store
        .fetch_updates(FetchUpdatesRequest {
            known_snapshot_revision: base.snapshot_revision.clone(),
            prefix: Some("/Wiki".to_string()),
            include_deleted: false,
        })
        .expect("updates should succeed");
    assert_eq!(without_deleted.changed_nodes.len(), 1);
    assert_eq!(without_deleted.changed_nodes[0].path, "/Wiki/alpha.md");
    assert_eq!(
        without_deleted.removed_paths,
        vec!["/Wiki/beta.md".to_string()]
    );

    let with_deleted = store
        .fetch_updates(FetchUpdatesRequest {
            known_snapshot_revision: base.snapshot_revision,
            prefix: Some("/Wiki".to_string()),
            include_deleted: true,
        })
        .expect("updates with deleted should succeed");
    assert_eq!(with_deleted.changed_nodes.len(), 2);
    assert!(
        with_deleted
            .changed_nodes
            .iter()
            .any(|node| node.path == "/Wiki/beta.md" && node.deleted_at == Some(13))
    );
    assert_eq!(
        with_deleted.removed_paths,
        vec!["/Wiki/beta.md".to_string()]
    );
}

#[test]
fn fetch_updates_returns_only_changed_nodes_since_known_snapshot() {
    let (_dir, store) = new_store();
    let alpha = write_node(&store, "/Wiki/alpha.md", "alpha", None, 10);
    let beta = write_node(&store, "/Wiki/beta.md", "beta", None, 11);
    let base = store
        .export_snapshot(ExportSnapshotRequest {
            prefix: Some("/Wiki".to_string()),
            include_deleted: false,
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
            include_deleted: false,
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
fn fetch_updates_full_refreshes_for_unknown_snapshot_revision() {
    let (_dir, store) = new_store();
    write_node(&store, "/Wiki/alpha.md", "alpha", None, 10);
    write_node(&store, "/Wiki/beta.md", "beta", None, 11);

    let updates = store
        .fetch_updates(FetchUpdatesRequest {
            known_snapshot_revision: "unknown".to_string(),
            prefix: Some("/Wiki".to_string()),
            include_deleted: false,
        })
        .expect("unknown snapshot should full refresh");
    assert_eq!(updates.changed_nodes.len(), 2);
    assert!(updates.changed_nodes.iter().any(|node| node.path == "/Wiki/alpha.md"));
    assert!(updates.changed_nodes.iter().any(|node| node.path == "/Wiki/beta.md"));
    assert!(updates.removed_paths.is_empty());
}
