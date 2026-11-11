//! Irreversible incident admission and bounded target preparation. No publication path.
use super::*;
pub(crate) fn semantic(db: &Connection, env: &impl Environment) -> Result<Vec<u8>> {
    let c = store::config(db)?;
    hash(&(
        env.owner(),
        env.canister(),
        cleanup::namespace(db)?.identity,
        c.origin,
        c.rp_id,
        c.key_name,
    ))
}
pub fn status(env: &impl Environment) -> Result<Option<IncidentStatus>> {
    // The adapter establishes authenticated owner scope. No config or key is needed to read
    // already persisted ciphertext/status, including forced incompatible configuration.
    env.transaction(store::incident::status)
}
pub(crate) fn load(db: &Connection, env: &impl Environment) -> Result<IncidentStatus> {
    let j = store::incident::status(db)?
        .filter(|j| !j.complete)
        .ok_or(Error::Conflict)?;
    if j.semantic_config != semantic(db, env)? {
        return Err(Error::Conflict);
    }
    for t in &j.targets {
        if terminal(t) {
            continue;
        }
        let h = store::header(db, &t.source.id)?;
        if h.state != VaultState::IncidentRequired
            || h.generation != t.source.generation
            || h.sequence != t.snapshot_sequence
        {
            return Err(Error::Conflict);
        }
    }
    Ok(j)
}
pub(crate) fn vector(j: &IncidentStatus) -> Result<Vec<u8>> {
    let mut bytes = b"kinic-vault/incident-vector/v2\0".to_vec();
    sized(&mut bytes, &j.namespace);
    sized(&mut bytes, &j.job);
    for t in &j.targets {
        sized(
            &mut bytes,
            &t.source
                .generation
                .as_ref()
                .ok_or(Error::Storage)?
                .bytes()?,
        );
        sized(&mut bytes, &t.attempt);
        // Preserve existing v2 vectors for ordinary preparation phases. Tag 2 cannot
        // alias the legacy target Option tags (0/1); terminal/discard states add identity.
        match t.phase {
            PreparationPhase::Purging => bytes.extend_from_slice(&[2, 1]),
            PreparationPhase::Purged => bytes.extend_from_slice(&[2, 2]),
            PreparationPhase::Cancelling => bytes.extend_from_slice(&[2, 3]),
            PreparationPhase::Cancelled => bytes.extend_from_slice(&[2, 4]),
            _ => {}
        }
        match &t.target {
            Some(g) => {
                bytes.push(1);
                sized(&mut bytes, &g.bytes()?);
            }
            None => bytes.push(0),
        }
    }
    Ok(Sha256::digest(bytes).to_vec())
}
pub(crate) fn save(db: &Connection, j: &mut IncidentStatus) -> Result<()> {
    j.vector_digest = vector(j)?;
    store::save(db, "transition", j)
}
fn safe_authority(
    db: &Connection,
    credential: &[u8],
    compromised: &[CredentialRevocation],
    sources: &[Generation],
) -> Result<()> {
    let a = authorization::authority(db, credential)?;
    if a.revoked
        || compromised.iter().any(|c| c.credential == credential)
        || sources.iter().any(|g| !authorization::covers(&a.scope, g))
    {
        return Err(Error::Unauthorized);
    }
    Ok(())
}
pub(crate) fn terminal(t: &IncidentTarget) -> bool {
    matches!(
        t.phase,
        PreparationPhase::Purging | PreparationPhase::Purged
    )
}
pub(crate) fn sources(j: &IncidentStatus) -> Result<Vec<Generation>> {
    j.targets
        .iter()
        .filter(|t| !terminal(t))
        .map(|t| t.source.generation.clone().ok_or(Error::Storage))
        .collect()
}
pub(crate) fn validate(
    db: &Connection,
    env: &impl Environment,
    credential: &[u8],
    purpose: &GrantPurpose,
    generations: &[Generation],
) -> Result<()> {
    match purpose {
        GrantPurpose::IncidentPrepare(r) => {
            id(&r.job)?;
            if r.namespace != cleanup::namespace(db)?.identity
                || r.sources.is_empty()
                || r.sources.len() > 3
                || r.sources != generations
                || r.targets.len() != r.sources.len()
                || r.compromised.is_empty()
                || r.compromised.len() > 9
            {
                return Err(Error::Unauthorized);
            }
            safe_authority(db, credential, &r.compromised, &r.sources)?;
            for (i, (g, t)) in r.sources.iter().zip(&r.targets).enumerate() {
                g.bytes()?;
                id(&t.attempt)?;
                if g.owner != env.owner()
                    || g.canister != env.canister()
                    || t.namespace != r.namespace
                    || t.vault != g.vault
                    || r.sources[..i].iter().any(|x| x.vault == g.vault)
                {
                    return Err(Error::Unauthorized);
                }
            }
            if store::incident::pending(db)? {
                let j = load(db, env)?;
                if j.job != r.job
                    || j.compromised != r.compromised
                    || sources(&j)? != r.sources
                    || j.targets
                        .iter()
                        .filter(|t| !terminal(t))
                        .zip(&r.targets)
                        .any(|(a, b)| a.attempt != b.attempt)
                {
                    return Err(Error::Unauthorized);
                }
                return Ok(());
            }
            let mut compromised = Vec::new();
            for (i, c) in r.compromised.iter().enumerate() {
                if c.credential.is_empty()
                    || c.credential.len() > 1024
                    || i > 0 && r.compromised[i - 1].credential >= c.credential
                {
                    return Err(Error::InvalidInput);
                }
                let a = authorization::authority(db, &c.credential)?;
                if a.revoked || a.version != c.version {
                    return Err(Error::Unauthorized);
                }
                compromised.push(a);
            }
            let all = store::list(db)?;
            if compromised
                .iter()
                .any(|a| a.scope == CredentialScope::Global)
                && all.iter().any(|h| h.generation.is_none())
            {
                return Err(Error::Conflict);
            }
            let affected: Vec<Generation> = all
                .iter()
                .filter_map(|h| h.generation.clone())
                .filter(|g| {
                    compromised
                        .iter()
                        .any(|a| authorization::covers(&a.scope, g))
                })
                .collect();
            if affected != r.sources {
                return Err(Error::Unauthorized);
            }
            for g in &r.sources {
                let h = store::active(db, &g.vault)?;
                if h.generation.as_ref() != Some(g) {
                    return Err(Error::Unauthorized);
                }
                next_epoch(g.epoch)?;
                h.sequence
                    .checked_add(1)
                    .filter(|n| *n <= i64::MAX as u64)
                    .ok_or(Error::QuotaExceeded)?;
            }
            Ok(())
        }
        GrantPurpose::IncidentCutover { job, digest } => {
            let j = load(db, env)?;
            if &j.job != job
                || sources(&j)? != generations
                || &incident_cutover::digest(db, env)? != digest
            {
                return Err(Error::Unauthorized);
            }
            safe_authority(db, credential, &j.compromised, generations)
        }
        GrantPurpose::Incident { job, vector_digest } => {
            let j = load(db, env)?;
            if &j.job != job
                || &j.vector_digest != vector_digest
                || sources(&j)? != generations
                || j.targets.iter().filter(|t| !terminal(t)).any(|t| {
                    t.target.is_none()
                        || matches!(
                            t.phase,
                            PreparationPhase::Cancelling | PreparationPhase::Cancelled
                        )
                })
            {
                return Err(Error::Unauthorized);
            }
            safe_authority(db, credential, &j.compromised, generations)
        }
        _ => Err(Error::Unauthorized),
    }
}
pub(crate) fn start(
    db: &Connection,
    env: &impl Environment,
    g: &grants::Grant,
) -> Result<IncidentStatus> {
    let GrantPurpose::IncidentPrepare(r) = &g.info.purpose else {
        return Err(Error::Unauthorized);
    };
    validate(db, env, &g.credential, &g.info.purpose, &g.info.generations)?;
    if store::incident::pending(db)? {
        return load(db, env);
    }
    // All owner conflicts, unsettled flights and storage admission are checked BEFORE revoke.
    let conflicts:i64=db.query_row("SELECT (SELECT count(*) FROM vaults WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND json_extract(header,'$.state')<>'Active')+(SELECT count(*) FROM uploads WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1))+(SELECT count(*) FROM restores WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1))+(SELECT count(*) FROM exports WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND state='Active' AND expires>?1)+(SELECT count(*) FROM key_flights WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND (in_flight=1 OR phase='cancelled'))",params![env.now() as i64],|r|kinic_sqlite_compat::row_get(r,0)).map_err(|_|Error::Storage)?;
    if conflicts != 0 || cleanup::namespace(db)?.job.is_some_and(|j| !j.complete) {
        return Err(Error::Busy);
    }
    let c = control(db)?;
    if c.random.as_ref().is_some_and(|f| f.expires > env.now()) || c.derive.is_some() {
        return Err(Error::Busy);
    }
    let slots:i64=db.query_row("SELECT count(*) FROM settings WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND key LIKE 'grant-slot:%'",params![],|r|kinic_sqlite_compat::row_get(r,0)).map_err(|_|Error::Storage)?;
    let prepaid:i64=db.query_row("SELECT EXISTS(SELECT 1 FROM settings WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND key='transition')",params![],|r|kinic_sqlite_compat::row_get(r,0)).map_err(|_|Error::Storage)?;
    if slots == 0 || prepaid == 0 {
        return Err(Error::Busy);
    }
    store::keys::admit_rows(db, r.sources.len() * 2)?;
    let mut targets = Vec::new();
    for (source, pending) in r.sources.iter().zip(&r.targets) {
        let h = store::active(db, &source.vault)?;
        let inactive = 1 - h.published_slot.unwrap_or(1);
        let rows:i64=db.query_row("SELECT count(*) FROM wrapper_slots WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND vault=?1 AND slot=?2",params![source.vault,inactive as i64],|r|kinic_sqlite_compat::row_get(r,0)).map_err(|_|Error::Storage)?;
        if rows != 0 {
            return Err(Error::Busy);
        }
        targets.push(IncidentTarget {
            snapshot_time: env.now(),
            snapshot_sequence: h.sequence,
            source: h,
            target: None,
            attempt: pending.attempt.clone(),
            next_epoch: next_epoch(source.epoch)?,
            reset_attempt: None,
            phase: PreparationPhase::PendingNonce,
            normal: None,
            recovery: None,
            recovery_verifier: vec![],
            envelope_digest: vec![],
            kit_ack: None,
            coverage: None,
            staged_export: None,
            backup_ack: None,
        });
    }
    let mut j = IncidentStatus {
        job: r.job.clone(),
        namespace: r.namespace.clone(),
        compromised: r.compromised.clone(),
        semantic_config: semantic(db, env)?,
        targets,
        vector_digest: vec![],
        complete: false,
        cancel_digest: None,
        completed_digest: None,
    };
    // Enforce the prepaid bound before the irreversible effects (same transaction).
    save(db, &mut j)?;
    let a = authorization::authority(db, &g.credential)?;
    // Actual source coverage, not a broad scope-label comparison: a scoped surviving key
    // covering all current sources may handle a Global key without acquiring Global rights.
    authorization::revoke_incident(db, &a, &r.compromised, &r.sources)?;
    for t in &j.targets {
        let mut h = t.source.clone();
        h.state = VaultState::IncidentRequired;
        store::put_header(db, &h)?;
    }
    let mut s=db.prepare("SELECT key,value FROM settings WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND key LIKE 'grant:%' LIMIT 6").map_err(|_|Error::Storage)?;
    let rows: Vec<(String, String)> = kinic_sqlite_compat::query_map(&mut s, params![], |r| {
        Ok((
            kinic_sqlite_compat::row_get(r, 0)?,
            kinic_sqlite_compat::row_get(r, 1)?,
        ))
    })
    .map_err(|_| Error::Storage)?;
    for (_, raw) in rows {
        let mut old: grants::Grant = serde_json::from_str(&raw).map_err(|_| Error::Storage)?;
        if old.info.id != g.info.id
            && (matches!(
                old.info.purpose,
                GrantPurpose::Create | GrantPurpose::Credentials
            ) || matches!(old.info.purpose, GrantPurpose::Normal)
                && (old.info.generations.is_empty()
                    || old.info.generations.iter().any(|x| r.sources.contains(x))))
        {
            old.revoked = true;
            grants::save(db, &old)?;
        }
    }
    Ok(j)
}
pub(crate) fn target<'a>(
    j: &'a mut IncidentStatus,
    vault: &[u8],
    attempt: &[u8],
) -> Result<&'a mut IncidentTarget> {
    j.targets
        .iter_mut()
        .find(|t| !terminal(t) && t.source.id == vault && t.attempt == attempt)
        .ok_or(Error::Unauthorized)
}
pub(crate) fn role(
    db: &Connection,
    env: &impl Environment,
    r: &IncidentDerive,
) -> Result<Generation> {
    let mut j = load(db, env)?;
    if j.job != r.job {
        return Err(Error::Unauthorized);
    }
    let t = target(&mut j, &r.generation.vault, &r.attempt)?;
    let actual = match r.role {
        IncidentRole::Source => t.source.generation.as_ref(),
        IncidentRole::Target => t.target.as_ref(),
    }
    .ok_or(Error::Unauthorized)?;
    if actual != &r.generation
        || matches!(
            t.phase,
            PreparationPhase::PendingNonce
                | PreparationPhase::Resetting
                | PreparationPhase::Cancelling
                | PreparationPhase::Cancelled
                | PreparationPhase::Purging
                | PreparationPhase::Purged
        )
    {
        return Err(Error::Unauthorized);
    }
    Ok(actual.clone())
}
pub(crate) fn stage(
    db: &Connection,
    env: &impl Environment,
    vault: &[u8],
    attempt: &[u8],
    normal: &Envelope,
    recovery: &Envelope,
    verifier: &[u8],
) -> Result<IncidentStatus> {
    let mut j = load(db, env)?;
    let t = target(&mut j, vault, attempt)?;
    if t.phase != PreparationPhase::Allocated {
        return Err(Error::Conflict);
    }
    for e in [normal, recovery] {
        if e.version != 2 || e.nonce.len() != 12 || e.ciphertext.len() != 48 {
            return Err(Error::InvalidInput);
        }
    }
    if normal.nonce == recovery.nonce {
        return Err(Error::InvalidInput);
    }
    ed25519_dalek::VerifyingKey::from_bytes(verifier.try_into().map_err(|_| Error::InvalidInput)?)
        .map_err(|_| Error::InvalidInput)?;
    t.envelope_digest = hash(&(
        t.target.as_ref().ok_or(Error::Conflict)?,
        normal,
        recovery,
        verifier,
    ))?;
    t.normal = Some(normal.clone());
    t.recovery = Some(recovery.clone());
    t.recovery_verifier = verifier.to_vec();
    t.phase = PreparationPhase::EnvelopesStaged;
    save(db, &mut j)?;
    Ok(j)
}
pub(crate) fn confirm(
    db: &Connection,
    env: &impl Environment,
    vault: &[u8],
    attempt: &[u8],
    digest: &[u8],
) -> Result<IncidentStatus> {
    let mut j = load(db, env)?;
    let t = target(&mut j, vault, attempt)?;
    if t.phase != PreparationPhase::EnvelopesStaged || digest != t.envelope_digest {
        return Err(Error::Conflict);
    }
    t.kit_ack = Some(digest.to_vec());
    t.phase = PreparationPhase::KitConfirmed;
    save(db, &mut j)?;
    Ok(j)
}
pub(crate) fn reset(
    db: &Connection,
    env: &impl Environment,
    vault: &[u8],
    attempt: &[u8],
    next: &[u8],
) -> Result<IncidentStatus> {
    id(next)?;
    if next == attempt {
        return Err(Error::Conflict);
    }
    let mut j = load(db, env)?;
    if cancellation_cleanup_pending(db, &j)?
        || j.targets
            .iter()
            .any(|t| t.phase == PreparationPhase::Cancelling)
    {
        return Err(Error::Busy);
    }
    j.cancel_digest = None;
    let t = target(&mut j, vault, attempt)?;
    // Reusing a target attempt requires bounded inactive cleanup; source pins stay intact.
    let inactive = 1 - t.source.published_slot.unwrap_or(1);
    if t.reset_attempt
        .as_deref()
        .is_some_and(|pending| pending != next)
    {
        return Err(Error::Conflict);
    }
    t.coverage = None;
    t.staged_export = None;
    t.backup_ack = None;
    t.reset_attempt = Some(next.to_vec());
    t.phase = PreparationPhase::Resetting;
    if !store::overlays::clear_inactive(db, &t.source, inactive)? {
        save(db, &mut j)?;
        return Ok(j);
    }
    t.reset_attempt = None;
    t.next_epoch = next_epoch(t.target.as_ref().map_or(t.next_epoch, |g| g.epoch))?;
    t.attempt = next.to_vec();
    t.target = None;
    t.phase = PreparationPhase::PendingNonce;
    t.normal = None;
    t.recovery = None;
    t.recovery_verifier.clear();
    t.envelope_digest.clear();
    t.kit_ack = None;
    save(db, &mut j)?;
    Ok(j)
}

