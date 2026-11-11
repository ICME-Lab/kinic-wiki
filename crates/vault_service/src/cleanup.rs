//! One prepaid cleanup slot per namespace. No random/key-service call on this path.
use super::*;
use hmac::{Hmac, Mac};
#[derive(Serialize, Deserialize, Clone)]
pub(crate) struct Namespace {
    pub identity: Vec<u8>,
    pub seed: Option<Vec<u8>>,
    pub serial: u64,
    pub pending: Option<Pending>,
    pub grant: Option<grants::Grant>,
    pub job: Option<CleanupProgress>,
    #[serde(default)]
    pub action: Vec<u8>,
    #[serde(default)]
    pub deleted: Vec<Generation>,
    #[serde(default)]
    pub budget: Budget,
}
#[derive(Serialize, Deserialize, Clone)]
pub(crate) struct Pending {
    pub request: GrantRequest,
    pub challenge: Challenge,
    pub fence: Vec<u8>,
    pub issued: u64,
    pub version: u64,
}
pub(crate) fn namespace(db: &Connection) -> Result<Namespace> {
    store::load(db, "cleanup")?.ok_or(Error::Unauthorized)
}
pub(crate) fn save(db: &Connection, n: &Namespace) -> Result<()> {
    store::save(db, "cleanup", n)
}
pub(crate) fn mac(seed: &[u8], domain: &[u8], data: &[u8]) -> Result<Vec<u8>> {
    if seed.len() != 32 {
        return Err(Error::Unauthorized);
    }
    let mut h = Hmac::<Sha256>::new_from_slice(seed).map_err(|_| Error::Storage)?;
    h.update(domain);
    h.update(data);
    Ok(h.finalize().into_bytes().to_vec())
}
#[derive(Serialize, Deserialize, Default, Clone)]
pub(crate) struct Budget {
    day: u64,
    challenge: u64,
    proof: u64,
    mutation: u64,
}
/// Persist counters outside the proof transaction so failed cryptographic proofs count.
pub(crate) fn budget(db: &Connection, now: u64, kind: u8) -> Result<()> {
    let mut namespace = namespace(db)?;
    let mut owner = namespace.budget.clone();
    let raw: Option<String> = db
        .query_row(
            "SELECT value FROM global_settings WHERE key='cleanup-budget'",
            params![],
            |r| kinic_sqlite_compat::row_get(r, 0),
        )
        .optional()
        .map_err(|_| Error::Storage)?;
    let mut global: Budget = raw
        .map(|r| serde_json::from_str(&r).map_err(|_| Error::Storage))
        .transpose()?
        .unwrap_or_default();
    let day = now / DAY;
    if owner.day != day {
        owner = Budget {
            day,
            ..Default::default()
        };
    }
    if global.day != day {
        global = Budget {
            day,
            ..Default::default()
        };
    }
    let (o, g, om, gm) = match kind {
        0 => (&mut owner.challenge, &mut global.challenge, 100, 1000),
        1 => (&mut owner.proof, &mut global.proof, 100, 1000),
        _ => (&mut owner.mutation, &mut global.mutation, 1000, 10000),
    };
    if *o >= om || *g >= gm {
        return Err(Error::RateLimited {
            retry_after: (day + 1) * DAY,
        });
    }
    *o += 1;
    *g += 1;
    namespace.budget = owner;
    save(db, &namespace)?;
    db.execute("INSERT INTO global_settings(key,value) VALUES('cleanup-budget',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![serde_json::to_string(&global).map_err(|_|Error::Storage)?]).map_err(|_|Error::Storage)?;
    Ok(())
}
pub fn begin(env: &impl Environment, r: GrantRequest) -> Result<Challenge> {
    env.transaction(|db| {
        store::authorize(db, env.owner())?;
        let mut n = namespace(db)?;
        let seed = n.seed.as_ref().ok_or(Error::Unauthorized)?;
        let GrantPurpose::Cleanup { job } = &r.purpose else {
            return Err(Error::Unauthorized);
        };
        id(job)?;
        crate::ceremonies::validate_request(db, env, &r)?;
        if let Some(p) = n.pending.as_ref().filter(|p| {
            p.challenge.expires > env.now() && p.fence == grants::fence(db).unwrap_or_default()
        }) {
            return if p.request == r {
                Ok(p.challenge.clone())
            } else {
                Err(Error::Busy)
            };
        }
        if n.job.as_ref().is_some_and(|j| !j.complete && j.job != *job) {
            return Err(Error::Busy);
        }
        if n.job.as_ref().is_some_and(|j| j.complete && j.job != *job) {
            n.job = None;
            n.action.clear();
            n.deleted.clear();
        }
        budget(db, env.now(), 0)?;
        n.budget = namespace(db)?.budget;
        n.serial = n
            .serial
            .checked_add(1)
            .filter(|x| *x <= i64::MAX as u64)
            .ok_or(Error::QuotaExceeded)?;
        let fence = grants::fence(db)?;
        let expires = env.now().checked_add(120).ok_or(Error::QuotaExceeded)?;
        let transcript = candid::encode_args((
            env.canister(),
            env.owner(),
            n.identity.clone(),
            n.serial,
            env.now(),
            expires,
            fence.clone(),
            r.clone(),
        ))
        .map_err(|_| Error::InvalidInput)?;
        let bytes = mac(seed, b"kinic-vault/cleanup-challenge/v1\0", &transcript)?;
        let challenge = Challenge {
            bytes,
            expires,
            registration: false,
            credential_ids: vec![r.credential.clone()],
        };
        let version = authorization::authority(db, &r.credential)?.version;
        n.pending = Some(Pending {
            request: r,
            challenge: challenge.clone(),
            fence,
            issued: env.now(),
            version,
        });
        save(db, &n)?;
        Ok(challenge)
    })
}
pub fn finish(env: &impl Environment, operation: Id, proof: String) -> Result<GrantInfo> {
    if proof.len() > 65536 {
        return Err(Error::InvalidInput);
    }
    env.transaction(|db| {
        let n = namespace(db)?;
        let p = n.pending.as_ref().ok_or(Error::InvalidProof)?;
        if p.request.operation != operation || p.challenge.expires <= env.now() {
            return Err(Error::Expired);
        }
        budget(db, env.now(), 1)
    })?;
    env.transaction(|db| {
        let mut n = namespace(db)?;
        let p = n.pending.clone().ok_or(Error::InvalidProof)?;
        if p.request.operation != operation
            || p.challenge.expires <= env.now()
            || p.fence != grants::fence(db)?
        {
            return Err(Error::Expired);
        }
        crate::ceremonies::validate_request(db, env, &p.request)?;
        let a = authorization::authority(db, &p.request.credential)?;
        if a.version != p.version {
            return Err(Error::Unauthorized);
        }
        let ceremony = crate::ceremonies::as_ceremony(&p);
        authorization::assertion(db, &ceremony, &p.request.credential, &proof)?;
        let id = mac(
            n.seed.as_ref().ok_or(Error::Unauthorized)?,
            b"kinic-vault/cleanup-grant/v1\0",
            &p.challenge.bytes,
        )?;
        let grant = crate::ceremonies::grant(env, p, id, a.version);
        let info = grant.info.clone();
        n.grant = Some(grant);
        n.pending = None;
        save(db, &n)?;
        Ok(info)
    })
}

pub fn status(env: &impl Environment) -> Result<Option<CleanupProgress>> {
    env.transaction(|db| {
        store::authorize(db, env.owner())?;
        Ok(store::load::<Namespace>(db, "cleanup")?.and_then(|n| n.job))
    })
}
/// Reclaim only a completely purged namespace after replay/callback retention. Account/payment
/// tables are intentionally untouched. A fresh namespace gets independent randomness.
pub(crate) fn reclaim_empty(db: &Connection, now: u64) -> Result<()> {
    let Some(n) = store::load::<Namespace>(db, "cleanup")? else {
        return Ok(());
    };
    let count:i64=db.query_row("SELECT (SELECT count(*) FROM vaults WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1))+(SELECT count(*) FROM key_flights WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND (in_flight=1 OR phase='cancelled'))",params![],|r|kinic_sqlite_compat::row_get(r,0)).map_err(|_|Error::Storage)?;
    if count != 0 {
        return Ok(());
    }
    let complete = n.job.as_ref().is_some_and(|j| j.complete)
        && n.grant
            .as_ref()
            .is_some_and(|g| now >= g.info.expires + grants::RETENTION);
    if !complete && !credentials(db)?.is_empty() {
        return Ok(());
    }
    let mut c = control(db)?;
    c.ceremony = None;
    c.random = None;
    c.derive = None;
    db.execute("DELETE FROM settings WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND key!='control'",params![]).map_err(|_|Error::Storage)?;
    db.execute(
        "DELETE FROM credentials WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1)",
        params![],
    )
    .map_err(|_| Error::Storage)?;
    store::save(db, "control", &c)
}
