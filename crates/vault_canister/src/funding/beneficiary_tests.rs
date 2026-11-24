use super::api::{
    beneficiary_payment_status_for, beneficiary_payments_for, cancel_quote_for, payable_ledger,
    require_beneficiary,
};
use super::*;

const NOW: u64 = 1_000_000_000;

fn principal(n: u8) -> Principal {
    Principal::from_slice(&[n])
}

fn quote(wallet: u8, beneficiary: u8, operation: u8) -> Payment {
    let config = FundingConfig {
        ledger: principal(3),
        recipient: principal(4),
        cycles_per_kinic: 1_000_000_000,
    };
    let request = PurchaseRequest {
        operation: vec![operation; 16],
        beneficiary: principal(beneficiary),
        amount_e8s: 100_000_000,
        min_credits: 1,
        created_at_time: NOW,
    };
    record_quote(principal(wallet), request, config, 10, NOW).unwrap()
}

#[test]
fn beneficiary_reads_only_payments_made_to_it() {
    crate::state::initialize().unwrap();
    let own = quote(31, 32, 1);
    let other = quote(31, 33, 2);
    let status = |caller, operation: &Payment| {
        beneficiary_payment_status_for(
            principal(caller),
            principal(31),
            &operation.request.operation,
            NOW,
        )
        .unwrap()
    };
    assert_eq!(status(32, &own), Some(own.clone()));
    assert_eq!(status(32, &other), None);
    assert_eq!(status(33, &own), None);
    // The wallet's own principal is not this payment's beneficiary.
    assert_eq!(status(31, &own), None);

    let listed = beneficiary_payments_for(principal(32), principal(31), NOW).unwrap();
    assert_eq!(listed, vec![own.clone()]);
    assert!(
        beneficiary_payments_for(principal(34), principal(31), NOW)
            .unwrap()
            .is_empty()
    );
    for anonymous in [
        beneficiary_payments_for(Principal::anonymous(), principal(31), NOW).err(),
        beneficiary_payment_status_for(
            Principal::anonymous(),
            principal(31),
            &own.request.operation,
            NOW,
        )
        .err(),
    ] {
        assert_eq!(anonymous, Some(Error::Unauthorized));
    }
    assert_eq!(
        beneficiary_payment_status_for(principal(32), principal(31), &[1; 15], NOW),
        Err(Error::InvalidInput)
    );
}

#[test]
fn only_the_wallet_or_its_beneficiary_can_submit_a_signed_quote() {
    crate::state::initialize().unwrap();
    let payment = quote(41, 42, 5);
    let operation = &payment.request.operation;
    assert_eq!(
        payable_ledger(principal(41), operation, None),
        Ok(principal(3))
    );
    assert_eq!(
        payable_ledger(principal(41), operation, Some(principal(42))),
        Ok(principal(3))
    );
    assert_eq!(
        payable_ledger(principal(41), operation, Some(principal(43))),
        Err(Error::NotFound)
    );
    // A beneficiary cannot use its own principal as the wallet for another payer's quote.
    assert_eq!(
        payable_ledger(principal(42), operation, Some(principal(42))),
        Err(Error::NotFound)
    );
    assert_eq!(
        payable_ledger(Principal::anonymous(), operation, Some(principal(42))),
        Err(Error::Unauthorized)
    );
    assert_eq!(
        payable_ledger(principal(41), &[5; 15], Some(principal(42))),
        Err(Error::InvalidInput)
    );
}

#[test]
fn only_the_beneficiary_can_act_on_its_payers_quote() {
    crate::state::initialize().unwrap();
    let payment = quote(51, 52, 6);
    let operation = &payment.request.operation;
    assert_eq!(
        require_beneficiary(principal(51), operation, principal(52)),
        Ok(())
    );
    for caller in [principal(51), principal(53)] {
        assert_eq!(
            require_beneficiary(principal(51), operation, caller),
            Err(Error::NotFound)
        );
    }
    assert_eq!(
        require_beneficiary(principal(51), operation, Principal::anonymous()),
        Err(Error::Unauthorized)
    );
    assert_eq!(
        require_beneficiary(principal(51), &[6; 16][..15], principal(52)),
        Err(Error::InvalidInput)
    );
    // The guarded cancellation expires the quote without moving funds.
    let cancelled = cancel_quote_for(principal(51), operation).unwrap();
    assert_eq!(cancelled.status, Status::Expired);
}

#[test]
fn a_bridge_row_under_the_same_key_reads_as_absent_to_a_beneficiary() {
    // The bridge and funding share the payments key space; the payer sees Conflict.
    crate::bridge::link_row_for_test(principal(61), vec![9; 16]);
    assert_eq!(
        beneficiary_payment_status_for(principal(62), principal(61), &[9; 16], NOW),
        Ok(None)
    );
    assert_eq!(
        payable_ledger(principal(61), &[9; 16], Some(principal(62))),
        Err(Error::NotFound)
    );
    assert_eq!(
        require_beneficiary(principal(61), &[9; 16], principal(62)),
        Err(Error::NotFound)
    );
    assert_eq!(
        payable_ledger(principal(61), &[9; 16], None),
        Err(Error::Conflict)
    );
    assert_eq!(
        beneficiary_payments_for(principal(62), principal(61), NOW),
        Ok(vec![])
    );
}
