use super::*;
pub use crate::uploads::{cancel_upload_batch, pending_uploads, upload_status};
use sha2::{Digest, Sha256};
const OVERHEAD: u64 = 4096;
const ROW_MAX: i64 = 10000;
fn db_error(_: sql::Error) -> Error {
    Error::Storage
}
fn num(db: &Connection, q: &str, vault: &[u8]) -> Result<u64> {
    let n: i64 = db
        .query_row(q, params![vault], |r| sql::row_get(r, 0))
        .map_err(db_error)?;
    Ok(n as u64)
}
fn head(db: &Connection, v: &[u8], o: &[u8]) -> Result<u64> {
    Ok(db
        .query_row(
            "SELECT head FROM (SELECT * FROM objects WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1)) WHERE vault=?1 AND object=?2",
            params![v, o],
            |r| sql::row_get::<i64>(r, 0),
        )
        .optional()
        .map_err(db_error)?
        .unwrap_or(0) as u64)
}
// Recheck at the write boundary: reservations in other vaults may have committed.
pub(crate) fn check_object_capacity(db: &Connection, v: &[u8], o: &[u8]) -> Result<()> {
    let count: i64 = db
        .query_row("SELECT count(*) FROM objects", params![], |r| {
            sql::row_get(r, 0)
        })
        .map_err(db_error)?;
    if count >= ROW_MAX && head(db, v, o)? == 0 {
        return Err(Error::QuotaExceeded);
    }
    Ok(())
}
pub(crate) fn check_revision_capacity(db: &Connection) -> Result<()> {
    let count: i64 = db
        .query_row("SELECT count(*) FROM revisions", params![], |r| {
            sql::row_get(r, 0)
        })
        .map_err(db_error)?;
    if count >= ROW_MAX {
        return Err(Error::QuotaExceeded);
    }
    Ok(())
}
fn next_sequence(sequence: u64) -> Result<u64> {
    if sequence >= i64::MAX as u64 {
        return Err(Error::QuotaExceeded);
    }
    Ok(sequence + 1)
}
pub fn quota(db: &Connection, v: &[u8]) -> Result<Quota> {
    active(db, v)?;
    let current = num(
        db,
        "SELECT COALESCE(sum(r.plain_size),0) FROM (SELECT * FROM revisions WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1)) r JOIN (SELECT * FROM objects WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1)) o ON r.vault=o.vault AND r.object=o.object AND r.revision=o.head WHERE r.vault=?1 AND r.deleted=0 AND o.purged=0",
        v,
    )?;
    let reserved:i64=db.query_row("SELECT COALESCE(sum(reserved),0) FROM uploads WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1)",params![],|r|sql::row_get(r,0)).map_err(db_error)?;
    let reserved = reserved as u64;
    let charged = usage(db)?.saturating_sub(reserved);
    Ok(Quota {
        current,
        charged,
        reserved,
        limit: TOTAL_MAX,
    })
}
fn measured_usage(db: &Connection, scoped: bool) -> Result<u64> {
    let scope = if scoped {
        " WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1)"
    } else {
        ""
    };
    let mut total = 262144u64;
    for (table, expression) in [
        (
            "settings",
            if scoped {
                "length(value)+length(key)+256"
            } else {
                // Only the bounded current-flight setting uses the prepaid control pool.
                "CASE WHEN key='derive' AND length(value)+length(key)+256<=512 AND length(value)+length(key)+length(owner)+12<=512 AND EXISTS(SELECT 1 FROM key_flights k WHERE k.owner=settings.owner AND k.token=json_extract(settings.value,'$[0]') AND k.in_flight=1) THEN 0 ELSE length(value)+length(key)+256 END"
            },
        ),
        ("vaults", "8192+cleanup_budget*512"),
        ("revisions", "charge"),
        ("uploads", "reserved"),
        ("receipts", "length(result)+length(digest)+4096"),
        ("objects", "4096+(1-purged)*512"),
        (
            "operations",
            if scoped {
                "CASE cleanup WHEN 1 THEN 0 WHEN 2 THEN 512 WHEN 3 THEN 2048 ELSE CASE WHEN result IS NULL THEN 131072 ELSE length(result)+4096 END END"
            } else {
                "CASE cleanup WHEN 1 THEN 0 WHEN 2 THEN 512 WHEN 3 THEN 0 ELSE CASE WHEN result IS NULL THEN 131072 ELSE length(result)+4096 END END"
            },
        ),
    ] {
        let n: i64 = db
            .query_row(
                &format!("SELECT COALESCE(sum({expression}),0) FROM {table}{scope}"),
                params![],
                |r| sql::row_get(r, 0),
            )
            .map_err(db_error)?;
        total = total.checked_add(n as u64).ok_or(Error::QuotaExceeded)?;
    }
    if scoped {
        let n:i64=db.query_row("SELECT count(*) FROM key_flights WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1)",params![],|r|sql::row_get(r,0)).map_err(db_error)?;
        total += n as u64 * 4096;
    } else {
        total += capacity::ACCOUNTING_POOL;
    }
    Ok(total)
}
pub fn usage(db: &Connection) -> Result<u64> {
    measured_usage(db, true)
}
pub fn global_usage(db: &Connection) -> Result<u64> {
    measured_usage(db, false)
}
pub fn global_capacity(db: &Connection) -> Result<GlobalCapacity> {
    let used = global_usage(db)?;
    Ok(GlobalCapacity {
        used,
        limit: TOTAL_MAX,
        accounting_reserved: capacity::ACCOUNTING_POOL,
        overcommitted: used > TOTAL_MAX,
        overage: used.saturating_sub(TOTAL_MAX),
    })
}
pub fn check_capacity(db: &Connection, extra: u64) -> Result<()> {
    if usage(db)?.checked_add(extra).ok_or(Error::QuotaExceeded)? > TOTAL_MAX
        || global_usage(db)?
            .checked_add(extra)
            .ok_or(Error::QuotaExceeded)?
            > TOTAL_MAX
    {
        return Err(Error::QuotaExceeded);
    }
    Ok(())
}
fn receipt<T: DeserializeOwned>(
    db: &Connection,
    operation: &[u8],
    digest: &[u8],
) -> Result<Option<T>> {
    let prior: Option<(Vec<u8>, String)> = db
        .query_row(
            "SELECT digest,result FROM (SELECT * FROM receipts WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1)) WHERE operation=?1",
            params![operation],
            |r| Ok((sql::row_get(r, 0)?, sql::row_get(r, 1)?)),
        )
        .optional()
        .map_err(db_error)?;
    prior
        .map(|(d, s)| {
            if d != digest {
                return Err(Error::Conflict);
            }
            if crate::uploads::cancelled(&s).is_some() {
                return Err(Error::Conflict);
            }
            if s == "\"Expired\"" {
                return Err(Error::Expired);
            }
            serde_json::from_str(&s).map_err(|_| Error::Storage)
        })
        .transpose()
}
pub fn record<T: Serialize>(
    db: &Connection,
    operation: &[u8],
    digest: &[u8],
    result: &T,
    now: u64,
) -> Result<()> {
    check_receipt_capacity(db, now)?;
    let upload: i64 = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM (SELECT * FROM uploads WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1)) WHERE id=?1)",
            params![operation],
            |r| sql::row_get(r, 0),
        )
        .map_err(db_error)?;
    if upload != 0 {
        return Err(Error::Conflict);
    }
    let encoded = serde_json::to_string(result).map_err(|_| Error::Storage)?;
    check_capacity(db, OVERHEAD + encoded.len() as u64 + digest.len() as u64)?;
    db.execute(
        "INSERT INTO receipts VALUES((SELECT owner FROM owner_scope WHERE slot=1),?1,?2,?3,?4)",
        params![operation, digest, encoded, (now + DAY) as i64],
    )
    .map_err(db_error)?;
    Ok(())
}
fn receipt_slots_used(db: &Connection) -> Result<i64> {
    db.query_row(
        "SELECT (SELECT count(*) FROM operations WHERE cleanup=0 AND owner=(SELECT owner FROM owner_scope WHERE slot=1))+(SELECT count(*) FROM (SELECT * FROM receipts WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1)))
              + (SELECT COALESCE(sum(1+receipt_budget/131072),0) FROM (SELECT * FROM uploads WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1)))",
        params![],
        |r| sql::row_get(r, 0),
    )
    .map_err(db_error)
}

