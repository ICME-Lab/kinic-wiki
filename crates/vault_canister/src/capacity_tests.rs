use super::*;
use candid::Principal;
use funding::*;
use kinic_sqlite_compat::params;
fn principal(n: u32) -> Principal {
    Principal::self_authenticating(n.to_be_bytes())
}
fn quote(wallet: u32, beneficiary: Principal, id: u8) -> Payment {
    record_quote(
        principal(wallet),
        PurchaseRequest {
            operation: vec![id; 16],
            beneficiary,
            amount_e8s: 100_000_000,
            min_credits: 20_000_000,
            created_at_time: 0,
        },
        FundingConfig {
            ledger: principal(5000),
            recipient: principal(5001),
            cycles_per_kinic: 100_000_000,
        },
        10,
        0,
    )
    .unwrap()
}
fn seed_accounts(count: u32) {
    state::transaction(|db| {
        for n in 0..count {
            db.execute(
                "INSERT INTO accounts VALUES(?1,1,0,0)",
                params![principal(n).to_text()],
            )
            .unwrap();
        }
        Ok(())
    })
    .unwrap();
}
#[test]
fn capacity_pool_is_global_only() {
    state::initialize().unwrap();
    state::transaction(|db| {
        let context = vault_store::OwnerContext::authenticated(principal(1))?;
        context.run(db, |db| {
            assert_eq!(
                vault_store::content::global_usage(db)? - vault_store::content::usage(db)?,
                16 * 1024 * 1024
            );
            Ok(())
        })
    })
    .unwrap();
}
#[test]
fn capacity_last_beneficiary_slot_is_reserved_before_debit_and_unknown_retained() {
    state::initialize().unwrap();
    seed_accounts(1023);
    let a = principal(2000);
    let b = principal(2001);
    quote(3000, a, 1);
    quote(3001, b, 2);
    quote(3002, a, 3);
    let first = begin_payment(principal(3000), &[1; 16], 0).unwrap();
    assert_eq!(
        begin_payment(principal(3001), &[2; 16], 0).unwrap_err(),
        vault_types::Error::QuotaExceeded
    );
    let same = begin_payment(principal(3002), &[3; 16], 0).unwrap();
    complete_payment(&first, Outcome::Rejected(Status::InsufficientFunds)).unwrap();
    complete_payment(&same, Outcome::Unknown).unwrap();
    state::State.vault_start_generation().unwrap();
    assert_eq!(
        begin_payment(principal(3001), &[2; 16], 1).unwrap_err(),
        vault_types::Error::QuotaExceeded
    );
    let retry = begin_payment(principal(3002), &[3; 16], 1).unwrap();
    complete_payment(&retry, Outcome::Paid(u64::MAX)).unwrap();
    quote(3003, principal(0), 4);
    let topup = begin_payment(principal(3003), &[4; 16], 2).unwrap();
    complete_payment(&topup, Outcome::Paid(u64::MAX)).unwrap();
    assert_eq!(state::State.balance(&a.to_text()).unwrap(), 100_000_000);
}
#[test]
fn capacity_audit_evicts_before_insert_and_rows_are_bounded() {
    state::initialize().unwrap();
    state::transaction(|db| {
        for _ in 0..10000 { accounting::record_entry(db,&principal(1).to_text(),"charge",1,1,0,None)?; }
        db.execute_batch("CREATE TRIGGER audit_no_transient_overflow BEFORE INSERT ON account_ledger WHEN (SELECT count(*) FROM account_ledger)>=10000 BEGIN SELECT RAISE(ABORT,'overflow'); END;").unwrap();
        accounting::record_entry(db,&principal(1).to_text(),"refund",1,1,0,None)?;
        assert!(accounting::record_entry(db,&principal(1).to_text(),&"x".repeat(513),1,1,0,None).is_err());
        Ok(())
    }).unwrap();
}
#[test]
fn capacity_oversized_settings_fail_atomically() {
    state::initialize().unwrap();
    state::transaction(|db| {
        assert!(
            db.execute(
                "INSERT INTO global_settings VALUES('oversized',?1)",
                params!["x".repeat(65536)]
            )
            .is_err()
        );
        Ok(())
    })
    .unwrap();
}

