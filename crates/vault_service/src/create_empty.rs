//! Explicit provisional authority to create one empty target with an existing scoped key.
use super::*;
pub fn status(env: &impl Environment) -> Result<Option<CreateEmptyStatus>> {
    env.transaction(|db| {
        store::authorize(db, env.owner())?;
        Ok(store::transition::load_state(db)?.creation)
    })
}
pub(crate) fn load(db: &Connection, job: &[u8]) -> Result<CreateEmptyStatus> {
    store::transition::load_state(db)?
        .creation
        .filter(|j| j.job == job)
        .ok_or(Error::Unauthorized)
}
pub(crate) fn save(db: &Connection, j: CreateEmptyStatus) -> Result<()> {
    let mut s = store::transition::load_state(db)?;
    s.creation = Some(j);
    store::transition::save_state(db, &s)
}
pub(crate) fn job(p: &GrantPurpose) -> Result<&Id> {
    match p {
        GrantPurpose::CreateEmpty { job, .. } => Ok(job),
        _ => Err(Error::Unauthorized),
    }
}
fn source(
    db: &Connection,
    env: &impl Environment,
    credential: &[u8],
    source: &Generation,
) -> Result<()> {
    source.bytes()?;
    let a = authorization::authority(db, credential)?;
    restore_candidate::instances(&a)?;
    restore_candidate::credential(db, credential)?;
    let h = store::header(db, &source.vault)?;
    if source.owner != env.owner()
        || source.canister != env.canister()
        || !authorization::covers(&a.scope, source)
        || h.generation.as_ref() != Some(source)
        || h.state != VaultState::Active
    {
        return Err(Error::Unauthorized);
    }
    cleanup::normal_allowed(db, &h)?;
    Ok(())
}
fn merged(
    db: &Connection,
    credential: &[u8],
    target: Option<&Generation>,
) -> Result<CredentialScope> {
    let a = authorization::authority(db, credential)?;
    let s = store::transition::load_state(db)?;
    let mut xs = Vec::new();
    for x in restore_candidate::instances(&a)? {
        if store::transition::instance_referenced(db, &s, x)? {
            xs.push(x.clone());
        }
    }
    if xs.len() >= 3 {
        return Err(Error::QuotaExceeded);
    }
    if let Some(g) = target {
        xs.push(Instance {
            vault: g.vault.clone(),
            nonce: g.nonce.clone(),
        });
    }
    Ok(CredentialScope::Instances(xs))
}
pub(crate) fn current(
    db: &Connection,
    env: &impl Environment,
    j: &CreateEmptyStatus,
) -> Result<()> {
    if !store::transition::creation_unfinished(j) || j.phase == CreateEmptyPhase::Cancelling {
        return Err(Error::Unauthorized);
    }
    source(db, env, &j.creator.credential, &j.authorizer_instance)?;
    let (_, digest, bound) = restore_candidate::capture(db, &j.creator.credential)?;
    if digest != j.key_digest
        || bound != j.creator
        || cleanup::namespace(db)?.identity != j.target.namespace
    {
        return Err(Error::Unauthorized);
    }
    merged(db, &j.creator.credential, None)?;
    target(db, j)?;
    Ok(())
}
/// Validate a request before randomness and again after UV; an existing job cannot change identity.
pub(crate) fn validate(db: &Connection, env: &impl Environment, r: &GrantRequest) -> Result<()> {
    let GrantPurpose::CreateEmpty {
        job,
        target: t,
        authorizer_instance,
    } = &r.purpose
    else {
        return Err(Error::Unauthorized);
    };
    for x in [job, &t.vault, &t.attempt] {
        id(x)?;
    }
    if r.generations != [authorizer_instance.clone()] || t.vault == authorizer_instance.vault {
        return Err(Error::Unauthorized);
    }
    source(db, env, &r.credential, authorizer_instance)?;
    let n = cleanup::namespace(db)?;
    if t.namespace.len() != 32 || n.identity != t.namespace || n.seed.is_none() {
        return Err(Error::Unauthorized);
    }
    let s = store::transition::load_state(db)?;
    if let Some(j) = s.creation.as_ref().filter(|j| j.job == *job) {
        if j.target != *t
            || j.authorizer_instance != *authorizer_instance
            || j.creator.credential != r.credential
        {
            return Err(Error::Unauthorized);
        }
        return current(db, env, j);
    }
    if store::transition::pending_state(&s) || n.job.as_ref().is_some_and(|j| !j.complete) {
        return Err(Error::Busy);
    }
    match store::header(db, &t.vault) {
        Err(Error::NotFound) => {}
        Ok(_) => return Err(Error::Conflict),
        Err(e) => return Err(e),
    }
    // Legacy non-active headers and imports also occupy the sole owner job slot.
    let pending:i64=db.query_row("SELECT (SELECT count(*) FROM vaults WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND json_extract(header,'$.state')!='Active')+(SELECT count(*) FROM restores WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1))",params![],|r|kinic_sqlite_compat::row_get(r,0)).map_err(|_|Error::Storage)?;
    if pending != 0 {
        return Err(Error::Busy);
    }
    if store::list(db)?.len() >= 3 {
        return Err(Error::QuotaExceeded);
    }
    store::setup::reject_discarded(db, &t.vault, &t.attempt, env.now())?;
    merged(db, &r.credential, None)?;
    store::content::check_capacity(db, 8192)
}
pub(crate) fn admit(db: &Connection, env: &impl Environment, r: &GrantRequest) -> Result<()> {
    validate(db, env, r)?;
    let GrantPurpose::CreateEmpty {
        job,
        target,
        authorizer_instance,
    } = &r.purpose
    else {
        return Err(Error::Unauthorized);
    };
    if store::transition::load_state(db)?
        .creation
        .as_ref()
        .is_some_and(|j| j.job == *job)
    {
        return Ok(());
    }
    let (_, key_digest, creator) = restore_candidate::capture(db, &r.credential)?;
    save(
        db,
        CreateEmptyStatus {
            job: job.clone(),
            target: target.clone(),
            authorizer_instance: authorizer_instance.clone(),
            creator,
            key_digest,
            phase: CreateEmptyPhase::Admitted,
            generation: None,
            normal: None,
            recovery: None,
            recovery_verifier: vec![],
            envelope_digest: vec![],
            kit_ack: None,
            allocation_token: None,
            cleanup_cursor: 0,
        },
    )
}
/// Never accept data-bearing or ever-active state even for cancellation.
pub(crate) fn target(db: &Connection, j: &CreateEmptyStatus) -> Result<Option<Header>> {
    let h = match store::header(db, &j.target.vault) {
        Ok(h) => Some(h),
        Err(Error::NotFound) => None,
        Err(e) => return Err(e),
    };
    if let Some(h) = &h {
        if h.state != VaultState::Pending || h.sequence != 0 || h.generation != j.generation {
            return Err(Error::Unauthorized);
        }
        store::setup::check_attempt(db, h, Some(&j.target.attempt))?;
    } else if j.generation.is_some() && j.phase != CreateEmptyPhase::Cancelled {
        return Err(Error::Unauthorized);
    }
    let rows:i64=db.query_row("SELECT (SELECT count(*) FROM revisions WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND vault=?1)+(SELECT count(*) FROM objects WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND vault=?1)+(SELECT count(*) FROM uploads WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND vault=?1)+(SELECT count(*) FROM restores WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND vault=?1)",params![j.target.vault],|r|kinic_sqlite_compat::row_get(r,0)).map_err(|_|Error::Storage)?;
    if rows != 0 {
        return Err(Error::Unauthorized);
    }
    Ok(h)
}
pub(crate) fn role(
    db: &Connection,
    env: &impl Environment,
    r: &IncidentDerive,
) -> Result<Generation> {
    let j = load(db, &r.job)?;
    current(db, env, &j)?;
    if r.role != IncidentRole::Target
        || r.attempt != j.target.attempt
        || j.generation.as_ref() != Some(&r.generation)
    {
        return Err(Error::Unauthorized);
    }
    Ok(r.generation.clone())
}
pub(crate) fn apply(
    db: &Connection,
    env: &impl Environment,
    g: &mut grants::Grant,
    op: &MutationOperation,
) -> Result<MutationResult> {
    let mut j = load(db, job(&g.info.purpose)?)?;
    current(db, env, &j)?;
    match op {
        MutationOperation::CreateEmptyStage {
            normal,
            recovery,
            recovery_verifier,
        } if j.phase == CreateEmptyPhase::Allocated => {
            if recovery_verifier.len() != 32
                || normal.nonce == recovery.nonce
                || [normal, recovery]
                    .iter()
                    .any(|e| e.version != 2 || e.nonce.len() != 12 || e.ciphertext.len() != 48)
            {
                return Err(Error::InvalidInput);
            }
            ed25519_dalek::VerifyingKey::from_bytes(
                recovery_verifier
                    .as_slice()
                    .try_into()
                    .map_err(|_| Error::InvalidInput)?,
            )
            .map_err(|_| Error::InvalidInput)?;
            j.envelope_digest = hash(&(
                "create-empty-envelopes/v2",
                &j.job,
                &j.target,
                &j.generation,
                normal,
                recovery,
                recovery_verifier,
            ))?;
            j.normal = Some(normal.clone());
            j.recovery = Some(recovery.clone());
            j.recovery_verifier = recovery_verifier.clone();
            j.phase = CreateEmptyPhase::EnvelopesStaged;
        }
        MutationOperation::CreateEmptyConfirmKit { envelope_digest }
            if j.phase == CreateEmptyPhase::EnvelopesStaged
                && envelope_digest == &j.envelope_digest =>
        {
            j.kit_ack = Some(envelope_digest.clone());
            j.phase = CreateEmptyPhase::KitConfirmed;
        }
        MutationOperation::CreateEmptyActivate
            if j.phase == CreateEmptyPhase::KitConfirmed
                && j.kit_ack.as_ref() == Some(&j.envelope_digest) =>
        {
            let generation = j.generation.as_ref().ok_or(Error::Unauthorized)?;
            let scope = merged(db, &j.creator.credential, Some(generation))?;
            let mut h = target(db, &j)?.ok_or(Error::Unauthorized)?;
            h.normal = j.normal.clone();
            h.recovery = j.recovery.clone();
            h.recovery_verifier = j.recovery_verifier.clone();
            h.sequence = 1;
            h.state = VaultState::Active;
            let mut all = authorization::authorities(db)?;
            let a = all
                .credentials
                .iter_mut()
                .find(|a| a.id == j.creator.credential)
                .ok_or(Error::Unauthorized)?;
            let mut n = cleanup::namespace(db)?;
            n.serial = n
                .serial
                .checked_add(1)
                .filter(|n| *n <= i64::MAX as u64)
                .ok_or(Error::QuotaExceeded)?;
            a.version = n.serial;
            a.scope = scope;
            cleanup::save(db, &n)?;
            store::save(db, "authorities", &all)?;
            store::put_header(db, &h)?;
            db.execute("UPDATE vaults SET expires=0 WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND id=?1",params![h.id]).map_err(|_|Error::Storage)?;
            j.phase = CreateEmptyPhase::Active;
            // Status is the ambiguous-response channel; all old physical-key grants are invalid.
            g.revoked = true;
        }
        _ => return Err(Error::Unauthorized),
    }
    save(db, j)?;
    Ok(MutationResult::Unit)
}
/// Narrow owner-II exception: no key, reset, credential, source effect or Active deletion.
pub fn cancel(
    env: &impl Environment,
    job: Id,
    pending: PendingCreation,
    generation: Option<Generation>,
    cursor: u64,
) -> Result<CleanupProgress> {
    env.transaction(|db| {
        store::authorize(db, env.owner())?;
        let mut j = load(db, &job)?;
        if j.target != pending
            || j.generation != generation
            || pending.namespace != cleanup::namespace(db)?.identity
            || j.authorizer_instance.owner != env.owner()
            || j.authorizer_instance.canister != env.canister()
            || j.phase == CreateEmptyPhase::Active
        {
            return Err(Error::Unauthorized);
        }
        if j.phase == CreateEmptyPhase::Cancelled {
            if cursor.checked_add(1) != Some(j.cleanup_cursor) && cursor != j.cleanup_cursor {
                return Err(Error::Conflict);
            }
            target(db, &j)?;
            return Ok(CleanupProgress {
                job,
                cursor: j.cleanup_cursor,
                complete: true,
            });
        }
        if j.phase == CreateEmptyPhase::Cancelling
            && cursor.checked_add(1) == Some(j.cleanup_cursor)
        {
            target(db, &j)?;
            return Ok(CleanupProgress {
                job,
                cursor: j.cleanup_cursor,
                complete: false,
            });
        }
        if cursor != j.cleanup_cursor {
            return Err(Error::Conflict);
        }
        target(db, &j)?;
        cleanup::budget(db, env.now(), 2)?;
        j.phase = CreateEmptyPhase::Cancelling;
        let settled =
            env.cleanup_existing_flights(db, std::slice::from_ref(&j.target.vault), true)?;
        let allocation_pending = j
            .allocation_token
            .map(|t| env.challenge_pending(db, t))
            .transpose()?
            .unwrap_or(false);
        let mut c = control(db)?;
        let matches =
            |f: &Flight| f.vault == j.target.vault && f.attempt.as_ref() == Some(&j.target.attempt);
        if c.random.as_ref().is_some_and(matches) && !allocation_pending {
            c.random = None;
        }
        // Key reservation rows are retained and settled by existing accounting, never erased here.
        if settled && !allocation_pending {
            if target(db, &j)?.is_some() {
                store::setup::cancel(db, &j.target.vault, &j.target.attempt, env.now())?;
            }
            if c.derive.as_ref().is_some_and(matches) {
                c.derive = None;
            }
            j.phase = CreateEmptyPhase::Cancelled;
        }
        store::save(db, "control", &c)?;
        j.cleanup_cursor = j
            .cleanup_cursor
            .checked_add(1)
            .ok_or(Error::QuotaExceeded)?;
        let result = CleanupProgress {
            job,
            cursor: j.cleanup_cursor,
            complete: j.phase == CreateEmptyPhase::Cancelled,
        };
        save(db, j)?;
        Ok(result)
    })
}
