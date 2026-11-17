//! Owner-scoped upload reconciliation and bounded direct cancellation.
use super::*;
/// Only upload IDs own these terminal results. Ordinary requests replay in operations.
#[derive(Serialize, serde::Deserialize)]
pub(crate) enum UploadOutcome {
    Committed(Revision),
    Cancelled { vault: Id, job: Id },
}
impl UploadOutcome {
    pub(crate) fn committed(self) -> Result<Revision> {
        match self {
            Self::Committed(revision) => Ok(revision),
            Self::Cancelled { .. } => Err(Error::Conflict),
        }
    }
}
pub(crate) struct Outcome {
    pub digest: Vec<u8>,
    pub result: UploadOutcome,
    pub expires: u64,
}
pub(crate) fn outcome(db: &Connection, upload: &[u8]) -> Result<Option<Outcome>> {
    let row: Option<(Vec<u8>, String, i64)> = db.query_row(
        "SELECT digest,result,expires FROM upload_outcomes WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND upload=?1",
        params![upload], |r| Ok((sql::row_get(r,0)?,sql::row_get(r,1)?,sql::row_get(r,2)?))
    ).optional().map_err(storage)?;
    row.map(|(digest, raw, expires)| {
        Ok(Outcome {
            digest,
            result: serde_json::from_str(&raw).map_err(|_| Error::Storage)?,
            expires: expires as u64,
        })
    })
    .transpose()
}
fn record(db: &Connection, upload: &[u8], digest: &[u8], encoded: &str, now: u64) -> Result<()> {
    db.execute("INSERT INTO upload_outcomes(owner,upload,digest,result,expires) VALUES((SELECT owner FROM owner_scope WHERE slot=1),?1,?2,?3,?4)",params![upload,digest,encoded,(now+DAY) as i64]).map_err(storage)?;
    Ok(())
}
fn encode(outcome: &UploadOutcome) -> Result<String> {
    serde_json::to_string(outcome).map_err(|_| Error::Storage)
}
pub(crate) fn record_committed(
    db: &Connection,
    upload: &[u8],
    digest: &[u8],
    revision: &Revision,
    now: u64,
) -> Result<()> {
    let encoded = encode(&UploadOutcome::Committed(revision.clone()))?;
    content::check_receipt_capacity(db, now)?;
    content::check_capacity(db, 4096 + encoded.len() as u64 + digest.len() as u64)?;
    record(db, upload, digest, &encoded, now)
}
fn storage(_: sql::Error) -> Error {
    Error::Storage
}
pub fn pending_uploads(db: &Connection, after: &[u8]) -> Result<PendingUploads> {
    if !after.is_empty() {
        id(after)?;
    }
    let mut stmt=db.prepare("SELECT id,vault,expires,cancel_job FROM uploads WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND id>?1 ORDER BY id LIMIT 11").map_err(storage)?;
    let mut entries = sql::query_map(&mut stmt, params![after], |r| {
        Ok(PendingUploadSummary {
            upload: sql::row_get(r, 0)?,
            vault: sql::row_get(r, 1)?,
            expires: sql::row_get::<i64>(r, 2)? as u64,
            cancel_job: sql::row_get(r, 3)?,
        })
    })
    .map_err(storage)?;
    let next = if entries.len() > 10 {
        entries.truncate(10);
        entries.last().map(|x| x.upload.clone())
    } else {
        None
    };
    Ok(PendingUploads { entries, next })
}
pub fn upload_status(db: &Connection, upload: &[u8], now: u64) -> Result<UploadStatus> {
    id(upload)?;
    let pending:Option<(String,i64,Option<Id>)>=db.query_row("SELECT request,expires,cancel_job FROM uploads WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND id=?1",params![upload],|r| Ok((sql::row_get(r,0)?,sql::row_get(r,1)?,sql::row_get(r,2)?))).optional().map_err(storage)?;
    if let Some((raw, expires, cancel_job)) = pending {
        if cancel_job.is_none() && expires as u64 <= now {
            return Ok(UploadStatus::Expired);
        }
        let request: BeginRevision = serde_json::from_str(&raw).map_err(|_| Error::Storage)?;
        let mut stmt=db.prepare("SELECT idx FROM chunks WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND upload=?1 ORDER BY idx LIMIT 10").map_err(storage)?;
        let received = sql::query_map(&mut stmt, params![upload], |r| {
            Ok(sql::row_get::<i64>(r, 0)? as u32)
        })
        .map_err(storage)?;
        return Ok(UploadStatus::Pending(PendingUpload {
            request,
            expires: expires as u64,
            received,
            cancel_job,
        }));
    }
    Ok(
        match outcome(db, upload)?
            .filter(|o| o.expires > now)
            .map(|o| o.result)
        {
            None => UploadStatus::Absent,
            Some(UploadOutcome::Cancelled { .. }) => UploadStatus::Cancelled,
            Some(UploadOutcome::Committed(r)) => UploadStatus::Committed(CommittedUpload {
                vault: r.vault,
                object: r.object,
                revision: r.revision,
                sequence: r.sequence,
            }),
        },
    )
}
/// One transaction per batch, held by the service. Never unreserve until all chunks are gone.
/// At most one protocol chunk (1 MiB plaintext + 16-byte AEAD tag) is removed per batch.
pub fn cancel_upload_batch(
    db: &Connection,
    vault: &[u8],
    upload: &[u8],
    job: &[u8],
    now: u64,
) -> Result<bool> {
    id(vault)?;
    id(upload)?;
    id(job)?;
    let row:Option<(Id,Vec<u8>,Option<Id>)>=db.query_row("SELECT vault,digest,cancel_job FROM uploads WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND id=?1",params![upload],|r|Ok((sql::row_get(r,0)?,sql::row_get(r,1)?,sql::row_get(r,2)?))).optional().map_err(storage)?;
    let Some((target, digest, prior_job)) = row else {
        return match outcome(db, upload)?
            .filter(|o| o.expires > now)
            .map(|o| o.result)
        {
            Some(UploadOutcome::Cancelled {
                vault: target,
                job: prior_job,
            }) => {
                if target == vault && prior_job == job {
                    Ok(true)
                } else {
                    Err(Error::Conflict)
                }
            }
            Some(UploadOutcome::Committed(r)) => {
                if r.vault == vault {
                    Ok(true)
                } else {
                    Err(Error::Unauthorized)
                }
            }
            None => Err(Error::NotFound),
        };
    };
    if target != vault {
        return Err(Error::Unauthorized);
    }
    if prior_job.as_ref().is_some_and(|p| p != job) {
        return Err(Error::Conflict);
    }
    db.execute("UPDATE uploads SET cancel_job=?2 WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND id=?1",params![upload,job]).map_err(storage)?;
    db.execute("DELETE FROM chunks WHERE rowid IN (SELECT rowid FROM chunks WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND upload=?1 ORDER BY idx LIMIT 1)",params![upload]).map_err(storage)?;
    let changed: i64 = db
        .query_row("SELECT changes()", params![], |r| sql::row_get(r, 0))
        .map_err(storage)?;
    if changed > 0 {
        db.execute("UPDATE uploads SET reserved=reserved-512,cleanup_budget=cleanup_budget-1 WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND id=?1 AND cleanup_budget>0",params![upload]).map_err(storage)?;
        let changed: i64 = db
            .query_row("SELECT changes()", params![], |r| sql::row_get(r, 0))
            .map_err(storage)?;
        if changed != 1 {
            return Err(Error::Storage);
        }
        return Ok(false);
    }
    let result = encode(&UploadOutcome::Cancelled {
        vault: vault.to_vec(),
        job: job.to_vec(),
    })?;
    // Replace the upload's already-reserved receipt slot. Neither new headroom nor
    // receipt admission is required, including when the shared capacity is exhausted.
    db.execute(
        "DELETE FROM uploads WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND id=?1",
        params![upload],
    )
    .map_err(storage)?;
    record(db, upload, &digest, &result, now)?;
    Ok(true)
}
