//! Global key-service admission, with durable reservations surviving UTC rollover/upgrades.
use super::*;
use vault_types::capacity::{KEY_OWNER_CHARGE, KEY_OWNER_ROWS, KEY_ROW, KEY_ROWS};
pub const DERIVE_RESERVATION: u64 = 30_000_000_000;
pub fn reserve(db: &Connection, token: u64, now: u64, required: u64) -> Result<()> {
    if token > i64::MAX as u64 || now > i64::MAX as u64 {
        return Err(Error::InvalidInput);
    }
    if required > DERIVE_RESERVATION {
        return Err(Error::QuotaExceeded);
    }
    let owner: Vec<u8> = db
        .query_row(
            "SELECT owner FROM owner_scope WHERE slot=1",
            params![],
            |r| sql::row_get(r, 0),
        )
        .map_err(|_| Error::Unauthorized)?;
    let (mine,all):(i64,i64)=db.query_row("SELECT COALESCE(sum(CASE WHEN owner=?1 THEN 1 ELSE 0 END),0),count(*) FROM key_flights WHERE in_flight=1",params![owner],|r|Ok((sql::row_get(r,0)?,sql::row_get(r,1)?))).map_err(|_|Error::Storage)?;
    if mine >= 1 || all >= 8 {
        return Err(Error::Busy);
    }
    let (mine,total):(i64,i64)=db.query_row("SELECT COALESCE(sum(CASE WHEN owner=?1 THEN 1 ELSE 0 END),0),count(*) FROM key_flights WHERE day=?2",params![owner,(now/DAY) as i64],|r|Ok((sql::row_get(r,0)?,sql::row_get(r,1)?))).map_err(|_|Error::Storage)?;
    if mine >= 100 || total >= 1000 {
        return Err(Error::QuotaExceeded);
    }
    // Outstanding work from earlier days still consumes today's available budget.
    let budget:i64=db.query_row("SELECT COALESCE(sum(CASE WHEN in_flight=1 THEN reserved WHEN settled>=?1 THEN actual ELSE 0 END),0) FROM key_flights",params![((now/DAY)*DAY) as i64],|r|sql::row_get(r,0)).map_err(|_|Error::Storage)?;
    if budget as u64 + DERIVE_RESERVATION > 30_000_000_000_000 {
        return Err(Error::QuotaExceeded);
    }
    admit_rows(db, 1)?;
    if owner.len() > 29
        || vault_types::capacity::row_size(&[owner.len(), "reserved".len()], 9)
            .is_none_or(|n| n > KEY_ROW)
    {
        return Err(Error::InvalidInput);
    }
    // The global 16 MiB pool already prepays this row. The historical owner billing charge remains 4096 B.
    if content::usage(db)?
        .checked_add(KEY_OWNER_CHARGE)
        .ok_or(Error::QuotaExceeded)?
        > TOTAL_MAX
    {
        return Err(Error::QuotaExceeded);
    }
    db.execute("INSERT INTO key_flights(owner,token,day,reserved,created,payment,generation) VALUES(?1,?2,?3,?4,?5,?6,COALESCE((SELECT CAST(value AS INTEGER) FROM global_settings WHERE key='generation'),0))",params![owner,token as i64,(now/DAY) as i64,DERIVE_RESERVATION as i64,now as i64,required as i64]).map_err(|_|Error::Storage)?;
    Ok(())
}
/// Callback completion may reconcile an earlier cancellation's conservative payment downwards.
pub fn settle(db: &Connection, token: u64, now: u64, actual: u64) -> Result<()> {
    settle_inner(db, token, now, actual, true)?;
    acknowledge_cancel(db, token)
}
fn settle_inner(db: &Connection, token: u64, now: u64, actual: u64, complete: bool) -> Result<()> {
    if actual > DERIVE_RESERVATION {
        return Err(Error::QuotaExceeded);
    }
    let previous:Option<(Option<i64>,String)>=db.query_row("SELECT actual,phase FROM key_flights WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND token=?1",params![token as i64],|r|Ok((sql::row_get(r,0)?,sql::row_get(r,1)?))).optional().map_err(|_|Error::Storage)?;
    let Some((old, phase)) = previous else {
        return Err(Error::NotFound);
    };
    if let Some(old) = old {
        if old != actual as i64 && !(complete && phase == "cancelled" && old >= actual as i64) {
            return Err(Error::Conflict);
        }
    }
    db.execute("UPDATE key_flights SET actual=?2,settled=?3,in_flight=CASE WHEN ?4=1 THEN 0 ELSE in_flight END WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND token=?1",params![token as i64,actual as i64,now as i64,if complete{1i64}else{0i64}]).map_err(|_|Error::Storage)?;
    Ok(())
}
/// Persisted before the management call is submitted; recovery knows exactly what was attached.
pub fn mark_sent(db: &Connection, token: u64, payment: u64) -> Result<()> {
    if payment > DERIVE_RESERVATION {
        return Err(Error::QuotaExceeded);
    }
    let exists:i64=db.query_row("SELECT EXISTS(SELECT 1 FROM key_flights WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND token=?1 AND settled IS NULL AND phase='reserved')",params![token as i64],|r|sql::row_get(r,0)).map_err(|_|Error::Storage)?;
    if exists != 1 {
        return Err(Error::Expired);
    }
    db.execute("UPDATE key_flights SET phase='sent',payment=?2 WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND token=?1 AND settled IS NULL",params![token as i64,payment as i64]).map_err(|_|Error::Storage)?;
    Ok(())
}
pub fn cancel_pending(db: &Connection, now: u64) -> Result<Option<(u64, u64, bool)>> {
    let flight:Option<(i64,i64,i64)>=db.query_row("SELECT token,CASE WHEN settled IS NOT NULL THEN actual WHEN phase='sent' THEN payment ELSE 0 END,generation FROM key_flights WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND (in_flight=1 OR phase='cancelled') ORDER BY in_flight DESC,token DESC LIMIT 1",params![],|r|Ok((sql::row_get(r,0)?,sql::row_get(r,1)?,sql::row_get(r,2)?))).optional().map_err(|_|Error::Storage)?;
    let Some((token, actual, generation)) = flight else {
        return Ok(None);
    };
    let current:i64=db.query_row("SELECT COALESCE((SELECT CAST(value AS INTEGER) FROM global_settings WHERE key='generation'),0)",params![],|r|sql::row_get(r,0)).map_err(|_|Error::Storage)?;
    let orphan = generation != current;
    settle_inner(db, token as u64, now, actual as u64, orphan)?;
    db.execute("UPDATE key_flights SET phase='cancelled' WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND token=?1",params![token]).map_err(|_|Error::Storage)?;
    Ok(Some((token as u64, actual as u64, orphan)))
}

