//! Authenticated funding endpoints and async orchestration.
use super::ledger::require_ledger;
use super::{
    FundingConfig, Payment, PurchaseRequest, QuoteAdmission, Status, admit_quote, auth,
    begin_payment, complete_payment, finish_quote, ledger, load, reconciliation, save, transaction,
};
use candid::Principal;
use kinic_sqlite_compat::{self as sql, OptionalExtension, params};
use vault_types::Error;

fn validate_funding_config(config: &FundingConfig) -> vault_types::Result<()> {
    auth(config.ledger)?;
    require_ledger(config.ledger)?;
    auth(config.recipient)?;
    if config.cycles_per_kinic == 0 || config.cycles_per_kinic > i64::MAX as u64 {
        return Err(Error::InvalidInput);
    }
    Ok(())
}

pub(super) fn load_funding_config(
    db: &sql::Connection,
) -> vault_types::Result<Option<FundingConfig>> {
    let raw: Option<String> = db
        .query_row(
            "SELECT value FROM global_settings WHERE key='funding'",
            params![],
            |r| sql::row_get(r, 0),
        )
        .optional()
        .map_err(|_| Error::Storage)?;
    let Some(raw) = raw else {
        return Ok(None);
    };
    let config: Option<FundingConfig> = serde_json::from_str(&raw).map_err(|_| Error::Storage)?;
    if let Some(config) = &config {
        validate_funding_config(config)?;
    }
    Ok(config)
}

