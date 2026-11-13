//! Paid target-only key flights and allocation; authority remains specific to each workflow.
use super::*;
pub(crate) async fn derive(env: &impl Environment, r: IncidentDerive) -> Result<KeyReply> {
    key_flights::derive(env, r, VaultState::Restoring, role).await
}
pub(crate) async fn derive_empty(env: &impl Environment, r: IncidentDerive) -> Result<KeyReply> {
    key_flights::derive(env, r, VaultState::Pending, create_empty::role).await
}
pub(crate) fn role(
    db: &Connection,
    env: &impl Environment,
    r: &IncidentDerive,
) -> Result<Generation> {
    let j = restore_admission::load(db, &r.job)?;
    restore_admission::fresh(db, env, &j)?;
    let p = j.pipeline.ok_or(Error::Conflict)?;
    if r.role != IncidentRole::Target
        || r.attempt != j.request.target.attempt
        || r.generation != p.target
        || !matches!(
            p.phase,
            RestorePhase::Allocated
                | RestorePhase::EnvelopesStaged
                | RestorePhase::KitConfirmed
                | RestorePhase::Importing
                | RestorePhase::BackupVerified
        )
    {
        return Err(Error::Unauthorized);
    }
    Ok(p.target)
}
pub(crate) async fn allocate(env: &impl Environment, job: Id) -> Result<()> {
    env.require_spending()?;
    let token = env.transaction(|db| {
        let mut j = restore_admission::load(db, &job)?;
        restore_admission::fresh(db, env, &j)?;
        if j.pipeline.is_some() {
            return Err(Error::Conflict);
        }
        // Publication expiry does not settle the previous allocation. Keep its sole
        // durable token until both its RPC and execution checkpoint are accounted for.
        if j.allocation_token
            .map(|token| env.challenge_pending(db, token))
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
            .filter(|x| *x <= i64::MAX as u64)
            .ok_or(Error::QuotaExceeded)?;
        c.random = Some(Flight {
            token: c.serial,
            vault: j.request.target.vault.clone(),
            epoch: j.next_epoch,
            state: VaultState::Restoring,
            attempt: Some(j.request.target.attempt.clone()),
            expires: env.now() + 120,
            key_name: store::config(db)?.key_name,
            configuration: grants::fence(db)?,
        });
        j.allocation_token = Some(c.serial);
        restore_admission::save(db, j)?;
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
        let mut j = restore_admission::load(db, &job)?;
        restore_admission::fresh(db, env, &j)?;
        let mut c = control(db)?;
        let f = c
            .random
            .as_ref()
            .filter(|f| {
                f.token == token
                    && f.attempt.as_ref() == Some(&j.request.target.attempt)
                    && f.vault == j.request.target.vault
            })
            .ok_or(Error::Expired)?;
        if f.configuration != grants::fence(db)? || f.expires <= env.now() || j.pipeline.is_some() {
            return Err(Error::Expired);
        }
        let nonce = nonce?;
        if nonce.len() != 32
            || j.current_live.as_ref().is_some_and(|g| g.nonce == nonce)
            || j.request
                .source_generation
                .as_ref()
                .is_some_and(|g| g.nonce == nonce)
        {
            return Err(Error::KeyService);
        }
        let target = Generation {
            version: 2,
            canister: env.canister(),
            owner: env.owner(),
            vault: j.request.target.vault.clone(),
            epoch: j.next_epoch,
            nonce,
            key_name: f.key_name.clone(),
        };
        target.bytes()?;
        j.pipeline = Some(RestorePipeline {
            target,
            phase: RestorePhase::Allocated,
            normal: None,
            recovery: None,
            recovery_verifier: vec![],
            envelope_digest: vec![],
            kit_ack: None,
            preflight: None,
            old_removed: false,
            discard_started: false,
            cleanup_cursor: 0,
            backup_ack: None,
        });
        restore_admission::save(db, j)?;
        c.random = None;
        store::save(db, "control", &c)
    })
}
