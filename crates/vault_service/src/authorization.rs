//! Physical credentials and immutable restored-instance authority.
use super::*;
#[derive(Serialize, Deserialize, Clone)]
pub(crate) struct Authority {
    pub id: Vec<u8>,
    pub version: u64,
    pub revoked: bool,
    pub scope: CredentialScope,
}
#[derive(Serialize, Deserialize, Clone, Default)]
pub(crate) struct Authorities {
    pub credentials: Vec<Authority>,
}
pub(crate) fn authorities(db: &Connection) -> Result<Authorities> {
    Ok(store::load(db, "authorities")?.unwrap_or_default())
}
pub(crate) fn authority(db: &Connection, id: &[u8]) -> Result<Authority> {
    authorities(db)?
        .credentials
        .into_iter()
        .find(|c| c.id == id)
        .ok_or(Error::Unauthorized)
}
pub(crate) fn covers(scope: &CredentialScope, g: &Generation) -> bool {
    match scope {
        CredentialScope::Global => true,
        CredentialScope::Instances(xs) => {
            xs.iter().any(|x| x.vault == g.vault && x.nonce == g.nonce)
        }
    }
}
pub(crate) fn subset(candidate: &CredentialScope, source: &CredentialScope) -> bool {
    match (candidate, source) {
        (CredentialScope::Global, CredentialScope::Global) => true,
        (CredentialScope::Instances(xs), _) => {
            !xs.is_empty()
                && xs.len() <= 3
                && xs.iter().all(|x| match source {
                    CredentialScope::Global => true,
                    CredentialScope::Instances(ys) => ys.contains(x),
                })
        }
        _ => false,
    }
}
pub(crate) fn insert(
    db: &Connection,
    c: &passkey_auth::PasskeyCredential,
    scope: CredentialScope,
) -> Result<()> {
    let mut all = authorities(db)?;
    let mut n = cleanup::namespace(db)?;
    n.serial = n
        .serial
        .checked_add(1)
        .filter(|x| *x <= i64::MAX as u64)
        .ok_or(Error::QuotaExceeded)?;
    // A namespace-wide high-water version prevents same-ID re-enrollment reviving old grants.
    all.credentials.retain(|a| !a.revoked);
    if all.credentials.len() >= 10 || all.credentials.iter().any(|a| a.id == c.id.0) {
        return Err(Error::QuotaExceeded);
    }
    insert_credential(db, c)?;
    all.credentials.push(Authority {
        id: c.id.0.clone(),
        version: n.serial,
        revoked: false,
        scope,
    });
    cleanup::save(db, &n)?;
    store::save(db, "authorities", &all)
}
pub(crate) fn remove(db: &Connection, issuer: &Authority, id: &[u8]) -> Result<()> {
    let mut all = authorities(db)?;
    let target = all
        .credentials
        .iter()
        .find(|c| c.id == id && !c.revoked)
        .ok_or(Error::NotFound)?;
    if !subset(&target.scope, &issuer.scope) {
        return Err(Error::Unauthorized);
    }
    // Every live instance must retain usable authentication. Removing the proving key itself
    // is allowed only if another appropriate credential survives.
    for h in store::list(db)? {
        let g = h.generation.as_ref().ok_or(Error::Conflict)?;
        if !all
            .credentials
            .iter()
            .any(|a| a.id != id && !a.revoked && covers(&a.scope, g))
        {
            return Err(Error::Conflict);
        }
    }
    let target = all
        .credentials
        .iter_mut()
        .find(|c| c.id == id)
        .ok_or(Error::NotFound)?;
    target.version = target.version.checked_add(1).ok_or(Error::QuotaExceeded)?;
    target.revoked = true;
    db.execute("DELETE FROM credentials WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND id=?1",params![id]).map_err(|_|Error::Storage)?;
    for n in 0..10 {
        let key = format!("credential-slot:{n}");
        let exists:i64=db.query_row("SELECT EXISTS(SELECT 1 FROM settings WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND key=?1)",params![key],|r|kinic_sqlite_compat::row_get(r,0)).map_err(|_|Error::Storage)?;
        if exists == 0 {
            store::save(db, &key, &())?;
            break;
        }
    }
    store::save(db, "authorities", &all)
}
pub(crate) fn assertion(db: &Connection, ch: &Ceremony, id: &[u8], json: &str) -> Result<()> {
    let a = authority(db, id)?;
    if a.revoked {
        return Err(Error::Unauthorized);
    }
    let creds = credentials(db)?
        .into_iter()
        .filter(|c| c.id.0 == id)
        .collect();
    let updated = auth::assertion(&store::config(db)?, ch, creds, json)?;
    db.execute("UPDATE credentials SET value=?2 WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND id=?1",params![updated.id.0,serde_json::to_string(&updated).map_err(|_|Error::Storage)?]).map_err(|_|Error::Storage)?;
    Ok(())
}

