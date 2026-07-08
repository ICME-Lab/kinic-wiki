// Where: crates/vfs_canister/src/tests/fs_entrypoints.rs
// What: FS entrypoint-level tests for the canister wrapper.
// Why: Keep the canister test module under the file-size ratchet without changing coverage.
use super::*;

#[test]
fn memory_manifest_roots_are_readable() {
    install_test_service();
    let database_id = "default".to_string();
    let manifest = memory_manifest(MemoryManifestRequest {
        database_id: database_id.clone(),
    })
    .expect("store manifest should load");
    for root in manifest.roots {
        assert!(
            read_node(database_id.clone(), root.path)
                .expect("root should read")
                .is_some()
        );
    }
}

#[test]
fn fs_entrypoints_cover_crud_search_and_sync() {
    install_test_service();

    let created = write_node(WriteNodeRequest {
        database_id: "default".to_string(),
        path: "/Knowledge/foo.md".to_string(),
        kind: NodeKind::File,
        content: "# Foo\n\nalpha body".to_string(),
        metadata_json: "{}".to_string(),
        expected_etag: None,
    })
    .expect("write should succeed");
    assert!(created.created);

    ensure_parent_folders("/Knowledge/nested/bar.md");
    ensure_parent_folders("/Sources/source/source.md");
    write_node(WriteNodeRequest {
        database_id: "default".to_string(),
        path: "/Knowledge/nested/bar.md".to_string(),
        kind: NodeKind::File,
        content: "# Bar\n\nbeta body".to_string(),
        metadata_json: "{}".to_string(),
        expected_etag: None,
    })
    .expect("nested write should succeed");

    let node = read_node("default".to_string(), "/Knowledge/foo.md".to_string())
        .expect("read should succeed")
        .expect("node should exist");
    assert_eq!(node.kind, NodeKind::File);

    let stale_write = write_node(WriteNodeRequest {
        database_id: "default".to_string(),
        path: "/Knowledge/foo.md".to_string(),
        kind: NodeKind::File,
        content: "# Foo\n\nrewrite".to_string(),
        metadata_json: "{}".to_string(),
        expected_etag: Some("stale".to_string()),
    });
    assert!(stale_write.is_err());

    let entries = list_nodes(ListNodesRequest {
        database_id: "default".to_string(),
        prefix: "/Knowledge".to_string(),
        recursive: false,
        limit: 100,
    })
    .expect("list should succeed");
    assert!(
        entries.iter().any(|entry| {
            entry.path == "/Knowledge/nested" && entry.kind == NodeEntryKind::Folder
        })
    );

    let children = list_children(ListChildrenRequest {
        database_id: "default".to_string(),
        path: "/Knowledge".to_string(),
    })
    .expect("children should list");
    assert!(children.iter().any(|child| {
        child.path == "/Knowledge/nested"
            && child.kind == NodeEntryKind::Folder
            && !child.is_virtual
    }));
    assert!(children.iter().any(|child| {
        child.path == "/Knowledge/foo.md"
            && child.kind == NodeEntryKind::File
            && child.etag.as_deref() == Some(created.node.etag.as_str())
    }));

    let hits = search_nodes(SearchNodesRequest {
        database_id: "default".to_string(),
        query_text: "alpha".to_string(),
        prefix: Some("/Knowledge".to_string()),
        top_k: 5,
        preview_mode: Some(SearchPreviewMode::None),
    })
    .expect("search should succeed");
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].path, "/Knowledge/foo.md");

    let path_hits = search_node_paths(SearchNodePathsRequest {
        database_id: "default".to_string(),
        query_text: "NeStEd".to_string(),
        prefix: Some("/Knowledge".to_string()),
        top_k: 5,
        preview_mode: None,
    })
    .expect("path search should succeed");
    assert!(
        path_hits
            .iter()
            .any(|hit| hit.path == "/Knowledge/nested/bar.md")
    );

    let snapshot = export_snapshot(ExportSnapshotRequest {
        database_id: "default".to_string(),
        prefix: Some("/Knowledge".to_string()),
        limit: 100,
        cursor: None,
        snapshot_revision: None,
        snapshot_session_id: None,
    })
    .expect("snapshot should export");
    assert_eq!(snapshot.nodes.len(), 4);
    assert!(snapshot.nodes.iter().all(|node| node.path != "/Skills"));

    let empty_delta = fetch_updates(FetchUpdatesRequest {
        database_id: "default".to_string(),
        known_snapshot_revision: snapshot.snapshot_revision.clone(),
        prefix: Some("/Knowledge".to_string()),
        limit: 100,
        cursor: None,
        target_snapshot_revision: None,
    })
    .expect("matching snapshot should produce empty delta");
    assert!(empty_delta.changed_nodes.is_empty());
    assert!(empty_delta.removed_paths.is_empty());

    let invalid_delta = fetch_updates(FetchUpdatesRequest {
        database_id: "default".to_string(),
        known_snapshot_revision: "missing".to_string(),
        prefix: Some("/Knowledge".to_string()),
        limit: 100,
        cursor: None,
        target_snapshot_revision: None,
    });
    assert_eq!(
        invalid_delta.expect_err("unknown snapshot should fail"),
        "known_snapshot_revision is invalid"
    );

    let deleted = delete_node(DeleteNodeRequest {
        database_id: "default".to_string(),
        path: "/Knowledge/foo.md".to_string(),
        expected_etag: Some(created.node.etag.clone()),
        expected_folder_index_etag: None,
    })
    .expect("delete should succeed");
    assert_eq!(deleted.path, "/Knowledge/foo.md");

    let deleted_read = read_node("default".to_string(), "/Knowledge/foo.md".to_string())
        .expect("read should succeed");
    assert!(deleted_read.is_none());

    let stale_delete = delete_node(DeleteNodeRequest {
        database_id: "default".to_string(),
        path: "/Knowledge/nested/bar.md".to_string(),
        expected_etag: Some("stale".to_string()),
        expected_folder_index_etag: None,
    });
    assert!(stale_delete.is_err());
}

