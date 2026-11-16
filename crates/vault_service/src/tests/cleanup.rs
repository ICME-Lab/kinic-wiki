use super::*;

#[test]
fn vault_deletion_batches_small_chunks_and_metadata_with_bounded_work() {
    let e = Env::new();
    e.create();
    e.transaction(|db|{for n in 0u8..20 {let object=vec![n;16];db.execute("INSERT INTO objects(owner,vault,object,head) VALUES((SELECT owner FROM owner_scope WHERE slot=1),?1,?2,1)",params![vec![1u8;16],object]).unwrap();db.execute("INSERT INTO revisions VALUES((SELECT owner FROM owner_scope WHERE slot=1),?1,?2,1,1,NULL,1,?3,'[]',0,4096)",params![vec![1u8;16],object,vec![0u8;64]]).unwrap();db.execute("INSERT INTO revision_chunks VALUES((SELECT owner FROM owner_scope WHERE slot=1),?1,?2,1,0,?3)",params![vec![1u8;16],object,vec![0u8;17]]).unwrap();}db.execute("UPDATE vaults SET cleanup_budget=61",[]).unwrap();Ok(())}).unwrap();
    for n in 40..43 {
        assert!(matches!(
            e.change(n, Action::DeleteVault { vault: vec![1; 16] }),
            Ok(MutationResult::Progress(false))
        ));
    }
    assert!(matches!(
        e.change(43, Action::DeleteVault { vault: vec![1; 16] }),
        Ok(MutationResult::Progress(true))
    ));
    assert!(e.transaction(store::list).unwrap().is_empty());
    assert!(matches!(
        block_on(create_vault(
            &e,
            CreateVault {
                vault: vec![1; 16],
                operation: vec![45; 16]
            }
        )),
        Err(Error::Conflict)
    ));
}
#[test]
fn review_empty_unfunded_collect_cannot_allocate_cleanup_receipts() {
    let e = Env::new();
    e.funded.set(false);
    for owner in 80..82 {
        e.owner.set(Principal::from_slice(&[owner + 10]));
        for n in 0u16..512 {
            let mut operation = vec![0; 16];
            operation[..2].copy_from_slice(&n.to_be_bytes());
            assert!(
                mutate(
                    &e,
                    Mutation {
                        operation,
                        action: Action::Collect
                    }
                )
                .is_err()
            );
        }
    }
    assert_eq!(
        e.db.borrow()
            .query_row("SELECT count(*) FROM operations", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
}
#[test]
fn review_resource_cleanup_survives_other_owners_full_cleanup_pool() {
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
    e.transaction(|db|{db.execute("WITH RECURSIVE n(x) AS(SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1024) INSERT INTO operations(owner,operation,digest,result,expires,token,runtime,admission) SELECT X'50',CAST(printf('%016d',x) AS BLOB),zeroblob(32),X'00',?1,x,0,1 FROM n",params![(e.now()+DAY) as i64]).unwrap();db.execute("UPDATE uploads SET reserved=?1",params![TOTAL_MAX as i64]).unwrap();Ok(())}).unwrap();
    e.funded.set(false);
    let action = Action::CancelUpload {
        vault: r.vault.clone(),
        upload: r.operation,
        job: vec![30; 16],
    };
    assert!(matches!(
        e.change(31, action.clone()),
        Ok(MutationResult::Progress(false))
    ));
    assert!(matches!(
        e.change(32, action.clone()),
        Ok(MutationResult::Progress(true))
    ));
    assert!(matches!(
        e.change(32, action.clone()),
        Ok(MutationResult::Progress(true))
    ));
    assert!(e.change(33, action).is_err());
    assert!(matches!(
        e.change(
            34,
            Action::DeleteVault {
                vault: r.vault.clone()
            }
        ),
        Ok(MutationResult::Progress(true))
    ));
    assert!(
        e.change(35, Action::DeleteVault { vault: r.vault })
            .is_err()
    );
}

#[test]
fn review_no_work_collect_preserves_vault_completion_budget() {
    let e = Env::new();
    e.create();
    e.funded.set(false);
    for n in 30..100 {
        assert!(matches!(e.change(n, Action::Collect), Err(Error::NotFound)));
    }
    e.transaction(|db| {
        assert_eq!(
            db.query_row("SELECT cleanup_budget FROM vaults", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            db.query_row("SELECT count(*) FROM operations", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        Ok(())
    })
    .unwrap();
    assert!(matches!(
        e.change(100, Action::DeleteVault { vault: vec![1; 16] }),
        Ok(MutationResult::Progress(true))
    ));
}
#[test]
fn review_expired_upload_collection_survives_full_unreserved_pool() {
    let e = Env::new();
    e.create();
    e.begin();
    e.transaction(|db|{db.execute("WITH RECURSIVE n(x) AS(SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1024) INSERT INTO operations(owner,operation,digest,result,expires,token,runtime,admission) SELECT X'50',CAST(printf('%016d',x) AS BLOB),zeroblob(32),X'00',?1,x,0,1 FROM n",params![(e.now()+3*DAY) as i64]).unwrap();Ok(())}).unwrap();
    e.now.set(e.now() + DAY);
    e.funded.set(false);
    assert!(matches!(
        e.change(60, Action::Collect),
        Ok(MutationResult::Collected(0))
    ));
    e.transaction(|db| {
        assert_eq!(
            db.query_row("SELECT count(*) FROM uploads", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
        Ok(())
    })
    .unwrap();
}
#[test]
fn review_cleanup_credits_follow_commit_retirement_tombstone_and_deletion() {
    let e = Env::new();
    e.create();
    for n in 0u8..11 {
        let id = 20 + n * 3;
        let r = BeginRevision {
            vault: vec![1; 16],
            object: vec![3; 16],
            operation: vec![id; 16],
            expected_revision: n as u64,
            plain_size: 1,
            manifest: vec![1; 64],
            chunk_hashes: vec![Sha256::digest([7; 17]).to_vec()],
        };
        e.change(id, Action::BeginRevision(r.clone())).unwrap();
        e.change(
            id + 1,
            Action::PutChunk {
                upload: r.operation.clone(),
                index: 0,
                bytes: vec![7; 17],
            },
        )
        .unwrap();
        e.change(
            id + 2,
            Action::CommitRevision {
                upload: r.operation,
            },
        )
        .unwrap();
    }
    let budget = || {
        e.transaction(|db| {
            db.query_row("SELECT cleanup_budget FROM vaults", [], |r| {
                r.get::<_, i64>(0)
            })
            .map_err(|_| Error::Storage)
        })
        .unwrap()
    };
    assert_eq!(budget(), 24);
    assert!(matches!(
        e.change(60, Action::Collect),
        Ok(MutationResult::Collected(1))
    ));
    assert_eq!(budget(), 22);
    e.change(
        61,
        Action::DeleteObject {
            vault: vec![1; 16],
            object: vec![3; 16],
            expected_revision: 11,
        },
    )
    .unwrap();
    assert_eq!(budget(), 23);
    e.funded.set(false);
    for (id, remaining) in [(70, 13), (71, 2), (72, 1), (73, 0)] {
        assert!(
            matches!(e.change(id,Action::DeleteVault{vault:vec![1;16]}),Ok(MutationResult::Progress(done)) if done==(remaining==0))
        );
        assert_eq!(budget(), remaining);
    }
    assert!(matches!(
        e.change(73, Action::DeleteVault { vault: vec![1; 16] }),
        Ok(MutationResult::Progress(true))
    ));
    let count = || {
        e.transaction(|db| {
            db.query_row(
                "SELECT count(*) FROM operations WHERE admission=2",
                [],
                |r| r.get::<_, i64>(0),
            )
            .map_err(|_| Error::Storage)
        })
        .unwrap()
    };
    let before = count();
    assert!(
        e.change(74, Action::DeleteVault { vault: vec![1; 16] })
            .is_err()
    );
    assert_eq!(count(), before);
    assert_eq!(budget(), 0);
}

#[test]
fn review_purge_hides_history_and_reclaims_boundedly_without_credit() {
    let e = Env::new();
    let r = committed_document(&e);
    for revision in 1u8..11 {
        let id = 100 + revision * 3;
        let mut next = r.clone();
        next.operation = vec![id; 16];
        next.expected_revision = revision as u64;
        e.change(id, Action::BeginRevision(next.clone())).unwrap();
        e.change(
            id + 1,
            Action::PutChunk {
                upload: next.operation.clone(),
                index: 0,
                bytes: vec![7; 17],
            },
        )
        .unwrap();
        e.change(
            id + 2,
            Action::CommitRevision {
                upload: next.operation,
            },
        )
        .unwrap();
    }
    let action = Action::PurgeObject {
        vault: r.vault.clone(),
        object: r.object.clone(),
        expected_revision: 11,
    };
    e.transaction(|db|{db.execute("WITH RECURSIVE n(x) AS(SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1024) INSERT INTO operations(owner,operation,digest,result,expires,token,runtime,admission) SELECT X'50',CAST(printf('%016d',x) AS BLOB),zeroblob(32),X'00',?1,x,0,1 FROM n",params![(e.now()+DAY) as i64]).unwrap();Ok(())}).unwrap();
    e.funded.set(false);
    assert!(matches!(
        e.change(60, action.clone()),
        Ok(MutationResult::Done)
    ));
    assert!(matches!(
        e.change(60, action.clone()),
        Ok(MutationResult::Done)
    ));
    assert!(matches!(e.change(61, action), Err(Error::Conflict)));
    e.transaction(|db| {
        for revision in 1..=11 {
            assert!(matches!(
                store::content::manifest(db, &r.vault, &r.object, revision),
                Err(Error::NotFound)
            ));
        }
        assert!(matches!(
            store::content::chunk(db, &r.vault, &r.object, 1, 0),
            Err(Error::NotFound)
        ));
        assert!(
            store::content::history(db, &r.vault, &r.object, u64::MAX)?
                .entries
                .is_empty()
        );
        assert!(
            store::content::objects(db, &r.vault, &[])?
                .entries
                .is_empty()
        );
        assert_eq!(store::content::quota(db, &r.vault)?.current, 0);
        Ok(())
    })
    .unwrap();
    let before = e.transaction(store::content::usage).unwrap();
    assert!(matches!(
        e.change(62, Action::Collect),
        Ok(MutationResult::Collected(1))
    ));
    assert!(e.transaction(store::content::usage).unwrap() < before);
    e.transaction(|db| {
        assert_eq!(
            db.query_row("SELECT count(*) FROM revisions", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            10
        );
        Ok(())
    })
    .unwrap();
    for id in 150..160 {
        assert!(matches!(
            e.change(id, Action::Collect),
            Ok(MutationResult::Collected(1))
        ));
    }
    e.funded.set(true);
    for expected in [0, 11] {
        let mut next = r.clone();
        next.operation = vec![80; 16];
        next.expected_revision = expected;
        assert!(matches!(
            e.change(80, Action::BeginRevision(next)),
            Err(Error::Conflict)
        ));
    }
    e.transaction(|db| {
        assert_eq!(
            db.query_row("SELECT count(*) FROM revision_chunks", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            db.query_row("SELECT head FROM objects", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            11
        );
        Ok(())
    })
    .unwrap();
    e.funded.set(false);
    assert!(matches!(
        e.change(
            90,
            Action::DeleteVault {
                vault: r.vault.clone()
            }
        ),
        Ok(MutationResult::Progress(false))
    ));
    assert!(matches!(
        e.change(91, Action::DeleteVault { vault: r.vault }),
        Ok(MutationResult::Progress(true))
    ));
}
#[test]
fn review_purge_fences_revision_owner_and_active_upload() {
    let e = Env::new();
    let r = committed_document(&e);
    let action = Action::PurgeObject {
        vault: r.vault.clone(),
        object: r.object.clone(),
        expected_revision: 1,
    };
    assert!(matches!(
        e.change(
            60,
            Action::PurgeObject {
                vault: r.vault.clone(),
                object: r.object.clone(),
                expected_revision: 0
            }
        ),
        Err(Error::Conflict)
    ));
    e.owner.set(Principal::from_slice(&[2]));
    assert!(e.change(61, action.clone()).is_err());
    e.owner.set(Principal::from_slice(&[1]));
    let mut next = r.clone();
    next.operation = vec![70; 16];
    next.expected_revision = 1;
    e.change(71, Action::BeginRevision(next.clone())).unwrap();
    assert!(matches!(e.change(62, action.clone()), Err(Error::Conflict)));
    e.change(
        72,
        Action::CancelUpload {
            vault: r.vault.clone(),
            upload: next.operation,
            job: vec![73; 16],
        },
    )
    .unwrap();
    assert!(matches!(e.change(62, action), Ok(MutationResult::Done)));
    assert!(matches!(
        e.change(
            62,
            Action::PurgeObject {
                vault: r.vault,
                object: r.object,
                expected_revision: 2
            }
        ),
        Err(Error::Conflict)
    ));
}

#[test]
fn review_collect_records_progress_when_only_expired_receipt_remains() {
    let e = Env::new();
    e.create();
    e.now.set(e.now() + DAY + 1);
    e.funded.set(false);
    assert!(matches!(
        e.change(60, Action::Collect),
        Ok(MutationResult::Collected(0))
    ));
    assert!(matches!(
        e.change(61, Action::Collect),
        Err(Error::NotFound)
    ));
}
