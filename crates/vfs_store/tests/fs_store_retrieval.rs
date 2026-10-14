fn new_store() -> (tempfile::TempDir, vfs_store::FsStore) {
    let dir = tempfile::tempdir().unwrap();
    let store = vfs_store::FsStore::new(dir.path().join("wiki.sqlite3"));
    store.run_fs_migrations().unwrap();
    (dir, store)
}
use vfs_types::{
    NodeKind, SearchNodesForRetrievalRequest, SearchNodesRequest, SearchPreviewMode,
    WriteNodeRequest,
};

#[test]
fn retrieval_preserves_light_hits_and_uses_original_intent() {
    let (_dir, store) = new_store();
    for (path, content) in [
        (
            "/hono-cors.md",
            "## Content\nCORS origin credentials 日本語😀\0\u{feff}tail".to_string(),
        ),
        ("/long.md", format!("{}\nneedle", "x".repeat(40_000))),
        ("/empty.md", String::new()),
    ] {
        store
            .write_node(
                WriteNodeRequest {
                    database_id: "default".into(),
                    path: path.into(),
                    kind: NodeKind::File,
                    content,
                    metadata_json: "{}".into(),
                    expected_etag: None,
                },
                1,
            )
            .unwrap();
    }
    let request = |query: &str| SearchNodesForRetrievalRequest {
        database_id: "default".into(),
        query_text: query.into(),
        intent: "CORS origin credentials".into(),
        prefix: Some("/".into()),
        top_k: 20,
    };
    let first = store.search_nodes_for_retrieval(request("CORS")).unwrap();
    let auxiliary = store.search_nodes_for_retrieval(request("origin")).unwrap();
    let legacy = store
        .search_nodes(SearchNodesRequest {
            database_id: "default".into(),
            query_text: "CORS".into(),
            prefix: Some("/".into()),
            top_k: 20,
            preview_mode: Some(SearchPreviewMode::Light),
        })
        .unwrap();
    assert_eq!(
        first.iter().map(|h| h.hit.clone()).collect::<Vec<_>>(),
        legacy
    );
    assert_eq!(first[0].rerank_excerpt, auxiliary[0].rerank_excerpt);
    assert_eq!(
        first[0].rerank_excerpt,
        "CORS origin credentials 日本語😀\0\u{feff}tail"
    );
    let long = store
        .search_nodes_for_retrieval(request("long.md"))
        .unwrap();
    assert!(!long[0].rerank_excerpt.contains("needle"));
    assert_eq!(long[0].rerank_excerpt.len(), 512);
    assert_eq!(
        store
            .search_nodes_for_retrieval(request("empty.md"))
            .unwrap()[0]
            .rerank_excerpt,
        ""
    );
    let mut oversized = request("😀");
    oversized.intent = "😀".repeat(257);
    assert!(store.search_nodes_for_retrieval(oversized).is_err());
    let mut oversized = request("CORS");
    oversized.top_k = 21;
    assert!(store.search_nodes_for_retrieval(oversized).is_err());
}