fn global_receipt_slots_used(db: &Connection) -> Result<i64> {
    db.query_row(
        "SELECT (SELECT count(*) FROM operations WHERE cleanup=0)+(SELECT count(*) FROM receipts)
              + (SELECT COALESCE(sum(1+receipt_budget/131072),0) FROM uploads)",
        params![],
        |r| sql::row_get(r, 0),
    )
    .map_err(db_error)
}

pub fn collect_expired_receipts(db: &Connection, now: u64) -> Result<()> {
    // Global maintenance selects the owner before binding scope; this pass touches only that owner.
    db.execute("DELETE FROM receipts WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND operation IN (SELECT operation FROM receipts WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND expires<=?1 ORDER BY expires,operation LIMIT 100)",params![now as i64]).map_err(db_error)?;
    Ok(())
}
pub fn check_receipt_capacity(db: &Connection, now: u64) -> Result<()> {
    check_receipt_capacity_for(db, now, 1)
}
fn check_receipt_capacity_for(db: &Connection, now: u64, additional: i64) -> Result<()> {
    collect_expired_receipts(db, now)?;
    if receipt_slots_used(db)? + additional > ROW_MAX
        || global_receipt_slots_used(db)? + additional > ROW_MAX
    {
        return Err(Error::QuotaExceeded);
    }
    Ok(())
}
pub fn begin(db: &Connection, r: BeginRevision, now: u64) -> Result<Upload> {
    begin_with_budget(db, r, now, true)
}
pub fn begin_with_budget(
    db: &Connection,
    r: BeginRevision,
    now: u64,
    allow_new: bool,
) -> Result<Upload> {
    active(db, &r.vault)?;
    id(&r.object)?;
    reject_purged(db, &r.vault, &r.object)?;
    id(&r.operation)?;
    if r.expected_revision >= i64::MAX as u64
        || r.plain_size > FILE_MAX
        || r.manifest.is_empty()
        || r.manifest.len() > 65536
        || r.chunk_hashes.len() != r.plain_size.div_ceil(1024 * 1024).max(1) as usize
        || r.chunk_hashes.iter().any(|h| h.len() != 32)
    {
        return Err(Error::InvalidInput);
    }
    let raw = serde_json::to_string(&r).map_err(|_| Error::Storage)?;
    let digest = Sha256::digest(raw.as_bytes()).to_vec();
    // A committed operation is never re-created as a new upload.
    if let Some(rev) = receipt::<Revision>(db, &r.operation, &digest)? {
        return Ok(Upload {
            id: r.operation,
            revision: rev.revision,
            expires: 0,
        });
    }
    let prior: Option<(Vec<u8>, i64, Option<Id>)> = db
        .query_row(
            "SELECT digest,expires,cancel_job FROM (SELECT * FROM uploads WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1)) WHERE id=?1",
            params![r.operation],
            |row| Ok((sql::row_get(row, 0)?, sql::row_get(row, 1)?, sql::row_get(row,2)?)),
        )
        .optional()
        .map_err(db_error)?;
    if let Some((d, e, cancel_job)) = prior {
        if cancel_job.is_some() {
            return Err(Error::Conflict);
        }
        if d != digest {
            return Err(Error::Conflict);
        }
        if e as u64 <= now {
            return Err(Error::Expired);
        }
        return Ok(Upload {
            id: r.operation,
            revision: r.expected_revision + 1,
            expires: e as u64,
        });
    }
    if !allow_new {
        return Err(Error::QuotaExceeded);
    }
    check_receipt_capacity(db, now)?;
    check_object_capacity(db, &r.vault, &r.object)?;
    if head(db, &r.vault, &r.object)? != r.expected_revision {
        return Err(Error::Conflict);
    }
    check_revision_capacity(db)?;
    let existing: Option<i64> = db
        .query_row(
            "SELECT expires FROM (SELECT * FROM uploads WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1)) WHERE vault=?1",
            params![r.vault],
            |row| sql::row_get(row, 0),
        )
        .optional()
        .map_err(db_error)?;
    if existing.is_some() {
        return Err(Error::Busy);
    }
    let q = quota(db, &r.vault)?;
    let old = if r.expected_revision > 0 {
        manifest(db, &r.vault, &r.object, r.expected_revision)?.plain_size
    } else {
        0
    };
    if q.current.saturating_sub(old) + r.plain_size > VAULT_MAX {
        return Err(Error::QuotaExceeded);
    }
    let receipt_budget = (r.chunk_hashes.len() as u64 + 1) * operations::CHARGE;
    check_receipt_capacity_for(db, now, r.chunk_hashes.len() as i64 + 2)?;
    // Include one separate purge receipt for a newly admitted object.
    let cleanup_budget = r.chunk_hashes.len() as u64 + 3;
    let reserved = receipt_budget
        + cleanup_budget * operations::CLEANUP_CHARGE
        + r.plain_size
        + r.chunk_hashes.len() as u64 * (16 + OVERHEAD)
        + raw.len() as u64 * 2
        + OVERHEAD * 3;
    check_capacity(db, reserved)?;
    db.execute(
        "INSERT INTO uploads(owner,id,vault,object,expected,expires,digest,request,reserved,receipt_budget,cleanup_budget) VALUES((SELECT owner FROM owner_scope WHERE slot=1),?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
        params![
            r.operation,
            r.vault,
            r.object,
            r.expected_revision as i64,
            (now + DAY) as i64,
            digest,
            raw,
            reserved as i64,
            receipt_budget as i64,
            cleanup_budget as i64
        ],
    )
    .map_err(db_error)?;
    Ok(Upload {
        id: r.operation,
        revision: r.expected_revision + 1,
        expires: now + DAY,
    })
}
fn upload(db: &Connection, id: &[u8], now: u64) -> Result<(BeginRevision, Vec<u8>, u64)> {
    vault_types::id(id)?;
    let (raw, d, e, cancel_job): (String, Vec<u8>, i64, Option<Id>) = db
        .query_row(
            "SELECT request,digest,expires,cancel_job FROM (SELECT * FROM uploads WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1)) WHERE id=?1",
            params![id],
            |row| {
                Ok((
                    sql::row_get(row, 0)?,
                    sql::row_get(row, 1)?,
                    sql::row_get(row, 2)?,
                    sql::row_get(row, 3)?,
                ))
            },
        )
        .optional()
        .map_err(db_error)?
        .ok_or(Error::NotFound)?;
    if cancel_job.is_some() {
        return Err(Error::Conflict);
    }
    if e as u64 <= now {
        return Err(Error::Expired);
    }
    let r: BeginRevision = serde_json::from_str(&raw).map_err(|_| Error::Storage)?;
    active(db, &r.vault)?;
    Ok((r, d, e as u64))
}
pub fn put(db: &Connection, id: &[u8], index: u32, bytes: &[u8], now: u64) -> Result<()> {
    let (r, _, _) = upload(db, id, now)?;
    let idx = index as usize;
    if idx >= r.chunk_hashes.len() || bytes.len() > CHUNK_MAX {
        return Err(Error::InvalidInput);
    }
    let expected = (r
        .plain_size
        .saturating_sub(idx as u64 * 1024 * 1024)
        .min(1024 * 1024)
        + 16) as usize;
    if bytes.len() != expected || Sha256::digest(bytes)[..] != r.chunk_hashes[idx] {
        return Err(Error::InvalidInput);
    }
    let old: Option<Vec<u8>> = db
        .query_row(
            "SELECT data FROM (SELECT * FROM chunks WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1)) WHERE upload=?1 AND idx=?2",
            params![id, index as i64],
            |row| sql::row_get(row, 0),
        )
        .optional()
        .map_err(db_error)?;
    if let Some(old) = old {
        if old == bytes {
            return Ok(());
        }
        return Err(Error::Conflict);
    }
    db.execute(
        "INSERT INTO chunks VALUES((SELECT owner FROM owner_scope WHERE slot=1),?1,?2,?3)",
        params![id, index as i64, bytes],
    )
    .map_err(db_error)?;
    Ok(())
}
pub fn commit(db: &Connection, id: &[u8], now: u64) -> Result<Revision> {
    vault_types::id(id)?;
    // Idempotent commit returns the original revision even if its head subsequently advances.
    let prior: Option<String> = db
        .query_row(
            "SELECT result FROM (SELECT * FROM receipts WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1)) WHERE operation=?1",
            params![id],
            |r| sql::row_get(r, 0),
        )
        .optional()
        .map_err(db_error)?;
    if let Some(raw) = prior {
        if crate::uploads::cancelled(&raw).is_some() {
            return Err(Error::Conflict);
        }
        if raw == "\"Expired\"" {
            return Err(Error::Expired);
        }
        let revision: Revision = serde_json::from_str(&raw).map_err(|_| Error::Conflict)?;
        if revision.deleted {
            return Err(Error::Conflict);
        }
        return Ok(revision);
    }
    let (r, d, _) = upload(db, id, now)?;
    check_object_capacity(db, &r.vault, &r.object)?;
    check_revision_capacity(db)?;
    if head(db, &r.vault, &r.object)? != r.expected_revision {
        return Err(Error::Conflict);
    }
    let n: i64 = db
        .query_row(
            "SELECT count(*) FROM (SELECT * FROM chunks WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1)) WHERE upload=?1",
            params![id],
            |row| sql::row_get(row, 0),
        )
        .map_err(db_error)?;
    if n as usize != r.chunk_hashes.len() {
        return Err(Error::Conflict);
    }
    let cleanup_credits =
        r.chunk_hashes.len() as i64 + 1 + if r.expected_revision == 0 { 1 } else { 0 };
    let mut h = active(db, &r.vault)?;
    h.sequence = next_sequence(h.sequence)?;
    let rev = Revision {
        vault: r.vault.clone(),
        object: r.object.clone(),
        revision: r.expected_revision + 1,
        plain_size: r.plain_size,
        manifest: r.manifest,
        chunk_hashes: r.chunk_hashes,
        deleted: false,
        sequence: h.sequence,
    };
    let hashes = serde_json::to_string(&rev.chunk_hashes).map_err(|_| Error::Storage)?;
    let charge = rev.plain_size
        + rev.chunk_hashes.len() as u64 * (16 + OVERHEAD)
        + rev.manifest.len() as u64
        + hashes.len() as u64
        + OVERHEAD;
    db.execute(
        "INSERT INTO revisions VALUES((SELECT owner FROM owner_scope WHERE slot=1),?1,?2,?3,?4,NULL,?5,?6,?7,0,?8)",
        params![
            rev.vault,
            rev.object,
            rev.revision as i64,
            rev.sequence as i64,
            rev.plain_size as i64,
            rev.manifest,
            hashes,
            charge as i64
        ],
    )
    .map_err(db_error)?;
    db.execute(
        "INSERT INTO revision_chunks SELECT (SELECT owner FROM owner_scope WHERE slot=1),?1,?2,?3,idx,data FROM (SELECT * FROM chunks WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1)) WHERE upload=?4",
        params![rev.vault, rev.object, rev.revision as i64, id],
    )
    .map_err(db_error)?;
    db.execute("INSERT INTO objects(owner,vault,object,head) VALUES((SELECT owner FROM owner_scope WHERE slot=1),?1,?2,?3) ON CONFLICT(owner,vault,object) DO UPDATE SET head=excluded.head",params![rev.vault,rev.object,rev.revision as i64]).map_err(db_error)?;
    db.execute("UPDATE revisions SET retired=?3 WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND (vault=?1 AND object=?2 AND revision<=?4 AND retired IS NULL)",params![rev.vault,rev.object,rev.sequence as i64,rev.revision.saturating_sub(10) as i64]).map_err(db_error)?;
    db.execute("DELETE FROM chunks WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND (upload=?1)", params![id])
        .map_err(db_error)?;
    db.execute(
        "DELETE FROM uploads WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND (id=?1)",
        params![id],
    )
    .map_err(db_error)?;

    add_cleanup_credits(db, &r.vault, cleanup_credits)?;
    put_header(db, &h)?;
    record(db, id, &d, &rev, now)?;
    Ok(rev)
}
fn row(r: &sql::Row<'_>) -> sql::Result<Revision> {
    let hashes: String = sql::row_get(r, 5)?;
    let hashes = serde_json::from_str(&hashes).map_err(|_| sql::invalid_query())?;
    Ok(Revision {
        vault: sql::row_get(r, 0)?,
        object: sql::row_get(r, 1)?,
        revision: sql::row_get::<i64>(r, 2)? as u64,
        plain_size: sql::row_get::<i64>(r, 3)? as u64,
        manifest: sql::row_get(r, 4)?,
        chunk_hashes: hashes,
        deleted: sql::row_get::<i64>(r, 6)? != 0,
        sequence: sql::row_get::<i64>(r, 7)? as u64,
    })
}
const COLS: &str = "r.vault,r.object,r.revision,r.plain_size,r.manifest,r.hashes,r.deleted,r.born";
pub fn manifest(db: &Connection, v: &[u8], o: &[u8], revision: u64) -> Result<Revision> {
    active(db, v)?;
    id(o)?;
    let rev = if revision == 0 {
        head(db, v, o)?
    } else {
        revision
    };
    if rev > i64::MAX as u64 {
        return Err(Error::InvalidInput);
    }
    db.query_row(&format!("SELECT {COLS} FROM (SELECT * FROM revisions WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1)) r WHERE r.vault=?1 AND r.object=?2 AND r.revision=?3 AND r.retired IS NULL"),params![v,o,rev as i64],row).optional().map_err(db_error)?.ok_or(Error::NotFound)
}
pub fn chunk(db: &Connection, v: &[u8], o: &[u8], revision: u64, index: u32) -> Result<Vec<u8>> {
    let m = manifest(db, v, o, revision)?;
    if index as usize >= m.chunk_hashes.len() {
        return Err(Error::InvalidInput);
    }
    db.query_row(
        "SELECT data FROM (SELECT * FROM revision_chunks WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1)) WHERE vault=?1 AND object=?2 AND revision=?3 AND idx=?4",
        params![v, o, m.revision as i64, index as i64],
        |r| sql::row_get(r, 0),
    )
    .optional()
    .map_err(db_error)?
    .ok_or(Error::NotFound)
}
pub fn history(db: &Connection, v: &[u8], o: &[u8], before: u64) -> Result<RevisionPage> {
    active(db, v)?;
    id(o)?;
    let mut s=db.prepare(&format!("SELECT {COLS} FROM (SELECT * FROM revisions WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1)) r WHERE r.vault=?1 AND r.object=?2 AND r.revision<?3 AND r.retired IS NULL ORDER BY r.revision DESC LIMIT 11")).map_err(db_error)?;
    let entries = sql::query_map(
        &mut s,
        params![v, o, before.min(i64::MAX as u64) as i64],
        row,
    )
    .map_err(db_error)?;
    let mut bytes = 0;
    let mut page = Vec::new();
    let mut more = false;
    for e in entries {
        let size = e.manifest.len() + e.chunk_hashes.len() * 32 + 512;
        if page.len() >= 10 || bytes + size > 800_000 {
            more = true;
            break;
        }
        bytes += size;
        page.push(e)
    }
    let next = if more {
        page.last().map(|r| r.revision)
    } else {
        None
    };
    Ok(RevisionPage {
        entries: page,
        next,
    })
}
pub fn objects(db: &Connection, v: &[u8], after: &[u8]) -> Result<ObjectPage> {
    active(db, v)?;
    if !after.is_empty() {
        id(after)?
    }
    let mut s=db.prepare(&format!("SELECT {COLS} FROM (SELECT * FROM revisions WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1)) r JOIN (SELECT * FROM objects WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1)) o ON r.vault=o.vault AND r.object=o.object AND r.revision=o.head WHERE r.vault=?1 AND r.object>?2 AND o.purged=0 ORDER BY r.object LIMIT 101")).map_err(db_error)?;
    let entries = sql::query_map(&mut s, params![v, after], row).map_err(db_error)?;
    let mut page = Vec::new();
    let mut bytes = 0;
    let mut more = false;
    for e in entries {
        let size = e.manifest.len() + e.chunk_hashes.len() * 32 + 512;
        if page.len() >= 100 || bytes + size > 800_000 {
            more = true;
            break;
        }
        bytes += size;
        page.push(e)
    }
    let next = if more {
        page.last().map(|r| r.object.clone())
    } else {
        None
    };
    Ok(ObjectPage {
        entries: page,
        next,
    })
}

