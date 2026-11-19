//! Authoritative ICRC-3 reconciliation. Every read is a replicated canister call.
use super::ledger::{nat, require_ledger};
use super::*;
use candid::Nat;
#[derive(Clone, Debug, CandidType, Serialize, Deserialize, PartialEq)]
pub struct ReconciliationState {
    pub start: u64,
    pub next: u64,
    pub end: u64,
    pub spender: Principal,
    pub lease: u64,
    pub lease_until: u64,
    pub lease_generation: i64,
}
#[derive(Clone, Debug, CandidType, Deserialize)]
pub struct ReconciliationProgress {
    pub payment: Payment,
    pub scanned: u64,
    pub next: Nat,
    pub end: Nat,
    pub can_continue: bool,
}
#[derive(Clone, Debug, CandidType, Deserialize, PartialEq)]
enum Value {
    Blob(Vec<u8>),
    Text(String),
    Nat(Nat),
    Int(candid::Int),
    Array(Vec<Value>),
    Map(Vec<(String, Value)>),
}
fn field<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    let Value::Map(entries) = value else {
        return None;
    };
    // Duplicate keys are ambiguous evidence, never a reason to credit.
    let mut keys = std::collections::BTreeSet::new();
    if entries.iter().any(|(k, _)| !keys.insert(k)) {
        return None;
    }
    entries.iter().find(|(k, _)| k == key).map(|(_, v)| v)
}
fn number(value: Option<&Value>) -> Option<u64> {
    match value? {
        Value::Nat(n) => nat(n),
        _ => None,
    }
}
fn default_account(value: Option<&Value>, owner: Principal) -> bool {
    let Some(Value::Array(parts)) = value else {
        return false;
    };
    matches!(parts.first(), Some(Value::Blob(bytes)) if bytes == owner.as_slice())
        && (parts.len() == 1
            || (parts.len() == 2
                && matches!(&parts[1],Value::Blob(bytes) if bytes.as_slice() == [0;32])))
}
fn matches_transfer(payment: &Payment, block: &Value) -> bool {
    let Some(scan) = &payment.reconciliation else {
        return false;
    };
    let Some(tx) = field(block, "tx") else {
        return false;
    };
    let transfer = match field(block, "btype") {
        Some(Value::Text(kind)) => kind == "2xfer",
        None => matches!(field(tx,"op"),Some(Value::Text(op)) if op == "xfer"),
        _ => false,
    };
    transfer
        && default_account(field(tx,"from"), payment.wallet)
        && default_account(field(tx,"to"), payment.config.recipient)
        && default_account(field(tx,"spender"), scan.spender)
        && number(field(tx,"amt")) == Some(payment.request.amount_e8s)
        // We always supply an explicit fee. Its presence in tx is part of the identity.
        && number(field(tx,"fee")) == Some(payment.fee)
        && number(field(tx,"ts")) == Some(payment.created_at_time)
        && matches!(field(tx,"memo"),Some(Value::Blob(memo)) if memo == &payment.memo)
}
pub(super) fn prepare_dispatch(sent: &Payment, spender: Principal, start: u64) -> Result<Payment> {
    transaction(|db| {
        let mut p = load(db, sent.wallet, &sent.request.operation)?.ok_or(Error::NotFound)?;
        if p != *sent || p.generation != generation(db)? || !matches!(p.status, Status::InFlight) {
            return Err(Error::Conflict);
        }
        if let Some(scan) = &p.reconciliation {
            if scan.spender != spender {
                return Err(Error::Conflict);
            }
        } else {
            // The first search snapshot belongs only to known-unsent preparation.
            if !p.preparing || p.uncertain {
                return Err(Error::Conflict);
            }
            p.reconciliation = Some(ReconciliationState {
                start,
                next: start,
                end: start,
                spender,
                lease: 0,
                lease_until: 0,
                lease_generation: 0,
            });
        }
        p.preparing = false;
        save(db, &p)?;
        Ok(p)
    })
}
// The eight lease rows are allocated with schema 14. Fixed-size updates
// leave the final settlement reserve available throughout a history scan.
const SLOT_BYTES: usize = 512;

pub(crate) fn initialize_scan_slots(db: &sql::Connection) -> Result<()> {
    db.execute(
        "WITH RECURSIVE slots(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM slots WHERE n<8)
         INSERT INTO payment_scan_slots
         SELECT n,printf('%*s',?1,'null') FROM slots",
        params![SLOT_BYTES as i64],
    )
    .map_err(|_| Error::Storage)?;
    Ok(())
}

