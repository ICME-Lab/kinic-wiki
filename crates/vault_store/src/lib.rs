use candid::Principal;
pub use kinic_sqlite_compat;
use kinic_sqlite_compat::{self as sql, Connection, OptionalExtension, params};
use serde::{Serialize, de::DeserializeOwned};
use vault_types::*;
pub const SCHEMA: &str = concat!(
    include_str!("schema.sql"),
    include_str!("key-capacity-schema.sql")
);
pub const CONTENT_SCHEMA: &str = include_str!("content-schema.sql");
pub const EXPIRY_SCHEMA: &str = include_str!("expiry-schema.sql");
pub mod content;
pub mod keys;
pub mod operations;
#[cfg(test)]
mod tests;
mod uploads;
pub fn load<T: DeserializeOwned>(db: &Connection, key: &str) -> Result<Option<T>> {
    let raw:Option<String>=db.query_row("SELECT value FROM settings WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND key=?1",params![key],|r|sql::row_get(r,0)).optional().map_err(|_|Error::Storage)?;
    raw.map(|s| serde_json::from_str(&s).map_err(|_| Error::Storage))
        .transpose()
}
pub fn save<T: Serialize>(db: &Connection, key: &str, value: &T) -> Result<()> {
    let raw = serde_json::to_string(value).map_err(|_| Error::Storage)?;
    if raw.len() > 4096 || key.len() > 64 {
        return Err(Error::QuotaExceeded);
    }
    let prior:Option<i64>=db.query_row("SELECT length(value)+length(key)+256 FROM settings WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND key=?1",params![key],|r|sql::row_get(r,0)).optional().map_err(|_|Error::Storage)?;
    let extra = (raw.len() + key.len() + 256).saturating_sub(prior.unwrap_or(0) as usize);
    if extra > 0 {
        content::check_capacity(db, extra as u64)?;
    }
    db.execute("INSERT INTO settings(owner,key,value) VALUES((SELECT owner FROM owner_scope WHERE slot=1),?1,?2) ON CONFLICT(owner,key) DO UPDATE SET value=excluded.value",params![key,raw]).map_err(|_|Error::Storage)?;
    Ok(())
}
pub fn config(db: &Connection) -> Result<VaultConfig> {
    let raw: Option<String> = db
        .query_row(
            "SELECT value FROM global_settings WHERE key='config'",
            params![],
            |r| sql::row_get(r, 0),
        )
        .optional()
        .map_err(|_| Error::Storage)?;
    serde_json::from_str(&raw.ok_or(Error::Unauthorized)?).map_err(|_| Error::Storage)
}
pub fn header(db: &Connection, vault: &[u8]) -> Result<Header> {
    id(vault)?;
    let raw:Option<String>=db.query_row("SELECT header FROM vaults WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND id=?1",params![vault],|r|sql::row_get(r,0)).optional().map_err(|_|Error::Storage)?;
    serde_json::from_str(&raw.ok_or(Error::NotFound)?).map_err(|_| Error::Storage)
}
pub fn put_header(db: &Connection, h: &Header) -> Result<()> {
    let raw = serde_json::to_string(h).map_err(|_| Error::Storage)?;
    db.execute("UPDATE vaults SET header=?2 WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND id=?1",params![h.id,raw]).map_err(|_|Error::Storage)?;
    Ok(())
}
pub fn active(db: &Connection, vault: &[u8]) -> Result<Header> {
    let h = header(db, vault)?;
    if h.state != VaultState::Active {
        return Err(Error::Conflict);
    }
    Ok(h)
}
pub fn list(db: &Connection) -> Result<Vec<Header>> {
    let mut stmt=db.prepare("SELECT header FROM vaults WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND json_extract(header,'$.state')<>'Deleted' ORDER BY id LIMIT 3").map_err(|_|Error::Storage)?;
    let rows: Vec<String> =
        sql::query_map(&mut stmt, params![], |r| sql::row_get(r, 0)).map_err(|_| Error::Storage)?;
    rows.into_iter()
        .map(|s| serde_json::from_str(&s).map_err(|_| Error::Storage))
        .collect()
}
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
