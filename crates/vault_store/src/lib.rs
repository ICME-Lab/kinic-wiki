mod accounting_capacity;
use candid::Principal;
use kinic_sqlite_compat::{self as sql, Connection, OptionalExtension, params};
use serde::{Serialize, de::DeserializeOwned};
use vault_types::*;

pub use kinic_sqlite_compat;
pub const SCHEMA: &str = concat!(
    include_str!("schema.sql"),
    include_str!("wrapper-schema.sql"),
    include_str!("key-capacity-schema.sql")
);

// Store functions are synchronous. The caller must provide one transaction per operation.
pub fn load<T: DeserializeOwned>(db: &Connection, key: &str) -> Result<Option<T>> {
    let raw: Option<String> = db
        .query_row(
            "SELECT value FROM (SELECT * FROM settings WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1)) WHERE key=?1",
            params![key],
            |r| sql::row_get(r, 0),
        )
        .optional()
        .map_err(|_| Error::Storage)?;
    raw.filter(|s| s != "null")
        .map(|s| serde_json::from_str(&s).map_err(|_| Error::Storage))
        .transpose()
}
pub fn save<T: Serialize>(db: &Connection, key: &str, value: &T) -> Result<()> {
    let text = serde_json::to_string(value).map_err(|_| Error::Storage)?;
    if text.len() > 65536 {
        return Err(Error::QuotaExceeded);
    }
    let existing:Option<String>=db.query_row("SELECT value FROM settings WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND key=?1",params![key],|r|sql::row_get(r,0)).optional().map_err(|_|Error::Storage)?;
    let reserved = matches!(
        key,
        "control"
            | "candidate"
            | "cleanup"
            | "authorities"
            | "bootstrap"
            | "transition"
            | "grant-ceremony"
            | "grant-random"
    ) || key.starts_with("grant:")
        || key.starts_with("grant-slot:")
        || key.starts_with("credential-slot:");
    let extra = if key == restore_working::KEY {
        if existing.is_some() {
            0
        } else {
            restore_working::BYTES
        }
    } else if reserved {
        if existing.is_some() { 0 } else { 65536 }
    } else {
        text.len()
            .saturating_sub(existing.as_ref().map_or(0, |s| s.len())) as u64
            + if existing.is_some() { 0 } else { 256 }
    };
    if extra > 0 {
        content::check_capacity(db, extra)?;
    }
    db.execute("INSERT INTO settings(owner,key,value) VALUES((SELECT owner FROM owner_scope WHERE slot=1),?1,?2) ON CONFLICT(owner,key) DO UPDATE SET value=excluded.value",params![key,text]).map_err(|_|Error::Storage)?;
    Ok(())
}
pub fn config(db: &Connection) -> Result<Config> {
    let global: Option<String> = db
        .query_row(
            "SELECT value FROM global_settings WHERE key='config'",
            params![],
            |r| sql::row_get(r, 0),
        )
        .optional()
        .map_err(|_| Error::Storage)?;
    if let Some(raw) = global {
        let c: VaultConfig = serde_json::from_str(&raw).map_err(|_| Error::Storage)?;
        let owner: Vec<u8> = db
            .query_row(
                "SELECT owner FROM owner_scope WHERE slot=1",
                params![],
                |r| sql::row_get(r, 0),
            )
            .map_err(|_| Error::Unauthorized)?;
        return Ok(Config {
            owner: Principal::from_slice(&owner),
            origin: c.origin,
            rp_id: c.rp_id,
            key_name: c.key_name,
            minimum_cycles: c.minimum_cycles,
        });
    }
    load(db, "config")?.ok_or(Error::Unauthorized)
}
pub fn authorize(db: &Connection, caller: Principal) -> Result<Config> {
    let c = config(db)?;
    if caller == Principal::anonymous() || caller != c.owner {
        return Err(Error::Unauthorized);
    }
    Ok(c)
}
pub fn header(db: &Connection, vault: &[u8]) -> Result<Header> {
    id(vault)?;
    let text: Option<String> = db
        .query_row(
            "SELECT header FROM (SELECT * FROM vaults WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1)) WHERE id=?1",
            params![vault],
            |r| sql::row_get(r, 0),
        )
        .optional()
        .map_err(|_| Error::Storage)?;
    serde_json::from_str(&text.ok_or(Error::NotFound)?).map_err(|_| Error::Storage)
}
pub fn put_header(db: &Connection, h: &Header) -> Result<()> {
    let text = serde_json::to_string(h).map_err(|_| Error::Storage)?;
    db.execute(
        "UPDATE vaults SET header=?2 WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND (id=?1)",
        params![h.id, text],
    )
    .map_err(|_| Error::Storage)?;
    Ok(())
}
pub fn active(db: &Connection, vault: &[u8]) -> Result<Header> {
    let h = header(db, vault)?;
    if h.state != VaultState::Active {
        return Err(Error::Conflict);
    }
    Ok(h)
}
pub fn reserve(db: &Connection, caller: Principal, r: Reserve, now: u64) -> Result<Header> {
    incident::owner_change_allowed(db)?;
    reserve_inner(db, caller, r, now)
}
/// Only the exact shared-slot creation may bypass the generic owner-job guard.
pub fn reserve_empty(db: &Connection, caller: Principal, job: &[u8], now: u64) -> Result<Header> {
    let j = transition::load_state(db)?
        .creation
        .filter(|j| j.job == job && j.phase == CreateEmptyPhase::Admitted)
        .ok_or(Error::Unauthorized)?;
    reserve_inner(
        db,
        caller,
        Reserve {
            vault: j.target.vault,
            operation: j.target.attempt,
        },
        now,
    )
}
fn reserve_inner(db: &Connection, caller: Principal, r: Reserve, now: u64) -> Result<Header> {
    let c = authorize(db, caller)?;
    id(&r.vault)?;
    id(&r.operation)?;
    setup::reject_discarded(db, &r.vault, &r.operation, now)?;
    let previous: Option<Vec<u8>> = db
        .query_row(
            "SELECT operation FROM (SELECT * FROM vaults WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1)) WHERE id=?1",
            params![r.vault],
            |row| sql::row_get(row, 0),
        )
        .optional()
        .map_err(|_| Error::Storage)?;
    if let Some(op) = previous {
        if op != r.operation {
            return Err(Error::Conflict);
        }
        let h = header(db, &r.vault)?;
        if h.state != VaultState::Pending {
            return Err(Error::Conflict);
        }
        pending(db, &r.vault, now)?;
        return Ok(h);
    }
    content::check_receipt_capacity(db, now)?;
    let ever: i64 = db
        .query_row("SELECT count(*) FROM (SELECT * FROM vaults WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1))", params![], |r| {
            sql::row_get(r, 0)
        })
        .map_err(|_| Error::Storage)?;
    if ever >= 10000 {
        return Err(Error::QuotaExceeded);
    }
    content::check_capacity(db, 8192)?;
    let total: i64 = db
        .query_row(
            "SELECT count(*) FROM (SELECT * FROM vaults WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1)) WHERE expires=0 OR expires>?1",
            params![now as i64],
            |row| sql::row_get(row, 0),
        )
        .map_err(|_| Error::Storage)?;
    if total >= 3 {
        return Err(Error::QuotaExceeded);
    }
    let pending: i64 = db
        .query_row(
            "SELECT count(*) FROM (SELECT * FROM vaults WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1)) WHERE expires>?1",
            params![now as i64],
            |row| sql::row_get(row, 0),
        )
        .map_err(|_| Error::Storage)?;
    if pending > 0 {
        return Err(Error::Busy);
    }
    let h = Header {
        published_slot: None,
        generation: None,
        recovery_verifier: vec![],
        id: r.vault,
        epoch: 0,
        state: VaultState::Pending,
        normal: None,
        recovery: None,
        sequence: 0,
        backup_sequence: None,
        backup_at: None,
        key_name: c.key_name,
    };
    let raw = serde_json::to_string(&h).map_err(|_| Error::Storage)?;
    db.execute(
        "INSERT INTO vaults(owner,id,operation,expires,header) VALUES((SELECT owner FROM owner_scope WHERE slot=1),?1,?2,?3,?4)",
        params![h.id, r.operation, (now + DAY) as i64, raw],
    )
    .map_err(|_| Error::Storage)?;
    Ok(h)
}
pub fn pending(db: &Connection, vault: &[u8], now: u64) -> Result<Header> {
    let h = header(db, vault)?;
    if h.state != VaultState::Pending && h.state != VaultState::Restoring {
        return Err(Error::Conflict);
    }
    let expires: i64 = db
        .query_row(
            "SELECT expires FROM (SELECT * FROM vaults WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1)) WHERE id=?1",
            params![vault],
            |r| sql::row_get(r, 0),
        )
        .map_err(|_| Error::Storage)?;
    if expires as u64 <= now {
        return Err(Error::Expired);
    }
    Ok(h)
}
pub fn list(db: &Connection) -> Result<Vec<Header>> {
    let mut stmt = db
        .prepare("SELECT header FROM (SELECT * FROM vaults WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1)) WHERE expires=0 ORDER BY id LIMIT 3")
        .map_err(|_| Error::Storage)?;
    let raw: Vec<String> =
        sql::query_map(&mut stmt, params![], |r| sql::row_get(r, 0)).map_err(|_| Error::Storage)?;
    raw.into_iter()
        .map(|s| serde_json::from_str(&s).map_err(|_| Error::Storage))
        .collect()
}
pub mod content;
#[cfg(test)]
mod tests;
pub const CONTENT_SCHEMA: &str = include_str!("content-schema.sql");
pub mod restore;
pub const RESTORE_SCHEMA: &str = concat!(
    include_str!("restore-schema.sql"),
    include_str!("restore-working-schema.sql")
);

