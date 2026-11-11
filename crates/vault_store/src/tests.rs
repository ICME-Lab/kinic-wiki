use super::*;
fn fixture() -> Connection {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch(&[SCHEMA, CONTENT_SCHEMA, RESTORE_SCHEMA].concat())
        .unwrap();
    select_owner(&db, Principal::self_authenticating([1; 32])).unwrap();
    save(
        &db,
        "config",
        &Config {
            owner: Principal::self_authenticating([1; 32]),
            origin: "http://localhost:5173".into(),
            rp_id: "localhost".into(),
            key_name: "test_key_1".into(),
            minimum_cycles: 100_000_000_000,
        },
    )
    .unwrap();
    db
}
#[test]
fn reserve_checks_owner_replay_expiry_and_limits() {
    let db = fixture();
    let owner = config(&db).unwrap().owner;
    let r = Reserve {
        vault: vec![1; 16],
        operation: vec![2; 16],
    };
    assert_eq!(
        reserve(&db, Principal::anonymous(), r.clone(), 1).unwrap_err(),
        Error::Unauthorized
    );
    reserve(&db, owner, r.clone(), 1).unwrap();
    assert_eq!(reserve(&db, owner, r.clone(), 1).unwrap().id, r.vault);
    assert_eq!(
        reserve(
            &db,
            owner,
            Reserve {
                vault: vec![3; 16],
                operation: vec![4; 16]
            },
            1
        )
        .unwrap_err(),
        Error::Busy
    );
    assert_eq!(reserve(&db, owner, r, DAY + 1).unwrap_err(), Error::Expired);
}
#[test]
fn explicit_transaction_rolls_back_writes_on_application_error() {
    let mut db = fixture();
    {
        let tx = db.transaction().unwrap();
        reserve(
            &tx,
            config(&tx).unwrap().owner,
            Reserve {
                vault: vec![1; 16],
                operation: vec![2; 16],
            },
            1,
        )
        .unwrap(); /* drop, no commit */
    }
    assert_eq!(header(&db, &[1; 16]).unwrap_err(), Error::NotFound);
}
#[test]
fn upload_is_atomic_bounded_idempotent_and_snapshot_retains_history() {
    use crate::content::*;
    use sha2::{Digest, Sha256};
    let mut db = fixture();

    let owner = config(&db).unwrap().owner;
    let vault = vec![1; 16];
    let object = vec![2; 16];
    let mut h = reserve(
        &db,
        owner,
        Reserve {
            vault: vault.clone(),
            operation: vec![3; 16],
        },
        1,
    )
    .unwrap();
    h.state = VaultState::Active;
    h.sequence = 1;
    put_header(&db, &h).unwrap();
    db.execute(
        "UPDATE vaults SET expires=0 WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1)",
        params![],
    )
    .unwrap();
    let bytes = vec![7; 17];
    let mut first = None;
    for i in 0..12 {
        let operation = vec![(10 + i) as u8; 16];
        let request = BeginRevision {
            vault: vault.clone(),
            object: object.clone(),
            expected_revision: i,
            operation: operation.clone(),
            plain_size: 1,
            manifest: vec![99],
            chunk_hashes: vec![Sha256::digest(&bytes).to_vec()],
        };
        {
            let tx = db.transaction().unwrap();
            begin(&tx, request.clone(), 1).unwrap();
            tx.commit().unwrap();
        }
        assert!(commit(&db, &operation, 1).is_err());
        put(&db, &operation, 0, &bytes, 1).unwrap();
        put(&db, &operation, 0, &bytes, 1).unwrap();
        assert!(put(&db, &operation, 0, &[8; 17], 1).is_err());
        {
            let tx = db.transaction().unwrap();
            let r = commit(&tx, &operation, 1).unwrap();
            assert_eq!(r.revision, i + 1);
            tx.commit().unwrap();
        }
        assert_eq!(commit(&db, &operation, 1).unwrap().revision, i + 1);
        assert_eq!(begin(&db, request, 1).unwrap().expires, 0);
        if i == 0 {
            first = Some(begin_export(&db, &vault, &[100; 16], 1).unwrap());
        }
    }
    assert_eq!(
        history(&db, &vault, &object, u64::MAX)
            .unwrap()
            .entries
            .len(),
        10
    );
    let e = first.unwrap();
    assert_eq!(export_index(&db, &e.id, 0, 1).unwrap().entries.len(), 1);
    assert_eq!(export_chunk(&db, &e.id, &object, 1, 0, 1).unwrap(), bytes);
    assert_eq!(
        purge(&db, &vault, &object, 1).unwrap_err(),
        Error::ExportInProgress
    );
    assert_eq!(gc(&db, 1).unwrap(), 0);
    let h = finish_export(&db, &e.id, true, 2).unwrap();
    assert!(h.sequence > h.backup_sequence.unwrap());
    assert_eq!(
        finish_export(&db, &e.id, true, 3).unwrap().backup_at,
        Some(2)
    );
    assert_eq!(gc(&db, 3).unwrap(), 1);
    let mut over = BeginRevision {
        vault: vault.clone(),
        object: vec![9; 16],
        expected_revision: 0,
        operation: vec![9; 16],
        plain_size: FILE_MAX + 1,
        manifest: vec![99],
        chunk_hashes: vec![vec![0; 32]],
    };
    assert_eq!(
        begin(&db, over.clone(), 3).unwrap_err(),
        Error::InvalidInput
    );
    over.plain_size = 1;
    over.chunk_hashes = vec![Sha256::digest(&bytes).to_vec()];
    over.expected_revision = 1;
    assert_eq!(begin(&db, over, 3).unwrap_err(), Error::Conflict);
}
#[test]
fn restore_preserves_ciphertext_and_requires_complete_authenticated_set() {
    use crate::{content, restore};
    use sha2::{Digest, Sha256};
    let db = fixture();
    let owner = config(&db).unwrap().owner;
    let vault = vec![11; 16];
    let e = Envelope {
        version: 1,
        nonce: vec![1; 12],
        ciphertext: vec![2; 48],
    };
    let header = Header {
        published_slot: None,
        generation: None,
        recovery_verifier: vec![],
        id: vault.clone(),
        epoch: 0,
        state: VaultState::Active,
        normal: Some(e.clone()),
        recovery: Some(e),
        sequence: 7,
        backup_sequence: Some(7),
        backup_at: Some(1),
        key_name: "old-source-key".into(),
    };
    let data = vec![7; 17];
    let revision = Revision {
        vault: vault.clone(),
        object: vec![12; 16],
        revision: 4,
        plain_size: 1,
        manifest: vec![8],
        chunk_hashes: vec![Sha256::digest(&data).to_vec()],
        deleted: false,
        sequence: 7,
    };
    let root = Sha256::digest([vec![0; 32], restore::leaf(&revision)].concat()).to_vec();
    // An exported overlay is materialized in the archive; its server slot pointer
    // cannot be imported into a different dataset with no matching wrapper rows.
    let mut invalid = header.clone();
    invalid.published_slot = Some(0);
    assert_eq!(
        restore::begin(
            &db,
            BeginRestore {
                header: invalid,
                operation: vec![13; 16],
                count: 1,
                root: root.clone(),
                reserved_bytes: 30000
            },
            1
        )
        .unwrap_err(),
        Error::InvalidInput
    );
    let h = restore::begin(
        &db,
        BeginRestore {
            header: header.clone(),
            operation: vec![13; 16],
            count: 1,
            root,
            reserved_bytes: 30000,
        },
        1,
    )
    .unwrap();
    assert_eq!(h.state, VaultState::Restoring);
    assert_eq!(h.backup_at, None);
    assert!(h.normal.is_none());
    assert_eq!(h.key_name, "test_key_1");
    assert!(active(&db, &vault).is_err());
    assert!(restore::ready(&db, &vault, 1).is_err());
    db.execute_batch("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<10000) INSERT INTO revisions SELECT (SELECT owner FROM owner_scope WHERE slot=1),x'ff', x'ff', x, x, NULL, 0, x'', '[]', 1, 4096 FROM n").unwrap();
    assert_eq!(
        restore::stage(&db, &vault, revision.clone(), 1).unwrap_err(),
        Error::QuotaExceeded
    );
    db.execute("DELETE FROM revisions WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND (vault=x'ff')", params![])
        .unwrap();
    restore::stage(&db, &vault, revision.clone(), 1).unwrap();
    assert!(restore::finish_record(&db, &vault, 7, 1).is_err());
    assert!(restore::put(&db, &vault, 0, &[9; 17], 1).is_err());
    restore::put(&db, &vault, 0, &data, 1).unwrap();
    db.execute_batch("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<10000) INSERT INTO objects SELECT (SELECT owner FROM owner_scope WHERE slot=1),x'ff', CAST(x AS BLOB), 1 FROM n").unwrap();
    assert_eq!(
        restore::finish_record(&db, &vault, 7, 1).unwrap_err(),
        Error::QuotaExceeded
    );
    db.execute("DELETE FROM objects WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND (vault=x'ff')", params![])
        .unwrap();
    let p = restore::finish_record(&db, &vault, 7, 1).unwrap();
    assert_eq!(p.count, 1);
    assert_eq!(restore::finish_record(&db, &vault, 7, 1).unwrap().count, 1);
    restore::ready(&db, &vault, 1).unwrap();
    let mut h = super::header(&db, &vault).unwrap();
    h.state = VaultState::Active;
    h.normal = header.normal;
    put_header(&db, &h).unwrap();
    restore::committed(&db, &vault).unwrap();
    assert_eq!(
        content::chunk(&db, &vault, &revision.object, 4, 0).unwrap(),
        data
    );
    assert_eq!(
        content::manifest(&db, &vault, &revision.object, 4)
            .unwrap()
            .manifest,
        revision.manifest
    );
    assert_eq!(
        authorize(&db, Principal::self_authenticating([99; 32])).unwrap_err(),
        Error::Unauthorized
    );
    assert_eq!(authorize(&db, owner).unwrap().owner, owner);
}

