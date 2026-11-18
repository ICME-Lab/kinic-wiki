//! Authorize the explicit vault and translate caller-visible operation/upload
//! IDs before handing a request to the existing owner-funded mutation journal.
use super::*;
use candid::Principal;
use store::sharing::{check_upload_target, scoped_access, scoped_id};

pub(super) struct SharedMutation<'a> {
    pub caller: Principal,
    pub vault: &'a [u8],
    pub wire_upload: Option<Id>,
}

pub async fn shared_derive_vault_key(
    env: &impl Environment,
    caller: Principal,
    mut request: DeriveKey,
) -> Result<KeyReply> {
    request.operation = scoped_id(b"operation", caller, &request.vault, &request.operation)?;
    derive(env, request, Some(caller)).await
}

pub fn shared_mutate(
    env: &impl Environment,
    caller: Principal,
    vault: &[u8],
    mut request: Mutation,
) -> Result<MutationResult> {
    let access = env.transaction(|db| scoped_access(db, caller, vault))?;
    use Action::*;
    let target = match &request.action {
        SaveInline(r) => Some(&r.request.vault),
        BeginRevision(r) => Some(&r.vault),
        DeleteObject { vault, .. }
        | CancelUpload { vault, .. }
        | PurgeObject { vault, .. }
        | DeleteVault { vault } => Some(vault),
        PutChunk { .. } | CommitRevision { .. } => None,
        // Collection crosses vaults. It remains available on the owner-only API.
        Collect => return Err(Error::Unauthorized),
    };
    if target.is_some_and(|t| t != vault)
        || access.role == AccessRole::Viewer
        || (matches!(request.action, PurgeObject { .. } | DeleteVault { .. })
            && access.role != AccessRole::Owner)
    {
        return Err(Error::Unauthorized);
    }
    let wire_upload = if let BeginRevision(r) = &request.action {
        Some(r.operation.clone())
    } else {
        None
    };
    let upload = match &mut request.action {
        BeginRevision(r) => Some(&mut r.operation),
        SaveInline(r) => Some(&mut r.request.operation),
        PutChunk { upload, .. } | CommitRevision { upload } | CancelUpload { upload, .. } => {
            Some(upload)
        }
        _ => None,
    };
    if let Some(upload) = upload {
        *upload = scoped_id(b"upload", caller, vault, upload)?;
        env.transaction(|db| check_upload_target(db, vault, upload))?;
    }
    request.operation = scoped_id(b"operation", caller, vault, &request.operation)?;
    mutate_inner(
        env,
        request,
        Some(SharedMutation {
            caller,
            vault,
            wire_upload,
        }),
    )
}
