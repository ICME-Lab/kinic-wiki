use tempfile::tempdir;
use wiki_runtime::WikiService;
use wiki_types::{
    AppendNodeRequest, EditNodeRequest, ExportSnapshotRequest, FetchUpdatesRequest, GlobNodeType,
    GlobNodesRequest, ListNodesRequest, MkdirNodeRequest, MoveNodeRequest, MultiEdit,
    MultiEditNodeRequest, NodeEntryKind, NodeKind, RecentNodesRequest, SearchNodePathsRequest,
    SearchNodesRequest, SearchPreviewMode, WriteNodeRequest,
};

fn new_service() -> WikiService {
    let dir = tempdir().expect("temp dir should exist");
    let db_path = dir.keep().join("wiki.sqlite3");
    let service = WikiService::new(db_path);
    service
        .run_fs_migrations()
        .expect("fs migrations should succeed");
    service
}

#[test]
fn fs_service_delegates_to_fs_store() {
    let service = new_service();
    let initial = service.status().expect("status should succeed");
    assert_eq!(initial.file_count, 0);
    assert_eq!(initial.source_count, 0);

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
                content: "beta body".to_string(),
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
        })
        .expect("list should succeed");
    assert!(entries.iter().any(|entry| entry.path == "/Wiki/alpha.md"));
    assert!(
        entries
            .iter()
            .any(|entry| entry.path == "/Wiki/nested" && entry.kind == NodeEntryKind::Directory)
    );

    // No token in file bodies or paths matches this; distinguishes FTS/path search from path-only search below.
    let hits = service
        .search_nodes(SearchNodesRequest {
            query_text: "zzz_no_match_token".to_string(),
            prefix: Some("/Wiki".to_string()),
            top_k: 5,
            preview_mode: Some(SearchPreviewMode::None),
        })
        .expect("search should succeed");
    assert!(hits.is_empty());

    let path_hits = service
        .search_node_paths(SearchNodePathsRequest {
            query_text: "NeStEd".to_string(),
            prefix: Some("/Wiki".to_string()),
            top_k: 5,
        })
        .expect("path search should succeed");
    assert_eq!(path_hits.len(), 1);
    assert_eq!(path_hits[0].path, "/Wiki/nested/beta.md");

    let snapshot = service
        .export_fs_snapshot(ExportSnapshotRequest {
            prefix: Some("/Wiki".to_string()),
            limit: 100,
            cursor: None,
            snapshot_revision: None,
            snapshot_session_id: None,
        })
        .expect("snapshot should succeed");
    let updates = service
        .fetch_fs_updates(FetchUpdatesRequest {
            known_snapshot_revision: snapshot.snapshot_revision,
            prefix: Some("/Wiki".to_string()),
            limit: 100,
            cursor: None,
            target_snapshot_revision: None,
        })
        .expect("updates should succeed");
    assert!(updates.changed_nodes.is_empty());
    assert!(updates.removed_paths.is_empty());

    let status = service.status().expect("status should succeed");
    assert_eq!(status.file_count, 2);
    assert_eq!(status.source_count, 0);
}

#[test]
fn fs_service_exposes_minimal_vfs_methods() {
    let service = new_service();

    let mkdir = service
        .mkdir_node(MkdirNodeRequest {
            path: "/Wiki/work".to_string(),
        })
        .expect("mkdir should succeed");
    assert!(mkdir.created);

    let appended = service
        .append_node(
            AppendNodeRequest {
                path: "/Wiki/work/log.md".to_string(),
                content: "alpha".to_string(),
                expected_etag: None,
                separator: None,
                metadata_json: None,
                kind: None,
            },
            20,
        )
        .expect("append create should succeed");
    let edited = service
        .edit_node(
            EditNodeRequest {
                path: "/Wiki/work/log.md".to_string(),
                old_text: "alpha".to_string(),
                new_text: "beta".to_string(),
                expected_etag: Some(appended.node.etag),
                replace_all: false,
            },
            21,
        )
        .expect("edit should succeed");
    assert_eq!(edited.replacement_count, 1);
    assert_eq!(
        service
            .read_node("/Wiki/work/log.md")
            .expect("read should succeed")
            .expect("node should exist")
            .content,
        "beta"
    );
}

#[test]
fn fs_service_exposes_extended_vfs_methods() {
    let service = new_service();
    let base = service
        .write_node(
            WriteNodeRequest {
                path: "/Wiki/a.md".to_string(),
                kind: NodeKind::File,
                content: "before alpha".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            30,
        )
        .expect("write should succeed");

    let moved = service
        .move_node(
            MoveNodeRequest {
                from_path: "/Wiki/a.md".to_string(),
                to_path: "/Wiki/nested/b.md".to_string(),
                expected_etag: Some(base.node.etag.clone()),
                overwrite: false,
            },
            31,
        )
        .expect("move should succeed");
    assert_eq!(moved.node.path, "/Wiki/nested/b.md");

    let globbed = service
        .glob_nodes(GlobNodesRequest {
            pattern: "**/*.md".to_string(),
            path: Some("/Wiki".to_string()),
            node_type: Some(GlobNodeType::File),
        })
        .expect("glob should succeed");
    assert_eq!(globbed.len(), 1);

    let recent = service
        .recent_nodes(RecentNodesRequest {
            limit: 5,
            path: Some("/Wiki".to_string()),
        })
        .expect("recent should succeed");
    assert_eq!(recent[0].path, "/Wiki/nested/b.md");

    let multi_edited = service
        .multi_edit_node(
            MultiEditNodeRequest {
                path: "/Wiki/nested/b.md".to_string(),
                edits: vec![
                    MultiEdit {
                        old_text: "before".to_string(),
                        new_text: "after".to_string(),
                    },
                    MultiEdit {
                        old_text: "alpha".to_string(),
                        new_text: "beta".to_string(),
                    },
                ],
                expected_etag: Some(moved.node.etag),
            },
            32,
        )
        .expect("multi edit should succeed");
    assert_eq!(multi_edited.replacement_count, 2);
    assert_eq!(
        service
            .read_node("/Wiki/nested/b.md")
            .expect("read should succeed")
            .expect("node should exist")
            .content,
        "after beta"
    );
}

#[test]
fn fs_service_rejects_noncanonical_source_move_target() {
    let service = new_service();
    let created = service
        .write_node(
            WriteNodeRequest {
                path: "/Sources/raw/source/source.md".to_string(),
                kind: NodeKind::Source,
                content: "alpha".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            40,
        )
        .expect("write should succeed");

    let error = service
        .move_node(
            MoveNodeRequest {
                from_path: "/Sources/raw/source/source.md".to_string(),
                to_path: "/Sources/raw/renamed/wrong.md".to_string(),
                expected_etag: Some(created.node.etag),
                overwrite: false,
            },
            41,
        )
        .expect_err("move should fail");

    assert!(error.contains("source path must"));
}