fn active_fixture(db: &Connection) -> Vec<u8> {
    let v = vec![1; 16];
    let mut h = reserve(
        db,
        config(db).unwrap().owner,
        Reserve {
            vault: v.clone(),
            operation: vec![3; 16],
        },
        1,
    )
    .unwrap();
    h.state = VaultState::Active;
    put_header(db, &h).unwrap();
    db.execute(
        "UPDATE vaults SET expires=0 WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1)",
        params![],
    )
    .unwrap();
    v
}
fn pending_revision(db: &Connection, v: &[u8], expected: u64, op: u8) {
    use sha2::{Digest, Sha256};
    let data = vec![7; 17];
    content::begin(
        db,
        BeginRevision {
            vault: v.to_vec(),
            object: vec![2; 16],
            expected_revision: expected,
            operation: vec![op; 16],
            plain_size: 1,
            manifest: vec![99],
            chunk_hashes: vec![Sha256::digest(&data).to_vec()],
        },
        1,
    )
    .unwrap();
    content::put(db, &[op; 16], 0, &data, 1).unwrap();
}
#[test]
fn purge_blocks_in_flight_upload_and_preserves_existing_content() {
    let db = fixture();
    let v = active_fixture(&db);
    pending_revision(&db, &v, 0, 10);
    content::commit(&db, &[10; 16], 1).unwrap();
    pending_revision(&db, &v, 1, 11);
    assert_eq!(
        content::purge(&db, &v, &[2; 16], 1).unwrap_err(),
        Error::Busy
    );
    assert_eq!(content::manifest(&db, &v, &[2; 16], 0).unwrap().revision, 1);
    content::commit(&db, &[11; 16], 1).unwrap();
    content::purge(&db, &v, &[2; 16], 1).unwrap();
    assert!(content::manifest(&db, &v, &[2; 16], 0).is_err());
}
#[test]
fn sequence_exhaustion_rejects_save_delete_and_purge_before_writes() {
    let db = fixture();
    let v = active_fixture(&db);
    pending_revision(&db, &v, 0, 10);
    content::commit(&db, &[10; 16], 1).unwrap();
    pending_revision(&db, &v, 1, 11);
    let mut h = header(&db, &v).unwrap();
    h.sequence = i64::MAX as u64;
    put_header(&db, &h).unwrap();
    assert_eq!(
        content::commit(&db, &[11; 16], 1).unwrap_err(),
        Error::QuotaExceeded
    );
    assert_eq!(
        content::delete(&db, &v, &[2; 16], 1, &[12; 16], 1).unwrap_err(),
        Error::QuotaExceeded
    );
    // Expired upload no longer prevents purge, but sequence exhaustion still does.
    assert_eq!(
        content::purge(&db, &v, &[2; 16], DAY + 1).unwrap_err(),
        Error::QuotaExceeded
    );
    assert_eq!(content::manifest(&db, &v, &[2; 16], 0).unwrap().revision, 1);
    assert_eq!(header(&db, &v).unwrap().sequence, i64::MAX as u64);
}
#[test]
fn commit_rechecks_record_capacity_after_upload_was_reserved() {
    for objects in [false, true] {
        let db = fixture();
        let v = active_fixture(&db);
        pending_revision(&db, &v, 0, 10);
        if objects {
            db.execute_batch("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<10000) INSERT INTO objects SELECT (SELECT owner FROM owner_scope WHERE slot=1),x'ff', CAST(x AS BLOB), 1 FROM n").unwrap();
        } else {
            db.execute_batch("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<10000) INSERT INTO revisions SELECT (SELECT owner FROM owner_scope WHERE slot=1),x'ff', x'ff', x, x, NULL, 0, x'', '[]', 1, 4096 FROM n").unwrap();
        }
        assert_eq!(
            content::commit(&db, &[10; 16], 1).unwrap_err(),
            Error::QuotaExceeded
        );
        assert!(content::manifest(&db, &v, &[2; 16], 0).is_err());
        assert_eq!(header(&db, &v).unwrap().sequence, 0);
    }
}

