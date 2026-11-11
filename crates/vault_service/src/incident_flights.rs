//! Private job-authorized random/derive operations. Raw owner bookkeeping never publishes keys.
use super::*;
pub(crate) async fn allocate(
    env: &impl Environment,
    vault: Id,
    attempt: Id,
) -> Result<IncidentStatus> {
    env.require_spending()?;
    let token = env.transaction(|db| {
        let mut j = incident::load(db, env)?;
        let t = incident::target(&mut j, &vault, &attempt)?;
        if t.target.is_some() || t.phase != PreparationPhase::PendingNonce {
            return Err(Error::Conflict);
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
        c.random = Some(Flight {
            token: c.serial,
            vault: vault.clone(),
            epoch: t.next_epoch,
            state: VaultState::IncidentRequired,
            attempt: Some(attempt.clone()),
            expires: env.now() + 120,
            key_name: store::config(db)?.key_name,
            configuration: grants::fence(db)?,
        });
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
        let mut c = control(db)?;
        let f = c
            .random
            .as_ref()
            .filter(|f| f.token == token)
            .ok_or(Error::Expired)?;
        if f.configuration != grants::fence(db)? || f.expires <= env.now() {
            return Err(Error::Expired);
        }
        let mut j = incident::load(db, env)?;
        let t = incident::target(&mut j, &vault, &attempt)?;
        if t.target.is_some()
            || t.phase != PreparationPhase::PendingNonce
            || t.next_epoch != f.epoch
        {
            return Err(Error::Conflict);
        }
        let nonce = nonce?;
        if nonce.len() != 32 {
            return Err(Error::KeyService);
        }
        let generation = Generation {
            version: 2,
            canister: env.canister(),
            owner: env.owner(),
            vault,
            epoch: f.epoch,
            nonce,
            key_name: f.key_name.clone(),
        };
        generation.bytes()?;
        t.target = Some(generation);
        t.phase = PreparationPhase::Allocated;
        incident::save(db, &mut j)?;
        c.random = None;
        store::save(db, "control", &c)?;
        Ok(j)
    })
}
pub(crate) async fn derive(env: &impl Environment, r: IncidentDerive) -> Result<KeyReply> {
    env.require_spending()?;
    env.transaction(|db| {
        incident::role(db, env, &r)?;
        runtime::collect_completed_key_rows(db, env)
    })?;
    let (token, flight) = env.transaction(|db| {
        let generation = incident::role(db, env, &r)?;
        if !valid_transport(&r.transport) {
            return Err(Error::InvalidInput);
        }
        let cfg = store::config(db)?;
        if env.balance() < cfg.minimum_cycles as u128 + 30_000_000_000 {
            return Err(Error::QuotaExceeded);
        }
        let mut c = control(db)?;
        if c.derive.as_ref().is_some_and(|f| f.expires > env.now()) {
            return Err(Error::Busy);
        }
        if c.day != env.now() / DAY {
            c.day = env.now() / DAY;
            c.derives = 0;
            c.challenges = 0;
        }
        if c.derives >= 100 {
            return Err(Error::QuotaExceeded);
        }
        c.serial = c
            .serial
            .checked_add(1)
            .filter(|n| *n <= i64::MAX as u64)
            .ok_or(Error::QuotaExceeded)?;
        c.derives += 1;
        store::keys::reserve(
            db,
            c.serial,
            env.now(),
            env.required_derive_payment(&generation.key_name),
        )?;
        let f = Flight {
            token: c.serial,
            vault: generation.vault,
            epoch: generation.epoch,
            state: VaultState::IncidentRequired,
            attempt: Some(r.attempt.clone()),
            expires: env.now() + 120,
            key_name: generation.key_name,
            configuration: grants::fence(db)?,
        };
        c.derive = Some(f.clone());
        store::save(db, "control", &c)?;
        Ok((c.serial, f))
    })?;
    if let Err(e) = env.reserve_cycles(token, store::keys::DERIVE_RESERVATION) {
        env.settle_key_reservation(token, 0)?;
        return Err(e);
    }
    let mut sent = false;
    let mut payment = env.required_derive_payment(&flight.key_name);
    let result = async {
        env.checkpoint_execution()?;
        let public = env.public_key(&flight.key_name).await?;
        env.transaction(|db| check(db, env, &r, &flight, true))?;
        env.require_spending()?;
        payment = env.required_derive_payment(&flight.key_name);
        env.transaction(|db| {
            check(db, env, &r, &flight, true)?;
            store::keys::mark_sent(db, token, payment)
        })?;
        env.checkpoint_execution()?;
        sent = true;
        let encrypted = env
            .derive_key(
                &flight.key_name,
                r.generation.key_input()?,
                r.transport.clone(),
            )
            .await?;
        env.transaction(|db| check(db, env, &r, &flight, true))?;
        runtime::validate_key_reply(KeyReply {
            encrypted_key: encrypted,
            public_key: public,
        })
    }
    .await;
    let actual = if sent {
        env.actual_derive_payment(payment)
    } else {
        0
    };
    env.settle_cycles(token, actual)?;
    let current = env.settle_key_reservation(token, actual)?;
    env.transaction(|db| {
        if !current {
            return Err(Error::Expired);
        }
        check(db, env, &r, &flight, false)?;
        result
    })
}
fn check(
    db: &Connection,
    env: &impl Environment,
    r: &IncidentDerive,
    f: &Flight,
    require_flight: bool,
) -> Result<()> {
    incident::role(db, env, r)?;
    if f.expires <= env.now()
        || f.configuration != grants::fence(db)?
        || require_flight
            && !control(db)?
                .derive
                .is_some_and(|current| current.token == f.token)
    {
        return Err(Error::Expired);
    }
    Ok(())
}
