//! Durable ICRC-2 quotes. Only the authenticated wallet can debit its own allowance.
use crate::state::transaction;
use candid::{CandidType, Nat, Principal};
use kinic_sqlite_compat::{self as sql, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use vault_types::{Error, Result};
/// Certified build provenance, independent of controller configuration and origin selection.
pub const FUNDING_MODE: &str = if cfg!(feature = "synthetic-funding-test-only") {
    "synthetic-test-only"
} else {
    "unavailable"
};
fn require_synthetic_funding() -> Result<()> {
    if cfg!(feature = "synthetic-funding-test-only") {
        Ok(())
    } else {
        Err(Error::Unauthorized)
    }
}
#[derive(Clone, Debug, CandidType, Serialize, Deserialize, PartialEq)]
pub struct FundingConfig {
    pub ledger: Principal,
    pub recipient: Principal,
    pub cycles_per_kinic: u64,
}
#[derive(Clone, Debug, CandidType, Serialize, Deserialize, PartialEq)]
pub struct PurchaseRequest {
    pub operation: Vec<u8>,
    pub beneficiary: Principal,
    pub amount_e8s: u64,
    pub min_credits: u64,
    pub created_at_time: u64,
}
#[derive(Clone, Debug, CandidType, Serialize, Deserialize, PartialEq)]
pub enum Status {
    Quoted,
    InFlight,
    Unknown,
    Paid(u64),
    BadFee(u64),
    InsufficientFunds,
    InsufficientAllowance,
    Expired,
    Rejected,
}
#[derive(Clone, Debug, CandidType, Serialize, Deserialize, PartialEq)]
pub struct Payment {
    pub wallet: Principal,
    pub request: PurchaseRequest,
    pub config: FundingConfig,
    pub fee: u64,
    pub credits: u64,
    pub memo: Vec<u8>,
    pub created_at_time: u64,
    pub status: Status,
    pub generation: i64,
    pub uncertain: bool,
    pub attempt: u64,
    pub sent_at: u64,
}
fn auth(p: Principal) -> Result<()> {
    if p == Principal::anonymous() || p == Principal::management_canister() {
        Err(Error::Unauthorized)
    } else {
        Ok(())
    }
}
fn load(db: &sql::Connection, w: Principal, id: &[u8]) -> Result<Option<Payment>> {
    let raw: Option<String> = db
        .query_row(
            "SELECT record FROM payments WHERE wallet=?1 AND operation=?2",
            params![w.to_text(), id],
            |r| sql::row_get(r, 0),
        )
        .optional()
        .map_err(|_| Error::Storage)?;
    raw.map(|v| serde_json::from_str(&v).map_err(|_| Error::Storage))
        .transpose()
}
fn payment_size(p: &Payment) -> Result<usize> {
    let raw = serde_json::to_string(p).map_err(|_| Error::Storage)?;
    vault_types::capacity::row_size(
        &[
            p.wallet.to_text().len(),
            p.request.operation.len(),
            raw.len(),
        ],
        1,
    )
    .ok_or(Error::QuotaExceeded)
}
/// Check the maximum-width callback, not merely the smaller Quoted/InFlight row.
/// All receipt variants are typed; ledger free text is deliberately never stored.
fn validate_receipts(p: &Payment) -> Result<()> {
    if p.request.operation.len() != 16 || p.memo.len() != 32 {
        return Err(Error::InvalidInput);
    }
    let mut widest = p.clone();
    widest.fee = u64::MAX;
    widest.credits = u64::MAX;
    widest.created_at_time = u64::MAX;
    widest.request.amount_e8s = u64::MAX;
    widest.request.min_credits = u64::MAX;
    widest.request.created_at_time = u64::MAX;
    widest.config.cycles_per_kinic = u64::MAX;
    widest.generation = i64::MIN;
    widest.attempt = u64::MAX;
    widest.sent_at = u64::MAX;
    widest.uncertain = false;
    // JSON encodes bytes as decimal arrays, so reserve the largest byte width too.
    widest.memo = vec![255; 32];
    widest.request.operation = vec![255; 16];
    for status in [
        Status::Quoted,
        Status::InFlight,
        Status::Unknown,
        Status::Paid(u64::MAX),
        Status::BadFee(u64::MAX),
        Status::InsufficientFunds,
        Status::InsufficientAllowance,
        Status::Expired,
        Status::Rejected,
    ] {
        widest.status = status;
        if payment_size(&widest)? > vault_types::capacity::PAYMENT_ROW {
            return Err(Error::QuotaExceeded);
        }
    }
    Ok(())
}
fn save(db: &sql::Connection, p: &Payment) -> Result<()> {
    validate_receipts(p)?;
    let expiry = if matches!(p.status, Status::Quoted) {
        p.created_at_time / 1_000_000_000 + 300
    } else if matches!(p.status, Status::InFlight | Status::Unknown) {
        i64::MAX as u64
    } else {
        p.created_at_time / 1_000_000_000 + 7 * 86400
    };
    db.execute("INSERT INTO payments(wallet,operation,record,expires) VALUES(?1,?2,?3,?4) ON CONFLICT(wallet,operation) DO UPDATE SET record=excluded.record,expires=excluded.expires",params![p.wallet.to_text(),p.request.operation,serde_json::to_string(p).map_err(|_|Error::Storage)?,expiry as i64]).map_err(|_|Error::Storage)?;
    Ok(())
}
fn generation(db: &sql::Connection) -> Result<i64> {
    db.query_row(
        "SELECT CAST(value AS INTEGER) FROM global_settings WHERE key='generation'",
        params![],
        |r| sql::row_get(r, 0),
    )
    .map_err(|_| Error::Storage)
}
/// A durable fee lookup occupies both payment capacity and a physical-flight slot.
/// No account is allocated until the later, authoritative transfer succeeds.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FeeFlight {
    payment: Payment,
    token: i64,
    expires: u64,
}
pub enum QuoteAdmission {
    Existing(Payment),
    Fee(FeeFlight),
}
pub fn admit_quote(
    wallet: Principal,
    request: PurchaseRequest,
    config: FundingConfig,
    now: u64,
) -> Result<QuoteAdmission> {
    auth(wallet)?;
    auth(request.beneficiary)?;
    if request.operation.len() != 16
        || request.amount_e8s == 0
        || request.amount_e8s > i64::MAX as u64
        || request.min_credits == 0
    {
        return Err(Error::InvalidInput);
    }
    transaction(|db| {
        if let Some(old) = load(db, wallet, &request.operation)? {
            return if old.request == request {
                Ok(QuoteAdmission::Existing(old))
            } else {
                Err(Error::Conflict)
            };
        }
        if request.created_at_time > now.saturating_add(60_000_000_000)
            || now.saturating_sub(request.created_at_time) > 300_000_000_000
        {
            return Err(Error::Expired);
        }
        let credits = u64::try_from(
            u128::from(request.amount_e8s) * u128::from(config.cycles_per_kinic) / 100_000_000,
        )
        .map_err(|_| Error::InvalidInput)?;
        if credits < 20_000_000 || credits < request.min_credits || credits > i64::MAX as u64 {
            return Err(Error::InvalidInput);
        }
        let generation = generation(db)?;
        let nanos = i64::try_from(now).map_err(|_| Error::InvalidInput)?;
        db.execute(
            "DELETE FROM quote_fee_flights WHERE generation<>?1 OR expires_ns<=?2",
            params![generation, nanos],
        )
        .map_err(|_| Error::Storage)?;
        db.execute(
            "DELETE FROM payments WHERE expires<?1",
            params![(now / 1_000_000_000) as i64],
        )
        .map_err(|_| Error::Storage)?;
        let (payments, owned): (i64, i64) = db
            .query_row(
                "SELECT count(*),coalesce(sum(wallet=?1),0) FROM payments",
                params![wallet.to_text()],
                |r| Ok((sql::row_get(r, 0)?, sql::row_get(r, 1)?)),
            )
            .map_err(|_| Error::Storage)?;
        let (flights, own_flights): (i64, i64) = db
            .query_row(
                "SELECT count(*),coalesce(sum(wallet=?1),0) FROM quote_fee_flights",
                params![wallet.to_text()],
                |r| Ok((sql::row_get(r, 0)?, sql::row_get(r, 1)?)),
            )
            .map_err(|_| Error::Storage)?;
        if payments + flights >= 1024 || owned + own_flights >= 16 {
            return Err(Error::QuotaExceeded);
        }
        // One caller cannot monopolize all eight physical fee calls. A 120s lease
        // exceeds the transport's 60s bounded wait; upgrades invalidate old leases.
        if flights >= 8 || own_flights >= 1 {
            return Err(Error::Busy);
        }
        let serial:i64=db.query_row("SELECT COALESCE((SELECT CAST(value AS INTEGER) FROM global_settings WHERE key='quote_fee_serial'),0)",params![],|r|sql::row_get(r,0)).map_err(|_|Error::Storage)?;
        let token = serial.checked_add(1).ok_or(Error::QuotaExceeded)?;
        db.execute("INSERT INTO global_settings(key,value) VALUES('quote_fee_serial',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![token.to_string()]).map_err(|_|Error::Storage)?;
        let mut hash = Sha256::new();
        hash.update(b"kinic-vault/payment/v1");
        hash.update(wallet.as_slice());
        hash.update(&request.operation);
        hash.update(request.created_at_time.to_be_bytes());
        let payment = Payment {
            wallet,
            request,
            config,
            fee: 0,
            credits,
            memo: hash.finalize().to_vec(),
            created_at_time: now,
            status: Status::Quoted,
            generation,
            uncertain: false,
            attempt: 0,
            sent_at: 0,
        };
        let expires = now
            .checked_add(120_000_000_000)
            .ok_or(Error::InvalidInput)?;
        let flight = FeeFlight {
            payment,
            token,
            expires,
        };
        validate_receipts(&flight.payment)?;
        let raw = serde_json::to_string(&flight).map_err(|_| Error::Storage)?;
        if vault_types::capacity::row_size(
            &[
                wallet.to_text().len(),
                flight.payment.request.operation.len(),
                raw.len(),
            ],
            3,
        )
        .ok_or(Error::QuotaExceeded)?
            > vault_types::capacity::PAYMENT_ROW
        {
            return Err(Error::QuotaExceeded);
        }
        db.execute("INSERT INTO quote_fee_flights(wallet,operation,token,generation,expires_ns,record) VALUES(?1,?2,?3,?4,?5,?6)",params![wallet.to_text(),flight.payment.request.operation,token,generation,i64::try_from(expires).map_err(|_|Error::InvalidInput)?,serde_json::to_string(&flight).map_err(|_|Error::Storage)?]).map_err(|_|Error::Storage)?;
        Ok(QuoteAdmission::Fee(flight))
    })
}
pub fn finish_quote(sent: &FeeFlight, fee: Result<u64>, now: u64) -> Result<Payment> {
    // Commit cleanup even when the external fee call failed. Returning the inner
    // error directly from the DB closure would roll back deletion of its lease.
    transaction(|db| {
        let raw: Option<String> = db
            .query_row(
                "SELECT record FROM quote_fee_flights WHERE wallet=?1 AND operation=?2",
                params![
                    sent.payment.wallet.to_text(),
                    sent.payment.request.operation
                ],
                |r| sql::row_get(r, 0),
            )
            .optional()
            .map_err(|_| Error::Storage)?;
        let Some(raw) = raw else {
            return Ok(Err(Error::Expired));
        };
        let current: FeeFlight = serde_json::from_str(&raw).map_err(|_| Error::Storage)?;
        if current.token != sent.token || current.payment.generation != sent.payment.generation {
            return Ok(Err(Error::Expired));
        }
        db.execute(
            "DELETE FROM quote_fee_flights WHERE wallet=?1 AND operation=?2 AND token=?3",
            params![
                sent.payment.wallet.to_text(),
                sent.payment.request.operation,
                sent.token
            ],
        )
        .map_err(|_| Error::Storage)?;
        if generation(db)? != current.payment.generation || current.expires <= now {
            return Ok(Err(Error::Expired));
        }
        let fee = match fee {
            Ok(fee) => fee,
            Err(error) => return Ok(Err(error)),
        };
        let mut payment = current.payment;
        payment.fee = fee;
        save(db, &payment)?;
        Ok(Ok(payment))
    })?
}
#[cfg(test)]
pub fn record_quote(
    wallet: Principal,
    request: PurchaseRequest,
    config: FundingConfig,
    fee: u64,
    now: u64,
) -> Result<Payment> {
    match admit_quote(wallet, request, config, now)? {
        QuoteAdmission::Existing(p) => Ok(p),
        QuoteAdmission::Fee(f) => finish_quote(&f, Ok(fee), now),
    }
}
pub fn begin_payment(wallet: Principal, id: &[u8], now: u64) -> Result<Payment> {
    auth(wallet)?;
    transaction(|db| {
        let mut p = load(db, wallet, id)?.ok_or(Error::NotFound)?;
        let current = generation(db)?;
        let orphan = matches!(p.status, Status::InFlight)
            && (p.generation < current || now.saturating_sub(p.sent_at) > 120_000_000_000);
        if !matches!(p.status, Status::Quoted | Status::Unknown) && !orphan {
            return Err(Error::Conflict);
        }
        // Unknown payments can only be retried byte-for-byte within ledger dedup window.
        // Beyond it the durable Unknown row requires authoritative ledger reconciliation.
        let max = if matches!(p.status, Status::Quoted) {
            300_000_000_000
        } else {
            23 * 3600 * 1_000_000_000
        };
        if now < p.created_at_time || now - p.created_at_time > max {
            return Err(Error::Expired);
        }
        crate::capacity::admit_beneficiary(db, p.request.beneficiary)?;
        validate_receipts(&p)?;
        // Reserve arithmetic capacity before the ledger can debit. Other in-flight credits and
        // possible reservation refunds count even while an account has no persisted balance row.
        let beneficiary = p.request.beneficiary.to_text();
        let balance: i64 = db
            .query_row(
                "SELECT balance_cycles FROM accounts WHERE owner=?1",
                params![beneficiary],
                |r| sql::row_get(r, 0),
            )
            .optional()
            .map_err(|_| Error::Storage)?
            .unwrap_or(0);
        let refunds:i64=db.query_row("SELECT coalesce(sum(CASE WHEN actual IS NULL THEN reserved WHEN in_flight=1 THEN actual ELSE 0 END),0) FROM vault_cycle_reservations WHERE owner=?1",params![beneficiary],|r|sql::row_get(r,0)).map_err(|_|Error::Storage)?;
        let mut capacity =
            u128::from(balance as u64) + u128::from(refunds as u64) + u128::from(p.credits);
        let mut statement = db
            .prepare("SELECT record FROM payments")
            .map_err(|_| Error::Storage)?;
        let records: Vec<String> =
            sql::query_map(&mut statement, params![], |r| sql::row_get(r, 0))
                .map_err(|_| Error::Storage)?;
        for raw in records {
            let other: Payment = serde_json::from_str(&raw).map_err(|_| Error::Storage)?;
            if other.request.beneficiary == p.request.beneficiary
                && (other.wallet != p.wallet || other.request.operation != p.request.operation)
                && matches!(other.status, Status::InFlight | Status::Unknown)
            {
                capacity += u128::from(other.credits);
            }
        }
        if capacity > i64::MAX as u128 {
            return Err(Error::QuotaExceeded);
        }
        p.uncertain |= orphan || matches!(p.status, Status::Unknown);
        p.status = Status::InFlight;
        p.generation = current;
        p.attempt = p.attempt.checked_add(1).ok_or(Error::QuotaExceeded)?;
        if p.attempt > 100 {
            return Err(Error::QuotaExceeded);
        }
        p.sent_at = now;
        save(db, &p)?;
        Ok(p)
    })
}
pub enum Outcome {
    Paid(u64),
    Unknown,
    Rejected(Status),
}
pub fn complete_payment(sent: &Payment, outcome: Outcome) -> Result<Payment> {
    transaction(|db| {
        let mut p = load(db, sent.wallet, &sent.request.operation)?.ok_or(Error::NotFound)?;
        if matches!(p.status, Status::Paid(_)) {
            return Ok(p);
        }
        if p.request != sent.request
            || p.config != sent.config
            || p.fee != sent.fee
            || p.memo != sent.memo
            || p.created_at_time != sent.created_at_time
            || p.generation != sent.generation
            || p.attempt != sent.attempt
            || !matches!(p.status, Status::InFlight)
        {
            return Err(Error::Conflict);
        }
        p.status = match outcome {
            Outcome::Paid(block) => {
                let owner = p.request.beneficiary.to_text();
                let balance: i64 = db
                    .query_row(
                        "SELECT balance_cycles FROM accounts WHERE owner=?1",
                        params![owner],
                        |r| sql::row_get(r, 0),
                    )
                    .optional()
                    .map_err(|_| Error::Storage)?
                    .unwrap_or(0);
                let next = balance
                    .checked_add(p.credits as i64)
                    .ok_or(Error::QuotaExceeded)?;
                db.execute("INSERT INTO accounts(owner,balance_cycles,storage_charged_at_ms) VALUES(?1,?2,?3) ON CONFLICT(owner) DO UPDATE SET balance_cycles=excluded.balance_cycles",params![owner,next,(p.created_at_time/1_000_000) as i64]).map_err(|_|Error::Storage)?;
                crate::accounting::record_entry(
                    db,
                    &owner,
                    "purchase",
                    p.credits as i64,
                    next,
                    (p.created_at_time / 1_000_000) as i64,
                    Some(&p.request.operation),
                )?;
                Status::Paid(block)
            }
            Outcome::Unknown => {
                p.uncertain = true;
                Status::Unknown
            }
            Outcome::Rejected(s) => {
                if p.uncertain {
                    Status::Unknown
                } else {
                    s
                }
            }
        };
        save(db, &p)?;
        Ok(p)
    })
}
#[ic_cdk::update]
fn set_funding_config(config: Option<FundingConfig>) -> vault_types::Result<()> {
    if !ic_cdk::api::is_controller(&ic_cdk::api::msg_caller()) {
        return Err(Error::Unauthorized);
    }
    if let Some(c) = &config {
        auth(c.ledger)?;
        auth(c.recipient)?;
        if c.cycles_per_kinic == 0 || c.cycles_per_kinic > i64::MAX as u64 {
            return Err(Error::InvalidInput);
        }
    }
    transaction(|db| {
        db.execute("INSERT INTO global_settings(key,value) VALUES('funding',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![serde_json::to_string(&config).map_err(|_|Error::Storage)?]).map_err(|_|Error::Storage)?;
        Ok(())
    })
}
#[ic_cdk::query]
fn account_balance() -> vault_types::Result<u64> {
    let caller = ic_cdk::api::msg_caller();
    auth(caller)?;
    crate::state::State.balance(&caller.to_text())
}
#[ic_cdk::query]
fn payment_status(operation: Vec<u8>) -> vault_types::Result<Option<Payment>> {
    let caller = ic_cdk::api::msg_caller();
    auth(caller)?;
    if operation.len() != 16 {
        return Err(Error::InvalidInput);
    }
    transaction(|db| load(db, caller, &operation))
}
#[ic_cdk::update]
async fn quote_purchase(request: PurchaseRequest) -> vault_types::Result<Payment> {
    require_synthetic_funding()?;
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
    let config: FundingConfig = transaction(|db| {
        let raw: String = db
            .query_row(
                "SELECT value FROM global_settings WHERE key='funding'",
                params![],
                |r| sql::row_get(r, 0),
            )
            .map_err(|_| Error::Unauthorized)?;
        serde_json::from_str::<Option<FundingConfig>>(&raw)
            .map_err(|_| Error::Storage)?
            .ok_or(Error::Unauthorized)
    })?;
    let flight = match admit_quote(caller, request, config, crate::now_nanos())? {
        QuoteAdmission::Existing(payment) => return Ok(payment),
        QuoteAdmission::Fee(flight) => flight,
    };
    let fee = async {
        let response = ic_cdk::call::Call::bounded_wait(flight.payment.config.ledger, "icrc1_fee")
            .change_timeout(60)
            .await
            .map_err(|_| Error::KeyService)?;
        let fee: Nat = response.candid().map_err(|_| Error::KeyService)?;
        nat(&fee).ok_or(Error::InvalidInput)
    }
    .await;
    finish_quote(&flight, fee, crate::now_nanos())
}
#[derive(CandidType, Deserialize)]
struct Account {
    owner: Principal,
    subaccount: Option<Vec<u8>>,
}
#[derive(CandidType, Deserialize)]
struct TransferFromArg {
    spender_subaccount: Option<Vec<u8>>,
    from: Account,
    to: Account,
    amount: Nat,
    fee: Option<Nat>,
    memo: Option<Vec<u8>>,
    created_at_time: Option<u64>,
}
#[derive(CandidType, Deserialize)]
enum TransferError {
    BadFee { expected_fee: Nat },
    BadBurn { min_burn_amount: Nat },
    InsufficientFunds { balance: Nat },
    InsufficientAllowance { allowance: Nat },
    TooOld,
    CreatedInFuture { ledger_time: u64 },
    Duplicate { duplicate_of: Nat },
    TemporarilyUnavailable,
    GenericError { error_code: Nat, message: String },
}
fn nat(n: &Nat) -> Option<u64> {
    n.0.to_string().parse().ok()
}
#[ic_cdk::update]
async fn pay_purchase(operation: Vec<u8>) -> vault_types::Result<Payment> {
    // Even an exact retry could newly debit: production must not dispatch it.
    require_synthetic_funding()?;
    if operation.len() != 16 {
        return Err(Error::InvalidInput);
    }
    let p = begin_payment(ic_cdk::api::msg_caller(), &operation, crate::now_nanos())?;
    let arg = TransferFromArg {
        spender_subaccount: None,
        from: Account {
            owner: p.wallet,
            subaccount: None,
        },
        to: Account {
            owner: p.config.recipient,
            subaccount: None,
        },
        amount: p.request.amount_e8s.into(),
        fee: Some(p.fee.into()),
        memo: Some(p.memo.clone()),
        created_at_time: Some(p.created_at_time),
    };
    let outcome = match ic_cdk::call::Call::bounded_wait(p.config.ledger, "icrc2_transfer_from")
        .change_timeout(60)
        .with_arg(arg)
        .await
    {
        Err(_) => Outcome::Unknown,
        Ok(response) => match response.candid::<std::result::Result<Nat, TransferError>>() {
            Ok(Ok(block))
            | Ok(Err(TransferError::Duplicate {
                duplicate_of: block,
            })) => nat(&block).map(Outcome::Paid).unwrap_or(Outcome::Unknown),
            Ok(Err(TransferError::BadFee { expected_fee })) => nat(&expected_fee)
                .map(|f| Outcome::Rejected(Status::BadFee(f)))
                .unwrap_or(Outcome::Unknown),
            Ok(Err(TransferError::InsufficientFunds { .. })) => {
                Outcome::Rejected(Status::InsufficientFunds)
            }
            Ok(Err(TransferError::InsufficientAllowance { .. })) => {
                Outcome::Rejected(Status::InsufficientAllowance)
            }
            // TooOld after an unknown first attempt does not prove the original transfer failed.
            Ok(Err(TransferError::TooOld)) => Outcome::Unknown,
            Ok(Err(_)) => Outcome::Rejected(Status::Rejected),
            Err(_) => Outcome::Unknown,
        },
    };
    complete_payment(&p, outcome)
}

#[ic_cdk::query]
fn list_payments() -> vault_types::Result<Vec<Payment>> {
    let caller = ic_cdk::api::msg_caller();
    auth(caller)?;
    transaction(|db| {
        let mut statement = db
            .prepare("SELECT record FROM payments WHERE wallet=?1 ORDER BY expires DESC LIMIT 16")
            .map_err(|_| Error::Storage)?;
        let rows: Vec<String> = sql::query_map(&mut statement, params![caller.to_text()], |r| {
            sql::row_get(r, 0)
        })
        .map_err(|_| Error::Storage)?;
        rows.into_iter()
            .map(|r| serde_json::from_str(&r).map_err(|_| Error::Storage))
            .collect()
    })
}
#[ic_cdk::update]
fn cancel_quote(operation: Vec<u8>) -> vault_types::Result<Payment> {
    let caller = ic_cdk::api::msg_caller();
    auth(caller)?;
    if operation.len() != 16 {
        return Err(Error::InvalidInput);
    }
    transaction(|db| {
        let mut p = load(db, caller, &operation)?.ok_or(Error::NotFound)?;
        if !matches!(p.status, Status::Quoted) {
            return Err(Error::Conflict);
        }
        p.status = Status::Expired;
        save(db, &p)?;
        Ok(p)
    })
}

#[cfg(all(test, not(feature = "synthetic-funding-test-only")))]
mod production_gate_tests {
    use super::*;
    use std::{
        future::Future,
        pin::pin,
        task::{Context, Poll, Waker},
    };
    fn rejected_before_ic_or_ledger_calls(f: impl Future<Output = Result<Payment>>) {
        let mut f = pin!(f);
        let mut cx = Context::from_waker(Waker::noop());
        assert!(matches!(
            f.as_mut().poll(&mut cx),
            Poll::Ready(Err(Error::Unauthorized))
        ));
    }
    #[test]
    fn production_quote_and_payment_fail_before_caller_fee_or_transfer_calls() {
        rejected_before_ic_or_ledger_calls(quote_purchase(PurchaseRequest {
            operation: vec![1; 16],
            beneficiary: Principal::anonymous(),
            amount_e8s: 100_000_000,
            min_credits: 1,
            created_at_time: 0,
        }));
        rejected_before_ic_or_ledger_calls(pay_purchase(vec![1; 16]));
    }
}
