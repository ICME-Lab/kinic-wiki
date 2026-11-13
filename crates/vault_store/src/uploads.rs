//! Owner-scoped upload reconciliation and bounded direct cancellation.
use super::*;
#[derive(Serialize, serde::Deserialize)]
pub(crate) struct CancelledUpload {
    cancelled_vault: Id,
    job: Id,
}
pub(crate) fn cancelled(raw: &str) -> Option<CancelledUpload> {
    serde_json::from_str(raw).ok()
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
    let prior:Option<String>=db.query_row("SELECT result FROM receipts WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND operation=?1 AND expires>?2",params![upload,now as i64],|r|sql::row_get(r,0)).optional().map_err(storage)?;
    let Some(raw) = prior else {
        return Ok(UploadStatus::Absent);
    };
    if cancelled(&raw).is_some() {
        return Ok(UploadStatus::Cancelled);
    }
    if raw == "\"Expired\"" {
        return Ok(UploadStatus::Expired);
    }
    // Receipts also hold unrelated operations; do not misclassify them as committed uploads.
    let Ok(r) = serde_json::from_str::<Revision>(&raw) else {
        return Ok(UploadStatus::Absent);
    };
    if r.deleted {
        return Ok(UploadStatus::Absent);
    }
    Ok(UploadStatus::Committed(CommittedUpload {
        vault: r.vault,
        object: r.object,
        revision: r.revision,
        sequence: r.sequence,
    }))
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
        let prior:Option<String>=db.query_row("SELECT result FROM receipts WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND operation=?1 AND expires>?2",params![upload,now as i64],|r|sql::row_get(r,0)).optional().map_err(storage)?;
        if let Some(raw) = prior {
            // GC may have finished between the authoritative status read and cleanup.
            // This terminal operation cannot be recreated; cancellation is a no-op.
            if raw == "\"Expired\"" {
                return Ok(true);
            }
            if let Some(r) = cancelled(&raw) {
                return if r.cancelled_vault == vault && r.job == job {
                    Ok(true)
                } else {
                    Err(Error::Conflict)
                };
            }
            if let Ok(r) = serde_json::from_str::<Revision>(&raw) {
                return if r.vault == vault && !r.deleted {
                    Ok(true)
                } else {
                    Err(Error::Unauthorized)
                };
            }
        }
        return Err(Error::NotFound);
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
        return Ok(false);
    }
    let result = serde_json::to_string(&CancelledUpload {
        cancelled_vault: vault.to_vec(),
        job: job.to_vec(),
    })
    .map_err(|_| Error::Storage)?;
    // Replace the upload's already-reserved receipt slot. Neither new headroom nor
    // receipt admission is required, including when the shared capacity is exhausted.
    db.execute(
        "DELETE FROM uploads WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND id=?1",
        params![upload],
    )
    .map_err(storage)?;
    db.execute("INSERT INTO receipts(owner,operation,digest,result,expires) VALUES((SELECT owner FROM owner_scope WHERE slot=1),?1,?2,?3,?4)",params![upload,digest,result,(now+DAY) as i64]).map_err(storage)?;
    Ok(true)
}