#[test]
fn fs_entrypoints_cover_backlink_queries() {
    install_test_service();
    ensure_parent_folders("/Knowledge/topic/source.md");

    ensure_parent_folders("/Sources/source/source.md");
    write_node(WriteNodeRequest {
        database_id: "default".to_string(),
        path: "/Knowledge/topic/source.md".to_string(),
        kind: NodeKind::File,
        content: "[Target](../target.md) and [[/Knowledge/target.md]]".to_string(),
        metadata_json: "{}".to_string(),
        expected_etag: None,
    })
    .expect("source write should succeed");

    let incoming = incoming_links(IncomingLinksRequest {
        database_id: "default".to_string(),
        path: "/Knowledge/target.md".to_string(),
        limit: 10,
    })
    .expect("incoming links should load");
    assert_eq!(incoming.len(), 2);
    assert!(
        incoming
            .iter()
            .all(|edge| edge.source_path == "/Knowledge/topic/source.md")
    );

    let outgoing = outgoing_links(OutgoingLinksRequest {
        database_id: "default".to_string(),
        path: "/Knowledge/topic/source.md".to_string(),
        limit: 10,
    })
    .expect("outgoing links should load");
    assert_eq!(outgoing.len(), 2);

    let graph = graph_links(GraphLinksRequest {
        database_id: "default".to_string(),
        prefix: "/Knowledge/topic".to_string(),
        limit: 10,
    })
    .expect("graph links should load");
    assert_eq!(graph.len(), 2);

    let context = read_node_context(NodeContextRequest {
        database_id: "default".to_string(),
        path: "/Knowledge/topic/source.md".to_string(),
        link_limit: 10,
    })
    .expect("context should load")
    .expect("node should exist");
    assert_eq!(context.node.path, "/Knowledge/topic/source.md");
    assert_eq!(context.outgoing_links.len(), 2);

    let neighborhood = graph_neighborhood(GraphNeighborhoodRequest {
        database_id: "default".to_string(),
        center_path: "/Knowledge/target.md".to_string(),
        depth: 1,
        limit: 10,
    })
    .expect("neighborhood should load");
    assert_eq!(neighborhood.len(), 2);
}

#[test]
fn fs_entrypoints_cover_append_edit_and_mkdir() {
    install_test_service();

    let mkdir = mkdir_node(MkdirNodeRequest {
        database_id: "default".to_string(),
        path: "/Knowledge/work".to_string(),
    })
    .expect("mkdir should succeed");
    assert!(mkdir.created);
    assert_eq!(mkdir.path, "/Knowledge/work");

    let appended = append_node(AppendNodeRequest {
        database_id: "default".to_string(),
        path: "/Knowledge/work/log.md".to_string(),
        content: "alpha".to_string(),
        expected_etag: None,
        separator: None,
        metadata_json: None,
        kind: None,
    })
    .expect("append create should succeed");
    assert!(appended.created);

    let appended_again = append_node(AppendNodeRequest {
        database_id: "default".to_string(),
        path: "/Knowledge/work/log.md".to_string(),
        content: "beta".to_string(),
        expected_etag: Some(appended.node.etag.clone()),
        separator: Some("\n".to_string()),
        metadata_json: None,
        kind: None,
    })
    .expect("append update should succeed");
    let appended_node = read_node("default".to_string(), "/Knowledge/work/log.md".to_string())
        .expect("read should succeed")
        .expect("node should exist");
    assert_eq!(appended_node.content, "alpha\nbeta");

    let edited = edit_node(EditNodeRequest {
        database_id: "default".to_string(),
        path: "/Knowledge/work/log.md".to_string(),
        old_text: "beta".to_string(),
        new_text: "gamma".to_string(),
        expected_etag: Some(appended_again.node.etag.clone()),
        replace_all: false,
    })
    .expect("edit should succeed");
    assert_eq!(edited.replacement_count, 1);
    let edited_node = read_node("default".to_string(), "/Knowledge/work/log.md".to_string())
        .expect("read should succeed")
        .expect("node should exist");
    assert_eq!(edited_node.content, "alpha\ngamma");
}