#[derive(Serialize, Deserialize)]
struct ScanSlot {
    wallet: Principal,
    operation: Vec<u8>,
    lease: u64,
    generation: i64,
    expires: u64,
}

fn scan_slots(db: &sql::Connection) -> Result<Vec<(i64, Option<ScanSlot>)>> {
    let mut query = db
        .prepare("SELECT slot,record FROM payment_scan_slots ORDER BY slot")
        .map_err(|_| Error::Storage)?;
    let rows: Vec<(i64, String)> = sql::query_map(&mut query, params![], |r| {
        Ok((sql::row_get(r, 0)?, sql::row_get(r, 1)?))
    })
    .map_err(|_| Error::Storage)?;
    if rows.len() != 8 {
        return Err(Error::Storage);
    }
    rows.into_iter()
        .map(|(slot, raw)| {
            Ok((
                slot,
                serde_json::from_str(&raw).map_err(|_| Error::Storage)?,
            ))
        })
        .collect()
}

fn write_scan_slot(db: &sql::Connection, slot: i64, scan: Option<ScanSlot>) -> Result<()> {
    let mut raw = serde_json::to_string(&scan).map_err(|_| Error::Storage)?;
    let padding = SLOT_BYTES.checked_sub(raw.len()).ok_or(Error::Storage)?;
    raw.extend(std::iter::repeat_n(' ', padding));
    db.execute(
        "UPDATE payment_scan_slots SET record=?2 WHERE slot=?1",
        params![slot, raw],
    )
    .map_err(|_| Error::Storage)?;
    Ok(())
}

pub(super) fn release_scan_slot(db: &sql::Connection, payment: &Payment) -> Result<()> {
    let Some(reconciliation) = payment
        .reconciliation
        .as_ref()
        .filter(|scan| scan.lease_until != 0)
    else {
        return Ok(());
    };
    let slot = scan_slots(db)?.into_iter().find(|(_, scan)| {
        scan.as_ref().is_some_and(|scan| {
            scan.wallet == payment.wallet
                && scan.operation == payment.request.operation
                && scan.lease == reconciliation.lease
                && scan.generation == reconciliation.lease_generation
        })
    });
    if let Some((slot, _)) = slot {
        write_scan_slot(db, slot, None)?;
    }
    Ok(())
}

pub(super) enum ScanAdmission {
    AlreadyPaid,
    RecoverQuote,
    History {
        slot: i64,
        lease: u64,
        lease_until: u64,
        lease_generation: i64,
    },
}

pub(super) fn scan_admission(
    db: &kinic_sqlite_compat::Connection,
    payment: &Payment,
    now: u64,
) -> Result<ScanAdmission> {
    if matches!(payment.status, Status::Paid(_)) {
        return Ok(ScanAdmission::AlreadyPaid);
    }
    if !matches!(payment.status, Status::InFlight | Status::Unknown) {
        return Err(Error::Conflict);
    }
    let current = generation(db)?;
    // The live transfer callback owns its outcome through the full wait window.
    if payment.status == Status::InFlight
        && payment.generation == current
        && now.saturating_sub(payment.sent_at) <= 120_000_000_000
    {
        return Err(Error::Busy);
    }
    if payment.preparing {
        return Ok(ScanAdmission::RecoverQuote);
    }
    let mut available = None;
    for (slot, scan) in scan_slots(db)? {
        if let Some(scan) = scan.filter(|scan| scan.generation == current && scan.expires > now) {
            if scan.wallet == payment.wallet {
                return Err(Error::Busy);
            }
        } else if available.is_none() {
            available = Some(slot);
        }
    }
    let scan = payment.reconciliation.as_ref().ok_or(Error::Storage)?;
    Ok(ScanAdmission::History {
        slot: available.ok_or(Error::Busy)?,
        lease: scan.lease.checked_add(1).ok_or(Error::QuotaExceeded)?,
        lease_until: now
            .checked_add(180_000_000_000)
            .ok_or(Error::InvalidInput)?,
        lease_generation: current,
    })
}

