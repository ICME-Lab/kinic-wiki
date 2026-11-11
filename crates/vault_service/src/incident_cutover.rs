//! Final UV binds already verified bounded summaries. No final record scan or copy.
use super::*;
pub(crate) fn digest(db: &Connection, env: &impl Environment) -> Result<Vec<u8>> {
    let j = incident::load(db, env)?;
    for t in &j.targets {
        if t.phase == PreparationPhase::Purged {
            continue;
        }
        let e = t.staged_export.as_ref().ok_or(Error::Conflict)?;
        let a = t.backup_ack.as_ref().ok_or(Error::Conflict)?;
        if t.phase != PreparationPhase::BackupVerified
            || t.kit_ack.as_ref() != Some(&t.envelope_digest)
            || !t
                .coverage
                .as_ref()
                .is_some_and(|c| c.complete && c.target_root == a.commitment)
            || a.descriptor_digest != e.descriptor_digest
            || a.commitment != e.commitment
            || a.recovery_verifier != t.recovery_verifier
            || a.sequence != e.export.sequence
        {
            return Err(Error::Conflict);
        }
    }
    hash(&("incident-cutover/v1", &j))
}
pub fn ready_digest(env: &impl Environment) -> Result<Vec<u8>> {
    env.transaction(|db| {
        store::authorize(db, env.owner())?;
        digest(db, env)
    })
}
pub(crate) fn publish(db: &Connection, env: &impl Environment, expected: &[u8]) -> Result<()> {
    if digest(db, env)? != expected {
        return Err(Error::Conflict);
    }
    let mut j = incident::load(db, env)?;
    let mut authorities = authorization::authorities(db)?;
    for t in &j.targets {
        if t.phase == PreparationPhase::Purged {
            continue;
        }
        let source = t.source.generation.as_ref().ok_or(Error::Storage)?;
        let target = t.target.as_ref().ok_or(Error::Storage)?;
        for a in authorities.credentials.iter_mut().filter(|a| !a.revoked) {
            if let CredentialScope::Instances(xs) = &mut a.scope {
                for x in xs {
                    if x.vault == source.vault && x.nonce == source.nonce {
                        x.nonce = target.nonce.clone();
                    }
                }
            }
        }
        let mut h = incident_export::target_header(t)?;
        h.backup_sequence = Some(h.sequence);
        h.backup_at = Some(env.now());
        store::put_header(db, &h)?;
        // An old-source header must never be paired with the now inactive/new overlay slot.
        db.execute("UPDATE exports SET state='Aborted' WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND vault=?1 AND state='Active'",params![h.id]).map_err(|_|Error::Storage)?;
    }
    store::save(db, "authorities", &authorities)?;
    // Revoke bounded owner grant rows as well as failing current-state checks, so stale
    // job grants cannot occupy all live slots and block immediate fresh Normal authority.
    let mut stmt = db.prepare("SELECT value FROM settings WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND key LIKE 'grant:%' LIMIT 6").map_err(|_| Error::Storage)?;
    let rows: Vec<String> = kinic_sqlite_compat::query_map(&mut stmt, params![], |r| {
        kinic_sqlite_compat::row_get(r, 0)
    })
    .map_err(|_| Error::Storage)?;
    for raw in rows {
        let mut g: grants::Grant = serde_json::from_str(&raw).map_err(|_| Error::Storage)?;
        let job_grant = match &g.info.purpose {
            GrantPurpose::Incident { job, .. } | GrantPurpose::IncidentCutover { job, .. } => {
                job == &j.job
            }
            GrantPurpose::IncidentPrepare(p) => p.job == j.job,
            _ => false,
        };
        if job_grant
            || matches!(g.info.purpose, GrantPurpose::Normal)
                && g.info.generations.iter().any(|g| {
                    j.targets
                        .iter()
                        .any(|t| t.source.generation.as_ref() == Some(g))
                })
        {
            g.revoked = true;
            grants::save(db, &g)?;
        }
    }
    j.complete = true;
    j.completed_digest = Some(expected.to_vec());
    incident::save(db, &mut j)
}
