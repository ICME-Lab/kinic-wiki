use super::*;
fn p(n: u8) -> Principal {
    Principal::from_slice(&[n])
}
fn db() -> Connection {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch(&[SCHEMA, CONTENT_SCHEMA, EXPIRY_SCHEMA].concat())
        .unwrap();
    db
}
fn scope<T>(db: &Connection, n: u8, f: impl FnOnce(&Connection) -> Result<T>) -> T {
    OwnerContext::authenticated(p(n))
        .unwrap()
        .run(db, f)
        .unwrap()
}
fn seed(db: &Connection, n: u8) {
    scope(db, n, |db| {
        let h = Header {
            id: vec![1; 16],
            nonce: vec![n; 32],
            state: VaultState::Active,
            sequence: 0,
            key_name: "test_key_1".into(),
            public_key: vec![1; 96],
        };
        db.execute(
            "INSERT INTO vaults(owner,id,operation,header) VALUES((SELECT owner FROM owner_scope WHERE slot=1),?1,?2,?3)",
            params![h.id, vec![2u8; 16], serde_json::to_string(&h).unwrap()],
        )
        .unwrap();
        Ok(())
    });
}
#[test]
fn sweep_advances_idle_owner_and_wraps_across_reopen() {
    let db = db();
    for n in 1..=3 {
        seed(&db, n);
    }
    scope(&db, 2, |db| {
        content::record(db, &[7; 16], &[8; 32], &true, 1)
    });
    let first = content::maintain_expired(&db, DAY + 2).unwrap().unwrap();
    assert_eq!(first.0, p(1));
    let second = content::maintain_expired(&db, DAY + 2).unwrap().unwrap();
    assert_eq!(second.0, p(2));
    assert_eq!(
        db.query_row("SELECT count(*) FROM receipts", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        content::maintain_expired(&db, DAY + 2).unwrap().unwrap().0,
        p(3)
    );
    assert!(content::maintain_expired(&db, DAY + 2).unwrap().is_none());
    assert_eq!(
        content::maintain_expired(&db, DAY + 2).unwrap().unwrap().0,
        p(1)
    );
}
#[test]
fn gc_retains_pending_key_and_collects_only_completed_old_keys() {
    let db = db();
    seed(&db, 1);
    scope(&db, 1, |db| {
        keys::reserve(db, 1, 1, 10)?;
        keys::mark_sent(db, 1, 10)?;
        content::gc(db, DAY * 2)?;
        assert_eq!(
            db.query_row("SELECT in_flight FROM key_flights", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        keys::settle(db, 1, DAY * 2, 7)?;
        content::gc(db, DAY * 3 + 1)?;
        assert_eq!(
            db.query_row("SELECT count(*) FROM key_flights", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        Ok(())
    });
}
#[test]
fn key_cancellation_retains_paid_work_and_reconciles_late_refund() {
    let db = db();
    seed(&db, 1);
    scope(&db, 1, |db| {
        keys::reserve(db, 1, 1, 20)?;
        keys::mark_sent(db, 1, 20)?;
        assert_eq!(keys::cancel_pending(db, 2)?, Some((1, 20, false)));
        assert_eq!(keys::reserve(db, 2, 2, 20), Err(Error::Busy));
        keys::settle(db, 1, 3, 7)?;
        keys::settle(db, 1, 3, 7)?;
        assert_eq!(keys::settle(db, 1, 3, 8), Err(Error::Conflict));
        keys::reserve(db, 2, 4, 20)?;
        Ok(())
    });
}
#[test]
fn expired_pending_operation_without_live_reservation_releases_capacity() {
    let db = db();
    seed(&db, 1);
    scope(&db, 1, |db| {
        let token = operations::begin(db, &[9; 16], &[3; 32], 1)?;
        operations::collect(db, 302)?;
        assert_eq!(operations::fence(db, &[9; 16], token), Err(Error::Expired));
        Ok(())
    });
}
#[test]
fn creation_context_encodes_all_fields_without_ambiguity() {
    let h = Header {
        id: vec![7; 16],
        nonce: vec![8; 32],
        state: VaultState::Active,
        sequence: 0,
        key_name: "k".into(),
        public_key: vec![],
    };
    let bytes = key_input(p(9), p(1), &h).unwrap();
    assert_eq!(&bytes[..10], &[0, 0, 0, 1, 9, 0, 0, 0, 1, 1]);
    assert_eq!(&bytes[10..14], &[0, 0, 0, 16]);
    assert_eq!(&bytes[30..34], &[0, 0, 0, 32]);
    assert_eq!(&bytes[66..], &[0, 0, 0, 1, b'k']);
    assert_ne!(bytes, key_input(p(10), p(1), &h).unwrap());
    let mut changed = h.clone();
    changed.nonce[0] += 1;
    assert_ne!(bytes, key_input(p(9), p(1), &changed).unwrap());
    changed = h.clone();
    changed.key_name = "other".into();
    assert_ne!(bytes, key_input(p(9), p(1), &changed).unwrap());
}
#[test]
fn vault_plaintext_and_shared_charged_limits_reject_growth() {
    let db = db();
    seed(&db, 1);
    scope(&db, 1, |db| {
        for n in 0u8..10 {
            let object = vec![n; 16];
            db.execute(
                "INSERT INTO objects(owner,vault,object,head) VALUES((SELECT owner FROM owner_scope WHERE slot=1),?1,?2,1)",
                params![vec![1u8; 16], object],
            )
            .unwrap();
            db.execute("INSERT INTO revisions VALUES((SELECT owner FROM owner_scope WHERE slot=1),?1,?2,1,1,NULL,?3,?4,'[]',0,?3)",params![vec![1u8;16],object,FILE_MAX as i64,vec![0u8;64]]).unwrap();
        }
        assert_eq!(content::quota(db, &[1; 16])?.current, 100 * 1024 * 1024);
        let r = BeginRevision {
            vault: vec![1; 16],
            object: vec![99; 16],
            operation: vec![98; 16],
            expected_revision: 0,
            plain_size: 1,
            manifest: vec![0; 64],
            chunk_hashes: vec![vec![0; 32]],
        };
        assert!(matches!(
            content::begin(db, r, 1),
            Err(Error::QuotaExceeded)
        ));
        assert!(matches!(
            content::check_capacity(db, 101 * 1024 * 1024),
            Err(Error::QuotaExceeded)
        ));
        Ok(())
    });
    seed(&db, 2);
    scope(&db, 2, |db| {
        assert!(content::usage(db)? < 1024 * 1024);
        assert!(matches!(
            content::check_capacity(db, 100 * 1024 * 1024),
            Err(Error::QuotaExceeded)
        ));
        Ok(())
    });
}
#[test]
fn control_row_growth_respects_shared_capacity() {
    let db = db();
    seed(&db, 1);
    scope(&db, 1, |db| {
        db.execute("INSERT INTO revisions VALUES((SELECT owner FROM owner_scope WHERE slot=1),?1,?2,1,1,NULL,1,?3,'[]',0,?4)",params![vec![1u8;16],vec![2u8;16],vec![0u8;64],TOTAL_MAX as i64]).unwrap();
        assert_eq!(
            save(db, "derive", &(1u64, vec![1u8; 16])),
            Err(Error::QuotaExceeded)
        );
        Ok(())
    });
}

#[test]
fn review_completed_small_receipts_release_worst_case_reservations() {
    let db = db();
    seed(&db, 1);
    scope(&db, 1, |db| {
        let before = content::usage(db)?;
        for n in 0u16..100 {
            let mut operation = vec![0; 16];
            operation[..2].copy_from_slice(&n.to_be_bytes());
            let token = operations::begin(db, &operation, &[3; 32], 1)?;
            operations::complete(db, &operation, token, &true, 1)?;
        }
        assert!(content::usage(db)? - before < 500_000);
        Ok(())
    });
}
#[test]
fn review_large_result_completion_fits_its_pending_reservation_at_capacity() {
    let db = db();
    seed(&db, 1);
    scope(&db, 1, |db| {
        let token = operations::begin(db, &[9; 16], &[3; 32], 1)?;
        let remaining = TOTAL_MAX - content::global_usage(db)?;
        db.execute("INSERT INTO revisions VALUES((SELECT owner FROM owner_scope WHERE slot=1),?1,?2,1,1,NULL,1,?3,'[]',0,?4)",params![vec![1u8;16],vec![3u8;16],vec![0u8;64],remaining as i64]).unwrap();
        operations::complete(db, &[9; 16], token, &vec![1u8; 120000], 1)?;
        assert!(content::global_usage(db)? <= TOTAL_MAX);
        let replay: Option<Vec<u8>> = operations::replay(db, &[9; 16], &[3; 32], 2)?;
        assert_eq!(replay.unwrap().len(), 120000);
        Ok(())
    });
}