#[test]
fn cancelled_creation_releases_slot_and_rejects_old_attempt() {
    let db = fixture();
    let owner = config(&db).unwrap().owner;
    let request = Reserve {
        vault: vec![21; 16],
        operation: vec![22; 16],
    };
    let h = reserve(&db, owner, request.clone(), 10).unwrap();
    assert_eq!(setup::list(&db, 10).unwrap()[0].attempt, request.operation);
    assert_eq!(
        setup::cancel(&db, &h.id, &[99; 16], 10),
        Err(Error::Conflict)
    );
    setup::cancel(&db, &h.id, &request.operation, 10).unwrap();
    setup::cancel(&db, &h.id, &request.operation, 11).unwrap();
    assert_eq!(
        reserve(&db, owner, request.clone(), 11).unwrap_err(),
        Error::Expired
    );
    let next = reserve(
        &db,
        owner,
        Reserve {
            operation: vec![23; 16],
            ..request.clone()
        },
        11,
    )
    .unwrap();
    assert_eq!(
        setup::check_attempt(&db, &next, Some(&request.operation)),
        Err(Error::Conflict)
    );
    setup::cancel(&db, &h.id, &request.operation, 11).unwrap();
    assert!(pending(&db, &h.id, 11).is_ok());
}

#[test]
fn low_balance_refuses_new_upload_but_preserves_retries() {
    let db = fixture();
    let v = active_fixture(&db);
    let request = BeginRevision {
        vault: v.clone(),
        object: vec![2; 16],
        expected_revision: 0,
        operation: vec![10; 16],
        plain_size: 1,
        manifest: vec![1],
        chunk_hashes: vec![vec![0; 32]],
    };
    assert_eq!(
        content::begin_with_budget(&db, request.clone(), 1, false).unwrap_err(),
        Error::QuotaExceeded
    );
    assert_eq!(content::quota(&db, &v).unwrap().reserved, 0);
    let original = content::begin(&db, request.clone(), 1).unwrap();
    let replay = content::begin_with_budget(&db, request, 2, false).unwrap();
    assert_eq!(original.expires, replay.expires);
    assert_eq!(original.id, replay.id);
}

#[test]
fn expired_restore_cleanup_is_bounded_and_allows_retry() {
    let db = fixture();
    let vault = vec![41; 16];
    let request = BeginRestore {
        header: Header {
            published_slot: None,
            generation: None,
            recovery_verifier: vec![],
            id: vault.clone(),
            epoch: 0,
            state: VaultState::Active,
            normal: None,
            recovery: Some(Envelope {
                version: 1,
                nonce: vec![1; 12],
                ciphertext: vec![2; 48],
            }),
            sequence: 2,
            backup_sequence: None,
            backup_at: None,
            key_name: "test_key_1".into(),
        },
        operation: vec![42; 16],
        count: 2,
        root: vec![0; 32],
        reserved_bytes: 2 * 1024 * 1024,
    };
    restore::begin(&db, request.clone(), 10).unwrap();
    for n in 1..=101u8 {
        db.execute(
            "INSERT INTO objects VALUES((SELECT owner FROM owner_scope WHERE slot=1),?1,?2,1)",
            params![vault, vec![n; 16]],
        )
        .unwrap();
    }
    for n in 1..=2u8 {
        db.execute(
            "INSERT INTO revisions VALUES((SELECT owner FROM owner_scope WHERE slot=1),?1,?2,1,?3,NULL,0,x'', '[]',1,4096)",
            params![vault, vec![n; 16], i64::from(n)],
        )
        .unwrap();
    }
    let now = DAY + 10;
    assert!(setup::list(&db, now).unwrap()[0].cleaning);
    assert_eq!(content::gc(&db, now).unwrap(), 1);
    let heads: i64 = db
        .query_row(
            "SELECT count(*) FROM (SELECT * FROM objects WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1)) WHERE vault=?1",
            params![vault],
            |r| sql::row_get(r, 0),
        )
        .unwrap();
    assert_eq!(heads, 1);
    assert_eq!(content::gc(&db, now).unwrap(), 1);
    assert!(setup::list(&db, now).unwrap().is_empty());
    assert_eq!(
        restore::begin(&db, request.clone(), now).unwrap_err(),
        Error::Expired
    );
    assert!(
        restore::begin(
            &db,
            BeginRestore {
                operation: vec![43; 16],
                ..request
            },
            now
        )
        .is_ok()
    );
}