pub(super) fn begin_scan(wallet: Principal, id: &[u8], now: u64) -> Result<Payment> {
    auth(wallet)?;
    if id.len() != 16 {
        return Err(Error::InvalidInput);
    }
    transaction(|db| {
        let mut p = load(db, wallet, id)?.ok_or(Error::NotFound)?;
        match scan_admission(db, &p, now)? {
            ScanAdmission::AlreadyPaid => return Ok(p),
            ScanAdmission::RecoverQuote => {
                // Interrupted preparation never dispatched a transfer.
                p.preparing = false;
                p.status = Status::Quoted;
                p.uncertain = false;
                crate::capacity::release_payment_completion(db, p.wallet, &p.request.operation)?;
            }
            ScanAdmission::History {
                slot,
                lease,
                lease_until,
                lease_generation,
            } => {
                write_scan_slot(
                    db,
                    slot,
                    Some(ScanSlot {
                        wallet: p.wallet,
                        operation: p.request.operation.clone(),
                        lease,
                        generation: lease_generation,
                        expires: lease_until,
                    }),
                )?;
                let scan = p.reconciliation.as_mut().ok_or(Error::Storage)?;
                scan.lease = lease;
                scan.lease_until = lease_until;
                scan.lease_generation = lease_generation;
                p.status = Status::Unknown;
                p.uncertain = true;
            }
        }
        save(db, &p)?;
        Ok(p)
    })
}
#[cfg(test)]
#[path = "reconciliation_tests.rs"]
mod tests;
#[derive(Clone, Debug, CandidType, Deserialize)]
struct Block {
    id: Nat,
    block: Value,
}
struct ScanBatch {
    end: u64,
    blocks: Vec<Block>,
}
fn progress(payment: Payment, scanned: u64, can_continue: bool) -> ReconciliationProgress {
    let (next, end) = payment
        .reconciliation
        .as_ref()
        .map(|s| (s.next, s.end))
        .unwrap_or((0, 0));
    ReconciliationProgress {
        payment,
        scanned,
        next: next.into(),
        end: end.into(),
        can_continue,
    }
}
fn finish_scan(
    sent: &Payment,
    batch: Result<ScanBatch>,
    now: u64,
) -> Result<ReconciliationProgress> {
    transaction(|db| {
        let mut p = load(db, sent.wallet, &sent.request.operation)?.ok_or(Error::NotFound)?;
        if matches!(p.status, Status::Paid(_)) {
            return Ok(progress(p, 0, false));
        }
        let old = sent.reconciliation.as_ref().ok_or(Error::Conflict)?;
        let scan = p.reconciliation.as_ref().ok_or(Error::Conflict)?;
        if old != scan || old.lease_generation != generation(db)? || old.lease_until <= now {
            return Err(Error::Conflict);
        }
        let mut next = scan.next;
        let mut end = scan.end;
        let mut scanned = 0;
        let mut found = None;
        if let Ok(mut batch) = batch {
            let limit = next.saturating_add(100).min(batch.end);
            // Invalid response sizes/ranges never advance a durable cursor.
            let mut seen = std::collections::BTreeSet::new();
            let valid = batch.end >= end
                && batch.blocks.len() <= 100
                && batch
                    .blocks
                    .iter()
                    .all(|b| nat(&b.id).is_some_and(|i| i >= next && i < limit && seen.insert(i)));
            if valid {
                end = batch.end;
                batch.blocks.sort_by(|a, b| a.id.cmp(&b.id));
                for b in batch.blocks {
                    if nat(&b.id) != Some(next) {
                        break;
                    }
                    scanned += 1;
                    next += 1;
                    if matches_transfer(&p, &b.block) {
                        found = nat(&b.id);
                        break;
                    }
                }
            }
        }
        release_scan_slot(db, &p)?;
        let scan = p.reconciliation.as_mut().ok_or(Error::Conflict)?;
        scan.next = next;
        scan.end = end;
        scan.lease_until = 0;
        if let Some(block) = found {
            credit_payment(db, &p)?;
            p.status = Status::Paid(block);
            p.uncertain = false;
        }
        save(db, &p)?;
        Ok(progress(
            p,
            scanned,
            found.is_none() && scanned > 0 && next < end,
        ))
    })
}
#[derive(Clone, Debug, CandidType, Deserialize)]
struct Range {
    start: Nat,
    length: Nat,
}
candid::define_function!(ArchiveCallback : (Vec<Range>) -> (GetBlocksResult) query);
#[derive(Clone, Debug, CandidType, Deserialize)]
struct Archive {
    args: Vec<Range>,
    callback: ArchiveCallback,
}
#[derive(Clone, Debug, CandidType, Deserialize)]
struct GetBlocksResult {
    log_length: Nat,
    blocks: Vec<Block>,
    archived_blocks: Vec<Archive>,
}
fn archive_request(
    response: &GetBlocksResult,
    next: u64,
    end: u64,
) -> Option<(ArchiveCallback, Range)> {
    let limit = next.saturating_add(100).min(end);
    if next >= limit {
        return None;
    }
    for archive in &response.archived_blocks {
        if auth(archive.callback.0.principal).is_err()
            || archive.callback.0.method.is_empty()
            || archive.callback.0.method.len() > 128
        {
            continue;
        }
        for range in &archive.args {
            let start = nat(&range.start)?;
            let stop = start.checked_add(nat(&range.length)?)?;
            if start <= next && next < stop {
                return Some((
                    archive.callback.clone(),
                    Range {
                        start: next.into(),
                        length: (stop.min(limit) - next).into(),
                    },
                ));
            }
        }
    }
    None
}
async fn get_blocks(
    canister: Principal,
    method: &str,
    args: Vec<Range>,
) -> Result<GetBlocksResult> {
    let response = ic_cdk::call::Call::bounded_wait(canister, method)
        .change_timeout(60)
        .with_arg(args)
        .await
        .map_err(|_| Error::KeyService)?;
    let raw = response.into_bytes();
    if raw.len() > 2_000_000 {
        return Err(Error::KeyService);
    }
    let mut config = candid::de::DecoderConfig::new();
    config
        .set_decoding_quota(2_000_000)
        .set_skipping_quota(10_000);
    let response: GetBlocksResult =
        candid::decode_one_with_config(&raw, &config).map_err(|_| Error::KeyService)?;
    if response.blocks.len() > 100
        || response.archived_blocks.len() > 100
        || response.archived_blocks.iter().any(|a| a.args.len() > 100)
    {
        return Err(Error::KeyService);
    }
    Ok(response)
}
pub(super) async fn ledger_tip(ledger: Principal) -> Result<u64> {
    let response = get_blocks(
        ledger,
        "icrc3_get_blocks",
        vec![Range {
            start: 0u64.into(),
            length: 0u64.into(),
        }],
    )
    .await?;
    nat(&response.log_length).ok_or(Error::KeyService)
}
async fn scan_ledger(p: &Payment) -> Result<ScanBatch> {
    let state = p.reconciliation.as_ref().ok_or(Error::Conflict)?;
    let next = state.next;
    let mut response = get_blocks(
        p.config.ledger,
        "icrc3_get_blocks",
        vec![Range {
            start: next.into(),
            length: 100u64.into(),
        }],
    )
    .await?;
    let end = nat(&response.log_length).ok_or(Error::KeyService)?;
    if end < state.end {
        return Err(Error::KeyService);
    }
    // At most one archive request per update. No recursively supplied callbacks are followed.
    // Only this direct authenticated response from the configured ledger selects its target.
    if let Some((callback, range)) = archive_request(&response, next, end) {
        let stop = next
            .checked_add(nat(&range.length).ok_or(Error::KeyService)?)
            .ok_or(Error::KeyService)?;
        let archive = get_blocks(callback.0.principal, &callback.0.method, vec![range]).await?;
        if archive
            .blocks
            .iter()
            .any(|b| !nat(&b.id).is_some_and(|i| i >= next && i < stop))
        {
            return Err(Error::KeyService);
        }
        response.blocks.extend(archive.blocks);
    }
    Ok(ScanBatch {
        end,
        blocks: response.blocks,
    })
}
#[ic_cdk::update]
async fn reconcile_purchase(operation: Vec<u8>) -> Result<ReconciliationProgress> {
    let p = begin_scan(ic_cdk::api::msg_caller(), &operation, crate::now_nanos())?;
    if matches!(p.status, Status::Paid(_) | Status::Quoted) {
        return Ok(progress(p, 0, false));
    }
    let batch = match require_ledger(p.config.ledger) {
        Ok(()) => scan_ledger(&p).await,
        Err(error) => Err(error),
    };
    finish_scan(&p, batch, crate::now_nanos())
}
pub(super) fn begin_preparation(sent: &Payment) -> Result<Payment> {
    transaction(|db| {
        let mut p = load(db, sent.wallet, &sent.request.operation)?.ok_or(Error::NotFound)?;
        if p != *sent
            || p.generation != generation(db)?
            || !matches!(p.status, Status::InFlight)
            || p.uncertain
            || p.reconciliation.is_some()
        {
            return Err(Error::Conflict);
        }
        p.preparing = true;
        save(db, &p)?;
        Ok(p)
    })
}
pub(super) fn finish_preparation(sent: &Payment) -> Result<Payment> {
    transaction(|db| {
        let mut p = load(db, sent.wallet, &sent.request.operation)?.ok_or(Error::NotFound)?;
        if p != *sent || !p.preparing || p.generation != generation(db)? {
            return Err(Error::Conflict);
        }
        p.status = Status::Quoted;
        p.preparing = false;
        crate::capacity::release_payment_completion(db, p.wallet, &p.request.operation)?;
        save(db, &p)?;
        Ok(p)
    })
}
