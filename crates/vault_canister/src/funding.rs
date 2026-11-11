//! Durable ICRC-2 quotes. Only the authenticated wallet can debit its own allowance.
use crate::state::transaction;
use candid::{CandidType, Nat, Principal};
use kinic_sqlite_compat::{self as sql, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use vault_types::{Error, Result};
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
fn save(db: &sql::Connection, p: &Payment) -> Result<()> {
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
pub fn record_quote(
    wallet: Principal,
    request: PurchaseRequest,
    config: FundingConfig,
    fee: u64,
    now: u64,
) -> Result<Payment> {
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
                Ok(old)
            } else {
                Err(Error::Conflict)
            };
        }
        if request.created_at_time > now.saturating_add(60_000_000_000)
            || now.saturating_sub(request.created_at_time) > 300_000_000_000
        {
            return Err(Error::Expired);
        }
        db.execute(
            "DELETE FROM payments WHERE expires<?1",
            params![(now / 1_000_000_000) as i64],
        )
        .map_err(|_| Error::Storage)?;
        let (global, owner): (i64, i64) = db
            .query_row(
                "SELECT count(*),coalesce(sum(wallet=?1),0) FROM payments",
                params![wallet.to_text()],
                |r| Ok((sql::row_get(r, 0)?, sql::row_get(r, 1)?)),
            )
            .map_err(|_| Error::Storage)?;
        if global >= 1024 || owner >= 16 {
            return Err(Error::QuotaExceeded);
        }
        let credits = u64::try_from(
            u128::from(request.amount_e8s) * u128::from(config.cycles_per_kinic) / 100_000_000,
        )
        .map_err(|_| Error::InvalidInput)?;
        if credits < 20_000_000 || credits < request.min_credits || credits > i64::MAX as u64 {
            return Err(Error::InvalidInput);
        }
        let mut hash = Sha256::new();
        hash.update(b"kinic-vault/payment/v1");
        hash.update(wallet.as_slice());
        hash.update(&request.operation);
        hash.update(request.created_at_time.to_be_bytes());
        let p = Payment {
            wallet,
            created_at_time: now,
            request,
            config,
            fee,
            credits,
            memo: hash.finalize().to_vec(),
            status: Status::Quoted,
            uncertain: false,
            attempt: 0,
            sent_at: 0,
            generation: generation(db)?,
        };
        save(db, &p)?;
        Ok(p)
    })
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
            .prepare("SELECT record FROM payments LIMIT 1024")
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
    let response = ic_cdk::call::Call::bounded_wait(config.ledger, "icrc1_fee")
        .change_timeout(60)
        .await
        .map_err(|_| Error::KeyService)?;
    let fee: Nat = response.candid().map_err(|_| Error::KeyService)?;
    record_quote(
        caller,
        request,
        config,
        nat(&fee).ok_or(Error::InvalidInput)?,
        crate::now_nanos(),
    )
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