#[test]
fn quota_reservations_in_two_vaults_meet_the_exact_global_boundary() {
    for excess in [0, 1] {
        let db = fixture();
        let a = active_fixture(&db);
        let b = vec![61; 16];
        let mut second = header(&db, &a).unwrap();
        second.id = b.clone();
        db.execute(
            "INSERT INTO vaults VALUES((SELECT owner FROM owner_scope WHERE slot=1),?1,?2,0,?3)",
            params![b, vec![62u8; 16], serde_json::to_string(&second).unwrap()],
        )
        .unwrap();
        let request = |vault: Vec<u8>, op: u8| BeginRevision {
            vault,
            object: vec![63; 16],
            operation: vec![op; 16],
            expected_revision: 0,
            plain_size: 1,
            manifest: vec![1],
            chunk_hashes: vec![vec![2; 32]],
        };
        let one = request(a.clone(), 64);
        let two = request(b.clone(), 65);
        let base = content::global_usage(&db).unwrap();
        content::begin(&db, one.clone(), 10).unwrap();
        content::begin(&db, two.clone(), 10).unwrap();
        let reservations = content::quota(&db, &a).unwrap().reserved;
        db.execute(
            "DELETE FROM uploads WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1)",
            params![],
        )
        .unwrap();
        db.execute(
            "INSERT INTO revisions VALUES((SELECT owner FROM owner_scope WHERE slot=1),x'ff',x'ff',1,1,NULL,0,x'', '[]',1,?1)",
            params![(TOTAL_MAX - base - reservations + excess) as i64],
        )
        .unwrap();
        content::begin(&db, one, 10).unwrap();
        let result = content::begin(&db, two, 10);
        let quota = content::quota(&db, &a).unwrap();
        if excess == 0 {
            result.unwrap();
            assert_eq!(
                quota.charged + quota.reserved + capacity::ACCOUNTING_POOL,
                TOTAL_MAX
            );
        } else {
            assert_eq!(result.unwrap_err(), Error::QuotaExceeded);
            assert!(quota.reserved < reservations);
        }
    }
}

#[test]
fn full_receipt_table_does_not_block_setup_cleanup() {
    for receipt_expires in [DAY + 1, DAY + 2] {
        let db = fixture();
        let vault = active_fixture(&db);
        pending_revision(&db, &vault, 0, 10);
        let pending = Reserve {
            vault: vec![31; 16],
            operation: vec![32; 16],
        };
        reserve(&db, config(&db).unwrap().owner, pending.clone(), 1).unwrap();
        db.execute(
            "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<10000)
             INSERT INTO receipts SELECT (SELECT owner FROM owner_scope WHERE slot=1),CAST(x AS BLOB),x'ff','null',?1 FROM n",
            params![receipt_expires as i64],
        )
        .unwrap();
        let now = DAY + 1;
        content::gc(&db, now).unwrap();
        assert_eq!(header(&db, &pending.vault).unwrap_err(), Error::NotFound);
        let reserved = content::quota(&db, &vault).unwrap().reserved;
        if receipt_expires == now {
            assert_eq!(reserved, 0);
            assert_eq!(
                content::commit(&db, &[10; 16], now).unwrap_err(),
                Error::Expired
            );
        } else {
            assert!(reserved > 0);
            content::gc(&db, receipt_expires).unwrap();
            assert_eq!(content::quota(&db, &vault).unwrap().reserved, 0);
        }
    }
}

#[test]
fn upload_commit_does_not_accept_a_deletion_receipt() {
    let mut db = fixture();
    let vault = active_fixture(&db);
    pending_revision(&db, &vault, 0, 10);
    content::commit(&db, &[10; 16], 1).unwrap();
    pending_revision(&db, &vault, 1, 11);
    let tx = db.transaction().unwrap();
    assert_eq!(
        content::delete(&tx, &vault, &[2; 16], 1, &[11; 16], 2).unwrap_err(),
        Error::Conflict
    );
    tx.rollback().unwrap();
    let deletion = content::delete(&db, &vault, &[2; 16], 1, &[12; 16], 2).unwrap();
    assert!(deletion.deleted);
    assert_eq!(
        content::delete(&db, &vault, &[2; 16], 1, &[12; 16], 3)
            .unwrap()
            .revision,
        deletion.revision
    );
    assert_eq!(
        content::commit(&db, &[12; 16], 3).unwrap_err(),
        Error::Conflict
    );
}

#[test]
fn uploads_reserve_receipt_slots_across_vaults() {
    let db = fixture();
    let first = active_fixture(&db);
    let second = vec![71; 16];
    let mut h = header(&db, &first).unwrap();
    h.id = second.clone();
    db.execute(
        "INSERT INTO vaults VALUES((SELECT owner FROM owner_scope WHERE slot=1),?1,?2,0,?3)",
        params![second, vec![72u8; 16], serde_json::to_string(&h).unwrap()],
    )
    .unwrap();
    db.execute_batch(
        "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<9998)
         INSERT INTO receipts SELECT (SELECT owner FROM owner_scope WHERE slot=1),CAST(x AS BLOB),x'ff','null',86401 FROM n",
    )
    .unwrap();
    pending_revision(&db, &first, 0, 10);
    pending_revision(&db, &second, 0, 11);
    assert_eq!(
        content::record(&db, &[99; 16], &[0; 32], &(), 1),
        Err(Error::QuotaExceeded)
    );
    assert_eq!(content::commit(&db, &[10; 16], 1).unwrap().revision, 1);
    assert_eq!(content::commit(&db, &[11; 16], 1).unwrap().revision, 1);
    assert_eq!(content::commit(&db, &[10; 16], 2).unwrap().revision, 1);
    let count: i64 = db
        .query_row("SELECT count(*) FROM (SELECT * FROM receipts WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1))", params![], |r| {
            sql::row_get(r, 0)
        })
        .unwrap();
    assert_eq!(count, 10000);
}