#[ic_cdk::update]
fn set_funding_config(config: Option<FundingConfig>) -> vault_types::Result<()> {
    if !ic_cdk::api::is_controller(&ic_cdk::api::msg_caller()) {
        return Err(Error::Unauthorized);
    }
    if let Some(config) = &config {
        validate_funding_config(config)?;
    }
    transaction(|db| {
        db.execute("INSERT INTO global_settings(key,value) VALUES('funding',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![serde_json::to_string(&config).map_err(|_|Error::Storage)?]).map_err(|_|Error::Storage)?;
        Ok(())
    })
}

#[ic_cdk::query]
pub(super) fn get_funding_config() -> vault_types::Result<Option<FundingConfig>> {
    crate::state::read(load_funding_config)
}

#[ic_cdk::query]
fn account_balance() -> vault_types::Result<u64> {
    let caller = ic_cdk::api::msg_caller();
    auth(caller)?;
    crate::state::State.balance(&caller.to_text())
}
#[ic_cdk::query]
fn payment_status(operation: Vec<u8>) -> vault_types::Result<Option<Payment>> {
    payment_status_for(ic_cdk::api::msg_caller(), &operation, crate::now_nanos())
}

pub(super) fn payment_status_for(
    caller: Principal,
    operation: &[u8],
    now: u64,
) -> vault_types::Result<Option<Payment>> {
    auth(caller)?;
    if operation.len() != 16 {
        return Err(Error::InvalidInput);
    }
    crate::state::read(|db| Ok(load(db, caller, operation)?.map(|p| p.with_effective_status(now))))
}

/// The beneficiary reads a payment funded by an external wallet without that wallet's signature.
#[ic_cdk::query]
fn beneficiary_payment_status(
    wallet: Principal,
    operation: Vec<u8>,
) -> vault_types::Result<Option<Payment>> {
    beneficiary_payment_status_for(
        ic_cdk::api::msg_caller(),
        wallet,
        &operation,
        crate::now_nanos(),
    )
}

pub(super) fn beneficiary_payment_status_for(
    caller: Principal,
    wallet: Principal,
    operation: &[u8],
    now: u64,
) -> vault_types::Result<Option<Payment>> {
    auth(caller)?;
    Ok(payment_status_for(wallet, operation, now)?.filter(|p| p.request.beneficiary == caller))
}
#[ic_cdk::update]
async fn quote_purchase(request: PurchaseRequest) -> vault_types::Result<Payment> {
    let caller = ic_cdk::api::msg_caller();
    auth(caller)?;
    auth(request.beneficiary)?;
    if request.operation.len() != 16 {
        return Err(Error::InvalidInput);
    }
    if let Some(p) = transaction(|db| load(db, caller, &request.operation))? {
        return if p.request == request {
            Ok(p)
        } else {
            Err(Error::Conflict)
        };
    }
    let config = transaction(load_funding_config)?.ok_or(Error::Unauthorized)?;
    let flight = match admit_quote(caller, request, config, crate::now_nanos())? {
        QuoteAdmission::Existing(payment) => return Ok(payment),
        QuoteAdmission::Fee(flight) => flight,
    };
    let fee = ledger::fee(flight.payment.config.ledger).await;
    finish_quote(&flight, fee, crate::now_nanos())
}
#[ic_cdk::update]
async fn pay_purchase(operation: Vec<u8>) -> vault_types::Result<Payment> {
    let caller = ic_cdk::api::msg_caller();
    auth(caller)?;
    pay_purchase_as(caller, operation, None).await
}

/// The beneficiary submits a quote its payer signed. The payer's quote fixes the
/// amount, recipient and beneficiary, and its ICRC-2 allowance bounds the debit,
/// so the payer does not need to sign this dispatch as well.
#[ic_cdk::update]
async fn beneficiary_pay_purchase(
    wallet: Principal,
    operation: Vec<u8>,
) -> vault_types::Result<Payment> {
    let caller = ic_cdk::api::msg_caller();
    auth(caller)?;
    pay_purchase_as(wallet, operation, Some(caller)).await
}

pub(super) fn payable_ledger(
    wallet: Principal,
    operation: &[u8],
    beneficiary: Option<Principal>,
) -> vault_types::Result<Principal> {
    auth(wallet)?;
    if operation.len() != 16 {
        return Err(Error::InvalidInput);
    }
    transaction(|db| {
        let p = load(db, wallet, operation)?.ok_or(Error::NotFound)?;
        // Another principal cannot learn whether this wallet's operation exists.
        if beneficiary.is_some_and(|caller| p.request.beneficiary != caller) {
            return Err(Error::NotFound);
        }
        Ok(p.config.ledger)
    })
}

async fn pay_purchase_as(
    caller: Principal,
    operation: Vec<u8>,
    beneficiary: Option<Principal>,
) -> vault_types::Result<Payment> {
    let ledger = payable_ledger(caller, &operation, beneficiary)?;
    require_ledger(ledger)?;
    let p = begin_payment(caller, &operation, crate::now_nanos())?;
    // Persist the history lower bound and spender before the first possible debit.
    // An existing immutable snapshot is retained for byte-for-byte retries.
    let p = if p.reconciliation.is_none() {
        reconciliation::begin_preparation(&p)?
    } else {
        p
    };
    let start = match &p.reconciliation {
        Some(scan) => scan.start,
        None => match reconciliation::ledger_tip(p.config.ledger).await {
            Ok(start) => start,
            Err(_) => return reconciliation::finish_preparation(&p),
        },
    };
    let p = reconciliation::prepare_dispatch(&p, ic_cdk::api::canister_self(), start)?;
    let outcome = ledger::transfer_from(&p).await;
    complete_payment(&p, outcome)
}

#[ic_cdk::query]
fn list_payments() -> vault_types::Result<Vec<Payment>> {
    list_payments_for(ic_cdk::api::msg_caller(), crate::now_nanos())
}

/// The wallet's 16 most recent payments, keeping only those whose beneficiary is the caller.
#[ic_cdk::query]
fn beneficiary_payments(wallet: Principal) -> vault_types::Result<Vec<Payment>> {
    beneficiary_payments_for(ic_cdk::api::msg_caller(), wallet, crate::now_nanos())
}

pub(super) fn beneficiary_payments_for(
    caller: Principal,
    wallet: Principal,
    now: u64,
) -> vault_types::Result<Vec<Payment>> {
    auth(caller)?;
    let mut payments = list_payments_for(wallet, now)?;
    payments.retain(|p| p.request.beneficiary == caller);
    Ok(payments)
}

pub(super) fn list_payments_for(caller: Principal, now: u64) -> vault_types::Result<Vec<Payment>> {
    auth(caller)?;
    crate::state::read(|db| {
        let mut statement = db
            .prepare("SELECT record FROM payments WHERE wallet=?1 ORDER BY expires DESC LIMIT 16")
            .map_err(|_| Error::Storage)?;
        let rows: Vec<String> = sql::query_map(&mut statement, params![caller.to_text()], |r| {
            sql::row_get(r, 0)
        })
        .map_err(|_| Error::Storage)?;
        rows.into_iter()
            .filter_map(|r| match crate::bridge::decode(&r) {
                Ok(Some(_)) => None,
                Err(error) => Some(Err(error)),
                Ok(None) => Some(
                    serde_json::from_str::<Payment>(&r)
                        .map(|payment| payment.with_effective_status(now))
                        .map_err(|_| Error::Storage),
                ),
            })
            .collect()
    })
}
#[ic_cdk::update]
fn cancel_quote(operation: Vec<u8>) -> vault_types::Result<Payment> {
    cancel_quote_for(ic_cdk::api::msg_caller(), &operation)
}

/// The beneficiary withdraws an unpaid quote its payer signed. This never moves funds.
#[ic_cdk::update]
fn beneficiary_cancel_quote(wallet: Principal, operation: Vec<u8>) -> vault_types::Result<Payment> {
    require_beneficiary(wallet, &operation, ic_cdk::api::msg_caller())?;
    cancel_quote_for(wallet, &operation)
}

/// Fails with `NotFound` unless `caller` is the beneficiary of the wallet's operation,
/// so another principal cannot learn whether that operation exists.
pub(super) fn require_beneficiary(
    wallet: Principal,
    operation: &[u8],
    caller: Principal,
) -> vault_types::Result<()> {
    auth(caller)?;
    payable_ledger(wallet, operation, Some(caller)).map(|_| ())
}

pub(super) fn cancel_quote_for(
    caller: Principal,
    operation: &[u8],
) -> vault_types::Result<Payment> {
    auth(caller)?;
    if operation.len() != 16 {
        return Err(Error::InvalidInput);
    }
    transaction(|db| {
        let mut p = load(db, caller, operation)?.ok_or(Error::NotFound)?;
        if !matches!(p.status, Status::Quoted) {
            return Err(Error::Conflict);
        }
        p.status = Status::Expired;
        save(db, &p)?;
        Ok(p)
    })
}
