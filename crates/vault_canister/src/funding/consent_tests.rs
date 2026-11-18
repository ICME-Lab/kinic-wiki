use super::consent::*;
use super::*;
use candid::{Encode, encode_args};
use std::collections::HashMap;

const CREATED: u64 = 1_000_000_000;
const DEADLINE: u64 = 301_000_000_000;

fn principal(n: u8) -> Principal {
    Principal::from_slice(&[n])
}

fn config() -> FundingConfig {
    FundingConfig {
        ledger: Principal::from_text("73mez-iiaaa-aaaaq-aaasq-cai").unwrap(),
        recipient: principal(44),
        cycles_per_kinic: 1_000_000_000,
    }
}

fn purchase(operation: u8) -> PurchaseRequest {
    PurchaseRequest {
        operation: vec![operation; 16],
        beneficiary: principal(2),
        amount_e8s: 123_456_789,
        min_credits: 1,
        created_at_time: CREATED,
    }
}

fn configure(config: Option<FundingConfig>) {
    transaction(|db| {
        db.execute(
            "INSERT OR REPLACE INTO global_settings(key,value) VALUES('funding',?1)",
            params![serde_json::to_string(&config).unwrap()],
        )
        .unwrap();
        Ok(())
    })
    .unwrap();
}

fn consent(
    caller: Principal,
    now: u64,
    method: &str,
    arg: Vec<u8>,
) -> Icrc21ConsentMessageResponse {
    consent_for(
        caller,
        principal(3),
        now,
        Icrc21ConsentMessageRequest {
            arg,
            method: method.into(),
            user_preferences: Icrc21ConsentMessageSpec {
                metadata: Icrc21ConsentMessageMetadata {
                    language: "ja".into(),
                    utc_offset_minutes: Some(540),
                },
                device_spec: Some(Icrc21DeviceSpec::FieldsDisplay),
            },
        },
    )
}

fn message(response: Icrc21ConsentMessageResponse) -> String {
    let Icrc21ConsentMessageResponse::Ok(info) = response else {
        panic!("expected consent message, got {response:?}");
    };
    assert_eq!(info.metadata.language, "en");
    assert_eq!(info.metadata.utc_offset_minutes, None);
    let Icrc21ConsentMessage::GenericDisplayMessage(message) = info.consent_message;
    assert!(message.len() <= 1024);
    message
}

fn unavailable(response: Icrc21ConsentMessageResponse, expected: &str) {
    let Icrc21ConsentMessageResponse::Err(Icrc21Error::ConsentMessageUnavailable(info)) = response
    else {
        panic!("expected unavailable consent, got {response:?}");
    };
    assert!(info.description.contains(expected), "{}", info.description);
}

fn unsupported(response: Icrc21ConsentMessageResponse) -> String {
    let Icrc21ConsentMessageResponse::Err(Icrc21Error::UnsupportedCanisterCall(info)) = response
    else {
        panic!("expected unsupported call, got {response:?}");
    };
    info.description
}

fn financial_writes() -> i64 {
    transaction(|db| {
        Ok(db
            .query_row("SELECT total_changes()", [], |row| row.get(0))
            .unwrap())
    })
    .unwrap()
}

#[test]
fn public_config_reflects_only_enabled_valid_funding_configuration() {
    crate::state::initialize().unwrap();
    assert_eq!(api::get_funding_config(), Ok(None));
    configure(Some(config()));
    assert_eq!(api::get_funding_config(), Ok(Some(config())));
    configure(None);
    assert_eq!(api::get_funding_config(), Ok(None));
}

#[cfg(not(feature = "synthetic-funding-test-only"))]
#[test]
fn discovery_rejects_a_non_pinned_production_ledger() {
    crate::state::initialize().unwrap();
    configure(Some(FundingConfig {
        ledger: principal(9),
        ..config()
    }));
    assert_eq!(api::get_funding_config(), Err(Error::Unauthorized));
}

