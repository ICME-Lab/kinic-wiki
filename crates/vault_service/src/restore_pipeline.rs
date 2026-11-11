//! One bounded restore child. Ciphertext stays in the existing resumable import tables.
use super::*;
pub(crate) fn current(
    db: &Connection,
    env: &impl Environment,
    j: &RestoreAdmissionStatus,
    p: &RestorePipeline,
) -> Result<()> {
    if p.phase == RestorePhase::Active
        || p.target.owner != env.owner()
        || p.target.canister != env.canister()
        || p.target.vault != j.request.target.vault
        || p.target.epoch != j.next_epoch
        || p.target.key_name != store::config(db)?.key_name
    {
        return Err(Error::Unauthorized);
    }
    p.target.bytes()?;

    let h = match store::header(db, &j.request.target.vault) {
        Ok(h) => Some(h),
        Err(Error::NotFound) => None,
        Err(e) => return Err(e),
    };
    if !p.old_removed {
        if h.as_ref().and_then(|h| h.generation.clone()) != j.current_live
            || h.as_ref().map_or(vec![], |h| h.recovery_verifier.clone()) != j.current_verifier
        {
            return Err(Error::Unauthorized);
        }
    } else if h
        .as_ref()
        .is_some_and(|h| h.generation.as_ref() != Some(&p.target) || h.state == VaultState::Active)
    {
        return Err(Error::Unauthorized);
    }
    if let Some(parent) = &j.parent_job {
        let s = store::transition::load_state(db)?;
        let parent = s
            .incident
            .filter(|x| &x.job == parent)
            .ok_or(Error::Unauthorized)?;
        if !parent.targets.iter().any(|t| {
            t.source.generation == j.current_live
                && (!p.old_removed || t.phase == PreparationPhase::Purged)
        }) {
            return Err(Error::Unauthorized);
        }
    }
    Ok(())
}
fn envelope(e: &Envelope) -> Result<()> {
    if e.version != 2 || e.nonce.len() != 12 || e.ciphertext.len() != 48 {
        Err(Error::InvalidInput)
    } else {
        Ok(())
    }
}
pub(crate) fn reservation(p: &RestorePreflight) -> Result<u64> {
    if p.plain_bytes > TOTAL_MAX
        || p.current_plain_bytes > p.plain_bytes
        || p.records > 10000
        || p.objects > p.records
        || p.chunks > p.records.saturating_mul(10)
        || p.current_plain_bytes > VAULT_MAX
        || p.sequence > i64::MAX as u64
        || p.revision_bytes > TOTAL_MAX
        || p.peak_pending_bytes > 400000
        || (p.records == 0
            && (p.objects != 0
                || p.chunks != 0
                || p.revision_bytes != 0
                || p.peak_pending_bytes != 0))
        || (p.records > 0
            && (p.objects == 0 || p.peak_pending_bytes == 0 || p.revision_bytes < p.records * 4096))
    {
        return Err(Error::InvalidInput);
    }
    p.revision_bytes
        .checked_add(p.objects.checked_mul(4096).ok_or(Error::QuotaExceeded)?)
        .filter(|x| *x <= TOTAL_MAX)
        .ok_or(Error::QuotaExceeded)
}
fn scalar(db: &Connection, query: &str, v: &[u8]) -> Result<u64> {
    let n: i64 = db
        .query_row(query, params![v], |r| kinic_sqlite_compat::row_get(r, 0))
        .map_err(|_| Error::Storage)?;
    u64::try_from(n).map_err(|_| Error::Storage)
}
/// Exact reclaimable content only; never account/payment/financial/grant/control rows.
pub(crate) fn projected(
    db: &Connection,
    j: &RestoreAdmissionStatus,
    p: &RestorePreflight,
) -> Result<()> {
    if !store::restore_working::available(db)? {
        return Err(Error::QuotaExceeded);
    }
    let v = &j.request.target.vault;
    let reclaim = if j.current_live.is_some() && j.pipeline.as_ref().is_none_or(|p| !p.old_removed)
    {
        scalar(
            db,
            "SELECT (SELECT count(*)*8192 FROM vaults WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND id=?1)+(SELECT COALESCE(sum(charge),0) FROM revisions WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND vault=?1)+(SELECT count(*)*4096 FROM objects WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND vault=?1)+(SELECT COALESCE(sum(reserved),0) FROM uploads WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND vault=?1)+(SELECT max(count(*)-1,0)*4096 FROM exports WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND vault=?1)",
            v,
        )?
    } else {
        0
    };
    let needed = reservation(p)?
        .checked_add(8192)
        .ok_or(Error::QuotaExceeded)?;
    for usage in [
        store::content::usage(db)?,
        store::content::global_usage(db)?,
    ] {
        if usage
            .checked_sub(reclaim)
            .and_then(|x| x.checked_add(needed))
            .is_none_or(|n| n > TOTAL_MAX)
        {
            return Err(Error::QuotaExceeded);
        }
    }
    for (table, count) in [("objects", p.objects), ("revisions", p.records)] {
        let query = format!(
            "SELECT count(*) FROM {table} WHERE NOT(owner=(SELECT owner FROM owner_scope WHERE slot=1) AND vault=?1)"
        );
        if scalar(db, &query, v)?
            .checked_add(count)
            .is_none_or(|n| n > 10000)
        {
            return Err(Error::QuotaExceeded);
        }
    }

    Ok(())
}
fn header(j: &RestoreAdmissionStatus, p: &RestorePipeline) -> Result<Header> {
    let f = p.preflight.as_ref().ok_or(Error::Conflict)?;
    Ok(Header {
        id: j.request.target.vault.clone(),
        generation: Some(p.target.clone()),
        epoch: p.target.epoch,
        state: VaultState::Restoring,
        normal: p.normal.clone(),
        recovery: p.recovery.clone(),
        recovery_verifier: p.recovery_verifier.clone(),
        sequence: f.sequence,
        backup_sequence: None,
        backup_at: None,
        key_name: p.target.key_name.clone(),
        published_slot: None,
    })
}
fn renew(db: &Connection, env: &impl Environment, v: &[u8]) -> Result<()> {
    let expires = env
        .now()
        .checked_add(DAY)
        .filter(|n| *n <= i64::MAX as u64)
        .ok_or(Error::QuotaExceeded)?;
    db.execute("UPDATE vaults SET expires=?2 WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND id=?1",params![v,expires as i64]).map_err(|_|Error::Storage)?;
    db.execute("UPDATE restores SET expires=?2 WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND vault=?1",params![v,expires as i64]).map_err(|_|Error::Storage)?;
    Ok(())
}
pub(crate) fn apply(
    db: &Connection,
    env: &impl Environment,
    g: &grants::Grant,
    op: &MutationOperation,
) -> Result<MutationResult> {
    let mut j = restore_admission::load(db, restore_grants::job(&g.info.purpose)?)?;
    let free = matches!(g.info.purpose, GrantPurpose::RestoreCleanup { .. });
    if !free
        && !matches!(g.info.purpose, GrantPurpose::RestoreTarget { .. })
        && !matches!(op, MutationOperation::RestoreCancel { .. })
    {
        return Err(Error::Unauthorized);
    }
    if free
        && !matches!(
            op,
            MutationOperation::RestoreDiscard { .. } | MutationOperation::RestoreCancel { .. }
        )
    {
        return Err(Error::Unauthorized);
    }
    if j.cancel_complete && matches!(op, MutationOperation::RestoreCancel { .. }) {
        return Ok(MutationResult::Unit);
    }
    if let MutationOperation::RestoreCancel { cursor } = op {
        if j.pipeline.is_none() {
            if *cursor != 0 {
                return Err(Error::Conflict);
            }
            j.cancel_requested = true;
            let mut c = control(db)?;
            if c.random.as_ref().is_some_and(|f| {
                Some(f.token) == j.allocation_token
                    && f.attempt.as_ref() == Some(&j.request.target.attempt)
            }) {
                c.random = None;
                store::save(db, "control", &c)?;
            }
            let settled = env.cleanup_existing_flights(db, &[], false)?;
            j.cancel_complete = settled
                && !j
                    .allocation_token
                    .map(|t| env.challenge_pending(db, t))
                    .transpose()?
                    .unwrap_or(false);
            restore_admission::save(db, j)?;
            return Ok(MutationResult::Unit);
        }
    }
    let mut p = j.pipeline.clone().ok_or(Error::Conflict)?;
    match op {
        MutationOperation::RestoreStage {
            normal,
            recovery,
            recovery_verifier,
        } if matches!(
            p.phase,
            RestorePhase::Allocated | RestorePhase::EnvelopesStaged
        ) =>
        {
            envelope(normal)?;
            envelope(recovery)?;
            ed25519_dalek::VerifyingKey::from_bytes(
                recovery_verifier
                    .as_slice()
                    .try_into()
                    .map_err(|_| Error::InvalidInput)?,
            )
            .map_err(|_| Error::InvalidInput)?;
            let digest = hash(&(
                j.request.job.clone(),
                j.request.target.clone(),
                p.target.clone(),
                normal,
                recovery,
                recovery_verifier,
            ))?;
            if !p.envelope_digest.is_empty() && p.envelope_digest != digest {
                return Err(Error::Conflict);
            }
            p.normal = Some(normal.clone());
            p.recovery = Some(recovery.clone());
            p.recovery_verifier = recovery_verifier.clone();
            p.envelope_digest = digest;
            p.phase = RestorePhase::EnvelopesStaged;
        }
        MutationOperation::RestoreConfirmKit { envelope_digest }
            if p.phase == RestorePhase::EnvelopesStaged
                && *envelope_digest == p.envelope_digest =>
        {
            p.kit_ack = Some(envelope_digest.clone());
            p.phase = RestorePhase::KitConfirmed;
        }
        MutationOperation::RestorePreflight(f) if p.phase == RestorePhase::KitConfirmed => {
            if f.archive_digest != j.request.archive_digest
                || f.archive_length != j.request.archive_length
                || f.source_commitment != j.request.source_commitment
                || f.records != j.request.records
                || f.target_commitment.len() != 32
                || !f.source_saved
                || !f.source_fully_verified
            {
                return Err(Error::InvalidInput);
            }
            if p.preflight.as_ref().is_some_and(|old| old != f) {
                return Err(Error::Conflict);
            }
            projected(db, &j, f)?;
            p.preflight = Some(f.clone());
        }
        MutationOperation::RestoreDiscard { current, cursor }
            if matches!(
                p.phase,
                RestorePhase::KitConfirmed | RestorePhase::Discarding
            ) =>
        {
            if j.current_live.as_ref() != Some(current)
                || *cursor != p.cleanup_cursor
                || p.old_removed
            {
                return Err(Error::Unauthorized);
            }
            let f = p.preflight.as_ref().ok_or(Error::Conflict)?;
            if p.phase == RestorePhase::KitConfirmed {
                projected(db, &j, f)?;
            }
            p.phase = RestorePhase::Discarding;
            p.discard_started = true;
            if let Some(mut parent) =
                store::incident::status(db)?.filter(|x| Some(&x.job) == j.parent_job.as_ref())
            {
                let t = parent
                    .targets
                    .iter_mut()
                    .find(|t| t.source.generation.as_ref() == Some(current))
                    .ok_or(Error::Unauthorized)?;
                if t.restore_child.as_ref().is_some_and(|x| {
                    x.job != j.request.job
                        || x.attempt != j.request.target.attempt
                        || x.target != p.target
                        || x.archive_digest != j.request.archive_digest
                }) {
                    return Err(Error::Unauthorized);
                }
                t.restore_child = Some(RestoreChildLink {
                    job: j.request.job.clone(),
                    attempt: j.request.target.attempt.clone(),
                    target: p.target.clone(),
                    archive_digest: j.request.archive_digest.clone(),
                });
                incident::save(db, &mut parent)?;
            }
            incident::purge(db, std::slice::from_ref(current), false)?;
            // Publish the destructive phase first in this transaction; all callbacks are fenced.
            j.pipeline = Some(p.clone());
            restore_admission::save(db, j.clone())?;
            let settled =
                env.cleanup_existing_flights(db, std::slice::from_ref(&current.vault), true)?;
            let mut h = store::header(db, &current.vault)?;
            if h.generation.as_ref() != Some(current) {
                return Err(Error::Unauthorized);
            }
            h.state = VaultState::Purging;
            store::put_header(db, &h)?;
            if settled && store::cleanup::purge_batch(db, std::slice::from_ref(&current.vault))? {
                incident::purge(db, std::slice::from_ref(current), true)?;
                p.old_removed = true;
                p.phase = RestorePhase::KitConfirmed;
            }
            p.cleanup_cursor = p
                .cleanup_cursor
                .checked_add(1)
                .ok_or(Error::QuotaExceeded)?;
        }
        MutationOperation::RestoreBeginImport
            if p.phase == RestorePhase::KitConfirmed
                && (j.current_live.is_none() || p.old_removed) =>
        {
            let f = p.preflight.as_ref().ok_or(Error::Conflict)?;
            if p.kit_ack.as_ref() != Some(&p.envelope_digest) {
                return Err(Error::Conflict);
            }
            projected(db, &j, f)?;
            let h = header(&j, &p)?;
            store::restore::begin_prepaid(
                db,
                BeginRestore {
                    header: h.clone(),
                    operation: j.request.target.attempt.clone(),
                    count: f.records,
                    root: f.target_commitment.clone(),
                    reserved_bytes: reservation(f)?,
                },
                env.now(),
            )?;
            store::put_header(db, &h)?;
            p.old_removed = true;
            p.phase = RestorePhase::Importing;
        }
        MutationOperation::RestoreRecord(r) if p.phase == RestorePhase::Importing => {
            let f = p.preflight.as_ref().ok_or(Error::Conflict)?;
            if !r.deleted
                && (store::format::parse(&r.manifest, r.chunk_hashes.len())?.version != 2
                    || store::format::effective(&r.manifest, r.chunk_hashes.len(), None)?
                        != r.manifest)
            {
                return Err(Error::InvalidInput);
            }
            if serde_json::to_vec(r)
                .map_err(|_| Error::InvalidInput)?
                .len() as u64
                > f.peak_pending_bytes
            {
                return Err(Error::QuotaExceeded);
            }
            renew(db, env, &p.target.vault)?;
            store::restore::stage(db, &p.target.vault, r.clone(), env.now())?;
            actual_bounds(db, &j, &p, false)?;
        }
        MutationOperation::RestoreChunk { index, data } if p.phase == RestorePhase::Importing => {
            renew(db, env, &p.target.vault)?;
            store::restore::put(db, &p.target.vault, *index, data, env.now())?;
        }
        MutationOperation::RestoreCommitRecord { sequence }
            if p.phase == RestorePhase::Importing =>
        {
            renew(db, env, &p.target.vault)?;
            store::restore::finish_record(db, &p.target.vault, *sequence, env.now())?;
            actual_bounds(db, &j, &p, false)?;
        }
        MutationOperation::RestoreConfirmBackup(ack)
            if matches!(
                p.phase,
                RestorePhase::Importing | RestorePhase::BackupVerified
            ) =>
        {
            renew(db, env, &p.target.vault)?;
            store::restore::ready(db, &p.target.vault, env.now())?;
            actual_bounds(db, &j, &p, true)?;
            let d = descriptor_inner(&j, &p)?;
            if ack.descriptor_digest != d.descriptor_digest
                || ack.commitment != d.commitment
                || ack.sequence != d.export.sequence
                || ack.recovery_verifier != p.recovery_verifier
                || ack.archive_hash.len() != 32
                || ack.archive_length < 100
                || ack.archive_length > 300 * 1024 * 1024
            {
                return Err(Error::InvalidInput);
            }
            p.backup_ack = Some(ack.clone());
            p.phase = RestorePhase::BackupVerified;
        }
        MutationOperation::RestoreActivate if p.phase == RestorePhase::BackupVerified => {
            renew(db, env, &p.target.vault)?;
            store::restore::ready(db, &p.target.vault, env.now())?;
            actual_bounds(db, &j, &p, true)?;
            if p.kit_ack.as_ref() != Some(&p.envelope_digest) || p.backup_ack.is_none() {
                return Err(Error::Conflict);
            }
            restore_candidate::promote(db, &j, &p.target)?;
            let mut h = header(&j, &p)?;
            h.state = VaultState::Active;
            h.backup_sequence = Some(h.sequence);
            h.backup_at = Some(env.now());
            store::put_header(db, &h)?;
            db.execute("UPDATE vaults SET expires=0 WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND id=?1",params![p.target.vault]).map_err(|_|Error::Storage)?;
            db.execute("DELETE FROM restores WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND vault=?1",params![p.target.vault]).map_err(|_|Error::Storage)?;
            let mut stmt=db.prepare("SELECT value FROM settings WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND key LIKE 'grant:%' LIMIT 6").map_err(|_|Error::Storage)?;
            let rows: Vec<String> = kinic_sqlite_compat::query_map(&mut stmt, params![], |r| {
                kinic_sqlite_compat::row_get(r, 0)
            })
            .map_err(|_| Error::Storage)?;
            for raw in rows {
                let mut grant: grants::Grant =
                    serde_json::from_str(&raw).map_err(|_| Error::Storage)?;
                if restore_grants::job(&grant.info.purpose).is_ok_and(|job| job == &j.request.job)
                    || j.existing_candidate
                        .as_ref()
                        .is_some_and(|c| c.credential == grant.credential)
                {
                    grant.revoked = true;
                    grants::save(db, &grant)?;
                }
            }
            p.phase = RestorePhase::Active;
        }
        MutationOperation::RestoreCancel { cursor } if p.phase != RestorePhase::Active => {
            if *cursor != p.cleanup_cursor {
                return Err(Error::Conflict);
            }
            j.cancel_requested = true;
            let destructive = p.old_removed || p.discard_started;
            p.phase = RestorePhase::Cancelling;
            j.pipeline = Some(p.clone());
            restore_admission::save(db, j.clone())?;
            let settled =
                env.cleanup_existing_flights(db, std::slice::from_ref(&p.target.vault), true)?;
            let mut c = control(db)?;
            if c.random.as_ref().is_some_and(|f| {
                f.attempt.as_ref() == Some(&j.request.target.attempt) && f.vault == p.target.vault
            }) {
                c.random = None;
                store::save(db, "control", &c)?;
            }
            if settled
                && !j
                    .allocation_token
                    .map(|t| env.challenge_pending(db, t))
                    .transpose()?
                    .unwrap_or(false)
            {
                if destructive {
                    let done = match store::header(db, &p.target.vault) {
                        Ok(h) => {
                            if h.generation.as_ref() != Some(&p.target)
                                && h.generation != j.current_live
                            {
                                return Err(Error::Unauthorized);
                            }
                            store::cleanup::purge_batch(db, std::slice::from_ref(&p.target.vault))?
                        }
                        Err(Error::NotFound) => true,
                        Err(e) => return Err(e),
                    };
                    if done {
                        if let Some(old) = &j.current_live {
                            incident::purge(db, std::slice::from_ref(old), true)?;
                        }
                        p.old_removed = true;
                        p.phase = RestorePhase::Cancelled;
                    }
                } else {
                    p.phase = RestorePhase::Cancelled;
                }
            }
            p.cleanup_cursor = p
                .cleanup_cursor
                .checked_add(1)
                .ok_or(Error::QuotaExceeded)?;
        }
        _ => return Err(Error::Unauthorized),
    }
    if p.phase == RestorePhase::Cancelled {
        j.cancel_complete = true;
    }
    j.pipeline = Some(p);
    restore_admission::save(db, j)?;
    Ok(MutationResult::Unit)
}
fn actual_bounds(
    db: &Connection,
    j: &RestoreAdmissionStatus,
    p: &RestorePipeline,
    exact: bool,
) -> Result<()> {
    let f = p.preflight.as_ref().ok_or(Error::Conflict)?;
    let v = &j.request.target.vault;
    for (q, expected) in [
        (
            "SELECT count(*) FROM revisions WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND vault=?1",
            f.records,
        ),
        (
            "SELECT count(*) FROM objects WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND vault=?1",
            f.objects,
        ),
        (
            "SELECT COALESCE(sum(charge),0) FROM revisions WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND vault=?1",
            f.revision_bytes,
        ),
        (
            "SELECT COALESCE(sum(plain_size),0) FROM revisions WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND vault=?1",
            f.plain_bytes,
        ),
        (
            "SELECT COALESCE(sum(json_array_length(hashes)),0) FROM revisions WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND vault=?1",
            f.chunks,
        ),
    ] {
        let n = scalar(db, q, v)?;
        if n > expected || exact && n != expected {
            return Err(Error::QuotaExceeded);
        }
    }
    let current = scalar(
        db,
        "SELECT COALESCE(sum(r.plain_size),0) FROM revisions r JOIN objects o ON r.owner=o.owner AND r.vault=o.vault AND r.object=o.object AND r.revision=o.head WHERE r.owner=(SELECT owner FROM owner_scope WHERE slot=1) AND r.vault=?1 AND r.deleted=0",
        v,
    )?;
    if exact && (current > VAULT_MAX || current != f.current_plain_bytes) {
        return Err(Error::QuotaExceeded);
    }
    // stage/finish consume the already charged import reservation, including legacy
    // pending JSON. Migration may leave global usage overcommitted; completing that
    // fixed reservation must not require additional absolute capacity. All declared
    // costs/counts above and store-level reservation/row bounds remain enforced.
    Ok(())
}
fn descriptor_inner(j: &RestoreAdmissionStatus, p: &RestorePipeline) -> Result<StagedExport> {
    let f = p.preflight.as_ref().ok_or(Error::Conflict)?;
    let e = Export {
        id: j.request.target.attempt.clone(),
        vault: p.target.vault.clone(),
        sequence: f.sequence,
        expires: i64::MAX as u64,
        state: "Restore".into(),
        record_count: f.records,
        chunk_count: f.chunks,
        plain_bytes: f.plain_bytes,
        header: header(j, p)?,
    };
    Ok(StagedExport {
        descriptor_digest: hash(&(
            "restore-backup/v2",
            &j.request,
            &p.target,
            &p.envelope_digest,
            f,
        ))?,
        export: e,
        commitment: f.target_commitment.clone(),
    })
}
fn read(
    db: &Connection,
    env: &impl Environment,
    job: &[u8],
    target: &Generation,
) -> Result<(RestoreAdmissionStatus, RestorePipeline)> {
    store::authorize(db, env.owner())?;
    let j = restore_admission::load(db, job)?;
    let p = j.pipeline.clone().ok_or(Error::NotFound)?;
    if &p.target != target
        || !matches!(
            p.phase,
            RestorePhase::Importing | RestorePhase::BackupVerified
        )
    {
        return Err(Error::Unauthorized);
    }
    let h = store::header(db, &target.vault)?;
    if h.generation.as_ref() != Some(target) || h.state != VaultState::Restoring {
        return Err(Error::Unauthorized);
    }
    Ok((j, p))
}
pub fn descriptor(env: &impl Environment, job: Id, target: Generation) -> Result<StagedExport> {
    env.transaction(|db| {
        let (j, p) = read(db, env, &job, &target)?;
        store::restore::ready(db, &target.vault, 0)?;
        actual_bounds(db, &j, &p, true)?;
        descriptor_inner(&j, &p)
    })
}
pub fn index(
    env: &impl Environment,
    job: Id,
    target: Generation,
    after: u64,
) -> Result<ExportPage> {
    env.transaction(|db| {
        let (j, p) = read(db, env, &job, &target)?;
        let h = header(&j, &p)?;
        store::content::snapshot_index(db, &h, h.sequence, after)
    })
}
pub fn chunk(
    env: &impl Environment,
    job: Id,
    target: Generation,
    object: Id,
    revision: u64,
    index: u32,
) -> Result<Vec<u8>> {
    env.transaction(|db| {
        let (j, p) = read(db, env, &job, &target)?;
        store::content::snapshot_chunk(
            db,
            &target.vault,
            header(&j, &p)?.sequence,
            &object,
            revision,
            index,
        )
    })
}
pub fn progress(env: &impl Environment, job: Id, target: Generation) -> Result<RestoreProgress> {
    env.transaction(|db| {
        read(db, env, &job, &target)?;
        store::restore::status(db, &target.vault)
    })
}
