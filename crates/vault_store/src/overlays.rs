//! The two permanently prepaid DEK wrapper slots. Published absence is corruption.
use super::*;
use sha2::{Digest, Sha256};

pub fn stage(
    db: &Connection,
    source: &Revision,
    target: &Generation,
    slot: u8,
    source_digest: &[u8],
    wrapper: &[u8],
) -> Result<()> {
    id(&source.object)?;
    let generation = target.bytes()?;
    if slot > 1
        || source.deleted
        || source.vault != target.vault
        || config(db)?.owner != target.owner
        || source_digest.len() != 32
        || source.revision > i64::MAX as u64
        || source_digest != Sha256::digest(&source.manifest).as_slice()
    {
        return Err(Error::InvalidInput);
    }
    let packed: format::PackedEnvelope =
        serde_json::from_slice(wrapper).map_err(|_| Error::InvalidInput)?;
    format::effective(
        &source.manifest,
        source.chunk_hashes.len(),
        Some(packed.clone()),
    )?;
    let wrapper = serde_json::to_vec(&packed).map_err(|_| Error::Storage)?;
    // Complete logical row, including duplicated identifiers and all field prefixes.
    let row_bytes = target.owner.as_slice().len()
        + target.vault.len()
        + source.object.len()
        + 8
        + 1
        + generation.len()
        + source_digest.len()
        + wrapper.len()
        + 8 * 4;
    if wrapper.len() > 1024 || row_bytes > 2048 {
        return Err(Error::QuotaExceeded);
    }
    db.execute("INSERT INTO wrapper_slots(owner,vault,object,revision,slot,generation,source_digest,wrapper) VALUES((SELECT owner FROM owner_scope WHERE slot=1),?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(owner,vault,object,revision,slot) DO UPDATE SET generation=excluded.generation,source_digest=excluded.source_digest,wrapper=excluded.wrapper",params![source.vault,source.object,source.revision as i64,slot as i64,generation,source_digest,wrapper]).map_err(|_| Error::Storage)?;
    Ok(())
}

pub fn effective(db: &Connection, header: &Header, mut r: Revision) -> Result<Revision> {
    if r.vault != header.id {
        return Err(Error::Storage);
    }
    if r.deleted {
        return Ok(r);
    }
    let Some(slot) = header.published_slot else {
        return Ok(r);
    };
    if slot > 1 {
        return Err(Error::Storage);
    }
    let expected = header.generation.as_ref().ok_or(Error::Storage)?.bytes()?;
    let row: Option<(Vec<u8>,Vec<u8>)> = db.query_row("SELECT generation,wrapper FROM wrapper_slots WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND vault=?1 AND object=?2 AND revision=?3 AND slot=?4",params![r.vault,r.object,r.revision as i64,slot as i64],|row|Ok((sql::row_get(row,0)?,sql::row_get(row,1)?))).optional().map_err(|_| Error::Storage)?;
    let (generation, wrapper) = row.ok_or(Error::Storage)?;
    if generation != expected {
        return Err(Error::Storage);
    }
    let wrapper = serde_json::from_slice(&wrapper).map_err(|_| Error::Storage)?;
    r.manifest = format::effective(&r.manifest, r.chunk_hashes.len(), Some(wrapper))
        .map_err(|_| Error::Storage)?;
    Ok(r)
}

/// Every new revision after first publication gets an explicit current-slot wrapper.
pub fn populate_current(db: &Connection, h: &Header, r: &Revision) -> Result<()> {
    let Some(slot) = h.published_slot else {
        return Ok(());
    };
    if r.deleted {
        return Ok(());
    }
    let wrapper = format::parse(&r.manifest, r.chunk_hashes.len())?.dek;
    stage(
        db,
        r,
        h.generation.as_ref().ok_or(Error::Storage)?,
        slot,
        &Sha256::digest(&r.manifest),
        &serde_json::to_vec(&wrapper).map_err(|_| Error::Storage)?,
    )
}

/// Bounded cleanup is required before reusing the inactive slot for another attempt.
pub fn clear_inactive(db: &Connection, h: &Header, slot: u8) -> Result<bool> {
    if slot > 1 || h.published_slot == Some(slot) {
        return Err(Error::Conflict);
    }
    db.execute("DELETE FROM wrapper_slots WHERE rowid IN (SELECT rowid FROM wrapper_slots WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND vault=?1 AND slot=?2 LIMIT 100)",params![h.id,slot as i64]).map_err(|_| Error::Storage)?;
    let remains: i64 = db.query_row("SELECT EXISTS(SELECT 1 FROM wrapper_slots WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND vault=?1 AND slot=?2)",params![h.id,slot as i64],|r|sql::row_get(r,0)).map_err(|_| Error::Storage)?;
    Ok(remains == 0)
}
