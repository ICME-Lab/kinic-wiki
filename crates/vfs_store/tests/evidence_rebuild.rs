#[allow(dead_code)]
mod common;
use sha2::{Digest, Sha256};
use vfs_store::{FsStore, RebuildBudget};
use vfs_types::*;
fn sha(s: &str) -> String {
    format!("{:x}", Sha256::digest(s.as_bytes()))
}
#[test]
fn copy_preserves_all_revisions_ids_and_operation_results() {
    let (dir, source) = common::new_store();
    let target = FsStore::new(dir.path().join("target.sqlite"));
    target.run_fs_migrations().unwrap();
    let mut paths = vec![];
    for n in 0..20 {
        let id = format!("event-{n}");
        let path = format!("/Sources/learning-runs/{}/{}.json", sha("run"), sha(&id));
        common::ensure_parent_folders(&source, &path, 1);
        let body=serde_json::json!({"id":id,"run_id":"run","kind":"hook","payload":{"capture":{"event":"PostToolUse","session_evidence":{"records":[{"text":"x".repeat(20_000)},{"text":"x".repeat(20_000)}]}}}}).to_string();
        source
            .write_node(
                WriteNodeRequest {
                    database_id: "default".into(),
                    path: path.clone(),
                    kind: NodeKind::Source,
                    content: body,
                    metadata_json: r#"{"kind":"kinic.learning.evidence"}"#.into(),
                    expected_etag: None,
                },
                10 + n,
            )
            .unwrap();
        paths.push(path);
    }
    let etag = common::write_file(&source, "/Knowledge/old.md", None, 100);
    source
        .delete_node(
            DeleteNodeRequest {
                database_id: "default".into(),
                path: "/Knowledge/old.md".into(),
                expected_etag: Some(etag),
                expected_folder_index_etag: None,
            },
            101,
        )
        .unwrap();
    common::write_file(&source, "/Knowledge/old.md", None, 102);
    let publication = LearningPublicationRequest {
        database_id: "default".into(),
        operation_id: "preserve-operation".into(),
        scope_guards: vec![],
        evidence: vec![],
        targets: vec![WriteNodeItem {
            path: "/Knowledge/decision.md".into(),
            kind: NodeKind::File,
            content: "approved decision".into(),
            metadata_json: r#"{"authority":"agent"}"#.into(),
            expected_etag: None,
        }],
    };
    let published = source.publish_learning(publication.clone(), 110).unwrap();
    let mut cursor = source.begin_rebuild_into(&target).unwrap();
    let budget = RebuildBudget {
        max_rows: 3,
        max_bytes: 65_536,
    };
    for _ in 0..1000 {
        let page = source
            .copy_rebuild_step(&target, &cursor, budget.clone())
            .unwrap();
        let replay = source
            .copy_rebuild_step(&target, &cursor, budget.clone())
            .unwrap();
        assert_eq!(page, replay);
        cursor = page.cursor;
        if page.done {
            break;
        }
    }
    assert_eq!(cursor.table, "complete");
    let mut verify = source.rebuild_start_cursor().unwrap();
    for _ in 0..1000 {
        let page = source
            .verify_rebuild_step(&target, &verify, budget.clone())
            .unwrap();
        verify = page.cursor;
        if page.done {
            break;
        }
    }
    assert_eq!(verify.table, "complete");
    for path in paths {
        assert_eq!(
            source.read_node(&path).unwrap(),
            target.read_node(&path).unwrap()
        );
        let a = source.current_node_revision(&path).unwrap().unwrap();
        let b = target.current_node_revision(&path).unwrap().unwrap();
        assert_eq!(a, b);
        let request = NodeHistoryRequest {
            database_id: "default".into(),
            node_id: a.node_id,
            before_revision: None,
            limit: 100,
        };
        assert_eq!(
            source.node_history(request.clone()).unwrap(),
            target.node_history(request).unwrap()
        );
    }
    assert_eq!(
        target.publish_learning(publication, 111).unwrap(),
        published
    );
    let old_size = source.logical_size_bytes().unwrap();
    let new_size = target.logical_size_bytes().unwrap();
    println!(
        "capacity_measurement: {}",
        serde_json::json!({"fixture":"20 repeated tool snapshots","old_logical_bytes":old_size,"new_logical_bytes":new_size,"old":measured_fixture(source.database_path()),"new":measured_fixture(target.database_path()),"stable_physical_bytes":null})
    );
    assert!(new_size < old_size / 2);
}
#[test]
fn copy_resumes_idempotently_and_rejects_schema_or_hash_drift() {
    let (dir, source) = common::new_store();
    common::write_file(&source, "/Knowledge/a.md", None, 1);
    let target = FsStore::new(dir.path().join("target.sqlite"));
    target.run_fs_migrations().unwrap();
    assert!(source.begin_rebuild_into(&source).is_err());
    let cursor = source.begin_rebuild_into(&target).unwrap();
    let budget = RebuildBudget {
        max_rows: 3,
        max_bytes: 65_536,
    };
    let first = source
        .copy_rebuild_step(&target, &cursor, budget.clone())
        .unwrap();
    let target = FsStore::new(dir.path().join("target.sqlite"));
    assert_eq!(
        source
            .copy_rebuild_step(&target, &cursor, budget.clone())
            .unwrap(),
        first
    );
    common::write_file(&source, "/Knowledge/new.md", None, 2);
    assert!(
        source
            .copy_rebuild_step(&target, &first.cursor, budget)
            .is_err()
    );
}

