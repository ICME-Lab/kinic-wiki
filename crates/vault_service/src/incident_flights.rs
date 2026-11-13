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
    key_flights::derive(env, r, VaultState::IncidentRequired, incident::role).await
}
