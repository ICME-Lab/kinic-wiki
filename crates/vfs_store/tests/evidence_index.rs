#[allow(dead_code)]
mod common;
use sha2::{Digest, Sha256};
use vfs_types::*;
fn sha(s: &str) -> String {
    format!("{:x}", Sha256::digest(s.as_bytes()))
}
#[test]
fn raw_evidence_is_metadata_searchable_but_body_is_not_indexed() {
    let (dir, store) = common::new_store();
    store.enable_evidence_storage().unwrap();
    let path = format!(
        "/Sources/learning-runs/{}/{}.json",
        sha("run"),
        sha("event")
    );
    common::ensure_parent_folders(&store, &path, 1);
    let body=serde_json::json!({"id":"event","run_id":"run","kind":"hook","payload":{"capture":{"event":"PostToolUse","tool_name":"CapacityProbe","session_evidence":{"records":[{"text":"uniquesecretterm AI"}]}}}}).to_string();
    store
        .write_node(
            WriteNodeRequest {
                database_id: "default".into(),
                path: path.clone(),
                kind: NodeKind::Source,
                content: body.clone(),
                metadata_json: r#"{"kind":"kinic.learning.evidence"}"#.into(),
                expected_etag: None,
            },
            2,
        )
        .unwrap();
    let search = |term: &str| {
        store
            .search_nodes(SearchNodesRequest {
                database_id: "default".into(),
                query_text: term.into(),
                prefix: None,
                top_k: 10,
                preview_mode: None,
            })
            .unwrap()
    };
    assert!(search("uniquesecretterm").is_empty());
    assert!(search("AI").is_empty());
    assert_eq!(search("CapacityProbe")[0].path, path);
    store
        .write_node(
            WriteNodeRequest {
                database_id: "default".into(),
                path: "/Knowledge/case.md".into(),
                kind: NodeKind::File,
                content: "uniquesecretterm AI".into(),
                metadata_json: "{}".into(),
                expected_etag: None,
            },
            3,
        )
        .unwrap();
    assert_eq!(search("uniquesecretterm")[0].path, "/Knowledge/case.md");
    assert_eq!(store.read_node(&path).unwrap().unwrap().content, body);
    let db = rusqlite::Connection::open(dir.path().join("wiki.sqlite3")).unwrap();
    let sql: String = db
        .query_row(
            "SELECT sql FROM sqlite_master WHERE name='fs_nodes_fts'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(sql.contains("content='fs_search_content'"));
    let size: i64 = db
        .query_row("SELECT sum(length(body)) FROM fs_evidence_blobs", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert!(size > 0);
}
#[test]
fn sql_does_not_expose_payload_tables_or_fake_plaintext() {
    let (_dir, store) = common::new_store();
    store.enable_evidence_storage().unwrap();
    for table in [
        "fs_evidence_blobs",
        "fs_evidence_manifests",
        "fs_evidence_bindings",
        "fs_search_content",
    ] {
        assert!(
            store
                .query_sql_json(
                    &format!("SELECT json_object('value',1) FROM {table} LIMIT 1"),
                    10
                )
                .is_err()
        );
    }
}

#[test]
fn external_index_tracks_normal_edits_moves_and_deletes() {
    let (dir, store) = common::new_store();
    store.enable_evidence_storage().unwrap();
    let first = store
        .write_node(
            WriteNodeRequest {
                database_id: "default".into(),
                path: "/Knowledge/a.md".into(),
                kind: NodeKind::File,
                content: "oldkeyword".into(),
                metadata_json: "{}".into(),
                expected_etag: None,
            },
            1,
        )
        .unwrap();
    let next = store
        .write_node(
            WriteNodeRequest {
                database_id: "default".into(),
                path: "/Knowledge/a.md".into(),
                kind: NodeKind::File,
                content: "newkeyword".into(),
                metadata_json: "{}".into(),
                expected_etag: Some(first.node.etag),
            },
            2,
        )
        .unwrap();
    store
        .move_node(
            MoveNodeRequest {
                database_id: "default".into(),
                from_path: "/Knowledge/a.md".into(),
                to_path: "/Knowledge/b.md".into(),
                expected_etag: Some(next.node.etag),
                overwrite: false,
                expected_target_etag: None,
            },
            3,
        )
        .unwrap();
    let current = store.read_node("/Knowledge/b.md").unwrap().unwrap();
    store
        .delete_node(
            DeleteNodeRequest {
                database_id: "default".into(),
                path: current.path,
                expected_etag: Some(current.etag),
                expected_folder_index_etag: None,
            },
            4,
        )
        .unwrap();
    let db = rusqlite::Connection::open(dir.path().join("wiki.sqlite3")).unwrap();
    db.execute(
        "INSERT INTO fs_nodes_fts(fs_nodes_fts,rank) VALUES('integrity-check',1)",
        [],
    )
    .unwrap();
    let hits = store
        .search_nodes(SearchNodesRequest {
            database_id: "default".into(),
            query_text: "newkeyword".into(),
            prefix: None,
            top_k: 10,
            preview_mode: None,
        })
        .unwrap();
    assert!(hits.is_empty());
}
