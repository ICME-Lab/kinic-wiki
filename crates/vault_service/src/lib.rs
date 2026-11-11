mod auth;
mod authorization;
pub mod ceremonies;
pub mod cleanup;
pub mod generation;
mod grants;
pub mod mutations;
pub mod recovery;
pub mod runtime;
use kinic_sqlite_compat::{Connection, OptionalExtension, params};
use runtime::Environment;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use vault_store as store;
use vault_types::*;

#[derive(Serialize, Deserialize, Clone)]
struct Ceremony {
    request: BeginUnlock,
    challenge: Challenge,
    created: u64,
    #[serde(default)]
    configuration: Vec<u8>,
}
#[derive(Serialize, Deserialize, Clone)]
struct Flight {
    token: u64,
    vault: Id,
    epoch: u64,
    state: VaultState,
    #[serde(default)]
    attempt: Option<Id>,
    expires: u64,
    #[serde(default)]
    key_name: String,
    #[serde(default)]
    configuration: Vec<u8>,
}
#[derive(Serialize, Deserialize, Default)]
struct Control {
    serial: u64,
    ceremony: Option<Ceremony>,
    random: Option<Flight>,
    derive: Option<Flight>,
    day: u64,
    derives: u64,
    challenges: u64,
    #[serde(default)]
    cleanup_budget: cleanup::Budget,
}
#[derive(Serialize, Deserialize)]
struct Candidate {
    vault: Id,
    credential: passkey_auth::PasskeyCredential,
    digest: Vec<u8>,
    expires: u64,
}
fn valid_transport(bytes: &[u8]) -> bool {
    let Ok(arr) = <&[u8; 48]>::try_from(bytes) else {
        return false;
    };
    Option::<ic_bls12_381::G1Affine>::from(ic_bls12_381::G1Affine::from_compressed(arr))
        .is_some_and(|p| !bool::from(p.is_identity()))
}
fn control(db: &Connection) -> Result<Control> {
    Ok(store::load(db, "control")?.unwrap_or_default())
}
fn hash<T: Serialize>(r: &T) -> Result<Vec<u8>> {
    Ok(Sha256::digest(serde_json::to_vec(r).map_err(|_| Error::InvalidInput)?).to_vec())
}
fn epoch(h: &Header, e: u64) -> Result<()> {
    if h.epoch != e {
        Err(Error::Conflict)
    } else {
        Ok(())
    }
}
fn live(db: &Connection, v: &[u8], t: u64) -> Result<Header> {
    let h = store::header(db, v)?;
    if h.state != VaultState::Active {
        store::pending(db, v, t)?;
    }
    Ok(h)
}
fn credentials(db: &Connection) -> Result<Vec<passkey_auth::PasskeyCredential>> {
    let mut s = db
        .prepare("SELECT value FROM (SELECT * FROM credentials WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1)) ORDER BY id LIMIT 10")
        .map_err(|_| Error::Storage)?;
    let raw: Vec<String> =
        kinic_sqlite_compat::query_map(&mut s, params![], |r| kinic_sqlite_compat::row_get(r, 0))
            .map_err(|_| Error::Storage)?;
    raw.iter()
        .map(|s| serde_json::from_str(s).map_err(|_| Error::Storage))
        .collect()
}
fn insert_credential(db: &Connection, c: &passkey_auth::PasskeyCredential) -> Result<()> {
    let slot:Option<String>=db.query_row("SELECT key FROM settings WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND key LIKE 'credential-slot:%' ORDER BY key LIMIT 1",params![],|r|kinic_sqlite_compat::row_get(r,0)).optional().map_err(|_|Error::Storage)?;
    if let Some(slot) = slot {
        db.execute("DELETE FROM settings WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND key=?1",params![slot]).map_err(|_|Error::Storage)?;
    }
    store::content::check_capacity(db, 65536)?;
    if credentials(db)?.len() >= 10 {
        return Err(Error::QuotaExceeded);
    }
    let existing: Option<String> = db
        .query_row(
            "SELECT value FROM (SELECT * FROM credentials WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1)) WHERE id=?1",
            params![c.id.0],
            |r| kinic_sqlite_compat::row_get(r, 0),
        )
        .optional()
        .map_err(|_| Error::Storage)?;
    if existing.is_some() {
        return Err(Error::Conflict);
    }
    db.execute(
        "INSERT INTO credentials(owner,id,value) VALUES((SELECT owner FROM owner_scope WHERE slot=1),?1,?2)",
        params![
            c.id.0,
            serde_json::to_string(c).map_err(|_| Error::Storage)?
        ],
    )
    .map_err(|_| Error::Storage)?;
    Ok(())
}
fn ceremony(
    db: &Connection,
    now: u64,
    v: &[u8],
    purpose: Purpose,
    transport: &[u8],
    target: &[u8],
) -> Result<Ceremony> {
    let mut c = control(db)?;
    let ch = c.ceremony.take().ok_or(Error::InvalidProof)?;
    if ch.challenge.expires <= now {
        return Err(Error::Expired);
    }
    if ch.request.vault != v
        || ch.request.purpose != purpose
        || ch.request.transport != transport
        || ch.request.target != target
    {
        return Err(Error::InvalidProof);
    }
    if ch.configuration != hash(&store::config(db)?)? {
        return Err(Error::Expired);
    }
    let h = live(db, v, now)?;
    epoch(&h, ch.request.epoch)?;
    store::setup::check_attempt(db, &h, ch.request.attempt.as_deref())?;
    store::save(db, "control", &c)?;
    Ok(ch)
}
fn assert_proof(db: &Connection, ch: &Ceremony, json: &str) -> Result<()> {
    let cfg = store::config(db)?;
    let creds = credentials(db)?;
    let updated = auth::assertion(&cfg, ch, creds, json)?;
    db.execute(
        "UPDATE credentials SET value=?2 WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND (id=?1)",
        params![
            updated.id.0,
            serde_json::to_string(&updated).map_err(|_| Error::Storage)?
        ],
    )
    .map_err(|_| Error::Storage)?;
    Ok(())
}
pub fn reserve_vault(env: &impl Environment, request: Reserve) -> Result<Header> {
    if !env.mutation_authorized() {
        return Err(Error::Unauthorized);
    }
    env.require_spending()?;
    env.transaction(|db| store::reserve(db, env.owner(), request, env.now()))
}
pub fn list_unfinished_vaults(env: &impl Environment) -> Result<Vec<UnfinishedVault>> {
    env.transaction(|db| {
        store::authorize(db, env.owner())?;
        let identity = store::load::<cleanup::Namespace>(db, "cleanup")?.map(|n| n.identity);
        let mut unfinished = store::setup::list(db, env.now())?;
        for item in &mut unfinished {
            item.namespace = identity.clone();
        }
        Ok(unfinished)
    })
}

