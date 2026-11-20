mod common;
use common::{ensure_parent_folders, new_store, write_file};
use sha2::{Digest, Sha256};
use vfs_store::FsStore;
use vfs_types::*;
fn hash(s: &str) -> String {
    format!("{:x}", Sha256::digest(s.as_bytes()))
}
fn fixture(store: &FsStore, terminal: bool) -> (String, NodeRevision) {
    fixture_with_event_id(store, terminal, "hook")
}
fn fixture_with_event_id(store: &FsStore, terminal: bool, id: &str) -> (String, NodeRevision) {
    let path = format!("/Sources/learning-runs/{}/{}.json", hash("run"), hash(id));
    ensure_parent_folders(store, &path, 1);
    let body = serde_json::json!({"id":id,"run_id":"run","kind":"hook","payload":{"capture":{"event":"PostToolUse","terminal":terminal,"text":"needle ".repeat(30000)}}}).to_string();
    store
        .write_node(
            WriteNodeRequest {
                database_id: "default".into(),
                path: path.clone(),
                kind: NodeKind::Source,
                content: body,
                metadata_json: "{}".into(),
                expected_etag: None,
            },
            2,
        )
        .unwrap();
    let revision = store.current_node_revision(&path).unwrap().unwrap();
    (path, revision)
}
fn snapshot(store: &FsStore) -> String {
    store
        .export_snapshot(ExportSnapshotRequest {
            database_id: "default".into(),
            prefix: Some("/".into()),
            limit: 1,
            cursor: None,
            snapshot_revision: None,
            snapshot_session_id: None,
        })
        .unwrap()
        .snapshot_revision
}
fn request(store: &FsStore, r: &NodeRevision) -> ArchiveIntermediateSourceRequest {
    ArchiveIntermediateSourceRequest {
        database_id: "default".into(),
        expected_mount: 0,
        path: r.node.path.clone(),
        expected_etag: r.node.etag.clone(),
        expected_node_id: r.node_id.clone(),
        expected_revision: r.revision,
        expected_content_hash: r.content_hash.clone(),
        expected_snapshot_revision: snapshot(store),
        backup_manifest_sha256: "a".repeat(64),
    }
}
#[test]
fn archive_frees_same_database_pages_and_preserves_delta_removal() {
    let (_dir, store) = new_store();
    let (path, r) = fixture(&store, false);
    let req = request(&store, &r);
    let old_snapshot = req.expected_snapshot_revision.clone();
    let result = store.archive_intermediate_source(req).unwrap();
    assert!(result.after.freelist_pages > result.before.freelist_pages + 30);
    assert_eq!(result.after.page_count, result.before.page_count);
    assert!(store.read_node(&path).unwrap().is_none());
    assert!(
        store
            .node_history(NodeHistoryRequest {
                database_id: "default".into(),
                node_id: r.node_id,
                before_revision: None,
                limit: 100
            })
            .unwrap()
            .revisions
            .is_empty()
    );
    let delta = store
        .fetch_updates(FetchUpdatesRequest {
            database_id: "default".into(),
            prefix: Some("/".into()),
            known_snapshot_revision: old_snapshot,
            target_snapshot_revision: None,
            cursor: None,
            limit: 100,
        })
        .unwrap();
    assert!(delta.removed_paths.contains(&path));
    let free = result.after.freelist_pages;
    // Another large write must consume existing free pages, not a new mount/image.
    store
        .write_node(
            WriteNodeRequest {
                database_id: "default".into(),
                path: "/Knowledge/reuse.md".into(),
                kind: NodeKind::File,
                content: "r".repeat(100000),
                metadata_json: "{}".into(),
                expected_etag: None,
            },
            4,
        )
        .unwrap();
    let after = store.storage_page_stats().unwrap();
    assert!(after.freelist_pages < free);
    assert_eq!(after.page_count, result.after.page_count);
}
#[test]
fn stale_snapshot_or_wrong_backup_identity_does_not_remove_any_data() {
    let (_dir, store) = new_store();
    let (path, r) = fixture(&store, false);
    let mut req = request(&store, &r);
    req.expected_revision += 1;
    assert!(store.archive_intermediate_source(req).is_err());
    let req = request(&store, &r);
    write_file(&store, "/Knowledge/new.md", None, 5);
    assert!(store.archive_intermediate_source(req).is_err());
    assert_eq!(store.current_node_revision(&path).unwrap().unwrap(), r);
}
#[test]
fn terminal_and_multiversion_sources_are_rejected() {
    let (_dir, store) = new_store();
    let (path, r) = fixture(&store, true);
    assert!(
        store
            .archive_intermediate_source(request(&store, &r))
            .is_err()
    );
    store
        .write_node(
            WriteNodeRequest {
                database_id: "default".into(),
                path: path.clone(),
                kind: NodeKind::Source,
                content: r.node.content.replace("true", "false"),
                metadata_json: "{}".into(),
                expected_etag: Some(r.node.etag),
            },
            4,
        )
        .unwrap();
    let r = store.current_node_revision(&path).unwrap().unwrap();
    assert!(
        store
            .archive_intermediate_source(request(&store, &r))
            .is_err()
    );
    assert!(store.read_node(&path).unwrap().is_some());
}
#[test]
fn incoming_links_protect_source_and_its_history() {
    let (_dir, store) = new_store();
    let (path, r) = fixture(&store, false);
    store
        .write_node(
            WriteNodeRequest {
                database_id: "default".into(),
                path: "/Knowledge/link.md".into(),
                kind: NodeKind::File,
                content: format!("[source]({path})"),
                metadata_json: "{}".into(),
                expected_etag: None,
            },
            4,
        )
        .unwrap();
    assert!(
        store
            .archive_intermediate_source(request(&store, &r))
            .is_err()
    );
    assert_eq!(store.current_node_revision(&path).unwrap().unwrap(), r);
}

