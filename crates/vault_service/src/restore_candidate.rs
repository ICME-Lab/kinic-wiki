//! Existing physical passkeys: immutable admission identity, live shared counter and scope merge.
use super::*;
fn credential(db: &Connection, id: &[u8]) -> Result<passkey_auth::PasskeyCredential> {
    let raw: Option<String> = db.query_row(
        "SELECT value FROM credentials WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND id=?1",
        params![id], |r| kinic_sqlite_compat::row_get(r, 0),
    ).optional().map_err(|_| Error::Storage)?;
    let c: passkey_auth::PasskeyCredential =
        serde_json::from_str(&raw.ok_or(Error::Unauthorized)?).map_err(|_| Error::Storage)?;
    if c.id.0 != id {
        return Err(Error::Unauthorized);
    }
    Ok(c)
}
fn instances(a: &authorization::Authority) -> Result<&Vec<Instance>> {
    match &a.scope {
        CredentialScope::Instances(xs)
            if !a.revoked
                && !xs.is_empty()
                && xs.len() <= 3
                && xs
                    .iter()
                    .all(|x| x.vault.len() == 16 && x.nonce.len() == 32)
                && xs.iter().enumerate().all(|(i, x)| !xs[..i].contains(x)) =>
        {
            Ok(xs)
        }
        _ => Err(Error::Unauthorized),
    }
}
pub(crate) fn capture(
    db: &Connection,
    id: &[u8],
) -> Result<(String, Vec<u8>, RestoreExistingCandidate)> {
    if id.is_empty() || id.len() > 1024 {
        return Err(Error::InvalidInput);
    }
    let a = authorization::authority(db, id)?;
    instances(&a)?;
    let c = credential(db, id)?;
    let raw = serde_json::to_string(&c).map_err(|_| Error::Storage)?;
    if raw.len() > 8192 {
        return Err(Error::QuotaExceeded);
    }
    Ok((
        raw,
        hash(&(c.id.0, c.public_key_cose.0))?,
        RestoreExistingCandidate {
            credential: id.to_vec(),
            version: a.version,
            scope_digest: hash(&a.scope)?,
        },
    ))
}
pub(crate) fn current(db: &Connection, j: &RestoreAdmissionStatus) -> Result<()> {
    match (&j.request.candidate_mode, &j.existing_candidate) {
        (Some(RestoreCandidateMode::ExistingInstances(id)), Some(bound))
            if id == &bound.credential =>
        {
            let a = authorization::authority(db, id)?;
            instances(&a)?;
            let c = credential(db, id)?;
            if a.version != bound.version
                || hash(&a.scope)? != bound.scope_digest
                || hash(&(c.id.0, c.public_key_cose.0))? != j.candidate_digest
            {
                return Err(Error::Unauthorized);
            }
            if restore_admission::physical(db)? > 10 {
                return Err(Error::QuotaExceeded);
            }
            merged_scope(db, j, None)?;
        }
        (None | Some(RestoreCandidateMode::New), None) => {
            if restore_admission::physical(db)? >= 10 {
                return Err(Error::QuotaExceeded);
            }
        }
        _ => return Err(Error::Unauthorized),
    }
    Ok(())
}
pub(crate) fn assert(
    db: &Connection,
    j: &mut RestoreAdmissionStatus,
    ceremony: &Ceremony,
    proof: &str,
) -> Result<()> {
    current(db, j)?;
    let c = if let Some(bound) = &j.existing_candidate {
        // Read the physical credential in this transaction; admission JSON is NOT a counter.
        credential(db, &bound.credential)?
    } else {
        serde_json::from_str(j.candidate.as_ref().ok_or(Error::Unauthorized)?)
            .map_err(|_| Error::Storage)?
    };
    let c = auth::assertion(&store::config(db)?, ceremony, vec![c], proof)?;
    let raw = serde_json::to_string(&c).map_err(|_| Error::Storage)?;
    if j.existing_candidate.is_some() {
        db.execute("UPDATE credentials SET value=?2 WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND id=?1", params![c.id.0, raw]).map_err(|_| Error::Storage)?;
    }
    j.candidate = Some(raw);
    Ok(())
}
fn matches(x: &Instance, g: &Generation) -> bool {
    x.vault == g.vault && x.nonce == g.nonce
}
fn merged_scope(
    db: &Connection,
    j: &RestoreAdmissionStatus,
    target: Option<&Generation>,
) -> Result<CredentialScope> {
    let bound = j.existing_candidate.as_ref().ok_or(Error::Unauthorized)?;
    let a = authorization::authority(db, &bound.credential)?;
    let s = store::transition::load_state(db)?;
    let mut xs = Vec::new();
    for x in instances(&a)? {
        // Only the explicitly proved current instance may be replaced, never VaultID alone.
        if j.current_live.as_ref().is_some_and(|g| matches(x, g)) {
            continue;
        }
        let live = match store::header(db, &x.vault) {
            Ok(h) => h.generation.as_ref().is_some_and(|g| matches(x, g)),
            Err(Error::NotFound) => false,
            Err(e) => return Err(e),
        };
        let pending = s.incident.as_ref().is_some_and(|p| {
            !p.complete
                && p.targets.iter().any(|t| {
                    t.source.generation.as_ref().is_some_and(|g| matches(x, g))
                        || t.target.as_ref().is_some_and(|g| matches(x, g))
                })
        }) || s.restore.as_ref().is_some_and(|r| {
            store::transition::restore_unfinished(r)
                && (r.current_live.as_ref().is_some_and(|g| matches(x, g))
                    || r.pipeline.as_ref().is_some_and(|p| matches(x, &p.target)))
        });
        if live || pending {
            xs.push(x.clone());
        }
    }
    // Admission reserves the eventual tuple even before the server allocates its nonce.
    if xs.len() >= 3 {
        return Err(Error::QuotaExceeded);
    }
    if let Some(g) = target {
        xs.push(Instance {
            vault: g.vault.clone(),
            nonce: g.nonce.clone(),
        });
    }
    Ok(CredentialScope::Instances(xs))
}
pub(crate) fn promote(
    db: &Connection,
    j: &RestoreAdmissionStatus,
    target: &Generation,
) -> Result<()> {
    current(db, j)?;
    if let Some(bound) = &j.existing_candidate {
        let scope = merged_scope(db, j, Some(target))?;
        let mut all = authorization::authorities(db)?;
        let a = all
            .credentials
            .iter_mut()
            .find(|a| a.id == bound.credential)
            .ok_or(Error::Unauthorized)?;
        let mut n = cleanup::namespace(db)?;
        n.serial = n
            .serial
            .checked_add(1)
            .filter(|n| *n <= i64::MAX as u64)
            .ok_or(Error::QuotaExceeded)?;
        a.version = n.serial;
        a.scope = scope;
        cleanup::save(db, &n)?;
        store::save(db, "authorities", &all)
    } else {
        let c = serde_json::from_str(j.candidate.as_ref().ok_or(Error::Unauthorized)?)
            .map_err(|_| Error::Storage)?;
        authorization::insert(
            db,
            &c,
            CredentialScope::Instances(vec![Instance {
                vault: target.vault.clone(),
                nonce: target.nonce.clone(),
            }]),
        )
    }
}
