use super::super::integration_tests::StoreClient;
use super::*;
use vfs_types::{
    DeleteNodeRequest, MoveNodeRequest, NodeKind, NodeRevisionRequest, WriteNodeRequest,
};

async fn write(
    client: &StoreClient,
    path: &str,
    content: &str,
    metadata: &str,
    etag: Option<String>,
) {
    client
        .write_node(WriteNodeRequest {
            database_id: "db".into(),
            path: path.into(),
            kind: NodeKind::File,
            content: content.into(),
            metadata_json: metadata.into(),
            expected_etag: etag,
        })
        .await
        .unwrap();
}
async fn snapshot(client: &StoreClient, path: &str) -> RevisionRef {
    let node = client
        .current_node_revision(NodeRevisionRequest {
            database_id: "db".into(),
            path: path.into(),
        })
        .await
        .unwrap()
        .unwrap();
    RevisionRef {
        path: node.node.path,
        node_id: node.node_id,
        revision: node.revision,
        etag: node.node.etag,
        content_hash: node.content_hash,
    }
}

#[tokio::test]
async fn original_evidence_survives_edit_move_delete_and_path_recreation() {
    let root = tempfile::tempdir().unwrap();
    let client = StoreClient::new(root.path());
    let path = "/Knowledge/original.md";
    write(&client, path, "original source", "{}", None).await;
    let original = snapshot(&client, path).await;
    write(
        &client,
        path,
        "updated source",
        "{}",
        Some(original.etag.clone()),
    )
    .await;
    let updated = snapshot(&client, path).await;
    let result = resolve_evidence(&client, "db", std::slice::from_ref(&original))
        .await
        .unwrap();
    assert_eq!(result.historical[0].content, "original source");
    assert_eq!(result.guards, vec![updated.clone()]);
    assert_eq!(result.current_nodes[0].content, "updated source");
    client
        .move_node(MoveNodeRequest {
            database_id: "db".into(),
            from_path: path.into(),
            to_path: "/Knowledge/moved.md".into(),
            expected_etag: Some(updated.etag),
            overwrite: false,
            expected_target_etag: None,
        })
        .await
        .unwrap();
    let moved = snapshot(&client, "/Knowledge/moved.md").await;
    let result = resolve_evidence(&client, "db", std::slice::from_ref(&original))
        .await
        .unwrap();
    assert_eq!(result.historical[0].path, path);
    assert_eq!(result.guards, vec![moved.clone()]);
    assert_eq!(result.current_nodes[0].path, "/Knowledge/moved.md");
    client
        .delete_node(DeleteNodeRequest {
            database_id: "db".into(),
            path: moved.path,
            expected_etag: Some(moved.etag),
            expected_folder_index_etag: None,
        })
        .await
        .unwrap();
    write(&client, path, "unrelated recreated node", "{}", None).await;
    let recreated = snapshot(&client, path).await;
    assert_ne!(recreated.node_id, original.node_id);
    let result = resolve_evidence(&client, "db", &[original]).await.unwrap();
    assert_eq!(result.historical[0].content, "original source");
    assert!(result.guards.is_empty());
    assert!(result.current_nodes.is_empty());
}

#[tokio::test]
async fn historical_metadata_evidence_closure_is_resolved_and_deduplicated() {
    let root = tempfile::tempdir().unwrap();
    let client = StoreClient::new(root.path());
    write(
        &client,
        "/Sources/raw.md",
        "original primary source",
        "{}",
        None,
    )
    .await;
    let source = snapshot(&client, "/Sources/raw.md").await;
    let metadata =
        serde_json::json!({"authority":"agent","evidence":[source.clone(),source.clone()]})
            .to_string();
    write(
        &client,
        "/Knowledge/lesson.md",
        "derived lesson",
        &metadata,
        None,
    )
    .await;
    let lesson = snapshot(&client, "/Knowledge/lesson.md").await;
    write(
        &client,
        "/Sources/raw.md",
        "later primary source",
        "{}",
        Some(source.etag.clone()),
    )
    .await;
    let current_source = snapshot(&client, "/Sources/raw.md").await;
    let result = resolve_evidence(&client, "db", &[lesson.clone(), lesson, source])
        .await
        .unwrap();
    assert_eq!(result.historical.len(), 2);
    assert!(
        result
            .historical
            .iter()
            .any(|node| node.content == "original primary source")
    );
    assert_eq!(result.guards.len(), 2);
    assert!(result.guards.contains(&current_source));
}

#[tokio::test]
async fn mismatched_snapshot_fields_conflicting_duplicates_and_excess_refs_are_rejected() {
    let root = tempfile::tempdir().unwrap();
    let client = StoreClient::new(root.path());
    write(&client, "/Sources/raw.md", "source body", "{}", None).await;
    let original = snapshot(&client, "/Sources/raw.md").await;
    for field in 0..5 {
        let mut bad = original.clone();
        match field {
            0 => bad.path = "/Sources/wrong.md".into(),
            1 => bad.node_id = "99999".into(),
            2 => bad.revision += 1,
            3 => bad.etag = "wrong".into(),
            _ => bad.content_hash = "wrong".into(),
        }
        assert!(resolve_evidence(&client, "db", &[bad]).await.is_err());
    }
    let mut conflict = original.clone();
    conflict.content_hash = "different".into();
    assert!(
        resolve_evidence(&client, "db", &[original.clone(), conflict])
            .await
            .is_err()
    );
    assert!(
        resolve_evidence(&client, "db", &vec![original; 101])
            .await
            .is_err()
    );
}
