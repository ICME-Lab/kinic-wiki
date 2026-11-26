use super::*;
use candid::Principal;
use funding::*;
fn p(n: u8) -> Principal {
    Principal::from_slice(&[n])
}
#[test]
fn funding_discovery_and_consent_are_exported() {
    let service = __export_service();
    assert!(service.contains("get_funding_config : () ->"));
    assert!(service.contains("icrc10_supported_standards : () ->"));
    assert!(
        service.contains("icrc21_canister_call_consent_message : (Icrc21ConsentMessageRequest) ->")
    );
}
#[test]
fn spending_status_is_an_update_in_the_public_interface() {
    let service = __export_service();
    let method = service
        .lines()
        .find(|line| line.trim_start().starts_with("get_spending_status : () ->"));
    assert!(method.is_some_and(|line| !line.contains("query")));
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
fn pending_fee_reserves_only_the_wallet_payment_capacity_before_dispatch() {
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
    let last = match admit_quote(p(191), req(15), cfg.clone(), 0).unwrap() {
        QuoteAdmission::Fee(f) => f,
        _ => panic!("fee slot expected"),
    };
    assert!(matches!(
        admit_quote(p(191), req(16), cfg.clone(), 0),
        Err(vault_types::Error::QuotaExceeded)
    ));
    let other = match admit_quote(p(192), req(1), cfg.clone(), 0).unwrap() {
        QuoteAdmission::Fee(f) => f,
        _ => panic!("another wallet can reserve its fee slot"),
    };
    finish_quote(&last, Ok(10), 1).unwrap();
    finish_quote(&other, Ok(10), 1).unwrap();
    assert!(matches!(
        admit_quote(p(191), req(16), cfg, 2),
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
    for version in [0, 8, 999] {
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
fn initial_release_creates_v14_and_reopens_without_rewriting_data() {
    use kinic_sqlite_compat::{Connection, params};
    let db = Connection::open_in_memory().unwrap();
    crate::schema::initialize_vault_schema(&db).unwrap();
    db.execute(
        "INSERT INTO accounts(owner,balance_cycles,storage_bytes,storage_charged_at_ms) VALUES('owner',123,456,789)",
        params![],
    )
    .unwrap();
    let version: i64 = db
        .query_row("PRAGMA user_version", params![], |r| {
            kinic_sqlite_compat::row_get(r, 0)
        })
        .unwrap();
    assert_eq!(version, 15);
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
    db.execute("UPDATE accounts SET storage_charge_remainder=123456", [])
        .unwrap();
    crate::schema::initialize_vault_schema(&db).unwrap();
    let account: (i64, i64, i64, i64) = db
        .query_row(
            "SELECT balance_cycles,storage_bytes,storage_charged_at_ms,storage_charge_remainder FROM accounts",
            params![],
            |r| {
                Ok((
                    kinic_sqlite_compat::row_get(r, 0)?,
                    kinic_sqlite_compat::row_get(r, 1)?,
                    kinic_sqlite_compat::row_get(r, 2)?,
                    kinic_sqlite_compat::row_get(r, 3)?,
                ))
            },
        )
        .unwrap();
    assert_eq!(account, (123, 456, 789, 123456));
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
fn initial_release_rejects_changed_v9_contract_without_repair() {
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
fn initial_release_leaves_sqlite_page_limit_at_its_default_on_reopen() {
    use kinic_sqlite_compat::{Connection, params};
    let path = std::env::temp_dir().join(format!(
        "vault-v9-policy-{}-{}.sqlite",
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
    assert!(before > 262144);
    crate::schema::initialize_vault_schema(&db).unwrap();
    let after: i64 = db
        .query_row("PRAGMA max_page_count", params![], |r| {
            kinic_sqlite_compat::row_get(r, 0)
        })
        .unwrap();
    drop(db);
    std::fs::remove_file(path).unwrap();
    assert_eq!(after, before);
}

#[test]
fn current_schema_initialization_is_idempotent() {
    let db = kinic_sqlite_compat::Connection::open_in_memory().unwrap();
    schema::initialize_vault_schema(&db).unwrap();
    let version: i64 = db
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap();
    assert_eq!(
        version, 15,
        "new installations must use exact storage accounting"
    );
    schema::initialize_vault_schema(&db).unwrap();
}

fn credit(owner: Principal, amount: u64) {
    state::transaction(|db| {
        db.execute(
            "INSERT INTO accounts(owner,balance_cycles,storage_bytes,storage_charged_at_ms) VALUES(?1,?2,0,0)",
            kinic_sqlite_compat::params![owner.to_text(), amount as i64],
        )
        .unwrap();
        Ok(())
    })
    .unwrap();
}
#[test]
fn spending_status_settles_storage_only_when_admission_succeeds() {
    use vault_types::SpendingStatus::*;

    state::initialize().unwrap();
    let state = state::State;
    let principal = p(201);
    let owner = vault_store::OwnerContext::authenticated(principal).unwrap();
    let status = |cycles, now| api::spending_status(owner, cycles, now);
    assert_eq!(status(100_000_000_000, 0), Ok(Unconfigured));
    state
        .vault_set_config(Some(VaultConfig {
            key_name: "test_key_1".into(),
            minimum_cycles: 100_000_000_000,
        }))
        .unwrap();
    assert_eq!(status(99_999_999_999, 0), Ok(ServiceReserveLow));
    assert_eq!(status(100_000_000_000, 0), Ok(AccountCreditLow));
    state::transaction(|db| {
        let count: i64 = db
            .query_row("SELECT count(*) FROM accounts", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
        Ok(())
    })
    .unwrap();

    credit(principal, 20_127_000);
    state
        .vault_track_storage(&principal.to_text(), 1_073_741_824, 0)
        .unwrap();
    assert_eq!(status(100_000_000_000, 1000), Ok(Available));
    assert_eq!(state.balance(&principal.to_text()), Ok(20_000_000));
    assert_eq!(status(100_000_000_000, 1001), Ok(AccountCreditLow));
    assert_eq!(state.balance(&principal.to_text()), Ok(20_000_000));
}

#[test]
fn spending_status_reports_account_storage_failure() {
    state::initialize().unwrap();
    state::State
        .vault_set_config(Some(VaultConfig {
            key_name: "test_key_1".into(),
            minimum_cycles: 100_000_000_000,
        }))
        .unwrap();
    state::transaction(|db| {
        db.execute("DROP TABLE accounts", []).unwrap();
        Ok(())
    })
    .unwrap();
    let owner = vault_store::OwnerContext::authenticated(p(202)).unwrap();
    assert_eq!(
        api::spending_status(owner, 100_000_000_000, 0),
        Err(Error::Storage)
    );
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
fn schema_ten_reopen_preserves_pending_upload_operation_receipt_balance_and_cursor() {
    use kinic_sqlite_compat::{Connection, params};
    let path =
        std::env::temp_dir().join(format!("vault-nine-pending-{}.sqlite", std::process::id()));
    {
        let db = Connection::open(&path).unwrap();
        schema::initialize_vault_schema(&db).unwrap();
        db.execute("INSERT INTO global_settings VALUES('gc-owner','01')", [])
            .unwrap();
        db.execute("INSERT INTO accounts(owner,balance_cycles,storage_bytes,storage_charged_at_ms,storage_charge_remainder) VALUES('owner',42,7,8,123456)", [])
            .unwrap();
        let scope = vault_store::OwnerContext::authenticated(p(1)).unwrap();
        scope.run(&db,|db|{let h=vault_types::Header{name:None,id:vec![1;16],nonce:vec![2;32],state:vault_types::VaultState::Active,sequence:0,key_name:"test_key_1".into(),public_key:vec![3;96]};db.execute("INSERT INTO vaults(owner,id,operation,header) VALUES((SELECT owner FROM owner_scope WHERE slot=1),?1,?2,?3)",params![h.id,vec![9u8;16],serde_json::to_string(&h).unwrap()]).unwrap();vault_store::content::begin(db,vault_types::BeginRevision{vault:vec![1;16],object:vec![2;16],expected_revision:0,operation:vec![3;16],plain_size:0,manifest:vec![4;64],chunk_hashes:vec![vec![5;32]]},1)?;vault_store::operations::begin(db,&[7;16],&[8;32],1)?;vault_store::keys::reserve(db, &[1; 16], 1,1,10)?;Ok(())}).unwrap();
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
    assert_eq!(
        db.query_row("SELECT storage_charge_remainder FROM accounts", [], |r| r
            .get::<_, i64>(
            0
        ))
        .unwrap(),
        123456
    );
    vault_store::OwnerContext::authenticated(p(1))
        .unwrap()
        .run(&db, |db| {
            let token = vault_store::operations::begin(db, &[10; 16], &[11; 32], 2)?;
            assert_eq!(token, 2, "reopening must preserve the global serial");
            Ok(())
        })
        .unwrap();
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
fn legacy_schema_eight_keeps_key_targets_results_and_financial_rows() {
    use kinic_sqlite_compat::{Connection, params};
    let db = Connection::open_in_memory().unwrap();
    schema::initialize_legacy_v8(&db);
    db.execute("INSERT INTO operations(owner,operation,digest,result,expires,token,runtime,admission) VALUES(X'01',?1,?2,NULL,300,1,0,3),(X'01',?3,?2,?4,86400,2,0,3)",params![vec![1u8;16],vec![2u8;32],vec![3u8;16],candid::encode_one(true).unwrap()]).unwrap();
    db.execute("INSERT INTO key_flights(owner,vault,token,day,reserved,created,payment) VALUES(X'01',zeroblob(16),1,0,30000000000,0,120000000)",[]).unwrap();
    db.execute("INSERT INTO accounts(owner,balance_cycles,storage_bytes,storage_charged_at_ms) VALUES('owner',42,7,8)", [])
        .unwrap();
    db.execute("INSERT INTO vault_cycle_reservations(owner,token,reserved,created_at_ms) VALUES('owner','derive:1',120000000,0)",[]).unwrap();
    let snapshot = || {
        db.query_row("SELECT json_object('operations',(SELECT json_group_array(hex(operation)||':'||admission||':'||hex(result)) FROM operations),'target',(SELECT hex(vault) FROM key_flights),'balance',(SELECT balance_cycles FROM accounts),'reserved',(SELECT reserved FROM vault_cycle_reservations),'flight',(SELECT reserved FROM key_flights))",[],|r|r.get::<_,String>(0)).unwrap()
    };
    let before = snapshot();
    schema::initialize_vault_schema(&db).unwrap();
    assert_eq!(snapshot(), before);
}

// Exact billing tests use independently known rates: 1 GiB/ms = 127 cycles,
// and 1 MiB over 1024 ms = 127 cycles.
#[test]
fn storage_billing_is_independent_of_settlement_partition() {
    state::initialize().unwrap();
    let whole = p(220).to_text();
    let split = p(221).to_text();
    credit(p(220), 10_000);
    credit(p(221), 10_000);
    let s = state::State;
    s.vault_track_storage(&whole, 1_048_576, 0).unwrap();
    s.vault_track_storage(&split, 1_048_576, 0).unwrap();
    s.vault_track_storage(&whole, 1_048_576, 1024).unwrap();
    for now in 1..=1024 {
        s.vault_track_storage(&split, 1_048_576, now).unwrap();
    }
    assert_eq!(s.balance(&whole).unwrap(), 9_873);
    assert_eq!(s.balance(&split).unwrap(), 9_873);
}

#[test]
fn storage_billing_settles_subsecond_usage_before_changing_bytes() {
    state::initialize().unwrap();
    credit(p(222), 10_000);
    let owner = p(222).to_text();
    let s = state::State;
    s.vault_track_storage(&owner, 1_073_741_824, 0).unwrap();
    s.vault_track_storage(&owner, 0, 1).unwrap();
    assert_eq!(s.balance(&owner).unwrap(), 9_873);
    s.vault_track_storage(&owner, 0, 1000).unwrap();
    assert_eq!(s.balance(&owner).unwrap(), 9_873);
}

#[test]
fn storage_billing_carries_fraction_across_size_changes() {
    state::initialize().unwrap();
    credit(p(223), 100);
    let owner = p(223).to_text();
    let s = state::State;
    s.vault_track_storage(&owner, 1_048_576, 0).unwrap();
    s.vault_track_storage(&owner, 2_097_152, 8).unwrap();
    assert_eq!(s.balance(&owner).unwrap(), 100);
    s.vault_track_storage(&owner, 0, 12).unwrap();
    assert_eq!(s.balance(&owner).unwrap(), 99);
}

#[test]
fn storage_billing_does_not_rewind_checkpoint_when_clock_moves_backwards() {
    state::initialize().unwrap();
    credit(p(224), 1_000_000);
    let owner = p(224).to_text();
    let s = state::State;
    s.vault_track_storage(&owner, 1_073_741_824, 1000).unwrap();
    s.vault_track_storage(&owner, 1_073_741_824, 500).unwrap();
    s.vault_track_storage(&owner, 0, 1500).unwrap();
    assert_eq!(s.balance(&owner).unwrap(), 936_500);
    state::transaction(|db| {
        let at: i64 = db
            .query_row(
                "SELECT storage_charged_at_ms FROM accounts WHERE owner=?1",
                [owner],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(at, 1500);
        Ok(())
    })
    .unwrap();
}

#[test]
fn storage_billing_discards_unpaid_usage_and_fraction_at_zero_balance() {
    state::initialize().unwrap();
    let owner = p(225).to_text();
    credit(p(225), 1);
    let s = state::State;
    s.vault_track_storage(&owner, 1_048_576, 0).unwrap();
    s.vault_track_storage(&owner, 1_048_576, 16).unwrap(); // 1 + 126/128 cycles
    assert_eq!(s.balance(&owner).unwrap(), 0);
    state::transaction(|db| {
        let remainder: i64 = db
            .query_row(
                "SELECT storage_charge_remainder FROM accounts WHERE owner=?1",
                [&owner],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            remainder, 0,
            "exact exhaustion must discard its fraction immediately"
        );
        Ok(())
    })
    .unwrap();
    s.vault_track_storage(&owner, 1_048_576, 32).unwrap(); // unpaid usage is discarded
    state::transaction(|db| {
        db.execute(
            "UPDATE accounts SET balance_cycles=100 WHERE owner=?1",
            [owner.clone()],
        )
        .unwrap();
        Ok(())
    })
    .unwrap();
    s.vault_track_storage(&owner, 1_048_576, 40).unwrap(); // 127/128 cycles, no debt
    assert_eq!(s.balance(&owner).unwrap(), 100);
}

fn billing_account(owner: &str) -> (i64, i64) {
    state::transaction(|db| {
        Ok(db
            .query_row(
                "SELECT balance_cycles,storage_charged_at_ms FROM accounts WHERE owner=?1",
                [owner],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap())
    })
    .unwrap()
}
fn seed_billing_round() {
    state::initialize().unwrap();
    state::transaction(|db| {
        for n in 0..1001 {
            db.execute("INSERT INTO accounts(owner,balance_cycles,storage_bytes,storage_charged_at_ms) VALUES(?1,10000,1048576,0)", [format!("a{n:04}")]).unwrap();
        }
        Ok(())
    }).unwrap();
}
#[test]
fn storage_billing_isolates_owner_failure_advances_cursor_and_retries_next_round() {
    seed_billing_round();
    state::transaction(|db| {
        // Fail after balance debit, so isolation must roll back the debit too.
        db.execute_batch("CREATE TRIGGER fail_one_owner BEFORE INSERT ON account_ledger WHEN NEW.owner='a0000' BEGIN SELECT RAISE(ABORT,'injected owner failure'); END;").unwrap();
        Ok(())
    }).unwrap();
    let s = state::State;
    s.vault_settle_storage_timer_batch(1024).unwrap();
    assert_eq!(billing_account("a0000"), (10000, 0));
    assert_eq!(billing_account("a0001"), (9873, 1024));
    assert_eq!(billing_account("a1000"), (10000, 0));
    state::transaction(|db| {
        assert_eq!(
            db.query_row(
                "SELECT cursor_owner FROM vault_storage_billing_state",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "a0999"
        );
        Ok(())
    })
    .unwrap();
    s.vault_settle_storage_timer_batch(2048).unwrap();
    assert_eq!(billing_account("a1000"), (9873, 1024));
    state::transaction(|db| {
        db.execute_batch("DROP TRIGGER fail_one_owner").unwrap();
        Ok(())
    })
    .unwrap();
    s.vault_settle_storage_timer_batch(2048).unwrap();
    assert_eq!(billing_account("a0000"), (9746, 2048));
    assert_eq!(billing_account("a0001"), (9746, 2048));
}

#[test]
fn storage_billing_database_failure_aborts_the_outer_batch() {
    state::initialize().unwrap();
    credit(p(226), 10000);
    state::State
        .vault_track_storage(&p(226).to_text(), 1_048_576, 0)
        .unwrap();
    state::transaction(|db| {
        db.execute_batch("DROP TABLE account_ledger").unwrap();
        Ok(())
    })
    .unwrap();
    assert!(state::State.vault_settle_storage_timer_batch(1024).is_err());
    assert_eq!(billing_account(&p(226).to_text()), (10000, 0));
}

#[test]
fn storage_billing_cursor_failure_rolls_back_successful_owners() {
    seed_billing_round();
    state::transaction(|db| { db.execute_batch("CREATE TRIGGER fail_cursor BEFORE INSERT ON vault_storage_billing_state BEGIN SELECT RAISE(ABORT,'injected cursor failure'); END;").unwrap(); Ok(()) }).unwrap();
    assert!(state::State.vault_settle_storage_timer_batch(1024).is_err());
    assert_eq!(billing_account("a0000"), (10000, 0));
    assert_eq!(billing_account("a0999"), (10000, 0));
}

#[test]
fn storage_billing_continues_after_independent_expiry_failure() {
    state::initialize().unwrap();
    credit(p(227), 10000);
    let owner = p(227).to_text();
    state::State
        .vault_track_storage(&owner, 1_048_576, 0)
        .unwrap();
    // Expiry's initial lookup fails; billing still has all of its own tables.
    state::transaction(|db| {
        db.execute_batch("DROP TABLE uploads").unwrap();
        Ok(())
    })
    .unwrap();
    state::State.vault_settle_storage_timer_batch(1024).unwrap();
    assert_eq!(billing_account(&owner), (9873, 1024));
}

#[test]
fn storage_billing_upgrade_preserves_remainder_and_continues_exactly() {
    state::initialize().unwrap();
    credit(p(228), 100);
    let owner = p(228).to_text();
    state::State
        .vault_track_storage(&owner, 1_048_576, 0)
        .unwrap();
    state::State
        .vault_track_storage(&owner, 1_048_576, 8)
        .unwrap();
    state::initialize().unwrap(); // real initialization / generation boundary
    state::State.vault_track_storage(&owner, 0, 16).unwrap();
    assert_eq!(state::State.balance(&owner).unwrap(), 99);
}

#[test]
fn initial_release_rejects_development_schema_eight_without_changes() {
    let db = kinic_sqlite_compat::Connection::open_in_memory().unwrap();
    schema::initialize_vault_schema(&db).unwrap();
    db.execute_batch("INSERT INTO accounts(owner,balance_cycles,storage_charged_at_ms) VALUES('owner',42,7); PRAGMA user_version=8;").unwrap();
    let before: i64 = db
        .query_row("SELECT total_changes()", [], |r| r.get(0))
        .unwrap();
    assert_eq!(
        schema::initialize_vault_schema(&db),
        Err(vault_types::Error::Storage)
    );
    assert_eq!(
        db.query_row("SELECT total_changes()", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        before
    );
    assert_eq!(
        db.query_row("SELECT balance_cycles FROM accounts", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        42
    );
    assert_eq!(
        db.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        8
    );
}

#[test]
fn storage_billing_failed_checkpoint_preserves_fraction_balance_and_ledger() {
    state::initialize().unwrap();
    let owner = p(229).to_text();
    credit(p(229), 10000);
    state::State
        .vault_track_storage(&owner, 1_048_576, 0)
        .unwrap();
    state::State
        .vault_track_storage(&owner, 1_048_576, 8)
        .unwrap();
    state::transaction(|db| {
        db.execute_batch("CREATE TRIGGER fail_checkpoint BEFORE UPDATE OF storage_charged_at_ms ON accounts BEGIN SELECT RAISE(ABORT,'injected checkpoint failure'); END;").unwrap();
        Ok(())
    }).unwrap();
    state::State.vault_settle_storage_timer_batch(16).unwrap();
    assert_eq!(billing_account(&owner), (10000, 8));
    state::transaction(|db| {
        assert_eq!(
            db.query_row("SELECT storage_charge_remainder FROM accounts", [], |r| r
                .get::<_, i64>(
                0
            ))
            .unwrap(),
            1065353216000
        ); // 127/128 of denominator
        assert_eq!(
            db.query_row("SELECT count(*) FROM account_ledger", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        db.execute_batch("DROP TRIGGER fail_checkpoint").unwrap();
        Ok(())
    })
    .unwrap();
    state::State.vault_settle_storage_timer_batch(16).unwrap();
    assert_eq!(billing_account(&owner), (9999, 16));
}

#[test]
fn storage_billing_missing_savepoint_aborts_the_outer_batch() {
    seed_billing_round();
    state::transaction(|db| {
        // ROLLBACK invalidates both the owner savepoint and outer transaction.
        db.execute_batch("CREATE TRIGGER destroy_savepoint BEFORE INSERT ON account_ledger WHEN NEW.owner='a0001' BEGIN SELECT RAISE(ROLLBACK,'injected transaction failure'); END;").unwrap();
        Ok(())
    }).unwrap();
    assert!(state::State.vault_settle_storage_timer_batch(1024).is_err());
    assert_eq!(billing_account("a0000"), (10000, 0));
    assert_eq!(billing_account("a0001"), (10000, 0));
}

#[test]
fn storage_billing_checked_overflow_keeps_owner_checkpoint_and_continues() {
    state::initialize().unwrap();
    state::transaction(|db| {
        db.execute("INSERT INTO accounts(owner,balance_cycles,storage_bytes,storage_charged_at_ms) VALUES('overflow',10000,?1,?2)", kinic_sqlite_compat::params![i64::MAX,i64::MIN]).unwrap();
        db.execute("INSERT INTO accounts(owner,balance_cycles,storage_bytes,storage_charged_at_ms) VALUES('success',10000,1048576,0)", []).unwrap();
        Ok(())
    }).unwrap();
    state::State.vault_settle_storage_timer_batch(1024).unwrap();
    assert_eq!(billing_account("overflow"), (10000, i64::MIN));
    assert_eq!(billing_account("success"), (9873, 1024));
}

#[test]
fn storage_billing_caps_a_charge_larger_than_i64_at_the_available_balance() {
    state::initialize().unwrap();
    credit(p(230), 10000);
    let owner = p(230).to_text();
    state::State
        .vault_track_storage(&owner, 1_073_741_824, 0)
        .unwrap();
    state::State
        .vault_settle_storage_timer_batch(i64::MAX)
        .unwrap();
    assert_eq!(billing_account(&owner), (0, i64::MAX));
    state::transaction(|db| {
        assert_eq!(
            db.query_row("SELECT amount_cycles FROM account_ledger", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            -10000
        );
        assert_eq!(
            db.query_row("SELECT storage_charge_remainder FROM accounts", [], |r| r
                .get::<_, i64>(
                0
            ))
            .unwrap(),
            0
        );
        Ok(())
    })
    .unwrap();
}

#[test]
fn storage_billing_fraction_is_discarded_when_execution_exhausts_balance() {
    state::initialize().unwrap();
    let owner = p(231).to_text();
    credit(p(231), 100);
    let s = state::State;
    s.vault_track_storage(&owner, 1_048_576, 0).unwrap();
    s.vault_track_storage(&owner, 1_048_576, 8).unwrap(); // 127/128 of one cycle
    state::transaction(|db| {
        let remainder: i64 = db
            .query_row(
                "SELECT storage_charge_remainder FROM accounts WHERE owner=?1",
                [&owner],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(remainder, 1065353216000);
        Ok(())
    })
    .unwrap();
    s.vault_charge_execution(&owner, 100, 8).unwrap();
    assert_eq!(billing_account(&owner), (0, 8));
    state::transaction(|db| {
        let remainder: i64 = db
            .query_row(
                "SELECT storage_charge_remainder FROM accounts WHERE owner=?1",
                [&owner],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            remainder, 0,
            "execution exhaustion must discard the accrued fraction immediately"
        );
        // Native top-up fixture: no timer or storage settlement before credit.
        db.execute(
            "UPDATE accounts SET balance_cycles=100 WHERE owner=?1",
            [&owner],
        )
        .unwrap();
        Ok(())
    })
    .unwrap();
    s.vault_track_storage(&owner, 1_048_576, 16).unwrap(); // only the new 127/128 cycle
    assert_eq!(s.balance(&owner).unwrap(), 100);
}

#[test]
fn initial_vault_grant_is_once_per_new_principal_and_never_for_existing_accounts() {
    state::initialize().unwrap();
    let owner = p(240);
    let first = state::State.initialize_account(owner, 100).unwrap();
    assert_eq!(first.balance, 10_000_000_000);
    assert_eq!(first.grant_cycles, 10_000_000_000);
    let again = state::State.initialize_account(owner, 101).unwrap();
    assert_eq!(again.balance, 10_000_000_000);
    state::transaction(|db| {
        db.execute(
            "UPDATE accounts SET balance_cycles=0 WHERE owner=?1",
            [owner.to_text()],
        )
        .unwrap();
        Ok(())
    })
    .unwrap();
    assert_eq!(
        state::State.initialize_account(owner, 102).unwrap().balance,
        0
    );
    credit(p(241), 123);
    state::transaction(|db| {
        kinic_cycle_grants::record_once(
            db,
            kinic_cycle_grants::Scope::Vault,
            &p(241).to_text(),
            "vault",
            0,
            0,
        )
        .unwrap();
        Ok(())
    })
    .unwrap();
    let existing = state::State.initialize_account(p(241), 103).unwrap();
    assert_eq!(existing.balance, 123);
    assert_eq!(existing.grant_cycles, 0);
    assert!(
        state::State
            .initialize_account(Principal::anonymous(), 104)
            .is_err()
    );
    state::transaction(|db| {
        assert_eq!(
            db.query_row(
                "SELECT count(*) FROM account_ledger WHERE owner=?1 AND kind='free_grant'",
                [owner.to_text()],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
        Ok(())
    })
    .unwrap();
}

#[test]
fn schema_ten_excludes_legacy_accounts_vault_owners_and_payment_participants() {
    let db = kinic_sqlite_compat::Connection::open_in_memory().unwrap();
    schema::legacy_v9_for_test(&db);
    db.execute(
        "INSERT INTO accounts(owner,balance_cycles,storage_charged_at_ms) VALUES(?1,123,99)",
        [p(1).to_text()],
    )
    .unwrap();
    db.execute(
        "INSERT INTO vaults(owner,id,operation,header) VALUES(?1,?2,?3,'{}')",
        kinic_sqlite_compat::params![p(2).as_slice(), vec![1u8; 16], vec![2u8; 16]],
    )
    .unwrap();
    let record = serde_json::json!({"request":{"beneficiary":p(5).to_text()}}).to_string();
    db.execute(
        "INSERT INTO payments VALUES(?1,?2,?3,1)",
        kinic_sqlite_compat::params![p(3).to_text(), vec![3u8; 16], record],
    )
    .unwrap();
    let flight =
        serde_json::json!({"payment":{"request":{"beneficiary":p(7).to_text()}}}).to_string();
    db.execute(
        "INSERT INTO quote_fee_flights VALUES(?1,?2,1,1,999,?3)",
        kinic_sqlite_compat::params![p(6).to_text(), vec![6u8; 16], flight],
    )
    .unwrap();
    schema::initialize_vault_schema(&db).unwrap();
    for n in [1, 2, 3, 5, 6, 7] {
        assert_eq!(
            kinic_cycle_grants::recorded(&db, kinic_cycle_grants::Scope::Vault, &p(n).to_text())
                .unwrap(),
            Some(0)
        );
    }
    assert_eq!(
        db.query_row("SELECT balance_cycles FROM accounts", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        123
    );
    schema::initialize_vault_schema(&db).unwrap();
    assert_eq!(
        db.query_row("SELECT count(*) FROM initial_cycle_grants", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        6
    );
}
#[test]
fn failed_grant_migration_rolls_back_schema_and_version() {
    let db = kinic_sqlite_compat::Connection::open_in_memory().unwrap();
    schema::legacy_v9_for_test(&db);
    db.execute(
        "INSERT INTO accounts(owner,balance_cycles,storage_charged_at_ms) VALUES('',123,99)",
        [],
    )
    .unwrap();
    assert!(schema::initialize_vault_schema(&db).is_err());
    assert_eq!(
        db.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        9
    );
    assert_eq!(
        db.query_row(
            "SELECT count(*) FROM sqlite_master WHERE name='initial_cycle_grants'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
}
#[test]
fn initial_grant_preserves_new_paid_credit_and_admits_after_former_account_cap() {
    state::initialize().unwrap();
    credit(p(242), 123);
    assert_eq!(
        state::State.initialize_account(p(242), 1).unwrap().balance,
        10_000_000_123
    );
    state::transaction(|db| {
        for n in 1..vault_types::capacity::ACCOUNTS {
            db.execute(
                "INSERT INTO accounts(owner,balance_cycles,storage_charged_at_ms) VALUES(?1,0,0)",
                [format!("fixture-{n}")],
            )
            .unwrap();
        }
        Ok(())
    })
    .unwrap();
    assert_eq!(
        state::State
            .initialize_account(p(243), 2)
            .unwrap()
            .grant_cycles,
        10_000_000_000
    );
    state::transaction(|db| {
        assert_eq!(
            kinic_cycle_grants::recorded(db, kinic_cycle_grants::Scope::Vault, &p(243).to_text())
                .unwrap(),
            Some(10_000_000_000)
        );
        Ok(())
    })
    .unwrap();
}
#[test]
fn a_full_subsidy_faucet_still_initializes_a_funded_account() {
    state::initialize().unwrap();
    let owner = p(243);
    credit(owner, 100_000_000_000);
    state::transaction(|db| {
        for n in 0..vault_types::capacity::SUBSIDIES {
            crate::key_subsidy::initialize_in(db, &format!("faucet-{n}"))?;
        }
        Ok(())
    })
    .unwrap();
    let initial = state::State.initialize_account(owner, 0).unwrap();
    assert_eq!(initial.balance, 100_000_000_000);
    assert_eq!(initial.grant_cycles, 0);
    assert!(
        state::State
            .vault_spending_available(&owner.to_text(), 0)
            .unwrap()
    );
    state::transaction(|db| {
        assert!(!crate::key_subsidy::available_in(db, &owner.to_text())?);
        assert_eq!(
            kinic_cycle_grants::recorded(db, kinic_cycle_grants::Scope::Vault, &owner.to_text())
                .unwrap(),
            None
        );
        Ok(())
    })
    .unwrap();
}
#[test]
fn initial_grant_receipt_and_balance_roll_back_on_ledger_failure() {
    state::initialize().unwrap();
    state::transaction(|db| {db.execute_batch("CREATE TRIGGER fail_free_grant BEFORE INSERT ON account_ledger WHEN NEW.kind='free_grant' BEGIN SELECT RAISE(ABORT,'fixture'); END;").unwrap();Ok(())}).unwrap();
    assert!(state::State.initialize_account(p(244), 1).is_err());
    state::transaction(|db| {
        assert_eq!(
            db.query_row("SELECT count(*) FROM accounts", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            db.query_row("SELECT count(*) FROM initial_cycle_grants", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        Ok(())
    })
    .unwrap();
}

#[test]
fn initial_grant_defers_without_consuming_reserved_payment_capacity() {
    state::initialize().unwrap();
    let owner = p(245);
    let credits = i64::MAX as u64 - 5_000_000_000;
    let request = PurchaseRequest {
        operation: vec![245; 16],
        beneficiary: owner,
        amount_e8s: 100_000_000,
        min_credits: credits,
        created_at_time: 1_000_000_000,
    };
    let config = FundingConfig {
        ledger: p(246),
        recipient: p(247),
        cycles_per_kinic: credits,
    };
    record_quote(owner, request.clone(), config, 10, 1_000_000_000).unwrap();
    let pending = begin_payment(owner, &request.operation, 1_000_000_000).unwrap();
    let initialized = state::State.initialize_account(owner, 1_000).unwrap();
    assert_eq!(initialized.grant_cycles, 0);
    state::transaction(|db| {
        assert_eq!(
            kinic_cycle_grants::recorded(db, kinic_cycle_grants::Scope::Vault, &owner.to_text())
                .unwrap(),
            None
        );
        Ok(())
    })
    .unwrap();
    complete_payment(&pending, Outcome::Paid(99)).unwrap();
    assert_eq!(state::State.balance(&owner.to_text()).unwrap(), credits);
    // Once credit is spent, the unconsumed grant can be claimed exactly once.
    state::transaction(|db| {
        db.execute(
            "UPDATE accounts SET balance_cycles=0 WHERE owner=?1",
            [owner.to_text()],
        )
        .unwrap();
        Ok(())
    })
    .unwrap();
    assert_eq!(
        state::State
            .initialize_account(owner, 1_001)
            .unwrap()
            .balance,
        10_000_000_000
    );
}

#[test]
fn initial_grant_defers_when_reserved_refunds_need_the_remaining_headroom() {
    state::initialize().unwrap();
    let owner = p(248);
    credit(owner, i64::MAX as u64 - 5_000_000_000);
    state::State
        .vault_reserve_cycles(&owner.to_text(), "derive:fixture", 50_000_000_000, 0)
        .unwrap();
    let initialized = state::State.initialize_account(owner, 0).unwrap();
    assert_eq!(initialized.grant_cycles, 0);
    state::State
        .vault_settle_cycles(&owner.to_text(), "derive:fixture", 0, 1)
        .unwrap();
    assert_eq!(
        state::State.balance(&owner.to_text()).unwrap(),
        i64::MAX as u64 - 5_000_000_000
    );
}

#[test]
fn initial_grant_preserves_headroom_for_unknown_third_party_payments() {
    state::initialize().unwrap();
    let owner = p(249);
    let wallet = p(250);
    let credits = i64::MAX as u64 - 5_000_000_000;
    let request = PurchaseRequest {
        operation: vec![249; 16],
        beneficiary: owner,
        amount_e8s: 100_000_000,
        min_credits: credits,
        created_at_time: 1_000_000_000,
    };
    let config = FundingConfig {
        ledger: p(246),
        recipient: p(247),
        cycles_per_kinic: credits,
    };
    record_quote(wallet, request.clone(), config, 10, 1_000_000_000).unwrap();
    let pending = begin_payment(wallet, &request.operation, 1_000_000_000).unwrap();
    complete_payment(&pending, Outcome::Unknown).unwrap();
    assert_eq!(
        state::State
            .initialize_account(owner, 1_000)
            .unwrap()
            .grant_cycles,
        0
    );
    complete_payment(&pending, Outcome::Paid(100)).unwrap();
    assert_eq!(state::State.balance(&owner.to_text()).unwrap(), credits);
}

fn reserve_first_key_fixture(owner: Principal, token: u64, fee: u64) {
    state::transaction(|db| {
        vault_store::OwnerContext::authenticated(owner)?.run(db, |db| {
            vault_store::keys::reserve(db, &[1; 16], token, 1, fee)
        })
    })
    .unwrap();
    state::State
        .vault_reserve_cycles(
            &owner.to_text(),
            &format!("derive:{token}"),
            fee + 20_000_000,
            1_000,
        )
        .unwrap();
}
#[test]
fn first_key_fee_is_sponsored_once_without_debiting_the_ten_billion_credit() {
    state::initialize().unwrap();
    let owner = p(251);
    assert_eq!(
        state::State.initialize_account(owner, 0).unwrap().balance,
        10_000_000_000
    );
    reserve_first_key_fixture(owner, 1, 26_153_846_153);
    assert_eq!(
        state::State.balance(&owner.to_text()).unwrap(),
        9_980_000_000
    );
    let scope = vault_store::OwnerContext::authenticated(owner).unwrap();
    state::State
        .vault_settle_key_flight(scope, 1, 2, 26_153_846_153)
        .unwrap();
    state::State
        .vault_reconcile_refunded_cycles(&owner.to_text(), "derive:1", 26_153_846_153, 2_000)
        .unwrap();
    state::State
        .vault_finish_execution(&owner.to_text(), "derive:1", 20_000_000, 2_000)
        .unwrap();
    assert_eq!(
        state::State.balance(&owner.to_text()).unwrap(),
        9_980_000_000
    );
    state::transaction(|db| {
        assert!(!crate::key_subsidy::available_in(db, &owner.to_text())?);
        Ok(())
    })
    .unwrap();
    // The permanent receipt survives restart and resource deletion; another
    // retrieval needs paid credit even though the first one was sponsored.
    state::initialize().unwrap();
    state::transaction(|db| {
        assert!(!crate::key_subsidy::available_in(db, &owner.to_text())?);
        Ok(())
    })
    .unwrap();
    assert!(
        state::State
            .vault_reserve_cycles(&owner.to_text(), "derive:2", 26_173_846_153, 3_000)
            .is_err()
    );
}
#[test]
fn first_key_no_cost_failure_restores_eligibility_but_charged_failure_consumes_it() {
    state::initialize().unwrap();
    let owner = p(252);
    state::State.initialize_account(owner, 0).unwrap();
    reserve_first_key_fixture(owner, 1, 26_153_846_153);
    let scope = vault_store::OwnerContext::authenticated(owner).unwrap();
    state::State
        .vault_settle_key_flight(scope, 1, 2, 0)
        .unwrap();
    state::transaction(|db| {
        assert!(crate::key_subsidy::available_in(db, &owner.to_text())?);
        Ok(())
    })
    .unwrap();
    reserve_first_key_fixture(owner, 2, 26_153_846_153);
    state::State
        .vault_settle_key_flight(scope, 2, 3, 20_000_000_000)
        .unwrap();
    state::State
        .vault_reconcile_refunded_cycles(&owner.to_text(), "derive:2", 20_000_000_000, 3_000)
        .unwrap();
    assert_eq!(
        state::State.balance(&owner.to_text()).unwrap(),
        10_000_000_000
    );
    state::transaction(|db| {
        assert!(!crate::key_subsidy::available_in(db, &owner.to_text())?);
        Ok(())
    })
    .unwrap();
}

#[test]
fn v10_migration_preserves_fifty_billion_and_excludes_existing_users_from_new_subsidy() {
    let owner = p(253);
    state::transaction(|db| {
        schema::legacy_v10_for_test(db);
        db.execute("INSERT INTO accounts(owner,balance_cycles,storage_charged_at_ms) VALUES(?1,50000000000,0)",[owner.to_text()]).unwrap();
        kinic_cycle_grants::record_once(db,kinic_cycle_grants::Scope::Vault,&owner.to_text(),"vault",50_000_000_000,0).unwrap();
        Ok(())
    }).unwrap();
    state::initialize().unwrap();
    let old = state::State.initialize_account(owner, 1).unwrap();
    assert_eq!(old.balance, 50_000_000_000);
    assert_eq!(old.grant_cycles, 50_000_000_000);
    state::transaction(|db| {
        assert!(!crate::key_subsidy::available_in(db, &owner.to_text())?);
        Ok(())
    })
    .unwrap();
    let new = p(254);
    assert_eq!(
        state::State.initialize_account(new, 1).unwrap().balance,
        10_000_000_000
    );
    state::transaction(|db| {
        assert!(crate::key_subsidy::available_in(db, &new.to_text())?);
        Ok(())
    })
    .unwrap();
}

#[test]
fn cancelled_first_key_keeps_subsidy_reserved_until_a_verified_zero_cost_reply() {
    state::initialize().unwrap();
    let owner = p(244);
    state::State.initialize_account(owner, 0).unwrap();
    reserve_first_key_fixture(owner, 1, 26_153_846_153);
    let scope = vault_store::OwnerContext::authenticated(owner).unwrap();
    state::transaction(|db| {
        scope.run(db, |db| {
            vault_store::keys::mark_sent(db, 1, 26_153_846_153)?;
            assert!(!crate::accounting::recover_pending_in(
                db,
                owner,
                Some(&[1; 16]),
                2
            )?);
            assert!(!crate::key_subsidy::available_in(db, &owner.to_text())?);
            Ok(())
        })
    })
    .unwrap();
    assert!(
        !state::State
            .vault_settle_key_flight(scope, 1, 3, 0)
            .unwrap()
    );
    state::transaction(|db| {
        assert!(crate::key_subsidy::available_in(db, &owner.to_text())?);
        Ok(())
    })
    .unwrap();
    assert_eq!(
        state::State.balance(&owner.to_text()).unwrap(),
        10_000_000_000
    );
}
#[test]
fn first_key_subsidy_remains_used_when_an_inflight_operation_is_recovered_after_upgrade() {
    state::initialize().unwrap();
    let owner = p(243);
    state::State.initialize_account(owner, 0).unwrap();
    reserve_first_key_fixture(owner, 1, 26_153_846_153);
    let scope = vault_store::OwnerContext::authenticated(owner).unwrap();
    state::transaction(|db| {
        scope.run(db, |db| vault_store::keys::mark_sent(db, 1, 26_153_846_153))
    })
    .unwrap();
    state::initialize().unwrap();
    state::transaction(|db| {
        scope.run(db, |db| {
            assert!(crate::accounting::recover_pending_in(db, owner, None, 130)?);
            assert!(!crate::key_subsidy::available_in(db, &owner.to_text())?);
            Ok(())
        })
    })
    .unwrap();
    assert_eq!(
        state::State.balance(&owner.to_text()).unwrap(),
        10_000_000_000
    );
    state::initialize().unwrap();
    state::transaction(|db| {
        assert!(!crate::key_subsidy::available_in(db, &owner.to_text())?);
        Ok(())
    })
    .unwrap();
}
#[test]
fn insufficient_execution_credit_does_not_consume_the_first_key_subsidy() {
    state::initialize().unwrap();
    let owner = p(242);
    state::State.initialize_account(owner, 0).unwrap();
    state::transaction(|db| {
        db.execute(
            "UPDATE accounts SET balance_cycles=1 WHERE owner=?1",
            [owner.to_text()],
        )
        .unwrap();
        vault_store::OwnerContext::authenticated(owner)?.run(db, |db| {
            vault_store::keys::reserve(db, &[1; 16], 1, 1, 26_153_846_153)
        })
    })
    .unwrap();
    assert!(
        state::State
            .vault_reserve_cycles(&owner.to_text(), "derive:1", 26_173_846_153, 1_000)
            .is_err()
    );
    state::transaction(|db| {
        assert!(crate::key_subsidy::available_in(db, &owner.to_text())?);
        Ok(())
    })
    .unwrap();
}

#[test]
fn bridge_upgrade_accepts_v8_and_initializes_v14() {
    let db = kinic_sqlite_compat::Connection::open_in_memory().unwrap();
    schema::initialize_legacy_v8(&db);
    db.execute("INSERT INTO accounts(owner,balance_cycles,storage_bytes,storage_charged_at_ms) VALUES('owner',42,7,8)", []).unwrap();
    schema::initialize_vault_schema(&db).unwrap();
    let version: i64 = db
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap();
    assert_eq!(version, 15);
    let account: (i64, i64) = db
        .query_row(
            "SELECT balance_cycles,storage_charge_remainder FROM accounts WHERE owner='owner'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(account, (42, 0));
}

#[test]
fn bridge_upgrade_from_schema_nine_preserves_records_and_fences_old_readers() {
    let db = kinic_sqlite_compat::Connection::open_in_memory().unwrap();
    schema::legacy_v9_for_test(&db);
    // Schema 9 has identical DDL but cannot interpret bridge_v1 payment rows.
    db.execute_batch("PRAGMA user_version=9;").unwrap();
    db.execute("INSERT INTO accounts(owner,balance_cycles,storage_bytes,storage_charged_at_ms,storage_charge_remainder) VALUES('owner',42,7,8,123456)", []).unwrap();
    db.execute(
        "INSERT INTO global_settings VALUES('bridge','retained configuration')",
        [],
    )
    .unwrap();
    for (operation, status) in [(1, CreditStatus::Prepared), (2, CreditStatus::Accepted)] {
        let record = serde_json::json!({"bridge_v1": crate::bridge::Record::Credit {
            offer: CreditOffer { operation: vec![operation;16], wiki_owner:p(1), vault_owner:p(2), amount_cycles:42, expires_at_ns:300_000_000_000, link_generation:1 },
            status, acknowledged:false, day:0,
        }}).to_string();
        db.execute("INSERT INTO payments(wallet,operation,record,expires) VALUES('owner',?1,?2,9223372036854775807)", kinic_sqlite_compat::params![vec![operation;16], record]).unwrap();
    }
    let snapshot = || {
        db.query_row("SELECT json_object('accounts',(SELECT json_group_array(json_array(owner,balance_cycles,storage_bytes,storage_charged_at_ms,storage_charge_remainder)) FROM accounts),'payments',(SELECT json_group_array(json_array(wallet,hex(operation),record,expires)) FROM payments),'settings',(SELECT json_group_array(json_array(key,value)) FROM global_settings))", [], |r| r.get::<_, String>(0)).unwrap()
    };
    let before = snapshot();
    schema::initialize_vault_schema(&db).unwrap();
    assert_eq!(
        db.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        15
    );
    assert_eq!(snapshot(), before);
    schema::initialize_vault_schema(&db).unwrap();
    assert_eq!(snapshot(), before);
}

fn bridge_grant_record(owner: Principal, amount: u64) -> String {
    serde_json::json!({"bridge_v1": crate::bridge::Record::Credit {
        offer: CreditOffer { operation: vec![252u8;16], wiki_owner:p(1), vault_owner:owner, amount_cycles:amount, expires_at_ns:300_000_000_000, link_generation:1 },
        status: CreditStatus::Prepared, acknowledged:false, day:0,
    }}).to_string()
}

#[test]
fn main_schema_ten_bridge_rows_migrate_without_null_beneficiaries_or_lost_state() {
    let db = kinic_sqlite_compat::Connection::open_in_memory().unwrap();
    schema::legacy_v9_for_test(&db);
    db.execute_batch("PRAGMA user_version=10;").unwrap();
    let owner = p(251);
    let raw = bridge_grant_record(owner, 42);
    db.execute(
        "INSERT INTO payments VALUES(?1,?2,?3,9223372036854775807)",
        kinic_sqlite_compat::params![owner.to_text(), vec![252u8; 16], raw],
    )
    .unwrap();
    schema::initialize_vault_schema(&db).unwrap();
    assert_eq!(
        db.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        15
    );
    assert_eq!(
        db.query_row("SELECT record FROM payments", [], |r| r.get::<_, String>(0))
            .unwrap(),
        raw
    );
    assert_eq!(
        kinic_cycle_grants::recorded(&db, kinic_cycle_grants::Scope::Vault, &owner.to_text())
            .unwrap(),
        Some(0)
    );
    assert!(!crate::key_subsidy::available_in(&db, &owner.to_text()).unwrap());
    schema::initialize_vault_schema(&db).unwrap();
}

#[test]
fn schema_eleven_upgrade_preserves_unclaimed_post_policy_grant_eligibility() {
    let owner = p(250);
    state::transaction(|db| {
        schema::subsidy_v11_for_test(db);
        db.execute(
            "INSERT INTO accounts(owner,balance_cycles,storage_charged_at_ms) VALUES(?1,123,0)",
            [owner.to_text()],
        )
        .unwrap();
        Ok(())
    })
    .unwrap();
    state::initialize().unwrap();
    let initialized = state::State.initialize_account(owner, 1).unwrap();
    assert_eq!(initialized.balance, 10_000_000_123);
    assert_eq!(initialized.grant_cycles, 10_000_000_000);
}

#[test]
fn initial_grant_preserves_prepared_bridge_credit_arithmetic_headroom() {
    state::initialize().unwrap();
    let owner = p(249);
    let amount = i64::MAX as u64 - 5_000_000_000;
    state::transaction(|db| {
        db.execute(
            "INSERT INTO payments VALUES(?1,?2,?3,9223372036854775807)",
            kinic_sqlite_compat::params![
                owner.to_text(),
                vec![252u8; 16],
                bridge_grant_record(owner, amount)
            ],
        )
        .unwrap();
        Ok(())
    })
    .unwrap();
    let initialized = state::State.initialize_account(owner, 1).unwrap();
    assert_eq!(initialized.grant_cycles, 0);
    assert_eq!(initialized.balance, 0);
    state::transaction(|db| {
        assert_eq!(
            kinic_cycle_grants::recorded(db, kinic_cycle_grants::Scope::Vault, &owner.to_text())
                .unwrap(),
            None
        );
        // The already-reserved bridge operation excludes its own reservation.
        crate::capacity::admit_credit(db, owner, owner, &[252; 16], amount)?;
        Ok(())
    })
    .unwrap();
}

#[test]
fn migrated_team_vault_resolves_original_owner_after_reopen() {
    let db = kinic_sqlite_compat::Connection::open_in_memory().unwrap();
    schema::legacy_v9_for_test(&db);
    db.execute_batch("PRAGMA user_version=10;").unwrap();
    let h = Header {
        id: vec![9; 16],
        nonce: vec![42; 32],
        key_name: "test_key_1".into(),
        public_key: vec![3; 96],
        state: VaultState::Active,
        sequence: 8,
        name: None,
    };
    db.execute(
        "INSERT INTO vaults(owner,id,operation,header) VALUES(?1,?2,?3,?4)",
        kinic_sqlite_compat::params![
            p(8).as_slice(),
            h.id,
            vec![11u8; 16],
            serde_json::to_string(&h).unwrap()
        ],
    )
    .unwrap();
    schema::initialize_vault_schema(&db).unwrap();
    assert_eq!(
        db.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        15
    );
    let owner = vault_store::OwnerContext::authenticated(p(8)).unwrap();
    owner
        .run(&db, |db| {
            vault_store::sharing::set_member(db, p(8), &h.id, p(9), AccessRole::Viewer)
        })
        .unwrap();
    schema::initialize_vault_schema(&db).unwrap();
    let access = vault_store::sharing::access(&db, p(9), &h.id).unwrap();
    assert_eq!(access.owner, p(8));
    assert_eq!(access.header, h);
}
