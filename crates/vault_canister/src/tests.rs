use super::*;
use candid::Principal;
use funding::*;
fn p(n: u8) -> Principal {
    Principal::from_slice(&[n])
}
#[test]
fn prepaid_payment_is_caller_bound_idempotent_and_no_read_allocation() {
    state::initialize().unwrap();
    for n in 1..100 {
        assert_eq!(state::State.balance(&p(n).to_text()).unwrap(), 0);
    }
    state::transaction(|db| {
        let count: i64 = db
            .query_row("SELECT count(*) FROM accounts", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
        Ok(())
    })
    .unwrap();
    let req = PurchaseRequest {
        operation: vec![1; 16],
        beneficiary: p(2),
        amount_e8s: 100_000_000,
        min_credits: 100,
        created_at_time: 1_000_000_000,
    };
    let cfg = FundingConfig {
        ledger: p(3),
        recipient: p(4),
        cycles_per_kinic: 1_000_000_000,
    };
    let quote = record_quote(p(1), req.clone(), cfg.clone(), 10, 1_000_000_000).unwrap();
    assert_eq!(quote.wallet, p(1));
    assert!(begin_payment(p(2), &req.operation, 1_000_000_000).is_err());
    let sent = begin_payment(p(1), &req.operation, 1_000_000_000).unwrap();
    assert_eq!(sent.wallet, p(1));
    assert!(begin_payment(p(1), &req.operation, 1_000_000_000).is_err());
    complete_payment(&sent, Outcome::Unknown).unwrap();
    let retried = begin_payment(p(1), &req.operation, 2_000_000_000).unwrap();
    assert_eq!(sent.memo, retried.memo);
    assert_eq!(sent.created_at_time, retried.created_at_time);
    complete_payment(&retried, Outcome::Paid(7)).unwrap();
    complete_payment(&retried, Outcome::Paid(7)).unwrap();
    assert_eq!(
        state::State.balance(&p(2).to_text()).unwrap(),
        1_000_000_000
    );
    assert_eq!(state::State.balance(&p(1).to_text()).unwrap(), 0);
    assert!(begin_payment(p(1), &req.operation, 2_000_000_000).is_err());
    let mut conflicting = req.clone();
    conflicting.beneficiary = p(5);
    assert!(record_quote(p(1), conflicting, cfg, 10, 1_000_000_000).is_err());
}
#[test]
fn uncertain_payment_never_becomes_safe_to_reissue_after_error_or_upgrade() {
    state::initialize().unwrap();
    let req = PurchaseRequest {
        operation: vec![44; 16],
        beneficiary: p(22),
        amount_e8s: 100_000_000,
        min_credits: 1,
        created_at_time: 1_000_000_000,
    };
    record_quote(
        p(21),
        req.clone(),
        FundingConfig {
            ledger: p(80),
            recipient: p(81),
            cycles_per_kinic: 90_000_000,
        },
        10,
        1_000_000_000,
    )
    .unwrap();
    let first = begin_payment(p(21), &req.operation, 1_000_000_000).unwrap();
    state::State.vault_start_generation().unwrap();
    let retry = begin_payment(p(21), &req.operation, 2_000_000_000).unwrap();
    assert!(retry.uncertain);
    assert!(complete_payment(&first, Outcome::Paid(1)).is_err());
    let unknown = complete_payment(&retry, Outcome::Rejected(Status::BadFee(20))).unwrap();
    assert_eq!(unknown.status, Status::Unknown);
    assert!(begin_payment(p(21), &req.operation, 24 * 3600 * 1_000_000_000).is_err());
    assert_eq!(state::State.balance(&p(22).to_text()).unwrap(), 0);
}
#[test]
fn quota_limits_pin_quotes_and_fee_failures_do_not_credit() {
    state::initialize().unwrap();
    for i in 0..16 {
        let req = PurchaseRequest {
            operation: vec![i; 16],
            beneficiary: p(52),
            amount_e8s: 100_000_000,
            min_credits: 100,
            created_at_time: 0,
        };
        record_quote(
            p(51),
            req,
            FundingConfig {
                ledger: p(80),
                recipient: p(81),
                cycles_per_kinic: 100_000_000,
            },
            10,
            0,
        )
        .unwrap();
    }
    let req = PurchaseRequest {
        operation: vec![17; 16],
        beneficiary: p(52),
        amount_e8s: 100_000_000,
        min_credits: 100,
        created_at_time: 0,
    };
    assert!(
        record_quote(
            p(51),
            req,
            FundingConfig {
                ledger: p(80),
                recipient: p(81),
                cycles_per_kinic: 100_000_000
            },
            10,
            0
        )
        .is_err()
    );
    let sent = begin_payment(p(51), &[0; 16], 0).unwrap();
    assert_eq!(
        complete_payment(&sent, Outcome::Rejected(Status::BadFee(20)))
            .unwrap()
            .status,
        Status::BadFee(20)
    );
    assert_eq!(state::State.balance(&p(52).to_text()).unwrap(), 0);
    assert!(begin_payment(p(51), &[0; 16], 0).is_err());
}
#[test]
fn certified_asset_policy_rejects_embedding_without_breaking_ii_popup() {
    let h = http::security_headers();
    let header = |name: &str| h.iter().find(|(n, _)| n == name).unwrap().1.as_str();
    assert!(header("Content-Security-Policy").contains("frame-ancestors 'none'"));
    assert_eq!(header("Referrer-Policy"), "no-referrer");
    assert_eq!(
        header("Cross-Origin-Opener-Policy"),
        "same-origin-allow-popups"
    );
    for (_, _, bytes) in http::ASSETS {
        assert!(bytes.len() < 1_900_000, "asset needs streaming");
    }
}
#[test]
fn fee_admission_precedes_io_and_fences_cleanup_expiry_and_upgrade() {
    state::initialize().unwrap();
    let cfg = FundingConfig {
        ledger: p(70),
        recipient: p(71),
        cycles_per_kinic: 100_000_000,
    };
    let req = |n| PurchaseRequest {
        operation: vec![n; 16],
        beneficiary: p(72),
        amount_e8s: 100_000_000,
        min_credits: 20_000_000,
        created_at_time: 0,
    };
    let mut invalid = req(1);
    invalid.amount_e8s = 0;
    assert!(admit_quote(p(73), invalid, cfg.clone(), 0).is_err());
    let first = match admit_quote(p(73), req(1), cfg.clone(), 0).unwrap() {
        QuoteAdmission::Fee(f) => f,
        _ => panic!("fee slot expected"),
    };
    assert!(admit_quote(p(73), req(2), cfg.clone(), 0).is_err());
    let mut flights = vec![first.clone()];
    for n in 74..81 {
        match admit_quote(p(n), req(n), cfg.clone(), 0).unwrap() {
            QuoteAdmission::Fee(f) => flights.push(f),
            _ => panic!("fee slot expected"),
        }
    }
    assert!(admit_quote(p(81), req(81), cfg.clone(), 0).is_err());
    assert!(finish_quote(&first, Err(vault_types::Error::KeyService), 1).is_err());
    let replacement = match admit_quote(p(73), req(1), cfg.clone(), 2).unwrap() {
        QuoteAdmission::Fee(f) => f,
        _ => panic!("fee slot expected"),
    };
    assert!(finish_quote(&first, Ok(10), 3).is_err()); // old failed callback cannot clear a replacement
    assert!(admit_quote(p(73), req(3), cfg.clone(), 3).is_err());
    state::State.vault_start_generation().unwrap();
    let fresh = match admit_quote(p(73), req(1), cfg.clone(), 4).unwrap() {
        QuoteAdmission::Fee(f) => f,
        _ => panic!("fee slot expected"),
    };
    assert!(finish_quote(&replacement, Ok(10), 5).is_err());
    assert_eq!(finish_quote(&fresh, Ok(20), 6).unwrap().fee, 20);
    assert!(matches!(
        admit_quote(p(73), req(1), cfg.clone(), 7).unwrap(),
        QuoteAdmission::Existing(_)
    ));
    let expired = match admit_quote(p(74), req(4), cfg.clone(), 8).unwrap() {
        QuoteAdmission::Fee(f) => f,
        _ => panic!("fee slot expected"),
    };
    assert!(finish_quote(&expired, Ok(10), 120_000_000_009).is_err());
    assert!(matches!(
        admit_quote(p(74), req(4), cfg, 120_000_000_010).unwrap(),
        QuoteAdmission::Fee(_)
    ));
}
#[test]
fn pending_fee_reserves_global_payment_capacity_before_dispatch() {
    state::initialize().unwrap();
    let cfg = FundingConfig {
        ledger: p(90),
        recipient: p(91),
        cycles_per_kinic: 100_000_000,
    };
    let req = |id| PurchaseRequest {
        operation: vec![id; 16],
        beneficiary: p(92),
        amount_e8s: 100_000_000,
        min_credits: 20_000_000,
        created_at_time: 0,
    };
    for owner in 128..=191 {
        for id in 0..if owner == 191 { 15 } else { 16 } {
            record_quote(p(owner), req(id), cfg.clone(), 10, 0).unwrap();
        }
    }
    let last = match admit_quote(p(192), req(1), cfg.clone(), 0).unwrap() {
        QuoteAdmission::Fee(f) => f,
        _ => panic!("fee slot expected"),
    };
    assert!(matches!(
        admit_quote(p(193), req(1), cfg.clone(), 0),
        Err(vault_types::Error::QuotaExceeded)
    ));
    finish_quote(&last, Ok(10), 1).unwrap();
    assert!(matches!(
        admit_quote(p(193), req(1), cfg, 2),
        Err(vault_types::Error::QuotaExceeded)
    ));
}

#[test]
fn unknown_payment_attempt_bound_and_late_exact_completion_preserve_identity() {
    state::initialize().unwrap();
    let wallet = p(210);
    let request = PurchaseRequest {
        operation: vec![211; 16],
        beneficiary: p(212),
        amount_e8s: 100_000_000,
        min_credits: 20_000_000,
        created_at_time: 0,
    };
    record_quote(
        wallet,
        request.clone(),
        FundingConfig {
            ledger: p(213),
            recipient: p(214),
            cycles_per_kinic: 100_000_000,
        },
        10,
        0,
    )
    .unwrap();
    for _ in 0..99 {
        let sent = begin_payment(wallet, &request.operation, 0).unwrap();
        complete_payment(&sent, Outcome::Unknown).unwrap();
    }
    let last = begin_payment(wallet, &request.operation, 0).unwrap();
    assert_eq!(last.attempt, 100);
    assert!(begin_payment(wallet, &request.operation, 121_000_000_000).is_err());
    assert!(begin_payment(wallet, &request.operation, 24 * 3600 * 1_000_000_000).is_err());
    let mut unrelated = last.clone();
    unrelated.request.beneficiary = p(215);
    assert!(complete_payment(&unrelated, Outcome::Paid(4)).is_err());
    unrelated = last.clone();
    unrelated.config.ledger = p(216);
    assert!(complete_payment(&unrelated, Outcome::Paid(4)).is_err());
    state::initialize().unwrap(); // persisted journal survives runtime generation change
    let paid = complete_payment(&last, Outcome::Paid(4)).unwrap();
    assert_eq!(paid.status, Status::Paid(4));
    assert_eq!(complete_payment(&last, Outcome::Paid(4)).unwrap(), paid);
    assert_eq!(
        complete_payment(&last, Outcome::Rejected(Status::Rejected)).unwrap(),
        paid
    );
    assert_eq!(
        state::State.balance(&p(212).to_text()).unwrap(),
        100_000_000
    );
    assert_eq!(state::State.balance(&p(215).to_text()).unwrap(), 0);
}

#[test]
fn initial_release_rejects_unsupported_or_foreign_stores_without_changes() {
    use kinic_sqlite_compat::{Connection, params};
    for version in [0, 1, 2, 3, 4, 5, 6, 7, 8] {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(&format!("CREATE TABLE foreign_data(secret BLOB); INSERT INTO foreign_data VALUES(X'0102'); PRAGMA user_version={version};")).unwrap();
        let before: i64 = db
            .query_row("SELECT count(*) FROM sqlite_master", params![], |r| {
                kinic_sqlite_compat::row_get(r, 0)
            })
            .unwrap();
        assert_eq!(
            crate::schema::initialize_vault_schema(&db),
            Err(vault_types::Error::Storage),
            "unsupported version {version}"
        );
        let after: i64 = db
            .query_row("SELECT count(*) FROM sqlite_master", params![], |r| {
                kinic_sqlite_compat::row_get(r, 0)
            })
            .unwrap();
        assert_eq!(before, after);
        let bytes: Vec<u8> = db
            .query_row("SELECT secret FROM foreign_data", params![], |r| {
                kinic_sqlite_compat::row_get(r, 0)
            })
            .unwrap();
        assert_eq!(bytes, [1, 2]);
    }
}

#[test]
fn initial_release_rejects_partial_v8_without_repairing_it() {
    use kinic_sqlite_compat::{Connection, params};
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch(
        "CREATE TABLE global_settings(key TEXT PRIMARY KEY,value TEXT); PRAGMA user_version=8;",
    )
    .unwrap();
    assert_eq!(
        crate::schema::initialize_vault_schema(&db),
        Err(vault_types::Error::Storage)
    );
    let count: i64 = db
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE type='table'",
            params![],
            |r| kinic_sqlite_compat::row_get(r, 0),
        )
        .unwrap();
    assert_eq!(count, 1);
}