pub mod setup;

/// An authenticated principal bound by the embedding canister, never by a request body.
/// Scope exists only during one synchronous transaction; no SQL or scope crosses an await.
#[derive(Clone, Copy)]
pub struct OwnerContext(Principal);
impl OwnerContext {
    pub fn authenticated(owner: Principal) -> Result<Self> {
        if owner == Principal::anonymous() || owner == Principal::management_canister() {
            return Err(Error::Unauthorized);
        }
        Ok(Self(owner))
    }
    pub fn owner(self) -> Principal {
        self.0
    }
    pub fn run<T>(self, db: &Connection, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        select_owner(db, self.0)?;
        let result = f(db);
        // A committed transaction must never retain a usable owner context.
        let cleared = db
            .execute("DELETE FROM owner_scope", params![])
            .map_err(|_| Error::Storage);
        cleared?;
        result
    }
}
fn select_owner(db: &Connection, owner: Principal) -> Result<()> {
    OwnerContext::authenticated(owner)?;
    db.execute("INSERT INTO owner_scope(slot,owner) VALUES(1,?1) ON CONFLICT(slot) DO UPDATE SET owner=excluded.owner",params![owner.as_slice()]).map_err(|_|Error::Storage)?;
    Ok(())
}
pub mod keys;
pub const EXPIRY_SCHEMA: &str = include_str!("expiry-schema.sql");

pub mod cleanup;

pub mod format;

pub mod overlays;

pub mod incident;

pub const KEY_CAPACITY_SCHEMA: &str = include_str!("key-capacity-schema.sql");

pub mod transition;

pub mod restore_working;

mod uploads;