fn publish_using(store: &FsStore, path: &str, source: &NodeRevision) {
    store
        .publish_learning(
            LearningPublicationRequest {
                database_id: "default".into(),
                operation_id: "publication".into(),
                scope_guards: vec![],
                targets: vec![WriteNodeItem {
                    path: "/Knowledge/derived.md".into(),
                    kind: NodeKind::File,
                    content: "derived fact".into(),
                    metadata_json: r#"{"authority":"agent"}"#.into(),
                    expected_etag: None,
                }],
                evidence: vec![RevisionRef {
                    path: path.into(),
                    node_id: source.node_id.clone(),
                    revision: source.revision,
                    etag: source.node.etag.clone(),
                    content_hash: source.content_hash.clone(),
                }],
            },
            3,
        )
        .unwrap();
}

#[test]
fn publication_receipt_protects_old_revision_even_when_current_article_no_longer_links() {
    let (_dir, store) = new_store();
    let (path, r) = fixture(&store, false);
    publish_using(&store, &path, &r);
    assert!(
        store
            .archive_intermediate_source(request(&store, &r))
            .is_err()
    );
    let mut alias = request(&store, &r);
    alias.expected_node_id.insert(0, '0');
    assert!(
        store.archive_intermediate_source(alias).is_err(),
        "alternate spelling of the node identity must preserve publication references"
    );
    assert_eq!(store.current_node_revision(&path).unwrap().unwrap(), r);
}

#[test]
fn large_publication_history_does_not_permanently_block_unreferenced_source() {
    let (dir, store) = new_store();
    let (path, r) = fixture(&store, false);
    let (protected_path, protected) = fixture_with_event_id(&store, false, "later-receipt");
    let mut conn = rusqlite::Connection::open(dir.path().join("wiki.sqlite3")).unwrap();
    let tx = conn.transaction().unwrap();
    for id in 0..257 {
        tx.execute(
            "INSERT INTO learning_publication_commits (operation_id, request_json, result_json)
             VALUES (?1, ?2, '{}')",
            rusqlite::params![id.to_string(), r#"{"evidence":[]}"#],
        )
        .unwrap();
    }
    tx.commit().unwrap();

    let req = request(&store, &r);
    let mut result = store.archive_intermediate_source(req.clone());
    assert!(matches!(&result, Err(error) if error.contains("retry archive to continue")));
    assert!(store.rebuild_start_cursor().is_ok());
    for _ in 0..64 {
        if !matches!(&result, Err(error) if error.contains("retry archive to continue")) {
            break;
        }
        assert_eq!(store.current_node_revision(&path).unwrap().unwrap(), r);
        result = store.archive_intermediate_source(req.clone());
    }
    result.expect("unreferenced source remains eligible after indexing old receipts");
    assert!(store.read_node(&path).unwrap().is_none());

    publish_using(&store, &protected_path, &protected);
    let err = store
        .archive_intermediate_source(request(&store, &protected))
        .unwrap_err();
    assert!(err.contains("retained by a publication receipt"));
    assert_eq!(
        store
            .current_node_revision(&protected_path)
            .unwrap()
            .unwrap(),
        protected
    );
}

#[test]
fn missing_backup_guard_and_late_sql_failure_preserve_source() {
    let (_dir, store) = new_store();
    let (path, r) = fixture(&store, false);
    let mut req = request(&store, &r);
    req.backup_manifest_sha256.clear();
    assert!(store.archive_intermediate_source(req).is_err());
    let conn = rusqlite::Connection::open(_dir.path().join("wiki.sqlite3")).unwrap();
    // A failed late SQL mutation must roll back normal deletion and its FTS/sync work.
    conn.execute_batch("CREATE TRIGGER deny_prune BEFORE DELETE ON fs_node_revisions BEGIN SELECT RAISE(ABORT,'test failure'); END;").unwrap();
    assert!(
        store
            .archive_intermediate_source(request(&store, &r))
            .is_err()
    );
    assert_eq!(store.current_node_revision(&path).unwrap().unwrap(), r);
    conn.execute_batch("DROP TRIGGER deny_prune").unwrap();
    assert!(
        store
            .archive_intermediate_source(request(&store, &r))
            .is_ok()
    );
}
