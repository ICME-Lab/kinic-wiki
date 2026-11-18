//! One first-key subsidy per new principal. This permanent receipt is independent
//! of Vault deletion, device caches, disposable audit logs and daily key GC.
use kinic_sqlite_compat::{self as sql, Connection, OptionalExtension, params};
use vault_types::{Error, Result};
pub const SCHEMA: &str = "CREATE TABLE key_subsidies(owner TEXT PRIMARY KEY NOT NULL,state INTEGER NOT NULL DEFAULT 0 CHECK(state IN (0,1,2)),token TEXT,attached INTEGER NOT NULL DEFAULT 0 CHECK(attached>=0 AND attached<=30000000000),actual INTEGER CHECK(actual>=0 AND actual<=attached),CHECK(state=0 OR token IS NOT NULL),CHECK(state<>2 OR (actual IS NOT NULL AND actual>0)));";
pub(crate) fn available_in(db: &Connection, owner: &str) -> Result<bool> {
    let available: i64 = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM key_subsidies WHERE owner=?1 AND state=0)",
            params![owner],
            |r| sql::row_get(r, 0),
        )
        .map_err(|_| Error::Storage)?;
    Ok(available != 0)
}
pub(crate) fn initialize_in(db: &Connection, owner: &str) -> Result<()> {
    db.execute(
        "INSERT INTO key_subsidies(owner) VALUES(?1) ON CONFLICT(owner) DO NOTHING",
        params![owner],
    )
    .map_err(|_| Error::Storage)?;
    Ok(())
}
/// Called in the same transaction as the owner's cycle reservation. Returns the
/// fee paid by the service; execution credit remains charged to the owner.
pub(crate) fn reserve_in(db: &Connection, owner: &str, token: &str, amount: u64) -> Result<u64> {
    let record: Option<(i64, Option<String>, i64)> = db
        .query_row(
            "SELECT state,token,attached FROM key_subsidies WHERE owner=?1",
            params![owner],
            |r| {
                Ok((
                    sql::row_get(r, 0)?,
                    sql::row_get(r, 1)?,
                    sql::row_get(r, 2)?,
                ))
            },
        )
        .optional()
        .map_err(|_| Error::Storage)?;
    let Some((state, previous, attached)) = record else {
        return Ok(0);
    };
    if state != 0 {
        return Ok(if previous.as_deref() == Some(token) {
            attached as u64
        } else {
            0
        });
    }
    let Some(serial) = token
        .strip_prefix("derive:")
        .and_then(|s| s.parse::<u64>().ok())
        .and_then(|s| i64::try_from(s).ok())
    else {
        return Ok(0);
    };
    let principal = candid::Principal::from_text(owner).map_err(|_| Error::Unauthorized)?;
    let fee:Option<i64>=db.query_row("SELECT payment FROM key_flights WHERE owner=?1 AND token=?2 AND phase='reserved' AND in_flight=1",params![principal.as_slice(),serial],|r|sql::row_get(r,0)).optional().map_err(|_|Error::Storage)?;
    let Some(fee) = fee else {
        return Ok(0);
    };
    let fee = u64::try_from(fee).map_err(|_| Error::Storage)?;
    if fee > amount {
        return Err(Error::InvalidInput);
    }
    db.execute("UPDATE key_subsidies SET state=1,token=?2,attached=?3,actual=NULL WHERE owner=?1 AND state=0",params![owner,token,fee as i64]).map_err(|_|Error::Storage)?;
    Ok(fee)
}
/// Translate management fees into the owner's share while settling the permanent
/// subsidy receipt. Unknown submitted costs stay reserved/consumed conservatively;
/// only a completed zero-cost outcome restores eligibility.
pub(crate) fn settle_in(
    db: &Connection,
    owner: &str,
    token: &str,
    actual: u64,
    complete: bool,
    allow_down: bool,
) -> Result<u64> {
    let record: Option<(i64, i64, Option<i64>)> = db
        .query_row(
            "SELECT state,attached,actual FROM key_subsidies WHERE owner=?1 AND token=?2",
            params![owner, token],
            |r| {
                Ok((
                    sql::row_get(r, 0)?,
                    sql::row_get(r, 1)?,
                    sql::row_get(r, 2)?,
                ))
            },
        )
        .optional()
        .map_err(|_| Error::Storage)?;
    let Some((state, attached, previous)) = record else {
        return Ok(actual);
    };
    let actual = i64::try_from(actual).map_err(|_| Error::InvalidInput)?;
    if actual > attached {
        return Err(Error::Conflict);
    }
    if previous.is_some_and(|old| old != actual && !(allow_down && old >= actual)) {
        return Err(Error::Conflict);
    }
    let next = if actual == 0 && complete {
        0
    } else if complete || state == 2 {
        2
    } else {
        1
    };
    db.execute(
        "UPDATE key_subsidies SET state=?3,actual=?4 WHERE owner=?1 AND token=?2",
        params![owner, token, next, actual],
    )
    .map_err(|_| Error::Storage)?;
    Ok(0)
}
