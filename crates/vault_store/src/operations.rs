//! Durable owner-scoped request journal. Pending async work and completed receipts are prepaid.
use super::*;
use candid::{CandidType, decode_one, encode_one};
use sha2::{Digest, Sha256};
pub const CHARGE: u64 = 131072;
pub const CLEANUP_CHARGE: u64 = 512;
/// Persisted admission classes share one result/count/charge policy.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(i64)]
pub enum AdmissionClass {
    Ordinary = 0,
    Cleanup = 1,
    ResourceCleanup = 2,
    ProtectedKey = 3,
}
impl AdmissionClass {
    fn from_sql(value: i64) -> Result<Self> {
        match value {
            0 => Ok(Self::Ordinary),
            1 => Ok(Self::Cleanup),
            2 => Ok(Self::ResourceCleanup),
            3 => Ok(Self::ProtectedKey),
            _ => Err(Error::Storage),
        }
    }
    fn result_limit(self) -> usize {
        match self {
            Self::Ordinary => CHARGE as usize - 4096,
            Self::Cleanup | Self::ResourceCleanup => 256,
            Self::ProtectedKey => capacity::KEY_CONTROL_RESULT,
        }
    }
    fn count_limits(self) -> Option<(usize, usize)> {
        match self {
            Self::Cleanup => Some((512, capacity::CLEANUP_RECEIPTS)),
            Self::ProtectedKey => {
                Some((capacity::KEY_CONTROL_OWNER_ROWS, capacity::KEY_CONTROL_ROWS))
            }
            Self::Ordinary | Self::ResourceCleanup => None,
        }
    }
    /// Ordinary results release unused reservation; protected pools are prepaid globally.
    pub(crate) fn charge_sql(scoped: bool) -> String {
        format!(
            "CASE admission WHEN {} THEN 0 WHEN {} THEN {} WHEN {} THEN {} ELSE CASE WHEN result IS NULL THEN {} ELSE length(result)+4096 END END",
            Self::Cleanup as i64,
            Self::ResourceCleanup as i64,
            CLEANUP_CHARGE,
            Self::ProtectedKey as i64,
            if scoped { capacity::KEY_CONTROL_ROW } else { 0 },
            CHARGE
        )
    }
}
/// The durable creation identity outlives its async lease and completed receipt.
fn check_creation_binding(db: &Connection, operation: &[u8], request_digest: &[u8]) -> Result<()> {
    let vault:Option<Id>=db.query_row("SELECT id FROM vaults WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND operation=?1",params![operation],|r|sql::row_get(r,0)).optional().map_err(|_|Error::Storage)?;
    if let Some(vault) = vault {
        let bound = digest(
            b"create-vault/v1",
            &CreateVault {
                vault,
                operation: operation.to_vec(),
            },
        )?;
        if bound != request_digest {
            return Err(Error::Conflict);
        }
    }
    Ok(())
}
pub fn digest<T: CandidType>(domain: &[u8], request: &T) -> Result<Vec<u8>> {
    let wire = encode_one(request).map_err(|_| Error::InvalidInput)?;
    Ok(Sha256::digest([domain, &wire].concat()).to_vec())
}
pub fn replay<T: DeserializeOwned + CandidType>(
    db: &Connection,
    operation: &[u8],
    digest: &[u8],
    now: u64,
) -> Result<Option<T>> {
    id(operation)?;
    check_creation_binding(db, operation, digest)?;
    let prior:Option<(Vec<u8>,Option<Vec<u8>>,i64)>=db.query_row("SELECT digest,result,expires FROM operations WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND operation=?1",params![operation],|r|Ok((sql::row_get(r,0)?,sql::row_get(r,1)?,sql::row_get(r,2)?))).optional().map_err(|_|Error::Storage)?;
    if let Some((d, result, expires)) = prior {
        if d != digest {
            return Err(Error::Conflict);
        }
        if let Some(result) = result {
            if expires as u64 <= now {
                return Err(Error::Expired);
            }
            return decode_one(&result).map(Some).map_err(|_| Error::Storage);
        }
    }
    Ok(None)
}
pub fn runtime(db: &Connection) -> Result<i64> {
    db.query_row("SELECT COALESCE((SELECT CAST(value AS INTEGER) FROM global_settings WHERE key='generation'),0)",params![],|r|sql::row_get(r,0)).map_err(|_|Error::Storage)
}
pub fn begin(db: &Connection, operation: &[u8], digest: &[u8], now: u64) -> Result<u64> {
    begin_inner(db, operation, digest, now, AdmissionClass::Ordinary)
}
/// Preserve ordinary admission whenever possible; protect fresh access only when
/// content bytes or ordinary receipt slots are exhausted. Existing rows keep their class.
pub fn begin_key(db: &Connection, operation: &[u8], digest: &[u8], now: u64) -> Result<u64> {
    match begin(db, operation, digest, now) {
        Err(Error::QuotaExceeded) => {
            begin_inner(db, operation, digest, now, AdmissionClass::ProtectedKey)
        }
        result => result,
    }
}
pub fn begin_cleanup(db: &Connection, operation: &[u8], digest: &[u8], now: u64) -> Result<u64> {
    begin_inner(db, operation, digest, now, AdmissionClass::Cleanup)
}
pub fn begin_resource_cleanup(
    db: &Connection,
    operation: &[u8],
    digest: &[u8],
    now: u64,
) -> Result<u64> {
    begin_inner(db, operation, digest, now, AdmissionClass::ResourceCleanup)
}
fn begin_inner(
    db: &Connection,
    operation: &[u8],
    digest: &[u8],
    now: u64,
    class: AdmissionClass,
) -> Result<u64> {
    id(operation)?;
    check_creation_binding(db, operation, digest)?;
    let current = runtime(db)?;
    let pending:Option<(Vec<u8>,i64,i64)>=db.query_row("SELECT digest,expires,runtime FROM operations WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND operation=?1",params![operation],|r|Ok((sql::row_get(r,0)?,sql::row_get(r,1)?,sql::row_get(r,2)?))).optional().map_err(|_|Error::Storage)?;
    if let Some((d, expires, old)) = &pending {
        if d != digest {
            return Err(Error::Conflict);
        }
        if *expires as u64 > now && *old == current {
            return Err(Error::Busy);
        }
    }
    if pending.is_none() {
        collect(db, now)?;
        if let Some((owner_limit, global_limit)) = class.count_limits() {
            let (mine,all):(i64,i64)=db.query_row("SELECT COALESCE(sum(CASE WHEN owner=(SELECT owner FROM owner_scope WHERE slot=1) THEN 1 ELSE 0 END),0),count(*) FROM operations WHERE admission=?1",params![class as i64],|r|Ok((sql::row_get(r,0)?,sql::row_get(r,1)?))).map_err(|_|Error::Storage)?;
            if mine as usize >= owner_limit || all as usize >= global_limit {
                return Err(Error::QuotaExceeded);
            }
        }
        match class {
            AdmissionClass::Ordinary => {
                content::check_receipt_capacity(db, now)?;
                content::check_capacity(db, CHARGE)?;
            }
            AdmissionClass::ProtectedKey => {
                if content::usage(db)?
                    .checked_add(capacity::KEY_CONTROL_ROW as u64)
                    .ok_or(Error::QuotaExceeded)?
                    > TOTAL_MAX
                {
                    return Err(Error::QuotaExceeded);
                }
            }
            AdmissionClass::Cleanup | AdmissionClass::ResourceCleanup => {}
        }
    }
    let serial:i64=db.query_row("SELECT COALESCE((SELECT CAST(value AS INTEGER) FROM global_settings WHERE key='serial'),0)",params![],|r|sql::row_get(r,0)).map_err(|_|Error::Storage)?;
    let serial = serial.checked_add(1).ok_or(Error::QuotaExceeded)?;
    db.execute("INSERT INTO global_settings(key,value) VALUES('serial',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![serial.to_string()]).map_err(|_|Error::Storage)?;
    db.execute("INSERT INTO operations(owner,operation,digest,result,expires,token,runtime,admission) VALUES((SELECT owner FROM owner_scope WHERE slot=1),?1,?2,NULL,?3,?4,?5,?6) ON CONFLICT(owner,operation) DO UPDATE SET token=excluded.token,runtime=excluded.runtime,expires=excluded.expires",params![operation,digest,(now+300) as i64,serial,current,class as i64]).map_err(|_|Error::Storage)?;
    Ok(serial as u64)
}
pub fn fence(db: &Connection, operation: &[u8], token: u64) -> Result<()> {
    let exists:i64=db.query_row("SELECT EXISTS(SELECT 1 FROM operations WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND operation=?1 AND token=?2 AND result IS NULL AND runtime=?3)",params![operation,token as i64,runtime(db)?],|r|sql::row_get(r,0)).map_err(|_|Error::Storage)?;
    if exists == 1 {
        Ok(())
    } else {
        Err(Error::Expired)
    }
}
pub fn complete<T: CandidType>(
    db: &Connection,
    operation: &[u8],
    token: u64,
    result: &T,
    now: u64,
) -> Result<()> {
    fence(db, operation, token)?;
    let bytes = encode_one(result).map_err(|_| Error::Storage)?;
    let class:i64=db.query_row("SELECT admission FROM operations WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND operation=?1",params![operation],|r|sql::row_get(r,0)).map_err(|_|Error::Storage)?;
    if bytes.len() > AdmissionClass::from_sql(class)?.result_limit() {
        return Err(Error::QuotaExceeded);
    }
    db.execute("UPDATE operations SET result=?3,expires=?4 WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND operation=?1 AND token=?2",params![operation,token as i64,bytes,(now+DAY) as i64]).map_err(|_|Error::Storage)?;
    Ok(())
}
pub fn fail(db: &Connection, operation: &[u8], token: u64) -> Result<()> {
    db.execute("DELETE FROM operations WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND operation=?1 AND token=?2 AND result IS NULL",params![operation,token as i64]).map_err(|_|Error::Storage)?;
    Ok(())
}
pub fn collect(db: &Connection, now: u64) -> Result<()> {
    db.execute("DELETE FROM operations WHERE rowid IN (SELECT rowid FROM operations WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND expires<=?1 AND (result IS NOT NULL OR NOT EXISTS(SELECT 1 FROM key_flights k WHERE k.owner=operations.owner AND k.token=operations.token AND (k.in_flight=1 OR k.phase='cancelled'))) ORDER BY expires LIMIT 100)",params![now as i64]).map_err(|_|Error::Storage)?;
    Ok(())
}

/// Transfer an admitted distinct chunk/commit receipt from the upload reservation.
/// Existing chunk retries under a NEW operation id use fresh capacity, preserving the commit budget.
pub fn begin_upload(
    db: &Connection,
    operation: &[u8],
    digest: &[u8],
    now: u64,
    upload: &[u8],
    index: Option<u32>,
) -> Result<u64> {
    id(upload)?;
    let already_present = if let Some(index) = index {
        let n:i64=db.query_row("SELECT count(*) FROM chunks WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND upload=?1 AND idx=?2",params![upload,index as i64],|r|sql::row_get(r,0)).map_err(|_|Error::Storage)?;
        n != 0
    } else {
        false
    };
    if !already_present {
        let budget:Option<i64>=db.query_row("SELECT receipt_budget FROM uploads WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND id=?1",params![upload],|r|sql::row_get(r,0)).optional().map_err(|_|Error::Storage)?;
        if budget.is_some_and(|n| n >= CHARGE as i64) {
            db.execute("UPDATE uploads SET reserved=reserved-?2,receipt_budget=receipt_budget-?2 WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND id=?1",params![upload,CHARGE as i64]).map_err(|_|Error::Storage)?;
        }
    }
    begin(db, operation, digest, now)
}
