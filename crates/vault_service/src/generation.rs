//! Durable, fenced new-namespace initialization. Existing namespaces require signed creation.
use super::*;
#[derive(Serialize, Deserialize, Clone)]
struct Setup {
    request: Bootstrap,
    token: u64,
    expires: u64,
    fence: Vec<u8>,
    challenge: Option<Challenge>,
}
pub async fn bootstrap(env: &impl Environment, request: Bootstrap) -> Result<BootstrapReply> {
    env.require_spending()?;
    if request.public_key.len() != 32 {
        return Err(Error::InvalidInput);
    }
    let prepared = env.transaction(|db| {
        store::authorize(db, env.owner())?;
        cleanup::reclaim_empty(db, env.now())?;
        if let Some(s) = store::load::<Setup>(db, "bootstrap")? {
            if hash(&s.request)? == hash(&request)?
                && s.fence == grants::fence(db)?
                && s.expires > env.now()
            {
                if let Some(challenge) = s.challenge {
                    return Ok(Err(BootstrapReply {
                        header: store::header(db, &request.reserve.vault)?,
                        challenge,
                    }));
                }
                return Err(Error::Busy);
            }
            return Err(Error::Conflict);
        }
        let count: i64 = db.query_row(
            "SELECT (SELECT count(*) FROM vaults WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1))+(SELECT count(*) FROM credentials WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1))",
            params![],
            |r| kinic_sqlite_compat::row_get(r, 0),
        ).map_err(|_| Error::Storage)?;
        if count != 0 || store::load::<cleanup::Namespace>(db, "cleanup")?.is_some() {
            return Err(Error::Unauthorized);
        }
        let mut c = control(db)?;
        c.serial = c.serial.checked_add(1)
            .filter(|x| *x <= i64::MAX as u64)
            .ok_or(Error::QuotaExceeded)?;
        let token = c.serial;
        store::save(db, "control", &c)?;
        // Prepay both fixed slots before external work. Cleanup authority waits for
        // an independent private seed; the retained owner budget survives recreation.
        cleanup::save(db, &cleanup::Namespace {
            identity: vec![], seed: None, serial: 0, pending: None, grant: None,
            job: None, action: vec![], deleted: vec![],
            budget: c.cleanup_budget.clone(), cancelled: None,
        })?;
        store::save(db, "authorities", &authorization::Authorities::default())?;
        grants::prepay(db)?;
        store::reserve(db, env.owner(), request.reserve.clone(), env.now())?;
        store::save(db, "bootstrap", &Setup {
            request: request.clone(), token, expires: env.now() + 120,
            fence: grants::fence(db)?, challenge: None,
        })?;
        Ok(Ok(token))
    })?;
    let token = match prepared {
        Ok(t) => t,
        Err(reply) => return Ok(reply),
    };
    env.reserve_challenge(token)?;
    env.checkpoint_execution()?;
    let seed = env.random().await;
    // Never proceed to another external call after cancellation/config/upgrade.
    if let Err(e) = env.transaction(|db| {
        check(db, env, token)?;
        Ok(())
    }) {
        env.settle_challenge(token)?;
        return Err(e);
    }
    env.checkpoint_execution()?;
    let nonce = env.random().await;
    env.settle_challenge(token)?;
    env.transaction(|db| {
        let mut setup = check(db, env, token)?;
        let seed = seed?;
        let nonce = nonce?;
        if seed.len() != 32 || nonce.len() != 32 || seed == nonce {
            return Err(Error::KeyService);
        }
        let mut h = store::pending(db, &request.reserve.vault, env.now())?;
        let g = Generation {
            version: 2,
            canister: env.canister(),
            owner: env.owner(),
            vault: h.id.clone(),
            epoch: 0,
            nonce,
            key_name: h.key_name.clone(),
        };
        g.bytes()?;
        h.generation = Some(g.clone());
        store::put_header(db, &h)?;
        let identity =
            Sha256::digest([b"kinic-vault/namespace/v1".as_slice(), &seed].concat()).to_vec();
        let mut n = cleanup::namespace(db)?;
        n.identity = identity;
        n.seed = Some(seed.clone());
        cleanup::save(db, &n)?;
        let bytes = cleanup::mac(
            &seed,
            b"kinic-vault/bootstrap/v2\0",
            &candid::encode_args((
                request.public_key.clone(),
                g,
                request.reserve.operation.clone(),
                setup.fence.clone(),
            ))
            .map_err(|_| Error::InvalidInput)?,
        )?;
        let challenge = Challenge {
            bytes,
            expires: env.now() + 120,
            registration: true,
            credential_ids: vec![],
        };
        setup.challenge = Some(challenge.clone());
        store::save(db, "bootstrap", &setup)?;
        Ok(BootstrapReply {
            header: h,
            challenge,
        })
    })
}
fn check(db: &Connection, env: &impl Environment, token: u64) -> Result<Setup> {
    let s: Setup = store::load(db, "bootstrap")?.ok_or(Error::Expired)?;
    if s.token != token || s.expires <= env.now() || s.fence != grants::fence(db)? {
        return Err(Error::Expired);
    }
    let h = store::pending(db, &s.request.reserve.vault, env.now())?;
    store::setup::check_attempt(db, &h, Some(&s.request.reserve.operation))?;
    Ok(s)
}
pub fn register(env: &impl Environment, attempt: Id, registration: String) -> Result<GrantInfo> {
    env.require_spending()?;
    env.transaction(|db| {
        let s: Setup = store::load(db, "bootstrap")?.ok_or(Error::Unauthorized)?;
        let s = check(db, env, s.token)?;
        if s.request.reserve.operation != attempt
            || !credentials(db)?.is_empty()
            || !store::list(db)?.is_empty()
        {
            return Err(Error::Unauthorized);
        }
        let h = store::pending(db, &s.request.reserve.vault, env.now())?;
        let ch = s.challenge.ok_or(Error::Busy)?;
        if ch.expires <= env.now() {
            return Err(Error::Expired);
        }
        let pending = cleanup::Pending {
            request: GrantRequest {
                operation: attempt,
                public_key: s.request.public_key,
                credential: vec![],
                purpose: GrantPurpose::Normal,
                generations: vec![h.generation.ok_or(Error::Conflict)?],
            },
            issued: ch.expires - 120,
            challenge: ch,
            fence: s.fence,
            version: 0,
        };
        let c = auth::registration(
            &store::config(db)?,
            &ceremonies::as_ceremony(&pending),
            &registration,
        )?;
        grants::admission(db, env.now())?;
        authorization::insert(db, &c, CredentialScope::Global)?;
        let mut pending = pending;
        pending.request.credential = c.id.0;
        let id = Sha256::digest(
            [
                b"kinic-vault/bootstrap-grant/v2".as_slice(),
                &pending.challenge.bytes,
            ]
            .concat(),
        )
        .to_vec();
        let version = authorization::authority(db, &pending.request.credential)?.version;
        let g = ceremonies::grant(env, pending, id, version);
        grants::save(db, &g)?;
        store::save(db, "bootstrap", &())?;
        Ok(g.info)
    })
}
