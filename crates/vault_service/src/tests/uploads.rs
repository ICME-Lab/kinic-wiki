use super::*;

#[test]
fn upload_lost_replies_commit_and_expected_revision_are_atomic() {
    let e = Env::new();
    e.create();
    let r = e.begin();
    let put = Action::PutChunk {
        upload: r.operation.clone(),
        index: 0,
        bytes: vec![7; 17],
    };
    e.change(6, put.clone()).unwrap();
    e.change(6, put).unwrap();
    assert!(matches!(
        e.change(
            6,
            Action::PutChunk {
                upload: r.operation.clone(),
                index: 0,
                bytes: vec![8; 17]
            }
        ),
        Err(Error::Conflict)
    ));
    let action = Action::CommitRevision {
        upload: r.operation.clone(),
    };
    let first = e.change(7, action.clone()).unwrap();
    let retry = e.change(7, action).unwrap();
    assert_eq!(
        candid::encode_one(first).unwrap(),
        candid::encode_one(retry).unwrap()
    );
    assert!(matches!(
        e.transaction(|db| store::content::upload_status(db, &r.operation, e.now()))
            .unwrap(),
        UploadStatus::Committed(_)
    ));
    assert!(matches!(
        e.change(
            8,
            Action::DeleteObject {
                vault: r.vault.clone(),
                object: r.object.clone(),
                expected_revision: 0
            }
        ),
        Err(Error::Conflict)
    ));
    e.owner.set(Principal::from_slice(&[2]));
    assert!(matches!(
        e.transaction(|db| store::content::manifest(db, &r.vault, &r.object, 0)),
        Err(Error::NotFound)
    ));
}
#[test]
fn admitted_upload_can_finish_when_other_work_consumes_shared_headroom() {
    let e = Env::new();
    e.create();
    let r = e.begin();
    e.transaction(|db|{let fill=TOTAL_MAX-store::content::global_usage(db)?;db.execute("INSERT INTO revisions VALUES((SELECT owner FROM owner_scope WHERE slot=1),?1,?2,1,1,NULL,1,?3,'[]',0,?4)",params![vault_id(1),vec![99u8;16],vec![0u8;64],fill as i64]).unwrap();assert_eq!(store::content::global_usage(db)?,TOTAL_MAX);Ok(())}).unwrap();
    assert!(matches!(
        e.change(
            6,
            Action::PutChunk {
                upload: r.operation.clone(),
                index: 0,
                bytes: vec![7; 17]
            }
        ),
        Ok(MutationResult::Done)
    ));
    assert!(matches!(
        e.change(
            8,
            Action::PutChunk {
                upload: r.operation.clone(),
                index: 0,
                bytes: vec![7; 17]
            }
        ),
        Err(Error::QuotaExceeded)
    ));
    assert!(matches!(
        e.change(
            6,
            Action::PutChunk {
                upload: r.operation.clone(),
                index: 0,
                bytes: vec![7; 17]
            }
        ),
        Ok(MutationResult::Done)
    ));
    assert!(matches!(
        e.change(
            7,
            Action::CommitRevision {
                upload: r.operation
            }
        ),
        Ok(MutationResult::Revision(_))
    ));
}
#[test]
fn fresh_id_duplicate_chunk_preserves_all_remaining_prepaid_receipts() {
    let e = Env::new();
    e.create();
    let first = vec![7u8; CHUNK_MAX];
    let last = vec![8u8; 17];
    let r = BeginRevision {
        vault: vault_id(1),
        object: vec![3; 16],
        operation: vec![4; 16],
        expected_revision: 0,
        plain_size: 1024 * 1024 + 1,
        manifest: vec![1; 64],
        chunk_hashes: vec![
            Sha256::digest(&first).to_vec(),
            Sha256::digest(&last).to_vec(),
        ],
    };
    e.change(5, Action::BeginRevision(r.clone())).unwrap();
    e.change(
        6,
        Action::PutChunk {
            upload: r.operation.clone(),
            index: 0,
            bytes: first.clone(),
        },
    )
    .unwrap();
    e.change(
        8,
        Action::PutChunk {
            upload: r.operation.clone(),
            index: 0,
            bytes: first,
        },
    )
    .unwrap();
    e.transaction(|db|{assert_eq!(db.query_row("SELECT receipt_budget FROM uploads",[],|r|r.get::<_,i64>(0)).unwrap(),2*ops::CHARGE as i64);let fill=TOTAL_MAX-store::content::global_usage(db)?;db.execute("INSERT INTO revisions VALUES((SELECT owner FROM owner_scope WHERE slot=1),?1,?2,1,1,NULL,1,?3,'[]',0,?4)",params![vault_id(1),vec![99u8;16],vec![0u8;64],fill as i64]).unwrap();Ok(())}).unwrap();
    e.change(
        9,
        Action::PutChunk {
            upload: r.operation.clone(),
            index: 1,
            bytes: last,
        },
    )
    .unwrap();
    assert!(matches!(
        e.change(
            10,
            Action::CommitRevision {
                upload: r.operation
            }
        ),
        Ok(MutationResult::Revision(_))
    ));
}
#[test]
fn admitted_upload_receipt_slots_survive_full_journal() {
    let e = Env::new();
    e.create();
    let r = e.begin();
    e.transaction(|db|{let used:i64=db.query_row("SELECT (SELECT count(*) FROM operations WHERE admission=0)+(SELECT COALESCE(sum(1+receipt_budget/131072),0) FROM uploads)",[],|r|r.get(0)).unwrap();db.execute("WITH RECURSIVE n(x) AS(SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<?1) INSERT INTO operations(owner,operation,digest,result,expires,token,runtime,admission) SELECT (SELECT owner FROM owner_scope WHERE slot=1),CAST(printf('%016d',x) AS BLOB),zeroblob(32),X'00',?2,x+100,0,0 FROM n",params![10000-used,(e.now()+DAY) as i64]).unwrap();Ok(())}).unwrap();
    e.change(
        6,
        Action::PutChunk {
            upload: r.operation.clone(),
            index: 0,
            bytes: vec![7; 17],
        },
    )
    .unwrap();
    assert!(matches!(
        e.change(
            7,
            Action::CommitRevision {
                upload: r.operation
            }
        ),
        Ok(MutationResult::Revision(_))
    ));
}

