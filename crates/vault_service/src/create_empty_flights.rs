//! Paid allocation uses the existing bounded financial token and target-role derive machinery.
use super::*;
pub(crate) async fn derive(env: &impl Environment, r: IncidentDerive) -> Result<KeyReply> {
    restore_flights::derive_empty(env, r).await
}
pub(crate) async fn allocate(env: &impl Environment, job: Id) -> Result<()> {
    env.require_spending()?;
    let token = env.transaction(|db| {
        let mut j = create_empty::load(db, &job)?;
        create_empty::current(db, env, &j)?;
        if j.phase != CreateEmptyPhase::Admitted {
            return Err(Error::Conflict);
        }
        if j.allocation_token
            .map(|t| env.challenge_pending(db, t))
            .transpose()?
            .unwrap_or(false)
        {
            return Err(Error::Busy);
        }
        let mut c = control(db)?;
        if c.random.as_ref().is_some_and(|f| f.expires > env.now()) {
            return Err(Error::Busy);
        }
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
            .filter(|n| *n <= i64::MAX as u64)
            .ok_or(Error::QuotaExceeded)?;
        // Charge the actual target header before randomness. No unreserved growth in overcommit.
        let h = store::reserve_empty(db, env.owner(), &job, env.now())?;
        c.random = Some(Flight {
            token: c.serial,
            vault: j.target.vault.clone(),
            epoch: 0,
            state: VaultState::Pending,
            attempt: Some(j.target.attempt.clone()),
            expires: env.now() + 120,
            key_name: h.key_name,
            configuration: grants::fence(db)?,
        });
        j.allocation_token = Some(c.serial);
        create_empty::save(db, j)?;
        store::save(db, "control", &c)?;
        Ok(c.serial)
    })?;
    env.reserve_challenge(token)?;
    let nonce = async {
        env.checkpoint_execution()?;
        env.random().await
    }
    .await;
    env.settle_challenge(token)?;
    env.transaction(|db| {
        let mut j = create_empty::load(db, &job)?;
        create_empty::current(db, env, &j)?;
        let mut c = control(db)?;
        let f = c
            .random
            .as_ref()
            .filter(|f| {
                f.token == token
                    && f.vault == j.target.vault
                    && f.attempt.as_ref() == Some(&j.target.attempt)
            })
            .ok_or(Error::Expired)?;
        if f.configuration != grants::fence(db)?
            || f.expires <= env.now()
            || j.phase != CreateEmptyPhase::Admitted
        {
            return Err(Error::Expired);
        }
        let nonce = nonce?;
        if nonce.len() != 32 || nonce == j.authorizer_instance.nonce {
            return Err(Error::KeyService);
        }
        let generation = Generation {
            version: 2,
            canister: env.canister(),
            owner: env.owner(),
            vault: j.target.vault.clone(),
            epoch: 0,
            nonce,
            key_name: f.key_name.clone(),
        };
        generation.bytes()?;
        let mut h = create_empty::target(db, &j)?.ok_or(Error::Unauthorized)?;
        h.generation = Some(generation.clone());
        store::put_header(db, &h)?;
        j.generation = Some(generation);
        j.phase = CreateEmptyPhase::Allocated;
        create_empty::save(db, j)?;
        c.random = None;
        store::save(db, "control", &c)
    })
}
