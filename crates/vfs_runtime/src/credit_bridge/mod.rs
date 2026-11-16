//! Durable source-side bridge. Every transition is synchronous and transaction scoped.
//! A hold is refundable only before dispatch or after an exact authoritative NotAccepted.
use super::*;
use candid::CandidType;
use credit_bridge_types::*;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
const TTL: u64 = 300_000_000_000;
const DAY: u64 = 86_400_000_000_000;
const CAP: i64 = 1024;
type R<T> = Result<T, String>;

#[derive(Clone, Debug, CandidType, Serialize, Deserialize, PartialEq, Eq)]
pub enum TransferAmount {
    All,
    Exact(u64),
}
#[derive(Clone, Debug, CandidType, Serialize, Deserialize, PartialEq, Eq)]
pub enum TransferPhase {
    Quoted,
    Offered,
    Unknown,
    Paid,
    Refunded,
}
#[derive(Clone, Debug, CandidType, Serialize, Deserialize, PartialEq, Eq)]
pub enum TransferApproval {
    Exact(u64),
    AllAvailable,
}
#[derive(Clone, Debug, CandidType, Serialize, Deserialize, PartialEq, Eq)]
pub struct VaultTransfer {
    pub offer: CreditOffer,
    pub database_id: String,
    pub requested: TransferAmount,
    pub phase: TransferPhase,
    pub balance_at_quote: u64,
    pub estimated_execution_fee_cycles: u64,
    pub collected_execution_fee_cycles: u64,
    pub receiver_cleanup_pending: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Transfer {
    view: VaultTransfer,
    peer: Principal,
    sequence: u64,
    attempt: u64,
    dispatched: bool,
    held: bool,
    published: bool,
    settled_day: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Settings {
    config: BridgeConfig,
    epoch: u64,
    serial: u64,
    generation: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Link {
    proof: LinkProof,
    active: bool,
    owner_epoch: u64,
    config_epoch: u64,
}
#[derive(Clone, Debug)]
pub struct LinkSnapshot {
    pub config: BridgeConfig,
    pub epoch: u64,
    pub owner_epoch: u64,
    pub lease_expires_at_ns: Option<u64>,
}
#[derive(Clone, Debug)]
pub struct Dispatch {
    pub offer: CreditOffer,
    pub peer: Principal,
    pub sequence: u64,
    pub attempt: u64,
    pub generation: u64,
    pub config_epoch: u64,
}

fn encode<T: Serialize>(v: &T) -> R<String> {
    serde_json::to_string(v).map_err(|e| e.to_string())
}
fn decode<T: DeserializeOwned>(s: String) -> R<T> {
    serde_json::from_str(&s).map_err(|e| e.to_string())
}
fn id(op: &[u8]) -> R<String> {
    if op.len() != 16 {
        return Err("InvalidInput".into());
    }
    Ok(op.iter().map(|b| format!("{b:02x}")).collect())
}
fn auth(p: Principal) -> R<()> {
    if p == Principal::anonymous() {
        Err("Unauthorized".into())
    } else {
        Ok(())
    }
}
fn settings(c: &Connection) -> R<Settings> {
    let s: String = c
        .query_row(
            "SELECT record FROM credit_bridge_settings WHERE id=1",
            params![],
            |r| crate::sqlite::row_get(r, 0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or("Disabled")?;
    decode(s)
}
fn save_settings(c: &Transaction<'_>, s: &Settings) -> R<()> {
    c.execute(
        "INSERT INTO credit_bridge_settings(id,record) VALUES(1,?1)
         ON CONFLICT(id) DO UPDATE SET record=excluded.record",
        params![encode(s)?],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
fn enabled(c: &Connection) -> R<Settings> {
    let s = settings(c)?;
    if !s.config.enabled {
        return Err("Disabled".into());
    }
    Ok(s)
}
fn scalar(c: &Connection, sql: &str, key: &str) -> R<i64> {
    c.query_row(sql, params![key], |r| crate::sqlite::row_get(r, 0))
        .map_err(|e| e.to_string())
}
fn owner_epoch(c: &Connection, p: Principal) -> R<u64> {
    Ok(scalar(
        c,
        "SELECT COALESCE((SELECT epoch FROM credit_bridge_owners WHERE wiki_owner=?1),0)",
        &p.to_text(),
    )? as u64)
}
fn expire_unpaired_fences(c: &Connection, now: i64) -> R<()> {
    c.execute(
        "DELETE FROM credit_bridge_fences
         WHERE expires_at_ns IS NOT NULL AND expires_at_ns<=?1
           AND NOT EXISTS (SELECT 1 FROM credit_bridge_links
                           WHERE credit_bridge_links.vault_owner=credit_bridge_fences.vault_owner)",
        params![now],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
fn fence(c: &Connection, p: Principal) -> R<u64> {
    Ok(scalar(
        c,
        "SELECT COALESCE((SELECT generation FROM credit_bridge_fences WHERE vault_owner=?1),0)",
        &p.to_text(),
    )? as u64)
}
fn link(c: &Connection, p: Principal) -> R<Option<Link>> {
    c.query_row(
        "SELECT record FROM credit_bridge_links WHERE wiki_owner=?1",
        params![p.to_text()],
        |r| crate::sqlite::row_get::<String>(r, 0),
    )
    .optional()
    .map_err(|e| e.to_string())?
    .map(decode)
    .transpose()
}
fn save_link(c: &Transaction<'_>, l: &Link) -> R<()> {
    c.execute(
        "INSERT INTO credit_bridge_links(wiki_owner,vault_owner,record) VALUES(?1,?2,?3)
         ON CONFLICT(wiki_owner) DO UPDATE SET record=excluded.record",
        params![
            l.proof.wiki_owner.to_text(),
            l.proof.challenge.vault_owner.to_text(),
            encode(l)?
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
fn active_link(c: &Connection, p: Principal) -> R<Link> {
    let l = link(c, p)?.ok_or("NotFound")?;
    if !l.active || l.proof.challenge.generation <= fence(c, l.proof.challenge.vault_owner)? {
        return Err("Conflict".into());
    }
    Ok(l)
}
fn owner(c: &Connection, db: &str, p: Principal) -> R<()> {
    auth(p)?;
    if load_member_role(c, db, &p.to_text())? != Some(DatabaseRole::Owner) {
        return Err("Unauthorized".into());
    }
    if load_database_status(c, db)? != DatabaseStatus::Active {
        return Err("Conflict".into());
    }
    Ok(())
}
fn load(c: &Connection, op: &[u8]) -> R<Transfer> {
    let s: String = c
        .query_row(
            "SELECT record FROM credit_bridge_transfers WHERE operation=?1",
            params![id(op)?],
            |r| crate::sqlite::row_get(r, 0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or("NotFound")?;
    decode(s)
}
fn all(c: &Connection) -> R<Vec<Transfer>> {
    let mut q = c
        .prepare("SELECT record FROM credit_bridge_transfers LIMIT 1025")
        .map_err(|e| e.to_string())?;
    let rows = crate::sqlite::query_map(&mut q, params![], |r| {
        crate::sqlite::row_get::<String>(r, 0)
    })
    .map_err(|e| e.to_string())?;
    rows.into_iter().map(decode).collect()
}
fn terminal(t: &Transfer) -> bool {
    matches!(t.view.phase, TransferPhase::Paid | TransferPhase::Refunded)
}
fn save(c: &Transaction<'_>, t: &Transfer) -> R<()> {
    let unresolved = !terminal(t) || t.view.receiver_cleanup_pending;
    c.execute("INSERT INTO credit_bridge_transfers(operation,database_id,payer,unresolved,refund_reserve,record) VALUES(?1,?2,?3,?4,?5,?6)
         ON CONFLICT(operation) DO UPDATE SET unresolved=excluded.unresolved,refund_reserve=excluded.refund_reserve,record=excluded.record",params![id(&t.view.offer.operation)?,t.view.database_id,t.view.offer.wiki_owner.to_text(),i64::from(unresolved),if t.held {t.view.offer.amount_cycles as i64}else{0},encode(t)?]).map_err(|e|e.to_string())?;
    Ok(())
}
fn allowed(c: &Connection, t: &Transfer, p: Principal) -> R<()> {
    auth(p)?;
    if t.view.offer.wiki_owner == p {
        Ok(())
    } else {
        owner(c, &t.view.database_id, p)
    }
}
fn ledger(
    c: &Transaction<'_>,
    t: &Transfer,
    kind: &str,
    amount: i64,
    balance: i64,
    now: u64,
) -> R<()> {
    insert_database_ledger(
        c,
        DatabaseLedgerInsert {
            database_id: &t.view.database_id,
            kind,
            amount_cycles: amount,
            balance_after_cycles: balance,
            payment_amount_e8s: None,
            caller: &t.view.offer.wiki_owner.to_text(),
            method: Some("vault_credit_bridge"),
            cycles_delta: None,
            config: None,
            ledger_block_index: None,
            now: (now / 1_000_000) as i64,
        },
    )
}
fn refund(c: &Transaction<'_>, t: &mut Transfer, now: u64) -> R<()> {
    if t.held {
        let bal = database_balance_for_update(c, &t.view.database_id)?;
        let next = checked_balance_add(bal, t.view.offer.amount_cycles as i64)?;
        let cfg = load_cycles_billing_config(c)?;
        update_database_cycles_balance(
            c,
            &t.view.database_id,
            next,
            &cfg,
            (now / 1_000_000) as i64,
        )?;
        ledger(
            c,
            t,
            "bridge_refund",
            t.view.offer.amount_cycles as i64,
            next,
            now,
        )?;
        t.held = false;
    }
    t.view.phase = TransferPhase::Refunded;
    t.view.receiver_cleanup_pending = t.published;
    save(c, t)
}
fn settle_storage(c: &Transaction<'_>, db: &str, p: Principal, now: u64) -> R<()> {
    let cfg = load_cycles_billing_config(c)?;
    let size = scalar(
        c,
        "SELECT logical_size_bytes FROM databases WHERE database_id=?1",
        db,
    )?;
    billing::settle_database_storage_charge_in_tx(
        c,
        billing::StorageChargeInput {
            database_id: db,
            caller: &p.to_text(),
            size_bytes: size.max(0) as u64,
            now: (now / 1_000_000) as i64,
            config: &cfg,
        },
    )?;
    Ok(())
}
fn daily(c: &Connection, now: u64) -> R<u128> {
    Ok(all(c)?
        .iter()
        .filter(|t| t.held || (t.view.phase == TransferPhase::Paid && t.settled_day == now / DAY))
        .map(|t| u128::from(t.view.offer.amount_cycles))
        .sum())
}
fn validate_link(c: &Connection, t: &Transfer) -> R<()> {
    let l = active_link(c, t.view.offer.wiki_owner)?;
    if l.proof.challenge.vault_owner != t.view.offer.vault_owner
        || l.proof.challenge.generation != t.view.offer.link_generation
    {
        return Err("Conflict".into());
    }
    Ok(())
}

fn link_status(l: &Link) -> LinkStatus {
    LinkStatus {
        wiki_owner: l.proof.wiki_owner,
        vault_owner: l.proof.challenge.vault_owner,
        generation: l.proof.challenge.generation,
        active: l.active,
    }
}
/// Retained exact refunds take precedence over unrelated incoming grants/purchases.
pub(crate) fn refund_headroom(c: &Connection, db: &str) -> R<i64> {
    scalar(
        c,
        "SELECT COALESCE(SUM(refund_reserve),0) FROM credit_bridge_transfers WHERE database_id=?1",
        db,
    )
}
pub(crate) fn guard_delete(c: &Connection, db: &str, payer: bool) -> R<()> {
    let sql = if payer {
        "SELECT count(*) FROM credit_bridge_transfers WHERE payer=?1 AND unresolved=1"
    } else {
        "SELECT count(*) FROM credit_bridge_transfers WHERE database_id=?1 AND unresolved=1"
    };
    if scalar(c, sql, db)? > 0 {
        return Err("pending Vault credit transfer".into());
    }
    Ok(())
}

mod links;
mod transfers;

fn check_approval(t: &Transfer, approval: &TransferApproval) -> R<()> {
    match (&t.view.requested, approval) {
        (TransferAmount::All, TransferApproval::AllAvailable) => Ok(()),
        (TransferAmount::Exact(n), TransferApproval::Exact(a)) if n == a => Ok(()),
        _ => Err("Conflict".into()),
    }
}
