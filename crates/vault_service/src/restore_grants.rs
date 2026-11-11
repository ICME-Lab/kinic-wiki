//! Candidate-only capabilities; paid work and subsidized destructive cleanup remain distinct.
use super::*;
pub(crate) fn binding(j: &RestoreAdmissionStatus) -> Result<Vec<u8>> {
    hash(&(
        "restore-proof/v2",
        &j.request,
        &j.challenge.bytes,
        &j.candidate_digest,
        &j.current_live,
        &j.current_verifier,
    ))
}
pub(crate) fn is_restore(p: &GrantPurpose) -> bool {
    matches!(
        p,
        GrantPurpose::RestorePrepare { .. }
            | GrantPurpose::RestoreTarget { .. }
            | GrantPurpose::RestoreCleanup { .. }
    )
}
pub(crate) fn job(p: &GrantPurpose) -> Result<&Id> {
    match p {
        GrantPurpose::RestorePrepare { job, .. }
        | GrantPurpose::RestoreTarget { job, .. }
        | GrantPurpose::RestoreCleanup { job, .. } => Ok(job),
        _ => Err(Error::Unauthorized),
    }
}
pub(crate) fn validate(
    db: &Connection,
    env: &impl Environment,
    credential: &[u8],
    purpose: &GrantPurpose,
    generations: &[Generation],
) -> Result<RestoreAdmissionStatus> {
    let j = restore_admission::load(db, job(purpose)?)?;
    restore_admission::fresh(db, env, &j)?;
    if j.phase != RestoreAdmissionPhase::Admitted {
        return Err(Error::Unauthorized);
    }
    let c: passkey_auth::PasskeyCredential =
        serde_json::from_str(j.candidate.as_ref().ok_or(Error::Unauthorized)?)
            .map_err(|_| Error::Storage)?;
    if c.id.0 != credential || !generations.is_empty() {
        return Err(Error::Unauthorized);
    }
    if j.cancel_requested && !matches!(purpose, GrantPurpose::RestoreCleanup { .. }) {
        return Err(Error::Unauthorized);
    }
    match purpose {
        GrantPurpose::RestorePrepare { target, .. }
            if *target == j.request.target
                && j.pipeline
                    .as_ref()
                    .is_none_or(|p| p.phase == RestorePhase::Allocated) => {}
        GrantPurpose::RestoreTarget { generation, .. }
            if j.pipeline.as_ref().is_some_and(|p| {
                &p.target == generation
                    && !matches!(
                        p.phase,
                        RestorePhase::Cancelling | RestorePhase::Cancelled | RestorePhase::Active
                    )
            }) => {}
        GrantPurpose::RestoreCleanup { target, .. }
            if *target == j.request.target
                && j.pipeline
                    .as_ref()
                    .is_none_or(|p| p.phase != RestorePhase::Active) => {}
        _ => return Err(Error::Unauthorized),
    }
    Ok(j)
}
pub fn begin(env: &impl Environment, r: GrantRequest) -> Result<Challenge> {
    let free = matches!(r.purpose, GrantPurpose::RestoreCleanup { .. });
    if !free {
        env.require_spending()?;
    }
    id(&r.operation)?;
    if r.public_key.len() != 32 || r.credential.is_empty() || r.credential.len() > 1024 {
        return Err(Error::InvalidInput);
    }
    ed25519_dalek::VerifyingKey::from_bytes(
        r.public_key
            .as_slice()
            .try_into()
            .map_err(|_| Error::InvalidInput)?,
    )
    .map_err(|_| Error::InvalidInput)?;
    env.transaction(|db| {
        validate(db, env, &r.credential, &r.purpose, &r.generations)?;
        let mut n = cleanup::namespace(db)?;
        let pending = if free {
            n.pending.clone()
        } else {
            store::load(db, "grant-ceremony")?
        };
        if let Some(p) = pending.filter(|p: &cleanup::Pending| {
            p.challenge.expires > env.now() && p.fence == grants::fence(db).unwrap_or_default()
        }) {
            return if p.request == r {
                Ok(p.challenge)
            } else {
                Err(Error::Busy)
            };
        }
        if n.job.as_ref().is_some_and(|p| !p.complete) {
            return Err(Error::Busy);
        }
        if !free {
            grants::admission(db, env.now())?;
        }
        cleanup::budget(db, env.now(), 0)?;
        n.budget = cleanup::namespace(db)?.budget;
        n.serial = n
            .serial
            .checked_add(1)
            .filter(|x| *x <= i64::MAX as u64)
            .ok_or(Error::QuotaExceeded)?;
        let fence = grants::fence(db)?;
        let expires = env.now().checked_add(120).ok_or(Error::QuotaExceeded)?;
        let j = restore_admission::load(db, job(&r.purpose)?)?;
        let transcript = candid::encode_args((
            env.owner(),
            env.canister(),
            r.clone(),
            j.request,
            j.current_live,
            j.current_verifier,
            j.candidate_digest,
            n.serial,
            expires,
            fence.clone(),
        ))
        .map_err(|_| Error::InvalidInput)?;
        let ch = Challenge {
            bytes: cleanup::mac(
                n.seed.as_ref().ok_or(Error::Unauthorized)?,
                b"kinic-vault/restore-capability/v2\0",
                &transcript,
            )?,
            expires,
            registration: false,
            credential_ids: vec![r.credential.clone()],
        };
        let p = cleanup::Pending {
            request: r,
            challenge: ch.clone(),
            fence,
            issued: env.now(),
            version: n.serial,
        };
        if free {
            n.pending = Some(p);
        } else {
            store::save(db, "grant-ceremony", &p)?;
        }
        cleanup::save(db, &n)?;
        Ok(ch)
    })
}
pub fn finish(
    env: &impl Environment,
    operation: Id,
    proof: String,
    cleanup_only: bool,
) -> Result<GrantInfo> {
    if !cleanup_only {
        env.require_spending()?;
    }
    if proof.len() > 65536 {
        return Err(Error::InvalidInput);
    }
    env.transaction(|db| cleanup::budget(db, env.now(), 1))?;
    env.transaction(|db| {
        let mut n = cleanup::namespace(db)?;
        let p: cleanup::Pending = if cleanup_only {
            n.pending.clone()
        } else {
            store::load(db, "grant-ceremony")?
        }
        .ok_or(Error::Unauthorized)?;
        if p.request.operation != operation
            || p.challenge.expires <= env.now()
            || p.fence != grants::fence(db)?
            || matches!(p.request.purpose, GrantPurpose::RestoreCleanup { .. }) != cleanup_only
        {
            return Err(Error::Expired);
        }
        let mut j = validate(
            db,
            env,
            &p.request.credential,
            &p.request.purpose,
            &p.request.generations,
        )?;
        let c = serde_json::from_str(j.candidate.as_ref().ok_or(Error::Unauthorized)?)
            .map_err(|_| Error::Storage)?;
        let c = auth::assertion(
            &store::config(db)?,
            &ceremonies::as_ceremony(&p),
            vec![c],
            &proof,
        )?;
        j.candidate = Some(serde_json::to_string(&c).map_err(|_| Error::Storage)?);
        let binding = binding(&j)?;
        restore_admission::save(db, j)?;
        let id = cleanup::mac(
            n.seed.as_ref().ok_or(Error::Unauthorized)?,
            b"kinic-vault/restore-grant/v2\0",
            &p.challenge.bytes,
        )?;
        let version = p.version;
        let mut g = ceremonies::grant(env, p, id, version);
        g.restore_binding = Some(binding);
        let info = g.info.clone();
        if cleanup_only {
            n.grant = Some(g);
            n.pending = None;
        } else {
            grants::admission(db, env.now())?;
            grants::save(db, &g)?;
            store::save(db, "grant-ceremony", &())?;
        }
        cleanup::save(db, &n)?;
        Ok(info)
    })
}