#[test]
fn initial_release_rejects_missing_columns_or_guards_without_repair() {
    use kinic_sqlite_compat::{Connection, params};
    for damage in [
        "DROP TRIGGER key_pool_count",
        "DROP TABLE accounts",
        "ALTER TABLE uploads DROP COLUMN cancel_job",
        "DROP INDEX one_upload_per_vault",
    ] {
        let db = Connection::open_in_memory().unwrap();
        crate::schema::initialize_vault_schema(&db).unwrap();
        db.execute_batch(damage).unwrap();
        let before: i64 = db
            .query_row("SELECT count(*) FROM sqlite_master", params![], |r| {
                kinic_sqlite_compat::row_get(r, 0)
            })
            .unwrap();
        assert_eq!(
            crate::schema::initialize_vault_schema(&db),
            Err(vault_types::Error::Storage),
            "damaged schema: {damage}"
        );
        let after: i64 = db
            .query_row("SELECT count(*) FROM sqlite_master", params![], |r| {
                kinic_sqlite_compat::row_get(r, 0)
            })
            .unwrap();
        assert_eq!(before, after);
    }
}

#[test]
fn initial_release_creates_v8_and_reopens_without_rewriting_data() {
    use kinic_sqlite_compat::{Connection, params};
    let db = Connection::open_in_memory().unwrap();
    crate::schema::initialize_vault_schema(&db).unwrap();
    db.execute(
        "INSERT INTO accounts VALUES('owner',123,456,789)",
        params![],
    )
    .unwrap();
    let version: i64 = db
        .query_row("PRAGMA user_version", params![], |r| {
            kinic_sqlite_compat::row_get(r, 0)
        })
        .unwrap();
    assert_eq!(version, 8);
    assert_eq!(db.query_row("SELECT count(*) FROM sqlite_master WHERE type='table' AND name IN ('settings','receipts')",[],|r|r.get::<_,i64>(0)).unwrap(),0);
    assert_eq!(db.query_row("SELECT count(*) FROM pragma_table_info('vault_cycle_reservations') WHERE name='account_owner'",[],|r|r.get::<_,i64>(0)).unwrap(),0);
    let before: i64 = db
        .query_row("SELECT total_changes()", params![], |r| {
            kinic_sqlite_compat::row_get(r, 0)
        })
        .unwrap();
    crate::schema::initialize_vault_schema(&db).unwrap();
    let after: i64 = db
        .query_row("SELECT total_changes()", params![], |r| {
            kinic_sqlite_compat::row_get(r, 0)
        })
        .unwrap();
    assert_eq!(before, after);
    let account: (i64, i64, i64) = db
        .query_row(
            "SELECT balance_cycles,storage_bytes,storage_charged_at_ms FROM accounts",
            params![],
            |r| {
                Ok((
                    kinic_sqlite_compat::row_get(r, 0)?,
                    kinic_sqlite_compat::row_get(r, 1)?,
                    kinic_sqlite_compat::row_get(r, 2)?,
                ))
            },
        )
        .unwrap();
    assert_eq!(account, (123, 456, 789));
}