#[test]
fn quote_and_pay_consent_explain_the_payer_beneficiary_and_exact_cost() {
    crate::state::initialize().unwrap();
    let wallet = principal(1);
    let request = purchase(7);
    let original_config = config();
    configure(Some(original_config.clone()));
    let before_quote_consent = financial_writes();
    let quote = message(consent(
        wallet,
        CREATED,
        "quote_purchase",
        Encode!(&request).unwrap(),
    ));
    for principal in [
        wallet,
        request.beneficiary,
        original_config.ledger,
        original_config.recipient,
        principal(3),
    ] {
        assert!(quote.contains(&principal.to_text()));
    }
    assert!(quote.contains("`1.23456789` KINIC"));
    assert!(quote.contains("`1234567890` cycles"));
    assert!(quote.contains("does not debit funds"));
    assert!(quote.contains("exact ledger transfer fee in the returned quote"));
    assert_eq!(financial_writes(), before_quote_consent);
    assert!(api::list_payments_for(wallet, CREATED).unwrap().is_empty());

    let payment = record_quote(
        wallet,
        request.clone(),
        original_config.clone(),
        10_000,
        CREATED,
    )
    .unwrap();
    configure(Some(FundingConfig {
        recipient: principal(5),
        cycles_per_kinic: 500_000_000,
        ..original_config.clone()
    }));
    let before_pay_consent = financial_writes();
    let pay = message(consent(
        wallet,
        DEADLINE,
        "pay_purchase",
        Encode!(&request.operation).unwrap(),
    ));
    for principal in [
        wallet,
        request.beneficiary,
        original_config.ledger,
        original_config.recipient,
        principal(3),
    ] {
        assert!(pay.contains(&principal.to_text()));
    }
    assert!(!pay.contains(&principal(5).to_text()));
    assert!(pay.contains("`1.23456789` KINIC"));
    assert!(pay.contains("`0.0001` KINIC"));
    assert!(pay.contains("`1.23466789` KINIC"));
    assert!(pay.contains("`1234567890` cycles"));
    assert_eq!(
        api::payment_status_for(wallet, &request.operation, DEADLINE),
        Ok(Some(payment))
    );
    assert_eq!(financial_writes(), before_pay_consent);
    assert_eq!(crate::state::State.balance(&wallet.to_text()), Ok(0));
    assert_eq!(
        crate::state::State.balance(&request.beneficiary.to_text()),
        Ok(0)
    );
}

#[test]
fn only_the_payer_owns_the_operation_and_only_the_beneficiary_receives_credit() {
    crate::state::initialize().unwrap();
    let wallet = principal(1);
    let request = purchase(8);
    let beneficiary = request.beneficiary;
    let operation = &request.operation;
    record_quote(wallet, request.clone(), config(), 10_000, CREATED).unwrap();
    let before = financial_writes();
    for caller in [beneficiary, principal(6)] {
        assert_eq!(
            api::payment_status_for(caller, operation, CREATED),
            Ok(None)
        );
        assert_eq!(api::list_payments_for(caller, CREATED), Ok(vec![]));
        assert_eq!(
            begin_payment(caller, operation, CREATED),
            Err(Error::NotFound)
        );
        assert_eq!(
            api::cancel_quote_for(caller, operation),
            Err(Error::NotFound)
        );
        for method in ["pay_purchase", "reconcile_purchase", "cancel_quote"] {
            unavailable(
                consent(caller, CREATED, method, Encode!(operation).unwrap()),
                "Payment operation was not found",
            );
        }
    }
    assert_eq!(financial_writes(), before);
    let sent = begin_payment(wallet, operation, DEADLINE).unwrap();
    assert_eq!(sent.attempt, 1);
    let paid = complete_payment(&sent, Outcome::Paid(9)).unwrap();
    assert_eq!(paid.status, Status::Paid(9));
    assert_eq!(
        crate::state::State.balance(&beneficiary.to_text()),
        Ok(1_234_567_890)
    );
    assert_eq!(crate::state::State.balance(&wallet.to_text()), Ok(0));
}