#[test]
fn delete_replays_only_its_request_journal_and_never_becomes_an_upload_outcome() {
    let e = Env::new();
    e.create();
    let r = e.begin();
    e.change(
        6,
        Action::PutChunk {
            upload: r.operation.clone(),
            index: 0,
            bytes: vec![7; 17],
        },
    )
    .unwrap();
    let committed = e
        .change(
            7,
            Action::CommitRevision {
                upload: r.operation.clone(),
            },
        )
        .unwrap();
    let delete = Action::DeleteObject {
        vault: r.vault.clone(),
        object: r.object.clone(),
        expected_revision: 1,
    };
    let deleted = e.change(8, delete.clone()).unwrap();
    assert_eq!(
        candid::encode_one(e.change(8, delete).unwrap()).unwrap(),
        candid::encode_one(deleted).unwrap()
    );
    assert_eq!(
        e.change(
            8,
            Action::DeleteObject {
                vault: r.vault.clone(),
                object: r.object.clone(),
                expected_revision: 2
            }
        )
        .unwrap_err(),
        Error::Conflict
    );
    e.transaction(|db| {
        assert_eq!(
            db.query_row(
                "SELECT count(*) FROM operations WHERE operation=?1",
                params![vec![8u8; 16]],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
        assert_eq!(
            db.query_row("SELECT count(*) FROM upload_outcomes", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert!(matches!(
            store::content::upload_status(db, &[8; 16], e.now())?,
            UploadStatus::Absent
        ));
        assert!(matches!(
            store::content::upload_status(db, &r.operation, e.now())?,
            UploadStatus::Committed(_)
        ));
        Ok(())
    })
    .unwrap();
    // Upload reconciliation returns the original committed revision after the head advances.
    assert_eq!(
        candid::encode_one(
            e.change(
                9,
                Action::CommitRevision {
                    upload: r.operation.clone()
                }
            )
            .unwrap()
        )
        .unwrap(),
        candid::encode_one(committed).unwrap()
    );
    assert!(matches!(
        e.change(10, Action::BeginRevision(r.clone())),
        Ok(MutationResult::Upload(Upload { expires: 0, .. }))
    ));
    let mut changed = r;
    changed.manifest[0] ^= 1;
    assert_eq!(
        e.change(11, Action::BeginRevision(changed)).unwrap_err(),
        Error::Conflict
    );
}

#[test]
fn expired_upload_gc_keeps_typed_cancellation_and_terminal_retry_binding() {
    let e = Env::new();
    e.create();
    let r = e.begin();
    e.now.set(e.now() + DAY);
    e.transaction(|db| {
        assert!(matches!(
            store::content::upload_status(db, &r.operation, e.now())?,
            UploadStatus::Expired
        ));
        store::content::gc(db, e.now())?;
        assert!(matches!(
            store::content::upload_status(db, &r.operation, e.now())?,
            UploadStatus::Cancelled
        ));
        assert_eq!(
            store::content::begin(db, r.clone(), e.now()).unwrap_err(),
            Error::Conflict
        );
        assert_eq!(
            store::content::commit(db, &r.operation, e.now()).unwrap_err(),
            Error::Conflict
        );
        assert!(store::content::cancel_upload_batch(
            db,
            &r.vault,
            &r.operation,
            &r.operation,
            e.now()
        )?);
        assert_eq!(
            store::content::cancel_upload_batch(db, &r.vault, &r.operation, &[90; 16], e.now()),
            Err(Error::Conflict)
        );
        let raw: String = db
            .query_row("SELECT result FROM upload_outcomes", [], |r| r.get(0))
            .unwrap();
        assert!(
            serde_json::from_str::<serde_json::Value>(&raw)
                .unwrap()
                .get("Cancelled")
                .is_some()
        );
        assert!(matches!(
            store::content::upload_status(db, &r.operation, e.now() + DAY)?,
            UploadStatus::Absent
        ));
        Ok(())
    })
    .unwrap();
}
