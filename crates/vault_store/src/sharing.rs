//! Vault-scoped authorization. Only the server resolves a vault's immutable owner.
use super::*;
use sha2::{Digest, Sha256};

// Covers the principal record and both index entries. Each new member also
// reserves a separate cleanup credit in vaults.cleanup_budget.
pub(crate) const MEMBER_CHARGE_SQL: &str = "512";
const MEMBER_CHARGE: u64 = 512;
const PAGE: usize = 20;
fn storage(_: sql::Error) -> Error {
    Error::Storage
}

fn decode_role(value: i64) -> Result<AccessRole> {
    match value {
        0 => Ok(AccessRole::Owner),
        1 => Ok(AccessRole::Editor),
        2 => Ok(AccessRole::Viewer),
        _ => Err(Error::Storage),
    }
}
type AccessRow = (Vec<u8>, String, i64);
fn access_row(row: &sql::Row<'_>) -> sql::Result<AccessRow> {
    Ok((
        sql::row_get(row, 0)?,
        sql::row_get(row, 1)?,
        sql::row_get(row, 2)?,
    ))
}
fn decode((owner, header, role): AccessRow) -> Result<VaultAccess> {
    Ok(VaultAccess {
        owner: Principal::try_from_slice(&owner).map_err(|_| Error::Storage)?,
        header: serde_json::from_str(&header).map_err(|_| Error::Storage)?,
        role: decode_role(role)?,
    })
}
pub fn access(db: &Connection, caller: Principal, vault: &[u8]) -> Result<VaultAccess> {
    OwnerContext::authenticated(caller)?;
    id(vault)?;
    let row = db.query_row(
        "SELECT v.owner,v.header,CASE WHEN v.owner=?2 THEN 0 ELSE m.role END
         FROM vaults v LEFT JOIN vault_members m ON m.owner=v.owner AND m.vault=v.id AND m.member=?2
         WHERE v.id=?1 AND (v.owner=?2 OR (m.role IS NOT NULL AND json_extract(v.header,'$.state')='Active'))",
        params![vault,caller.as_slice()],access_row).optional().map_err(storage)?;
    decode(row.ok_or(Error::Unauthorized)?)
}
pub fn accessible(db: &Connection, caller: Principal, after: &[u8]) -> Result<VaultAccessPage> {
    OwnerContext::authenticated(caller)?;
    if !after.is_empty() {
        id(after)?;
    }
    let mut q=db.prepare(
        "SELECT owner,header,role FROM (
           SELECT v.id,v.owner,v.header,0 AS role FROM vaults v WHERE v.owner=?1 AND v.id>?2
           UNION ALL
           SELECT m.vault,m.owner,v.header,m.role FROM vault_members m JOIN vaults v ON v.id=m.vault AND v.owner=m.owner
           WHERE m.member=?1 AND m.vault>?2 AND json_extract(v.header,'$.state')='Active'
         ) ORDER BY id LIMIT ?3").map_err(storage)?;
    let rows = sql::query_map(
        &mut q,
        params![caller.as_slice(), after, (PAGE + 1) as i64],
        access_row,
    )
    .map_err(storage)?;
    let mut entries = rows.into_iter().map(decode).collect::<Result<Vec<_>>>()?;
    let next = if entries.len() > PAGE {
        entries.truncate(PAGE);
        entries.last().map(|a| a.header.id.clone())
    } else {
        None
    };
    Ok(VaultAccessPage { entries, next })
}
/// Verify the owner scope used by storage/accounting matches the authenticated
/// principal's access to this exact vault before any owner-scoped operation.
pub fn scoped_access(db: &Connection, caller: Principal, vault: &[u8]) -> Result<VaultAccess> {
    let result = access(db, caller, vault)?;
    let scoped: Option<Vec<u8>> = db
        .query_row(
            "SELECT owner FROM owner_scope WHERE slot=1",
            params![],
            |r| sql::row_get(r, 0),
        )
        .optional()
        .map_err(storage)?;
    if scoped.as_deref() != Some(result.owner.as_slice()) {
        return Err(Error::Unauthorized);
    }
    Ok(result)
}
fn admin(db: &Connection, caller: Principal, vault: &[u8]) -> Result<()> {
    if scoped_access(db, caller, vault)?.role != AccessRole::Owner {
        return Err(Error::Unauthorized);
    }
    Ok(())
}
pub fn members(db: &Connection, caller: Principal, vault: &[u8]) -> Result<Vec<VaultMember>> {
    admin(db, caller, vault)?;
    let mut stmt=db.prepare("SELECT member,role FROM vault_members WHERE owner=?1 AND vault=?2 ORDER BY member LIMIT 100").map_err(storage)?;
    let rows: Vec<(Vec<u8>, i64)> =
        sql::query_map(&mut stmt, params![caller.as_slice(), vault], |r| {
            Ok((sql::row_get(r, 0)?, sql::row_get(r, 1)?))
        })
        .map_err(storage)?;
    rows.into_iter()
        .map(|(member, role)| {
            Ok(VaultMember {
                principal: Principal::try_from_slice(&member).map_err(|_| Error::Storage)?,
                role: decode_role(role)?,
            })
        })
        .collect()
}
fn changes(db: &Connection) -> Result<i64> {
    db.query_row("SELECT changes()", params![], |r| sql::row_get(r, 0))
        .map_err(storage)
}
pub fn set_member(
    db: &Connection,
    caller: Principal,
    vault: &[u8],
    member: Principal,
    role: AccessRole,
) -> Result<()> {
    admin(db, caller, vault)?;
    active(db, vault)?;
    OwnerContext::authenticated(member)?;
    let role = match role {
        AccessRole::Editor => 1,
        AccessRole::Viewer => 2,
        AccessRole::Owner => return Err(Error::InvalidInput),
    };
    if member == caller {
        return Err(Error::InvalidInput);
    }
    db.execute(
        "UPDATE vault_members SET role=?4 WHERE owner=?1 AND vault=?2 AND member=?3",
        params![caller.as_slice(), vault, member.as_slice(), role],
    )
    .map_err(storage)?;
    if changes(db)? > 0 {
        return Ok(());
    }
    let count: i64 = db
        .query_row(
            "SELECT count(*) FROM vault_members WHERE owner=?1 AND vault=?2",
            params![caller.as_slice(), vault],
            |r| sql::row_get(r, 0),
        )
        .map_err(storage)?;
    if count >= 100 {
        return Err(Error::QuotaExceeded);
    }
    content::check_capacity(db, MEMBER_CHARGE + operations::CLEANUP_CHARGE)?;
    db.execute(
        "INSERT INTO vault_members(owner,vault,member,role) VALUES(?1,?2,?3,?4)",
        params![caller.as_slice(), vault, member.as_slice(), role],
    )
    .map_err(storage)?;
    content::add_cleanup_credits(db, vault, 1)
}
pub fn remove_member(
    db: &Connection,
    caller: Principal,
    vault: &[u8],
    member: Principal,
) -> Result<()> {
    admin(db, caller, vault)?;
    if member == caller {
        return Err(Error::InvalidInput);
    }
    OwnerContext::authenticated(member)?;
    db.execute(
        "DELETE FROM vault_members WHERE owner=?1 AND vault=?2 AND member=?3",
        params![caller.as_slice(), vault, member.as_slice()],
    )
    .map_err(storage)?;
    content::release_cleanup_credits(db, vault, changes(db)?)
}