#[test]
fn setup_cancellation_cannot_consume_an_upload_receipt_slot() {
    let db = fixture();
    let vault = active_fixture(&db);
    let setup = Reserve {
        vault: vec![81; 16],
        operation: vec![82; 16],
    };
    reserve(&db, config(&db).unwrap().owner, setup.clone(), 1).unwrap();
    db.execute_batch(
        "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<9998)
         INSERT INTO receipts SELECT (SELECT owner FROM owner_scope WHERE slot=1),CAST(x AS BLOB),x'ff','null',86401 FROM n",
    )
    .unwrap();
    pending_revision(&db, &vault, 0, 10);
    assert_eq!(
        content::record(&db, &[99; 16], &[0; 32], &(), 1),
        Err(Error::QuotaExceeded)
    );
    setup::cancel(&db, &setup.vault, &setup.operation, 1).unwrap();
    content::commit(&db, &[10; 16], 1).unwrap();
    assert_eq!(
        reserve(
            &db,
            config(&db).unwrap().owner,
            Reserve {
                vault: vec![83; 16],
                operation: vec![84; 16],
            },
            1
        )
        .unwrap_err(),
        Error::QuotaExceeded
    );
}

#[test]
fn expired_upload_uses_its_reserved_receipt_slot_at_the_limit() {
    let db = fixture();
    let vault = active_fixture(&db);
    db.execute_batch(
        "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<9999)
         INSERT INTO receipts SELECT (SELECT owner FROM owner_scope WHERE slot=1),CAST(x AS BLOB),x'ff','null',86403 FROM n",
    )
    .unwrap();
    pending_revision(&db, &vault, 0, 10);
    content::gc(&db, DAY + 1).unwrap();
    assert_eq!(content::quota(&db, &vault).unwrap().reserved, 0);
    assert_eq!(
        content::commit(&db, &[10; 16], DAY + 1).unwrap_err(),
        Error::Expired
    );
    let count: i64 = db
        .query_row("SELECT count(*) FROM (SELECT * FROM receipts WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1))", params![], |r| {
            sql::row_get(r, 0)
        })
        .unwrap();
    assert_eq!(count, 10000);
    let request = BeginRevision {
        vault,
        object: vec![2; 16],
        expected_revision: 0,
        operation: vec![11; 16],
        plain_size: 1,
        manifest: vec![1],
        chunk_hashes: vec![vec![0; 32]],
    };
    assert_eq!(
        content::begin(&db, request, DAY + 1).unwrap_err(),
        Error::QuotaExceeded
    );
}

#[test]
fn authenticated_owner_switch_cannot_read_or_overwrite_other_owner_ids() {
    let db = fixture();
    let a = config(&db).unwrap();
    let request = Reserve {
        vault: vec![71; 16],
        operation: vec![72; 16],
    };
    reserve(&db, a.owner, request.clone(), 1).unwrap();
    let mut b = a.clone();
    b.owner = Principal::self_authenticating([2; 32]);
    select_owner(&db, b.owner).unwrap();
    save(&db, "config", &b).unwrap();
    assert_eq!(header(&db, &request.vault).unwrap_err(), Error::NotFound);
    reserve(&db, b.owner, request.clone(), 1).unwrap();
    assert_eq!(header(&db, &request.vault).unwrap().id, request.vault);
}

#[test]
fn global_capacity_and_receipts_do_not_multiply_by_owner_count() {
    let db = fixture();
    let a = config(&db).unwrap();
    let mut b = a.clone();
    b.owner = Principal::self_authenticating([2; 32]);
    select_owner(&db, b.owner).unwrap();
    save(&db, "config", &b).unwrap();
    db.execute("INSERT INTO revisions VALUES((SELECT owner FROM owner_scope WHERE slot=1),x'ff',x'ff',1,1,NULL,0,x'','[]',1,?1)",params![(TOTAL_MAX-content::global_usage(&db).unwrap()) as i64]).unwrap();
    assert_eq!(
        reserve(
            &db,
            b.owner,
            Reserve {
                vault: vec![1; 16],
                operation: vec![2; 16]
            },
            1
        )
        .unwrap_err(),
        Error::QuotaExceeded
    );
}
#[test]
fn missing_context_cannot_reuse_preceding_authenticated_owner() {
    let db = fixture();
    let owner = config(&db).unwrap().owner;
    let context = OwnerContext::authenticated(owner).unwrap();
    context
        .run(&db, |db| {
            reserve(
                db,
                owner,
                Reserve {
                    vault: vec![1; 16],
                    operation: vec![2; 16],
                },
                1,
            )
        })
        .unwrap();
    assert_eq!(header(&db, &[1; 16]).unwrap_err(), Error::NotFound);
    assert!(save(&db, "unscoped", &1).is_err());
    assert!(OwnerContext::authenticated(Principal::anonymous()).is_err());
}

#[test]
fn key_service_owner_and_global_flights_and_rollover_are_bounded() {
    let db = fixture();
    keys::reserve(&db, 1, 1, 30_000_000_000).unwrap();
    assert_eq!(
        keys::reserve(&db, 2, DAY + 1, 30_000_000_000),
        Err(Error::Busy)
    );
}
#[test]
fn key_service_rejects_management_payment_above_reserved_ceiling() {
    let db = fixture();
    assert_eq!(
        keys::reserve(&db, 1, 1, 30_000_000_001),
        Err(Error::QuotaExceeded)
    );
}

