use super::*;

fn err(_: sql::Error) -> Error {
    Error::Storage
}

pub fn check_attempt(db: &Connection, h: &Header, attempt: Option<&[u8]>) -> Result<()> {
    if h.state == VaultState::Active {
        return if attempt.is_none() {
            Ok(())
        } else {
            Err(Error::Conflict)
        };
    }
    let attempt = attempt.ok_or(Error::InvalidInput)?;
    id(attempt)?;
    let current: Vec<u8> = db
        .query_row(
            "SELECT operation FROM (SELECT * FROM vaults WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1)) WHERE id=?1",
            params![h.id],
            |r| sql::row_get(r, 0),
        )
        .map_err(err)?;
    if current != attempt {
        return Err(Error::Conflict);
    }
    Ok(())
}

pub fn list(db: &Connection, now: u64) -> Result<Vec<UnfinishedVault>> {
    // Expired creations have no payload to clean. Show the current creation
    // and any unfinished restore, including a restore undergoing cleanup.
    let mut stmt = db
        .prepare(
            "SELECT v.header,v.operation,v.expires FROM (SELECT * FROM vaults WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1)) v
         WHERE v.expires>0 AND (v.expires>?1 OR EXISTS(SELECT 1 FROM (SELECT * FROM restores WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1)) r WHERE r.vault=v.id))
         ORDER BY v.expires,v.id LIMIT 3",
        )
        .map_err(err)?;
    let rows: Vec<(String, Id, i64)> = sql::query_map(&mut stmt, params![now as i64], |r| {
        Ok((
            sql::row_get(r, 0)?,
            sql::row_get(r, 1)?,
            sql::row_get(r, 2)?,
        ))
    })
    .map_err(err)?;
    rows.into_iter()
        .map(|(raw, attempt, expires)| {
            let header: Header = serde_json::from_str(&raw).map_err(|_| Error::Storage)?;
            Ok(UnfinishedVault {
                vault: header.id,
                attempt,
                state: header.state,
                expires: expires as u64,
                cleaning: expires as u64 <= now,
            })
        })
        .collect()
}

fn receipt_key(vault: &[u8], attempt: &[u8]) -> Vec<u8> {
    // Content and activation operation IDs are exactly 16 bytes.
    [&[0u8][..], vault, attempt].concat()
}

pub fn reject_discarded(db: &Connection, vault: &[u8], attempt: &[u8], now: u64) -> Result<()> {
    let discarded: Option<i64> = db
        .query_row(
            "SELECT expires FROM (SELECT * FROM receipts WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1)) WHERE operation=?1 AND result=''",
            params![receipt_key(vault, attempt)],
            |r| sql::row_get(r, 0),
        )
        .optional()
        .map_err(err)?;
    if discarded.is_some_and(|expires| expires as u64 > now) {
        return Err(Error::Expired);
    }
    Ok(())
}

pub fn cancel(db: &Connection, v: &[u8], attempt: &[u8], now: u64) -> Result<()> {
    id(v)?;
    id(attempt)?;
    let replay: Option<i64> = db
        .query_row(
            "SELECT 1 FROM (SELECT * FROM receipts WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1)) WHERE operation=?1 AND digest=?2 AND result='' AND expires>?3",
            params![receipt_key(v, attempt), v, now as i64],
            |r| sql::row_get(r, 0),
        )
        .optional()
        .map_err(err)?;
    if replay.is_some() {
        return Ok(());
    }
    let h = header(db, v)?;
    if h.state == VaultState::Active {
        return Err(Error::Conflict);
    }
    check_attempt(db, &h, Some(attempt))?;
    db.execute(
        "UPDATE vaults SET expires=min(expires,?2) WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND (id=?1)",
        params![v, now.max(1) as i64],
    )
    .map_err(err)?;
    if h.state == VaultState::Pending {
        finish_cleanup(db, v, now)?;
    }
    Ok(())
}

pub(crate) fn collect_expired(db: &Connection, now: u64) -> Result<Option<u64>> {
    let vault: Option<Id> = db
        .query_row(
            "SELECT v.id FROM (SELECT * FROM vaults WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1)) v
         WHERE v.expires>0 AND v.expires<=?1
         ORDER BY EXISTS(SELECT 1 FROM (SELECT * FROM restores WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1)) r WHERE r.vault=v.id) DESC,v.expires,v.id LIMIT 1",
            params![now as i64],
            |r| sql::row_get(r, 0),
        )
        .optional()
        .map_err(err)?;
    let Some(vault) = vault else { return Ok(None) };
    let revision: Option<(Id, i64)> = db
        .query_row(
            "SELECT object,revision FROM (SELECT * FROM revisions WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1)) WHERE vault=?1 LIMIT 1",
            params![vault],
            |r| Ok((sql::row_get(r, 0)?, sql::row_get(r, 1)?)),
        )
        .optional()
        .map_err(err)?;
    let count = if let Some((object, revision)) = revision {
        content::remove_revision(db, &vault, &object, revision)?;
        1
    } else {
        0
    };
    finish_cleanup(db, &vault, now)?;
    Ok(Some(count))
}

fn finish_cleanup(db: &Connection, v: &[u8], now: u64) -> Result<()> {
    db.execute(
        "DELETE FROM objects WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND (vault=?1 AND object IN
         (SELECT object FROM (SELECT * FROM objects WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1)) WHERE vault=?1 ORDER BY object LIMIT 100))",
        params![v],
    )
    .map_err(err)?;
    let remaining: i64 = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM (SELECT * FROM revisions WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1)) WHERE vault=?1) OR EXISTS(SELECT 1 FROM (SELECT * FROM objects WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1)) WHERE vault=?1)",
        params![v], |r| sql::row_get(r, 0),
    ).map_err(err)?;
    if remaining == 0 {
        // Replace the charged vault row with an equally charged cancellation
        // receipt. An empty result is reserved for setup tombstones.
        let attempt: Id = db
            .query_row(
                "SELECT operation FROM (SELECT * FROM vaults WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1)) WHERE id=?1 AND expires>0",
                params![v],
                |r| sql::row_get(r, 0),
            )
            .map_err(err)?;
        db.execute(
            "INSERT INTO receipts(owner,operation,digest,result,expires) VALUES((SELECT owner FROM owner_scope WHERE slot=1),?1,?2,'',?3)
             ON CONFLICT(owner,operation) DO UPDATE SET digest=excluded.digest,expires=excluded.expires",
            params![receipt_key(v, &attempt), v, (now + DAY) as i64],
        )
        .map_err(err)?;
        db.execute("DELETE FROM restores WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND (vault=?1)", params![v])
            .map_err(err)?;
        db.execute("DELETE FROM vaults WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND (id=?1 AND expires>0)", params![v])
            .map_err(err)?;
    }
    Ok(())
}