#[test]
fn effective_expiry_changes_only_stale_quoted_reads_without_writing() {
    crate::state::initialize().unwrap();
    let wallet = principal(1);
    let quoted = record_quote(wallet, purchase(11), config(), 10_000, CREATED).unwrap();
    let inflight = record_quote(wallet, purchase(12), config(), 10_000, CREATED).unwrap();
    let unknown = record_quote(wallet, purchase(13), config(), 10_000, CREATED).unwrap();
    let paid = record_quote(wallet, purchase(14), config(), 10_000, CREATED).unwrap();
    let inflight = begin_payment(wallet, &inflight.request.operation, CREATED).unwrap();
    let unknown = begin_payment(wallet, &unknown.request.operation, CREATED).unwrap();
    let unknown = complete_payment(&unknown, Outcome::Unknown).unwrap();
    let paid = begin_payment(wallet, &paid.request.operation, CREATED).unwrap();
    let paid = complete_payment(&paid, Outcome::Paid(21)).unwrap();
    let operation = &[11; 16];
    let writes_before_reads = financial_writes();
    assert_eq!(
        api::payment_status_for(wallet, operation, DEADLINE),
        Ok(Some(quoted.clone()))
    );
    let mut expired = quoted.clone();
    expired.status = Status::Expired;
    assert_eq!(
        api::payment_status_for(wallet, operation, DEADLINE + 1),
        Ok(Some(expired.clone()))
    );
    assert_eq!(
        begin_payment(wallet, operation, DEADLINE + 1),
        Err(Error::Expired)
    );
    unavailable(
        consent(
            wallet,
            DEADLINE + 1,
            "pay_purchase",
            Encode!(operation).unwrap(),
        ),
        "expired",
    );
    let list: HashMap<_, _> = api::list_payments_for(wallet, DEADLINE + 1)
        .unwrap()
        .into_iter()
        .map(|p| (p.request.operation[0], p))
        .collect();
    assert_eq!(
        list,
        HashMap::from([
            (11, expired.clone()),
            (12, inflight),
            (13, unknown),
            (14, paid)
        ])
    );
    for (id, payment) in list {
        assert_eq!(
            api::payment_status_for(wallet, &[id; 16], DEADLINE + 1),
            Ok(Some(payment))
        );
    }
    assert_eq!(
        transaction(|db| load(db, wallet, operation)),
        Ok(Some(quoted.clone()))
    );
    assert_eq!(financial_writes(), writes_before_reads);
    assert_eq!(api::cancel_quote_for(wallet, operation), Ok(expired));
}

#[test]
fn cancel_and_reconcile_consent_only_describe_existing_payment_actions() {
    crate::state::initialize().unwrap();
    let wallet = principal(1);
    let request = purchase(10);
    let payment = record_quote(wallet, request.clone(), config(), 10_000, CREATED).unwrap();
    let operation = &request.operation;
    let before = financial_writes();
    let cancel = message(consent(
        wallet,
        CREATED,
        "cancel_quote",
        Encode!(operation).unwrap(),
    ));
    assert!(cancel.contains("Cancel"));
    assert!(cancel.contains("does not debit"));
    unavailable(
        consent(
            wallet,
            CREATED,
            "reconcile_purchase",
            Encode!(operation).unwrap(),
        ),
        "cannot be reconciled",
    );
    assert_eq!(financial_writes(), before);
    assert_eq!(
        api::payment_status_for(wallet, operation, CREATED),
        Ok(Some(payment))
    );

    let sent = begin_payment(wallet, operation, CREATED).unwrap();
    let preparing = reconciliation::begin_preparation(&sent).unwrap();
    let dispatched = reconciliation::prepare_dispatch(&preparing, principal(3), 40).unwrap();
    let unknown = complete_payment(&dispatched, Outcome::Unknown).unwrap();
    let before = financial_writes();
    let scan = message(consent(
        wallet,
        DEADLINE + 1,
        "reconcile_purchase",
        Encode!(operation).unwrap(),
    ));
    assert!(scan.contains("ledger history"));
    assert!(scan.contains("does not send a new transfer"));
    assert!(scan.contains(&request.beneficiary.to_text()));
    assert_eq!(
        api::payment_status_for(wallet, operation, DEADLINE + 1),
        Ok(Some(unknown))
    );
    assert_eq!(financial_writes(), before);
}