/// Stable, domain-separated, fixed-size journal and resource keys. The owner-only
/// protocol retains its original 16-byte identifiers.
pub fn scoped_id(domain: &[u8], caller: Principal, vault: &[u8], wire: &[u8]) -> Result<Id> {
    id(vault)?;
    id(wire)?;
    let mut hash = Sha256::new();
    hash.update(b"kinic-vault/shared-id/v1");
    for part in [domain, caller.as_slice(), vault, wire] {
        hash.update((part.len() as u32).to_be_bytes());
        hash.update(part);
    }
    Ok(hash.finalize()[..16].to_vec())
}
/// Match both live and terminal resource bindings before exposing any receipt.
pub fn check_upload_target(db: &Connection, vault: &[u8], upload: &[u8]) -> Result<()> {
    let pending:Option<Id>=db.query_row("SELECT vault FROM uploads WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND id=?1",params![upload],|r|sql::row_get(r,0)).optional().map_err(storage)?;
    let actual = match pending {
        Some(target) => Some(target),
        None => crate::uploads::outcome(db, upload)?.map(|o| match o.result {
            crate::uploads::UploadOutcome::Cancelled { vault, .. } => vault,
            crate::uploads::UploadOutcome::Committed(r) => r.vault,
        }),
    };
    if actual.is_some_and(|v| v != vault) {
        return Err(Error::Unauthorized);
    }
    Ok(())
}
pub fn remember_upload(
    db: &Connection,
    caller: Principal,
    vault: &[u8],
    wire: &[u8],
    upload: &[u8],
) -> Result<()> {
    // One small handle per live reservation is covered by its metadata overhead.
    // SQLite deletes it in the same transaction that removes the upload.
    db.execute("INSERT OR IGNORE INTO shared_upload_handles(owner,vault,upload,caller,wire)
        SELECT owner,vault,id,?3,?4 FROM uploads WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND vault=?1 AND id=?2",
        params![vault,upload,caller.as_slice(),wire]).map_err(storage)?;
    Ok(())
}
pub fn pending_uploads(
    db: &Connection,
    caller: Principal,
    vault: &[u8],
    after: &[u8],
) -> Result<PendingUploads> {
    scoped_access(db, caller, vault)?;
    if !after.is_empty() {
        id(after)?;
    }
    let mut q=db.prepare("SELECT h.wire,u.expires,u.cancel_job FROM shared_upload_handles h JOIN uploads u ON u.owner=h.owner AND u.vault=h.vault AND u.id=h.upload
        WHERE h.owner=(SELECT owner FROM owner_scope WHERE slot=1) AND h.vault=?1 AND h.caller=?2 AND h.wire>?3 LIMIT 1").map_err(storage)?;
    let entries = sql::query_map(&mut q, params![vault, caller.as_slice(), after], |r| {
        Ok(PendingUploadSummary {
            upload: sql::row_get(r, 0)?,
            vault: vault.to_vec(),
            expires: sql::row_get::<i64>(r, 1)? as u64,
            cancel_job: sql::row_get(r, 2)?,
        })
    })
    .map_err(storage)?;
    Ok(PendingUploads {
        entries,
        next: None,
    })
}
pub fn upload_status(
    db: &Connection,
    caller: Principal,
    vault: &[u8],
    wire: &[u8],
    now: u64,
) -> Result<UploadStatus> {
    scoped_access(db, caller, vault)?;
    let upload = scoped_id(b"upload", caller, vault, wire)?;
    check_upload_target(db, vault, &upload)?;
    let mut status = content::upload_status(db, &upload, now)?;
    if let UploadStatus::Pending(p) = &mut status {
        p.request.operation = wire.to_vec();
    }
    Ok(status)
}