#[test]
fn fs_entrypoints_allow_source_paths_without_schema_validation() {
    install_test_service();

    let written = write_node(WriteNodeRequest {
        database_id: "default".to_string(),
        path: "/Sources/source.md".to_string(),
        kind: NodeKind::Source,
        content: "source".to_string(),
        metadata_json: "{}".to_string(),
        expected_etag: None,
    })
    .expect("source write should not enforce source path schema");
    assert_eq!(written.node.path, "/Sources/source.md");

    ensure_parent_folders("/Sources/source/source.md");
    write_node(WriteNodeRequest {
        database_id: "default".to_string(),
        path: "/Sources/source/source.md".to_string(),
        kind: NodeKind::Source,
        content: "source".to_string(),
        metadata_json: "{}".to_string(),
        expected_etag: None,
    })
    .expect("safe source write should succeed");

    let appended = append_node(AppendNodeRequest {
        database_id: "default".to_string(),
        path: "/Knowledge/topic.md".to_string(),
        content: "next".to_string(),
        expected_etag: None,
        separator: None,
        metadata_json: None,
        kind: Some(NodeKind::Source),
    })
    .expect("source append should not enforce source path schema");
    assert_eq!(appended.node.kind, NodeKind::Source);

    ensure_parent_folders("/Sources/keep/keep.md");
    let created = write_node(WriteNodeRequest {
        database_id: "default".to_string(),
        path: "/Sources/keep/keep.md".to_string(),
        kind: NodeKind::Source,
        content: "keep".to_string(),
        metadata_json: "{}".to_string(),
        expected_etag: None,
    })
    .expect("safe source write should succeed");

    ensure_parent_folders("/Sources/renamed-/wrong.md");
    let moved = move_node(MoveNodeRequest {
        database_id: "default".to_string(),
        from_path: "/Sources/keep/keep.md".to_string(),
        to_path: "/Sources/renamed-/wrong.md".to_string(),
        expected_etag: Some(created.node.etag),
        overwrite: false,
    })
    .expect("source move should not enforce source path schema");
    assert_eq!(moved.node.path, "/Sources/renamed-/wrong.md");
    assert_eq!(moved.node.kind, NodeKind::Source);
}

#[test]
fn fs_entrypoints_search_large_hits_without_trap() {
    install_test_service();

    let payload = format!("shared-bench-search {}", "x".repeat(1024 * 1024 - 20));
    ensure_parent_folders("/Knowledge/large/node-000.md");
    for index in 0..10 {
        write_node(WriteNodeRequest {
            database_id: "default".to_string(),
            path: format!("/Knowledge/large/node-{index:03}.md"),
            kind: NodeKind::File,
            content: payload.clone(),
            metadata_json: "{}".to_string(),
            expected_etag: None,
        })
        .expect("large write should succeed");
    }

    let hits = search_nodes(SearchNodesRequest {
        database_id: "default".to_string(),
        query_text: "shared-bench-search".to_string(),
        prefix: Some("/Knowledge/large".to_string()),
        top_k: 10,
        preview_mode: Some(SearchPreviewMode::None),
    })
    .expect("large search should succeed");

    assert_eq!(hits.len(), 10);
    for window in hits.windows(2) {
        assert!(window[0].score <= window[1].score);
    }
    for hit in hits {
        assert!(hit.path.starts_with("/Knowledge/large/"));
        assert!(hit.snippet.is_none());
        assert!(hit.preview.is_none());
    }
}

