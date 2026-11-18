//! Interleavings from independent review of ee804e6c.
use super::tests::{offer, p, setup};
use super::*;
use crate::funding::{
    FeeFlight, FundingConfig, PurchaseRequest, QuoteAdmission, admit_quote, finish_quote,
};

fn fee_flight(owner: Principal, operation: Vec<u8>) -> FeeFlight {
    match admit_quote(
        owner,
        PurchaseRequest {
            operation,
            beneficiary: owner,
            amount_e8s: 100_000_000,
            min_credits: 1,
            created_at_time: 1,
        },
        FundingConfig {
            ledger: p(8),
            recipient: p(9),
            cycles_per_kinic: 20_000_000,
        },
        1,
    )
    .unwrap()
    {
        QuoteAdmission::Fee(flight) => flight,
        QuoteAdmission::Existing(_) => panic!("expected an outstanding fee lookup"),
    }
}
fn raw_record(owner: Principal, operation: &[u8]) -> String {
    transaction(|db| {
        db.query_row(
            "SELECT record FROM payments WHERE wallet=?1 AND operation=?2",
            params![owner.to_text(), operation],
            |r| sql::row_get(r, 0),
        )
        .map_err(|_| Error::Storage)
    })
    .unwrap()
}
fn assert_flight_cleaned() {
    transaction(|db| {
        let count: i64 = db
            .query_row("SELECT count(*) FROM quote_fee_flights", params![], |r| {
                sql::row_get(r, 0)
            })
            .unwrap();
        assert_eq!(count, 0);
        Ok(())
    })
    .unwrap();
}
#[test]
fn live_fee_identity_blocks_bridge_credit_admission() {
    setup();
    let o = offer();
    let flight = fee_flight(p(1), o.operation.clone());
    assert_eq!(prepare(p(1), p(9), o, 2), Err(Error::Conflict));
    assert_eq!(crate::state::State.balance(&p(1).to_text()).unwrap(), 0);
    assert!(finish_quote(&flight, Ok(1), 3).is_ok());
}
#[test]
fn live_fee_identity_blocks_bridge_link_admission() {
    setup();
    let flight = fee_flight(p(1), vec![7; 16]);
    assert_eq!(begin_link(p(1), vec![7; 16], 2), Err(Error::Conflict));
    assert!(finish_quote(&flight, Ok(1), 3).is_ok());
}
fn callback_preserves_credit(accepted: bool) {
    setup();
    let o = offer();
    let flight = fee_flight(p(1), o.operation.clone());
    // Seed the formerly reachable mixed-writer state to exercise callback defense
    // independently of the new admission guard.
    transaction(|db| {
        save(
            db,
            p(1),
            &o.operation,
            Record::Credit {
                offer: o.clone(),
                status: CreditStatus::Prepared,
                acknowledged: false,
                day: 0,
            },
        )
    })
    .unwrap();
    if accepted {
        receive(p(9), o.clone(), 2, 100, |n| n).unwrap();
    }
    let raw = raw_record(p(1), &o.operation);
    assert_eq!(finish_quote(&flight, Ok(1), 3), Err(Error::Conflict));
    assert_flight_cleaned();
    assert_eq!(raw_record(p(1), &o.operation), raw);
    assert_eq!(
        crate::state::State.balance(&p(1).to_text()).unwrap(),
        if accepted { 100 } else { 0 }
    );
    assert_eq!(
        status(p(9), o.clone(), 3).unwrap().status,
        if accepted {
            CreditStatus::Accepted
        } else {
            CreditStatus::Prepared
        }
    );
    if accepted {
        configure(BridgeConfig {
            peer: p(9),
            enabled: true,
            daily_limit_cycles: 100,
            physical_reserve_cycles: 1,
        })
        .unwrap();
        let mut second = o;
        second.operation = vec![8; 16];
        assert_eq!(prepare(p(1), p(9), second, 4), Err(Error::QuotaExceeded));
    } else {
        transaction(|db| {
            assert_eq!(reservations(db)?, vec![(p(1), o.operation, 100)]);
            Ok(())
        })
        .unwrap();
    }
}
#[test]
fn fee_callback_preserves_prepared_credit_and_reservation() {
    callback_preserves_credit(false)
}
#[test]
fn fee_callback_preserves_accepted_credit_and_daily_evidence() {
    callback_preserves_credit(true)
}
#[test]
fn fee_callback_preserves_claimed_link_proof() {
    setup();
    let flight = fee_flight(p(1), vec![7; 16]);
    let proof = LinkProof {
        challenge: LinkChallenge {
            challenge: vec![3; 16],
            vault_owner: p(1),
            generation: 1,
            expires_at_ns: 300_000_000_000,
        },
        wiki_owner: p(2),
    };
    transaction(|db| {
        save(
            db,
            p(1),
            &[7; 16],
            Record::Link {
                challenge: proof.challenge.clone(),
                wiki_owner: Some(p(2)),
                revoked: false,
                acknowledged: false,
            },
        )
    })
    .unwrap();
    let raw = raw_record(p(1), &[7; 16]);
    assert_eq!(finish_quote(&flight, Ok(1), 3), Err(Error::Conflict));
    assert_flight_cleaned();
    assert_eq!(raw_record(p(1), &[7; 16]), raw);
    assert_eq!(
        consume_link(
            p(9),
            proof.challenge.challenge.clone(),
            p(2),
            400_000_000_000
        )
        .unwrap(),
        proof
    );
}
#[test]
fn another_owner_link_cannot_cancel_offer_callback() {
    setup();
    let o = offer();
    let snapshot = lookup_snapshot(p(1), &o.operation).unwrap();
    begin_link(p(3), vec![9; 16], 1).unwrap();
    assert_eq!(
        finish_lookup(snapshot, p(1), o, 2).unwrap().status,
        CreditStatus::Prepared
    );
}
#[test]
fn another_owner_repeated_revoke_cannot_cancel_offer_callback() {
    setup();
    let o = offer();
    let snapshot = lookup_snapshot(p(1), &o.operation).unwrap();
    for _ in 0..32 {
        revoke(p(3)).unwrap();
    }
    assert_eq!(
        finish_lookup(snapshot, p(1), o, 2).unwrap().status,
        CreditStatus::Prepared
    );
}
#[test]
fn own_revoke_allows_only_fundless_intent_and_keeps_proof_revoked() {
    setup();
    let challenge = begin_link(p(1), vec![1; 16], 0).unwrap();
    let proof = consume_link(p(9), challenge.challenge, p(2), 1).unwrap();
    let mut o = offer();
    o.link_generation = proof.challenge.generation;
    let snapshot = lookup_snapshot(p(1), &o.operation).unwrap();
    let fence = revoke(p(1)).unwrap();
    assert_eq!(
        finish_lookup(snapshot, p(1), o.clone(), 2).unwrap().status,
        CreditStatus::Prepared
    );
    assert!(o.link_generation <= fence.through_generation);
    assert_eq!(crate::state::State.balance(&p(1).to_text()).unwrap(), 0);
    assert_eq!(ack_link(p(9), proof), Err(Error::Conflict));
    assert_eq!(
        receive(p(3), o, 3, 100, |_| panic!("untrusted send")),
        Err(Error::Unauthorized)
    );
}