#[test]
fn reconcile_consent_waits_for_live_preparation_through_the_exact_deadline() {
    crate::state::initialize().unwrap();
    let wallet = principal(1);
    let request = purchase(15);
    let operation = &request.operation;
    record_quote(wallet, request.clone(), config(), 10_000, CREATED).unwrap();
    let sent = begin_payment(wallet, operation, CREATED).unwrap();
    let preparing = reconciliation::begin_preparation(&sent).unwrap();
    let live_deadline = 121_000_000_000;
    let before = financial_writes();
    let preview = |now| {
        consent(
            wallet,
            now,
            "reconcile_purchase",
            Encode!(operation).unwrap(),
        )
    };
    unavailable(preview(live_deadline), "already in progress");
    assert!(message(preview(live_deadline + 1)).contains("preparation was interrupted"));
    assert_eq!(
        api::payment_status_for(wallet, operation, live_deadline + 1),
        Ok(Some(preparing))
    );
    assert_eq!(financial_writes(), before);
}

#[test]
fn reconcile_consent_waits_for_another_operations_same_wallet_lease() {
    crate::state::initialize().unwrap();
    let wallet = principal(1);
    let make_unknown = |id| {
        let request = purchase(id);
        let operation = &request.operation;
        record_quote(wallet, request.clone(), config(), 10_000, CREATED).unwrap();
        let sent = begin_payment(wallet, operation, CREATED).unwrap();
        let preparing = reconciliation::begin_preparation(&sent).unwrap();
        let dispatched = reconciliation::prepare_dispatch(&preparing, principal(3), 40).unwrap();
        complete_payment(&dispatched, Outcome::Unknown).unwrap()
    };
    let mut active = make_unknown(16);
    let other = make_unknown(17);
    let lease_until = 181_000_000_000;
    let scan = active.reconciliation.as_mut().unwrap();
    scan.lease = 1;
    scan.lease_until = lease_until;
    scan.lease_generation = active.generation;
    transaction(|db| save(db, &active)).unwrap();
    let before = financial_writes();
    let preview = |now| {
        consent(
            wallet,
            now,
            "reconcile_purchase",
            Encode!(&other.request.operation).unwrap(),
        )
    };
    unavailable(preview(lease_until - 1), "already in progress");
    assert!(message(preview(lease_until)).contains("ledger history"));
    assert_eq!(
        api::payment_status_for(wallet, &active.request.operation, lease_until),
        Ok(Some(active))
    );
    assert_eq!(
        api::payment_status_for(wallet, &other.request.operation, lease_until),
        Ok(Some(other))
    );
    assert_eq!(financial_writes(), before);
}

#[test]
fn pay_consent_allows_the_last_attempt_and_rejects_exhausted_payments() {
    crate::state::initialize().unwrap();
    let wallet = principal(1);
    let request = purchase(18);
    let operation = &request.operation;
    record_quote(wallet, request.clone(), config(), 10_000, CREATED).unwrap();
    let sent = begin_payment(wallet, operation, CREATED).unwrap();
    let preparing = reconciliation::begin_preparation(&sent).unwrap();
    let dispatched = reconciliation::prepare_dispatch(&preparing, principal(3), 40).unwrap();
    let mut unknown = complete_payment(&dispatched, Outcome::Unknown).unwrap();
    unknown.attempt = 99;
    transaction(|db| save(db, &unknown)).unwrap();
    let preview = || consent(wallet, CREATED, "pay_purchase", Encode!(operation).unwrap());
    let before = financial_writes();
    assert!(message(preview()).contains("Resubmit the same Vault payment"));
    assert_eq!(financial_writes(), before);
    let last = begin_payment(wallet, operation, CREATED).unwrap();
    assert_eq!(last.attempt, 100);
    let exhausted = complete_payment(&last, Outcome::Unknown).unwrap();
    let before = financial_writes();
    unavailable(preview(), "funding limit");
    assert_eq!(
        begin_payment(wallet, operation, CREATED),
        Err(Error::QuotaExceeded)
    );
    assert_eq!(
        api::payment_status_for(wallet, operation, CREATED),
        Ok(Some(exhausted))
    );
    assert_eq!(financial_writes(), before);
}