#[test]
fn fs_entrypoints_search_cover_fts_recall_cjk_and_delete_sync() {
    install_test_service();
    ensure_parent_folders("/Knowledge/search/node-0.md");

    for (path, content) in [
        ("/Knowledge/search/node-0.md", "alpha beta gamma"),
        ("/Knowledge/search/node-1.md", "alpha beta"),
        (
            "/Knowledge/search/検索改善メモ.md",
            "検索精度改善の作業メモ",
        ),
    ] {
        write_node(WriteNodeRequest {
            database_id: "default".to_string(),
            path: path.to_string(),
            kind: NodeKind::File,
            content: content.to_string(),
            metadata_json: "{}".to_string(),
            expected_etag: None,
        })
        .expect("write should succeed");
    }

    let multi_term_hits = search_nodes(SearchNodesRequest {
        database_id: "default".to_string(),
        query_text: "alpha beta missing".to_string(),
        prefix: Some("/Knowledge/search".to_string()),
        top_k: 10,
        preview_mode: Some(SearchPreviewMode::None),
    })
    .expect("multi-term search should succeed");
    assert!(
        multi_term_hits
            .iter()
            .any(|hit| hit.path == "/Knowledge/search/node-0.md")
    );
    assert!(
        multi_term_hits
            .iter()
            .any(|hit| hit.path == "/Knowledge/search/node-1.md")
    );

    let cjk_hits = search_nodes(SearchNodesRequest {
        database_id: "default".to_string(),
        query_text: "検索改善".to_string(),
        prefix: Some("/Knowledge/search".to_string()),
        top_k: 10,
        preview_mode: Some(SearchPreviewMode::None),
    })
    .expect("CJK search should succeed");
    assert!(
        cjk_hits
            .iter()
            .any(|hit| hit.path == "/Knowledge/search/検索改善メモ.md")
    );

    let deleted = read_node(
        "default".to_string(),
        "/Knowledge/search/node-1.md".to_string(),
    )
    .expect("read should succeed")
    .expect("node should exist");
    delete_node(DeleteNodeRequest {
        database_id: "default".to_string(),
        path: "/Knowledge/search/node-1.md".to_string(),
        expected_etag: Some(deleted.etag),
        expected_folder_index_etag: None,
    })
    .expect("delete should succeed");

    let after_delete_hits = search_nodes(SearchNodesRequest {
        database_id: "default".to_string(),
        query_text: "alpha beta missing".to_string(),
        prefix: Some("/Knowledge/search".to_string()),
        top_k: 10,
        preview_mode: Some(SearchPreviewMode::None),
    })
    .expect("search after delete should succeed");
    assert!(
        after_delete_hits
            .iter()
            .all(|hit| hit.path != "/Knowledge/search/node-1.md")
    );
}

#[test]
fn fs_entrypoints_cover_move_glob_and_multi_edit() {
    install_test_service();
    ensure_parent_folders("/Knowledge/work/item.md");
    ensure_parent_folders("/Knowledge/archive/item.md");

    let created = write_node(WriteNodeRequest {
        database_id: "default".to_string(),
        path: "/Knowledge/work/item.md".to_string(),
        kind: NodeKind::File,
        content: "alpha beta".to_string(),
        metadata_json: "{}".to_string(),
        expected_etag: None,
    })
    .expect("write should succeed");

    let moved = move_node(MoveNodeRequest {
        database_id: "default".to_string(),
        from_path: "/Knowledge/work/item.md".to_string(),
        to_path: "/Knowledge/archive/item.md".to_string(),
        expected_etag: Some(created.node.etag.clone()),
        overwrite: false,
    })
    .expect("move should succeed");
    assert_eq!(moved.from_path, "/Knowledge/work/item.md");
    assert_eq!(moved.node.path, "/Knowledge/archive/item.md");

    let globbed = glob_nodes(GlobNodesRequest {
        database_id: "default".to_string(),
        pattern: "**".to_string(),
        path: Some("/Knowledge".to_string()),
        node_type: Some(GlobNodeType::Directory),
    })
    .expect("glob should succeed");
    assert!(
        globbed
            .iter()
            .any(|hit| hit.path == "/Knowledge/archive" && hit.kind == NodeEntryKind::Folder)
    );

    let edited = multi_edit_node(MultiEditNodeRequest {
        database_id: "default".to_string(),
        path: "/Knowledge/archive/item.md".to_string(),
        edits: vec![
            MultiEdit {
                old_text: "alpha".to_string(),
                new_text: "one".to_string(),
            },
            MultiEdit {
                old_text: "beta".to_string(),
                new_text: "two".to_string(),
            },
        ],
        expected_etag: Some(moved.node.etag),
    })
    .expect("multi edit should succeed");
    assert_eq!(edited.replacement_count, 2);
    let edited_node = read_node(
        "default".to_string(),
        "/Knowledge/archive/item.md".to_string(),
    )
    .expect("read should succeed")
    .expect("node should exist");
    assert_eq!(edited_node.content, "one two");
}
