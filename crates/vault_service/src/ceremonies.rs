//! Fresh WebAuthn issuance; candidate possession never grants existing-namespace authority.
use super::*;
use cleanup::Pending;
pub(crate) fn validate_request(
    db: &Connection,
    env: &impl Environment,
    r: &GrantRequest,
) -> Result<()> {
    id(&r.operation)?;
    if r.public_key.len() != 32
        || r.credential.is_empty()
        || r.credential.len() > 1024
        || r.generations.len() > 3
    {
        return Err(Error::InvalidInput);
    }
    ed25519_dalek::VerifyingKey::from_bytes(
        r.public_key
            .as_slice()
            .try_into()
            .map_err(|_| Error::InvalidInput)?,
    )
    .map_err(|_| Error::InvalidInput)?;
    let a = authorization::authority(db, &r.credential)?;
    if a.revoked {
        return Err(Error::Unauthorized);
    }
    if matches!(
        r.purpose,
        GrantPurpose::Incident { .. }
            | GrantPurpose::IncidentPrepare(_)
            | GrantPurpose::IncidentCutover { .. }
    ) {
        return incident::validate(db, env, &r.credential, &r.purpose, &r.generations);
    }
    if matches!(r.purpose, GrantPurpose::Create | GrantPurpose::Credentials) {
        store::incident::owner_change_allowed(db)?;
    }
    if let GrantPurpose::CancelCreation { target, .. } = &r.purpose {
        if a.scope != CredentialScope::Global || !r.generations.is_empty() {
            return Err(Error::Unauthorized);
        }
        return cleanup::pending_creation(db, target, None);
    }
    if matches!(r.purpose, GrantPurpose::Create | GrantPurpose::Credentials)
        && a.scope != CredentialScope::Global
    {
        return Err(Error::Unauthorized);
    }
    if matches!(r.purpose, GrantPurpose::Restore { .. }) {
        return Err(Error::Conflict);
    } // Task7 transition authorization.
    if r.generations.is_empty()
        && !matches!(r.purpose, GrantPurpose::Create | GrantPurpose::Credentials)
    {
        return Err(Error::InvalidInput);
    }
    for (i, g) in r.generations.iter().enumerate() {
        g.bytes()?;
        if g.owner != env.owner()
            || g.canister != env.canister()
            || !authorization::covers(&a.scope, g)
            || r.generations[..i].iter().any(|x| x.vault == g.vault)
        {
            return Err(Error::Unauthorized);
        }
        let h = store::header(db, &g.vault)?;
        if h.generation.as_ref() != Some(g) {
            return Err(Error::Unauthorized);
        }
        if matches!(r.purpose, GrantPurpose::Normal) {
            cleanup::normal_allowed(db, &h)?;
            if h.state != VaultState::Active && h.state != VaultState::Pending {
                return Err(Error::Conflict);
            }
        }
    }
    Ok(())
}
pub(crate) fn as_ceremony(p: &Pending) -> Ceremony {
    Ceremony {
        request: BeginUnlock {
            vault: p
                .request
                .generations
                .first()
                .map(|g| g.vault.clone())
                .unwrap_or(vec![0; 16]),
            attempt: None,
            epoch: p.request.generations.first().map_or(0, |g| g.epoch),
            purpose: Purpose::Unlock,
            transport: vec![0; 48],
            target: vec![],
        },
        challenge: p.challenge.clone(),
        created: p.issued,
        configuration: p.fence.clone(),
    }
}
pub(crate) fn grant(env: &impl Environment, p: Pending, id: Id, version: u64) -> grants::Grant {
    grants::Grant {
        info: GrantInfo {
            id,
            expires: p.issued + grants::GRANT_TTL,
            next_counter: 0,
            purpose: p.request.purpose,
            generations: p.request.generations,
        },
        owner: env.owner(),
        canister: env.canister(),
        public_key: p.request.public_key,
        credential: p.request.credential,
        credential_version: version,
        fence: p.fence,
        revoked: false,
        last_digest: vec![],
        last_result: None,
        work: None,
    }
}
#[derive(Serialize, Deserialize)]
struct Flight {
    request: GrantRequest,
    token: u64,
    expires: u64,
    fence: Vec<u8>,
}
pub async fn begin(env: &impl Environment, r: GrantRequest) -> Result<Challenge> {
    env.require_spending()?;
    let token = env.transaction(|db| {
        validate_request(db, env, &r)?;
        grants::admission(db, env.now())?;
        if let Some(p) = store::load::<Pending>(db, "grant-ceremony")? {
            if p.challenge.expires > env.now() {
                return if p.request == r {
                    Ok(Err(p.challenge))
                } else {
                    Err(Error::Busy)
                };
            }
        }
        if store::load::<Flight>(db, "grant-random")?.is_some_and(|f| f.expires > env.now()) {
            return Err(Error::Busy);
        }
        let mut c = control(db)?;
        if c.day != env.now() / DAY {
            c.day = env.now() / DAY;
            c.challenges = 0;
            c.derives = 0;
        }
        if c.challenges >= 100 {
            return Err(Error::QuotaExceeded);
        }
        c.challenges += 1;
        c.serial = c
            .serial
            .checked_add(1)
            .filter(|x| *x <= i64::MAX as u64)
            .ok_or(Error::QuotaExceeded)?;
        let f = Flight {
            request: r.clone(),
            token: c.serial,
            expires: env.now() + 120,
            fence: grants::fence(db)?,
        };
        store::save(db, "control", &c)?;
        store::save(db, "grant-random", &f)?;
        Ok(Ok(c.serial))
    })?;
    let token = match token {
        Ok(t) => t,
        Err(ch) => return Ok(ch),
    };
    env.reserve_challenge(token)?;
    env.checkpoint_execution()?;
    let random = env.random().await;
    env.settle_challenge(token)?;
    env.transaction(|db| {
        let f = store::load::<Flight>(db, "grant-random")?.ok_or(Error::Expired)?;
        if f.token != token || f.expires <= env.now() || f.fence != grants::fence(db)? {
            return Err(Error::Expired);
        }
        validate_request(db, env, &r)?;
        let random = random?;
        if random.len() != 32 {
            return Err(Error::KeyService);
        }
        let version = authorization::authority(db, &r.credential)?.version;
        let bytes = Sha256::digest(
            [
                b"kinic-vault/grant-challenge/v2".as_slice(),
                &random,
                &candid::encode_args((
                    env.canister(),
                    env.owner(),
                    r.clone(),
                    version,
                    env.now() + 120,
                    f.fence.clone(),
                ))
                .map_err(|_| Error::InvalidInput)?,
            ]
            .concat(),
        )
        .to_vec();
        let challenge = Challenge {
            bytes,
            expires: env.now() + 120,
            registration: false,
            credential_ids: vec![r.credential.clone()],
        };
        store::save(
            db,
            "grant-ceremony",
            &Pending {
                request: r,
                challenge: challenge.clone(),
                fence: f.fence,
                issued: env.now(),
                version,
            },
        )?;
        store::save(db, "grant-random", &())?;
        Ok(challenge)
    })
}
pub fn finish(env: &impl Environment, operation: Id, proof: String) -> Result<GrantInfo> {
    env.require_spending()?;
    if proof.len() > 65536 {
        return Err(Error::InvalidInput);
    }
    env.transaction(|db| {
        let p: Pending = store::load(db, "grant-ceremony")?.ok_or(Error::InvalidProof)?;
        if p.request.operation != operation
            || p.challenge.expires <= env.now()
            || p.fence != grants::fence(db)?
        {
            return Err(Error::Expired);
        }
        validate_request(db, env, &p.request)?;
        grants::admission(db, env.now())?;
        let a = authorization::authority(db, &p.request.credential)?;
        if a.version != p.version {
            return Err(Error::Unauthorized);
        }
        authorization::assertion(db, &as_ceremony(&p), &p.request.credential, &proof)?;
        let id =
            Sha256::digest([b"kinic-vault/grant-id/v2".as_slice(), &p.challenge.bytes].concat())
                .to_vec();
        let g = grant(env, p, id, a.version);
        grants::save(db, &g)?;
        store::save(db, "grant-ceremony", &())?;
        Ok(g.info)
    })
}
