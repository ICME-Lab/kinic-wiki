// Where: crates/wiki_canister/src/tests.rs
// What: Entry-point level tests for the FS-first canister surface.
// Why: Phase 3 replaces the public canister contract, so tests must assert the wrapper behavior directly.
use std::path::PathBuf;

use tempfile::tempdir;
use wiki_runtime::WikiService;
use wiki_types::{
    DeleteNodeRequest, ExportSnapshotRequest, FetchUpdatesRequest, ListNodesRequest,
    NodeEntryKind, NodeKind, SearchNodesRequest, WriteNodeRequest,
};

use super::{
    SERVICE, delete_node, export_snapshot, fetch_updates, list_nodes, read_node, search_nodes,
    status, write_node,
};

fn install_test_service() {
    let dir = tempdir().expect("tempdir should create");
    let db_path = PathBuf::from(dir.keep()).join("wiki.sqlite3");
    let service = WikiService::new(db_path);
    service.run_fs_migrations().expect("fs migrations should run");
    SERVICE.with(|slot| *slot.borrow_mut() = Some(service));
}

#[test]
fn status_stays_available_after_fs_migrations() {
    install_test_service();

    let current = status();

    assert_eq!(current.file_count, 0);
    assert_eq!(current.source_count, 0);
    assert_eq!(current.deleted_count, 0);
}

#[test]
fn fs_entrypoints_cover_crud_search_and_sync() {
    install_test_service();

    let created = write_node(WriteNodeRequest {
        path: "/Wiki/foo.md".to_string(),
        kind: NodeKind::File,
        content: "# Foo\n\nalpha body".to_string(),
        metadata_json: "{}".to_string(),
        expected_etag: None,
    })
    .expect("write should succeed");
    assert!(created.created);

    write_node(WriteNodeRequest {
        path: "/Wiki/nested/bar.md".to_string(),
        kind: NodeKind::File,
        content: "# Bar\n\nbeta body".to_string(),
        metadata_json: "{}".to_string(),
        expected_etag: None,
    })
    .expect("nested write should succeed");

    let node = read_node("/Wiki/foo.md".to_string())
        .expect("read should succeed")
        .expect("node should exist");
    assert_eq!(node.kind, NodeKind::File);

    let stale_write = write_node(WriteNodeRequest {
        path: "/Wiki/foo.md".to_string(),
        kind: NodeKind::File,
        content: "# Foo\n\nrewrite".to_string(),
        metadata_json: "{}".to_string(),
        expected_etag: Some("stale".to_string()),
    });
    assert!(stale_write.is_err());

    let entries = list_nodes(ListNodesRequest {
        prefix: "/Wiki".to_string(),
        recursive: false,
        include_deleted: false,
    })
    .expect("list should succeed");
    assert!(entries.iter().any(|entry| {
        entry.path == "/Wiki/nested" && entry.kind == NodeEntryKind::Directory
    }));

    let hits = search_nodes(SearchNodesRequest {
        query_text: "alpha".to_string(),
        prefix: Some("/Wiki".to_string()),
        top_k: 5,
    })
    .expect("search should succeed");
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].path, "/Wiki/foo.md");

    let snapshot = export_snapshot(ExportSnapshotRequest {
        prefix: Some("/Wiki".to_string()),
        include_deleted: false,
    })
    .expect("snapshot should export");
    assert_eq!(snapshot.nodes.len(), 2);

    let empty_delta = fetch_updates(FetchUpdatesRequest {
        known_snapshot_revision: snapshot.snapshot_revision.clone(),
        prefix: Some("/Wiki".to_string()),
        include_deleted: false,
    })
    .expect("matching snapshot should produce empty delta");
    assert!(empty_delta.changed_nodes.is_empty());
    assert!(empty_delta.removed_paths.is_empty());

    let full_refresh = fetch_updates(FetchUpdatesRequest {
        known_snapshot_revision: "missing".to_string(),
        prefix: Some("/Wiki".to_string()),
        include_deleted: false,
    })
    .expect("unknown snapshot should full refresh");
    assert_eq!(full_refresh.changed_nodes.len(), 2);
    assert!(full_refresh.removed_paths.is_empty());
    assert!(
        full_refresh
            .changed_nodes
            .iter()
            .all(|entry| entry.path.starts_with("/Wiki"))
    );

    let deleted = delete_node(DeleteNodeRequest {
        path: "/Wiki/foo.md".to_string(),
        expected_etag: Some(created.node.etag.clone()),
    })
    .expect("delete should succeed");
    assert!(deleted.deleted_at > 0);

    let deleted_read = read_node("/Wiki/foo.md".to_string()).expect("read should succeed");
    assert!(deleted_read.is_none());

    let stale_delete = delete_node(DeleteNodeRequest {
        path: "/Wiki/nested/bar.md".to_string(),
        expected_etag: Some("stale".to_string()),
    });
    assert!(stale_delete.is_err());
}

#[test]
fn exported_candid_matches_checked_in_did() {
    let actual = super::candid_interface();
    let expected = include_str!("../wiki.did");

    assert_eq!(actual.trim(), expected.trim());
}
