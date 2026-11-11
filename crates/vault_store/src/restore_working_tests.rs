use super::*;
fn request(v: u8) -> BeginRestore {
    BeginRestore {
        header: Header {
            id: vec![v; 16],
            epoch: 0,
            generation: None,
            recovery_verifier: vec![],
            state: VaultState::Restoring,
            normal: None,
            recovery: Some(Envelope {
                version: 1,
                nonce: vec![1; 12],
                ciphertext: vec![2; 48],
            }),
            sequence: 1,
            backup_sequence: None,
            backup_at: None,
            key_name: "test_key_1".into(),
            published_slot: None,
        },
        operation: vec![v + 1; 16],
        count: 1,
        root: vec![0; 32],
        reserved_bytes: 8192,
    }
}
#[test]
fn prepaid_working_stage_and_commit_do_not_grow_usage_and_legacy_keeps_digest() {
    for prepaid in [false, true] {
        let db = fixture();
        let before = content::global_usage(&db).unwrap();
        restore_working::prepay(&db).unwrap();
        assert_eq!(content::global_usage(&db).unwrap() - before, 524288);
        restore_working::prepay(&db).unwrap();
        assert_eq!(content::global_usage(&db).unwrap() - before, 524288);
        let mut request = request(9);
        if !prepaid {
            request.reserved_bytes += 502;
        }
        if prepaid {
            restore::begin_prepaid(&db, request.clone(), 1).unwrap();
        } else {
            restore::begin(&db, request.clone(), 1).unwrap();
        }
        let digest: Vec<u8> = db
            .query_row("SELECT digest FROM restores", params![], |r| {
                sql::row_get(r, 0)
            })
            .unwrap();
        let usage = content::global_usage(&db).unwrap();
        let row = Revision {
            vault: vec![9; 16],
            object: vec![20; 16],
            revision: 1,
            sequence: 1,
            plain_size: 0,
            manifest: vec![],
            chunk_hashes: vec![],
            deleted: true,
        };
        restore::stage(&db, &row.vault, row.clone(), 1).unwrap();
        assert_eq!(content::global_usage(&db).unwrap(), usage);
        restore::finish_record(&db, &row.vault, 1, 1).unwrap();
        assert_eq!(content::global_usage(&db).unwrap(), usage);
        let after: Vec<u8> = db
            .query_row("SELECT digest FROM restores", params![], |r| {
                sql::row_get(r, 0)
            })
            .unwrap();
        assert_eq!(digest, after);
        // An expired retained restore still occupies the one physical working slot.
        assert_eq!(
            restore::begin_prepaid(&db, self::request(11), DAY + 2).unwrap_err(),
            Error::Busy
        );
    }
}
#[test]
fn prepaid_working_pending_ceiling_and_owner_isolation() {
    let db = fixture();
    assert_eq!(
        restore::begin_prepaid(&db, request(9), 1).unwrap_err(),
        Error::QuotaExceeded
    );
    restore_working::prepay(&db).unwrap();
    restore::begin_prepaid(&db, request(9), 1).unwrap();
    let usage = content::global_usage(&db).unwrap();
    db.execute(
        "UPDATE restores SET pending=?1",
        params!["x".repeat(400000)],
    )
    .unwrap();
    assert_eq!(content::global_usage(&db).unwrap(), usage);
    assert!(
        db.execute(
            "UPDATE restores SET pending=?1",
            params!["x".repeat(400001)]
        )
        .is_err()
    );
    assert!(
        db.execute("UPDATE restores SET digest=?1", params![vec![1u8; 33]])
            .is_err()
    );
    let other = Principal::self_authenticating([2; 32]);
    OwnerContext::authenticated(other)
        .unwrap()
        .run(&db, |db| {
            assert!(!restore_working::available(db)?);
            assert_eq!(
                restore::begin_prepaid(db, request(9), 1).unwrap_err(),
                Error::QuotaExceeded
            );
            Ok(())
        })
        .unwrap();
}