/// A completed tombstone is retained for retries, but is no longer pending financial recovery.
pub fn acknowledge_cancel(db: &Connection, token: u64) -> Result<()> {
    db.execute("UPDATE key_flights SET phase='cancelled_done' WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND token=?1 AND in_flight=0 AND phase='cancelled'",params![token as i64]).map_err(|_|Error::Storage)?;
    Ok(())
}

/// Stored-row admission only. The service commits bounded GC separately before calling this.
pub fn admit_rows(db: &Connection, additional: usize) -> Result<()> {
    if additional == 0 || additional > KEY_OWNER_ROWS {
        return Err(Error::InvalidInput);
    }
    let (mine,total):(i64,i64)=db.query_row("SELECT COALESCE(sum(CASE WHEN owner=(SELECT owner FROM owner_scope WHERE slot=1) THEN 1 ELSE 0 END),0),count(*) FROM key_flights",params![],|r|Ok((sql::row_get(r,0)?,sql::row_get(r,1)?))).map_err(|_|Error::Storage)?;
    if mine as usize + additional > KEY_OWNER_ROWS || total as usize + additional > KEY_ROWS {
        return Err(Error::QuotaExceeded);
    }
    Ok(())
}

/// One bounded batch. Service callers commit a batch before fallible admission so
/// legacy journals above the new cap can make progress even when admission fails.
pub fn collect_completed(db: &Connection, now: u64) -> Result<Vec<Principal>> {
    const SELECT: &str = "SELECT rowid,owner FROM key_flights WHERE in_flight=0 AND phase!='cancelled' AND settled IS NOT NULL AND settled<=?1 AND day<?2 ORDER BY CASE WHEN owner=(SELECT owner FROM owner_scope WHERE slot=1) THEN 0 ELSE 1 END,settled,owner,token LIMIT 128";
    let mut statement = db.prepare(SELECT).map_err(|_| Error::Storage)?;
    let rows: Vec<(i64, Vec<u8>)> = sql::query_map(
        &mut statement,
        params![now.saturating_sub(DAY) as i64, (now / DAY) as i64],
        |r| Ok((sql::row_get(r, 0)?, sql::row_get(r, 1)?)),
    )
    .map_err(|_| Error::Storage)?;
    let mut owners = std::collections::BTreeSet::new();
    for (row, owner) in rows {
        let owner = Principal::try_from_slice(&owner).map_err(|_| Error::Storage)?;
        owners.insert(owner);
        db.execute("DELETE FROM key_flights WHERE rowid=?1", params![row])
            .map_err(|_| Error::Storage)?;
    }
    Ok(owners.into_iter().collect())
}
