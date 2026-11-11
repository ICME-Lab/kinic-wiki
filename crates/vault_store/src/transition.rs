//! One prepaid slot, including a possible nested recovery admission. Never discard a parent.
use super::*;
pub fn decode(raw: &str) -> Result<TransitionState> {
    if raw.len() > 65536 {
        return Err(Error::Storage);
    }
    let value: serde_json::Value = serde_json::from_str(raw).map_err(|_| Error::Storage)?;
    if value.is_null() {
        return Ok(TransitionState::default());
    }
    let state = if value.get("version").is_some() {
        if ["version", "incident", "restore", "namespace_flight"]
            .iter()
            .any(|key| value.get(key).is_none())
        {
            return Err(Error::Storage);
        }
        let s: TransitionState = serde_json::from_value(value).map_err(|_| Error::Storage)?;
        if s.version != 1 {
            return Err(Error::Storage);
        }
        s
    } else {
        // Only the exact historical IncidentStatus shape is a legacy value, never an
        // untagged fallback after a failed tagged decode.
        let object = value.as_object().ok_or(Error::Storage)?;
        if object.keys().any(|k| {
            ![
                "job",
                "namespace",
                "compromised",
                "semantic_config",
                "targets",
                "vector_digest",
                "complete",
                "cancel_digest",
                "completed_digest",
            ]
            .contains(&k.as_str())
        }) {
            return Err(Error::Storage);
        }
        TransitionState {
            incident: Some(serde_json::from_value(value).map_err(|_| Error::Storage)?),
            ..Default::default()
        }
    };
    if state.incident.as_ref().is_some_and(|j| {
        j.targets.is_empty() || j.targets.len() > 3 || j.job.len() != 16 || j.namespace.len() != 32
    }) || state.namespace_flight.is_some()
        && (state.incident.is_some() || state.restore.is_some())
    {
        return Err(Error::Storage);
    }
    if let Some(j) = &state.restore {
        if j.request.job.len() != 16
            || j.request.target.namespace.len() != 32
            || j.request.target.vault.len() != 16
            || j.request.target.attempt.len() != 16
            || j.candidate.as_ref().is_some_and(|s| s.len() > 8192)
        {
            return Err(Error::Storage);
        }
        if j.cancel_complete
            && (!j.cancel_requested
                || j.pipeline
                    .as_ref()
                    .is_some_and(|p| p.phase != RestorePhase::Cancelled))
        {
            return Err(Error::Storage);
        }
        let has_candidate = j.candidate.is_some() && j.candidate_digest.len() == 32;
        match (&j.request.candidate_mode, &j.existing_candidate) {
            (Some(RestoreCandidateMode::ExistingInstances(id)), Some(c))
                if !id.is_empty()
                    && id.len() <= 1024
                    && id == &c.credential
                    && c.version > 0
                    && c.version <= i64::MAX as u64
                    && c.scope_digest.len() == 32
                    && has_candidate
                    && j.phase != RestoreAdmissionPhase::Registration => {}
            (None | Some(RestoreCandidateMode::New), None) => {}
            _ => return Err(Error::Storage),
        }

        let phase_valid = match j.phase {
            RestoreAdmissionPhase::Registration => {
                j.candidate.is_none()
                    && j.candidate_digest.is_empty()
                    && j.recovery_message.is_empty()
            }
            RestoreAdmissionPhase::Possession => has_candidate && j.recovery_message.is_empty(),
            RestoreAdmissionPhase::CurrentProof => {
                has_candidate && j.current_live.is_some() && !j.recovery_message.is_empty()
            }
            RestoreAdmissionPhase::Admitted => has_candidate && !j.recovery_message.is_empty(),
        };
        if !phase_valid
            || j.challenge.bytes.len() != 32
            || j.semantic_config.len() != 32
            || j.proof_fence.len() != 32
            || j.request.archive_digest.len() != 32
            || j.request.source_commitment.len() != 32
            || j.next_epoch > i64::MAX as u64
            || j.current_live.is_some() != (j.current_verifier.len() == 32)
            || j.current_live.is_none() && !j.current_verifier.is_empty()
            || j.recovery_message.len() > 8192
        {
            return Err(Error::Storage);
        }
        for g in [&j.current_live, &j.request.source_generation]
            .into_iter()
            .flatten()
        {
            g.bytes().map_err(|_| Error::Storage)?;
        }
        if let Some(p) = &j.pipeline {
            p.target.bytes().map_err(|_| Error::Storage)?;
            if p.target.vault != j.request.target.vault
                || p.target.epoch != j.next_epoch
                || j.current_live
                    .as_ref()
                    .is_some_and(|g| g.nonce == p.target.nonce)
                || p.envelope_digest.len() > 32
                || p.recovery_verifier.len() > 32
                || p.normal.as_ref().is_some_and(|e| {
                    e.version != 2 || e.nonce.len() != 12 || e.ciphertext.len() != 48
                })
                || p.recovery.as_ref().is_some_and(|e| {
                    e.version != 2 || e.nonce.len() != 12 || e.ciphertext.len() != 48
                })
            {
                return Err(Error::Storage);
            }
            if matches!(
                p.phase,
                RestorePhase::EnvelopesStaged
                    | RestorePhase::KitConfirmed
                    | RestorePhase::Discarding
                    | RestorePhase::Importing
                    | RestorePhase::BackupVerified
                    | RestorePhase::Active
            ) && (p.normal.is_none()
                || p.recovery.is_none()
                || p.envelope_digest.len() != 32
                || p.recovery_verifier.len() != 32)
            {
                return Err(Error::Storage);
            }
            if matches!(
                p.phase,
                RestorePhase::KitConfirmed
                    | RestorePhase::Discarding
                    | RestorePhase::Importing
                    | RestorePhase::BackupVerified
                    | RestorePhase::Active
            ) && p.kit_ack.as_ref() != Some(&p.envelope_digest)
            {
                return Err(Error::Storage);
            }
            if matches!(
                p.phase,
                RestorePhase::Discarding
                    | RestorePhase::Importing
                    | RestorePhase::BackupVerified
                    | RestorePhase::Active
            ) && p.preflight.is_none()
            {
                return Err(Error::Storage);
            }
            if matches!(
                p.phase,
                RestorePhase::Importing | RestorePhase::BackupVerified | RestorePhase::Active
            ) && !p.old_removed
            {
                return Err(Error::Storage);
            }
            if matches!(p.phase, RestorePhase::BackupVerified | RestorePhase::Active)
                && p.backup_ack.is_none()
            {
                return Err(Error::Storage);
            }
        }
        if let Some(parent) = &j.parent_job {
            if !state.incident.as_ref().is_some_and(|p| {
                &p.job == parent
                    && p.targets
                        .iter()
                        .any(|t| t.source.generation == j.current_live)
            }) {
                return Err(Error::Storage);
            }
        }
    }
    Ok(state)
}
pub fn load_state(db: &Connection) -> Result<TransitionState> {
    let raw:Option<String>=db.query_row("SELECT value FROM settings WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND key='transition'",params![],|r|sql::row_get(r,0)).optional().map_err(|_|Error::Storage)?;
    raw.map(|s| decode(&s))
        .unwrap_or_else(|| Ok(TransitionState::default()))
}
pub fn save_state(db: &Connection, s: &TransitionState) -> Result<()> {
    let raw = serde_json::to_string(s).map_err(|_| Error::Storage)?;
    if raw.len() > 65536 {
        return Err(Error::QuotaExceeded);
    }
    decode(&raw)?;
    // Leave room for the bounded candidate (8 KiB), two challenges and proof message
    // in admissions; the hard whole-slot bound is always enforced by save.
    save(db, "transition", s)
}
pub fn pending_state(s: &TransitionState) -> bool {
    s.restore.as_ref().is_some_and(restore_unfinished)
        || s.namespace_flight.is_some()
        || s.incident.as_ref().is_some_and(|j| !j.complete)
}
pub fn pending(db: &Connection) -> Result<bool> {
    Ok(pending_state(&load_state(db)?))
}
pub fn any_pending(db: &Connection) -> Result<bool> {
    let mut st = db
        .prepare("SELECT value FROM settings WHERE key='transition'")
        .map_err(|_| Error::Storage)?;
    let rows: Vec<String> =
        sql::query_map(&mut st, params![], |r| sql::row_get(r, 0)).map_err(|_| Error::Storage)?;
    let mut busy = false;
    for raw in rows {
        busy |= pending_state(&decode(&raw)?);
    }
    Ok(busy)
}
pub fn restore_pending(db: &Connection) -> Result<bool> {
    let s = load_state(db)?;
    Ok(s.restore.as_ref().is_some_and(restore_unfinished) || s.namespace_flight.is_some())
}
pub fn pinned(db: &Connection, v: &[u8]) -> Result<bool> {
    let s = load_state(db)?;
    let live = match header(db, v) {
        Ok(h) => h.generation,
        Err(Error::NotFound) => None,
        Err(e) => return Err(e),
    };
    Ok(s.restore.as_ref().is_some_and(|j| {
        restore_unfinished(j)
            && j.request.target.vault == v
            && (live == j.current_live
                || j.pipeline
                    .as_ref()
                    .is_some_and(|p| live.as_ref() == Some(&p.target)))
    }) || s.incident.as_ref().is_some_and(|j| {
        !j.complete
            && j.targets.iter().any(|t| {
                t.source.id == v
                    && t.source.generation == live
                    && !matches!(
                        t.phase,
                        PreparationPhase::Purging | PreparationPhase::Purged
                    )
            })
    }))
}

pub fn restore_unfinished(j: &RestoreAdmissionStatus) -> bool {
    !j.cancel_complete
        && j.pipeline
            .as_ref()
            .is_none_or(|p| !matches!(p.phase, RestorePhase::Active | RestorePhase::Cancelled))
}