#[test]
fn rebuild_refuses_unknown_schema_budget_overrun_and_corrupt_target() {
    let (dir, source) = common::new_store();
    common::write_file(&source, "/Knowledge/a.md", None, 1);
    let target = FsStore::new(dir.path().join("target.sqlite"));
    target.run_fs_migrations().unwrap();
    let start = source.begin_rebuild_into(&target).unwrap();
    assert!(
        source
            .copy_rebuild_step(
                &target,
                &start,
                RebuildBudget {
                    max_rows: 3,
                    max_bytes: 1
                }
            )
            .is_err()
    );
    let budget = RebuildBudget {
        max_rows: 3,
        max_bytes: 65_536,
    };
    let mut cursor = start.clone();
    for _ in 0..1000 {
        let page = source
            .copy_rebuild_step(&target, &cursor, budget.clone())
            .unwrap();
        cursor = page.cursor;
        if page.done {
            break;
        }
    }
    let db = rusqlite::Connection::open(target.database_path()).unwrap();
    db.execute(
        "UPDATE fs_nodes SET content='tampered' WHERE path='/Knowledge/a.md'",
        [],
    )
    .unwrap();
    drop(db);
    let mut cursor = start;
    let mut refused = false;
    for _ in 0..1000 {
        match source.verify_rebuild_step(&target, &cursor, budget.clone()) {
            Ok(p) => {
                cursor = p.cursor;
                if p.done {
                    break;
                }
            }
            Err(_) => {
                refused = true;
                break;
            }
        }
    }
    assert!(refused);
    let db = rusqlite::Connection::open(source.database_path()).unwrap();
    db.execute("CREATE TABLE unknown_records(body TEXT)", [])
        .unwrap();
    drop(db);
    assert!(source.rebuild_start_cursor().is_err());
}

fn measured_fixture(path: &std::path::Path) -> serde_json::Value {
    let db = rusqlite::Connection::open(path).unwrap();
    let scalar = |sql: &str| db.query_row(sql, [], |r| r.get::<_, u64>(0)).unwrap();
    serde_json::json!({
        "page_count":scalar("PRAGMA page_count"),"page_size":scalar("PRAGMA page_size"),"freelist_count":scalar("PRAGMA freelist_count"),
        "current_stored_bytes":scalar("SELECT COALESCE(SUM(length(CAST(content AS BLOB))),0) FROM fs_nodes"),
        "history_stored_bytes":scalar("SELECT COALESCE(SUM(length(CAST(content AS BLOB))),0) FROM fs_node_revisions"),
        "shared_record_bytes":scalar("SELECT COALESCE(SUM(length(CAST(body AS BLOB))),0) FROM fs_evidence_blobs"),
        "manifest_bytes":scalar("SELECT COALESCE(SUM(length(CAST(manifest_json AS BLOB))),0) FROM fs_evidence_manifests"),
        "fts_index_block_bytes":scalar("SELECT COALESCE(SUM(length(block)),0) FROM fs_nodes_fts_data"),
        "fts_total_table_page_bytes":null,"canister_stable_bytes":null,
    })
}