pub fn cancel_vault_setup(env: &impl Environment, vault: Id, attempt: Id) -> Result<()> {
    env.transaction(|db| {
        store::authorize(db, env.owner())?;
        if !env.mutation_authorized() {
            let h = store::header(db, &vault)?;
            if h.state != VaultState::Pending || h.sequence != 0 || !credentials(db)?.is_empty() {
                return Err(Error::Unauthorized);
            }
        }
        store::setup::cancel(db, &vault, &attempt, env.now())?;
        let Some(mut c) = store::load::<Control>(db, "control")? else {
            return Ok(());
        };
        let matches = |f: &Flight| f.vault == vault && f.attempt.as_ref() == Some(&attempt);
        if c.random.as_ref().is_some_and(matches) {
            c.random = None;
        }
        if c.derive.as_ref().is_some_and(matches) {
            c.derive = None;
        }
        if c.ceremony.as_ref().is_some_and(|ch| {
            ch.request.vault == vault && ch.request.attempt.as_ref() == Some(&attempt)
        }) {
            c.ceremony = None;
        }
        store::save(db, "control", &c)
    })
}

pub fn get_vault_header(env: &impl Environment, vault: Id) -> Result<Header> {
    env.transaction(|db| {
        store::authorize(db, env.owner())?;
        store::incident::readable(db, &vault)
    })
}
pub fn list_vaults(env: &impl Environment) -> Result<Vec<Header>> {
    env.transaction(|db| {
        store::authorize(db, env.owner())?;
        store::list(db)
    })
}
pub fn list_credentials(env: &impl Environment) -> Result<Vec<CredentialInfo>> {
    env.transaction(|db| {
        store::authorize(db, env.owner())?;
        Ok(credentials(db)?
            .into_iter()
            .map(|c| CredentialInfo { id: c.id.0 })
            .collect())
    })
}

