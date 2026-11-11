//! Signed descriptor preparation, then exact owner-II ciphertext-only reads.
use super::*;
pub(crate) fn target_header(t: &IncidentTarget) -> Result<Header> {
    let g = t.target.clone().ok_or(Error::Conflict)?;
    let mut h = t.source.clone();
    h.generation = Some(g.clone());
    h.epoch = g.epoch;
    h.key_name = g.key_name;
    h.normal = t.normal.clone();
    h.recovery = t.recovery.clone();
    h.recovery_verifier = t.recovery_verifier.clone();
    h.sequence = t
        .snapshot_sequence
        .checked_add(1)
        .filter(|n| *n <= i64::MAX as u64)
        .ok_or(Error::QuotaExceeded)?;
    h.published_slot = Some(1 - t.source.published_slot.unwrap_or(1));
    h.state = VaultState::Active;
    h.backup_sequence = None;
    h.backup_at = None;
    Ok(h)
}
pub(crate) fn prepare(
    db: &Connection,
    env: &impl Environment,
    vault: &[u8],
    attempt: &[u8],
    export: &[u8],
) -> Result<()> {
    id(export)?;
    let mut j = incident::load(db, env)?;
    let job = j.job.clone();
    let t = incident::target(&mut j, vault, attempt)?;
    if !matches!(
        t.phase,
        PreparationPhase::Wrapping | PreparationPhase::BackupVerified
    ) {
        return Err(Error::Conflict);
    }
    if let Some(e) = &t.staged_export {
        if e.export.id == export {
            return if e.export.expires > env.now() {
                Ok(())
            } else {
                Err(Error::Expired)
            };
        }
        if e.export.expires > env.now() {
            return Err(Error::Busy);
        }
    }
    let c = t
        .coverage
        .as_ref()
        .filter(|c| c.complete)
        .ok_or(Error::Conflict)?;
    let h = target_header(t)?;
    let e = Export {
        id: export.to_vec(),
        vault: vault.to_vec(),
        sequence: h.sequence,
        expires: env.now().checked_add(DAY).ok_or(Error::QuotaExceeded)?,
        state: "Staged".into(),
        record_count: c.records,
        chunk_count: c.chunks,
        plain_bytes: c.plain_bytes,
        header: h,
    };
    let digest = hash(&(
        "incident-export/v1",
        &job,
        attempt,
        &e,
        &c.source_root,
        &c.target_root,
    ))?;
    t.staged_export = Some(StagedExport {
        export: e,
        commitment: c.target_root.clone(),
        descriptor_digest: digest,
    });
    t.backup_ack = None;
    t.phase = PreparationPhase::Wrapping;
    incident::save(db, &mut j)
}
fn prepared(
    db: &Connection,
    env: &impl Environment,
    r: &IncidentRead,
) -> Result<(IncidentTarget, StagedExport)> {
    store::authorize(db, env.owner())?;
    let mut j = incident::load(db, env)?;
    if j.job != r.job {
        return Err(Error::Unauthorized);
    }
    let t = incident::target(&mut j, &r.vault, &r.attempt)?;
    if !matches!(
        t.phase,
        PreparationPhase::Wrapping | PreparationPhase::BackupVerified
    ) {
        return Err(Error::Conflict);
    }
    let e = t
        .staged_export
        .clone()
        .filter(|e| e.export.id == r.export && e.descriptor_digest == r.descriptor_digest)
        .ok_or(Error::NotFound)?;
    if e.export.expires <= env.now() {
        return Err(Error::Expired);
    }
    Ok((t.clone(), e))
}
pub fn descriptor(env: &impl Environment, r: IncidentRead) -> Result<StagedExport> {
    env.transaction(|db| prepared(db, env, &r).map(|(_, e)| e))
}
pub fn index(env: &impl Environment, r: IncidentRead, after: u64) -> Result<ExportPage> {
    env.transaction(|db| {
        let (t, e) = prepared(db, env, &r)?;
        store::content::snapshot_index(db, &e.export.header, t.snapshot_sequence, after)
    })
}
pub fn chunk(
    env: &impl Environment,
    r: IncidentRead,
    object: Id,
    revision: u64,
    index: u32,
) -> Result<Vec<u8>> {
    env.transaction(|db| {
        let (t, _) = prepared(db, env, &r)?;
        store::content::snapshot_chunk(
            db,
            &t.source.id,
            t.snapshot_sequence,
            &object,
            revision,
            index,
        )
    })
}
pub(crate) fn confirm(
    db: &Connection,
    env: &impl Environment,
    vault: &[u8],
    attempt: &[u8],
    ack: &IncidentBackupAck,
) -> Result<()> {
    let mut j = incident::load(db, env)?;
    let t = incident::target(&mut j, vault, attempt)?;
    let e = t.staged_export.as_ref().ok_or(Error::Conflict)?;
    if !matches!(
        t.phase,
        PreparationPhase::Wrapping | PreparationPhase::BackupVerified
    ) || e.export.expires <= env.now()
        || t.kit_ack.as_ref() != Some(&t.envelope_digest)
        || !t
            .coverage
            .as_ref()
            .is_some_and(|c| c.complete && c.target_root == ack.commitment)
        || ack.descriptor_digest != e.descriptor_digest
        || ack.commitment != e.commitment
        || ack.sequence != e.export.sequence
        || ack.recovery_verifier != t.recovery_verifier
        || ack.archive_hash.len() != 32
        || ack.archive_length < 100
        || ack.archive_length > 256 * 1024 * 1024
    {
        return Err(Error::Conflict);
    }
    t.backup_ack = Some(ack.clone());
    t.phase = PreparationPhase::BackupVerified;
    incident::save(db, &mut j)
}
