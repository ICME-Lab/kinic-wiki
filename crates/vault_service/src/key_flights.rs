//! Shared paid key execution. Callers supply their exact role/freshness policy.
//! Financial settlement delegates to the raw owner environment even after publication expires.
use super::*;
pub(crate) async fn derive<E: Environment>(
    env: &E,
    r: IncidentDerive,
    state: VaultState,
    role: impl Fn(&Connection, &E, &IncidentDerive) -> Result<Generation>,
) -> Result<KeyReply> {
    env.require_spending()?;
    env.transaction(|db| {
        role(db, env, &r)?;
        runtime::collect_completed_key_rows(db, env)
    })?;
    let (token, flight) = env.transaction(|db| {
        let generation = role(db, env, &r)?;
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
            state,
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
        env.transaction(|db| check(db, env, &r, &flight, true, &role))?;
        env.require_spending()?;
        payment = env.required_derive_payment(&flight.key_name);
        env.transaction(|db| {
            check(db, env, &r, &flight, true, &role)?;
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
        env.transaction(|db| check(db, env, &r, &flight, true, &role))?;
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
        check(db, env, &r, &flight, false, &role)?;
        result
    })
}
fn check<E: Environment>(
    db: &Connection,
    env: &E,
    r: &IncidentDerive,
    f: &Flight,
    require_flight: bool,
    role: &impl Fn(&Connection, &E, &IncidentDerive) -> Result<Generation>,
) -> Result<()> {
    role(db, env, r)?;
    if f.expires <= env.now()
        || f.configuration != grants::fence(db)?
        || require_flight
            && control(db)?
                .derive
                .is_none_or(|current| current.token != f.token)
    {
        return Err(Error::Expired);
    }
    Ok(())
}
