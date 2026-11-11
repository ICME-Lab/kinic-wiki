//! Fixed prepaid workspace for one restore per owner. Payload charges stay separate.
use super::*;
pub const BYTES: u64 = 512 * 1024;
pub const PENDING_MAX: usize = 400_000;
pub const METADATA_MAX: usize = 65_536;
pub const KEY: &str = "restore-working";
/// 400000 pending bytes + 65536 metadata bytes + 256 identities/prefixes
/// = 465792 < 524288. Header and transition are separately charged/bounded.
pub fn prepay(db: &Connection) -> Result<()> {
    save(db, KEY, &())
}
pub fn available(db: &Connection) -> Result<bool> {
    let exists: i64 = db.query_row("SELECT EXISTS(SELECT 1 FROM settings WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND key='restore-working')",params![],|r|sql::row_get(r,0)).map_err(|_|Error::Storage)?;
    Ok(exists != 0)
}
pub(crate) fn mode(db: &Connection, v: &[u8]) -> Result<bool> {
    let mode:i64=db.query_row("SELECT working_prepaid FROM restores WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND vault=?1",params![v],|r|sql::row_get(r,0)).map_err(|_|Error::Storage)?;
    Ok(mode == 1)
}
