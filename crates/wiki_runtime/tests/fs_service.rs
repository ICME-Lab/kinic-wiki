use tempfile::tempdir;
use wiki_runtime::WikiService;
use wiki_types::{
    ExportSnapshotRequest, FetchUpdatesRequest, ListNodesRequest, NodeEntryKind, NodeKind,
    SearchNodesRequest, WriteNodeRequest,
};

fn new_service() -> WikiService {
    let dir = tempdir().expect("temp dir should exist");
    let db_path = dir.keep().join("wiki.sqlite3");
    let service = WikiService::new(db_path);
    service.run_fs_migrations().expect("fs migrations should succeed");
    service
}

#[test]
fn fs_service_delegates_to_fs_store() {
    let service = new_service();
    let initial = service.status().expect("status should succeed");
    assert_eq!(initial.file_count, 0);
    assert_eq!(initial.source_count, 0);
    assert_eq!(initial.deleted_count, 0);

    let write = service
        .write_node(
            WriteNodeRequest {
                path: "/Wiki/alpha.md".to_string(),
                kind: NodeKind::File,
                content: "alpha body".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            10,
        )
        .expect("write should succeed");
    assert_eq!(
        service
            .read_node("/Wiki/alpha.md")
            .expect("read should succeed")
            .expect("node should exist")
            .etag,
        write.node.etag
    );

    service
        .write_node(
            WriteNodeRequest {
                path: "/Wiki/nested/beta.md".to_string(),
                kind: NodeKind::File,
                content: "nested body".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            11,
        )
        .expect("nested write should succeed");

    let entries = service
        .list_nodes(ListNodesRequest {
            prefix: "/Wiki".to_string(),
            recursive: false,
            include_deleted: false,
        })
        .expect("list should succeed");
    assert!(entries.iter().any(|entry| entry.path == "/Wiki/alpha.md"));
    assert!(
        entries
            .iter()
            .any(|entry| entry.path == "/Wiki/nested" && entry.kind == NodeEntryKind::Directory)
    );

    let hits = service
        .search_nodes(SearchNodesRequest {
            query_text: "nested".to_string(),
            prefix: Some("/Wiki".to_string()),
            top_k: 5,
        })
        .expect("search should succeed");
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].path, "/Wiki/nested/beta.md");

    let snapshot = service
        .export_fs_snapshot(ExportSnapshotRequest {
            prefix: Some("/Wiki".to_string()),
            include_deleted: false,
        })
        .expect("snapshot should succeed");
    let updates = service
        .fetch_fs_updates(FetchUpdatesRequest {
            known_snapshot_revision: snapshot.snapshot_revision,
            prefix: Some("/Wiki".to_string()),
            include_deleted: false,
        })
        .expect("updates should succeed");
    assert!(updates.changed_nodes.is_empty());
    assert!(updates.removed_paths.is_empty());

    let status = service.status().expect("status should succeed");
    assert_eq!(status.file_count, 2);
    assert_eq!(status.source_count, 0);
    assert_eq!(status.deleted_count, 0);
}