#[test]
fn read_consent_explains_disclosure_without_returning_any_data() {
    crate::state::initialize().unwrap();
    let before = financial_writes();
    let wallet = principal(1);
    let empty = encode_args(()).unwrap();
    for (method, argument, expected) in [
        (
            "get_funding_config",
            empty.clone(),
            "public funding configuration",
        ),
        (
            "account_balance",
            empty.clone(),
            "your Vault prepaid cycle balance",
        ),
        (
            "list_payments",
            empty,
            "up to 16 of your Vault payment records",
        ),
        (
            "payment_status",
            Encode!(&vec![9_u8; 16]).unwrap(),
            "your Vault payment record for this operation",
        ),
    ] {
        let result = message(consent(wallet, CREATED, method, argument));
        assert!(result.contains(expected), "{result}");
        assert!(!result.contains(&wallet.to_text()));
    }
    assert_eq!(financial_writes(), before);
}

#[test]
fn consent_rejects_malformed_or_extended_arguments_without_echoing_input() {
    crate::state::initialize().unwrap();
    let wallet = principal(1);
    let request = purchase(7);
    let encoded = Encode!(&request).unwrap();
    let mut trailing = encoded.clone();
    trailing.push(0);
    #[derive(candid::CandidType)]
    struct ExtendedQuote {
        operation: Vec<u8>,
        beneficiary: Principal,
        amount_e8s: u64,
        min_credits: u64,
        created_at_time: u64,
        subaccount: Vec<u8>,
    }
    let extended = Encode!(&ExtendedQuote {
        operation: request.operation.clone(),
        beneficiary: request.beneficiary,
        amount_e8s: request.amount_e8s,
        min_credits: request.min_credits,
        created_at_time: request.created_at_time,
        subaccount: vec![1; 32],
    })
    .unwrap();
    for arg in [
        Vec::new(),
        b"PRIVATE PAYLOAD".to_vec(),
        Encode!(&123_u64).unwrap(),
        Encode!(&request, &()).unwrap(),
        trailing,
        extended,
    ] {
        let description = unsupported(consent(wallet, CREATED, "quote_purchase", arg));
        assert!(
            description.contains("Invalid Candid arguments"),
            "{description}"
        );
        assert!(!description.contains("PRIVATE"));
    }
    for (method, arg) in [
        ("payment_status", Encode!(&vec![9_u8; 15]).unwrap()),
        ("list_payments", Encode!(&()).unwrap()),
        ("get_funding_config", vec![0; 1025]),
    ] {
        assert!(unsupported(consent(wallet, CREATED, method, arg)).len() < 128);
    }
    for method in [
        "derive_key",
        "set_funding_config",
        "list_documents",
        "PRIVATE METHOD",
    ] {
        let description = unsupported(consent(wallet, CREATED, method, encoded.clone()));
        assert!(!description.contains(method));
    }
}

#[test]
fn quote_consent_reports_disabled_config_and_rejects_invalid_or_expired_terms() {
    crate::state::initialize().unwrap();
    let wallet = principal(1);
    let request = purchase(7);
    unavailable(
        consent(
            wallet,
            CREATED,
            "quote_purchase",
            Encode!(&request).unwrap(),
        ),
        "funding is unavailable",
    );
    configure(Some(config()));
    unavailable(
        consent(
            wallet,
            DEADLINE + 1,
            "quote_purchase",
            Encode!(&request).unwrap(),
        ),
        "expired",
    );
    let impossible_quote = PurchaseRequest {
        min_credits: u64::MAX,
        ..request.clone()
    };
    assert!(
        unsupported(consent(
            wallet,
            CREATED,
            "quote_purchase",
            Encode!(&impossible_quote).unwrap()
        ))
        .contains("Invalid funding arguments")
    );
    unavailable(
        consent(
            Principal::anonymous(),
            CREATED,
            "quote_purchase",
            Encode!(&request).unwrap(),
        ),
        "authenticated wallet",
    );
    assert!(matches!(
        consent(
            Principal::anonymous(),
            CREATED,
            "get_funding_config",
            encode_args(()).unwrap()
        ),
        Icrc21ConsentMessageResponse::Ok(_)
    ));
}
