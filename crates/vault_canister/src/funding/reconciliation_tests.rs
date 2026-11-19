use super::*;
fn principal(n: u8) -> Principal {
    Principal::from_slice(&[n])
}
fn sent() -> Payment {
    crate::state::initialize().unwrap();
    record_quote(
        principal(91),
        PurchaseRequest {
            operation: vec![91; 16],
            beneficiary: principal(92),
            amount_e8s: 100_000_000,
            min_credits: 1,
            created_at_time: 0,
        },
        FundingConfig {
            ledger: principal(93),
            recipient: principal(94),
            cycles_per_kinic: 100_000_000,
        },
        10,
        0,
    )
    .unwrap();
    begin_preparation(&begin_payment(principal(91), &[91; 16], 0).unwrap()).unwrap()
}
fn account(n: u8) -> Value {
    Value::Array(vec![Value::Blob(vec![n])])
}
fn block() -> Value {
    // Independently specified ledger block: amount 1 KINIC, fee 10, three default accounts.
    Value::Map(vec![(
        "tx".into(),
        Value::Map(vec![
            ("op".into(), Value::Text("xfer".into())),
            ("from".into(), account(91)),
            ("to".into(), account(94)),
            ("spender".into(), account(95)),
            ("amt".into(), Value::Nat(100_000_000u64.into())),
            ("fee".into(), Value::Nat(10u64.into())),
            ("ts".into(), Value::Nat(0u64.into())),
            ("memo".into(), Value::Blob(vec![7; 32])),
        ]),
    )])
}
#[test]
fn exact_transfer_matches_but_each_mismatched_field_is_rejected() {
    let mut p = sent();
    p.memo = vec![7; 32];
    p.reconciliation = Some(ReconciliationState {
        start: 0,
        next: 0,
        end: 0,
        spender: principal(95),
        lease: 0,
        lease_until: 0,
        lease_generation: 0,
    });
    assert!(matches_transfer(&p, &block()));
    for key in ["from", "to", "spender", "amt", "fee", "ts", "memo", "op"] {
        let mut b = block();
        let Value::Map(outer) = &mut b else {
            unreachable!()
        };
        let Value::Map(tx) = &mut outer[0].1 else {
            unreachable!()
        };
        tx.iter_mut().find(|(k, _)| k == key).unwrap().1 = Value::Text("mismatch".into());
        assert!(!matches_transfer(&p, &b), "{key}");
    }
}
#[test]
fn cursor_is_persisted_before_dispatch_and_single_flight_is_owner_bound() {
    let p = sent();
    let p = prepare_dispatch(&p, principal(95), 123).unwrap();
    assert_eq!(
        transaction(|db| load(db, p.wallet, &p.request.operation))
            .unwrap()
            .unwrap()
            .reconciliation
            .as_ref()
            .unwrap()
            .start,
        123
    );
    complete_payment(&p, Outcome::Unknown).unwrap();
    assert!(begin_scan(principal(96), &[91; 16], 1).is_err());
    let scan = begin_scan(p.wallet, &[91; 16], 1).unwrap();
    assert_eq!(scan.reconciliation.unwrap().next, 123);
    assert!(matches!(
        begin_scan(p.wallet, &[91; 16], 2),
        Err(Error::Busy)
    ));
}
#[test]
fn payment_json_requires_its_dispatch_marker() {
    let p = sent();
    let mut json = serde_json::to_value(&p).unwrap();
    json.as_object_mut().unwrap().remove("preparing");
    assert!(serde_json::from_value::<Payment>(json).is_err());
}

