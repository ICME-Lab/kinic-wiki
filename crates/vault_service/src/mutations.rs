//! The only production data mutation entrypoint. Effect and replay receipt share one transaction.
use super::*;
use grants::{Grant, Work, WorkRequest};
pub async fn mutate(
    env: &impl Environment,
    payload: Vec<u8>,
    signature: Vec<u8>,
) -> Result<MutationResult> {
    if signature.len() != 64 {
        return Err(Error::InvalidProof);
    }
    let m = grants::decode(&payload)?;
    // Failed Ed25519 proofs consume the separate daily cleanup mutation budget too.
    // Commit this cheap admission separately; proof failure must not roll it back.
    env.transaction(|db| {
        if let Some(n) = store::load::<cleanup::Namespace>(db, "cleanup")? {
            if let Some(g) = n.grant.as_ref().filter(|g| g.info.id == m.grant) {
                if m.owner != env.owner()
                    || m.canister != env.canister()
                    || payload.len() > CLEANUP_MUTATION_MAX
                    || !matches!(m.operation, MutationOperation::Cleanup { .. })
                {
                    return Err(Error::Unauthorized);
                }
                grants::current(db, env, g)?;
                cleanup::budget(db, env.now(), 2)?;
            }
        }
        Ok(())
    })?;
    // Capture policy outside the borrowed store transaction; never reenter canister state.
    let spending =
        matches!(m.operation, MutationOperation::Cleanup { .. }) || env.require_spending().is_ok();
    let (result, work) = env.transaction(|db| {
        store::authorize(db, env.owner())?;
        let mut n = store::load::<cleanup::Namespace>(db, "cleanup")?;
        let is_cleanup = n
            .as_ref()
            .and_then(|n| n.grant.as_ref())
            .is_some_and(|g| g.info.id == m.grant);
        let mut g = if is_cleanup {
            n.as_ref()
                .and_then(|n| n.grant.clone())
                .ok_or(Error::Unauthorized)?
        } else {
            grants::load(db, &m.grant)?
        };
        if is_cleanup && payload.len() > CLEANUP_MUTATION_MAX {
            return Err(Error::InvalidInput);
        }
        if let Some(prior) = grants::authenticate(db, env, &m, &payload, &signature, &g)? {
            return Ok((prior, None));
        }
        let result = if is_cleanup {
            let n = n.as_mut().ok_or(Error::Unauthorized)?;
            n.budget = cleanup::namespace(db)?.budget;
            cleanup_operation(db, env, &g, n, &m.operation)?
        } else {
            if !spending && !matches!(m.operation, MutationOperation::KeyResult { .. }) {
                return Err(Error::QuotaExceeded);
            }
            ordinary(db, env, &mut g, &m.operation)?
        };
        let work = match &result {
            MutationResult::Handle(h) => g.work.clone().filter(|w| w.handle == *h),
            _ => None,
        };
        grants::receipt(&mut g, &payload, &result)?;
        if is_cleanup {
            if candid::encode_one(&result)
                .map_err(|_| Error::Storage)?
                .len()
                > 4096
            {
                return Err(Error::QuotaExceeded);
            }
            let n = n.as_mut().ok_or(Error::Unauthorized)?;
            n.grant = Some(g);
            cleanup::save(db, n)?;
        } else {
            grants::save(db, &g)?;
        }
        Ok((result, work))
    })?;
    if let Some(work) = work {
        let authorized = Authorized {
            env,
            grant: m.grant.clone(),
        };
        let completion = match work.request.clone() {
            WorkRequest::Derive(r) => derive_vault_key(&authorized, r)
                .await
                .map(MutationResult::Key),
            WorkRequest::Create(r) => create_generation(&authorized, r)
                .await
                .map(MutationResult::Header),
        };
        env.transaction(|db| {
            let mut g = grants::load(db, &m.grant)?;
            if !g.work.as_ref().is_some_and(|w| w.handle == work.handle) {
                return Ok(());
            }
            let completion = if grants::current(db, env, &g).is_ok() && work.expires > env.now() {
                completion
            } else {
                Err(Error::Expired)
            };
            g.work.as_mut().ok_or(Error::Storage)?.result = Some(completion);
            grants::save(db, &g)
        })?;
    }
    Ok(result)
}
fn generation<'a>(db: &Connection, g: &'a Grant, v: &[u8], active: bool) -> Result<&'a Generation> {
    let target = g
        .info
        .generations
        .iter()
        .find(|x| x.vault == v)
        .ok_or(Error::Unauthorized)?;
    let h = store::header(db, v)?;
    if h.generation.as_ref() != Some(target) || (active && h.state != VaultState::Active) {
        return Err(Error::Unauthorized);
    }
    Ok(target)
}
fn upload_vault(db: &Connection, upload: &[u8], vault: &[u8]) -> Result<()> {
    let actual:Option<Vec<u8>>=db.query_row("SELECT vault FROM uploads WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND id=?1",params![upload],|r|kinic_sqlite_compat::row_get(r,0)).optional().map_err(|_|Error::Storage)?;
    if actual.as_deref() != Some(vault) {
        return Err(Error::Unauthorized);
    }
    Ok(())
}
fn ordinary(
    db: &Connection,
    env: &impl Environment,
    g: &mut Grant,
    op: &MutationOperation,
) -> Result<MutationResult> {
    let a = authorization::authority(db, &g.credential)?;
    let normal = matches!(g.info.purpose, GrantPurpose::Normal);
    match op {
        MutationOperation::Create(r) => {
            if g.info.purpose != GrantPurpose::Create || a.scope != CredentialScope::Global {
                return Err(Error::Unauthorized);
            }
            if store::load::<cleanup::Namespace>(db, "cleanup")?.is_some_and(|n| {
                n.cancelled
                    .as_ref()
                    .is_some_and(|target| target.vault == r.vault && target.attempt == r.operation)
            }) {
                return Err(Error::Conflict);
            }
            let h = store::reserve(db, env.owner(), r.clone(), env.now())?;
            if h.generation.is_some() {
                return Ok(MutationResult::Header(h));
            }
            work(g, env, WorkRequest::Create(r.clone()))
        }
        MutationOperation::Derive(r) if normal => {
            generation(db, g, &r.vault, false)?;
            if r.assertion.is_some() {
                return Err(Error::InvalidInput);
            }
            work(g, env, WorkRequest::Derive(r.clone()))
        }
        MutationOperation::KeyResult { handle } => {
            let w = g
                .work
                .as_ref()
                .filter(|w| w.handle == *handle)
                .ok_or(Error::NotFound)?;
            if w.expires <= env.now() {
                return Err(Error::Expired);
            }
            w.result.clone().ok_or(Error::Busy)?
        }
        MutationOperation::Activate {
            request: r,
            recovery_verifier,
        } if normal => {
            generation(db, g, &r.vault, false)?;
            let mut h = store::pending(db, &r.vault, env.now())?;
            store::setup::check_attempt(db, &h, r.attempt.as_deref())?;
            if h.state != VaultState::Pending
                || recovery_verifier.len() != 32
                || r.registration.is_some()
                || r.assertion.is_some()
            {
                return Err(Error::InvalidInput);
            }
            ed25519_dalek::VerifyingKey::from_bytes(
                recovery_verifier
                    .as_slice()
                    .try_into()
                    .map_err(|_| Error::InvalidInput)?,
            )
            .map_err(|_| Error::InvalidInput)?;
            for e in [&r.normal, &r.recovery] {
                if e.version != 2 || e.nonce.len() != 12 || e.ciphertext.len() != 48 {
                    return Err(Error::InvalidInput);
                }
            }
            if r.normal.nonce == r.recovery.nonce {
                return Err(Error::InvalidInput);
            }
            h.normal = Some(r.normal.clone());
            h.recovery = Some(r.recovery.clone());
            h.recovery_verifier = recovery_verifier.clone();
            h.state = VaultState::Active;
            h.sequence = 1;
            store::put_header(db, &h)?;
            db.execute("UPDATE vaults SET expires=0 WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND id=?1",params![h.id]).map_err(|_|Error::Storage)?;
            Ok(MutationResult::Header(h))
        }
        MutationOperation::BeginRevision(r) if normal => {
            generation(db, g, &r.vault, true)?;
            if store::format::parse(&r.manifest, r.chunk_hashes.len())?.version != 2 {
                return Err(Error::InvalidInput);
            }
            Ok(MutationResult::Upload(store::content::begin_with_budget(
                db,
                r.clone(),
                env.now(),
                true,
            )?))
        }
        MutationOperation::PutChunk {
            vault,
            upload,
            index,
            data,
        } if normal => {
            generation(db, g, vault, true)?;
            upload_vault(db, upload, vault)?;
            store::content::put(db, upload, *index, data, env.now())?;
            Ok(MutationResult::Unit)
        }
        MutationOperation::CommitRevision { vault, upload } if normal => {
            generation(db, g, vault, true)?;
            upload_vault(db, upload, vault)?;
            let mut r = store::content::commit(db, upload, env.now())?;
            r.manifest.clear();
            r.chunk_hashes.clear();
            Ok(MutationResult::Revision(r))
        }
        MutationOperation::DeleteObject {
            vault,
            object,
            expected_revision,
            operation,
        } if normal => {
            generation(db, g, vault, true)?;
            Ok(MutationResult::Revision(store::content::delete(
                db,
                vault,
                object,
                *expected_revision,
                operation,
                env.now(),
            )?))
        }
        MutationOperation::PurgeObject { vault, object } if normal => {
            generation(db, g, vault, true)?;
            store::content::purge(db, vault, object, env.now())?;
            Ok(MutationResult::Unit)
        }
        MutationOperation::CancelSetup { vault, attempt } if normal => {
            generation(db, g, vault, false)?;
            env.cleanup_existing_flights(db, std::slice::from_ref(vault), true)?;
            let mut c = control(db)?;
            if c.random
                .as_ref()
                .is_some_and(|f| f.vault == *vault && f.attempt.as_ref() == Some(attempt))
            {
                c.random = None;
                store::save(db, "control", &c)?;
            }
            store::setup::cancel(db, vault, attempt, env.now())?;
            Ok(MutationResult::Unit)
        }
        MutationOperation::RemoveCredential { credential }
            if g.info.purpose == GrantPurpose::Credentials =>
        {
            authorization::remove(db, &a, credential)?;
            Ok(MutationResult::Unit)
        }
        MutationOperation::BeginRegistration { vault, scope } => Ok(MutationResult::Challenge(
            authorization::begin_registration(db, env, g, vault, scope)?,
        )),
        MutationOperation::RegisterCredential {
            vault,
            registration,
            scope,
        } => {
            authorization::register(db, env, g, vault, scope, registration)?;
            Ok(MutationResult::Unit)
        }
        _ => Err(Error::Unauthorized),
    }
}
fn work(g: &mut Grant, env: &impl Environment, request: WorkRequest) -> Result<MutationResult> {
    if g.work
        .as_ref()
        .is_some_and(|w| w.result.is_none() && w.expires > env.now())
    {
        return Err(Error::Busy);
    }
    let handle = Sha256::digest(
        [
            b"kinic-vault/work/v2".as_slice(),
            &g.info.id,
            &g.info.next_counter.to_be_bytes(),
        ]
        .concat(),
    )
    .to_vec();
    g.work = Some(Work {
        handle: handle.clone(),
        expires: env.now() + 120,
        request,
        result: None,
    });
    Ok(MutationResult::Handle(handle))
}
async fn create_generation(env: &impl Environment, r: Reserve) -> Result<Header> {
    let token = env.transaction(|db| {
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
        let h = store::pending(db, &r.vault, env.now())?;
        c.random = Some(Flight {
            token: c.serial,
            vault: r.vault.clone(),
            attempt: Some(r.operation.clone()),
            epoch: h.epoch,
            state: h.state,
            key_name: h.key_name,
            expires: env.now() + 120,
            configuration: grants::fence(db)?,
        });
        store::save(db, "control", &c)?;
        Ok(c.serial)
    })?;
    env.reserve_challenge(token)?;
    env.checkpoint_execution()?;
    let nonce = env.random().await;
    env.settle_challenge(token)?;
    env.transaction(|db| {
        let mut c = control(db)?;
        let f = c
            .random
            .as_ref()
            .filter(|f| f.token == token)
            .ok_or(Error::Expired)?;
        if f.expires <= env.now() || f.configuration != grants::fence(db)? {
            return Err(Error::Expired);
        }
        let mut h = store::pending(db, &r.vault, env.now())?;
        store::setup::check_attempt(db, &h, Some(&r.operation))?;
        let nonce = nonce?;
        if nonce.len() != 32 {
            return Err(Error::KeyService);
        }
        if h.generation.is_some() {
            return Err(Error::Conflict);
        }
        let g = Generation {
            version: 2,
            canister: env.canister(),
            owner: env.owner(),
            vault: h.id.clone(),
            epoch: h.epoch,
            nonce,
            key_name: h.key_name.clone(),
        };
        g.bytes()?;
        h.generation = Some(g);
        c.random = None;
        store::save(db, "control", &c)?;
        store::put_header(db, &h)?;
        Ok(h)
    })
}
/// Validated delegation is private to this module. No public epoch/boolean is an API capability.
struct Authorized<'a, E> {
    env: &'a E,
    grant: Id,
}
impl<E: Environment> Environment for Authorized<'_, E> {
    fn owner(&self) -> candid::Principal {
        self.env.owner()
    }
    fn canister(&self) -> candid::Principal {
        self.env.canister()
    }
    fn now(&self) -> u64 {
        self.env.now()
    }
    fn balance(&self) -> u128 {
        self.env.balance()
    }
    fn mutation_authorized(&self) -> bool {
        true
    }
    fn transaction<T>(&self, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        self.env.transaction(|db| {
            let g = grants::load(db, &self.grant)?;
            grants::current(db, self.env, &g)?;
            f(db)
        })
    }
    fn require_spending(&self) -> Result<()> {
        self.env.require_spending()
    }
    fn reserve_challenge(&self, t: u64) -> Result<()> {
        self.env.reserve_challenge(t)
    }
    fn settle_challenge(&self, t: u64) -> Result<()> {
        self.env.settle_challenge(t)
    }
    fn checkpoint_execution(&self) -> Result<()> {
        self.env.checkpoint_execution()
    }
    fn reserve_cycles(&self, t: u64, a: u64) -> Result<()> {
        self.env.reserve_cycles(t, a)
    }
    fn settle_cycles(&self, t: u64, a: u64) -> Result<()> {
        self.env.settle_cycles(t, a)
    }
    fn required_derive_payment(&self, k: &str) -> u64 {
        self.env.required_derive_payment(k)
    }
    fn actual_derive_payment(&self, a: u64) -> u64 {
        self.env.actual_derive_payment(a)
    }
    async fn random(&self) -> Result<Vec<u8>> {
        self.env.random().await
    }
    async fn public_key(&self, k: &str) -> Result<Vec<u8>> {
        self.env.public_key(k).await
    }
    async fn derive_key(&self, k: &str, i: Vec<u8>, t: Vec<u8>) -> Result<Vec<u8>> {
        self.env.derive_key(k, i, t).await
    }
}
fn cleanup_operation(
    db: &Connection,
    env: &impl Environment,
    g: &Grant,
    n: &mut cleanup::Namespace,
    op: &MutationOperation,
) -> Result<MutationResult> {
    let MutationOperation::Cleanup {
        job,
        cursor,
        action,
    } = op
    else {
        return Err(Error::Unauthorized);
    };
    let pending = match &g.info.purpose {
        GrantPurpose::Cleanup { job: authorized } if authorized == job => None,
        GrantPurpose::CancelCreation {
            job: authorized,
            target,
        } if authorized == job => {
            if action
                != &(CleanupAction::CancelSetup {
                    attempt: target.attempt.clone(),
                })
            {
                return Err(Error::Unauthorized);
            }
            Some(target)
        }
        _ => return Err(Error::Unauthorized),
    };
    let mut progress = n.job.clone().unwrap_or(CleanupProgress {
        job: job.clone(),
        cursor: 0,
        complete: false,
    });
    if progress.job != *job || progress.cursor != *cursor || progress.complete {
        return Err(Error::Conflict);
    }
    let targets: Vec<Id> = pending
        .map(|p| vec![p.vault.clone()])
        .unwrap_or_else(|| g.info.generations.iter().map(|g| g.vault.clone()).collect());
    // Both cancellation routes validate the same exact never-activated attempt
    // before accounting. Its freeze marker and accounting progress commit atomically.
    let cancellation_target = if let CleanupAction::CancelSetup { attempt } = action {
        if targets.len() != 1 {
            return Err(Error::InvalidInput);
        }
        let target = PendingCreation {
            namespace: n.identity.clone(),
            vault: targets[0].clone(),
            attempt: attempt.clone(),
        };
        cleanup::pending_creation(db, &target, None)?;
        Some(target)
    } else {
        None
    };
    // Immutable job identity includes the action; each grant renewal continues the same job.
    let digest = hash(&(job, action, &targets))?;
    if !n.action.is_empty() && n.action != digest {
        return Err(Error::Conflict);
    }
    n.action = digest;
    let settled = env.cleanup_existing_flights(
        db,
        &targets,
        matches!(
            action,
            CleanupAction::Purge | CleanupAction::CancelSetup { .. }
        ),
    )?;
    let complete = match action {
        CleanupAction::Purge => {
            if settled {
                store::cleanup::purge_batch(db, &targets)?
            } else {
                false
            }
        }
        CleanupAction::Expired => store::cleanup::expired_batch(db, &targets, env.now())?,
        CleanupAction::CancelSetup { attempt } => {
            if targets.len() != 1 {
                return Err(Error::InvalidInput);
            }
            let mut c = control(db)?;
            if c.random
                .as_ref()
                .is_some_and(|f| f.vault == targets[0] && f.attempt.as_ref() == Some(attempt))
            {
                c.random = None;
                store::save(db, "control", &c)?;
            }
            n.cancelled = cancellation_target;
            if settled {
                store::setup::cancel(db, &targets[0], attempt, env.now())?;
            }
            settled
        }
        CleanupAction::AbortExport { export } => {
            let e = store::content::active_export(db, env.now())?.ok_or(Error::NotFound)?;
            if e.id != *export || !targets.contains(&e.vault) {
                return Err(Error::Unauthorized);
            }
            store::content::finish_export(db, export, false, env.now())?;
            true
        }
    };
    progress.cursor = progress.cursor.checked_add(1).ok_or(Error::QuotaExceeded)?;
    progress.complete = complete;
    if complete
        && matches!(
            action,
            CleanupAction::Purge | CleanupAction::CancelSetup { .. }
        )
    {
        n.deleted = g.info.generations.clone();
    }
    n.job = Some(progress.clone());
    Ok(MutationResult::Cleanup(progress))
}