pub async fn begin_unlock(env: &impl Environment, request: BeginUnlock) -> Result<Challenge> {
    if !env.mutation_authorized() {
        return Err(Error::Unauthorized);
    }
    env.require_spending()?;
    let token = env.transaction(|db| {
        let cfg = store::authorize(db, env.owner())?;
        let h = live(db, &request.vault, env.now())?;
        epoch(&h, request.epoch)?;
        store::setup::check_attempt(db, &h, request.attempt.as_deref())?;
        if request.transport.len() != 48 || request.target.len() > 1024 {
            return Err(Error::InvalidInput);
        }
        if request.purpose == Purpose::Unlock {
            if !valid_transport(&request.transport) {
                return Err(Error::InvalidInput);
            }
        } else if request.transport != vec![0; 48] {
            return Err(Error::InvalidInput);
        }
        if matches!(request.purpose, Purpose::Unlock) && h.state != VaultState::Active {
            return Err(Error::Conflict);
        }
        if matches!(request.purpose, Purpose::Activate) && h.state == VaultState::Active {
            return Err(Error::Conflict);
        }
        if matches!(
            request.purpose,
            Purpose::AddCredential | Purpose::RemoveCredential
        ) && h.state != VaultState::Active
        {
            return Err(Error::Conflict);
        }
        let creds = credentials(db)?;
        if creds.is_empty() && request.purpose != Purpose::Activate {
            return Err(Error::InvalidProof);
        }
        let mut c = control(db)?;
        let t = env.now();
        if c.random.as_ref().is_some_and(|f| f.expires > t)
            || c.ceremony
                .as_ref()
                .is_some_and(|ch| ch.challenge.expires > t)
        {
            return Err(Error::Busy);
        }
        if c.day != t / DAY {
            c.day = t / DAY;
            c.derives = 0;
            c.challenges = 0
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
        let token = c.serial;
        c.random = Some(Flight {
            token,
            vault: request.vault.clone(),
            epoch: h.epoch,
            state: h.state,
            attempt: request.attempt.clone(),
            expires: t + 120,
            key_name: h.key_name,
            configuration: hash(&cfg)?,
        });
        store::save(db, "control", &c)?;
        Ok(token)
    })?;
    if let Err(error) = env.reserve_challenge(token) {
        env.transaction(|db| {
            let mut c = control(db)?;
            if c.random.as_ref().is_some_and(|f| f.token == token) {
                c.random = None;
            }
            store::save(db, "control", &c)
        })?;
        return Err(error);
    }
    env.checkpoint_execution()?;
    let random = env.random().await;
    env.settle_challenge(token)?;
    env.transaction(|db| {
        store::authorize(db, env.owner())?;
        let mut c = control(db)?;
        let f = c
            .random
            .take()
            .filter(|f| f.token == token)
            .ok_or(Error::Expired)?;
        if f.expires <= env.now() {
            return Err(Error::Expired);
        }
        if f.configuration != hash(&store::config(db)?)? {
            return Err(Error::Expired);
        }
        let h = live(db, &f.vault, env.now())?;
        epoch(&h, f.epoch)?;
        store::setup::check_attempt(db, &h, f.attempt.as_deref())?;
        if h.state != f.state || h.key_name != f.key_name {
            return Err(Error::Conflict);
        }
        let bytes = random?;
        if bytes.len() != 32 {
            return Err(Error::KeyService);
        }
        let creds = credentials(db)?;
        let ch = Challenge {
            bytes,
            expires: env.now() + 120,
            registration: creds.is_empty()
                || (request.purpose == Purpose::AddCredential && request.target.is_empty()),
            credential_ids: creds.into_iter().map(|x| x.id.0).collect(),
        };
        c.ceremony = Some(Ceremony {
            request,
            challenge: ch.clone(),
            created: env.now(),
            configuration: f.configuration,
        });
        store::save(db, "control", &c)?;
        Ok(ch)
    })
}
pub async fn derive_vault_key(env: &impl Environment, request: Derive) -> Result<KeyReply> {
    if !env.mutation_authorized() {
        return Err(Error::Unauthorized);
    }
    env.require_spending()?;
    env.transaction(|db| {
        let h = live(db, &request.vault, env.now())?;
        epoch(&h, request.epoch)?;
        store::setup::check_attempt(db, &h, request.attempt.as_deref())?;
        runtime::collect_completed_key_rows(db, env)
    })?;
    let (cfg, token, flight) = env.transaction(|db| {
        let mut cfg = store::authorize(db, env.owner())?;
        let configuration = hash(&cfg)?;
        if !valid_transport(&request.transport)
            || request.assertion.as_ref().is_some_and(|s| s.len() > 65536)
        {
            return Err(Error::InvalidInput);
        }
        let h = live(db, &request.vault, env.now())?;
        epoch(&h, request.epoch)?;
        store::setup::check_attempt(db, &h, request.attempt.as_deref())?;
        if h.state == VaultState::Active && !env.mutation_authorized() {
            let ch = ceremony(
                db,
                env.now(),
                &request.vault,
                Purpose::Unlock,
                &request.transport,
                &[],
            )?;
            assert_proof(
                db,
                &ch,
                request.assertion.as_deref().ok_or(Error::InvalidProof)?,
            )?;
        }
        let mut c = control(db)?;
        let t = env.now();
        if c.derive.as_ref().is_some_and(|f| f.expires > t) {
            return Err(Error::Busy);
        }
        if c.day != t / DAY {
            c.day = t / DAY;
            c.derives = 0;
            c.challenges = 0
        }
        if c.derives >= 100 {
            return Err(Error::QuotaExceeded);
        }
        if env.balance() < cfg.minimum_cycles as u128 + 30_000_000_000 {
            return Err(Error::QuotaExceeded);
        }
        store::keys::reserve(
            db,
            c.serial
                .checked_add(1)
                .filter(|n| *n <= i64::MAX as u64)
                .ok_or(Error::QuotaExceeded)?,
            t,
            env.required_derive_payment(&h.key_name),
        )?;
        c.derives += 1;
        c.serial = c
            .serial
            .checked_add(1)
            .filter(|n| *n <= i64::MAX as u64)
            .ok_or(Error::QuotaExceeded)?;
        let token = c.serial;
        c.derive = Some(Flight {
            token,
            vault: h.id,
            epoch: h.epoch,
            state: h.state,
            attempt: request.attempt.clone(),
            expires: t + 120,
            key_name: h.key_name.clone(),
            configuration,
        });
        store::save(db, "control", &c)?;
        cfg.key_name = h.key_name;
        Ok((cfg, token, c.derive.clone().ok_or(Error::Storage)?))
    })?;
    let mut payment = env.required_derive_payment(&cfg.key_name);
    if let Err(error) = env.reserve_cycles(token, store::keys::DERIVE_RESERVATION) {
        env.settle_key_reservation(token, 0)?;
        return Err(error);
    }
    env.checkpoint_execution()?;
    let mut sent = false;
    let result = async {
        let public = env.public_key(&cfg.key_name).await?;
        // Every management callback revalidates attempt, epoch, flight and payer.
        env.transaction(|db| {
            let c = control(db)?;
            let f = c
                .derive
                .as_ref()
                .filter(|f| f.token == token)
                .ok_or(Error::Expired)?;
            if f.expires <= env.now() {
                return Err(Error::Expired);
            }
            if f.configuration != hash(&store::config(db)?)? {
                return Err(Error::Expired);
            }
            let h = live(db, &f.vault, env.now())?;
            epoch(&h, f.epoch)?;
            store::setup::check_attempt(db, &h, f.attempt.as_deref())?;
            if h.state != f.state || h.key_name != f.key_name {
                return Err(Error::Conflict);
            }
            Ok(())
        })?;
        env.require_spending()?;
        payment = env.required_derive_payment(&cfg.key_name);
        env.transaction(|db| store::keys::mark_sent(db, token, payment))?;
        env.checkpoint_execution()?;
        sent = true;
        let encrypted = env
            .derive_key(
                &cfg.key_name,
                env.transaction(|db| {
                    let h = store::header(db, &request.vault)?;
                    match h.generation {
                        Some(g) => g.key_input(),
                        None => Err(Error::Unauthorized),
                    }
                })?,
                request.transport,
            )
            .await?;
        runtime::validate_key_reply(KeyReply {
            encrypted_key: encrypted,
            public_key: public,
        })
    }
    .await;
    // Payments are spent once submitted even if the management call rejects or returns late.
    let actual = if sent {
        env.actual_derive_payment(payment)
    } else {
        0
    };
    env.settle_cycles(token, actual)?;
    let current = env.settle_key_reservation(token, actual)?;
    // Release accounting first; publication remains fully grant/runtime/generation fenced.
    env.transaction(|db| {
        store::authorize(db, env.owner())?;
        if !current {
            return Ok(Err(Error::Expired));
        }
        let f = flight;
        if f.expires <= env.now() {
            return Ok(Err(Error::Expired));
        }
        match live(db, &f.vault, env.now()) {
            Ok(h)
                if h.epoch == f.epoch
                    && h.state == f.state
                    && h.key_name == f.key_name
                    && f.configuration == hash(&store::config(db)?)?
                    && store::setup::check_attempt(db, &h, f.attempt.as_deref()).is_ok() =>
            {
                Ok(result)
            }
            _ => Ok(Err(Error::Expired)),
        }
    })?
}
pub fn activate_vault(env: &impl Environment, request: Activate) -> Result<Header> {
    if !env.mutation_authorized() {
        return Err(Error::Unauthorized);
    }
    activate_inner(env, request, false)
}
fn activate_inner(env: &impl Environment, request: Activate, restoring: bool) -> Result<Header> {
    env.transaction(|db| {
        let cfg = store::authorize(db, env.owner())?;
        id(&request.operation)?;
        envelope(&request.normal)?;
        envelope(&request.recovery)?;
        if request.normal.nonce == request.recovery.nonce {
            return Err(Error::InvalidInput);
        }
        let digest = hash(&request)?;
        let prior: Option<(Vec<u8>, String)> = db
            .query_row(
                "SELECT digest,result FROM (SELECT * FROM receipts WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1)) WHERE operation=?1",
                params![request.operation],
                |r| {
                    Ok((
                        kinic_sqlite_compat::row_get(r, 0)?,
                        kinic_sqlite_compat::row_get(r, 1)?,
                    ))
                },
            )
            .optional()
            .map_err(|_| Error::Storage)?;
        if let Some((d, result)) = prior {
            if d != digest {
                return Err(Error::Conflict);
            }
            return serde_json::from_str(&result).map_err(|_| Error::Storage);
        }
        let mut h = store::pending(db, &request.vault, env.now())?;
        store::setup::check_attempt(db, &h, request.attempt.as_deref())?;
        if restoring {
            if h.state != VaultState::Restoring {
                return Err(Error::Conflict);
            }
            store::restore::ready(db, &request.vault, env.now())?;
            if h.recovery.as_ref() != Some(&request.recovery) {
                return Err(Error::InvalidInput);
            }
        } else if h.state != VaultState::Pending {
            return Err(Error::Conflict);
        }
        let ch = ceremony(db, env.now(), &request.vault, Purpose::Activate, &vec![0; 48], &[])?;
        if credentials(db)?.is_empty() {
            let credential = auth::registration(
                &cfg,
                &ch,
                request.registration.as_deref().ok_or(Error::InvalidProof)?,
            )?;
            insert_credential(db, &credential)?;
        } else {
            assert_proof(
                db,
                &ch,
                request.assertion.as_deref().ok_or(Error::InvalidProof)?,
            )?;
        }
        h.state = VaultState::Active;
        h.normal = Some(request.normal);
        h.recovery = Some(request.recovery);
        if restoring {
            store::restore::committed(db, &h.id)?;
        } else {
            h.sequence = 1;
        }
        store::put_header(db, &h)?;
        db.execute("UPDATE vaults SET expires=0 WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND (id=?1)", params![h.id])
            .map_err(|_| Error::Storage)?;
        store::content::record(db, &request.operation, &digest, &h, env.now())?;
        Ok(h)
    })
}
pub fn manage_unlock_credential(env: &impl Environment, request: ManageCredential) -> Result<()> {
    if !env.mutation_authorized() {
        return Err(Error::Unauthorized);
    }
    env.require_spending()?;
    env.transaction(|db| {
        store::authorize(db, env.owner())?;
        store::active(db, &request.vault)?;
        let purpose = if request.remove.is_some() {
            Purpose::RemoveCredential
        } else {
            Purpose::AddCredential
        };
        let target = if let Some(ref id) = request.remove {
            id.clone()
        } else {
            hash(&request.registration)?
        };
        let ch = ceremony(db, env.now(), &request.vault, purpose, &vec![0; 48], &target)?;
        assert_proof(db, &ch, &request.assertion)?;
        if let Some(id) = request.remove {
            let creds = credentials(db)?;
            if creds.len() <= 1 {
                return Err(Error::Conflict);
            }
            if !creds.iter().any(|c| c.id.0 == id) {
                return Err(Error::NotFound);
            }
            db.execute("DELETE FROM credentials WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND (id=?1)", params![id])
                .map_err(|_| Error::Storage)?;
        } else {
            // Registration uses the same bound ceremony challenge; the existing credential signs its digest.
            let candidate: Candidate = store::load(db, "candidate")?.ok_or(Error::InvalidProof)?;
            if candidate.vault != request.vault
                || candidate.digest != target
                || candidate.expires <= env.now()
            {
                return Err(Error::InvalidProof);
            }
            insert_credential(db, &candidate.credential)?;
            db.execute("DELETE FROM settings WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND (key='candidate')", params![])
                .map_err(|_| Error::Storage)?;
        }
        Ok(())
    })
}
pub fn prepare_unlock_credential(
    env: &impl Environment,
    vault: Id,
    registration: String,
) -> Result<Vec<u8>> {
    if !env.mutation_authorized() {
        return Err(Error::Unauthorized);
    }
    env.require_spending()?;
    env.transaction(|db| {
        let cfg = store::authorize(db, env.owner())?;
        store::incident::readable(db, &vault)?;
        let ch = ceremony(
            db,
            env.now(),
            &vault,
            Purpose::AddCredential,
            &vec![0; 48],
            &[],
        )?;
        let credential = auth::registration(&cfg, &ch, &registration)?;
        let digest = hash(&Some(registration))?;
        store::save(
            db,
            "candidate",
            &Candidate {
                vault,
                credential,
                digest: digest.clone(),
                expires: env.now() + 120,
            },
        )?;
        Ok(digest)
    })
}
pub fn begin_revision(env: &impl Environment, request: BeginRevision) -> Result<Upload> {
    if !env.mutation_authorized() {
        return Err(Error::Unauthorized);
    }
    let payer_eligible = env.require_spending().is_ok();
    env.transaction(|db| {
        let cfg = store::authorize(db, env.owner())?;
        let allow_new = env.balance() >= cfg.minimum_cycles as u128 && payer_eligible;
        if allow_new {
            store::content::gc(db, env.now())?;
        }
        store::content::begin_with_budget(db, request, env.now(), allow_new)
    })
}
pub fn put_chunk(env: &impl Environment, upload: Id, index: u32, data: Vec<u8>) -> Result<()> {
    if !env.mutation_authorized() {
        return Err(Error::Unauthorized);
    }
    env.transaction(|db| {
        store::authorize(db, env.owner())?;
        store::content::put(db, &upload, index, &data, env.now())
    })
}
pub fn commit_revision(env: &impl Environment, upload: Id) -> Result<Revision> {
    if !env.mutation_authorized() {
        return Err(Error::Unauthorized);
    }
    env.transaction(|db| {
        store::authorize(db, env.owner())?;
        store::content::commit(db, &upload, env.now())
    })
}
pub fn get_manifest(
    env: &impl Environment,
    vault: Id,
    object: Id,
    revision: u64,
) -> Result<Revision> {
    env.transaction(|db| {
        store::authorize(db, env.owner())?;
        store::content::manifest(db, &vault, &object, revision)
    })
}
pub fn get_chunk(
    env: &impl Environment,
    vault: Id,
    object: Id,
    revision: u64,
    index: u32,
) -> Result<Vec<u8>> {
    env.transaction(|db| {
        store::authorize(db, env.owner())?;
        store::content::chunk(db, &vault, &object, revision, index)
    })
}
pub fn list_history(
    env: &impl Environment,
    vault: Id,
    object: Id,
    before: u64,
) -> Result<RevisionPage> {
    env.transaction(|db| {
        store::authorize(db, env.owner())?;
        store::content::history(db, &vault, &object, before)
    })
}
pub fn list_objects(env: &impl Environment, vault: Id, after: Id) -> Result<ObjectPage> {
    env.transaction(|db| {
        store::authorize(db, env.owner())?;
        store::content::objects(db, &vault, &after)
    })
}
pub fn get_quota(env: &impl Environment, vault: Id) -> Result<Quota> {
    env.transaction(|db| {
        store::authorize(db, env.owner())?;
        store::content::quota(db, &vault)
    })
}
pub fn delete_object(
    env: &impl Environment,
    vault: Id,
    object: Id,
    expected_revision: u64,
    operation: Id,
) -> Result<Revision> {
    if !env.mutation_authorized() {
        return Err(Error::Unauthorized);
    }
    env.require_spending()?;
    env.transaction(|db| {
        store::authorize(db, env.owner())?;
        store::content::delete(
            db,
            &vault,
            &object,
            expected_revision,
            &operation,
            env.now(),
        )
    })
}
pub fn purge_object(env: &impl Environment, vault: Id, object: Id) -> Result<()> {
    if !env.mutation_authorized() {
        return Err(Error::Unauthorized);
    }
    env.transaction(|db| {
        store::authorize(db, env.owner())?;
        store::content::purge(db, &vault, &object, env.now())
    })
}
pub fn collect_garbage(env: &impl Environment) -> Result<u64> {
    if !env.mutation_authorized() {
        return Err(Error::Unauthorized);
    }
    env.transaction(|db| {
        store::authorize(db, env.owner())?;
        store::content::gc(db, env.now())
    })
}
pub fn begin_export(env: &impl Environment, vault: Id, export: Id) -> Result<Export> {
    env.transaction(|db| {
        store::authorize(db, env.owner())?;
        store::content::begin_export(db, &vault, &export, env.now())
    })
}
pub fn export_index(env: &impl Environment, export: Id, after: u64) -> Result<ExportPage> {
    env.transaction(|db| {
        store::authorize(db, env.owner())?;
        store::content::export_index(db, &export, after, env.now())
    })
}
pub fn get_export_chunk(
    env: &impl Environment,
    export: Id,
    object: Id,
    revision: u64,
    index: u32,
) -> Result<Vec<u8>> {
    env.transaction(|db| {
        store::authorize(db, env.owner())?;
        store::content::export_chunk(db, &export, &object, revision, index, env.now())
    })
}
pub fn finish_export(env: &impl Environment, export: Id, saved: bool) -> Result<Header> {
    env.transaction(|db| {
        store::authorize(db, env.owner())?;
        store::content::finish_export(db, &export, saved, env.now())
    })
}
pub fn abort_export(env: &impl Environment, export: Id) -> Result<Header> {
    finish_export(env, export, false)
}
pub fn begin_restore(env: &impl Environment, request: BeginRestore) -> Result<Header> {
    if !env.mutation_authorized() {
        return Err(Error::Unauthorized);
    }
    env.require_spending()?;
    env.transaction(|db| {
        store::authorize(db, env.owner())?;
        store::restore::begin(db, request, env.now())
    })
}
fn restore_transaction<T>(
    env: &impl Environment,
    vault: &[u8],
    attempt: Option<&[u8]>,
    apply: impl FnOnce(&Connection, u64) -> Result<T>,
) -> Result<T> {
    env.transaction(|db| {
        store::authorize(db, env.owner())?;
        let t = env.now();
        let h = store::pending(db, vault, t)?;
        store::setup::check_attempt(db, &h, attempt)?;
        apply(db, t)
    })
}

pub fn begin_restore_revision(
    env: &impl Environment,
    vault: Id,
    revision: Revision,
    attempt: Option<Id>,
) -> Result<()> {
    if !env.mutation_authorized() {
        return Err(Error::Unauthorized);
    }
    restore_transaction(env, &vault, attempt.as_deref(), |db, t| {
        store::restore::stage(db, &vault, revision, t)
    })
}

pub fn put_restore_chunk(
    env: &impl Environment,
    vault: Id,
    index: u32,
    data: Vec<u8>,
    attempt: Option<Id>,
) -> Result<()> {
    if !env.mutation_authorized() {
        return Err(Error::Unauthorized);
    }
    restore_transaction(env, &vault, attempt.as_deref(), |db, t| {
        store::restore::put(db, &vault, index, &data, t)
    })
}

pub fn commit_restore_revision(
    env: &impl Environment,
    vault: Id,
    sequence: u64,
    attempt: Option<Id>,
) -> Result<RestoreProgress> {
    if !env.mutation_authorized() {
        return Err(Error::Unauthorized);
    }
    restore_transaction(env, &vault, attempt.as_deref(), |db, t| {
        store::restore::finish_record(db, &vault, sequence, t)
    })
}
pub fn commit_restore(env: &impl Environment, request: Activate) -> Result<Header> {
    if !env.mutation_authorized() {
        return Err(Error::Unauthorized);
    }
    activate_inner(env, request, true)
}
pub fn get_active_export(env: &impl Environment) -> Result<Option<Export>> {
    env.transaction(|db| {
        store::authorize(db, env.owner())?;
        store::content::active_export(db, env.now())
    })
}
#[cfg(test)]
mod vectors {
    #[test]
    fn webcrypto_aes_gcm_vector() {
        use aes_gcm::{
            Aes256Gcm, KeyInit,
            aead::{Aead, Payload},
        };
        let v: serde_json::Value =
            serde_json::from_str(include_str!("../tests/fixtures/vector.json")).unwrap();
        let bytes = |k: &str| hex::decode(v[k].as_str().unwrap()).unwrap();
        let key = bytes("key");
        let nonce = aes_gcm::Nonce::from(<[u8; 12]>::try_from(bytes("nonce")).unwrap());
        let aad = bytes("aad");
        let plaintext = bytes("plaintext");
        let expected = bytes("ciphertext");
        let c = Aes256Gcm::new_from_slice(&key).unwrap();
        assert_eq!(
            c.encrypt(
                &nonce,
                Payload {
                    msg: &plaintext,
                    aad: &aad
                }
            )
            .unwrap(),
            expected
        );
    }
}
#[cfg(test)]
mod integration_tests;

pub fn get_active_export_for_vault(env: &impl Environment, vault: Id) -> Result<Option<Export>> {
    env.transaction(|db| {
        store::authorize(db, env.owner())?;
        store::content::active_export_for_vault(db, &vault, env.now())
    })
}

pub mod incident;
mod incident_flights;

pub mod incident_cutover;
pub mod incident_export;
pub mod incident_wrapping;

pub mod restore_admission;

mod restore_flights;
pub mod restore_grants;
pub mod restore_pipeline;