#[test]
fn initial_release_rejects_sqlite_similar_foreign_names_without_changes() {
    use kinic_sqlite_compat::{Connection, params};
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch(
        "CREATE TABLE sqliteXforeign(secret BLOB); INSERT INTO sqliteXforeign VALUES(X'0102');",
    )
    .unwrap();
    assert_eq!(
        crate::schema::initialize_vault_schema(&db),
        Err(vault_types::Error::Storage)
    );
    let version: i64 = db
        .query_row("PRAGMA user_version", params![], |r| {
            kinic_sqlite_compat::row_get(r, 0)
        })
        .unwrap();
    assert_eq!(version, 0);
    let tables: i64 = db
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE type='table'",
            params![],
            |r| kinic_sqlite_compat::row_get(r, 0),
        )
        .unwrap();
    assert_eq!(tables, 1);
}

#[test]
fn initial_release_rejects_changed_v8_contract_without_repair() {
    use kinic_sqlite_compat::{Connection, params};
    for damage in [
        "ALTER TABLE operations ADD COLUMN future_column TEXT",
        "DROP INDEX one_upload_per_vault; CREATE INDEX one_upload_per_vault ON uploads(owner,vault)",
        "DROP TRIGGER key_pool_count; CREATE TRIGGER key_pool_count BEFORE INSERT ON key_flights BEGIN SELECT 1; END;",
    ] {
        let db = Connection::open_in_memory().unwrap();
        crate::schema::initialize_vault_schema(&db).unwrap();
        db.execute_batch(damage).unwrap();
        let before: i64 = db
            .query_row("SELECT total_changes()", params![], |r| {
                kinic_sqlite_compat::row_get(r, 0)
            })
            .unwrap();
        assert_eq!(
            crate::schema::initialize_vault_schema(&db),
            Err(vault_types::Error::Storage),
            "changed contract: {damage}"
        );
        let after: i64 = db
            .query_row("SELECT total_changes()", params![], |r| {
                kinic_sqlite_compat::row_get(r, 0)
            })
            .unwrap();
        assert_eq!(before, after);
    }
}