#[test]
fn key_service_global_eight_flights_and_thousand_derivations_are_not_per_owner() {
    let db = fixture();
    for i in 0..8 {
        select_owner(&db, Principal::self_authenticating([i + 1; 32])).unwrap();
        keys::reserve(&db, 1, 1, 30_000_000_000).unwrap();
        keys::cancel_pending(&db, 2).unwrap();
    }
    select_owner(&db, Principal::self_authenticating([20; 32])).unwrap();
    assert_eq!(
        keys::reserve(&db, 1, DAY + 1, 30_000_000_000),
        Err(Error::Busy)
    );
    // Settled historical owner reservations count toward the shared daily service budget.
    db.execute(
        "UPDATE key_flights SET actual=reserved,settled=1,in_flight=0",
        params![],
    )
    .unwrap();
    db.execute_batch("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<992) INSERT INTO key_flights(owner,token,day,reserved,actual,created,settled,in_flight) SELECT x'ff',x,0,30000000000,30000000000,1,1,0 FROM n;").unwrap();
    assert_eq!(
        keys::reserve(&db, 1, 1, 30_000_000_000),
        Err(Error::QuotaExceeded)
    );
    // Yesterday's settled costs release today's budget; outstanding costs would not.
    keys::reserve(&db, 1, DAY + 1, 30_000_000_000).unwrap();
}

#[test]
fn full_quota_keeps_one_pre_reserved_export_snapshot_available_per_vault() {
    let db = fixture();
    let vault = active_fixture(&db);
    let remainder = TOTAL_MAX - content::global_usage(&db).unwrap();
    db.execute("INSERT INTO revisions VALUES((SELECT owner FROM owner_scope WHERE slot=1),x'ff',x'ff',1,1,NULL,0,x'','[]',1,?1)",params![remainder as i64]).unwrap();
    let export = content::begin_export(&db, &vault, &[80; 16], 1).unwrap();
    assert_eq!(export.vault, vault);
    assert_eq!(content::global_usage(&db).unwrap(), TOTAL_MAX);
    assert_eq!(
        content::begin_export(&db, &vault, &[81; 16], 1).unwrap_err(),
        Error::Busy
    );
}

#[test]
fn cancelled_pending_key_reservation_is_recoverable_and_idempotent() {
    let db = fixture();
    keys::reserve(&db, 1, 1, 10_000_000_000).unwrap();
    assert_eq!(
        keys::cancel_pending(&db, DAY + 1).unwrap(),
        Some((1, 0, false))
    );
    assert_eq!(
        keys::cancel_pending(&db, DAY + 2).unwrap(),
        Some((1, 0, false))
    );
    keys::settle(&db, 1, DAY + 2, 0).unwrap();
    assert!(keys::cancel_pending(&db, DAY + 2).unwrap().is_none());
    keys::reserve(&db, 2, DAY + 2, 10_000_000_000).unwrap();
}

#[test]
fn active_export_lookup_is_bound_to_selected_vault() {
    let db = fixture();
    let first = active_fixture(&db);
    let owner = config(&db).unwrap().owner;
    let mut h = reserve(
        &db,
        owner,
        Reserve {
            vault: vec![3; 16],
            operation: vec![4; 16],
        },
        1,
    )
    .unwrap();
    h.state = VaultState::Active;
    put_header(&db, &h).unwrap();
    db.execute(
        "UPDATE vaults SET expires=0 WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1)",
        params![],
    )
    .unwrap();
    content::begin_export(&db, &first, &[80; 16], 1).unwrap();
    assert!(
        content::active_export_for_vault(&db, &h.id, 1)
            .unwrap()
            .is_none()
    );
    content::begin_export(&db, &h.id, &[81; 16], 1).unwrap();
    assert_eq!(
        content::active_export_for_vault(&db, &first, 1)
            .unwrap()
            .unwrap()
            .id,
        vec![80; 16]
    );
    assert_eq!(
        content::active_export_for_vault(&db, &h.id, 1)
            .unwrap()
            .unwrap()
            .id,
        vec![81; 16]
    );
}

#[test]
fn cancelling_live_management_call_does_not_release_owner_or_global_flight() {
    let db = fixture();
    keys::reserve(&db, 1, 1, 10_000_000_000).unwrap();
    keys::mark_sent(&db, 1, 10_000_000_000).unwrap();
    keys::cancel_pending(&db, 2).unwrap();
    assert_eq!(
        keys::reserve(&db, 2, DAY * 3, 10_000_000_000),
        Err(Error::Busy)
    );
    // A real callback can reconcile a refund after cancellation, then release the flight.
    keys::settle(&db, 1, DAY * 3, 3_000_000_000).unwrap();
    keys::reserve(&db, 2, DAY * 3, 10_000_000_000).unwrap();
}