/// Public authority summaries only, scoped by the authenticated adapter. Needed to bind exact
/// selected credential versions and namespace in a fresh pre-nonce ceremony.
pub fn context_in(db: &Connection) -> Result<Option<IncidentContext>> {
    let Some(n) = store::load::<cleanup::Namespace>(db, "cleanup")? else {
        return Ok(None);
    };
    Ok(Some(IncidentContext {
        namespace: n.identity,
        credentials: authorization::authorities(db)?
            .credentials
            .into_iter()
            .filter(|a| !a.revoked)
            .map(|a| IncidentCredential {
                credential: a.id,
                version: a.version,
                scope: a.scope,
            })
            .collect(),
    }))
}

fn discard(t: &mut IncidentTarget) {
    t.coverage = None;
    t.staged_export = None;
    t.backup_ack = None;
    t.target = None;
    t.normal = None;
    t.recovery = None;
    t.recovery_verifier.clear();
    t.envelope_digest.clear();
    t.kit_ack = None;
    t.reset_attempt = None;
}
/// Fence selected terminal targets before the first bounded deletion. The fixed audit
/// identities remain in the vector; only surviving sources authorize further preparation.
pub(crate) fn purge(db: &Connection, targets: &[Id], complete: bool) -> Result<()> {
    let Some(mut j) = store::incident::status(db)?.filter(|j| !j.complete) else {
        return Ok(());
    };
    for t in &mut j.targets {
        if targets.contains(&t.source.id) {
            discard(t);
            t.source.normal = None;
            t.source.recovery = None;
            t.source.recovery_verifier.clear();
            t.phase = if complete {
                PreparationPhase::Purged
            } else {
                PreparationPhase::Purging
            };
        }
    }
    j.complete = j
        .targets
        .iter()
        .all(|t| t.phase == PreparationPhase::Purged);
    save(db, &mut j)
}
/// An exact job/vector authorizes only discard. One batch clears at most one target's
/// bounded inactive overlay; all attempts are fenced atomically before any callback runs.
pub(crate) fn cancel(
    db: &Connection,
    env: &impl Environment,
    job: &[u8],
    digest: &[u8],
    generations: &[Generation],
) -> Result<bool> {
    let mut j = load(db, env)?;
    if j.job != job || sources(&j)? != generations {
        return Err(Error::Unauthorized);
    }
    if j.cancel_digest.as_deref() != Some(digest) {
        if cancellation_cleanup_pending(db, &j)? {
            return Err(Error::Busy);
        }
        if j.vector_digest != digest
            || j.targets
                .iter()
                .any(|t| t.phase == PreparationPhase::Cancelling)
        {
            return Err(Error::Unauthorized);
        }
        j.cancel_digest = Some(digest.to_vec());
        let mut control = control(db)?;
        if control.random.as_ref().is_some_and(|f| {
            j.targets.iter().any(|t| {
                !terminal(t) && f.vault == t.source.id && f.attempt.as_ref() == Some(&t.attempt)
            })
        }) {
            control.random = None;
            store::save(db, "control", &control)?;
        }
        for t in j.targets.iter_mut().filter(|t| !terminal(t)) {
            // A domain-separated successor fences pre-nonce grants too. Resume must still
            // explicitly supply another fresh attempt through paid IncidentReset.
            t.attempt = hash(&("incident-cancel/v1", &j.job, &t.attempt, digest))?[..16].to_vec();
            t.next_epoch = t.target.as_ref().map_or(t.next_epoch, |g| g.epoch);
            discard(t);
            t.phase = PreparationPhase::Cancelling;
        }
    }
    if let Some(t) = j
        .targets
        .iter_mut()
        .find(|t| t.phase == PreparationPhase::Cancelling)
    {
        if store::overlays::clear_inactive(db, &t.source, 1 - t.source.published_slot.unwrap_or(1))?
        {
            t.phase = PreparationPhase::Cancelled;
        }
    }
    let complete = !j
        .targets
        .iter()
        .any(|t| t.phase == PreparationPhase::Cancelling);
    save(db, &mut j)?;
    Ok(complete)
}

/// Cancelled targets can still owe financial settlement to an unfinished cleanup cursor.
/// Preserve that cursor's exact action binding until it completes; unrelated cleanup actions
/// do not acquire a new incident lock. No transient grant/expiry is used as durable authority.
fn cancellation_cleanup_pending(db: &Connection, j: &IncidentStatus) -> Result<bool> {
    let Some(vector_digest) = j.cancel_digest.as_ref() else {
        return Ok(false);
    };
    let n = cleanup::namespace(db)?;
    let Some(progress) = n.job.as_ref().filter(|p| !p.complete) else {
        return Ok(false);
    };
    let targets: Vec<Id> = j
        .targets
        .iter()
        .filter(|t| !terminal(t))
        .map(|t| t.source.id.clone())
        .collect();
    let action = CleanupAction::CancelIncident {
        incident: j.job.clone(),
        vector_digest: vector_digest.clone(),
    };
    Ok(n.action == hash(&(&progress.job, &action, &targets))?)
}