fn scanning() -> Payment {
    let p = sent();
    let p = prepare_dispatch(&p, principal(95), 123).unwrap();
    complete_payment(&p, Outcome::Unknown).unwrap();
    begin_scan(p.wallet, &p.request.operation, 1).unwrap()
}
#[test]
fn bounded_scan_resumes_without_skipping_gaps_and_failure_keeps_unknown() {
    let p = scanning();
    let batch = ScanBatch {
        end: 500,
        blocks: (123..223)
            .map(|id| Block {
                id: Nat::from(id as u64),
                block: Value::Map(vec![]),
            })
            .collect(),
    };
    let progress = finish_scan(&p, Ok(batch), 2).unwrap();
    assert_eq!(progress.scanned, 100);
    assert_eq!(progress.next, Nat::from(223u64));
    assert!(progress.can_continue);
    assert_eq!(progress.payment.status, Status::Unknown);
    let p = begin_scan(p.wallet, &p.request.operation, 3).unwrap();
    let progress = finish_scan(
        &p,
        Ok(ScanBatch {
            end: 500,
            blocks: vec![Block {
                id: 224u64.into(),
                block: block(),
            }],
        }),
        4,
    )
    .unwrap();
    assert_eq!(progress.next, Nat::from(223u64));
    assert!(!progress.can_continue);
    let p = begin_scan(p.wallet, &p.request.operation, 5).unwrap();
    let progress = finish_scan(&p, Err(Error::KeyService), 6).unwrap();
    assert_eq!(progress.next, Nat::from(223u64));
    assert_eq!(progress.payment.status, Status::Unknown);
    assert_eq!(
        crate::state::State
            .balance(&principal(92).to_text())
            .unwrap(),
        0
    );
}
#[test]
fn reconciliation_and_late_callback_share_atomic_credit_and_stale_upgrade_lease_is_fenced() {
    let p = scanning();
    crate::state::State.vault_start_generation().unwrap();
    assert!(finish_scan(&p, Err(Error::KeyService), 2).is_err());
    let scan = begin_scan(p.wallet, &p.request.operation, 3).unwrap();
    let mut b = block();
    let Value::Map(outer) = &mut b else {
        unreachable!()
    };
    let Value::Map(tx) = &mut outer[0].1 else {
        unreachable!()
    };
    tx.iter_mut().find(|(k, _)| k == "memo").unwrap().1 = Value::Blob(p.memo.clone());
    let progress = finish_scan(
        &scan,
        Ok(ScanBatch {
            end: 124,
            blocks: vec![Block {
                id: 123u64.into(),
                block: b,
            }],
        }),
        4,
    )
    .unwrap();
    assert_eq!(progress.payment.status, Status::Paid(123));
    assert!(!progress.can_continue);
    complete_payment(&p, Outcome::Paid(123)).unwrap();
    assert_eq!(
        crate::state::State
            .balance(&principal(92).to_text())
            .unwrap(),
        100_000_000
    );
}
fn completion_reserves() -> i64 {
    transaction(|db| {
        db.query_row(
            "SELECT count(*) FROM payment_completion_reservations",
            [],
            |r| sql::row_get(r, 0),
        )
        .map_err(|_| Error::Storage)
    })
    .expect("schema must support durable payment completion reservations")
}

#[test]
fn reconciliation_starts_advances_and_credits_at_the_page_limit() {
    let payment = prepare_dispatch(&sent(), principal(95), 999).unwrap();
    let payment = complete_payment(&payment, Outcome::Unknown).unwrap();
    assert_eq!(completion_reserves(), 1);
    let page_limit = transaction(|db| {
        // Make an audit write depend on a free page even if the audit table
        // currently has room. The filler exists only in this test.
        db.execute_batch(
            "CREATE TABLE page_limit_filler(data BLOB);
            CREATE TRIGGER page_limit_audit BEFORE INSERT ON account_ledger
            BEGIN INSERT INTO page_limit_filler VALUES(zeroblob(32768)); END;
            CREATE TRIGGER page_limit_record_growth BEFORE UPDATE OF record ON payments
            WHEN length(NEW.record)>length(OLD.record)
            BEGIN INSERT INTO page_limit_filler VALUES(zeroblob(32768)); END;",
        )
        .unwrap();
        let pages: i64 = db
            .query_row("PRAGMA page_count", [], |r| sql::row_get(r, 0))
            .unwrap();
        let free: i64 = db
            .query_row("PRAGMA freelist_count", [], |r| sql::row_get(r, 0))
            .unwrap();
        assert_eq!(free, 0);
        db.execute_batch(&format!("PRAGMA max_page_count={pages};"))
            .unwrap();
        Ok(pages)
    })
    .unwrap();

    let scan = begin_scan(payment.wallet, &payment.request.operation, 1).unwrap();
    let missed = finish_scan(
        &scan,
        Ok(ScanBatch {
            end: 1001,
            blocks: vec![Block {
                id: 999u64.into(),
                block: Value::Map(vec![]),
            }],
        }),
        2,
    )
    .unwrap();
    assert_eq!(missed.next, Nat::from(1000u64));
    assert_eq!(missed.payment.status, Status::Unknown);
    assert_eq!(completion_reserves(), 1);
    let scan = begin_scan(payment.wallet, &payment.request.operation, 3).unwrap();
    let mut matching = block();
    let Value::Map(outer) = &mut matching else {
        unreachable!()
    };
    let Value::Map(fields) = &mut outer[0].1 else {
        unreachable!()
    };
    fields.iter_mut().find(|(key, _)| key == "memo").unwrap().1 = Value::Blob(scan.memo.clone());
    let progress = finish_scan(
        &scan,
        Ok(ScanBatch {
            end: 1001,
            blocks: vec![Block {
                id: 1000u64.into(),
                block: matching,
            }],
        }),
        4,
    )
    .unwrap();
    assert_eq!(progress.payment.status, Status::Paid(1000));
    assert_eq!(completion_reserves(), 0);
    assert_eq!(
        begin_scan(scan.wallet, &scan.request.operation, 5)
            .unwrap()
            .status,
        Status::Paid(1000)
    );
    transaction(|db| {
        assert_eq!(
            db.query_row("PRAGMA page_count", [], |r| sql::row_get::<i64>(r, 0))
                .unwrap(),
            page_limit
        );
        assert_eq!(
            db.query_row(
                "SELECT count(*) FROM account_ledger WHERE kind='purchase'",
                [],
                |r| sql::row_get::<i64>(r, 0)
            )
            .unwrap(),
            1
        );
        Ok(())
    })
    .unwrap();
    assert_eq!(
        crate::state::State
            .balance(&principal(92).to_text())
            .unwrap(),
        100_000_000
    );
}

