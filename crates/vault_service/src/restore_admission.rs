//! Restore-only admission. Existing scopes stay unchanged until verified activation.
use super::*;
pub fn status(env: &impl Environment) -> Result<Option<RestoreAdmissionStatus>> {
    env.transaction(|db| Ok(store::transition::load_state(db)?.restore))
}
pub(crate) fn physical(db: &Connection) -> Result<u64> {
    let n:i64=db.query_row("SELECT count(*) FROM credentials WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1)",params![],|r|kinic_sqlite_compat::row_get(r,0)).map_err(|_|Error::Storage)?;
    Ok(n as u64)
}
fn check_request(
    db: &Connection,
    env: &impl Environment,
    r: &RestoreAdmissionRequest,
) -> Result<(Option<Header>, Option<Id>, u64)> {
    for x in [&r.job, &r.target.vault, &r.target.attempt] {
        id(x)?;
    }
    let n = cleanup::namespace(db)?;
    if r.target.namespace != n.identity
        || n.identity.len() != 32
        || n.seed.is_none()
        || r.archive_digest.len() != 32
        || r.source_commitment.len() != 32
        || r.archive_length == 0
        || r.archive_length > 300 * 1024 * 1024
        || r.records > 10000
        || r.reserved_bytes > TOTAL_MAX
    {
        return Err(Error::InvalidInput);
    }
    if let Some(g) = &r.source_generation {
        g.bytes()?;
        if g.vault != r.target.vault || g.epoch != r.source_epoch {
            return Err(Error::InvalidInput);
        }
    }
    if n.job.as_ref().is_some_and(|j| !j.complete) {
        return Err(Error::Busy);
    }
    let unfinished: i64 = db.query_row(
        "SELECT count(*) FROM vaults WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND json_extract(header,'$.state') IN ('Pending','Restoring','Purging')",
        params![], |r| kinic_sqlite_compat::row_get(r,0)).map_err(|_|Error::Storage)?;
    if unfinished != 0 {
        return Err(Error::Busy);
    }
    let h = match store::header(db, &r.target.vault) {
        Ok(h) => Some(h),
        Err(Error::NotFound) => None,
        Err(e) => return Err(e),
    };
    if let Some(h) = &h {
        if !matches!(h.state, VaultState::Active | VaultState::IncidentRequired) {
            return Err(Error::Conflict);
        }
        let g = h.generation.as_ref().ok_or(Error::Unauthorized)?;
        g.bytes()?;
        if g.owner != env.owner() || g.canister != env.canister() || h.recovery_verifier.len() != 32
        {
            return Err(Error::Unauthorized);
        }
        ed25519_dalek::VerifyingKey::from_bytes(
            h.recovery_verifier
                .as_slice()
                .try_into()
                .map_err(|_| Error::InvalidInput)?,
        )
        .map_err(|_| Error::InvalidInput)?;
    }
    let epoch = next_epoch(r.source_epoch.max(h.as_ref().map_or(0, |h| h.epoch)))?;
    let s = store::transition::load_state(db)?;
    if s.namespace_flight.as_ref().is_some_and(|f| !f.ready) {
        return Err(Error::Busy);
    }
    let parent = if let Some(p) = s.incident.filter(|p| !p.complete) {
        let h = h.as_ref().ok_or(Error::Busy)?;
        if h.state != VaultState::IncidentRequired
            || !p.targets.iter().any(|t| {
                t.source.generation == h.generation
                    && !matches!(
                        t.phase,
                        PreparationPhase::Purging
                            | PreparationPhase::Purged
                            | PreparationPhase::Cancelling
                    )
            })
        {
            return Err(Error::Busy);
        }
        Some(p.job)
    } else {
        if h.as_ref()
            .is_some_and(|h| h.state == VaultState::IncidentRequired)
        {
            return Err(Error::Conflict);
        }
        None
    };
    let count: i64 = db
        .query_row(
            "SELECT count(*) FROM vaults WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1)",
            params![],
            |r| kinic_sqlite_compat::row_get(r, 0),
        )
        .map_err(|_| Error::Storage)?;
    if h.is_none() && count >= 3 {
        return Err(Error::QuotaExceeded);
    }
    Ok((h, parent, epoch))
}
pub(crate) fn current(
    db: &Connection,
    env: &impl Environment,
    j: &RestoreAdmissionStatus,
) -> Result<()> {
    if j.semantic_config != incident::semantic(db, env)? {
        return Err(Error::Conflict);
    }
    restore_candidate::current(db, j)?;
    if let Some(p) = &j.pipeline {
        return restore_pipeline::current(db, env, j, p);
    }
    let (h, parent, epoch) = check_request(db, env, &j.request)?;
    if h.as_ref().and_then(|h| h.generation.clone()) != j.current_live
        || h.as_ref().map_or(vec![], |h| h.recovery_verifier.clone()) != j.current_verifier
        || parent != j.parent_job
        || epoch != j.next_epoch
    {
        return Err(Error::Unauthorized);
    }
    Ok(())
}
pub(crate) fn fresh(
    db: &Connection,
    env: &impl Environment,
    j: &RestoreAdmissionStatus,
) -> Result<()> {
    current(db, env, j)?;
    if j.proof_fence != grants::fence(db)? || j.challenge.expires <= env.now() {
        return Err(Error::Expired);
    }
    Ok(())
}
pub(crate) fn load(db: &Connection, job: &[u8]) -> Result<RestoreAdmissionStatus> {
    store::transition::load_state(db)?
        .restore
        .filter(|j| j.request.job == job)
        .ok_or(Error::Unauthorized)
}
pub(crate) fn save(db: &Connection, j: RestoreAdmissionStatus) -> Result<()> {
    let mut s = store::transition::load_state(db)?;
    s.restore = Some(j);
    store::transition::save_state(db, &s)
}
fn challenge(
    db: &Connection,
    env: &impl Environment,
    j: &mut RestoreAdmissionStatus,
    registration: bool,
) -> Result<Challenge> {
    let mut n = cleanup::namespace(db)?;
    n.serial = n
        .serial
        .checked_add(1)
        .filter(|x| *x <= i64::MAX as u64)
        .ok_or(Error::QuotaExceeded)?;
    j.issued = env.now();
    j.proof_fence = grants::fence(db)?;
    let expires = env.now().checked_add(120).ok_or(Error::QuotaExceeded)?;
    let transcript = candid::encode_args((
        env.owner(),
        env.canister(),
        j.request.clone(),
        j.current_live.clone(),
        j.current_verifier.clone(),
        j.parent_job.clone(),
        j.candidate_digest.clone(),
        j.existing_candidate.clone(),
        n.serial,
        expires,
        j.proof_fence.clone(),
        registration,
    ))
    .map_err(|_| Error::InvalidInput)?;
    let bytes = cleanup::mac(
        n.seed.as_ref().ok_or(Error::Unauthorized)?,
        b"kinic-vault/restore-admission/v2\0",
        &transcript,
    )?;
    let ids = if let Some(c) = &j.candidate {
        vec![
            serde_json::from_str::<passkey_auth::PasskeyCredential>(c)
                .map_err(|_| Error::Storage)?
                .id
                .0,
        ]
    } else {
        vec![]
    };
    j.challenge = Challenge {
        bytes,
        expires,
        registration,
        credential_ids: ids,
    };
    cleanup::save(db, &n)?;
    Ok(j.challenge.clone())
}
fn ceremony(j: &RestoreAdmissionStatus) -> Ceremony {
    Ceremony {
        request: BeginUnlock {
            vault: j.request.target.vault.clone(),
            attempt: Some(j.request.target.attempt.clone()),
            epoch: j.next_epoch,
            purpose: Purpose::Unlock,
            transport: vec![0; 48],
            target: vec![],
        },
        challenge: j.challenge.clone(),
        created: j.issued,
        configuration: j.proof_fence.clone(),
    }
}
/// Idempotent exact admission; fresh proof on expiry uses resume, never changes candidate/job.
pub fn begin(env: &impl Environment, r: RestoreAdmissionRequest) -> Result<Challenge> {
    env.require_spending()?;
    env.transaction(|db| {
        store::authorize(db, env.owner())?;
        let mut s = store::transition::load_state(db)?;
        if s.restore
            .as_ref()
            .is_some_and(|j| !store::transition::restore_unfinished(j))
        {
            if s.restore.as_ref().is_some_and(|j| {
                j.request.job == r.job || j.request.target.attempt == r.target.attempt
            }) {
                return Err(Error::Conflict);
            }
            s.restore = None;
        }
        if let Some(j) = &s.restore {
            if j.request != r {
                return Err(Error::Busy);
            }
            fresh(db, env, j)?;
            return if matches!(
                j.phase,
                RestoreAdmissionPhase::Registration | RestoreAdmissionPhase::Possession
            ) {
                Ok(j.challenge.clone())
            } else {
                Err(Error::Conflict)
            };
        }
        if !matches!(
            r.candidate_mode,
            Some(RestoreCandidateMode::ExistingInstances(_))
        ) && physical(db)? >= 10
        {
            return Err(Error::QuotaExceeded);
        }
        let (h, parent, epoch) = check_request(db, env, &r)?;
        // Reserve worst-case bounded proof/candidate metadata in the same slot BEFORE admission.
        if serde_json::to_vec(&s).map_err(|_| Error::Storage)?.len() > 32768 {
            return Err(Error::QuotaExceeded);
        }
        cleanup::budget(db, env.now(), 0)?;
        let mut j = RestoreAdmissionStatus {
            request: r,
            current_live: h.as_ref().and_then(|h| h.generation.clone()),
            current_verifier: h.map_or(vec![], |h| h.recovery_verifier),
            parent_job: parent,
            next_epoch: epoch,
            phase: RestoreAdmissionPhase::Registration,
            candidate: None,
            candidate_digest: vec![],
            existing_candidate: None,
            challenge: Challenge {
                bytes: vec![],
                expires: 0,
                registration: true,
                credential_ids: vec![],
            },
            recovery_message: vec![],
            semantic_config: incident::semantic(db, env)?,
            proof_fence: vec![],
            issued: env.now(),
            pipeline: None,
            allocation_token: None,
            cancel_requested: false,
            cancel_complete: false,
        };
        if let Some(RestoreCandidateMode::ExistingInstances(id)) = &j.request.candidate_mode {
            let (raw, digest, bound) = restore_candidate::capture(db, id)?;
            j.candidate = Some(raw);
            j.candidate_digest = digest;
            j.existing_candidate = Some(bound);
            j.phase = RestoreAdmissionPhase::Possession;
        }
        restore_candidate::current(db, &j)?;
        let registration = j.candidate.is_none();
        let ch = challenge(db, env, &mut j, registration)?;
        // A restore request and current identity are small; reserve >=16 KiB for later proofs.
        s.namespace_flight = None;
        s.restore = Some(j);
        if serde_json::to_vec(&s).map_err(|_| Error::Storage)?.len() > 49152 {
            return Err(Error::QuotaExceeded);
        }
        store::transition::save_state(db, &s)?;
        Ok(ch)
    })
}
fn proof_budget(env: &impl Environment, job: &[u8], length: usize) -> Result<()> {
    if length > 65536 {
        return Err(Error::InvalidInput);
    }
    env.transaction(|db| {
        let j = load(db, job)?;
        fresh(db, env, &j)?;
        cleanup::budget(db, env.now(), 1)
    })
}
pub fn register(env: &impl Environment, job: Id, proof: String) -> Result<Challenge> {
    env.require_spending()?;
    proof_budget(env, &job, proof.len())?;
    env.transaction(|db| {
        let mut j = load(db, &job)?;
        fresh(db, env, &j)?;
        if j.phase != RestoreAdmissionPhase::Registration {
            return Err(Error::Conflict);
        }
        let c = auth::registration(&store::config(db)?, &ceremony(&j), &proof)?;
        if credentials(db)?.iter().any(|x| x.id == c.id) {
            return Err(Error::Conflict);
        }
        let raw = serde_json::to_string(&c).map_err(|_| Error::Storage)?;
        if raw.len() > 8192 {
            return Err(Error::QuotaExceeded);
        }
        j.candidate_digest = hash(&(c.id.0.clone(), c.public_key_cose.0.clone()))?;
        j.candidate = Some(raw);
        j.phase = RestoreAdmissionPhase::Possession;
        let ch = challenge(db, env, &mut j, false)?;
        save(db, j)?;
        Ok(ch)
    })
}
pub fn possess(env: &impl Environment, job: Id, proof: String) -> Result<RestoreAdmissionStatus> {
    proof_budget(env, &job, proof.len())?;
    env.transaction(|db| {
        let mut j = load(db, &job)?;
        fresh(db, env, &j)?;
        if j.phase != RestoreAdmissionPhase::Possession {
            return Err(Error::Conflict);
        }
        let ceremony = ceremony(&j);
        restore_candidate::assert(db, &mut j, &ceremony, &proof)?;
        j.phase = if j.current_live.is_some() {
            RestoreAdmissionPhase::CurrentProof
        } else {
            RestoreAdmissionPhase::Admitted
        };
        // Candidate possession challenge already binds full pending identity and key. Recovery
        // signs distinct exact bytes, including current verifier and fresh challenge/fence.
        j.recovery_message = [
            b"kinic-vault/recovery-proof/v2\0".as_slice(),
            &candid::encode_args((
                "restore-admission",
                env.owner(),
                env.canister(),
                j.request.clone(),
                j.current_live.clone(),
                j.current_verifier.clone(),
                j.parent_job.clone(),
                j.candidate_digest.clone(),
                j.existing_candidate.clone(),
                j.challenge.bytes.clone(),
                j.challenge.expires,
                j.proof_fence.clone(),
            ))
            .map_err(|_| Error::InvalidInput)?,
        ]
        .concat();
        save(db, j.clone())?;
        Ok(j)
    })
}
pub fn prove_current(
    env: &impl Environment,
    job: Id,
    signature: Vec<u8>,
) -> Result<RestoreAdmissionStatus> {
    proof_budget(env, &job, signature.len())?;
    env.transaction(|db| {
        let mut j = load(db, &job)?;
        fresh(db, env, &j)?;
        if j.current_live.is_none()
            || !matches!(
                j.phase,
                RestoreAdmissionPhase::CurrentProof | RestoreAdmissionPhase::Admitted
            )
        {
            return Err(Error::Unauthorized);
        }
        grants::verify(&j.current_verifier, &j.recovery_message, &signature)?;
        j.phase = RestoreAdmissionPhase::Admitted;
        save(db, j.clone())?;
        Ok(j)
    })
}
pub fn resume(env: &impl Environment, job: Id) -> Result<Challenge> {
    env.transaction(|db| {
        let mut j = load(db, &job)?;
        current(db, env, &j)?;
        cleanup::budget(db, env.now(), 0)?;
        j.phase = if j.candidate.is_some() {
            RestoreAdmissionPhase::Possession
        } else {
            RestoreAdmissionPhase::Registration
        };
        j.recovery_message.clear();
        let registering = j.candidate.is_none();
        let ch = challenge(db, env, &mut j, registering)?;
        save(db, j)?;
        Ok(ch)
    })
}

