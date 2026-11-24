//! Durable ICRC-2 quotes. Only the authenticated wallet can quote against its own
//! allowance; the wallet or the quote's beneficiary can submit that signed quote.
use crate::state::transaction;
mod api;
#[cfg(test)]
#[path = "funding/beneficiary_tests.rs"]
mod beneficiary_tests;
mod consent;
#[cfg(test)]
#[path = "funding/consent_tests.rs"]
mod consent_tests;
mod ledger;
mod reconciliation;
use candid::{CandidType, Principal};
pub(crate) use consent::{
    Icrc10SupportedStandard, Icrc21ConsentMessageRequest, Icrc21ConsentMessageResponse,
};
use kinic_sqlite_compat::{self as sql, OptionalExtension, params};
pub(crate) use reconciliation::initialize_scan_slots;
pub use reconciliation::{ReconciliationProgress, ReconciliationState};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use vault_types::{Error, Result};
const QUOTE_LIFETIME_NS: u64 = 300_000_000_000;
/// Certified build provenance, independent of controller configuration and origin selection.
#[cfg(any(feature = "embedded-assets", not(target_arch = "wasm32")))]
pub const FUNDING_MODE: &str = if cfg!(feature = "synthetic-funding-test-only") {
    "synthetic-test-only"
} else {
    "production"
};
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
    pub reconciliation: Option<ReconciliationState>,
    /// True only while the durable operation is known not to have dispatched a debit.
    pub preparing: bool,
}
impl Payment {
    fn with_effective_status(mut self, now: u64) -> Self {
        if self.status == Status::Quoted
            && now.saturating_sub(self.created_at_time) > QUOTE_LIFETIME_NS
        {
            self.status = Status::Expired;
        }
        self
    }
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
    raw.map(|v| {
        if crate::bridge::decode(&v)?.is_some() {
            return Err(Error::Conflict);
        }
        serde_json::from_str(&v).map_err(|_| Error::Storage)
    })
    .transpose()
}
#[cfg(test)]
pub(crate) fn all_payments(db: &sql::Connection) -> Result<impl Iterator<Item = Result<Payment>>> {
    let mut statement = db
        .prepare("SELECT record FROM payments")
        .map_err(|_| Error::Storage)?;
    let records: Vec<String> = sql::query_map(&mut statement, params![], |r| sql::row_get(r, 0))
        .map_err(|_| Error::Storage)?;
    Ok(records
        .into_iter()
        .filter_map(|raw| match crate::bridge::decode(&raw) {
            Ok(Some(_)) => None,
            Err(e) => Some(Err(e)),
            Ok(None) => Some(serde_json::from_str(&raw).map_err(|_| Error::Storage)),
        }))
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
    widest.preparing = false;
    // Reserve the reconciliation fields even for a quote with no cursor yet.
    widest.reconciliation = Some(ReconciliationState {
        start: u64::MAX,
        next: u64::MAX,
        end: u64::MAX,
        spender: Principal::from_slice(&[255; 29]),
        lease: u64::MAX,
        lease_until: u64::MAX,
        lease_generation: i64::MIN,
    });
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
// Wallet, operation, expires, and three length prefixes use at most 99 of
// the 4,096-byte row budget. Stable-size pending rows can advance a scan
// even when SQLite cannot allocate a new page.
const PENDING_RECORD_BYTES: usize = vault_types::capacity::PAYMENT_ROW - (63 + 16 + 8 + 12);

pub(crate) fn pad_pending_payments(db: &sql::Connection) -> Result<()> {
    db.execute(
        "UPDATE payments SET record=record || printf('%*s', ?1 - length(CAST(record AS BLOB)), '')
         WHERE json_extract(record,'$.status') IN ('InFlight','Unknown')",
        params![PENDING_RECORD_BYTES as i64],
    )
    .map_err(|_| Error::Storage)?;
    Ok(())
}

fn save(db: &sql::Connection, p: &Payment) -> Result<()> {
    validate_receipts(p)?;
    let mut raw = serde_json::to_string(p).map_err(|_| Error::Storage)?;
    if matches!(p.status, Status::InFlight | Status::Unknown) {
        let padding = PENDING_RECORD_BYTES
            .checked_sub(raw.len())
            .ok_or(Error::QuotaExceeded)?;
        raw.extend(std::iter::repeat_n(' ', padding));
        // Pending-to-pending writes keep the same deadline. Do not rewrite
        // the expiry index or allocate a new journal row during reconciliation.
        let same_expiry: i64 = db.query_row(
            "SELECT EXISTS(SELECT 1 FROM payments WHERE wallet=?1 AND operation=?2 AND expires=?3)",
            params![p.wallet.to_text(),p.request.operation,i64::MAX],
            |r| sql::row_get(r, 0),
        ).map_err(|_| Error::Storage)?;
        if same_expiry != 0 {
            db.execute(
                "UPDATE payments SET record=?3 WHERE wallet=?1 AND operation=?2",
                params![p.wallet.to_text(), p.request.operation, raw],
            )
            .map_err(|_| Error::Storage)?;
            return Ok(());
        }
    }
    let expiry = if matches!(p.status, Status::Quoted) {
        p.created_at_time / 1_000_000_000 + 300
    } else if matches!(p.status, Status::InFlight | Status::Unknown) {
        i64::MAX as u64
    } else {
        p.created_at_time / 1_000_000_000 + 7 * 86400
    };
    db.execute("INSERT INTO payments(wallet,operation,record,expires) VALUES(?1,?2,?3,?4) ON CONFLICT(wallet,operation) DO UPDATE SET record=excluded.record,expires=excluded.expires",params![p.wallet.to_text(),p.request.operation,raw,expiry as i64]).map_err(|_|Error::Storage)?;
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

fn validate_quote_request(request: &PurchaseRequest) -> Result<()> {
    auth(request.beneficiary)?;
    if request.operation.len() != 16
        || request.amount_e8s == 0
        || request.amount_e8s > i64::MAX as u64
        || request.min_credits == 0
    {
        return Err(Error::InvalidInput);
    }
    Ok(())
}

fn quote_credits(request: &PurchaseRequest, config: &FundingConfig, now: u64) -> Result<u64> {
    if request.created_at_time > now.saturating_add(60_000_000_000)
        || now.saturating_sub(request.created_at_time) > QUOTE_LIFETIME_NS
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
    Ok(credits)
}

pub fn admit_quote(
    wallet: Principal,
    request: PurchaseRequest,
    config: FundingConfig,
    now: u64,
) -> Result<QuoteAdmission> {
    auth(wallet)?;
    validate_quote_request(&request)?;
    transaction(|db| {
        if let Some(old) = load(db, wallet, &request.operation)? {
            return if old.request == request {
                Ok(QuoteAdmission::Existing(old))
            } else {
                Err(Error::Conflict)
            };
        }
        let credits = quote_credits(&request, &config, now)?;
        let generation = generation(db)?;
        let nanos = i64::try_from(now).map_err(|_| Error::InvalidInput)?;
        db.execute(
            "DELETE FROM quote_fee_flights WHERE generation<>?1 OR expires_ns<=?2",
            params![generation, nanos],
        )
        .map_err(|_| Error::Storage)?;
        crate::capacity::collect_expired_payments(db, wallet, (now / 1_000_000_000) as i64)?;
        let owned: i64 = db
            .query_row(
                "SELECT count(*) FROM payments WHERE wallet=?1",
                params![wallet.to_text()],
                |r| sql::row_get(r, 0),
            )
            .map_err(|_| Error::Storage)?;
        let (flights, own_flights): (i64, i64) = db
            .query_row(
                "SELECT count(*),coalesce(sum(wallet=?1),0) FROM quote_fee_flights",
                params![wallet.to_text()],
                |r| Ok((sql::row_get(r, 0)?, sql::row_get(r, 1)?)),
            )
            .map_err(|_| Error::Storage)?;
        if owned + own_flights >= 16 {
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
            reconciliation: None,
            preparing: false,
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
        // A fee callback only creates a quote. It never replaces any existing
        // receipt, including a bridge record left by a conflicting older writer.
        // Return an inner error so removal of this exact fee lease still commits.
        let occupied: i64 = db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM payments WHERE wallet=?1 AND operation=?2)",
                params![
                    current.payment.wallet.to_text(),
                    current.payment.request.operation
                ],
                |r| sql::row_get(r, 0),
            )
            .map_err(|_| Error::Storage)?;
        if occupied != 0 {
            return Ok(Err(Error::Conflict));
        }
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
fn payment_eligibility(p: &Payment, current: i64, now: u64) -> Result<bool> {
    if p.reconciliation
        .as_ref()
        .is_some_and(|s| s.lease_generation == current && s.lease_until > now)
    {
        return Err(Error::Busy);
    }
    let orphan = matches!(p.status, Status::InFlight)
        && (p.generation < current || now.saturating_sub(p.sent_at) > 120_000_000_000);
    if !matches!(p.status, Status::Quoted | Status::Unknown) && !orphan {
        return Err(Error::Conflict);
    }
    // Unknown payments can only be retried byte-for-byte within ledger dedup window.
    // Beyond it the durable Unknown row requires authoritative ledger reconciliation.
    let max = if matches!(p.status, Status::Quoted) || p.preparing {
        QUOTE_LIFETIME_NS
    } else {
        23 * 3600 * 1_000_000_000
    };
    if now < p.created_at_time || now - p.created_at_time > max {
        return Err(Error::Expired);
    }
    Ok(orphan)
}

fn next_payment_attempt(payment: &Payment) -> Result<u64> {
    payment
        .attempt
        .checked_add(1)
        .filter(|attempt| *attempt <= 100)
        .ok_or(Error::QuotaExceeded)
}

pub fn begin_payment(wallet: Principal, id: &[u8], now: u64) -> Result<Payment> {
    auth(wallet)?;
    transaction(|db| {
        let mut p = load(db, wallet, id)?.ok_or(Error::NotFound)?;
        let current = generation(db)?;
        let orphan = payment_eligibility(&p, current, now)?;
        validate_receipts(&p)?;
        crate::capacity::admit_credit(
            db,
            p.request.beneficiary,
            p.wallet,
            &p.request.operation,
            p.credits,
        )?;
        crate::capacity::reserve_payment_completion(db, p.wallet, &p.request.operation)?;
        p.uncertain |= (orphan && !p.preparing) || matches!(p.status, Status::Unknown);
        p.status = Status::InFlight;
        p.generation = current;
        p.attempt = next_payment_attempt(&p)?;
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
fn credit_payment(db: &sql::Connection, p: &Payment) -> Result<()> {
    crate::capacity::release_payment_completion(db, p.wallet, &p.request.operation)?;
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
    Ok(())
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
            || !(matches!(p.status, Status::InFlight)
                || (matches!(p.status, Status::Unknown) && matches!(outcome, Outcome::Paid(_))))
        {
            return Err(Error::Conflict);
        }
        p.preparing = false;
        p.status = match outcome {
            Outcome::Paid(block) => {
                credit_payment(db, &p)?;
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
                    crate::capacity::release_payment_completion(
                        db,
                        p.wallet,
                        &p.request.operation,
                    )?;
                    s
                }
            }
        };
        if matches!(p.status, Status::Paid(_)) {
            p.uncertain = false;
            reconciliation::release_scan_slot(db, &p)?;
            if let Some(scan) = &mut p.reconciliation {
                scan.lease_until = 0;
            }
        }
        save(db, &p)?;
        Ok(p)
    })
}
#[cfg(all(test, not(feature = "synthetic-funding-test-only")))]
mod production_ledger_tests {
    use super::*;
    #[test]
    fn only_pinned_kinic_ledger_can_debit_production_payments() {
        assert_eq!(
            ledger::require_ledger(Principal::from_text("73mez-iiaaa-aaaaq-aaasq-cai").unwrap()),
            Ok(())
        );
        assert_eq!(
            ledger::require_ledger(Principal::from_slice(&[7])),
            Err(Error::Unauthorized)
        );
    }
}

#[cfg(test)]
mod reconciliation_race_tests {
    use super::*;
    #[test]
    fn late_success_after_uncertainty_credits_exactly_once() {
        crate::state::initialize().unwrap();
        let wallet = Principal::from_slice(&[91]);
        let beneficiary = Principal::from_slice(&[92]);
        record_quote(
            wallet,
            PurchaseRequest {
                operation: vec![91; 16],
                beneficiary,
                amount_e8s: 100_000_000,
                min_credits: 1,
                created_at_time: 0,
            },
            FundingConfig {
                ledger: Principal::from_slice(&[93]),
                recipient: Principal::from_slice(&[94]),
                cycles_per_kinic: 100_000_000,
            },
            10,
            0,
        )
        .unwrap();
        let sent = begin_payment(wallet, &[91; 16], 0).unwrap();
        complete_payment(&sent, Outcome::Unknown).unwrap();
        let paid = complete_payment(&sent, Outcome::Paid(42)).unwrap();
        assert_eq!(paid.status, Status::Paid(42));
        complete_payment(&sent, Outcome::Paid(42)).unwrap();
        assert_eq!(
            crate::state::State.balance(&beneficiary.to_text()).unwrap(),
            100_000_000
        );
    }
}
