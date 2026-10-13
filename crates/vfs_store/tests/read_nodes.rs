use vfs_store::FsStore;
use vfs_types::{NodeKind, WriteNodeRequest};
#[test]
fn read_nodes_preserves_order_duplicates_and_text_with_partial_failures() {
    let dir = tempfile::tempdir().unwrap();
    let store = FsStore::new(dir.path().join("wiki.sqlite3"));
    store.run_fs_migrations().unwrap();
    let body = "\u{feff}日本語\0😀";
    let paths: Vec<String> = (0..10)
        .map(|i| format!("/Knowledge/{}-{i}--';.md", "長".repeat(130)))
        .collect();
    for path in &paths {
        store
            .write_node(
                WriteNodeRequest {
                    database_id: "default".into(),
                    path: path.clone(),
                    kind: NodeKind::File,
                    content: body.into(),
                    metadata_json: "{}".into(),
                    expected_etag: None,
                },
                1,
            )
            .unwrap();
    }
    let results = store.read_nodes(&paths).unwrap();
    for (path, result) in paths.iter().zip(results) {
        let node = result.unwrap().unwrap();
        assert_eq!(node, store.read_node(path).unwrap().unwrap());
        assert_eq!(node.content, body);
    }
    let results = store
        .read_nodes(&[
            paths[0].clone(),
            "/Knowledge/missing.md".into(),
            "relative".into(),
            paths[0].clone(),
        ])
        .unwrap();
    assert_eq!(results[0], results[3]);
    assert_eq!(results[1], Ok(None));
    assert!(results[2].is_err());
    assert!(store.read_nodes(&[]).is_err());
    assert!(store.read_nodes(&vec![paths[0].clone(); 11]).is_err());
}