#[test]
fn recovering_interrupted_unsent_quote_releases_completion_space() {
    let payment = sent();
    assert_eq!(completion_reserves(), 1);
    crate::state::State.vault_start_generation().unwrap();
    let recovered = begin_scan(payment.wallet, &payment.request.operation, 1).unwrap();
    assert_eq!(recovered.status, Status::Quoted);
    assert_eq!(completion_reserves(), 0);
    transaction(|db| {
        let accounts: i64 = db
            .query_row("SELECT count(*) FROM accounts", [], |r| r.get(0))
            .unwrap();
        assert_eq!(accounts, 0);
        assert_eq!(
            crate::payment_holds::beneficiary(db, &payment.request.beneficiary.to_text(), None)?,
            0
        );
        Ok(())
    })
    .unwrap();
}

#[test]
fn archive_ranges_are_clipped_to_requested_window_and_only_direct_ledger_callbacks_are_used() {
    let response = GetBlocksResult {
        log_length: 1000u64.into(),
        blocks: vec![],
        archived_blocks: vec![Archive {
            args: vec![Range {
                start: 0u64.into(),
                length: 1000u64.into(),
            }],
            callback: ArchiveCallback::new(principal(99), "icrc3_get_blocks".into()),
        }],
    };
    let (callback, range) = archive_request(&response, 123, 1000).unwrap();
    assert_eq!(callback.0.principal, principal(99));
    assert_eq!(range.start, Nat::from(123u64));
    assert_eq!(range.length, Nat::from(100u64));
    assert!(archive_request(&response, 1000, 1000).is_none());
}
#[test]
fn scan_lease_blocks_transfer_retry_and_upgrade_releases_it_without_losing_cursor() {
    let p = scanning();
    assert_eq!(
        begin_payment(p.wallet, &p.request.operation, 2),
        Err(Error::Busy)
    );
    crate::state::State.vault_start_generation().unwrap();
    let next = begin_scan(p.wallet, &p.request.operation, 3).unwrap();
    assert_eq!(next.reconciliation.as_ref().unwrap().next, 123);
    assert_ne!(
        next.reconciliation.as_ref().unwrap().lease_generation,
        p.reconciliation.as_ref().unwrap().lease_generation
    );
    assert!(finish_scan(&p, Err(Error::KeyService), 4).is_err());
}
#[test]
fn expired_scan_callback_cannot_overwrite_a_new_lease() {
    let p = scanning();
    let next = begin_scan(p.wallet, &p.request.operation, 181_000_000_000).unwrap();
    assert!(finish_scan(&p, Err(Error::KeyService), 181_000_000_001).is_err());
    assert!(finish_scan(&next, Err(Error::KeyService), 181_000_000_002).is_ok());
}
#[test]
fn oversized_duplicate_and_out_of_range_evidence_never_advances_or_credits() {
    let p = scanning();
    for ids in [vec![123; 2], vec![122], vec![223], (123..224).collect()] {
        let p = begin_scan(p.wallet, &p.request.operation, 181_000_000_000).unwrap();
        let result = finish_scan(
            &p,
            Ok(ScanBatch {
                end: 500,
                blocks: ids
                    .into_iter()
                    .map(|id| Block {
                        id: Nat::from(id as u64),
                        block: block(),
                    })
                    .collect(),
            }),
            181_000_000_001,
        )
        .unwrap();
        assert_eq!(result.next, Nat::from(123u64));
        assert_eq!(result.scanned, 0);
        assert_eq!(result.payment.status, Status::Unknown);
        assert!(!result.can_continue);
    }
}
#[test]
fn default_account_encoding_and_modern_block_type_are_validated() {
    let mut p = scanning();
    p.memo = vec![7; 32];
    let mut b = block();
    let Value::Map(outer) = &mut b else {
        unreachable!()
    };
    let Value::Map(tx) = &mut outer[0].1 else {
        unreachable!()
    };
    for key in ["from", "to", "spender"] {
        let Value::Array(parts) = &mut tx.iter_mut().find(|(k, _)| k == key).unwrap().1 else {
            unreachable!()
        };
        parts.push(Value::Blob(vec![0; 32]));
    }
    outer.push(("btype".into(), Value::Text("2xfer".into())));
    assert!(matches_transfer(&p, &b));
    let Value::Map(outer) = &mut b else {
        unreachable!()
    };
    outer[1].1 = Value::Text("1xfer".into());
    assert!(!matches_transfer(&p, &b));
    let Value::Map(outer) = &mut b else {
        unreachable!()
    };
    outer[1].1 = Value::Text("2xfer".into());
    let Value::Map(tx) = &mut outer[0].1 else {
        unreachable!()
    };
    let Value::Array(parts) = &mut tx.iter_mut().find(|(k, _)| k == "spender").unwrap().1 else {
        unreachable!()
    };
    parts[1] = Value::Blob(vec![1; 32]);
    assert!(!matches_transfer(&p, &b));
}
#[test]
fn missing_dispatch_cursor_is_corrupt_state_and_is_not_rewritten() {
    let p = sent();
    let dispatched = prepare_dispatch(&p, principal(95), 1000).unwrap();
    complete_payment(&dispatched, Outcome::Unknown).unwrap();
    transaction(|db| {
        db.execute(
            "UPDATE payments SET record=json_set(record,'$.reconciliation',NULL) WHERE wallet=?1 AND operation=?2",
            params![p.wallet.to_text(), p.request.operation],
        ).map_err(|_| Error::Storage)?;
        Ok(())
    }).unwrap();
    let before = transaction(|db| load(db, p.wallet, &p.request.operation)).unwrap();
    assert_eq!(
        begin_scan(p.wallet, &p.request.operation, 1),
        Err(Error::Storage)
    );
    assert_eq!(
        transaction(|db| load(db, p.wallet, &p.request.operation)).unwrap(),
        before
    );
}