#[test]
fn capacity_legacy_commitments_survive_upgrade_above_account_cap() {
    state::initialize().unwrap();
    seed_accounts(1023);
    let beneficiary = principal(2000);
    quote(3000, beneficiary, 1);
    quote(3001, principal(2001), 2);
    let first = begin_payment(principal(3000), &[1; 16], 0).unwrap();
    complete_payment(&first, Outcome::Unknown).unwrap();
    // Model rows from the unbounded Task5 schema, then install the new guards.
    state::transaction(|db| {
        db.execute_batch("DROP TRIGGER accounting_accounts_count")
            .unwrap();
        for n in 2100..2103 {
            db.execute(
                "INSERT INTO accounts VALUES(?1,7,0,0)",
                params![principal(n).to_text()],
            )
            .unwrap();
        }
        Ok(())
    })
    .unwrap();
    state::initialize().unwrap();
    assert_eq!(
        begin_payment(principal(3001), &[2; 16], 1).unwrap_err(),
        vault_types::Error::QuotaExceeded
    );
    let retry = begin_payment(principal(3000), &[1; 16], 1).unwrap();
    complete_payment(&retry, Outcome::Paid(u64::MAX)).unwrap();
    assert_eq!(
        state::State.balance(&beneficiary.to_text()).unwrap(),
        100_000_000
    );
    assert_eq!(state::State.balance(&principal(2100).to_text()).unwrap(), 7);
}
#[test]
fn capacity_full_journals_keep_refunds_checkpoints_and_tiny_balance_cleanup_available() {
    state::initialize().unwrap();
    let owner = principal(2000);
    let text = owner.to_text();
    quote(3000, owner, 1);
    let sent = begin_payment(principal(3000), &[1; 16], 0).unwrap();
    complete_payment(&sent, Outcome::Paid(1)).unwrap();
    state::State
        .vault_reserve_cycles(&text, "derive:1", 30_000_000, 0)
        .unwrap();
    state::transaction(|db| {
        db.execute("WITH RECURSIVE n(x) AS(SELECT 2 UNION ALL SELECT x+1 FROM n WHERE x<10000) INSERT INTO vault_cycle_reservations(owner,token,account_owner,reserved,created_at_ms) SELECT ?1,'derive:'||x,?1,0,0 FROM n",params![text]).unwrap();
        db.execute("WITH RECURSIVE n(x) AS(SELECT 2 UNION ALL SELECT x+1 FROM n WHERE x<9999) INSERT INTO account_ledger(owner,kind,amount_cycles,balance_after,at_ms) SELECT ?1,'charge',0,0,0 FROM n",params![text]).unwrap();
        Ok(())
    }).unwrap();
    assert!(
        state::State
            .vault_reserve_cycles(&text, "new", 1, 0)
            .is_err()
    );
    state::State
        .vault_reserve_cycles(&text, "derive:1", 30_000_000, 0)
        .unwrap();
    // Storage billing and a confirmed top-up also rotate full disposable audit
    // history without consuming another reservation or account admission.
    state::State
        .vault_track_storage(&text, 1_073_741_824, 1000)
        .unwrap();
    state::State
        .vault_track_storage(&text, 1_073_741_824, 2000)
        .unwrap();
    quote(3001, owner, 2);
    let topup = begin_payment(principal(3001), &[2; 16], 0).unwrap();
    complete_payment(&topup, Outcome::Paid(2)).unwrap();
    state::State
        .vault_checkpoint_execution(&text, "derive:1", 1)
        .unwrap();
    state::State
        .vault_settle_cycles(&text, "derive:1", 0, 1)
        .unwrap();
    state::State
        .vault_finish_execution(&text, "derive:1", 1, 1)
        .unwrap();
    state::transaction(|db| {
        db.execute(
            "UPDATE accounts SET balance_cycles=1 WHERE owner=?1",
            params![text],
        )
        .unwrap();
        Ok(())
    })
    .unwrap();
    state::State
        .vault_charge_execution(&text, 20_000_000, 1)
        .unwrap();
    state::State
        .vault_charge_execution(&text, 20_000_000, 1)
        .unwrap();
    assert_eq!(state::State.balance(&text).unwrap(), 0);
    state::transaction(|db| {
        let count: i64 = db
            .query_row("SELECT count(*) FROM account_ledger", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 10000);
        let count: i64 = db
            .query_row("SELECT count(*) FROM vault_cycle_reservations", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(count, 10000);
        Ok(())
    })
    .unwrap();
}
#[test]
fn capacity_whole_payment_row_bound_applies_to_insert_and_update() {
    state::initialize().unwrap();
    let p = quote(3000, principal(2000), 255);
    state::transaction(|db| {
        let raw = serde_json::to_string(&p).unwrap();
        let max = 4096 - (4 + p.wallet.to_text().len()) - (4 + 16) - 4 - 8;
        let exact = format!("{raw}{}", " ".repeat(max - raw.len()));
        db.execute("UPDATE payments SET record=?1", params![exact])
            .unwrap();
        assert!(
            db.execute(
                "UPDATE payments SET record=?1",
                params![format!("{exact} ")]
            )
            .is_err()
        );
        assert!(
            db.execute(
                "UPDATE quote_fee_flights SET record=?1",
                params!["x".repeat(4097)]
            )
            .is_ok()
        ); // no row, no allocation
        Ok(())
    })
    .unwrap();
    let sent = begin_payment(p.wallet, &p.request.operation, 1).unwrap();
    complete_payment(&sent, Outcome::Paid(u64::MAX)).unwrap();
}

#[test]
fn capacity_settings_prepaid_slots_cover_every_existing_key_and_cursor_widening() {
    use vault_types::capacity::*;
    state::initialize().unwrap();
    state::transaction(|db| {
        for key in GLOBAL_SETTING_KEYS.iter().copied().chain(["future-incident","future-restore"]) {
            let max=SETTING_ROW-8-key.len();
            db.execute("INSERT INTO global_settings VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![key,"x".repeat(max)]).unwrap();
        }
        assert!(db.execute("INSERT INTO global_settings VALUES('eighth','x')",params![]).is_err());
        for key in GLOBAL_SETTING_KEYS {
            db.execute("UPDATE global_settings SET value=?2 WHERE key=?1",params![key,i64::MAX.to_string()]).unwrap();
        }
        db.execute("INSERT INTO vault_storage_billing_state VALUES(1,?1,?2)",params![principal(1).to_text(),i64::MAX]).unwrap();
        Ok(())
    }).unwrap();
}
#[test]
fn capacity_unknown_past_retry_window_remains_protected() {
    state::initialize().unwrap();
    seed_accounts(1023);
    quote(3000, principal(2000), 1);
    let p = begin_payment(principal(3000), &[1; 16], 0).unwrap();
    complete_payment(&p, Outcome::Unknown).unwrap();
    assert_eq!(
        begin_payment(p.wallet, &[1; 16], 24 * 3600 * 1_000_000_000).unwrap_err(),
        vault_types::Error::Expired
    );
    state::transaction(|db| {
        let raw: String = db
            .query_row("SELECT record FROM payments", [], |r| r.get(0))
            .unwrap();
        assert!(matches!(
            serde_json::from_str::<Payment>(&raw).unwrap().status,
            Status::Unknown
        ));
        assert_eq!(
            crate::capacity::admit_beneficiary(db, principal(2001)).unwrap_err(),
            vault_types::Error::QuotaExceeded
        );
        Ok(())
    })
    .unwrap();
}

#[test]
fn capacity_full_unknown_payment_budget_blocks_new_quotes_but_allows_exact_completion() {
    state::initialize().unwrap();
    quote(3000, principal(2000), 255);
    let original = begin_payment(principal(3000), &[255; 16], 0).unwrap();
    let pending = complete_payment(&original, Outcome::Unknown).unwrap();
    state::transaction(|db| {
        for n in 1..1024 {
            let mut p = pending.clone();
            p.wallet = principal(4000 + n);
            db.execute(
                "INSERT INTO payments VALUES(?1,?2,?3,?4)",
                params![
                    p.wallet.to_text(),
                    p.request.operation,
                    serde_json::to_string(&p).unwrap(),
                    i64::MAX
                ],
            )
            .unwrap();
        }
        Ok(())
    })
    .unwrap();
    assert!(matches!(
        admit_quote(
            principal(6000),
            PurchaseRequest {
                operation: vec![2; 16],
                beneficiary: principal(2000),
                amount_e8s: 100_000_000,
                min_credits: 20_000_000,
                created_at_time: 0
            },
            pending.config.clone(),
            0
        ),
        Err(vault_types::Error::QuotaExceeded)
    ));
    let retry = begin_payment(original.wallet, &[255; 16], 1).unwrap();
    complete_payment(&retry, Outcome::Paid(u64::MAX)).unwrap();
    state::transaction(|db| {
        let count: i64 = db
            .query_row("SELECT count(*) FROM payments", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1024);
        let flights: i64 = db
            .query_row("SELECT count(*) FROM quote_fee_flights", [], |r| r.get(0))
            .unwrap();
        assert_eq!(flights, 0);
        Ok(())
    })
    .unwrap();
}

#[test]
fn capacity_fee_reservation_and_account_fields_reject_one_byte_excess() {
    state::initialize().unwrap();
    let q = quote(3000, principal(2000), 1);
    let fee = admit_quote(
        principal(3001),
        PurchaseRequest {
            operation: vec![2; 16],
            ..q.request.clone()
        },
        q.config.clone(),
        0,
    )
    .unwrap();
    assert!(matches!(fee, QuoteAdmission::Fee(_)));
    state::transaction(|db| {
        let raw:String=db.query_row("SELECT record FROM quote_fee_flights",[],|r|r.get(0)).unwrap();
        let max=4096-(4+principal(3001).to_text().len())-(4+16)-4-24;
        let exact=format!("{raw}{}"," ".repeat(max-raw.len()));
        db.execute("UPDATE quote_fee_flights SET record=?1",params![exact]).unwrap();
        assert!(db.execute("UPDATE quote_fee_flights SET record=?1",params![format!("{exact} ")]).is_err());
        assert!(db.execute("INSERT INTO accounts VALUES(?1,0,0,0)",params!["x".repeat(64)]).is_err());
        assert!(db.execute("INSERT INTO vault_cycle_reservations(owner,token,account_owner,reserved,created_at_ms) VALUES(?1,?2,?1,0,0)",params![principal(1).to_text(),"x".repeat(129)]).is_err());
        db.execute("INSERT INTO vault_cycle_reservations(owner,token,account_owner,reserved,created_at_ms) VALUES(?1,?2,?1,0,0)",params![principal(1).to_text(),"x".repeat(128)]).unwrap();
        assert!(db.execute("UPDATE vault_cycle_reservations SET token=?1",params!["x".repeat(129)]).is_err());
        Ok(())
    }).unwrap();
}

#[test]
fn capacity_extreme_legacy_excess_is_reported_without_erasing_commitments() {
    state::initialize().unwrap();
    quote(30000, principal(20000), 1);
    let sent = begin_payment(principal(30000), &[1; 16], 0).unwrap();
    complete_payment(&sent, Outcome::Unknown).unwrap();
    state::transaction(|db| {
        db.execute_batch("DROP TRIGGER accounting_accounts_count")
            .unwrap();
        for n in 0..5000 {
            db.execute(
                "INSERT INTO accounts VALUES(?1,7,0,0)",
                params![principal(n).to_text()],
            )
            .unwrap();
        }
        db.execute(
            "INSERT INTO revisions VALUES(?1,x'ff',x'ff',1,1,NULL,0,x'','[]',1,?2)",
            params![principal(1).as_slice(), 183i64 * 1024 * 1024],
        )
        .unwrap();
        Ok(())
    })
    .unwrap();
    state::initialize().unwrap();
    let before = state::transaction(vault_store::content::global_capacity).unwrap();
    assert_eq!(
        serde_json::to_value(&before).unwrap().get("legacy_excess"),
        Some(&serde_json::json!((5001u64 - 1024) * 512))
    );
    assert!(before.overcommitted);
    state::transaction(|db| {
        vault_store::OwnerContext::authenticated(principal(1))?.run(db, |db| {
            assert_eq!(
                vault_store::content::check_capacity(db, 1).unwrap_err(),
                vault_types::Error::QuotaExceeded
            );
            Ok(())
        })
    })
    .unwrap();
    let retry = begin_payment(sent.wallet, &sent.request.operation, 1).unwrap();
    complete_payment(&retry, Outcome::Paid(u64::MAX)).unwrap();
    let after = state::transaction(vault_store::content::global_capacity).unwrap();
    assert_eq!(before, after); // Future account was already charged before confirmation.
    assert_eq!(
        state::State.balance(&principal(20000).to_text()).unwrap(),
        100_000_000
    );
    assert_eq!(state::State.balance(&principal(1).to_text()).unwrap(), 7);
}

#[test]
fn capacity_legacy_oversized_whole_row_is_charged_until_normalized() {
    state::initialize().unwrap();
    let p = quote(3000, principal(2000), 1);
    state::transaction(|db| {
        db.execute_batch("DROP TRIGGER accounting_payments_UPDATE_size")
            .unwrap();
        let raw = serde_json::to_string(&p).unwrap();
        let record_max = 4096 - (4 + p.wallet.to_text().len()) - (4 + 16) - 4 - 8;
        db.execute(
            "UPDATE payments SET record=?1",
            params![format!("{raw}{}", " ".repeat(record_max + 37 - raw.len()))],
        )
        .unwrap();
        Ok(())
    })
    .unwrap();
    state::initialize().unwrap();
    let before = state::transaction(vault_store::content::global_capacity).unwrap();
    assert_eq!(before.legacy_excess, 37);
    let sent = begin_payment(p.wallet, &p.request.operation, 1).unwrap();
    complete_payment(&sent, Outcome::Paid(u64::MAX)).unwrap();
    assert_eq!(
        state::transaction(vault_store::content::global_capacity)
            .unwrap()
            .legacy_excess,
        0
    );
}

#[test]
fn key_gc_refreshes_offline_other_owner_billing_and_restores_caller_scope() {
    state::initialize().unwrap();
    let caller = principal(7001);
    let other = principal(7002);
    state::transaction(|db|{
        let now=3*vault_types::DAY;
        let account=other.to_text();
        db.execute("INSERT INTO accounts VALUES(?1,1000000000,0,0)",params![account]).unwrap();
        vault_store::OwnerContext::authenticated(other)?.run(db,|db|{
            vault_store::keys::reserve(db,1,1,0)?;
            vault_store::keys::settle(db,1,2,0)?;
            db.execute("UPDATE accounts SET storage_bytes=?1 WHERE owner=?2",params![vault_store::content::usage(db)? as i64,account]).unwrap();Ok(())
        })?;
        let old:i64=db.query_row("SELECT storage_bytes FROM accounts WHERE owner=?1",params![account],|r|r.get(0)).unwrap();
        vault_store::OwnerContext::authenticated(caller)?.run(db,|db|{
            let owners=vault_store::keys::collect_completed(db,now)?;assert_eq!(owners,vec![other]);
            accounting::reconcile_key_gc_in(db,caller,&owners,(now*1000) as i64)?;
            let active:Vec<u8>=db.query_row("SELECT owner FROM owner_scope",params![],|r|r.get(0)).unwrap();assert_eq!(active,caller.as_slice());
            let (usage,balance,at):(i64,i64,i64)=db.query_row("SELECT storage_bytes,balance_cycles,storage_charged_at_ms FROM accounts WHERE owner=?1",params![account],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap();
            assert_eq!(usage,old-4096);
            let expected=(old as u128*now as u128*127000/1073741824) as i64;
            assert_eq!(balance,1_000_000_000-expected);assert_eq!(at,(now*1000) as i64);
            let count:i64=db.query_row("SELECT count(*) FROM accounts",params![],|r|r.get(0)).unwrap();assert_eq!(count,1);Ok(())
        })
    }).unwrap();
}