/// The only external call in admission is a private namespace seed, never a target nonce.
pub async fn initialize_namespace(env: &impl Environment, operation: Id) -> Result<Vec<u8>> {
    id(&operation)?;
    env.require_spending()?;
    let preparation=env.transaction(|db|{
        store::authorize(db,env.owner())?;
        let mut s=store::transition::load_state(db)?;
        if s.restore.is_some()||s.incident.is_some(){return Err(Error::Busy);}
        if let Some(n)=store::load::<cleanup::Namespace>(db,"cleanup")? {
            if n.seed.is_some(){return Ok(Err(n.identity));}
            if !s.namespace_flight.as_ref().is_some_and(|f|f.operation==operation){return Err(Error::Conflict);}
        }else{
            let count:i64=db.query_row("SELECT (SELECT count(*) FROM vaults WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1))+(SELECT count(*) FROM credentials WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1))",params![],|r|kinic_sqlite_compat::row_get(r,0)).map_err(|_|Error::Storage)?;
            if count!=0{return Err(Error::Unauthorized);}
            cleanup::save(db,&cleanup::Namespace{identity:vec![],seed:None,serial:0,pending:None,grant:None,job:None,action:vec![],deleted:vec![],budget:control(db)?.cleanup_budget,cancelled:None})?;
            store::save(db,"authorities",&authorization::Authorities::default())?;
            grants::prepay(db)?;
        }
        let fence=grants::fence(db)?;
        if s.namespace_flight.as_ref().is_some_and(|f|f.fence==fence&&f.expires>env.now()){return Err(Error::Busy);}
        let mut c=control(db)?;
        if c.day!=env.now()/DAY{c.day=env.now()/DAY;c.challenges=0;c.derives=0;}
        if c.challenges>=100{return Err(Error::QuotaExceeded);}
        c.challenges+=1;c.serial=c.serial.checked_add(1).filter(|n|*n<=i64::MAX as u64).ok_or(Error::QuotaExceeded)?;
        s.namespace_flight=Some(RestoreNamespaceFlight{operation:operation.clone(),token:c.serial,expires:env.now()+120,fence,ready:false});
        store::transition::save_state(db,&s)?;store::save(db,"control",&c)?;Ok(Ok(c.serial))
    })?;
    let token = match preparation {
        Ok(t) => t,
        Err(id) => return Ok(id),
    };
    env.reserve_challenge(token)?;
    let random = async {
        env.checkpoint_execution()?;
        env.random().await
    }
    .await;
    env.settle_challenge(token)?;
    env.transaction(|db| {
        let mut s = store::transition::load_state(db)?;
        let f = s
            .namespace_flight
            .as_mut()
            .filter(|f| f.token == token && f.operation == operation && !f.ready)
            .ok_or(Error::Expired)?;
        if f.expires <= env.now() || f.fence != grants::fence(db)? {
            return Err(Error::Expired);
        }
        let seed = random?;
        if seed.len() != 32 {
            return Err(Error::KeyService);
        }
        let mut n = cleanup::namespace(db)?;
        if n.seed.is_some() {
            return Err(Error::Conflict);
        }
        n.identity =
            Sha256::digest([b"kinic-vault/namespace/v1".as_slice(), &seed].concat()).to_vec();
        n.seed = Some(seed);
        f.ready = true;
        cleanup::save(db, &n)?;
        store::transition::save_state(db, &s)?;
        Ok(n.identity)
    })
}
