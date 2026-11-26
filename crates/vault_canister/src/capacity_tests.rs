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
                "INSERT INTO accounts(owner,balance_cycles,storage_bytes,storage_charged_at_ms) VALUES(?1,1,0,0)",
                params![principal(n).to_text()],
            )
            .unwrap();
        }
        Ok(())
    })
    .unwrap();
}
#[test]
fn empty_accounting_reservation_only_covers_settings() {
    state::initialize().unwrap();
    state::transaction(|db| {
        let context = vault_store::OwnerContext::authenticated(principal(1))?;
        context.run(db, |db| {
            assert_eq!(
                vault_store::content::global_usage(db)? - vault_store::content::usage(db)?,
                vault_types::capacity::SETTINGS as u64
            );
            Ok(())
        })
    })
    .unwrap();
}

#[test]
fn growing_shared_journals_use_indexes_for_key_admission_and_cleanup() {
    state::initialize().unwrap();
    state::transaction(|db| {
        for (query,index) in [
            ("EXPLAIN QUERY PLAN SELECT count(*) FROM key_flights WHERE in_flight=1", "key_flights_active"),
            ("EXPLAIN QUERY PLAN SELECT rowid,owner FROM key_flights WHERE in_flight=0 AND phase!='cancelled' AND settled IS NOT NULL AND settled<=0 AND day<1 ORDER BY settled,owner,token LIMIT 128", "key_flights_gc_global"),
            ("EXPLAIN QUERY PLAN SELECT rowid FROM vault_cycle_reservations WHERE in_flight=0 AND execution_billed>=execution_checkpoint AND settled_at_ms IS NOT NULL AND settled_at_ms<=0 ORDER BY settled_at_ms LIMIT 128", "vault_cycle_reservations_gc"),
        ] {
            let detail:String=db.query_row(query,[],|r|r.get(3)).unwrap();
            assert!(detail.contains(index),"{query}: {detail}");
        }
        Ok(())
    }).unwrap();
}