fn reject_purged(db: &Connection, v: &[u8], o: &[u8]) -> Result<()> {
    let purged:Option<i64>=db.query_row("SELECT purged FROM objects WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND vault=?1 AND object=?2",params![v,o],|r|sql::row_get(r,0)).optional().map_err(db_error)?;
    if purged == Some(1) {
        return Err(Error::Conflict);
    }
    Ok(())
}
/// Purge consumes the object's separate prepaid receipt credit. Its identity and
/// head remain permanently fenced, and the existing GC reclaims retired blobs.
pub fn check_purge(db: &Connection, v: &[u8], o: &[u8], expected: u64) -> Result<()> {
    active(db, v)?;
    id(o)?;
    reject_purged(db, v, o)?;
    let current = head(db, v, o)?;
    if current == 0 || current != expected {
        return Err(Error::Conflict);
    }
    let uploading:i64=db.query_row("SELECT EXISTS(SELECT 1 FROM uploads WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND vault=?1 AND object=?2)",params![v,o],|r|sql::row_get(r,0)).map_err(db_error)?;
    if uploading != 0 {
        return Err(Error::Conflict);
    }
    Ok(())
}
pub fn purge(db: &Connection, v: &[u8], o: &[u8], expected: u64) -> Result<()> {
    check_purge(db, v, o, expected)?;
    let mut h = active(db, v)?;
    h.sequence = next_sequence(h.sequence)?;
    db.execute("UPDATE objects SET purged=1 WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND vault=?1 AND object=?2",params![v,o]).map_err(db_error)?;
    // At most eleven current/history revisions exist; older ones are already retired.
    db.execute("UPDATE revisions SET retired=?3 WHERE rowid IN (SELECT rowid FROM revisions WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND vault=?1 AND object=?2 AND retired IS NULL ORDER BY revision DESC LIMIT 11)",params![v,o,h.sequence as i64]).map_err(db_error)?;
    put_header(db, &h)
}
pub fn delete(
    db: &Connection,
    v: &[u8],
    o: &[u8],
    expected: u64,
    operation: &[u8],
    now: u64,
) -> Result<Revision> {
    active(db, v)?;
    id(operation)?;
    let d = Sha256::digest([b"delete".as_slice(), v, o, &expected.to_be_bytes()].concat());
    if let Some(r) = receipt(db, operation, &d)? {
        return Ok(r);
    }
    let old = manifest(db, v, o, 0)?;
    if old.revision != expected || old.deleted {
        return Err(Error::Conflict);
    }
    if expected >= i64::MAX as u64 {
        return Err(Error::QuotaExceeded);
    }
    check_revision_capacity(db)?;
    check_capacity(db, OVERHEAD * 2)?;
    let mut h = active(db, v)?;
    h.sequence = next_sequence(h.sequence)?;
    let r = Revision {
        vault: v.to_vec(),
        object: o.to_vec(),
        revision: expected + 1,
        plain_size: 0,
        manifest: vec![],
        chunk_hashes: vec![],
        deleted: true,
        sequence: h.sequence,
    };
    db.execute(
        "INSERT INTO revisions VALUES((SELECT owner FROM owner_scope WHERE slot=1),?1,?2,?3,?4,NULL,0,x'', '[]',1,4096)",
        params![v, o, r.revision as i64, h.sequence as i64],
    )
    .map_err(db_error)?;
    db.execute(
        "UPDATE objects SET head=?3 WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND (vault=?1 AND object=?2)",
        params![v, o, r.revision as i64],
    )
    .map_err(db_error)?;
    db.execute("UPDATE revisions SET retired=?3 WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND (vault=?1 AND object=?2 AND revision<=?4 AND retired IS NULL)",params![v,o,h.sequence as i64,r.revision.saturating_sub(10) as i64]).map_err(db_error)?;
    add_cleanup_credits(db, v, 1)?;
    put_header(db, &h)?;
    record(db, operation, &d, &r, now)?;
    Ok(r)
}
fn collect_expired_upload(db: &Connection, now: u64) -> Result<()> {
    let row:Option<(Id,Id,Option<Id>)>=db.query_row("SELECT id,vault,cancel_job FROM uploads WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND expires<=?1 ORDER BY expires,id LIMIT 1",params![now as i64],|r|Ok((sql::row_get(r,0)?,sql::row_get(r,1)?,sql::row_get(r,2)?))).optional().map_err(db_error)?;
    if let Some((upload, vault, job)) = row {
        cancel_upload_batch(
            db,
            &vault,
            &upload,
            &job.unwrap_or_else(|| upload.clone()),
            now,
        )?;
    }
    Ok(())
}

