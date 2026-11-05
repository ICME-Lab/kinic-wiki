use sha2::{Digest, Sha256};
use tempfile::TempDir;
use vfs_runtime::VfsService;
use vfs_types::*;
fn sha(s: &str) -> String {
    format!("{:x}", Sha256::digest(s.as_bytes()))
}
fn setup() -> (TempDir, VfsService) {
    let dir = tempfile::tempdir().unwrap();
    let s = VfsService::new(dir.path().join("index.sqlite"), dir.path().join("dbs"));
    s.run_index_migrations().unwrap();
    s.create_database("memo", "owner", 1).unwrap();
    (dir, s)
}
fn write(s: &VfsService, path: &str, body: &str) {
    s.write_node(
        "owner",
        WriteNodeRequest {
            database_id: "memo".into(),
            path: path.into(),
            kind: NodeKind::File,
            content: body.into(),
            metadata_json: "{}".into(),
            expected_etag: None,
        },
        2,
    )
    .unwrap();
}
fn begin(s: &VfsService) -> EvidenceRebuildStatus {
    let idle = s.evidence_rebuild_status("memo").unwrap();
    s.evidence_rebuild_begin(
        EvidenceRebuildRequest {
            database_id: "memo".into(),
            expected_source_mount: idle.source_mount,
            expected_schema: "vfs_store:005_evidence_storage".into(),
        },
        10,
    )
    .unwrap()
}
#[test]
fn maintenance_gate_blocks_all_content_mutations_before_charging() {
    let (_dir, s) = setup();
    write(&s, "/Knowledge/a.md", "original");
    let status = begin(&s);
    assert_eq!(status.phase, "Copying");
    assert!(
        s.begin_database_cycles_purchase("memo", "owner", 1_000_000, 20)
            .is_ok()
    );
    assert!(
        s.prepare_node_mutation("memo", "owner")
            .unwrap_err()
            .message
            .contains("maintenance")
    );
    assert!(
        s.write_node(
            "owner",
            WriteNodeRequest {
                database_id: "memo".into(),
                path: "/Knowledge/b.md".into(),
                kind: NodeKind::File,
                content: "blocked".into(),
                metadata_json: "{}".into(),
                expected_etag: None
            },
            20
        )
        .is_err()
    );
    assert!(
        s.write_nodes(
            "owner",
            WriteNodesRequest {
                database_id: "memo".into(),
                nodes: vec![WriteNodeItem {
                    path: "/Knowledge/b.md".into(),
                    kind: NodeKind::File,
                    content: "blocked".into(),
                    metadata_json: "{}".into(),
                    expected_etag: None
                }]
            },
            20
        )
        .is_err()
    );
    assert_eq!(
        s.read_node("memo", "owner", "/Knowledge/a.md")
            .unwrap()
            .unwrap()
            .content,
        "original"
    );
    assert!(
        s.grant_database_access("memo", "owner", "new-reader", DatabaseRole::Reader, 20)
            .is_err()
    );
}
fn populate(s: &VfsService) {
    let run = sha("run");
    for p in [
        "/Sources/learning-runs".to_owned(),
        format!("/Sources/learning-runs/{run}"),
    ] {
        s.mkdir_node(
            "owner",
            MkdirNodeRequest {
                database_id: "memo".into(),
                path: p,
            },
            2,
        )
        .unwrap();
    }
    for n in 0..20 {
        let id = format!("e{n}");
        let path = format!("/Sources/learning-runs/{run}/{}.json", sha(&id));
        let body=serde_json::json!({"id":id,"run_id":"run","kind":"hook","payload":{"capture":{"session_evidence":{"records":[{"text":"x".repeat(20000)},{"text":"x".repeat(20000)}]}}}}).to_string();
        s.write_node(
            "owner",
            WriteNodeRequest {
                database_id: "memo".into(),
                path,
                kind: NodeKind::Source,
                content: body,
                metadata_json: r#"{"kind":"kinic.learning.evidence"}"#.into(),
                expected_etag: None,
            },
            3 + n,
        )
        .unwrap();
    }
}
fn ready(s: &VfsService, mut state: EvidenceRebuildStatus) -> EvidenceRebuildStatus {
    for _ in 0..1000 {
        if state.phase == "Ready" {
            return state;
        }
        let r = EvidenceRebuildStepRequest {
            database_id: "memo".into(),
            migration_id: state.migration_id.clone(),
            expected_step: state.step,
            max_rows: 3,
            max_bytes: 65536,
        };
        state = if state.phase == "Copying" {
            s.evidence_rebuild_step(r).unwrap()
        } else {
            s.evidence_rebuild_verify(r).unwrap()
        };
    }
    panic!("not ready");
}
fn control(state: &EvidenceRebuildStatus) -> EvidenceRebuildControlRequest {
    EvidenceRebuildControlRequest {
        database_id: "memo".into(),
        migration_id: state.migration_id.clone(),
        expected_state_hash: state.state_hash.clone(),
    }
}
#[test]
fn activation_preserves_catalog_acl_and_blocks_stale_control() {
    let (_dir, s) = setup();
    populate(&s);
    s.grant_database_access("memo", "owner", "reader", DatabaseRole::Reader, 2)
        .unwrap();
    let state = ready(&s, begin(&s));
    let stale = control(&state);
    let active = s.evidence_rebuild_activate(stale.clone()).unwrap();
    assert_eq!(active.phase, "ActivatedReadOnly");
    assert_ne!(active.source_mount, active.target_mount);
    assert!(s.read_node("memo", "reader", "/Sources").unwrap().is_some());
    assert!(s.evidence_rebuild_resume_writes(stale).is_err());
    let rolled = s.evidence_rebuild_rollback(control(&active)).unwrap();
    assert_eq!(rolled.phase, "Aborted");
    write(&s, "/Knowledge/after-rollback.md", "still source");
}
#[test]
fn post_resume_rollback_is_refused_without_losing_new_writes() {
    let (dir, s) = setup();
    populate(&s);
    let state = ready(&s, begin(&s));
    let active = s.evidence_rebuild_activate(control(&state)).unwrap();
    let resumed = s.evidence_rebuild_resume_writes(control(&active)).unwrap();
    assert_eq!(resumed.phase, "Active");
    write(&s, "/Knowledge/new.md", "new data");
    assert!(s.evidence_rebuild_rollback(control(&resumed)).is_err());
    let reopened = VfsService::new(dir.path().join("index.sqlite"), dir.path().join("dbs"));
    reopened.run_index_migrations().unwrap();
    reopened.run_database_migrations("memo").unwrap();
    assert_eq!(
        reopened
            .read_node("memo", "owner", "/Knowledge/new.md")
            .unwrap()
            .unwrap()
            .content,
        "new data"
    );
}

