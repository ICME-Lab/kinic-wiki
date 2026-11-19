use super::*;
pub(super) fn p(n: u8) -> Principal {
    Principal::from_slice(&[n])
}
pub(super) fn setup() {
    crate::state::initialize().unwrap();
    configure(BridgeConfig {
        peer: p(9),
        enabled: true,
        daily_limit_cycles: 1_000_000_000,
        physical_reserve_cycles: 1,
    })
    .unwrap();
}
pub(super) fn offer() -> CreditOffer {
    CreditOffer {
        operation: vec![7; 16],
        wiki_owner: p(2),
        vault_owner: p(1),
        amount_cycles: 100,
        expires_at_ns: 300_000_000_000,
        link_generation: 1,
    }
}
#[test]
fn challenge_binds_both_owners_and_revoke_fences_late_ack() {
    setup();
    let a = begin_link(p(1), vec![3; 16], 0).unwrap();
    assert_eq!(a, begin_link(p(1), vec![3; 16], 0).unwrap());
    assert_ne!(
        a.challenge,
        begin_link(p(2), vec![3; 16], 0).unwrap().challenge
    );
    assert_eq!(
        consume_link(p(8), a.challenge.clone(), p(2), 1),
        Err(Error::Unauthorized)
    );
    let proof = consume_link(p(9), a.challenge.clone(), p(2), 1).unwrap();
    assert_eq!(
        consume_link(p(9), a.challenge.clone(), p(3), 1),
        Err(Error::Conflict)
    );
    let fence = revoke(p(1)).unwrap();
    assert!(fence.through_generation >= a.generation);
    assert_eq!(ack_link(p(9), proof), Err(Error::Conflict));
    let fresh = begin_link(p(1), vec![4; 16], 2).unwrap();
    assert!(fresh.generation > fence.through_generation);
}
#[test]
fn exact_credit_once_and_protected_receipt() {
    setup();
    let o = offer();
    prepare(p(1), p(9), o.clone(), 0).unwrap();
    assert_eq!(
        receive(p(8), o.clone(), 1, 100, |_| panic!("unauthorized accept")),
        Err(Error::Unauthorized)
    );
    let mut wrong = o.clone();
    wrong.amount_cycles = 99;
    assert_eq!(
        receive(p(9), wrong, 1, 100, |_| panic!("changed tuple accept")),
        Err(Error::Conflict)
    );
    assert_eq!(
        receive(p(9), o.clone(), 1, 99, |_| panic!("insufficient cycles")),
        Err(Error::InvalidInput)
    );
    assert_eq!(
        receive(p(9), o.clone(), 1, 100, |n| {
            assert_eq!(n, 100);
            n
        })
        .unwrap()
        .status,
        CreditStatus::Accepted
    );
    assert_eq!(
        receive(p(9), o.clone(), 2, 100, |_| panic!("duplicate accepted"))
            .unwrap()
            .status,
        CreditStatus::Accepted
    );
    assert_eq!(crate::state::State.balance(&p(1).to_text()).unwrap(), 100);
    assert_eq!(
        status(p(9), o.clone(), u64::MAX).unwrap().status,
        CreditStatus::Accepted
    );
    ack_credit(p(9), o, 1).unwrap();
}
#[test]
fn new_bridge_link_reclaims_at_most_128_expired_other_wallet_payments() {
    setup();
    transaction(|db| {
        db.execute("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<300) INSERT INTO payments(wallet,operation,record,expires) SELECT printf('expired-%05d',x),CAST(printf('%016d',x) AS BLOB),'{}',-1 FROM n",[]).unwrap();
        Ok(())
    }).unwrap();
    begin_link(p(1), vec![8; 16], 0).unwrap();
    transaction(|db| {
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
fn expired_intent_is_authoritative_not_accepted() {
    setup();
    let o = offer();
    prepare(p(1), p(9), o.clone(), 0).unwrap();
    assert_eq!(
        status(p(9), o.clone(), 300_000_000_000).unwrap().status,
        CreditStatus::NotAccepted
    );
    assert_eq!(
        receive(p(9), o.clone(), 300_000_000_001, 100, |_| panic!(
            "expired accept"
        ))
        .unwrap()
        .status,
        CreditStatus::NotAccepted
    );
    ack_credit(p(9), o, 300_000_000_001).unwrap();
}
#[test]
fn acknowledged_paid_day_reservation_survives_gc() {
    setup();
    let o = offer();
    prepare(p(1), p(9), o.clone(), 0).unwrap();
    receive(p(9), o.clone(), 1, 100, |n| n).unwrap();
    ack_credit(p(9), o, 2).unwrap();
    transaction(|db| {
        admit(db, p(3), 301_000_000_000)?;
        assert!(load(db, p(1), &[7; 16])?.is_some());
        Ok(())
    })
    .unwrap();
}
#[test]
fn cycles_storage_failure_never_accepts_or_credits() {
    setup();
    let o = offer();
    prepare(p(1), p(9), o.clone(), 0).unwrap();
    transaction(|db|{db.execute_batch("CREATE TRIGGER bridge_fail BEFORE UPDATE ON payments BEGIN SELECT RAISE(ABORT,'test failure'); END;").unwrap();Ok(())}).unwrap();
    assert_eq!(
        receive(p(9), o.clone(), 1, 100, |_| panic!(
            "storage failure accepted"
        )),
        Err(Error::Storage)
    );
    assert_eq!(crate::state::State.balance(&p(1).to_text()).unwrap(), 0);
    assert_eq!(status(p(9), o, 1).unwrap().status, CreditStatus::Prepared);
}
#[test]
fn short_accept_traps_and_rolls_back_native_transaction() {
    setup();
    let o = offer();
    prepare(p(1), p(9), o.clone(), 0).unwrap();
    assert!(std::panic::catch_unwind(|| receive(p(9), o.clone(), 1, 100, |_| 99)).is_err());
    assert_eq!(crate::state::State.balance(&p(1).to_text()).unwrap(), 0);
    assert_eq!(status(p(9), o, 1).unwrap().status, CreditStatus::Prepared);
}
#[test]
fn disable_stops_new_work_but_preserves_pending_authority() {
    setup();
    let o = offer();
    prepare(p(1), p(9), o.clone(), 0).unwrap();
    configure(BridgeConfig {
        peer: p(9),
        enabled: false,
        daily_limit_cycles: 1000,
        physical_reserve_cycles: 1,
    })
    .unwrap();
    assert_eq!(begin_link(p(1), vec![1; 16], 0), Err(Error::Unauthorized));
    assert_eq!(
        receive(p(9), o, 1, 100, |n| n).unwrap().status,
        CreditStatus::Accepted
    );
    assert_eq!(
        configure(BridgeConfig {
            peer: p(8),
            enabled: false,
            daily_limit_cycles: 1000,
            physical_reserve_cycles: 1
        }),
        Err(Error::Conflict)
    );
}
#[test]
fn claimed_link_is_protected_after_expiry() {
    setup();
    let c = begin_link(p(1), vec![1; 16], 0).unwrap();
    let proof = consume_link(p(9), c.challenge.clone(), p(2), 1).unwrap();
    transaction(|db| admit(db, p(3), 301_000_000_000)).unwrap();
    assert_eq!(
        consume_link(p(9), c.challenge, p(2), 301_000_000_000).unwrap(),
        proof
    );
    ack_link(p(9), proof).unwrap();
    transaction(|db| {
        admit(db, p(3), 301_000_000_000)?;
        assert!(load(db, p(1), &[1; 16])?.is_none());
        Ok(())
    })
    .unwrap();
}
#[test]
fn challenge_expiry_malformed_and_anonymous_are_rejected() {
    setup();
    assert_eq!(
        begin_link(Principal::anonymous(), vec![1; 16], 0),
        Err(Error::Unauthorized)
    );
    assert_eq!(begin_link(p(1), vec![1; 15], 0), Err(Error::InvalidInput));
    let c = begin_link(p(1), vec![1; 16], 0).unwrap();
    assert_eq!(
        consume_link(p(9), c.challenge, p(2), 300_000_000_000),
        Err(Error::Expired)
    );
    assert_eq!(
        consume_link(p(9), vec![1; 15], p(2), 0),
        Err(Error::InvalidInput)
    );
    let o = offer();
    assert_eq!(prepare(p(3), p(9), o.clone(), 0), Err(Error::Unauthorized));
    assert_eq!(status(p(9), o, 0), Err(Error::NotFound));
}
#[test]
fn owner_pool_bound_is_shared_with_bridge_and_no_account_for_links() {
    setup();
    for n in 0..16 {
        begin_link(p(1), vec![n; 16], 0).unwrap();
    }
    assert_eq!(begin_link(p(1), vec![99; 16], 0), Err(Error::QuotaExceeded));
    assert_eq!(prepare(p(1), p(9), offer(), 0), Err(Error::Conflict));
    transaction(|db| {
        let count: i64 = db
            .query_row("SELECT count(*) FROM accounts", params![], |r| {
                sql::row_get(r, 0)
            })
            .unwrap();
        assert_eq!(count, 0);
        assert_eq!(crate::funding::all_payments(db)?.count(), 0);
        Ok(())
    })
    .unwrap();
}
#[test]
fn bridge_pending_account_does_not_block_another_beneficiary() {
    setup();
    transaction(|db| {
        for n in 0..1023u32 {
            db.execute(
                "INSERT INTO accounts(owner,balance_cycles,storage_bytes,storage_charged_at_ms) VALUES(?1,0,0,0)",
                params![Principal::from_slice(&n.to_be_bytes()).to_text()],
            )
            .unwrap();
        }
        Ok(())
    })
    .unwrap();
    prepare(p(1), p(9), offer(), 0).unwrap();
    transaction(|db| {
        crate::capacity::allocate_beneficiary(db, p(3), 0)?;
        Ok(())
    })
    .unwrap();
    receive(p(9), offer(), 1, 100, |n| n).unwrap();
}
#[test]
fn bridge_link_admits_after_a_thousand_other_payment_rows() {
    setup();
    transaction(|db| {
        for n in 0..1024u32 {
            db.execute(
                "INSERT INTO payments VALUES(?1,?2,?3,?4)",
                params![
                    Principal::from_slice(&n.to_be_bytes()).to_text(),
                    vec![1u8; 16],
                    "{}",
                    i64::MAX
                ],
            )
            .unwrap();
        }
        Ok(())
    })
    .unwrap();
    begin_link(p(1), vec![2; 16], 0).unwrap();
}
#[test]
fn upgrade_keeps_prepared_and_claimed_records_and_serial() {
    setup();
    let o = offer();
    prepare(p(1), p(9), o.clone(), 0).unwrap();
    let c = begin_link(p(1), vec![1; 16], 0).unwrap();
    let proof = consume_link(p(9), c.challenge, p(2), 1).unwrap();
    crate::state::initialize().unwrap();
    assert_eq!(
        status(p(9), o.clone(), 1).unwrap().status,
        CreditStatus::Prepared
    );
    ack_link(p(9), proof.clone()).unwrap();
    assert!(begin_link(p(1), vec![2; 16], 2).unwrap().generation > proof.challenge.generation);
    receive(p(9), o, 1, 100, |n| n).unwrap();
}
#[test]
fn legacy_icrc_admission_counts_bridge_even_with_same_operation() {
    setup();
    let o = offer();
    prepare(p(1), p(9), o.clone(), 0).unwrap();
    transaction(|db| {
        db.execute(
            "UPDATE accounts SET balance_cycles=?2 WHERE owner=?1",
            params![p(1).to_text(), i64::MAX - 20_000_050],
        )
        .unwrap();
        Ok(())
    })
    .unwrap();
    let request = crate::funding::PurchaseRequest {
        operation: o.operation,
        beneficiary: p(1),
        amount_e8s: 100_000_000,
        min_credits: 1,
        created_at_time: 1,
    };
    let cfg = crate::funding::FundingConfig {
        ledger: p(8),
        recipient: p(9),
        cycles_per_kinic: 20_000_000,
    };
    crate::funding::record_quote(p(3), request.clone(), cfg, 1, 1).unwrap();
    assert_eq!(
        crate::funding::begin_payment(p(3), &request.operation, 1),
        Err(Error::QuotaExceeded)
    );
}
#[test]
fn old_json_remains_readable_and_bridge_collision_is_not_icrc() {
    setup();
    let request = crate::funding::PurchaseRequest {
        operation: vec![1; 16],
        beneficiary: p(1),
        amount_e8s: 100_000_000,
        min_credits: 1,
        created_at_time: 1,
    };
    let cfg = crate::funding::FundingConfig {
        ledger: p(8),
        recipient: p(9),
        cycles_per_kinic: 20_000_000,
    };
    let original = crate::funding::record_quote(p(1), request.clone(), cfg, 1, 1).unwrap();
    begin_link(p(1), vec![2; 16], 1).unwrap();
    transaction(|db| {
        let found = crate::funding::all_payments(db)?.collect::<Result<Vec<_>>>()?;
        assert_eq!(found, vec![original.clone()]);
        let raw: String = db
            .query_row(
                "SELECT record FROM payments WHERE wallet=?1 AND operation=?2",
                params![p(1).to_text(), request.operation],
                |r| sql::row_get(r, 0),
            )
            .unwrap();
        assert_eq!(
            serde_json::from_str::<crate::funding::Payment>(&raw).unwrap(),
            original
        );
        Ok(())
    })
    .unwrap();
    assert_eq!(
        crate::funding::begin_payment(p(1), &[2; 16], 1),
        Err(Error::Conflict)
    );
}

#[test]
fn callback_preparation_fence_changes_across_configuration_updates() {
    setup();
    let before = transaction(settings).unwrap();
    let snapshot = lookup_snapshot(p(1), &offer().operation).unwrap();
    configure(BridgeConfig {
        enabled: false,
        ..before.config.clone()
    })
    .unwrap();
    configure(before.config).unwrap();
    assert_eq!(
        finish_lookup(snapshot, p(1), offer(), 1),
        Err(Error::Conflict)
    );
}
#[test]
fn every_offer_field_is_part_of_receipt_identity() {
    setup();
    let o = offer();
    prepare(p(1), p(9), o.clone(), 0).unwrap();
    let mut changes = vec![];
    let mut changed = o.clone();
    changed.operation = vec![8; 16];
    changes.push(changed);
    let mut changed = o.clone();
    changed.wiki_owner = p(3);
    changes.push(changed);
    let mut changed = o.clone();
    changed.vault_owner = p(3);
    changes.push(changed);
    let mut changed = o.clone();
    changed.amount_cycles += 1;
    changes.push(changed);
    let mut changed = o.clone();
    changed.expires_at_ns += 1;
    changes.push(changed);
    let mut changed = o.clone();
    changed.link_generation += 1;
    changes.push(changed);
    for changed in changes {
        assert!(receive(p(9), changed, 1, 100, |_| panic!("changed tuple accepted")).is_err());
    }
    assert_eq!(ack_credit(p(9), o, 1), Err(Error::Conflict));
}
#[test]
fn old_revoke_completion_cannot_remove_new_link_challenge() {
    setup();
    let old = begin_link(p(1), vec![1; 16], 0).unwrap();
    let proof = consume_link(p(9), old.challenge, p(2), 1).unwrap();
    let fence = revoke(p(1)).unwrap();
    let fresh = begin_link(p(1), vec![2; 16], 1).unwrap();
    finish_revoke(&fence).unwrap();
    assert_eq!(ack_link(p(9), proof), Err(Error::NotFound));
    assert!(
        consume_link(p(9), fresh.challenge, p(2), 2)
            .unwrap()
            .challenge
            .generation
            > fence.through_generation
    );
}

#[test]
fn upgraded_offer_callback_cannot_prepare_an_intent() {
    setup();
    let snapshot = lookup_snapshot(p(1), &offer().operation).unwrap();
    crate::state::initialize().unwrap();
    assert_eq!(
        finish_lookup(snapshot, p(1), offer(), 0),
        Err(Error::Conflict)
    );
}

#[test]
fn link_preview_displays_recipient_without_claiming_before_consent() {
    setup();
    let c = begin_link(p(1), vec![1; 16], 0).unwrap();
    assert_eq!(inspect_link(p(9), c.challenge.clone(), 1).unwrap(), c);
    assert_eq!(
        inspect_link(p(8), c.challenge.clone(), 1),
        Err(Error::Unauthorized)
    );
    transaction(|db| {
        assert!(matches!(
            load(db, p(1), &[1; 16])?,
            Some(Record::Link {
                wiki_owner: None,
                ..
            })
        ));
        Ok(())
    })
    .unwrap();
    assert_eq!(
        consume_link(p(9), c.challenge.clone(), p(3), 2)
            .unwrap()
            .wiki_owner,
        p(3)
    );
    assert_eq!(
        inspect_link(p(9), c.challenge.clone(), c.expires_at_ns),
        Err(Error::Expired)
    );
    revoke(p(1)).unwrap();
    assert_eq!(inspect_link(p(9), c.challenge, 3), Err(Error::Conflict));
}

#[test]
fn link_status_forwarding_rejects_a_different_recipient() {
    let link = Some(LinkStatus {
        vault_owner: p(2),
        wiki_owner: p(3),
        generation: 1,
        active: true,
    });
    assert_eq!(
        validate_link_status(p(1), link.clone()),
        Err(Error::Conflict)
    );
    assert_eq!(validate_link_status(p(2), link.clone()).unwrap(), link);
    assert_eq!(validate_link_status(p(1), None).unwrap(), None);
}

#[test]
fn widest_bridge_records_fit_4096_without_fake_icrc_fields() {
    setup();
    transaction(|db| {
        let owner = Principal::from_slice(&[255; 29]);
        let challenge = LinkChallenge {
            challenge: vec![255; 16],
            vault_owner: owner,
            generation: u64::MAX,
            expires_at_ns: u64::MAX,
        };
        save(
            db,
            owner,
            &[255; 16],
            Record::Link {
                challenge,
                wiki_owner: Some(owner),
                revoked: true,
                acknowledged: false,
            },
        )?;
        let offer = CreditOffer {
            operation: vec![254; 16],
            wiki_owner: owner,
            vault_owner: owner,
            amount_cycles: i64::MAX as u64,
            expires_at_ns: u64::MAX,
            link_generation: u64::MAX,
        };
        save(
            db,
            owner,
            &[254; 16],
            Record::Credit {
                offer,
                status: CreditStatus::NotAccepted,
                acknowledged: false,
                day: u64::MAX,
            },
        )?;
        let mut q = db
            .prepare("SELECT wallet,operation,record FROM payments")
            .unwrap();
        let rows: Vec<(String, Vec<u8>, String)> = sql::query_map(&mut q, params![], |r| {
            Ok((
                sql::row_get(r, 0)?,
                sql::row_get(r, 1)?,
                sql::row_get(r, 2)?,
            ))
        })
        .unwrap();
        for (wallet, id, raw) in rows {
            assert!(
                vault_types::capacity::row_size(&[wallet.len(), id.len(), raw.len()], 1).unwrap()
                    <= 4096
            );
            let json: serde_json::Value = serde_json::from_str(&raw).unwrap();
            assert!(json.get("request").is_none());
            assert!(json.get("config").is_none());
            assert!(decode(&raw)?.is_some());
        }
        Ok(())
    })
    .unwrap();
}
#[test]
fn pending_and_paid_unacked_receipts_survive_generic_gc() {
    setup();
    let o = offer();
    prepare(p(1), p(9), o.clone(), 0).unwrap();
    transaction(|db| admit(db, p(3), 301_000_000_000)).unwrap();
    assert_eq!(
        status(p(9), o.clone(), 1).unwrap().status,
        CreditStatus::Prepared
    );
    receive(p(9), o.clone(), 1, 100, |n| n).unwrap();
    transaction(|db| admit(db, p(3), 10 * DAY)).unwrap();
    assert_eq!(
        status(p(9), o.clone(), 10 * DAY).unwrap().status,
        CreditStatus::Accepted
    );
    ack_credit(p(9), o.clone(), 10 * DAY).unwrap();
    transaction(|db| admit(db, p(3), 10 * DAY)).unwrap();
    assert_eq!(status(p(9), o, 10 * DAY), Err(Error::NotFound));
}

#[test]
fn receipt_accepted_across_midnight_keeps_today_daily_capacity_reserved() {
    setup();
    configure(BridgeConfig {
        peer: p(9),
        enabled: true,
        daily_limit_cycles: 100,
        physical_reserve_cycles: 1,
    })
    .unwrap();
    let mut first = offer();
    first.expires_at_ns = DAY + 100;
    prepare(p(1), p(9), first.clone(), DAY - 100).unwrap();
    receive(p(9), first, DAY + 1, 100, |n| n).unwrap();
    let mut second = offer();
    second.operation = vec![8; 16];
    second.expires_at_ns = DAY + 100;
    assert_eq!(
        prepare(p(1), p(9), second, DAY + 2),
        Err(Error::QuotaExceeded)
    );
}

#[test]
fn disabled_bridge_allows_claimed_proof_recovery_but_not_new_claims() {
    setup();
    let claimed = begin_link(p(1), vec![1; 16], 0).unwrap();
    let untouched = begin_link(p(1), vec![2; 16], 0).unwrap();
    let proof = consume_link(p(9), claimed.challenge.clone(), p(2), 1).unwrap();
    configure(BridgeConfig {
        peer: p(9),
        enabled: false,
        daily_limit_cycles: 1000,
        physical_reserve_cycles: 1,
    })
    .unwrap();
    assert_eq!(
        consume_link(p(9), claimed.challenge, p(2), 2).unwrap(),
        proof
    );
    assert_eq!(
        consume_link(p(9), untouched.challenge, p(2), 2),
        Err(Error::Unauthorized)
    );
    ack_link(p(9), proof).unwrap();
}
