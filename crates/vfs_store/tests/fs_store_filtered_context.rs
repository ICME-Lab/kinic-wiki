// Where: crates/vfs_store filtered context integration tests.
// What: verifies sparse retrieval and derived-output filtering.
// Why: access filtering must happen before top-k ranking and cover every returned path reference.

use tempfile::tempdir;
use vfs_store::FsStore;
use vfs_types::{AppendNodeRequest, MkdirNodeRequest, NodeKind, QueryContextRequest};

fn new_store() -> (tempfile::TempDir, FsStore) {
    let dir = tempdir().expect("temp dir should exist");
    let store = FsStore::new(dir.path().join("wiki.sqlite3"));
    store
        .run_fs_migrations()
        .expect("fs migrations should succeed");
    (dir, store)
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

fn append_node(store: &FsStore, path: &str, content: &str, kind: NodeKind, now: i64) {
    ensure_parent_folders(store, path, now - 1);
    store
        .append_node(
            AppendNodeRequest {
                database_id: "default".to_string(),
                path: path.to_string(),
                content: content.to_string(),
                expected_etag: None,
                separator: None,
                metadata_json: None,
                kind: Some(kind),
            },
            now,
        )
        .expect("context fixture node should write");
}

fn filtered_context(
    store: &FsStore,
    namespace: &str,
    allow_path: impl FnMut(&str) -> bool,
) -> vfs_types::QueryContext {
    store
        .query_context_filtered(
            QueryContextRequest {
                database_id: "default".to_string(),
                task: "needle".to_string(),
                entities: Vec::new(),
                namespace: Some(namespace.to_string()),
                budget_tokens: 1_000,
                include_evidence: false,
                depth: 0,
            },
            allow_path,
        )
        .expect("filtered context should load")
}

#[test]
fn query_context_filtered_finds_allowed_hit_beyond_unfiltered_limit() {
    let (_dir, store) = new_store();
    for index in 0..120 {
        append_node(
            &store,
            &format!("/Knowledge/filter/aa-denied-{index:03}.md"),
            "needle shared context",
            NodeKind::File,
            index + 1,
        );
    }
    append_node(
        &store,
        "/Knowledge/filter/zz-allowed.md",
        "needle shared context",
        NodeKind::File,
        200,
    );

    let context = filtered_context(&store, "/Knowledge/filter", |path| {
        path == "/Knowledge/filter/zz-allowed.md"
    });

    assert_eq!(
        context
            .search_hits
            .iter()
            .map(|hit| hit.path.as_str())
            .collect::<Vec<_>>(),
        vec!["/Knowledge/filter/zz-allowed.md"]
    );
    assert_eq!(
        context
            .nodes
            .iter()
            .map(|item| item.node.path.as_str())
            .collect::<Vec<_>>(),
        vec!["/Knowledge/filter/zz-allowed.md"]
    );
    assert!(!context.truncated);
}

#[test]
fn query_context_filtered_marks_scan_cap_as_truncated() {
    let (_dir, store) = new_store();
    for index in 0..1_001 {
        append_node(
            &store,
            &format!("/Knowledge/filter-cap/aa-denied-{index:04}.md"),
            "needle shared context",
            NodeKind::File,
            index + 1,
        );
    }
    append_node(
        &store,
        "/Knowledge/filter-cap/zz-allowd-1001.md",
        "needle shared context",
        NodeKind::File,
        2_000,
    );

    let context = filtered_context(&store, "/Knowledge/filter-cap", |path| {
        path == "/Knowledge/filter-cap/zz-allowd-1001.md"
    });

    assert!(
        context.search_hits.is_empty(),
        "unexpected hits: {:?}",
        context.search_hits
    );
    assert!(context.nodes.is_empty());
    assert!(context.truncated);
}

#[test]
fn query_context_filtered_filters_derived_links_and_evidence() {
    fn allow_context_path(path: &str) -> bool {
        matches!(
            path,
            "/Knowledge/filter/zz-allowed.md"
                | "/Knowledge/filter/zz-allowed-target.md"
                | "/Sources/filter/allowed.md"
        )
    }

    let (_dir, store) = new_store();
    for (path, content, kind, now) in [
        (
            "/Knowledge/filter/zz-allowed.md",
            "needle [Allowed](/Knowledge/filter/zz-allowed-target.md) [Denied](/Knowledge/filter/aa-denied-target.md) [AllowedRaw](/Sources/filter/allowed.md) [DeniedRaw](/Sources/filter/denied.md)",
            NodeKind::File,
            10,
        ),
        (
            "/Knowledge/filter/zz-allowed-target.md",
            "allowed target",
            NodeKind::File,
            11,
        ),
        (
            "/Knowledge/filter/aa-denied-target.md",
            "denied target",
            NodeKind::File,
            12,
        ),
        (
            "/Knowledge/filter/provenance.md",
            "[DeniedRaw](/Sources/filter/denied.md)",
            NodeKind::File,
            13,
        ),
        (
            "/Sources/filter/allowed.md",
            "allowed raw",
            NodeKind::Source,
            14,
        ),
        (
            "/Sources/filter/denied.md",
            "denied raw",
            NodeKind::Source,
            15,
        ),
    ] {
        append_node(&store, path, content, kind, now);
    }

    let context = store
        .query_context_filtered(
            QueryContextRequest {
                database_id: "default".to_string(),
                task: "needle".to_string(),
                entities: Vec::new(),
                namespace: Some("/Knowledge/filter".to_string()),
                budget_tokens: 1_000,
                include_evidence: true,
                depth: 1,
            },
            allow_context_path,
        )
        .expect("filtered context should load");

    assert_eq!(
        context
            .nodes
            .iter()
            .map(|item| item.node.path.as_str())
            .collect::<Vec<_>>(),
        vec!["/Knowledge/filter/zz-allowed.md"]
    );
    assert!(context.graph_links.iter().all(|edge| {
        allow_context_path(&edge.source_path) && allow_context_path(&edge.target_path)
    }));
    assert!(
        context
            .graph_links
            .iter()
            .any(|edge| edge.target_path == "/Knowledge/filter/zz-allowed-target.md")
    );
    assert!(
        context
            .evidence
            .iter()
            .flat_map(|item| &item.refs)
            .all(|item| {
                allow_context_path(&item.source_path) && allow_context_path(&item.via_path)
            })
    );
    assert!(
        context
            .evidence
            .iter()
            .flat_map(|item| &item.refs)
            .any(|item| item.source_path == "/Sources/filter/allowed.md")
    );
    let node_context = context
        .nodes
        .iter()
        .find(|item| item.node.path == "/Knowledge/filter/zz-allowed.md")
        .expect("allowed node context should be present");
    assert!(
        node_context
            .incoming_links
            .iter()
            .chain(node_context.outgoing_links.iter())
            .all(|edge| {
                allow_context_path(&edge.source_path) && allow_context_path(&edge.target_path)
            })
    );
}