#[test]
fn initial_release_reapplies_page_policy_after_real_connection_reopen() {
    use kinic_sqlite_compat::{Connection, params};
    let path = std::env::temp_dir().join(format!(
        "vault-v8-policy-{}-{}.sqlite",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    {
        let db = Connection::open(&path).unwrap();
        crate::schema::initialize_vault_schema(&db).unwrap();
    }
    let db = Connection::open(&path).unwrap();
    let before: i64 = db
        .query_row("PRAGMA max_page_count", params![], |r| {
            kinic_sqlite_compat::row_get(r, 0)
        })
        .unwrap();
    assert_ne!(
        before, 262144,
        "reopen must really lose connection-local policy"
    );
    crate::schema::initialize_vault_schema(&db).unwrap();
    let after: i64 = db
        .query_row("PRAGMA max_page_count", params![], |r| {
            kinic_sqlite_compat::row_get(r, 0)
        })
        .unwrap();
    drop(db);
    std::fs::remove_file(path).unwrap();
    assert_eq!(after, 262144);
}

#[test]
fn ii_only_reopens_eight_and_rejects_seven_without_modifying_it() {
    let db = kinic_sqlite_compat::Connection::open_in_memory().unwrap();
    schema::initialize_vault_schema(&db).unwrap();
    let version: i64 = db
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap();
    assert_eq!(version, 8, "new installations must use the II-only schema");
    schema::initialize_vault_schema(&db).unwrap();
    db.execute_batch("PRAGMA user_version=7").unwrap();
    assert!(schema::initialize_vault_schema(&db).is_err());
    assert_eq!(
        db.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        7
    );
}

fn credit(owner: Principal, amount: u64) {
    state::transaction(|db| {
        db.execute(
            "INSERT INTO accounts VALUES(?1,?2,0,0)",
            kinic_sqlite_compat::params![owner.to_text(), amount as i64],
        )
        .unwrap();
        Ok(())
    })
    .unwrap();
}
#[test]
fn execution_checkpoints_refunds_and_storage_are_exact() {
    state::initialize().unwrap();
    let owner = p(31);
    credit(owner, 2_000_000_000);
    let s = state::State;
    s.vault_reserve_cycles(&owner.to_text(), "derive:1", 200_000_000, 0)
        .unwrap();
    assert_eq!(s.balance(&owner.to_text()).unwrap(), 1_800_000_000);
    s.vault_checkpoint_execution(&owner.to_text(), "derive:1", 5_000_000)
        .unwrap();
    s.vault_settle_cycles(&owner.to_text(), "derive:1", 100_000_000, 1)
        .unwrap();
    s.vault_finish_execution(&owner.to_text(), "derive:1", 7_000_000, 1)
        .unwrap();
    let once = s.balance(&owner.to_text()).unwrap();
    assert_eq!(once, 1_893_000_000);
    s.vault_settle_cycles(&owner.to_text(), "derive:1", 100_000_000, 1)
        .unwrap();
    s.vault_finish_execution(&owner.to_text(), "derive:1", 7_000_000, 1)
        .unwrap();
    assert_eq!(s.balance(&owner.to_text()).unwrap(), once);
    s.vault_reconcile_refunded_cycles(&owner.to_text(), "derive:1", 80_000_000, 2)
        .unwrap();
    assert_eq!(s.balance(&owner.to_text()).unwrap(), once + 20_000_000);
    s.vault_track_storage(&owner.to_text(), 1024 * 1024, 0)
        .unwrap();
    s.vault_settle_storage_timer_batch(86400000).unwrap();
    assert!(s.balance(&owner.to_text()).unwrap() < once + 20_000_000);
}
#[test]
fn cancellation_reconciliation_is_atomic_owner_scoped_and_survives_disable() {
    use kinic_sqlite_compat::params;
    state::initialize().unwrap();
    let owner = p(32);
    let other = p(33);
    credit(owner, 2_000_000_000);
    credit(other, 2_000_000_000);
    let scope = vault_store::OwnerContext::authenticated(owner).unwrap();
    state::transaction(|db| {
        scope.run(db, |db| {
            vault_store::keys::reserve(db, &[1; 16], 1, 1, 100_000_000)?;
            vault_store::keys::mark_sent(db, 1, 100_000_000)?;
            Ok(())
        })
    })
    .unwrap();
    let s = state::State;
    s.vault_reserve_cycles(&owner.to_text(), "derive:1", 120_000_000, 1000)
        .unwrap();
    s.vault_checkpoint_execution(&owner.to_text(), "derive:1", 20_000_000)
        .unwrap();
    state::transaction(|db| {
        scope.run(db, |db| {
            assert!(!accounting::recover_pending_in(
                db,
                owner,
                Some(&[2; 16]),
                2
            )?);
            assert!(vault_store::keys::current(db)?.is_some());
            accounting::recover_pending_in(db, owner, Some(&[1; 16]), 2)?;
            Ok(())
        })
    })
    .unwrap();
    assert_eq!(s.balance(&owner.to_text()).unwrap(), 1_880_000_000);
    assert_eq!(s.balance(&other.to_text()).unwrap(), 2_000_000_000);
    s.vault_set_config(None).unwrap();
    assert!(!s.vault_settle_key_flight(scope, 1, 3, 60_000_000).unwrap());
    s.vault_reconcile_refunded_cycles(&owner.to_text(), "derive:1", 60_000_000, 3000)
        .unwrap();
    assert_eq!(s.balance(&owner.to_text()).unwrap(), 1_920_000_000);
    state::transaction(|db| {
        let pending: i64 = db
            .query_row(
                "SELECT in_flight FROM key_flights WHERE owner=?1",
                params![owner.as_slice()],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(pending, 0);
        Ok(())
    })
    .unwrap();
}
#[test]
fn schema_eight_reopen_preserves_pending_upload_operation_receipt_balance_and_cursor() {
    use kinic_sqlite_compat::{Connection, params};
    let path =
        std::env::temp_dir().join(format!("vault-seven-pending-{}.sqlite", std::process::id()));
    {
        let db = Connection::open(&path).unwrap();
        schema::initialize_vault_schema(&db).unwrap();
        db.execute("INSERT INTO global_settings VALUES('gc-owner','01')", [])
            .unwrap();
        db.execute("INSERT INTO accounts VALUES('owner',42,7,8)", [])
            .unwrap();
        let scope = vault_store::OwnerContext::authenticated(p(1)).unwrap();
        scope.run(&db,|db|{let h=vault_types::Header{id:vec![1;16],nonce:vec![2;32],state:vault_types::VaultState::Active,sequence:0,key_name:"test_key_1".into(),public_key:vec![3;96]};db.execute("INSERT INTO vaults(owner,id,operation,header) VALUES((SELECT owner FROM owner_scope WHERE slot=1),?1,?2,?3)",params![h.id,vec![9u8;16],serde_json::to_string(&h).unwrap()]).unwrap();vault_store::content::begin(db,vault_types::BeginRevision{vault:vec![1;16],object:vec![2;16],expected_revision:0,operation:vec![3;16],plain_size:0,manifest:vec![4;64],chunk_hashes:vec![vec![5;32]]},1)?;vault_store::operations::begin(db,&[7;16],&[8;32],1)?;vault_store::keys::reserve(db, &[1; 16], 1,1,10)?;Ok(())}).unwrap();
    }
    let db = Connection::open(&path).unwrap();
    schema::initialize_vault_schema(&db).unwrap();
    for table in ["uploads", "operations", "key_flights", "accounts"] {
        assert_eq!(
            db.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }
    assert_eq!(
        db.query_row(
            "SELECT value FROM global_settings WHERE key='gc-owner'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "01"
    );
    drop(db);
    std::fs::remove_file(path).unwrap();
}
#[test]
fn offline_timer_recovers_expired_orphan_key_reservation() {
    state::initialize().unwrap();
    let owner = p(34);
    credit(owner, 1_000_000_000);
    let scope = vault_store::OwnerContext::authenticated(owner).unwrap();
    state::transaction(|db| {
        scope.run(db, |db| {
            vault_store::keys::reserve(db, &[1; 16], 1, 1, 100_000_000)?;
            vault_store::keys::mark_sent(db, 1, 100_000_000)?;
            Ok(())
        })
    })
    .unwrap();
    state::State
        .vault_reserve_cycles(&owner.to_text(), "derive:1", 120_000_000, 1000)
        .unwrap();
    state::initialize().unwrap();
    state::State
        .vault_settle_storage_timer_batch(121000)
        .unwrap();
    state::transaction(|db| {
        let flight: i64 = db
            .query_row("SELECT in_flight FROM key_flights", [], |r| r.get(0))
            .unwrap();
        assert_eq!(flight, 0);
        Ok(())
    })
    .unwrap();
}
#[test]
fn key_and_financial_callback_settlement_roll_back_together() {
    state::initialize().unwrap();
    let owner = p(35);
    credit(owner, 1_000_000_000);
    let scope = vault_store::OwnerContext::authenticated(owner).unwrap();
    state::transaction(|db| {
        scope.run(db, |db| {
            vault_store::keys::reserve(db, &[1; 16], 1, 1, 100_000_000)?;
            vault_store::keys::mark_sent(db, 1, 100_000_000)?;
            Ok(())
        })
    })
    .unwrap();
    state::State
        .vault_reserve_cycles(&owner.to_text(), "derive:1", 120_000_000, 1000)
        .unwrap();
    state::transaction(|db|{db.execute_batch("CREATE TRIGGER reject_refund BEFORE UPDATE ON accounts BEGIN SELECT RAISE(ABORT,'injected refund failure'); END;").unwrap();Ok(())}).unwrap();
    assert!(
        state::State
            .vault_settle_key_flight(scope, 1, 2, 50_000_000)
            .is_err()
    );
    state::transaction(|db| {
        assert_eq!(
            db.query_row("SELECT in_flight FROM key_flights", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        Ok(())
    })
    .unwrap();
}

#[test]
fn compatible_schema_eight_keeps_key_targets_results_and_financial_rows() {
    use kinic_sqlite_compat::{Connection, params};
    let db = Connection::open_in_memory().unwrap();
    schema::initialize_vault_schema(&db).unwrap();
    db.execute("INSERT INTO operations(owner,operation,digest,result,expires,token,runtime,admission) VALUES(X'01',?1,?2,NULL,300,1,0,3),(X'01',?3,?2,?4,86400,2,0,3)",params![vec![1u8;16],vec![2u8;32],vec![3u8;16],candid::encode_one(true).unwrap()]).unwrap();
    db.execute("INSERT INTO key_flights(owner,vault,token,day,reserved,created,payment) VALUES(X'01',zeroblob(16),1,0,30000000000,0,120000000)",[]).unwrap();
    db.execute("INSERT INTO accounts VALUES('owner',42,7,8)", [])
        .unwrap();
    db.execute("INSERT INTO vault_cycle_reservations(owner,token,reserved,created_at_ms) VALUES('owner','derive:1',120000000,0)",[]).unwrap();
    let snapshot = || {
        db.query_row("SELECT json_object('operations',(SELECT json_group_array(hex(operation)||':'||admission||':'||hex(result)) FROM operations),'target',(SELECT hex(vault) FROM key_flights),'balance',(SELECT balance_cycles FROM accounts),'reserved',(SELECT reserved FROM vault_cycle_reservations),'flight',(SELECT reserved FROM key_flights))",[],|r|r.get::<_,String>(0)).unwrap()
    };
    let before = snapshot();
    schema::initialize_vault_schema(&db).unwrap();
    assert_eq!(snapshot(), before);
}
