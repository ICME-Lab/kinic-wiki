use super::*;
use sha2::{Digest, Sha256};
fn err(_: sql::Error) -> Error {
    Error::Storage
}
fn be(n: u64) -> [u8; 8] {
    n.to_be_bytes()
}
pub fn leaf(r: &Revision) -> Vec<u8> {
    let mut data = b"kinic-vault/restore-record/v1".to_vec();
    data.extend(&r.vault);
    data.extend(&r.object);
    data.extend(be(r.revision));
    data.extend(be(r.sequence));
    data.extend(be(r.plain_size));
    data.push(r.deleted as u8);
    data.extend((r.manifest.len() as u32).to_be_bytes());
    data.extend(&r.manifest);
    data.extend((r.chunk_hashes.len() as u32).to_be_bytes());
    for h in &r.chunk_hashes {
        data.extend(h)
    }
    Sha256::digest(data).to_vec()
}
/// Versioned target identity is committed even when there are no live records.
pub fn target_seed(generation: &Generation) -> Result<Vec<u8>> {
    Ok(Sha256::digest(
        [
            b"kinic-vault/restore-root/v2\0".as_slice(),
            &generation.bytes()?,
        ]
        .concat(),
    )
    .to_vec())
}
pub fn begin(db: &Connection, r: BeginRestore, now: u64) -> Result<Header> {
    begin_inner(db, r, now, false)
}
pub fn begin_prepaid(db: &Connection, r: BeginRestore, now: u64) -> Result<Header> {
    if !restore_working::available(db)? {
        return Err(Error::QuotaExceeded);
    }
    begin_inner(db, r, now, true)
}
fn begin_inner(db: &Connection, r: BeginRestore, now: u64, prepaid: bool) -> Result<Header> {
    id(&r.header.id)?;
    id(&r.operation)?;
    setup::reject_discarded(db, &r.header.id, &r.operation, now)?;
    if r.header.published_slot.is_some()
        || r.count > 10000
        || r.root.len() != 32
        || r.reserved_bytes > TOTAL_MAX
        || r.header.epoch > i64::MAX as u64
        || r.header.sequence > i64::MAX as u64
    {
        return Err(Error::InvalidInput);
    }
    let digest = Sha256::digest(serde_json::to_vec(&r).map_err(|_| Error::InvalidInput)?).to_vec();
    let previous: Option<(Vec<u8>, i64)> = db
        .query_row(
            "SELECT digest,expires FROM (SELECT * FROM restores WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1)) WHERE vault=?1",
            params![r.header.id],
            |row| Ok((sql::row_get(row, 0)?, sql::row_get(row, 1)?)),
        )
        .optional()
        .map_err(err)?;
    if let Some((d, e)) = previous {
        if d != digest {
            return Err(Error::Conflict);
        }
        if e as u64 <= now {
            return Err(Error::Expired);
        }
        return header(db, &r.header.id);
    }
    if header(db, &r.header.id).is_ok() {
        return Err(Error::Conflict);
    }
    content::check_receipt_capacity(db, now)?;
    let total: i64 = db
        .query_row("SELECT count(*) FROM revisions", params![], |r| {
            sql::row_get(r, 0)
        })
        .map_err(err)?;
    if total as u64 + r.count > 10000 {
        return Err(Error::QuotaExceeded);
    }
    let cfg = config(db)?;
    let vaults: i64 = db
        .query_row(
            "SELECT count(*) FROM (SELECT * FROM vaults WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1)) WHERE expires=0 OR expires>?1",
            params![now as i64],
            |row| sql::row_get(row, 0),
        )
        .map_err(err)?;
    if vaults >= 3 {
        return Err(Error::QuotaExceeded);
    }
    let unfinished: i64 = db
        .query_row(
            "SELECT count(*) FROM restores WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1)",
            params![],
            |row| sql::row_get(row, 0),
        )
        .map_err(err)?;
    if unfinished > 0 {
        return Err(Error::Busy);
    }
    content::check_capacity(db, r.reserved_bytes + if prepaid { 8192 } else { 12288 })?;
    let mut h = r.header;
    h.state = VaultState::Restoring;
    h.normal = None;
    h.backup_sequence = None;
    h.backup_at = None;
    h.key_name = cfg.key_name;
    if let Some(g) = &h.generation
        && (g.owner != cfg.owner
            || g.vault != h.id
            || g.epoch != h.epoch
            || g.key_name != h.key_name)
    {
        return Err(Error::InvalidInput);
    }
    if let Some(e) = &h.recovery {
        if h.generation.is_some() {
            if e.version != 2 || e.nonce.len() != 12 || e.ciphertext.len() != 48 {
                return Err(Error::InvalidInput);
            }
        } else {
            envelope(e)?;
        }
    } else {
        return Err(Error::InvalidInput);
    }
    let seed = h
        .generation
        .as_ref()
        .map(target_seed)
        .transpose()?
        .unwrap_or(vec![0u8; 32]);
    db.execute(
        "INSERT INTO vaults VALUES((SELECT owner FROM owner_scope WHERE slot=1),?1,?2,?3,?4)",
        params![
            h.id,
            r.operation,
            (now + DAY) as i64,
            serde_json::to_string(&h).map_err(|_| Error::Storage)?
        ],
    )
    .map_err(err)?;
    db.execute(
        "INSERT INTO restores VALUES((SELECT owner FROM owner_scope WHERE slot=1),?1,?2,?3,?4,?5,?6,0,0,?7,'',?8,?9)",
        params![
            h.id,
            r.operation,
            (now + DAY) as i64,
            r.count as i64,
            r.root,
            seed,
            r.reserved_bytes as i64,
            digest,
            i64::from(prepaid)
        ],
    )
    .map_err(err)?;
    Ok(h)
}
fn progress(db: &Connection, v: &[u8], now: u64) -> Result<(RestoreProgress, u64, String, u64)> {
    let h = pending(db, v, now)?;
    if h.state != VaultState::Restoring {
        return Err(Error::Conflict);
    }
    let (count,last,chain,reserved,pending,expected):(i64,i64,Vec<u8>,i64,String,i64)=db.query_row("SELECT count,last_seq,chain,reserved,pending,expected_count FROM (SELECT * FROM restores WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1)) WHERE vault=?1",params![v],|r|Ok((sql::row_get(r,0)?,sql::row_get(r,1)?,sql::row_get(r,2)?,sql::row_get(r,3)?,sql::row_get(r,4)?,sql::row_get(r,5)?))).map_err(err)?;
    Ok((
        RestoreProgress {
            count: count as u64,
            sequence: last as u64,
            root: chain,
        },
        reserved as u64,
        pending,
        expected as u64,
    ))
}
pub fn stage(db: &Connection, v: &[u8], r: Revision, now: u64) -> Result<()> {
    let h = header(db, v)?;
    let (p, reserved, pending, expected) = progress(db, v, now)?;
    id(&r.object)?;
    if !pending.is_empty() {
        let old: Revision = serde_json::from_str(&pending).map_err(|_| Error::Storage)?;
        if leaf(&old) == leaf(&r) {
            return Ok(());
        }
        return Err(Error::Busy);
    }
    if p.count >= expected
        || r.vault != v
        || r.sequence <= p.sequence
        || r.sequence > h.sequence
        || r.revision == 0
        || r.revision > i64::MAX as u64
        || r.plain_size > FILE_MAX
        || r.manifest.len() > 65536
        || r.chunk_hashes.iter().any(|h| h.len() != 32)
    {
        return Err(Error::InvalidInput);
    }
    if r.deleted {
        if r.plain_size != 0 || !r.manifest.is_empty() || !r.chunk_hashes.is_empty() {
            return Err(Error::InvalidInput);
        }
    } else if r.manifest.is_empty()
        || r.chunk_hashes.len() != r.plain_size.div_ceil(1048576).max(1) as usize
    {
        return Err(Error::InvalidInput);
    }
    let prepaid = restore_working::mode(db, v)?;
    let charge = if prepaid && r.deleted {
        4096
    } else {
        (if r.deleted { 0 } else { WRAPPER_HEADROOM })
            + r.plain_size
            + r.chunk_hashes.len() as u64 * (16 + 4096)
            + r.manifest.len() as u64
            + serde_json::to_string(&r.chunk_hashes)
                .map_err(|_| Error::Storage)?
                .len() as u64
            + 4096
    };
    let encoded = serde_json::to_string(&r).map_err(|_| Error::Storage)?;
    if prepaid && encoded.len() > restore_working::PENDING_MAX {
        return Err(Error::QuotaExceeded);
    }
    let pending_charge = if prepaid { 0 } else { encoded.len() as u64 };
    if charge + pending_charge > reserved {
        return Err(Error::QuotaExceeded);
    }
    let old: Option<i64> = db
        .query_row(
            "SELECT head FROM (SELECT * FROM objects WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1)) WHERE vault=?1 AND object=?2",
            params![v, r.object],
            |row| sql::row_get(row, 0),
        )
        .optional()
        .map_err(err)?;
    if old.is_some_and(|x| x as u64 >= r.revision) {
        return Err(Error::Conflict);
    }
    let versions: i64 = db
        .query_row(
            "SELECT count(*) FROM (SELECT * FROM revisions WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1)) WHERE vault=?1 AND object=?2",
            params![v, r.object],
            |row| sql::row_get(row, 0),
        )
        .map_err(err)?;
    if versions >= 10 {
        return Err(Error::QuotaExceeded);
    }
    content::check_revision_capacity(db)?;
    content::check_object_capacity(db, v, &r.object)?;
    db.execute(
        "INSERT INTO revisions VALUES((SELECT owner FROM owner_scope WHERE slot=1),?1,?2,?3,?4,NULL,?5,?6,?7,?8,?9)",
        params![
            v,
            r.object,
            r.revision as i64,
            r.sequence as i64,
            r.plain_size as i64,
            r.manifest,
            serde_json::to_string(&r.chunk_hashes).map_err(|_| Error::Storage)?,
            r.deleted as i64,
            charge as i64
        ],
    )
    .map_err(err)?;
    db.execute(
        "UPDATE restores SET reserved=reserved-?2,pending=?3 WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND (vault=?1)",
        params![v, (charge + pending_charge) as i64, encoded],
    )
    .map_err(err)?;
    Ok(())
}
pub fn put(db: &Connection, v: &[u8], index: u32, data: &[u8], now: u64) -> Result<()> {
    let (_, _, raw, _) = progress(db, v, now)?;
    let r: Revision = serde_json::from_str(&raw).map_err(|_| Error::Conflict)?;
    let idx = index as usize;
    if idx >= r.chunk_hashes.len()
        || data.len() > CHUNK_MAX
        || data.len()
            != (r
                .plain_size
                .saturating_sub(idx as u64 * 1048576)
                .min(1048576)
                + 16) as usize
        || Sha256::digest(data)[..] != r.chunk_hashes[idx]
    {
        return Err(Error::InvalidInput);
    }
    let old:Option<Vec<u8>>=db.query_row("SELECT data FROM (SELECT * FROM revision_chunks WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1)) WHERE vault=?1 AND object=?2 AND revision=?3 AND idx=?4",params![v,r.object,r.revision as i64,index as i64],|r|sql::row_get(r,0)).optional().map_err(err)?;
    if let Some(old) = old {
        if old == data {
            return Ok(());
        }
        return Err(Error::Conflict);
    }
    db.execute(
        "INSERT INTO revision_chunks VALUES((SELECT owner FROM owner_scope WHERE slot=1),?1,?2,?3,?4,?5)",
        params![v, r.object, r.revision as i64, index as i64, data],
    )
    .map_err(err)?;
    Ok(())
}
pub fn finish_record(
    db: &Connection,
    v: &[u8],
    sequence: u64,
    now: u64,
) -> Result<RestoreProgress> {
    let (mut p, reserved, raw, _) = progress(db, v, now)?;
    if raw.is_empty() && p.sequence == sequence {
        return Ok(p);
    }
    let r: Revision = serde_json::from_str(&raw).map_err(|_| Error::Conflict)?;
    if r.sequence != sequence {
        return Err(Error::Conflict);
    }
    let count: i64 = db
        .query_row(
            "SELECT count(*) FROM (SELECT * FROM revision_chunks WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1)) WHERE vault=?1 AND object=?2 AND revision=?3",
            params![v, r.object, r.revision as i64],
            |row| sql::row_get(row, 0),
        )
        .map_err(err)?;
    if count as usize != r.chunk_hashes.len() {
        return Err(Error::Conflict);
    }
    content::check_object_capacity(db, v, &r.object)?;
    let existing: i64 = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM (SELECT * FROM objects WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1)) WHERE vault=?1 AND object=?2)",
            params![v, r.object],
            |row| sql::row_get(row, 0),
        )
        .map_err(err)?;
    let head_charge = if existing == 0 { 4096 } else { 0 };
    let pending_charge = if restore_working::mode(db, v)? {
        0
    } else {
        raw.len() as u64
    };
    if reserved + pending_charge < head_charge {
        return Err(Error::QuotaExceeded);
    }
    db.execute("INSERT INTO objects VALUES((SELECT owner FROM owner_scope WHERE slot=1),?1,?2,?3) ON CONFLICT(owner,vault,object) DO UPDATE SET head=excluded.head",params![v,r.object,r.revision as i64]).map_err(err)?;
    p.root = Sha256::digest([p.root, leaf(&r)].concat()).to_vec();
    p.count += 1;
    p.sequence = r.sequence;
    db.execute(
        "UPDATE restores SET chain=?2,count=?3,last_seq=?4,reserved=reserved+?6-?5,pending='' WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND (vault=?1)",
        params![v, p.root, p.count as i64, p.sequence as i64, head_charge as i64, pending_charge as i64],
    )
    .map_err(err)?;
    Ok(p)
}
pub fn ready(db: &Connection, v: &[u8], now: u64) -> Result<()> {
    let (p, _, pending, expected) = progress(db, v, now)?;
    let root: Vec<u8> = db
        .query_row(
            "SELECT expected_root FROM (SELECT * FROM restores WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1)) WHERE vault=?1",
            params![v],
            |r| sql::row_get(r, 0),
        )
        .map_err(err)?;
    if !pending.is_empty() || p.count != expected || p.root != root {
        return Err(Error::Conflict);
    }
    let current:i64=db.query_row("SELECT COALESCE(sum(r.plain_size),0) FROM (SELECT * FROM revisions WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1)) r JOIN (SELECT * FROM objects WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1)) o ON r.vault=o.vault AND r.object=o.object AND r.revision=o.head WHERE r.vault=?1 AND r.deleted=0",params![v],|row|sql::row_get(row,0)).map_err(err)?;
    if current as u64 > VAULT_MAX {
        return Err(Error::QuotaExceeded);
    }
    Ok(())
}
pub fn committed(db: &Connection, v: &[u8]) -> Result<()> {
    db.execute("UPDATE restores SET reserved=0 WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND (vault=?1)", params![v])
        .map_err(err)?;
    Ok(())
}

/// Ciphertext-only resume cursor; authorization and exact generation checks live in service.
pub fn status(db: &Connection, v: &[u8]) -> Result<RestoreProgress> {
    progress(db, v, 0).map(|x| x.0)
}