#[test]
fn committed_destination_survives_index_failure_and_begin_retry() {
    let (dir, s) = setup();
    populate(&s);
    let db = rusqlite::Connection::open(dir.path().join("index.sqlite")).unwrap();
    db.execute_batch("CREATE TRIGGER fail_begin_receipt BEFORE UPDATE ON database_maintenance WHEN NEW.last_operation='begin' BEGIN SELECT RAISE(ABORT,'injected index failure'); END;").unwrap();
    let idle = s.evidence_rebuild_status("memo").unwrap();
    let r = EvidenceRebuildRequest {
        database_id: "memo".into(),
        expected_source_mount: idle.source_mount,
        expected_schema: idle.source_schema,
    };
    assert!(s.evidence_rebuild_begin(r.clone(), 10).is_err());
    assert_eq!(s.evidence_rebuild_status("memo").unwrap().phase, "Gated");
    assert!(s.prepare_node_mutation("memo", "owner").is_err());
    db.execute("DROP TRIGGER fail_begin_receipt", []).unwrap();
    let state = s.evidence_rebuild_begin(r, 10).unwrap();
    assert_eq!(state.phase, "Copying");
    db.execute_batch("CREATE TRIGGER fail_copy_receipt BEFORE UPDATE ON database_maintenance WHEN NEW.last_operation='copy' BEGIN SELECT RAISE(ABORT,'injected index failure'); END;").unwrap();
    let step = EvidenceRebuildStepRequest {
        database_id: "memo".into(),
        migration_id: state.migration_id,
        expected_step: state.step,
        max_rows: 3,
        max_bytes: 65536,
    };
    assert!(s.evidence_rebuild_step(step.clone()).is_err());
    db.execute("DROP TRIGGER fail_copy_receipt", []).unwrap();
    drop(db);
    let a = s.evidence_rebuild_step(step.clone()).unwrap();
    let b = s.evidence_rebuild_step(step).unwrap();
    assert_eq!(a, b);
    assert_eq!(ready(&s, a).phase, "Ready");
}
