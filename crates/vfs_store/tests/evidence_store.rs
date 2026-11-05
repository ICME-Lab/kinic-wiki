use sha2::{Digest, Sha256};
fn sha(b: &[u8]) -> String {
    format!("{:x}", Sha256::digest(b))
}
fn fixture(run: &str) -> (String, String) {
    (
        format!(
            "/Sources/learning-runs/{}/{}.json",
            sha(run.as_bytes()),
            sha(b"event")
        ),
        String::new(),
    )
}

#[allow(dead_code)]
mod common;
#[test]
fn current_and_history_preserve_identity_etag_hash() {
    use vfs_types::{NodeHistoryRequest, NodeKind, WriteNodeRequest};
    let (dir, store) = common::new_store();
    store.enable_evidence_storage().unwrap();
    let (path, _) = fixture("run");
    common::ensure_parent_folders(&store, &path, 1);
    let body=serde_json::to_string(&serde_json::json!({"id":"event","run_id":"run","kind":"hook","payload":{"capture":{"event":"PostToolUse","session_evidence":{"records":[{"text":"x".repeat(20_000)},{"text":"x".repeat(20_000)}]}}}})).unwrap();
    let request = WriteNodeRequest {
        database_id: "default".into(),
        path: path.clone(),
        kind: NodeKind::Source,
        content: body.clone(),
        metadata_json: r#"{"kind":"kinic.learning.evidence"}"#.into(),
        expected_etag: None,
    };
    let ack = store.write_node(request, 10).unwrap().node;
    assert_eq!(store.read_node(&path).unwrap().unwrap().content, body);
    let revision = store.current_node_revision(&path).unwrap().unwrap();
    assert_eq!(revision.node.etag, ack.etag);
    assert_eq!(revision.content_hash, sha(body.as_bytes()));
    let history = store
        .node_history(NodeHistoryRequest {
            database_id: "default".into(),
            node_id: revision.node_id,
            before_revision: None,
            limit: 10,
        })
        .unwrap();
    assert_eq!(history.revisions[0].node.content, body);
    let db = rusqlite::Connection::open(dir.path().join("wiki.sqlite3")).unwrap();
    let internal_reference: String = db
        .query_row("SELECT content FROM fs_nodes WHERE path=?1", [&path], |r| {
            r.get(0)
        })
        .unwrap();
    let current: i64 = db
        .query_row(
            "SELECT length(content) FROM fs_nodes WHERE path=?1",
            [&path],
            |r| r.get(0),
        )
        .unwrap();
    let historical: i64 = db
        .query_row(
            "SELECT length(content) FROM fs_node_revisions WHERE path=?1",
            [&path],
            |r| r.get(0),
        )
        .unwrap();
    assert!(current < 1000 && historical < 1000);
    let blobs: i64 = db
        .query_row("SELECT count(*) FROM fs_evidence_blobs", [], |r| r.get(0))
        .unwrap();
    assert_eq!(blobs, 1);
    drop(db);
    store
        .write_node(
            WriteNodeRequest {
                database_id: "default".into(),
                path: "/Sources/user-literal.json".into(),
                kind: NodeKind::Source,
                content: internal_reference.clone(),
                metadata_json: r#"{"kind":"kinic.learning.evidence"}"#.into(),
                expected_etag: None,
            },
            11,
        )
        .unwrap();
    assert_eq!(
        store
            .read_node("/Sources/user-literal.json")
            .unwrap()
            .unwrap()
            .content,
        internal_reference
    );
    let export = store
        .export_snapshot(vfs_types::ExportSnapshotRequest {
            database_id: "default".into(),
            prefix: Some("/Sources/learning-runs".into()),
            limit: 100,
            cursor: None,
            snapshot_revision: None,
            snapshot_session_id: None,
        })
        .unwrap();
    assert_eq!(
        export
            .nodes
            .iter()
            .find(|n| n.path == path)
            .unwrap()
            .content,
        body
    );
    assert_eq!(
        store.read_nodes(std::slice::from_ref(&path)).unwrap()[0]
            .as_ref()
            .unwrap()
            .as_ref()
            .unwrap()
            .content,
        body
    );
    let moved = format!("{}.moved", path);
    store
        .move_node(
            vfs_types::MoveNodeRequest {
                database_id: "default".into(),
                from_path: path.clone(),
                to_path: moved.clone(),
                expected_etag: Some(ack.etag),
                overwrite: false,
                expected_target_etag: None,
            },
            20,
        )
        .unwrap();
    let after = store.current_node_revision(&moved).unwrap().unwrap();
    assert_eq!(after.node.content, body);
    let history_id = after.node_id;
    store
        .delete_node(
            vfs_types::DeleteNodeRequest {
                database_id: "default".into(),
                path: moved,
                expected_etag: Some(after.node.etag),
                expected_folder_index_etag: None,
            },
            30,
        )
        .unwrap();
    let h = store
        .node_history(NodeHistoryRequest {
            database_id: "default".into(),
            node_id: history_id,
            before_revision: None,
            limit: 100,
        })
        .unwrap();
    assert_eq!(h.revisions.len(), 3);
    assert!(h.revisions[0].deleted);
    assert!(
        h.revisions
            .iter()
            .all(|r| r.node.content == body && r.content_hash == sha(body.as_bytes()))
    );
}
#[test]
fn ordinary_documents_and_marker_like_text_remain_literal() {
    use vfs_types::{NodeKind, WriteNodeRequest};
    let (_dir, store) = common::new_store();
    store.enable_evidence_storage().unwrap();
    common::ensure_parent_folders(&store, "/Knowledge/case.md", 1);
    let body = "kinic:evidence:v1:fake";
    store
        .write_node(
            WriteNodeRequest {
                database_id: "default".into(),
                path: "/Knowledge/case.md".into(),
                kind: NodeKind::File,
                content: body.into(),
                metadata_json: "{}".into(),
                expected_etag: None,
            },
            10,
        )
        .unwrap();
    assert_eq!(
        store
            .read_node("/Knowledge/case.md")
            .unwrap()
            .unwrap()
            .content,
        body
    );
}