pub(crate) fn remove_revision(
    db: &Connection,
    vault: &[u8],
    object: &[u8],
    revision: i64,
) -> Result<()> {
    db.execute(
        "DELETE FROM revision_chunks WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND (vault=?1 AND object=?2 AND revision=?3)",
        params![vault, object, revision],
    )
    .map_err(db_error)?;
    db.execute(
        "DELETE FROM revisions WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND (vault=?1 AND object=?2 AND revision=?3)",
        params![vault, object, revision],
    )
    .map_err(db_error)?;
    release_cleanup_credits(db, vault, 1)?;
    Ok(())
}

fn collect_retired_revision(db: &Connection) -> Result<u64> {
    let row:Option<(Id,Id,i64)>=db.query_row("SELECT vault,object,revision FROM revisions WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND retired IS NOT NULL ORDER BY vault,object,revision LIMIT 1",params![],|r|Ok((sql::row_get(r,0)?,sql::row_get(r,1)?,sql::row_get(r,2)?))).optional().map_err(db_error)?;
    let Some((v, o, r)) = row else { return Ok(0) };
    remove_ciphertext_batch(db, &v, Some(&o), Some(r))?;
    let remaining:i64=db.query_row("SELECT count(*) FROM revision_chunks WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND vault=?1 AND object=?2 AND revision=?3",params![v,o,r],|r|sql::row_get(r,0)).map_err(db_error)?;
    if remaining == 0 {
        remove_revision(db, &v, &o, r)?;
    }
    Ok(1)
}
pub fn gc(db: &Connection, now: u64) -> Result<u64> {
    keys::collect_owner_completed(db, now)?;
    collect_expired_receipts(db, now)?;
    operations::collect(db, now)?;
    collect_expired_upload(db, now)?;
    collect_retired_revision(db)
}
/// Cursor advances even for idle owners. A restart reads the same durable position.
pub fn maintain_expired(db: &Connection, now: u64) -> Result<Option<(Principal, u64)>> {
    let cursor: Option<String> = db
        .query_row(
            "SELECT value FROM global_settings WHERE key='gc-owner'",
            params![],
            |r| sql::row_get(r, 0),
        )
        .optional()
        .map_err(db_error)?;
    let cursor = cursor.unwrap_or_default();
    let next:Option<Vec<u8>>=db.query_row("SELECT owner FROM (SELECT owner FROM vaults UNION SELECT owner FROM uploads UNION SELECT owner FROM receipts UNION SELECT owner FROM operations UNION SELECT owner FROM key_flights) WHERE hex(owner)>?1 ORDER BY hex(owner) LIMIT 1",params![cursor],|r|sql::row_get(r,0)).optional().map_err(db_error)?;
    let Some(owner) = next else {
        db.execute("INSERT INTO global_settings(key,value) VALUES('gc-owner','') ON CONFLICT(key) DO UPDATE SET value=''",params![]).map_err(db_error)?;
        return Ok(None);
    };
    db.execute("INSERT INTO global_settings(key,value) VALUES('gc-owner',hex(?1)) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![owner]).map_err(db_error)?;
    let owner = Principal::try_from_slice(&owner).map_err(|_| Error::Storage)?;
    let usage = OwnerContext::authenticated(owner)?.run(db, |db| {
        gc(db, now)?;
        usage(db)
    })?;
    Ok(Some((owner, usage)))
}

/// At most 100 rows and one maximum ciphertext chunk's bytes per call.
pub fn remove_ciphertext_batch(
    db: &Connection,
    vault: &[u8],
    object: Option<&[u8]>,
    revision: Option<i64>,
) -> Result<usize> {
    let mut stmt=db.prepare("SELECT rowid,length(data) FROM revision_chunks WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND vault=?1 AND (length(?2)=0 OR object=?2) AND (?3<0 OR revision=?3) ORDER BY object,revision,idx LIMIT 100").map_err(db_error)?;
    let rows: Vec<(i64, i64)> = sql::query_map(
        &mut stmt,
        params![vault, object.unwrap_or(&[]), revision.unwrap_or(-1)],
        |r| Ok((sql::row_get(r, 0)?, sql::row_get(r, 1)?)),
    )
    .map_err(db_error)?;
    let mut bytes = 0usize;
    let mut removed = 0;
    for (row, size) in rows {
        let size = usize::try_from(size).map_err(|_| Error::Storage)?;
        if bytes + size > CHUNK_MAX {
            break;
        }
        db.execute("DELETE FROM revision_chunks WHERE rowid=?1", params![row])
            .map_err(db_error)?;
        bytes += size;
        removed += 1;
    }
    release_cleanup_credits(db, vault, removed as i64)?;
    Ok(removed)
}

fn add_cleanup_credits(db: &Connection, vault: &[u8], amount: i64) -> Result<()> {
    db.execute("UPDATE vaults SET cleanup_budget=cleanup_budget+?2 WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND id=?1",params![vault,amount]).map_err(db_error)?;
    Ok(())
}
/// Release only credits attached to the rows just removed. The same transaction may
/// replace one such credit with a resource-backed operation receipt of at most 512 bytes.
pub fn release_cleanup_credits(db: &Connection, vault: &[u8], amount: i64) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    if amount < 0 {
        return Err(Error::Storage);
    }
    db.execute("UPDATE vaults SET cleanup_budget=cleanup_budget-?2 WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND id=?1 AND cleanup_budget>=?2",params![vault,amount]).map_err(db_error)?;
    let changed: i64 = db
        .query_row("SELECT changes()", params![], |r| sql::row_get(r, 0))
        .map_err(db_error)?;
    if changed != 1 {
        return Err(Error::Storage);
    }
    Ok(())
}