#[test]
fn expired_fee_lease_releases_identity_without_late_overwrite() {
    setup();
    let o = offer();
    let flight = fee_flight(p(1), o.operation.clone());
    let now = 120_000_000_001;
    assert_eq!(
        prepare(p(1), p(9), o.clone(), now).unwrap().status,
        CreditStatus::Prepared
    );
    let raw = raw_record(p(1), &o.operation);
    assert_eq!(finish_quote(&flight, Ok(1), now), Err(Error::Expired));
    assert_flight_cleaned();
    assert_eq!(raw_record(p(1), &o.operation), raw);
}
#[test]
fn upgrade_invalidates_fee_lease_before_same_identity_bridge_admission() {
    setup();
    let flight = fee_flight(p(1), vec![7; 16]);
    crate::state::initialize().unwrap();
    let challenge = begin_link(p(1), vec![7; 16], 2).unwrap();
    let raw = raw_record(p(1), &[7; 16]);
    assert_eq!(finish_quote(&flight, Ok(1), 3), Err(Error::Expired));
    assert_flight_cleaned();
    assert_eq!(raw_record(p(1), &[7; 16]), raw);
    assert_eq!(
        inspect_link(p(9), challenge.challenge, 4)
            .unwrap()
            .vault_owner,
        p(1)
    );
}
#[test]
fn another_wallet_fee_lease_does_not_reserve_this_wallet_identity() {
    setup();
    let o = offer();
    let flight = fee_flight(p(3), o.operation.clone());
    prepare(p(1), p(9), o.clone(), 2).unwrap();
    assert!(finish_quote(&flight, Ok(1), 3).is_ok());
    assert_eq!(status(p(9), o, 4).unwrap().status, CreditStatus::Prepared);
}

#[test]
fn fee_callback_preserves_existing_normal_payment_and_commits_lease_cleanup() {
    setup();
    let flight = fee_flight(p(1), vec![7; 16]);
    // Seed an ordinary completed quote with the same immutable payment tuple.
    let mut payment: crate::funding::Payment =
        serde_json::from_value(serde_json::to_value(&flight).unwrap()["payment"].clone()).unwrap();
    payment.fee = 123;
    let raw = serde_json::to_string(&payment).unwrap();
    transaction(|db| {
        db.execute(
            "INSERT INTO payments(wallet,operation,record,expires) VALUES(?1,?2,?3,?4)",
            params![p(1).to_text(), vec![7u8; 16], raw, 300i64],
        )
        .unwrap();
        Ok(())
    })
    .unwrap();
    assert_eq!(finish_quote(&flight, Ok(1), 3), Err(Error::Conflict));
    assert_flight_cleaned();
    assert_eq!(raw_record(p(1), &[7; 16]), raw);
    transaction(|db| {
        assert_eq!(
            crate::funding::all_payments(db)?.collect::<Result<Vec<_>>>()?,
            vec![payment]
        );
        Ok(())
    })
    .unwrap();
}