#[test]
fn expired_cycle_reservations_are_cleaned_in_a_committed_batch_even_when_admission_fails() {
    state::initialize().unwrap();
    state::transaction(|db| {
        db.execute("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<130) INSERT INTO vault_cycle_reservations(owner,token,reserved,created_at_ms,settled_at_ms,in_flight) SELECT 'old','old:'||x,0,0,0,0 FROM n",[]).unwrap();
        Ok(())
    }).unwrap();
    assert!(
        state::State
            .vault_reserve_cycles(&principal(1).to_text(), "new", 1, 86_400_001)
            .is_err()
    );
    state::transaction(|db| {
        let count: i64 = db
            .query_row("SELECT count(*) FROM vault_cycle_reservations", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(count, 2);
        Ok(())
    })
    .unwrap();
}
#[test]
fn ten_thousand_accounts_can_be_admitted_without_a_shared_account_row_cap() {
    state::initialize().unwrap();
    state::transaction(|db| {
        for n in 0..10_000u32 {
            db.execute("INSERT INTO accounts(owner,balance_cycles,storage_bytes,storage_charged_at_ms) VALUES(?1,0,0,0)",params![principal(n).to_text()]).unwrap();
        }
        Ok(())
    }).unwrap();
    assert_eq!(
        state::State.balance(&principal(9_999).to_text()).unwrap(),
        0
    );
}
#[test]
fn another_wallet_can_quote_after_a_thousand_payment_rows() {
    state::initialize().unwrap();
    state::transaction(|db| {
        for n in 0..1_024u32 {
            db.execute(
                "INSERT INTO payments(wallet,operation,record,expires) VALUES(?1,?2,'{}',999999)",
                params![principal(n).to_text(), n.to_be_bytes().repeat(4)],
            )
            .unwrap();
        }
        Ok(())
    })
    .unwrap();
    quote(3_000, principal(2_000), 1);
}
#[test]
fn one_new_quote_reclaims_at_most_128_expired_other_wallet_payments() {
    state::initialize().unwrap();
    state::transaction(|db| {
        db.execute("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<300) INSERT INTO payments(wallet,operation,record,expires) SELECT printf('expired-%05d',x),CAST(printf('%016d',x) AS BLOB),'{}',-1 FROM n",[]).unwrap();
        Ok(())
    }).unwrap();
    quote(3_000, principal(2_000), 1);
    state::transaction(|db| {
        let expired: i64 = db
            .query_row("SELECT count(*) FROM payments WHERE expires=-1", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(expired, 172);
        Ok(())
    })
    .unwrap();
}
#[test]
fn a_payment_reserves_sqlite_completion_pages_before_ledger_dispatch() {
    state::initialize().unwrap();
    let p = quote(3_000, principal(2_000), 1);
    begin_payment(p.wallet, &p.request.operation, 0).unwrap();
    state::transaction(|db| {
        let bytes:i64=db.query_row("SELECT length(spare) FROM payment_completion_reservations WHERE wallet=?1 AND operation=?2",params![p.wallet.to_text(),p.request.operation],|r|r.get(0)).unwrap();
        assert_eq!(bytes,1_048_576);
        Ok(())
    }).unwrap();
}
#[test]
fn deleting_a_payment_releases_its_completion_pages() {
    state::initialize().unwrap();
    let p = quote(3_000, principal(2_000), 1);
    begin_payment(p.wallet, &p.request.operation, 0).unwrap();
    state::transaction(|db| {
        db.execute(
            "DELETE FROM payments WHERE wallet=?1 AND operation=?2",
            params![p.wallet.to_text(), p.request.operation],
        )
        .unwrap();
        let count: i64 = db
            .query_row(
                "SELECT count(*) FROM payment_completion_reservations",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);
        Ok(())
    })
    .unwrap();
}
#[test]
fn unknown_payment_keeps_completion_pages_until_paid_at_sqlite_page_limit() {
    state::initialize().unwrap();
    let p = quote(3_000, principal(2_000), 1);
    let sent = begin_payment(p.wallet, &p.request.operation, 0).unwrap();
    complete_payment(&sent, Outcome::Unknown).unwrap();
    let page_count = state::transaction(|db| {
        let pages: i64 = db.query_row("PRAGMA page_count", [], |r| r.get(0)).unwrap();
        db.execute_batch(&format!("PRAGMA max_page_count={pages};"))
            .unwrap();
        Ok(pages)
    })
    .unwrap();
    let paid = complete_payment(&sent, Outcome::Paid(1)).unwrap();
    assert_eq!(paid.status, Status::Paid(1));
    assert_eq!(
        state::State
            .balance(&p.request.beneficiary.to_text())
            .unwrap(),
        p.credits
    );
    state::transaction(|db| {
        let reserved: i64 = db
            .query_row(
                "SELECT count(*) FROM payment_completion_reservations",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let pages: i64 = db.query_row("PRAGMA page_count", [], |r| r.get(0)).unwrap();
        assert_eq!((reserved, pages), (0, page_count));
        Ok(())
    })
    .unwrap();
}
#[test]
fn failed_payment_leaves_no_permanent_beneficiary_account() {
    state::initialize().unwrap();
    let beneficiary = principal(2_000);
    let payment = quote(3_000, beneficiary, 1);
    let sent = begin_payment(payment.wallet, &payment.request.operation, 1).unwrap();
    complete_payment(&sent, Outcome::Rejected(Status::InsufficientFunds)).unwrap();
    state::transaction(|db| {
        let count: i64 = db
            .query_row(
                "SELECT count(*) FROM accounts WHERE owner=?1",
                params![beneficiary.to_text()],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);
        Ok(())
    })
    .unwrap();
}
#[test]
fn capacity_pending_beneficiaries_do_not_block_other_owners_and_unknown_is_retained() {
    state::initialize().unwrap();
    seed_accounts(1023);
    let a = principal(2000);
    let b = principal(2001);
    quote(3000, a, 1);
    quote(3001, b, 2);
    quote(3002, a, 3);
    let first = begin_payment(principal(3000), &[1; 16], 0).unwrap();
    let other = begin_payment(principal(3001), &[2; 16], 0).unwrap();
    let same = begin_payment(principal(3002), &[3; 16], 0).unwrap();
    complete_payment(&first, Outcome::Rejected(Status::InsufficientFunds)).unwrap();
    complete_payment(&same, Outcome::Unknown).unwrap();
    state::State.vault_start_generation().unwrap();
    complete_payment(&other, Outcome::Paid(u64::MAX)).unwrap();
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
fn growing_reservation_journal_keeps_refunds_checkpoints_and_tiny_balance_cleanup_available() {
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
        db.execute("WITH RECURSIVE n(x) AS(SELECT 2 UNION ALL SELECT x+1 FROM n WHERE x<10000) INSERT INTO vault_cycle_reservations(owner,token,reserved,created_at_ms) SELECT ?1,'derive:'||x,0,0 FROM n",params![text]).unwrap();
        db.execute("WITH RECURSIVE n(x) AS(SELECT 2 UNION ALL SELECT x+1 FROM n WHERE x<9999) INSERT INTO account_ledger(owner,kind,amount_cycles,balance_after,at_ms) SELECT ?1,'charge',0,0,0 FROM n",params![text]).unwrap();
        Ok(())
    }).unwrap();
    state::State
        .vault_reserve_cycles(&text, "new", 1, 0)
        .unwrap();
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
        assert_eq!(count, 10001);
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
        for key in GLOBAL_SETTING_KEYS {
            let max=SETTING_ROW-8-key.len();
            db.execute("INSERT INTO global_settings VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![key,"x".repeat(max)]).unwrap();
        }
        assert!(db.execute("INSERT INTO global_settings VALUES('ninth','x')",params![]).is_err());
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
        Ok(())
    })
    .unwrap();
}

#[test]
fn beneficiary_hold_total_tracks_cross_payer_admission_retry_and_settlement() {
    state::initialize().unwrap();
    let owner = principal(2000);
    let a = quote(3000, owner, 1);
    let b = quote(3001, owner, 2);
    let other = quote(3002, principal(2001), 3);
    let held = || {
        state::transaction(|db| crate::payment_holds::beneficiary(db, &owner.to_text(), None))
            .unwrap()
    };
    assert_eq!(held(), 0);
    let a = begin_payment(a.wallet, &a.request.operation, 1).unwrap();
    let b = begin_payment(b.wallet, &b.request.operation, 1).unwrap();
    let other = begin_payment(other.wallet, &other.request.operation, 1).unwrap();
    assert_eq!(held(), 200_000_000);
    state::transaction(|db| {
        let wallet = a.wallet.to_text();
        let excluded = Some((wallet.as_str(), a.request.operation.as_slice()));
        assert_eq!(
            crate::payment_holds::beneficiary(db, &owner.to_text(), excluded)?,
            100_000_000
        );
        let wallet = other.wallet.to_text();
        let excluded = Some((wallet.as_str(), other.request.operation.as_slice()));
        assert_eq!(
            crate::payment_holds::beneficiary(db, &owner.to_text(), excluded)?,
            200_000_000
        );
        let buckets: i64 = db
            .query_row(
                "SELECT count(*) FROM payment_holds WHERE kind='beneficiary'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(buckets, 2);
        Ok(())
    })
    .unwrap();
    complete_payment(&a, Outcome::Unknown).unwrap();
    let retried = begin_payment(a.wallet, &a.request.operation, 2).unwrap();
    assert_eq!(held(), 200_000_000);
    complete_payment(&retried, Outcome::Paid(7)).unwrap();
    assert_eq!(held(), 100_000_000);
    complete_payment(&b, Outcome::Rejected(Status::InsufficientFunds)).unwrap();
    assert_eq!(held(), 0);
}

#[test]
fn beneficiary_admission_fits_a_fixed_sql_budget_with_thousands_of_payers() {
    state::initialize().unwrap();
    let owner = principal(2000);
    let mut payment = quote(3000, owner, 1);
    payment.status = Status::Unknown;
    state::transaction(|db| {
        for n in 0..2_048 {
            payment.wallet = principal(4000 + n);
            db.execute(
                "INSERT INTO payments VALUES(?1,?2,?3,9223372036854775807)",
                params![payment.wallet.to_text(), payment.request.operation, serde_json::to_string(&payment).unwrap()],
            ).unwrap();
        }
        let owner = owner.to_text();
        {
            let _budget = kinic_sqlite_compat::install_progress_handler(db, 20, 200);
            crate::accounting::admit_credit(db, &owner, 100_000_000, None)?;
        }
        // The former indexed lookup still had to visit every matching journal row.
        db.execute_batch("CREATE INDEX fixture_pending_beneficiary ON payments(json_extract(record,'$.request.beneficiary')) WHERE json_extract(record,'$.status') IN ('InFlight','Unknown');").unwrap();
        let mut old = db.prepare("SELECT record FROM payments WHERE json_extract(record,'$.request.beneficiary')=?1 AND json_extract(record,'$.status') IN ('InFlight','Unknown')").unwrap();
        let _budget = kinic_sqlite_compat::install_progress_handler(db, 20, 200);
        let error = kinic_sqlite_compat::query_map(&mut old, params![owner], |r| r.get::<_,String>(0)).unwrap_err();
        assert!(kinic_sqlite_compat::is_interrupted(&error));
        Ok(())
    }).unwrap();
}

#[test]
fn capacity_unknown_payment_rows_do_not_block_other_quotes_or_exact_completion() {
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
    let next = admit_quote(
        principal(6000),
        PurchaseRequest {
            operation: vec![2; 16],
            beneficiary: principal(2000),
            amount_e8s: 100_000_000,
            min_credits: 20_000_000,
            created_at_time: 0,
        },
        pending.config.clone(),
        0,
    )
    .unwrap();
    let QuoteAdmission::Fee(next) = next else {
        panic!("new fee flight")
    };
    finish_quote(&next, Ok(10), 1).unwrap();
    let retry = begin_payment(original.wallet, &[255; 16], 1).unwrap();
    complete_payment(&retry, Outcome::Paid(u64::MAX)).unwrap();
    state::transaction(|db| {
        let count: i64 = db
            .query_row("SELECT count(*) FROM payments", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1025);
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
        assert!(db.execute("INSERT INTO accounts(owner,balance_cycles,storage_bytes,storage_charged_at_ms) VALUES(?1,0,0,0)",params!["x".repeat(64)]).is_err());
        assert!(db.execute("INSERT INTO vault_cycle_reservations(owner,token,reserved,created_at_ms) VALUES(?1,?2,0,0)",params![principal(1).to_text(),"x".repeat(129)]).is_err());
        db.execute("INSERT INTO vault_cycle_reservations(owner,token,reserved,created_at_ms) VALUES(?1,?2,0,0)",params![principal(1).to_text(),"x".repeat(128)]).unwrap();
        assert!(db.execute("UPDATE vault_cycle_reservations SET token=?1",params!["x".repeat(129)]).is_err());
        Ok(())
    }).unwrap();
}

#[test]
fn key_gc_refreshes_offline_other_owner_billing_and_restores_caller_scope() {
    state::initialize().unwrap();
    let caller = principal(7001);
    let other = principal(7002);
    state::transaction(|db|{
        let now=3*vault_types::DAY;
        let account=other.to_text();
        db.execute("INSERT INTO accounts(owner,balance_cycles,storage_bytes,storage_charged_at_ms) VALUES(?1,1000000000,0,0)",params![account]).unwrap();
        vault_store::OwnerContext::authenticated(other)?.run(db,|db|{
            vault_store::keys::reserve(db, &[1; 16], 1,1,0)?;
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
