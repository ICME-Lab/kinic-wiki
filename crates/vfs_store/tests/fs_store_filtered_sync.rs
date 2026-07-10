// Where: crates/vfs_store filtered sync integration tests.
// What: verifies access-filtered snapshot and delta pagination.
// Why: client-visible cursors must never expose paths rejected by the access predicate.

use tempfile::tempdir;
use vfs_store::FsStore;
use vfs_types::{
    DeleteNodeRequest, ExportSnapshotRequest, FetchUpdatesRequest, MkdirNodeRequest, NodeKind,
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
    ensure_parent_folders(store, path, now - 1);
    store
        .write_node(
            WriteNodeRequest {
                database_id: "default".to_string(),
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

#[test]
fn export_snapshot_filtered_only_returns_allowed_cursors() {
    let (_dir, store) = new_store();
    for index in 0..25 {
        write_node(
            &store,
            &format!("/Knowledge/aa-denied-{index:03}.md"),
            "denied",
            None,
            index,
        );
    }
    write_node(&store, "/Knowledge/zz-allowed-a.md", "allowed", None, 100);
    write_node(&store, "/Knowledge/zz-allowed-b.md", "allowed", None, 101);

    let first = store
        .export_snapshot_filtered(
            ExportSnapshotRequest {
                database_id: "default".to_string(),
                prefix: Some("/Knowledge".to_string()),
                limit: 1,
                cursor: None,
                snapshot_revision: None,
                snapshot_session_id: None,
            },
            |path| path.starts_with("/Knowledge/zz-allowed-"),
        )
        .expect("first filtered snapshot page should load");

    assert_eq!(first.nodes.len(), 1);
    assert_eq!(first.nodes[0].path, "/Knowledge/zz-allowed-a.md");
    assert_eq!(first.next_cursor, Some(first.nodes[0].path.clone()));
    assert!(
        !first
            .next_cursor
            .as_deref()
            .unwrap_or_default()
            .contains("denied")
    );

    let second = store
        .export_snapshot_filtered(
            ExportSnapshotRequest {
                database_id: "default".to_string(),
                prefix: Some("/Knowledge".to_string()),
                limit: 1,
                cursor: first.next_cursor,
                snapshot_revision: Some(first.snapshot_revision),
                snapshot_session_id: None,
            },
            |path| path.starts_with("/Knowledge/zz-allowed-"),
        )
        .expect("second filtered snapshot page should load");
    assert_eq!(second.nodes.len(), 1);
    assert_eq!(second.nodes[0].path, "/Knowledge/zz-allowed-b.md");
    assert_eq!(second.next_cursor, None);
}

#[test]
fn export_snapshot_filtered_returns_no_cursor_when_every_path_is_denied() {
    let (_dir, store) = new_store();
    write_node(&store, "/Knowledge/private/secret.md", "secret", None, 10);

    let page = store
        .export_snapshot_filtered(
            ExportSnapshotRequest {
                database_id: "default".to_string(),
                prefix: Some("/Knowledge".to_string()),
                limit: 1,
                cursor: None,
                snapshot_revision: None,
                snapshot_session_id: None,
            },
            |_| false,
        )
        .expect("denied-only snapshot should load");

    assert!(page.nodes.is_empty());
    assert_eq!(page.next_cursor, None);
}

#[test]
fn export_snapshot_filtered_ignores_denied_changes_between_allowed_pages() {
    let (_dir, store) = new_store();
    let denied_etag = write_node(&store, "/Knowledge/aa-denied.md", "denied", None, 10);
    write_node(&store, "/Knowledge/zz-allowed-a.md", "allowed", None, 11);
    write_node(&store, "/Knowledge/zz-allowed-b.md", "allowed", None, 12);

    let first = store
        .export_snapshot_filtered(
            ExportSnapshotRequest {
                database_id: "default".to_string(),
                prefix: Some("/Knowledge".to_string()),
                limit: 1,
                cursor: None,
                snapshot_revision: None,
                snapshot_session_id: None,
            },
            |path| path.starts_with("/Knowledge/zz-allowed-"),
        )
        .expect("first filtered snapshot page should load");
    write_node(
        &store,
        "/Knowledge/aa-denied.md",
        "denied update",
        Some(&denied_etag),
        20,
    );

    let second = store
        .export_snapshot_filtered(
            ExportSnapshotRequest {
                database_id: "default".to_string(),
                prefix: Some("/Knowledge".to_string()),
                limit: 1,
                cursor: first.next_cursor,
                snapshot_revision: Some(first.snapshot_revision),
                snapshot_session_id: None,
            },
            |path| path.starts_with("/Knowledge/zz-allowed-"),
        )
        .expect("denied change should not invalidate filtered snapshot");
    assert_eq!(second.nodes[0].path, "/Knowledge/zz-allowed-b.md");
}

#[test]
fn export_snapshot_filtered_rejects_allowed_update_between_pages() {
    let (_dir, store) = new_store();
    write_node(&store, "/Knowledge/allowed-a.md", "allowed", None, 10);
    let second_etag = write_node(&store, "/Knowledge/allowed-b.md", "allowed", None, 11);
    let first = store
        .export_snapshot_filtered(
            ExportSnapshotRequest {
                database_id: "default".to_string(),
                prefix: Some("/Knowledge".to_string()),
                limit: 1,
                cursor: None,
                snapshot_revision: None,
                snapshot_session_id: None,
            },
            |path| path.ends_with("allowed-a.md") || path.ends_with("allowed-b.md"),
        )
        .expect("first filtered snapshot page should load");
    write_node(
        &store,
        "/Knowledge/allowed-b.md",
        "allowed update",
        Some(&second_etag),
        20,
    );

    let error = store
        .export_snapshot_filtered(
            ExportSnapshotRequest {
                database_id: "default".to_string(),
                prefix: Some("/Knowledge".to_string()),
                limit: 1,
                cursor: first.next_cursor,
                snapshot_revision: Some(first.snapshot_revision),
                snapshot_session_id: None,
            },
            |path| path.ends_with("allowed-a.md") || path.ends_with("allowed-b.md"),
        )
        .expect_err("allowed update should invalidate filtered snapshot");
    assert_eq!(error, "snapshot_revision is no longer current");
}

#[test]
fn export_snapshot_filtered_rejects_allowed_delete_between_pages() {
    let (_dir, store) = new_store();
    write_node(&store, "/Knowledge/allowed-a.md", "allowed", None, 10);
    let second_etag = write_node(&store, "/Knowledge/allowed-b.md", "allowed", None, 11);
    let first = store
        .export_snapshot_filtered(
            ExportSnapshotRequest {
                database_id: "default".to_string(),
                prefix: Some("/Knowledge".to_string()),
                limit: 1,
                cursor: None,
                snapshot_revision: None,
                snapshot_session_id: None,
            },
            |path| path.ends_with("allowed-a.md") || path.ends_with("allowed-b.md"),
        )
        .expect("first filtered snapshot page should load");
    store
        .delete_node(
            DeleteNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/allowed-b.md".to_string(),
                expected_etag: Some(second_etag),
                expected_folder_index_etag: None,
            },
            20,
        )
        .expect("allowed node should delete");

    let error = store
        .export_snapshot_filtered(
            ExportSnapshotRequest {
                database_id: "default".to_string(),
                prefix: Some("/Knowledge".to_string()),
                limit: 1,
                cursor: first.next_cursor,
                snapshot_revision: Some(first.snapshot_revision),
                snapshot_session_id: None,
            },
            |path| path.ends_with("allowed-a.md") || path.ends_with("allowed-b.md"),
        )
        .expect_err("allowed delete should invalidate filtered snapshot");
    assert_eq!(error, "snapshot_revision is no longer current");
}

#[test]
fn fetch_updates_filtered_only_returns_allowed_cursors() {
    let (_dir, store) = new_store();
    let removed_etag = write_node(&store, "/Knowledge/zz-removed.md", "base", None, 0);
    let base = store
        .export_snapshot(ExportSnapshotRequest {
            database_id: "default".to_string(),
            prefix: Some("/Knowledge".to_string()),
            limit: 100,
            cursor: None,
            snapshot_revision: None,
            snapshot_session_id: None,
        })
        .expect("base snapshot should load");
    for index in 0..25 {
        write_node(
            &store,
            &format!("/Knowledge/aa-denied-{index:03}.md"),
            "denied",
            None,
            index + 1,
        );
    }
    write_node(&store, "/Knowledge/zz-allowed.md", "allowed", None, 100);
    store
        .delete_node(
            DeleteNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/zz-removed.md".to_string(),
                expected_etag: Some(removed_etag),
                expected_folder_index_etag: None,
            },
            101,
        )
        .expect("allowed removal should delete");

    let first = store
        .fetch_updates_filtered(
            FetchUpdatesRequest {
                database_id: "default".to_string(),
                known_snapshot_revision: base.snapshot_revision.clone(),
                prefix: Some("/Knowledge".to_string()),
                limit: 1,
                cursor: None,
                target_snapshot_revision: None,
            },
            |path| path.starts_with("/Knowledge/zz-"),
        )
        .expect("first filtered updates page should load");
    assert_eq!(first.changed_nodes[0].path, "/Knowledge/zz-allowed.md");
    assert_eq!(first.next_cursor, Some(first.changed_nodes[0].path.clone()));
    assert!(
        !first
            .next_cursor
            .as_deref()
            .unwrap_or_default()
            .contains("denied")
    );

    let second = store
        .fetch_updates_filtered(
            FetchUpdatesRequest {
                database_id: "default".to_string(),
                known_snapshot_revision: base.snapshot_revision,
                prefix: Some("/Knowledge".to_string()),
                limit: 1,
                cursor: first.next_cursor,
                target_snapshot_revision: Some(first.snapshot_revision),
            },
            |path| path.starts_with("/Knowledge/zz-"),
        )
        .expect("second filtered updates page should load");
    assert!(second.changed_nodes.is_empty());
    assert_eq!(second.removed_paths, vec!["/Knowledge/zz-removed.md"]);
    assert_eq!(second.next_cursor, None);
}

#[test]
fn fetch_updates_filtered_returns_no_cursor_when_every_change_is_denied() {
    let (_dir, store) = new_store();
    write_node(&store, "/Knowledge/base.md", "base", None, 0);
    let base = store
        .export_snapshot(ExportSnapshotRequest {
            database_id: "default".to_string(),
            prefix: Some("/Knowledge".to_string()),
            limit: 100,
            cursor: None,
            snapshot_revision: None,
            snapshot_session_id: None,
        })
        .expect("base snapshot should load");
    write_node(&store, "/Knowledge/private/secret.md", "secret", None, 10);

    let page = store
        .fetch_updates_filtered(
            FetchUpdatesRequest {
                database_id: "default".to_string(),
                known_snapshot_revision: base.snapshot_revision,
                prefix: Some("/Knowledge".to_string()),
                limit: 1,
                cursor: None,
                target_snapshot_revision: None,
            },
            |_| false,
        )
        .expect("denied-only updates should load");
    assert!(page.changed_nodes.is_empty());
    assert!(page.removed_paths.is_empty());
    assert_eq!(page.next_cursor, None);
}
