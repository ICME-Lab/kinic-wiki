//! Authoritative ICRC-3 reconciliation. Every read is a replicated canister call.
use super::*;
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
            // An old/uncertain record has no authoritative lower bound. Never invent one.
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
fn begin_scan(wallet: Principal, id: &[u8], now: u64) -> Result<Payment> {
    auth(wallet)?;
    if id.len() != 16 {
        return Err(Error::InvalidInput);
    }
    transaction(|db| {
        let mut p = load(db, wallet, id)?.ok_or(Error::NotFound)?;
        if matches!(p.status, Status::Paid(_)) {
            return Ok(p);
        }
        if !matches!(p.status, Status::InFlight | Status::Unknown) {
            return Err(Error::Conflict);
        }
        let current = generation(db)?;
        if p.preparing {
            if p.generation == current && now.saturating_sub(p.sent_at) <= 120_000_000_000 {
                return Err(Error::Busy);
            }
            // An interrupted preparation never issued transfer_from. Recover its cancellable quote.
            p.preparing = false;
            p.status = Status::Quoted;
            p.uncertain = false;
            save(db, &p)?;
            return Ok(p);
        }
        let mut statement = db
            .prepare("SELECT record FROM payments")
            .map_err(|_| Error::Storage)?;
        let records: Vec<String> =
            sql::query_map(&mut statement, params![], |r| sql::row_get(r, 0))
                .map_err(|_| Error::Storage)?;
        let mut active = 0;
        for raw in records {
            let other: Payment = serde_json::from_str(&raw).map_err(|_| Error::Storage)?;
            if other
                .reconciliation
                .as_ref()
                .is_some_and(|s| s.lease_generation == current && s.lease_until > now)
            {
                if other.wallet == wallet {
                    return Err(Error::Busy);
                }
                active += 1;
            }
        }
        if active >= 8 {
            return Err(Error::Busy);
        }
        p.status = Status::Unknown;
        p.uncertain = true;
        if let Some(scan) = &mut p.reconciliation {
            scan.lease = scan.lease.checked_add(1).ok_or(Error::QuotaExceeded)?;
            scan.lease_until = now
                .checked_add(180_000_000_000)
                .ok_or(Error::InvalidInput)?;
            scan.lease_generation = current;
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
    if matches!(p.status, Status::Paid(_)) || p.reconciliation.is_none() {
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
        save(db, &p)?;
        Ok(p)
    })
}
