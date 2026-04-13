// Where: crates/wiki_canister/src/tests_sync_contract.rs
// What: Additional entry-point tests for search/sync behavior and Candid contract integrity.
// Why: The VFS validation phase needs API-boundary coverage for behavior and interface drift.
use tempfile::tempdir;
use wiki_runtime::WikiService;
use wiki_types::{
    DeleteNodeRequest, ExportSnapshotRequest, FetchUpdatesRequest, NodeKind,
    SearchNodePathsRequest, SearchNodesRequest, WriteNodeRequest,
};

use super::{
    SERVICE, delete_node, export_snapshot, fetch_updates, search_node_paths, search_nodes,
    write_node,
};

fn install_test_service() {
    let dir = tempdir().expect("tempdir should create");
    let db_path = dir.keep().join("wiki.sqlite3");
    let service = WikiService::new(db_path);
    service
        .run_fs_migrations()
        .expect("fs migrations should run");
    SERVICE.with(|slot| *slot.borrow_mut() = Some(service));
}

#[test]
fn canister_search_respects_prefix_and_hides_deleted_nodes() {
    install_test_service();

    let alpha = write_node(WriteNodeRequest {
        path: "/Wiki/project-alpha/one.md".to_string(),
        kind: NodeKind::File,
        content: "alpha shared term".to_string(),
        metadata_json: "{}".to_string(),
        expected_etag: None,
    })
    .expect("alpha write should succeed");
    write_node(WriteNodeRequest {
        path: "/Wiki/project-beta/two.md".to_string(),
        kind: NodeKind::File,
        content: "beta shared term".to_string(),
        metadata_json: "{}".to_string(),
        expected_etag: None,
    })
    .expect("beta write should succeed");

    delete_node(DeleteNodeRequest {
        path: "/Wiki/project-alpha/one.md".to_string(),
        expected_etag: Some(alpha.node.etag),
    })
    .expect("delete should succeed");

    let hits = search_nodes(SearchNodesRequest {
        query_text: "shared".to_string(),
        prefix: Some("/Wiki/project-alpha".to_string()),
        top_k: 10,
    })
    .expect("search should succeed");
    assert!(hits.is_empty());

    let beta_hits = search_nodes(SearchNodesRequest {
        query_text: "shared".to_string(),
        prefix: Some("/Wiki/project-beta".to_string()),
        top_k: 10,
    })
    .expect("search should succeed");
    assert_eq!(beta_hits.len(), 1);
    assert_eq!(beta_hits[0].path, "/Wiki/project-beta/two.md");

    let path_hits = search_node_paths(SearchNodePathsRequest {
        query_text: "PROJECT-beta".to_string(),
        prefix: Some("/Wiki".to_string()),
        top_k: 10,
    })
    .expect("path search should succeed");
    assert_eq!(path_hits.len(), 1);
    assert_eq!(path_hits[0].path, "/Wiki/project-beta/two.md");
}

#[test]
fn canister_fetch_updates_reports_removed_paths_after_delete() {
    install_test_service();

    let created = write_node(WriteNodeRequest {
        path: "/Wiki/scope/item.md".to_string(),
        kind: NodeKind::File,
        content: "scope body".to_string(),
        metadata_json: "{}".to_string(),
        expected_etag: None,
    })
    .expect("write should succeed");

    let snapshot = export_snapshot(ExportSnapshotRequest {
        prefix: Some("/Wiki/scope".to_string()),
    })
    .expect("snapshot should succeed");

    delete_node(DeleteNodeRequest {
        path: "/Wiki/scope/item.md".to_string(),
        expected_etag: Some(created.node.etag),
    })
    .expect("delete should succeed");

    let updates = fetch_updates(FetchUpdatesRequest {
        known_snapshot_revision: snapshot.snapshot_revision,
        prefix: Some("/Wiki/scope".to_string()),
    })
    .expect("updates should succeed");
    assert!(updates.changed_nodes.is_empty());
    assert_eq!(
        updates.removed_paths,
        vec!["/Wiki/scope/item.md".to_string()]
    );
}

#[test]
fn canister_fetch_updates_rejects_prefix_scope_changes() {
    install_test_service();

    write_node(WriteNodeRequest {
        path: "/Wiki/a/one.md".to_string(),
        kind: NodeKind::File,
        content: "alpha".to_string(),
        metadata_json: "{}".to_string(),
        expected_etag: None,
    })
    .expect("write should succeed");
    write_node(WriteNodeRequest {
        path: "/Wiki/b/two.md".to_string(),
        kind: NodeKind::File,
        content: "beta".to_string(),
        metadata_json: "{}".to_string(),
        expected_etag: None,
    })
    .expect("write should succeed");

    let narrow = export_snapshot(ExportSnapshotRequest {
        prefix: Some("/Wiki/a".to_string()),
    })
    .expect("snapshot should succeed");
    let widened = fetch_updates(FetchUpdatesRequest {
        known_snapshot_revision: narrow.snapshot_revision,
        prefix: Some("/Wiki".to_string()),
    });
    assert_eq!(
        widened.expect_err("prefix scope change should fail"),
        "known_snapshot_revision prefix does not match request prefix"
    );
}

#[test]
fn canister_fetch_updates_returns_delta_from_old_retained_revision() {
    install_test_service();

    write_node(WriteNodeRequest {
        path: "/Wiki/base.md".to_string(),
        kind: NodeKind::File,
        content: "base".to_string(),
        metadata_json: "{}".to_string(),
        expected_etag: None,
    })
    .expect("base write should succeed");
    write_node(WriteNodeRequest {
        path: "/Wiki/unchanged.md".to_string(),
        kind: NodeKind::File,
        content: "unchanged".to_string(),
        metadata_json: "{}".to_string(),
        expected_etag: None,
    })
    .expect("unchanged write should succeed");

    let base = export_snapshot(ExportSnapshotRequest {
        prefix: Some("/Wiki".to_string()),
    })
    .expect("snapshot should succeed");

    for index in 0..300 {
        write_node(WriteNodeRequest {
            path: format!("/Wiki/history-{index}.md"),
            kind: NodeKind::File,
            content: format!("revision {index}"),
            metadata_json: "{}".to_string(),
            expected_etag: None,
        })
        .expect("history write should succeed");
    }

    let updates = fetch_updates(FetchUpdatesRequest {
        known_snapshot_revision: base.snapshot_revision,
        prefix: Some("/Wiki".to_string()),
    })
    .expect("old snapshot delta should succeed");

    assert_eq!(updates.changed_nodes.len(), 300);
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
            .all(|node| node.path.starts_with("/Wiki/history-"))
    );
}

#[test]
fn exported_candid_matches_checked_in_wiki_did() {
    assert_eq!(
        super::candid_interface().trim_end(),
        include_str!("../wiki.did").trim_end()
    );
}

#[test]
fn mkdir_node_request_type_is_fixed_at_interface_boundary() {
    let generated = super::candid_interface();
    let checked_in = include_str!("../wiki.did");

    for did in [generated.as_str(), checked_in] {
        assert!(
            did.contains("type MkdirNodeRequest = record { path : text };"),
            "mkdir_node request type must stay nominal in the public interface",
        );
        assert!(
            did.contains("mkdir_node : (MkdirNodeRequest) -> (Result_7) query;"),
            "mkdir_node must consume MkdirNodeRequest at the interface boundary",
        );
        assert!(
            !did.contains("mkdir_node : (DeleteNodeResult) -> (Result_7) query;"),
            "mkdir_node must not collapse to DeleteNodeResult",
        );
    }
}
