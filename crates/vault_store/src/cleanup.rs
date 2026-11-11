//! Terminal deletion in fixed-size batches: at most one 1 MiB chunk or one control row.
use super::*;
pub fn purge_batch(db: &Connection, targets: &[Id]) -> Result<bool> {
    if targets.is_empty() || targets.len() > 3 {
        return Err(Error::InvalidInput);
    }
    // Freeze all selected instances before touching any data. Headers remain until every
    // chunk/control row has gone so a newly authenticated cleanup grant can resume.
    for v in targets {
        let mut h = header(db, v)?;
        h.state = VaultState::Purging;
        put_header(db, &h)?;
    }
    for v in targets {
        for table in [
            "revision_chunks",
            "chunks",
            "wrapper_slots",
            "revisions",
            "uploads",
            "objects",
            "exports",
            "restores",
        ] {
            let condition = if table == "chunks" {
                "upload IN (SELECT id FROM uploads WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND vault=?1)"
            } else {
                "vault=?1"
            };
            // Table names are static, never request data.
            let query = format!(
                "DELETE FROM {table} WHERE rowid IN (SELECT rowid FROM {table} WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND {condition} ORDER BY rowid LIMIT 1)"
            );
            db.execute(&query, params![v.as_slice()])
                .map_err(|_| Error::Storage)?;
            let count = changes(db)?;
            if count > 0 {
                return Ok(false);
            }
        }
    }
    for v in targets {
        db.execute(
            "DELETE FROM vaults WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND id=?1",
            params![v.as_slice()],
        )
        .map_err(|_| Error::Storage)?;
    }
    Ok(true)
}

/// Only expired upload/export rows of the authenticated target set. Never unpins active exports
/// or garbage collects frozen source history. A call affects at most one SQL row/1 MiB blob.
pub fn expired_batch(db: &Connection, targets: &[Id], now: u64) -> Result<bool> {
    for v in targets {
        let upload:Option<Id>=db.query_row("SELECT id FROM uploads WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND vault=?1 AND expires<=?2 ORDER BY id LIMIT 1",params![v.as_slice(),now as i64],|r|sql::row_get(r,0)).optional().map_err(|_|Error::Storage)?;
        if let Some(u) = upload {
            db.execute("DELETE FROM chunks WHERE rowid IN (SELECT rowid FROM chunks WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND upload=?1 ORDER BY idx LIMIT 1)",params![u]).map_err(|_|Error::Storage)?;
            let n = changes(db)?;
            if n == 0 {
                db.execute("DELETE FROM uploads WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND id=?1",params![u]).map_err(|_|Error::Storage)?;
            }
            return Ok(false);
        }
        db.execute("DELETE FROM exports WHERE rowid IN (SELECT rowid FROM exports WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND vault=?1 AND expires<=?2 ORDER BY id LIMIT 1)",params![v.as_slice(),now as i64]).map_err(|_|Error::Storage)?;
        if changes(db)? > 0 {
            return Ok(false);
        }
    }
    Ok(true)
}

fn changes(db: &Connection) -> Result<i64> {
    db.query_row("SELECT changes()", params![], |r| sql::row_get(r, 0))
        .map_err(|_| Error::Storage)
}