#[test]
fn offline_owner_expired_receipts_are_reclaimed_globally_without_touching_live_slots() {
    let db = fixture();
    let a = config(&db).unwrap();
    let vault = active_fixture(&db);
    pending_revision(&db, &vault, 0, 10);
    db.execute(
        "UPDATE uploads SET expires=?1 WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1)",
        params![(DAY * 2) as i64],
    )
    .unwrap();
    reserve(
        &db,
        a.owner,
        Reserve {
            vault: vec![31; 16],
            operation: vec![32; 16],
        },
        DAY / 2,
    )
    .unwrap();
    db.execute_batch(&format!("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<9998) INSERT INTO receipts(owner,operation,digest,result,expires) SELECT (SELECT owner FROM owner_scope WHERE slot=1),CAST(x AS BLOB),x'ff','null',CASE WHEN x=9998 THEN {} ELSE {} END FROM n;",DAY*2,DAY+1)).unwrap();
    let mut b = a.clone();
    b.owner = Principal::self_authenticating([42; 32]);
    select_owner(&db, b.owner).unwrap();
    save(&db, "config", &b).unwrap();
    let request = Reserve {
        vault: vec![51; 16],
        operation: vec![52; 16],
    };
    assert_eq!(
        reserve(&db, b.owner, request.clone(), DAY).unwrap_err(),
        Error::QuotaExceeded
    );
    let before: i64 = db
        .query_row("SELECT count(*) FROM receipts", params![], |r| {
            sql::row_get(r, 0)
        })
        .unwrap();
    assert_eq!(before, 9998);
    assert_eq!(
        content::maintain_expired(&db, DAY + 2).unwrap().unwrap().0,
        a.owner
    );
    select_owner(&db, b.owner).unwrap();
    reserve(&db, b.owner, request, DAY + 2).unwrap();
    let after: i64 = db
        .query_row("SELECT count(*) FROM receipts", params![], |r| {
            sql::row_get(r, 0)
        })
        .unwrap();
    assert!(before - after > 0 && before - after <= 100);
    let live: i64 = db
        .query_row(
            "SELECT count(*) FROM receipts WHERE owner=?1 AND expires>?2",
            params![a.owner.as_slice(), (DAY + 2) as i64],
            |r| sql::row_get(r, 0),
        )
        .unwrap();
    assert_eq!(live, 1);
    select_owner(&db, a.owner).unwrap();
    assert_eq!(
        content::commit(&db, &[10; 16], DAY + 2).unwrap().revision,
        1
    );
    assert_eq!(pending(&db, &[31; 16], DAY + 2).unwrap().id, vec![31; 16]);
}

#[test]
fn v2_empty_target_restore_validates_generation_seed_and_rejects_v1_zero_root() {
    for valid in [true, false] {
        let db = fixture();
        let owner = config(&db).unwrap().owner;
        let g = Generation {
            version: 2,
            owner,
            canister: Principal::from_slice(&[1]),
            vault: vec![11; 16],
            epoch: 1,
            nonce: vec![12; 32],
            key_name: "test_key_1".into(),
        };
        let e = Envelope {
            version: 2,
            nonce: vec![1; 12],
            ciphertext: vec![2; 48],
        };
        let h = Header {
            published_slot: None,
            generation: Some(g.clone()),
            recovery_verifier: vec![3; 32],
            id: g.vault.clone(),
            epoch: 1,
            state: VaultState::Active,
            normal: Some(e.clone()),
            recovery: Some(e),
            sequence: 0,
            backup_sequence: None,
            backup_at: None,
            key_name: g.key_name.clone(),
        };
        let root = if valid {
            restore::target_seed(&g).unwrap()
        } else {
            vec![0; 32]
        };
        restore::begin(
            &db,
            BeginRestore {
                header: h,
                operation: vec![13; 16],
                count: 0,
                root,
                reserved_bytes: 30000,
            },
            1,
        )
        .unwrap();
        assert_eq!(restore::ready(&db, &g.vault, 1).is_ok(), valid);
    }
}

#[test]
fn capacity_overcommit_preserves_read_export_reuse_and_bounded_cleanup() {
    let db = fixture();
    let vault = active_fixture(&db);
    pending_revision(&db, &vault, 0, 10);
    content::commit(&db, &[10; 16], 1).unwrap();
    let first = content::begin_export(&db, &vault, &[80; 16], 1).unwrap();
    content::finish_export(&db, &first.id, true, 1).unwrap();
    // Legacy versions could retain multiple finished snapshots. Replacing one
    // must not demand growth even while another inactive row remains.
    let mut legacy = first.clone();
    legacy.id = vec![83; 16];
    legacy.state = "Finished".into();
    db.execute("INSERT INTO exports VALUES((SELECT owner FROM owner_scope WHERE slot=1),?1,?2,?3,?4,'Finished')",params![legacy.id,vault,serde_json::to_string(&legacy).unwrap(),legacy.expires as i64]).unwrap();
    let overage = 1234;
    let fill = TOTAL_MAX - content::global_usage(&db).unwrap() + overage;
    db.execute("INSERT INTO revisions VALUES((SELECT owner FROM owner_scope WHERE slot=1),x'ff',x'ff',1,1,NULL,0,x'','[]',1,?1)",params![fill as i64]).unwrap();
    let status = content::global_capacity(&db).unwrap();
    assert!(status.overcommitted);
    assert_eq!(status.overage, overage);
    assert_eq!(
        content::chunk(&db, &vault, &[2; 16], 1, 0).unwrap(),
        vec![7; 17]
    );
    assert_eq!(header(&db, &vault).unwrap().id, vault);
    assert_eq!(
        content::check_capacity(&db, 1).unwrap_err(),
        Error::QuotaExceeded
    );
    let second = content::begin_export(&db, &vault, &[81; 16], 2).unwrap();
    assert_eq!(second.vault, vault);
    assert_eq!(content::global_capacity(&db).unwrap(), status);
    assert_eq!(
        content::begin_export(&db, &vault, &[82; 16], 2).unwrap_err(),
        Error::Busy
    );
    content::finish_export(&db, &second.id, true, 2).unwrap();
    db.execute("DELETE FROM revisions WHERE vault=x'ff'", params![])
        .unwrap();
    assert!(!content::global_capacity(&db).unwrap().overcommitted);
    content::check_capacity(&db, 1).unwrap();
}

#[test]
fn transition_metadata_uses_one_fixed_prepaid_owner_slot() {
    let db = fixture();
    let before = content::usage(&db).unwrap();
    let global_before = content::global_usage(&db).unwrap();
    save(&db, "transition", &()).unwrap();
    assert_eq!(content::usage(&db).unwrap() - before, 65536);
    assert_eq!(content::global_usage(&db).unwrap() - global_before, 65536);
    let prepaid = content::usage(&db).unwrap();
    save(&db, "transition", &"x".repeat(60000)).unwrap();
    assert_eq!(content::usage(&db).unwrap(), prepaid);
    assert_eq!(
        save(&db, "transition", &"x".repeat(65536)),
        Err(Error::QuotaExceeded)
    );
}