#[derive(Serialize, Deserialize)]
struct PendingRegistration {
    vault: Id,
    scope: CredentialScope,
    grant: Id,
    challenge: Challenge,
    fence: Vec<u8>,
    issued: u64,
}
pub(crate) fn begin_registration(
    db: &Connection,
    env: &impl Environment,
    g: &grants::Grant,
    vault: &Id,
    scope: &CredentialScope,
) -> Result<Challenge> {
    registration_authority(db, g, vault, scope)?;
    if credentials(db)?.len() >= 10 {
        return Err(Error::QuotaExceeded);
    }
    let mut n = cleanup::namespace(db)?;
    n.serial = n
        .serial
        .checked_add(1)
        .filter(|n| *n <= i64::MAX as u64)
        .ok_or(Error::QuotaExceeded)?;
    let bytes = cleanup::mac(
        n.seed.as_ref().ok_or(Error::Unauthorized)?,
        b"kinic-vault/candidate/v2\0",
        &candid::encode_args((
            g.info.id.clone(),
            n.serial,
            vault.clone(),
            scope.clone(),
            grants::fence(db)?,
            env.now() + 120,
        ))
        .map_err(|_| Error::InvalidInput)?,
    )?;
    let challenge = Challenge {
        bytes,
        expires: env.now() + 120,
        registration: true,
        credential_ids: credentials(db)?.into_iter().map(|c| c.id.0).collect(),
    };
    store::save(
        db,
        "candidate",
        &PendingRegistration {
            vault: vault.clone(),
            scope: scope.clone(),
            grant: g.info.id.clone(),
            challenge: challenge.clone(),
            fence: grants::fence(db)?,
            issued: env.now(),
        },
    )?;
    cleanup::save(db, &n)?;
    Ok(challenge)
}
fn registration_authority(
    db: &Connection,
    g: &grants::Grant,
    vault: &Id,
    scope: &CredentialScope,
) -> Result<()> {
    let source = authority(db, &g.credential)?;
    if !subset(scope, &source.scope) {
        return Err(Error::Unauthorized);
    }
    if *scope == CredentialScope::Global {
        if g.info.purpose != GrantPurpose::Credentials {
            return Err(Error::Unauthorized);
        }
    } else {
        if !matches!(
            g.info.purpose,
            GrantPurpose::Credentials | GrantPurpose::Normal
        ) {
            return Err(Error::Unauthorized);
        }
        if let CredentialScope::Instances(xs) = scope {
            for x in xs {
                let h = store::header(db, &x.vault)?;
                let generation = h.generation.ok_or(Error::Unauthorized)?;
                if generation.nonce != x.nonce || !g.info.generations.contains(&generation) {
                    return Err(Error::Unauthorized);
                }
            }
        }
    }
    store::active(db, vault)?;
    Ok(())
}
pub(crate) fn register(
    db: &Connection,
    env: &impl Environment,
    g: &grants::Grant,
    vault: &Id,
    scope: &CredentialScope,
    json: &str,
) -> Result<()> {
    registration_authority(db, g, vault, scope)?;
    let p: PendingRegistration = store::load(db, "candidate")?.ok_or(Error::InvalidProof)?;
    if p.vault != *vault
        || p.scope != *scope
        || p.grant != g.info.id
        || p.challenge.expires <= env.now()
        || p.fence != grants::fence(db)?
    {
        return Err(Error::InvalidProof);
    }
    let ch = Ceremony {
        request: BeginUnlock {
            vault: vault.clone(),
            attempt: None,
            epoch: 0,
            purpose: Purpose::AddCredential,
            transport: vec![0; 48],
            target: vec![],
        },
        challenge: p.challenge,
        created: p.issued,
        configuration: p.fence,
    };
    let c = auth::registration(&store::config(db)?, &ch, json)?;
    insert(db, &c, scope.clone())?;
    store::save(db, "candidate", &())?;
    Ok(())
}