#[test]
fn widest_reconciliation_record_fits_existing_row_bound_and_round_trips() {
    let mut p = scanning();
    p.wallet = Principal::from_slice(&[255; 29]);
    p.request.beneficiary = p.wallet;
    p.config.ledger = p.wallet;
    p.config.recipient = p.wallet;
    p.request.operation = vec![255; 16];
    p.memo = vec![255; 32];
    p.reconciliation = Some(ReconciliationState {
        start: u64::MAX,
        next: u64::MAX,
        end: u64::MAX,
        spender: p.wallet,
        lease: u64::MAX,
        lease_until: u64::MAX,
        lease_generation: i64::MIN,
    });
    validate_receipts(&p).unwrap();
    assert!(payment_size(&p).unwrap() <= 4096);
    let decoded: Payment = serde_json::from_str(&serde_json::to_string(&p).unwrap()).unwrap();
    assert_eq!(decoded, p);
}
#[test]
fn live_transfer_scan_is_busy_and_preserves_definitive_rejection() {
    let p = sent();
    let dispatched = prepare_dispatch(&p, principal(95), 123).unwrap();
    for now in [1, 120_000_000_000] {
        assert_eq!(
            begin_scan(dispatched.wallet, &dispatched.request.operation, now),
            Err(Error::Busy)
        );
        assert_eq!(
            transaction(|db| load(db, dispatched.wallet, &dispatched.request.operation))
                .unwrap()
                .unwrap(),
            dispatched
        );
    }
    let rejected = complete_payment(
        &dispatched,
        Outcome::Rejected(Status::InsufficientAllowance),
    )
    .unwrap();
    assert_eq!(rejected.status, Status::InsufficientAllowance);
    assert!(!rejected.uncertain);
    let expires: i64 = transaction(|db| {
        db.query_row(
            "SELECT expires FROM payments WHERE wallet=?1 AND operation=?2",
            params![dispatched.wallet.to_text(), dispatched.request.operation],
            |r| sql::row_get(r, 0),
        )
        .map_err(|_| Error::Storage)
    })
    .unwrap();
    assert_eq!(expires, 7 * 86400);
}
#[test]
fn orphaned_transfer_scan_preserves_late_success_exactly_once() {
    let p = sent();
    let dispatched = prepare_dispatch(&p, principal(95), 123).unwrap();
    let scan = begin_scan(
        dispatched.wallet,
        &dispatched.request.operation,
        120_000_000_001,
    )
    .unwrap();
    assert_eq!(scan.status, Status::Unknown);
    complete_payment(&dispatched, Outcome::Paid(123)).unwrap();
    let result = finish_scan(&scan, Err(Error::KeyService), 120_000_000_002).unwrap();
    assert_eq!(result.payment.status, Status::Paid(123));
    complete_payment(&dispatched, Outcome::Paid(123)).unwrap();
    assert_eq!(
        crate::state::State
            .balance(&principal(92).to_text())
            .unwrap(),
        dispatched.credits
    );
}
#[test]
fn upgrade_releases_live_transfer_for_reconciliation() {
    let p = sent();
    let dispatched = prepare_dispatch(&p, principal(95), 123).unwrap();
    crate::state::State.vault_start_generation().unwrap();
    let scan = begin_scan(dispatched.wallet, &dispatched.request.operation, 1).unwrap();
    assert_eq!(scan.status, Status::Unknown);
    assert!(scan.uncertain);
    assert_eq!(scan.reconciliation.as_ref().unwrap().next, 123);
    let result = finish_scan(&scan, Err(Error::KeyService), 2).unwrap();
    assert_eq!(result.payment.status, Status::Unknown);
    assert!(!result.can_continue);
}
#[test]
fn first_tip_failure_restores_known_unsent_quote_and_can_retry_safely() {
    let p = sent();
    let quote = finish_preparation(&p).unwrap();
    assert_eq!(quote.status, Status::Quoted);
    assert!(!quote.uncertain);
    let retry = begin_payment(p.wallet, &p.request.operation, 1).unwrap();
    let retry = begin_preparation(&retry).unwrap();
    let ready = prepare_dispatch(&retry, principal(95), 123).unwrap();
    assert_eq!(ready.reconciliation.unwrap().start, 123);
    assert_eq!(
        crate::state::State
            .balance(&principal(92).to_text())
            .unwrap(),
        0
    );
}
#[test]
fn reconciliation_cannot_interrupt_live_tip_preparation_but_upgrade_recovers_unsent_quote() {
    let p = sent();
    assert_eq!(
        begin_scan(p.wallet, &p.request.operation, 1),
        Err(Error::Busy)
    );
    crate::state::State.vault_start_generation().unwrap();
    let recovered = begin_scan(p.wallet, &p.request.operation, 2).unwrap();
    assert_eq!(recovered.status, Status::Quoted);
    assert!(recovered.reconciliation.is_none());
    assert!(finish_preparation(&p).is_err());
    let retry = begin_payment(p.wallet, &p.request.operation, 3).unwrap();
    let retry = begin_preparation(&retry).unwrap();
    prepare_dispatch(&retry, principal(95), 123).unwrap();
}
#[test]
fn global_scan_flight_limit_is_eight_and_releases_after_completion() {
    crate::state::initialize().unwrap();
    let mut prepared = Vec::new();
    for n in 101..=109u8 {
        let wallet = principal(n);
        record_quote(
            wallet,
            PurchaseRequest {
                operation: vec![n; 16],
                beneficiary: principal(92),
                amount_e8s: 100_000_000,
                min_credits: 1,
                created_at_time: 0,
            },
            FundingConfig {
                ledger: principal(93),
                recipient: principal(94),
                cycles_per_kinic: 100_000_000,
            },
            10,
            0,
        )
        .unwrap();
        let p = begin_preparation(&begin_payment(wallet, &[n; 16], 0).unwrap()).unwrap();
        let p = prepare_dispatch(&p, principal(95), 123).unwrap();
        complete_payment(&p, Outcome::Unknown).unwrap();
        prepared.push(p);
    }
    let active: Vec<_> = prepared[..8]
        .iter()
        .map(|p| begin_scan(p.wallet, &p.request.operation, 1).unwrap())
        .collect();
    let ninth = &prepared[8];
    assert_eq!(
        begin_scan(ninth.wallet, &ninth.request.operation, 2),
        Err(Error::Busy)
    );
    finish_scan(&active[0], Err(Error::KeyService), 3).unwrap();
    assert!(begin_scan(ninth.wallet, &ninth.request.operation, 4).is_ok());
}
