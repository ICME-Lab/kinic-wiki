//! Ordered immutable-source coverage, using only the two prepaid wrapper slots.
use super::*;

pub(crate) fn source_page(db: &Connection, t: &IncidentTarget, after: u64) -> Result<ExportPage> {
    let mut page = store::content::snapshot_index(db, &t.source, t.snapshot_sequence, after)?;
    for r in &mut page.entries {
        if !r.deleted {
            r.manifest = store::format::effective(&r.manifest, r.chunk_hashes.len(), None)?;
        }
    }
    Ok(page)
}
pub fn source_index(
    env: &impl Environment,
    job: Id,
    vault: Id,
    attempt: Id,
    after: u64,
) -> Result<ExportPage> {
    env.transaction(|db| {
        store::authorize(db, env.owner())?;
        let mut j = incident::load(db, env)?;
        if j.job != job {
            return Err(Error::Unauthorized);
        }
        let t = incident::target(&mut j, &vault, &attempt)?;
        source_page(db, t, after)
    })
}
pub(crate) fn wrap(
    db: &Connection,
    env: &impl Environment,
    vault: &[u8],
    attempt: &[u8],
    after: u64,
    rows: &[IncidentWrapper],
) -> Result<()> {
    if rows.len() > 100 {
        return Err(Error::InvalidInput);
    }
    let mut j = incident::load(db, env)?;
    let t = incident::target(&mut j, vault, attempt)?;
    if !matches!(
        t.phase,
        PreparationPhase::KitConfirmed | PreparationPhase::Wrapping
    ) || t.kit_ack.as_ref() != Some(&t.envelope_digest)
    {
        return Err(Error::Conflict);
    }
    let batch = hash(&(after, rows))?;
    if t.coverage.as_ref().is_some_and(|c| c.last_batch == batch) {
        return Ok(());
    }
    let generation = t.target.as_ref().ok_or(Error::Conflict)?.clone();
    let mut c = t.coverage.clone().unwrap_or(IncidentCoverage {
        cursor: 0,
        records: 0,
        chunks: 0,
        plain_bytes: 0,
        source_root: vec![0; 32],
        target_root: store::restore::target_seed(&generation)?,
        complete: false,
        last_batch: vec![],
    });
    if c.cursor != after || c.complete {
        return Err(Error::Conflict);
    }
    let page = source_page(db, t, after)?;
    // The entire next bounded page is required; no caller-selected holes or reordering.
    if page.entries.len() != rows.len() {
        return Err(Error::Conflict);
    }
    let slot = 1 - t.source.published_slot.unwrap_or(1);
    for (r, w) in page.entries.iter().zip(rows) {
        if r.object != w.object
            || r.revision != w.revision
            || r.sequence != w.sequence
            || w.source_digest != Sha256::digest(&r.manifest).to_vec()
        {
            return Err(Error::Conflict);
        }
        let mut transformed = r.clone();
        if r.deleted {
            if !w.wrapper.is_empty() {
                return Err(Error::InvalidInput);
            }
        } else {
            store::overlays::stage(db, r, &generation, slot, &w.source_digest, &w.wrapper)?;
            let wrapper = serde_json::from_slice(&w.wrapper).map_err(|_| Error::InvalidInput)?;
            transformed.manifest =
                store::format::effective(&r.manifest, r.chunk_hashes.len(), Some(wrapper))?;
        }
        c.source_root = Sha256::digest([c.source_root, store::restore::leaf(r)].concat()).to_vec();
        c.target_root =
            Sha256::digest([c.target_root, store::restore::leaf(&transformed)].concat()).to_vec();
        c.records += 1;
        c.chunks += r.chunk_hashes.len() as u64;
        c.plain_bytes += r.plain_size;
        c.cursor = r.sequence;
    }
    if c.records > 10000 {
        return Err(Error::QuotaExceeded);
    }
    c.complete = page.next.is_none();
    c.last_batch = batch;
    t.coverage = Some(c);
    t.staged_export = None;
    t.backup_ack = None;
    t.phase = PreparationPhase::Wrapping;
    incident::save(db, &mut j)
}