#[test]
fn published_wrapper_is_required_and_preserves_content_ciphertext() {
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD as B64};
    use sha2::{Digest, Sha256};
    let db = fixture();
    let owner = config(&db).unwrap().owner;
    let mut h = reserve(
        &db,
        owner,
        Reserve {
            vault: vec![1; 16],
            operation: vec![2; 16],
        },
        1,
    )
    .unwrap();
    let generation = Generation {
        version: 2,
        canister: Principal::from_slice(&[8]),
        owner,
        vault: h.id.clone(),
        epoch: 1,
        nonce: vec![4; 32],
        key_name: "test_key_1".into(),
    };
    h.generation = Some(generation.clone());
    h.published_slot = Some(0);
    let wrapper = format::PackedEnvelope {
        version: 2,
        nonce: B64.encode([1; 12]),
        ciphertext: B64.encode([2; 48]),
    };
    let base = format::Manifest {
        version: 1,
        dek: format::PackedEnvelope {
            version: 1,
            ..wrapper.clone()
        },
        metadata: format::PackedEnvelope {
            version: 1,
            nonce: B64.encode([3; 12]),
            ciphertext: B64.encode([4; 16]),
        },
        nonces: vec![B64.encode([5; 12])],
    };
    let revision = Revision {
        vault: h.id.clone(),
        object: vec![3; 16],
        revision: 1,
        plain_size: 1,
        manifest: serde_json::to_vec(&base).unwrap(),
        chunk_hashes: vec![vec![6; 32]],
        deleted: false,
        sequence: 1,
    };
    assert_eq!(
        overlays::effective(&db, &h, revision.clone()).unwrap_err(),
        Error::Storage
    );
    let digest = Sha256::digest(&revision.manifest).to_vec();
    overlays::stage(
        &db,
        &revision,
        &generation,
        0,
        &digest,
        &serde_json::to_vec(&wrapper).unwrap(),
    )
    .unwrap();
    h.state = VaultState::Active;
    h.sequence = 1;
    put_header(&db, &h).unwrap();
    db.execute("UPDATE vaults SET expires=0", params![])
        .unwrap();
    db.execute("INSERT INTO revisions VALUES((SELECT owner FROM owner_scope WHERE slot=1),?1,?2,1,1,NULL,1,?3,?4,0,8192)",params![h.id,revision.object,revision.manifest,serde_json::to_string(&revision.chunk_hashes).unwrap()]).unwrap();
    db.execute(
        "INSERT INTO objects VALUES((SELECT owner FROM owner_scope WHERE slot=1),?1,?2,1)",
        params![h.id, revision.object],
    )
    .unwrap();
    let effective = overlays::effective(&db, &h, revision.clone()).unwrap();
    assert_eq!(
        content::manifest(&db, &h.id, &revision.object, 1)
            .unwrap()
            .manifest,
        effective.manifest
    );
    assert_eq!(
        content::history(&db, &h.id, &revision.object, 2)
            .unwrap()
            .entries[0]
            .manifest,
        effective.manifest
    );
    assert_eq!(
        content::objects(&db, &h.id, &[]).unwrap().entries[0].manifest,
        effective.manifest
    );
    let export = content::begin_export(&db, &h.id, &[11; 16], 1).unwrap();
    assert_eq!(
        content::export_index(&db, &export.id, 0, 1)
            .unwrap()
            .entries[0]
            .manifest,
        effective.manifest
    );
    assert_eq!(overlays::clear_inactive(&db, &h, 0), Err(Error::Conflict));
    assert!(overlays::clear_inactive(&db, &h, 1).unwrap());
    let parsed = format::parse(&effective.manifest, 1).unwrap();
    assert_eq!(parsed.version, 2);
    assert_eq!(parsed.metadata.ciphertext, base.metadata.ciphertext);
    assert_eq!(parsed.nonces, base.nonces);
    assert_eq!(effective.chunk_hashes, revision.chunk_hashes);
    assert_eq!(effective.sequence, revision.sequence);
    let ciphertext = vec![42; 17];
    let upload = content::begin_with_budget(
        &db,
        BeginRevision {
            vault: h.id.clone(),
            object: revision.object.clone(),
            expected_revision: 1,
            operation: vec![12; 16],
            plain_size: 1,
            manifest: effective.manifest.clone(),
            chunk_hashes: vec![Sha256::digest(&ciphertext).to_vec()],
        },
        2,
        true,
    )
    .unwrap();
    content::put(&db, &upload.id, 0, &ciphertext, 2).unwrap();
    let created = content::commit(&db, &upload.id, 2).unwrap();
    assert_eq!(
        content::manifest(&db, &h.id, &revision.object, 2)
            .unwrap()
            .manifest,
        created.manifest
    );
    let rows: i64 = db
        .query_row(
            "SELECT count(*) FROM wrapper_slots WHERE slot=0",
            params![],
            |r| sql::row_get(r, 0),
        )
        .unwrap();
    assert_eq!(rows, 2);
    db.execute("DELETE FROM wrapper_slots WHERE revision=2", params![])
        .unwrap();
    assert_eq!(
        content::manifest(&db, &h.id, &revision.object, 2).unwrap_err(),
        Error::Storage
    );
    let mut wrong = h.clone();
    wrong.generation.as_mut().unwrap().nonce[0] ^= 1;
    assert_eq!(
        overlays::effective(&db, &wrong, revision.clone()).unwrap_err(),
        Error::Storage
    );
    let mut tombstone = revision;
    tombstone.deleted = true;
    tombstone.manifest.clear();
    tombstone.chunk_hashes.clear();
    assert!(
        overlays::effective(&db, &h, tombstone)
            .unwrap()
            .manifest
            .is_empty()
    );
}
