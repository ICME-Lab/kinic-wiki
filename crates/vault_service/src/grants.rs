//! Bounded grant admission, exact-byte authentication and atomic last-request receipts.
use super::*;
use ed25519_dalek::{Signature, VerifyingKey};
pub(crate) const GRANT_TTL: u64 = 300;
pub(crate) const RETENTION: u64 = 120;
#[derive(Serialize, Deserialize, Clone)]
pub(crate) struct Grant {
    pub info: GrantInfo,
    pub owner: candid::Principal,
    pub canister: candid::Principal,
    pub public_key: Vec<u8>,
    pub credential: Vec<u8>,
    pub credential_version: u64,
    pub fence: Vec<u8>,
    pub revoked: bool,
    #[serde(default)]
    pub restore_binding: Option<Vec<u8>>,
    pub last_digest: Vec<u8>,
    pub last_result: Option<MutationResult>,
    pub work: Option<Work>,
}
#[derive(Serialize, Deserialize, Clone)]
pub(crate) struct Work {
    pub handle: Id,
    pub expires: u64,
    pub request: WorkRequest,
    pub result: Option<Result<MutationResult>>,
}
#[derive(Serialize, Deserialize, Clone)]
pub(crate) enum WorkRequest {
    Derive(Derive),
    Create(Reserve),
    IncidentAllocate { vault: Id, attempt: Id },
    IncidentDerive(IncidentDerive),
    RestoreAllocate { job: Id },
    RestoreDerive(IncidentDerive),
}
pub(crate) fn key(id: &[u8]) -> String {
    format!(
        "grant:{}",
        id.iter().map(|b| format!("{b:02x}")).collect::<String>()
    )
}
pub(crate) fn fence(db: &Connection) -> Result<Vec<u8>> {
    let generation: Option<String> = db
        .query_row(
            "SELECT value FROM global_settings WHERE key='generation'",
            params![],
            |r| kinic_sqlite_compat::row_get(r, 0),
        )
        .optional()
        .map_err(|_| Error::Storage)?;
    hash(&(store::config(db)?, generation))
}
pub(crate) fn verify(public: &[u8], bytes: &[u8], signature: &[u8]) -> Result<()> {
    let public: &[u8; 32] = public.try_into().map_err(|_| Error::InvalidProof)?;
    let signature = Signature::from_slice(signature).map_err(|_| Error::InvalidProof)?;
    VerifyingKey::from_bytes(public)
        .map_err(|_| Error::InvalidProof)?
        .verify_strict(bytes, &signature)
        .map_err(|_| Error::InvalidProof)
}
pub(crate) fn decode(payload: &[u8]) -> Result<Mutation> {
    if payload.len() > MUTATION_MAX {
        return Err(Error::InvalidInput);
    }
    let mut config = candid::de::DecoderConfig::new();
    config
        .set_decoding_quota(MUTATION_MAX * 8)
        .set_skipping_quota(0)
        .set_max_type_len(256)
        .set_full_error_message(false);
    let mut decoder = candid::de::IDLDeserialize::new_with_config(payload, &config)
        .map_err(|_| Error::InvalidInput)?;
    let result = decoder.get_value().map_err(|_| Error::InvalidInput)?;
    decoder.done().map_err(|_| Error::InvalidInput)?;
    Ok(result)
}
pub(crate) fn load(db: &Connection, id: &[u8]) -> Result<Grant> {
    store::load(db, &key(id))?.ok_or(Error::Unauthorized)
}
pub(crate) fn save(db: &Connection, grant: &Grant) -> Result<()> {
    if store::load::<Grant>(db, &key(&grant.info.id))?.is_none() {
        let slot:Option<String>=db.query_row("SELECT key FROM settings WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND key LIKE 'grant-slot:%' ORDER BY key LIMIT 1",params![],|r|kinic_sqlite_compat::row_get(r,0)).optional().map_err(|_|Error::Storage)?;
        if let Some(slot) = slot {
            db.execute("DELETE FROM settings WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND key=?1",params![slot]).map_err(|_|Error::Storage)?;
        }
    }
    store::save(db, &key(&grant.info.id), grant)
}
pub(crate) fn prepay(db: &Connection) -> Result<()> {
    store::restore_working::prepay(db)?;
    for n in 0..6 {
        store::save(db, &format!("grant-slot:{n}"), &())?;
    }
    for n in 0..10 {
        store::save(db, &format!("credential-slot:{n}"), &())?;
    }
    for k in [
        "candidate",
        "grant-ceremony",
        "grant-random",
        "bootstrap",
        "transition",
    ] {
        store::save(db, k, &())?;
    }
    Ok(())
}
pub(crate) fn admission(db: &Connection, now: u64) -> Result<()> {
    // Never evict receipt state before its full callback deadline; bounded pool scan (512 maximum).
    let mut stmt = db
        .prepare("SELECT owner,key,value FROM settings WHERE key LIKE 'grant:%' LIMIT 513")
        .map_err(|_| Error::Storage)?;
    let rows: Vec<(Vec<u8>, String, String)> =
        kinic_sqlite_compat::query_map(&mut stmt, params![], |r| {
            Ok((
                kinic_sqlite_compat::row_get(r, 0)?,
                kinic_sqlite_compat::row_get(r, 1)?,
                kinic_sqlite_compat::row_get(r, 2)?,
            ))
        })
        .map_err(|_| Error::Storage)?;
    let owner = store::config(db)?.owner;
    let (mut total, mut mine, mut live, mut mine_live) = (0, 0, 0, 0);
    for (o, k, raw) in rows {
        let g: Grant = serde_json::from_str(&raw).map_err(|_| Error::Storage)?;
        if now >= g.info.expires.saturating_add(RETENTION)
            && g.work
                .as_ref()
                .is_none_or(|w| w.result.is_some() || now >= w.expires)
        {
            db.execute(
                "DELETE FROM settings WHERE owner=?1 AND key=?2",
                params![o, k],
            )
            .map_err(|_| Error::Storage)?;
            // Restore the same permanently charged admission slot in its owner's namespace.
            for n in 0..6 {
                let slot = format!("grant-slot:{n}");
                let exists: i64 = db
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM settings WHERE owner=?1 AND key=?2)",
                        params![o, slot],
                        |r| kinic_sqlite_compat::row_get(r, 0),
                    )
                    .map_err(|_| Error::Storage)?;
                if exists == 0 {
                    db.execute(
                        "INSERT INTO settings(owner,key,value) VALUES(?1,?2,'null')",
                        params![o, slot],
                    )
                    .map_err(|_| Error::Storage)?;
                    break;
                }
            }
            continue;
        }
        total += 1;
        mine += usize::from(o == owner.as_slice());
        if !g.revoked && g.info.expires > now {
            live += 1;
            mine_live += usize::from(o == owner.as_slice());
        }
    }
    if total >= 512 || mine >= 6 || live >= 256 || mine_live >= 3 {
        return Err(Error::Busy);
    }
    let prepaid:i64=db.query_row("SELECT EXISTS(SELECT 1 FROM settings WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND key LIKE 'grant-slot:%')",params![],|r|kinic_sqlite_compat::row_get(r,0)).map_err(|_|Error::Storage)?;
    if prepaid == 1 {
        Ok(())
    } else {
        store::content::check_capacity(db, 65536)
    }
}
pub(crate) fn current(db: &Connection, env: &impl Environment, g: &Grant) -> Result<()> {
    if g.owner != env.owner() || g.canister != env.canister() || g.revoked {
        return Err(Error::Unauthorized);
    }
    if g.info.expires <= env.now() || g.fence != fence(db)? {
        return Err(Error::Expired);
    }
    if restore_grants::is_restore(&g.info.purpose) {
        let j =
            restore_grants::validate(db, env, &g.credential, &g.info.purpose, &g.info.generations)?;
        if g.restore_binding.as_ref() != Some(&restore_grants::binding(&j)?) {
            return Err(Error::Unauthorized);
        }
        return Ok(());
    }
    let authority = crate::authorization::authority(db, &g.credential)?;
    if authority.revoked || authority.version != g.credential_version {
        return Err(Error::Unauthorized);
    }
    if matches!(
        g.info.purpose,
        GrantPurpose::Incident { .. }
            | GrantPurpose::IncidentPrepare(_)
            | GrantPurpose::IncidentCutover { .. }
    ) {
        return incident::validate(db, env, &g.credential, &g.info.purpose, &g.info.generations);
    }
    if matches!(g.info.purpose, GrantPurpose::Restore { .. }) {
        return Err(Error::Conflict);
    }
    if matches!(
        g.info.purpose,
        GrantPurpose::Create | GrantPurpose::Credentials
    ) {
        store::incident::owner_change_allowed(db)?;
    }
    if matches!(g.info.purpose, GrantPurpose::Normal) && g.info.generations.is_empty() {
        return Err(Error::Unauthorized);
    }
    if let GrantPurpose::CancelCreation { job, target } = &g.info.purpose {
        if authority.scope != CredentialScope::Global || !g.info.generations.is_empty() {
            return Err(Error::Unauthorized);
        }
        return cleanup::pending_creation(db, target, Some(job));
    }
    for generation in &g.info.generations {
        let h = match store::header(db, &generation.vault) {
            Ok(h) => h,
            Err(Error::NotFound)
                if matches!(g.info.purpose, GrantPurpose::Cleanup { .. })
                    && cleanup::namespace(db)?.deleted.contains(generation) =>
            {
                continue;
            }
            Err(e) => return Err(e),
        };
        if matches!(g.info.purpose, GrantPurpose::Normal) {
            cleanup::normal_allowed(db, &h)?;
            if !matches!(h.state, VaultState::Active | VaultState::Pending) {
                return Err(Error::Unauthorized);
            }
        }
        if h.generation.as_ref() != Some(generation)
            || !crate::authorization::covers(&authority.scope, generation)
        {
            return Err(Error::Unauthorized);
        }
    }
    Ok(())
}
pub(crate) fn authenticate(
    db: &Connection,
    env: &impl Environment,
    m: &Mutation,
    payload: &[u8],
    signature: &[u8],
    g: &Grant,
) -> Result<Option<MutationResult>> {
    if m.version != 2
        || m.owner != env.owner()
        || m.canister != env.canister()
        || m.grant != g.info.id
    {
        return Err(Error::Unauthorized);
    }
    current(db, env, g)?;
    verify(
        &g.public_key,
        &[MUTATION_DOMAIN, payload].concat(),
        signature,
    )?;
    if m.counter.checked_add(1) == Some(g.info.next_counter) {
        if g.last_digest == Sha256::digest(payload).to_vec() {
            return g.last_result.clone().map(Some).ok_or(Error::Conflict);
        }
        return Err(Error::Conflict);
    }
    if m.counter != g.info.next_counter || m.counter >= i64::MAX as u64 {
        return Err(Error::Conflict);
    }
    if g.work
        .as_ref()
        .is_some_and(|w| w.result.is_none() && w.expires > env.now())
    {
        return Err(Error::Busy);
    }
    Ok(None)
}
pub(crate) fn receipt(g: &mut Grant, payload: &[u8], result: &MutationResult) -> Result<()> {
    g.info.next_counter = g
        .info
        .next_counter
        .checked_add(1)
        .ok_or(Error::QuotaExceeded)?;
    g.last_digest = Sha256::digest(payload).to_vec();
    g.last_result = Some(result.clone());
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_bytes_strict_signature_and_trailing_decode() {
        use ed25519_dalek::{Signer, SigningKey};
        let key = SigningKey::from_bytes(&[7; 32]);
        let m = Mutation {
            version: 2,
            canister: candid::Principal::from_slice(&[1]),
            owner: candid::Principal::from_slice(&[2]),
            grant: vec![3; 32],
            counter: 0,
            operation: MutationOperation::RemoveCredential {
                credential: vec![4],
            },
        };
        let bytes = candid::encode_one(&m).unwrap();
        assert!(decode(&bytes).is_ok());
        let signature = key.sign(&[MUTATION_DOMAIN, &bytes].concat()).to_bytes();
        assert!(
            verify(
                key.verifying_key().as_bytes(),
                &[MUTATION_DOMAIN, &bytes].concat(),
                &signature
            )
            .is_ok()
        );
        assert_eq!(
            verify(key.verifying_key().as_bytes(), &bytes, &signature),
            Err(Error::InvalidProof)
        );
        let mut trailing = bytes;
        trailing.push(0);
        assert!(decode(&trailing).is_err());
    }
}
