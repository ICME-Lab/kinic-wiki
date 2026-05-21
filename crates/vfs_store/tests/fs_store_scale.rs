use std::time::Instant;

use tempfile::tempdir;
use vfs_store::FsStore;
use vfs_types::{
    AppendNodeRequest, DeleteNodeRequest, ExportSnapshotRequest, FetchUpdatesRequest, GlobNodeType,
    GlobNodesRequest, ListNodesRequest, MkdirNodeRequest, NodeEntryKind, NodeKind,
    SearchNodePathsRequest, SearchNodesRequest, SearchPreviewMode, WriteNodeRequest,
};

fn new_store() -> (tempfile::TempDir, FsStore) {
    let dir = tempdir().expect("temp dir should exist");
    let store = FsStore::new(dir.path().join("wiki.sqlite3"));
    store
        .run_fs_migrations()
        .expect("fs migrations should succeed");
    (dir, store)
}

fn markdown_of_size(size: usize, marker: &str) -> String {
    let mut content = format!("# Scale Test\n\nmarker: {marker}\n\n");
    while content.len() < size {
        content.push_str("content block for vfs validation.\n");
    }
    content.truncate(size);
    content
}

fn write_file(
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
fn markdown_size_variants_roundtrip_through_write_append_and_edit() {
    let (_dir, store) = new_store();

    for (index, size) in [1_024usize, 4_096, 16_384, 65_536].into_iter().enumerate() {
        let path = format!("/Wiki/sizes/{size}.md");
        let marker = format!("TARGET_{size}");
        let content = markdown_of_size(size, &marker);
        ensure_parent_folders(&store, &path, 99 + index as i64);
        let created = store
            .write_node(
                WriteNodeRequest {
                    database_id: "default".to_string(),
                    path: path.clone(),
                    kind: NodeKind::File,
                    content: content.clone(),
                    metadata_json: "{}".to_string(),
                    expected_etag: None,
                },
                100 + index as i64,
            )
            .expect("size write should succeed");
        assert_eq!(
            store
                .read_node(&path)
                .expect("read should succeed")
                .expect("node should exist")
                .content
                .len(),
            size
        );

        let appended = store
            .append_node(
                AppendNodeRequest {
                    database_id: "default".to_string(),
                    path: path.clone(),
                    content: "\nappend marker".to_string(),
                    expected_etag: Some(created.node.etag.clone()),
                    separator: None,
                    metadata_json: None,
                    kind: None,
                },
                200 + index as i64,
            )
            .expect("append should succeed");
        assert!(
            store
                .read_node(&path)
                .expect("read should succeed")
                .expect("node should exist")
                .content
                .len()
                > size
        );

        let edited = store
            .edit_node(
                vfs_types::EditNodeRequest {
                    database_id: "default".to_string(),
                    path: path.clone(),
                    old_text: marker.clone(),
                    new_text: format!("UPDATED_{size}"),
                    expected_etag: Some(appended.node.etag),
                    replace_all: false,
                },
                300 + index as i64,
            )
            .expect("edit should succeed");
        assert_eq!(edited.replacement_count, 1);
        assert!(
            store
                .read_node(&path)
                .expect("read should succeed")
                .expect("node should exist")
                .content
                .contains(&format!("UPDATED_{size}"))
        );
    }
}

#[test]
fn list_nodes_scales_to_thousand_entries() {
    let (_dir, store) = new_store();

    for index in 0..1_000 {
        let bucket = index % 10;
        let path = format!("/Wiki/scale/bucket-{bucket}/node-{index:04}.md");
        write_file(&store, &path, "scale body", None, 10 + index as i64);
    }

    let root_entries = store
        .list_nodes(ListNodesRequest {
            database_id: "default".to_string(),
            prefix: "/Wiki/scale".to_string(),
            recursive: false,
        })
        .expect("root list should succeed");
    assert_eq!(root_entries.len(), 10);
    assert!(root_entries.iter().all(|entry| {
        entry.kind == NodeEntryKind::Folder
            && entry.has_children
            && entry.path.starts_with("/Wiki/scale/bucket-")
    }));

    let recursive_entries = store
        .list_nodes(ListNodesRequest {
            database_id: "default".to_string(),
            prefix: "/Wiki/scale".to_string(),
            recursive: true,
        })
        .expect("recursive list should succeed");
    assert_eq!(recursive_entries.len(), 1_011);
    assert_eq!(
        recursive_entries
            .iter()
            .filter(|entry| entry.kind == NodeEntryKind::File)
            .count(),
        1_000
    );
}

#[test]
fn glob_and_search_scale_cases_respect_scope_and_physical_deletes() {
    let (_dir, store) = new_store();

    for index in 0..120 {
        let project = if index % 2 == 0 { "alpha" } else { "beta" };
        let path = format!("/Wiki/projects/{project}/nested/topic-{index:03}.md");
        let etag = write_file(
            &store,
            &path,
            &format!("project {project} needle-{index}"),
            None,
            100 + index as i64,
        );
        if index % 15 == 0 {
            store
                .delete_node(
                    DeleteNodeRequest {
                        database_id: "default".to_string(),
                        path,
                        expected_etag: Some(etag),
                        expected_folder_index_etag: None,
                    },
                    500 + index as i64,
                )
                .expect("delete should succeed");
        }
    }

    let glob_hits = store
        .glob_nodes(GlobNodesRequest {
            database_id: "default".to_string(),
            pattern: "**/*.md".to_string(),
            path: Some("/Wiki/projects/alpha".to_string()),
            node_type: Some(GlobNodeType::File),
        })
        .expect("glob should succeed");
    assert!(glob_hits.len() >= 50);
    assert!(
        glob_hits
            .iter()
            .all(|hit| hit.path.starts_with("/Wiki/projects/alpha/"))
    );

    let search_hits = store
        .search_nodes(SearchNodesRequest {
            database_id: "default".to_string(),
            query_text: "needle".to_string(),
            prefix: Some("/Wiki/projects/alpha".to_string()),
            top_k: 100,
            preview_mode: Some(SearchPreviewMode::None),
        })
        .expect("search should succeed");
    assert!(
        search_hits
            .iter()
            .all(|hit| hit.path.starts_with("/Wiki/projects/alpha/"))
    );
    assert!(
        !search_hits
            .iter()
            .any(|hit| hit.path.ends_with("topic-000.md"))
    );

    let path_hits = store
        .search_node_paths(SearchNodePathsRequest {
            database_id: "default".to_string(),
            query_text: "TOPIC-000".to_string(),
            prefix: Some("/Wiki/projects/alpha".to_string()),
            top_k: 100,
            preview_mode: None,
        })
        .expect("path search should succeed");
    assert!(
        path_hits
            .iter()
            .all(|hit| hit.path.starts_with("/Wiki/projects/alpha/"))
    );
}

#[test]
fn path_search_smoke_reports_latency_and_hits() {
    let (_dir, store) = new_store();

    for index in 0..300 {
        let path = format!("/Wiki/bench/nested/Topic-{index:03}.md");
        write_file(
            &store,
            &path,
            &format!("body {index}"),
            None,
            1_000 + index as i64,
        );
    }

    let cases = [
        ("nested", "nested"),
        ("basename", "Topic-042"),
        ("mixed_case", "tOpIc-042"),
    ];
    for (label, query_text) in cases {
        let started_at = Instant::now();
        let hits = store
            .search_node_paths(SearchNodePathsRequest {
                database_id: "default".to_string(),
                query_text: query_text.to_string(),
                prefix: Some("/Wiki/bench".to_string()),
                top_k: 20,
                preview_mode: None,
            })
            .expect("path search smoke should succeed");
        let elapsed_us = started_at.elapsed().as_micros();
        println!(
            "path_search_smoke case={label} query={query_text} hit_count={} latency_us={elapsed_us}",
            hits.len()
        );
        assert!(!hits.is_empty());
    }
}

#[test]
fn fetch_updates_reports_small_delta_against_large_snapshot() {
    let (_dir, store) = new_store();

    for index in 0..1_000 {
        let path = format!("/Wiki/snapshot/note-{index:04}.md");
        write_file(
            &store,
            &path,
            &format!("body {index}"),
            None,
            10 + index as i64,
        );
    }

    let base = store
        .export_snapshot(ExportSnapshotRequest {
            database_id: "default".to_string(),
            prefix: Some("/Wiki/snapshot".to_string()),
            limit: 100,
            cursor: None,
            snapshot_revision: None,
            snapshot_session_id: None,
        })
        .expect("base snapshot should succeed");
    assert_eq!(base.nodes.len(), 100);

    let updated_etag = store
        .read_node("/Wiki/snapshot/note-0001.md")
        .expect("read should succeed")
        .expect("node should exist")
        .etag;
    let updated = write_file(
        &store,
        "/Wiki/snapshot/note-0001.md",
        "body 1 updated",
        Some(&updated_etag),
        5_000,
    );
    let deleted_etag = store
        .read_node("/Wiki/snapshot/note-0002.md")
        .expect("read should succeed")
        .expect("node should exist")
        .etag;
    store
        .delete_node(
            DeleteNodeRequest {
                database_id: "default".to_string(),
                path: "/Wiki/snapshot/note-0002.md".to_string(),
                expected_etag: Some(deleted_etag),
                expected_folder_index_etag: None,
            },
            5_001,
        )
        .expect("delete should succeed");
    write_file(&store, "/Wiki/snapshot/new.md", "new body", None, 5_002);

    let updates = store
        .fetch_updates(FetchUpdatesRequest {
            database_id: "default".to_string(),
            known_snapshot_revision: base.snapshot_revision,
            prefix: Some("/Wiki/snapshot".to_string()),
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
            .any(|node| node.path == "/Wiki/snapshot/note-0001.md" && node.etag == updated)
    );
    assert!(
        updates
            .changed_nodes
            .iter()
            .any(|node| node.path == "/Wiki/snapshot/new.md")
    );
    assert_eq!(
        updates.removed_paths,
        vec!["/Wiki/snapshot/note-0002.md".to_string()]
    );
}
