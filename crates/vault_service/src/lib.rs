//! II-only operations. No request principal, application grant or independent unlock credential.
pub mod runtime;
use runtime::Environment;
use vault_store::{
    self as store,
    kinic_sqlite_compat::{self as sql, OptionalExtension, params},
    operations as ops,
};
use vault_types::*;
fn authenticate(env: &impl Environment) -> Result<()> {
    store::OwnerContext::authenticated(env.owner()).map(|_| ())
}
fn replay<T: serde::de::DeserializeOwned + candid::CandidType>(
    env: &impl Environment,
    op: &[u8],
    digest: &[u8],
) -> Result<Option<T>> {
    env.transaction(|db| ops::replay(db, op, digest, env.now()))
}
pub async fn create_vault(env: &impl Environment, r: CreateVault) -> Result<Header> {
    authenticate(env)?;
    id(&r.vault)?;
    id(&r.operation)?;
    let digest = ops::digest(b"create-vault/v1", &r)?;
    if let Some(result) = replay(env, &r.operation, &digest)? {
        return Ok(result);
    }
    env.require_spending()?;
    let (token,mut h)=env.transaction(|db|{
  let config=store::config(db)?;
  let existing:Option<Vec<u8>>=db.query_row("SELECT operation FROM vaults WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND id=?1",params![r.vault],|r|sql::row_get(r,0)).optional().map_err(|_|Error::Storage)?;
  let h=if let Some(operation)=existing {
   if operation!=r.operation{return Err(Error::Conflict)}
   let h=store::header(db,&r.vault)?;if h.state!=VaultState::Pending{return Err(Error::Conflict)}h
  }else{
   let count:i64=db.query_row("SELECT count(*) FROM vaults WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND json_extract(header,'$.state')<>'Deleted'",params![],|r|sql::row_get(r,0)).map_err(|_|Error::Storage)?;
   let total:i64=db.query_row("SELECT count(*) FROM vaults",params![],|r|sql::row_get(r,0)).map_err(|_|Error::Storage)?;
   if count>=3 || total>=10000{return Err(Error::QuotaExceeded)}
   store::content::check_capacity(db,16384)?;
   let h=Header{id:r.vault.clone(),nonce:vec![],state:VaultState::Pending,sequence:0,key_name:config.key_name,public_key:vec![]};
   let raw=serde_json::to_string(&h).map_err(|_|Error::Storage)?;
   db.execute("INSERT INTO vaults(owner,id,operation,header) VALUES((SELECT owner FROM owner_scope WHERE slot=1),?1,?2,?3)",params![r.vault,r.operation,raw]).map_err(|_|Error::Storage)?;h
  };
  let token=ops::begin(db,&r.operation,&digest,env.now())?;Ok((token,h))
 })?;
    let result = async {
        if h.nonce.is_empty() {
            let nonce = env.random().await?;
            if nonce.len() != 32 {
                return Err(Error::KeyService);
            }
            h = env.transaction(|db| {
                ops::fence(db, &r.operation, token)?;
                let mut h = store::header(db, &r.vault)?;
                if h.state != VaultState::Pending {
                    return Err(Error::Conflict);
                }
                if h.nonce.is_empty() {
                    h.nonce = nonce;
                    store::put_header(db, &h)?;
                }
                Ok(h)
            })?;
        }
        let public = env.public_key(&h.key_name).await?;
        ic_vetkeys::DerivedPublicKey::deserialize(&public).map_err(|_| Error::KeyService)?;
        env.transaction(|db| {
            ops::fence(db, &r.operation, token)?;
            store::config(db)?;
            let mut current = store::header(db, &r.vault)?;
            if current != h || current.state != VaultState::Pending {
                return Err(Error::Conflict);
            }
            current.public_key = public;
            current.state = VaultState::Active;
            store::put_header(db, &current)?;
            ops::complete(db, &r.operation, token, &current, env.now())?;
            Ok(current)
        })
    }
    .await;
    if result.is_err() {
        env.transaction(|db| ops::fail(db, &r.operation, token))?;
    }
    result
}
pub async fn derive_vault_key(env: &impl Environment, r: DeriveKey) -> Result<KeyReply> {
    authenticate(env)?;
    id(&r.vault)?;
    id(&r.operation)?;
    // Reject malformed transport points before reserving paid work.
    if !ic_vetkeys::is_valid_transport_public_key_encoding(&r.transport)
        || r.transport.first() == Some(&0xc0)
    {
        return Err(Error::InvalidInput);
    }
    let digest = ops::digest(b"derive-vault-key/v1", &r)?;
    if let Some(reply) = replay(env, &r.operation, &digest)? {
        return Ok(reply);
    }
    env.transaction(|db| {
        env.recover_pending(db, None)?;
        let owners = store::keys::collect_completed(db, env.now())?;
        env.reconcile_key_gc(db, &owners)
    })?;
    env.require_spending()?;
    let (token, h, input, payment) = env.transaction(|db| {
        store::config(db)?;
        let h = store::active(db, &r.vault)?;
        let input = key_input(env.canister(), env.owner(), &h)?;
        let payment = env.required_derive_payment(&h.key_name);
        let token = ops::begin_key(db, &r.operation, &digest, env.now())?;
        store::keys::reserve(db, token, env.now(), payment)?;
        store::save_key_control(db, token, &r.vault)?;
        Ok((token, h, input, payment))
    })?;
    if let Err(error) = env.reserve_cycles(token, payment) {
        env.settle_key_reservation(token, 0)?;
        env.transaction(|db| ops::fail(db, &r.operation, token))?;
        return Err(error);
    }
    let prepare = env
        .transaction(|db| {
            ops::fence(db, &r.operation, token)?;
            store::keys::mark_sent(db, token, payment)
        })
        .and_then(|_| env.checkpoint_execution());
    if let Err(error) = prepare {
        env.settle_key_reservation(token, 0)?;
        env.settle_cycles(token, 0)?;
        env.transaction(|db| ops::fail(db, &r.operation, token))?;
        return Err(error);
    }
    let encrypted = env
        .derive_key(&h.key_name, input.clone(), r.transport)
        .await;
    let actual = env.actual_derive_payment(payment);
    let current = env.settle_key_reservation(token, actual)?;
    env.settle_cycles(token, actual)?;
    let result = (|| {
        let encrypted_key = encrypted?;
        ic_vetkeys::EncryptedVetKey::deserialize(&encrypted_key).map_err(|_| Error::KeyService)?;
        if !current {
            return Err(Error::Expired);
        }
        let reply = KeyReply {
            encrypted_key,
            public_key: h.public_key.clone(),
            input,
        };
        env.transaction(|db| {
            ops::fence(db, &r.operation, token)?;
            store::config(db)?;
            let now = store::active(db, &r.vault)?;
            if now.nonce != h.nonce || now.key_name != h.key_name || now.public_key != h.public_key
            {
                return Err(Error::Conflict);
            }
            ops::complete(db, &r.operation, token, &reply, env.now())?;
            Ok(reply)
        })
    })();
    if result.is_err() {
        env.transaction(|db| ops::fail(db, &r.operation, token))?;
    }
    result
}
pub fn mutate(env: &impl Environment, r: Mutation) -> Result<MutationResult> {
    authenticate(env)?;
    id(&r.operation)?;
    let digest = ops::digest(b"mutation/v1", &r)?;
    if let Some(result) = replay(env, &r.operation, &digest)? {
        return Ok(result);
    }
    let cleanup = matches!(
        r.action,
        Action::CancelUpload { .. }
            | Action::Collect
            | Action::DeleteVault { .. }
            | Action::PurgeObject { .. }
    );
    if !cleanup {
        env.require_spending()?;
    }
    env.transaction(|db| {
        if let Some(result) = ops::replay(db, &r.operation, &digest, env.now())? {
            return Ok(result);
        }
        let resource_backed = cleanup && cleanup_backing(db, &r.action, env.now())?;
        // Collect before admitting its receipt: journal admission may itself collect
        // expired rows, which must count as progress rather than roll back as a no-op.
        let collected = if matches!(r.action, Action::Collect) {
            let before = sql_changes(db)?;
            env.recover_pending(db, None)?;
            let collected = store::content::gc(db, env.now())?;
            if sql_changes(db)? == before {
                return Err(Error::NotFound);
            }
            Some(collected)
        } else {
            None
        };
        let token = if cleanup {
            if resource_backed {
                ops::begin_resource_cleanup(db, &r.operation, &digest, env.now())?
            } else {
                ops::begin_cleanup(db, &r.operation, &digest, env.now())?
            }
        } else {
            match &r.action {
                Action::PutChunk { upload, index, .. } => {
                    ops::begin_upload(db, &r.operation, &digest, env.now(), upload, Some(*index))?
                }
                Action::CommitRevision { upload } => {
                    ops::begin_upload(db, &r.operation, &digest, env.now(), upload, None)?
                }
                _ => ops::begin(db, &r.operation, &digest, env.now())?,
            }
        };
        let result = match r.action {
            Action::BeginRevision(request) => {
                MutationResult::Upload(store::content::begin(db, request, env.now())?)
            }
            Action::PutChunk {
                upload,
                index,
                bytes,
            } => {
                store::content::put(db, &upload, index, &bytes, env.now())?;
                MutationResult::Done
            }
            Action::CommitRevision { upload } => {
                MutationResult::Revision(store::content::commit(db, &upload, env.now())?)
            }
            Action::DeleteObject {
                vault,
                object,
                expected_revision,
            } => MutationResult::Revision(store::content::delete(
                db,
                &vault,
                &object,
                expected_revision,
                &r.operation,
                env.now(),
            )?),
            Action::PurgeObject {
                vault,
                object,
                expected_revision,
            } => {
                store::content::purge(db, &vault, &object, expected_revision)?;
                MutationResult::Done
            }
            Action::CancelUpload { vault, upload, job } => MutationResult::Progress(
                store::content::cancel_upload_batch(db, &vault, &upload, &job, env.now())?,
            ),
            Action::DeleteVault { vault } => {
                env.recover_pending(db, Some(&vault))?;
                MutationResult::Progress(delete_vault_batch(db, &vault, env.now())?)
            }
            Action::Collect => MutationResult::Collected(collected.ok_or(Error::Storage)?),
        };
        ops::complete(db, &r.operation, token, &result, env.now())?;
        Ok(result)
    })
}
fn sql_changes(db: &sql::Connection) -> Result<i64> {
    db.query_row("SELECT total_changes()", params![], |r| sql::row_get(r, 0))
        .map_err(|_| Error::Storage)
}
/// Only a retained resource may spend its prepaid completion credit. Terminal
/// fresh-id requests fail; exact-id retries have already replayed their receipt.
fn cleanup_backing(db: &sql::Connection, action: &Action, now: u64) -> Result<bool> {
    match action {
        Action::PurgeObject {
            vault,
            object,
            expected_revision,
        } => {
            store::content::check_purge(db, vault, object, *expected_revision)?;
            Ok(true)
        }
        Action::CancelUpload { vault, upload, .. } => {
            let row:Option<(Id,i64)>=db.query_row("SELECT vault,cleanup_budget FROM uploads WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND id=?1",params![upload.as_slice()],|r|Ok((sql::row_get(r,0)?,sql::row_get(r,1)?))).optional().map_err(|_|Error::Storage)?;
            let (target, budget) = row.ok_or(Error::Conflict)?;
            if target != *vault {
                return Err(Error::Unauthorized);
            }
            if budget <= 0 {
                return Err(Error::Storage);
            }
            Ok(true)
        }
        Action::DeleteVault { vault } => {
            let h = store::header(db, vault)?;
            if h.state == VaultState::Deleted {
                return Err(Error::Conflict);
            }
            let budget:i64=db.query_row("SELECT cleanup_budget FROM vaults WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND id=?1",params![vault.as_slice()],|r|sql::row_get(r,0)).map_err(|_|Error::Storage)?;
            if budget <= 0 {
                return Err(Error::Storage);
            }
            Ok(true)
        }
        Action::Collect => {
            // Every such GC pass releases at least one admitted resource credit.
            let backed:i64=db.query_row("SELECT EXISTS(SELECT 1 FROM uploads WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND expires<=?1 AND cleanup_budget>0) OR EXISTS(SELECT 1 FROM revisions WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND retired IS NOT NULL)",params![now as i64],|r|sql::row_get(r,0)).map_err(|_|Error::Storage)?;
            if backed != 0 {
                return Ok(true);
            }
            let any:i64=db.query_row("SELECT EXISTS(SELECT 1 FROM vaults WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND json_extract(header,'$.state')<>'Deleted') OR EXISTS(SELECT 1 FROM uploads WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1)) OR EXISTS(SELECT 1 FROM receipts WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1)) OR EXISTS(SELECT 1 FROM operations WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1)) OR EXISTS(SELECT 1 FROM key_flights WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1))",params![],|r|sql::row_get(r,0)).map_err(|_|Error::Storage)?;
            if any == 0 {
                return Err(Error::NotFound);
            }
            Ok(false)
        }
        _ => Err(Error::InvalidInput),
    }
}
fn delete_vault_batch(db: &sql::Connection, v: &[u8], now: u64) -> Result<bool> {
    let mut h = store::header(db, v)?;
    if h.state == VaultState::Deleted {
        return Ok(true);
    }
    h.state = VaultState::Deleting;
    store::put_header(db, &h)?;
    let upload:Option<(Id,Option<Id>)>=db.query_row("SELECT id,cancel_job FROM uploads WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND vault=?1 LIMIT 1",params![v],|r|Ok((sql::row_get(r,0)?,sql::row_get(r,1)?))).optional().map_err(|_|Error::Storage)?;
    if let Some((u, job)) = upload {
        store::content::cancel_upload_batch(db, v, &u, &job.unwrap_or_else(|| u.clone()), now)?;
        return Ok(false);
    }
    if store::content::remove_ciphertext_batch(db, v, None, None)? > 0 {
        return Ok(false);
    }
    for table in ["revisions", "objects"] {
        db.execute(&format!("DELETE FROM {table} WHERE rowid IN (SELECT rowid FROM {table} WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND vault=?1 LIMIT 100)"),params![v]).map_err(|_|Error::Storage)?;
        let n: i64 = db
            .query_row("SELECT changes()", params![], |r| sql::row_get(r, 0))
            .map_err(|_| Error::Storage)?;
        if n > 0 {
            store::content::release_cleanup_credits(db, v, n)?;
            return Ok(false);
        }
    }
    store::content::release_cleanup_credits(db, v, 1)?;
    h.state = VaultState::Deleted;
    store::put_header(db, &h)?;
    Ok(true)
}
#[cfg(test)]
mod tests;

// Never substitute timestamps, callers or deterministic bytes for cryptographic entropy.
// This adapter exists for ic-vetkeys' transitive rand linkage; service randomness uses raw_rand.
#[cfg(target_arch = "wasm32")]
fn unsupported_sync_entropy(_: &mut [u8]) -> std::result::Result<(), getrandom::Error> {
    Err(getrandom::Error::UNSUPPORTED)
}
#[cfg(target_arch = "wasm32")]
getrandom::register_custom_getrandom!(unsupported_sync_entropy);
