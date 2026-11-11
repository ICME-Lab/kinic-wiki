//! Authenticated Wiki adapter for the private Vault service. No owner arrives in API arguments.
use super::{now_millis, with_service};
use candid::Principal;
use ic_cdk_management_canister as management;
use kinic_sqlite_compat::Connection;
use vault_service::runtime::Environment;
use vault_store::OwnerContext;
use vault_types::*;

struct WikiVault {
    owner: OwnerContext,
    started: u64,
    derive_payment: std::cell::Cell<Option<u64>>,
    operation: std::cell::Cell<Option<(u64, bool)>>,
}
impl WikiVault {
    fn capture() -> Result<Self> {
        let owner = OwnerContext::authenticated(ic_cdk::api::msg_caller())?;
        Ok(Self {
            owner,
            started: meter(),
            derive_payment: std::cell::Cell::new(None),
            operation: std::cell::Cell::new(None),
        })
    }
    fn execution_cycles(&self) -> u64 {
        meter().saturating_sub(self.started).saturating_add(
            (super::UPDATE_EXECUTION_BASE_CYCLES + super::UPDATE_ACCOUNTING_OVERHEAD_CYCLES) as u64,
        )
    }
    fn operation_token(&self) -> Option<String> {
        self.operation.get().map(|(token, derive)| {
            format!("{}:{token}", if derive { "derive" } else { "challenge" })
        })
    }
    fn finish<T>(&self, result: Result<T>) -> Result<T> {
        let amount = self.execution_cycles();
        // Reserved operations stay bound to their original payer even after ownership loss/rebind.
        if let Some(token) = self.operation_token() {
            with_service(|s| {
                s.vault_finish_execution(&self.owner().to_text(), &token, amount, now_millis())
            })
            .ok();
        } else {
            with_service(|s| {
                s.vault_charge_execution(&self.owner().to_text(), amount, now_millis())
            })
            .ok();
        }

        result
    }
}
fn meter() -> u64 {
    #[cfg(target_arch = "wasm32")]
    {
        ic_cdk::api::performance_counter(
            ic_cdk::api::PerformanceCounterType::CallContextInstructionCounter,
        )
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        0
    }
}
impl Environment for WikiVault {
    fn owner(&self) -> Principal {
        self.owner.owner()
    }
    fn now(&self) -> u64 {
        super::now_nanos() / 1_000_000_000
    }
    fn balance(&self) -> u128 {
        ic_cdk::api::canister_cycle_balance()
    }
    fn transaction<T>(&self, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        with_service(|s| {
            let result = s.vault_transaction(self.owner, |db| {
                let value = f(db)?;
                let usage = vault_store::content::usage(db)?;
                Ok((value, usage))
            });
            match result {
                Ok((value, usage)) => {
                    s.vault_track_storage(&self.owner().to_text(), usage, now_millis())
                        .ok();
                    Ok(Ok(value))
                }
                Err(error) => Ok(Err(error)),
            }
        })
        .map_err(|_| Error::Storage)?
    }
    fn require_spending(&self) -> Result<()> {
        let config = with_service(|s| Ok(s.vault_config()))
            .map_err(|_| Error::Storage)??
            .ok_or(Error::Unauthorized)?;
        if self.balance() < config.minimum_cycles as u128 {
            return Err(Error::QuotaExceeded);
        }
        with_service(|s| s.vault_require_spending(&self.owner().to_text(), now_millis()))
            .map(|_| ())
            .map_err(|_| Error::QuotaExceeded)
    }
    fn reserve_challenge(&self, token: u64) -> Result<()> {
        with_service(|s| {
            s.vault_reserve_cycles(
                &self.owner().to_text(),
                &format!("challenge:{token}"),
                (super::UPDATE_EXECUTION_BASE_CYCLES + super::UPDATE_ACCOUNTING_OVERHEAD_CYCLES)
                    as u64,
                now_millis(),
            )
        })
        .map_err(|_| Error::QuotaExceeded)?;
        self.operation.set(Some((token, false)));
        Ok(())
    }
    fn settle_challenge(&self, token: u64) -> Result<()> {
        with_service(|s| {
            s.vault_settle_cycles(
                &self.owner().to_text(),
                &format!("challenge:{token}"),
                0,
                now_millis(),
            )
        })
        .map_err(|_| Error::Storage)
    }
    fn checkpoint_execution(&self) -> Result<()> {
        let token = self.operation_token().ok_or(Error::Storage)?;
        with_service(|s| {
            s.vault_checkpoint_execution(&self.owner().to_text(), &token, self.execution_cycles())
        })
        .map_err(|_| Error::Storage)
    }
    fn reserve_cycles(&self, token: u64, amount: u64) -> Result<()> {
        with_service(|s| {
            s.vault_reserve_cycles(
                &self.owner().to_text(),
                &format!("derive:{token}"),
                amount.saturating_add(
                    (super::UPDATE_EXECUTION_BASE_CYCLES + super::UPDATE_ACCOUNTING_OVERHEAD_CYCLES)
                        as u64,
                ),
                now_millis(),
            )
        })
        .map_err(|_| Error::QuotaExceeded)?;
        self.operation.set(Some((token, true)));
        Ok(())
    }
    fn settle_cycles(&self, token: u64, actual: u64) -> Result<()> {
        with_service(|s| {
            s.vault_reconcile_refunded_cycles(
                &self.owner().to_text(),
                &format!("derive:{token}"),
                actual,
                now_millis(),
            )
        })
        .map_err(|_| Error::Storage)?;
        with_service(|s| Ok(s.vault_settle_key_flight(self.owner, token, self.now(), actual)))
            .map_err(|_| Error::Storage)?
    }
    fn actual_derive_payment(&self, attached: u64) -> u64 {
        self.derive_payment.get().unwrap_or(attached)
    }
    fn required_derive_payment(&self, key_name: &str) -> u64 {
        ic_cdk::api::cost_vetkd_derive_key(key_name, 0)
            .ok()
            .and_then(|x| u64::try_from(x).ok())
            .unwrap_or(u64::MAX)
    }
    async fn random(&self) -> Result<Vec<u8>> {
        management::raw_rand().await.map_err(|_| Error::KeyService)
    }
    async fn public_key(&self, name: &str) -> Result<Vec<u8>> {
        management::vetkd_public_key(&management::VetKDPublicKeyArgs {
            canister_id: None,
            context: CONTEXT.to_vec(),
            key_id: key_id(name),
        })
        .await
        .map(|x| x.public_key)
        .map_err(|_| Error::KeyService)
    }
    async fn derive_key(&self, name: &str, input: Vec<u8>, transport: Vec<u8>) -> Result<Vec<u8>> {
        let payment = self.required_derive_payment(name);
        let result = management::vetkd_derive_key(&management::VetKDDeriveKeyArgs {
            input,
            context: CONTEXT.to_vec(),
            key_id: key_id(name),
            transport_public_key: transport,
        })
        .await;
        let refund = u64::try_from(ic_cdk::api::msg_cycles_refunded()).unwrap_or(u64::MAX);
        self.derive_payment
            .set(Some(payment.saturating_sub(refund)));
        result
            .map(|x| x.encrypted_key)
            .map_err(|_| Error::KeyService)
    }
}
fn key_id(name: &str) -> management::VetKDKeyId {
    management::VetKDKeyId {
        curve: management::VetKDCurve::Bls12_381_G2,
        name: name.into(),
    }
}

#[ic_cdk::update]
fn vault_get_payer() -> vault_types::Result<Option<String>> {
    let env = WikiVault::capture()?;
    with_service(|s| s.vault_payer(&env.owner().to_text())).map_err(|_| Error::Storage)
}
#[ic_cdk::update]
fn vault_set_payer(database_id: String) -> vault_types::Result<()> {
    let env = WikiVault::capture()?;
    with_service(|s| s.vault_set_payer(&env.owner().to_text(), &database_id, now_millis()))
        .map_err(|_| Error::Unauthorized)
}
#[ic_cdk::update]
fn vault_set_config(config: Option<vault_types::VaultConfig>) -> vault_types::Result<()> {
    if !ic_cdk::api::is_controller(&ic_cdk::api::msg_caller()) {
        return Err(Error::Unauthorized);
    }
    with_service(|s| Ok(s.vault_set_config(config))).map_err(|_| Error::Storage)?
}
#[ic_cdk::update]
fn vault_get_config() -> vault_types::Result<Option<vault_types::VaultConfig>> {
    // Public configuration contains no owner data and is required for exact RP/origin matching.
    OwnerContext::authenticated(ic_cdk::api::msg_caller())?;
    with_service(|s| Ok(s.vault_config())).map_err(|_| Error::Storage)?
}
#[ic_cdk::update]
fn vault_reserve_vault(request: vault_types::Reserve) -> vault_types::Result<vault_types::Header> {
    let env = WikiVault::capture()?;
    let result = vault_service::reserve_vault(&env, request);
    env.finish(result)
}

#[ic_cdk::update]
fn vault_list_unfinished_vaults() -> vault_types::Result<Vec<vault_types::UnfinishedVault>> {
    let env = WikiVault::capture()?;
    let result = vault_service::list_unfinished_vaults(&env);
    env.finish(result)
}

#[ic_cdk::update]
fn vault_cancel_vault_setup(
    vault: vault_types::Id,
    attempt: vault_types::Id,
) -> vault_types::Result<()> {
    let env = WikiVault::capture()?;
    let result = vault_service::cancel_vault_setup(&env, vault, attempt);
    env.finish(result)
}

#[ic_cdk::update]
fn vault_get_vault_header(vault: vault_types::Id) -> vault_types::Result<vault_types::Header> {
    let env = WikiVault::capture()?;
    let result = vault_service::get_vault_header(&env, vault);
    env.finish(result)
}

#[ic_cdk::update]
fn vault_list_vaults() -> vault_types::Result<Vec<vault_types::Header>> {
    let env = WikiVault::capture()?;
    let result = vault_service::list_vaults(&env);
    env.finish(result)
}

#[ic_cdk::update]
fn vault_list_credentials() -> vault_types::Result<Vec<vault_types::CredentialInfo>> {
    let env = WikiVault::capture()?;
    let result = vault_service::list_credentials(&env);
    env.finish(result)
}

#[ic_cdk::update]
async fn vault_begin_unlock(
    request: vault_types::BeginUnlock,
) -> vault_types::Result<vault_types::Challenge> {
    let env = WikiVault::capture()?;
    let result = vault_service::begin_unlock(&env, request).await;
    env.finish(result)
}

#[ic_cdk::update]
async fn vault_derive_vault_key(
    request: vault_types::Derive,
) -> vault_types::Result<vault_types::KeyReply> {
    let env = WikiVault::capture()?;
    let result = vault_service::derive_vault_key(&env, request).await;
    env.finish(result)
}

#[ic_cdk::update]
fn vault_activate_vault(
    request: vault_types::Activate,
) -> vault_types::Result<vault_types::Header> {
    let env = WikiVault::capture()?;
    let result = vault_service::activate_vault(&env, request);
    env.finish(result)
}

#[ic_cdk::update]
fn vault_manage_unlock_credential(
    request: vault_types::ManageCredential,
) -> vault_types::Result<()> {
    let env = WikiVault::capture()?;
    let result = vault_service::manage_unlock_credential(&env, request);
    env.finish(result)
}

#[ic_cdk::update]
fn vault_prepare_unlock_credential(
    vault: vault_types::Id,
    registration: String,
) -> vault_types::Result<Vec<u8>> {
    let env = WikiVault::capture()?;
    let result = vault_service::prepare_unlock_credential(&env, vault, registration);
    env.finish(result)
}

#[ic_cdk::update]
fn vault_begin_revision(
    request: vault_types::BeginRevision,
) -> vault_types::Result<vault_types::Upload> {
    let env = WikiVault::capture()?;
    let result = vault_service::begin_revision(&env, request);
    env.finish(result)
}

#[ic_cdk::update]
fn vault_put_chunk(upload: vault_types::Id, index: u32, data: Vec<u8>) -> vault_types::Result<()> {
    let env = WikiVault::capture()?;
    let result = vault_service::put_chunk(&env, upload, index, data);
    env.finish(result)
}

#[ic_cdk::update]
fn vault_commit_revision(upload: vault_types::Id) -> vault_types::Result<vault_types::Revision> {
    let env = WikiVault::capture()?;
    let result = vault_service::commit_revision(&env, upload);
    env.finish(result)
}

#[ic_cdk::update]
fn vault_get_manifest(
    vault: vault_types::Id,
    object: vault_types::Id,
    revision: u64,
) -> vault_types::Result<vault_types::Revision> {
    let env = WikiVault::capture()?;
    let result = vault_service::get_manifest(&env, vault, object, revision);
    env.finish(result)
}

#[ic_cdk::update]
fn vault_get_chunk(
    vault: vault_types::Id,
    object: vault_types::Id,
    revision: u64,
    index: u32,
) -> vault_types::Result<Vec<u8>> {
    let env = WikiVault::capture()?;
    let result = vault_service::get_chunk(&env, vault, object, revision, index);
    env.finish(result)
}

#[ic_cdk::update]
fn vault_list_history(
    vault: vault_types::Id,
    object: vault_types::Id,
    before: u64,
) -> vault_types::Result<vault_types::RevisionPage> {
    let env = WikiVault::capture()?;
    let result = vault_service::list_history(&env, vault, object, before);
    env.finish(result)
}

#[ic_cdk::update]
fn vault_list_objects(
    vault: vault_types::Id,
    after: vault_types::Id,
) -> vault_types::Result<vault_types::ObjectPage> {
    let env = WikiVault::capture()?;
    let result = vault_service::list_objects(&env, vault, after);
    env.finish(result)
}

#[ic_cdk::update]
fn vault_get_quota(vault: vault_types::Id) -> vault_types::Result<vault_types::Quota> {
    let env = WikiVault::capture()?;
    let result = vault_service::get_quota(&env, vault);
    env.finish(result)
}

#[ic_cdk::update]
fn vault_delete_object(
    vault: vault_types::Id,
    object: vault_types::Id,
    expected_revision: u64,
    operation: vault_types::Id,
) -> vault_types::Result<vault_types::Revision> {
    let env = WikiVault::capture()?;
    let result = vault_service::delete_object(&env, vault, object, expected_revision, operation);
    env.finish(result)
}

#[ic_cdk::update]
fn vault_purge_object(vault: vault_types::Id, object: vault_types::Id) -> vault_types::Result<()> {
    let env = WikiVault::capture()?;
    let result = vault_service::purge_object(&env, vault, object);
    env.finish(result)
}

#[ic_cdk::update]
fn vault_collect_garbage() -> vault_types::Result<u64> {
    let env = WikiVault::capture()?;
    let result = vault_service::collect_garbage(&env);
    env.finish(result)
}

#[ic_cdk::update]
fn vault_begin_export(
    vault: vault_types::Id,
    export: vault_types::Id,
) -> vault_types::Result<vault_types::Export> {
    let env = WikiVault::capture()?;
    let result = vault_service::begin_export(&env, vault, export);
    env.finish(result)
}

#[ic_cdk::update]
fn vault_export_index(
    export: vault_types::Id,
    after: u64,
) -> vault_types::Result<vault_types::ExportPage> {
    let env = WikiVault::capture()?;
    let result = vault_service::export_index(&env, export, after);
    env.finish(result)
}

#[ic_cdk::update]
fn vault_get_export_chunk(
    export: vault_types::Id,
    object: vault_types::Id,
    revision: u64,
    index: u32,
) -> vault_types::Result<Vec<u8>> {
    let env = WikiVault::capture()?;
    let result = vault_service::get_export_chunk(&env, export, object, revision, index);
    env.finish(result)
}

#[ic_cdk::update]
fn vault_finish_export(
    export: vault_types::Id,
    saved: bool,
) -> vault_types::Result<vault_types::Header> {
    let env = WikiVault::capture()?;
    let result = vault_service::finish_export(&env, export, saved);
    env.finish(result)
}

#[ic_cdk::update]
fn vault_abort_export(export: vault_types::Id) -> vault_types::Result<vault_types::Header> {
    let env = WikiVault::capture()?;
    let result = vault_service::abort_export(&env, export);
    env.finish(result)
}

#[ic_cdk::update]
fn vault_begin_restore(
    request: vault_types::BeginRestore,
) -> vault_types::Result<vault_types::Header> {
    let env = WikiVault::capture()?;
    let result = vault_service::begin_restore(&env, request);
    env.finish(result)
}

#[ic_cdk::update]
fn vault_begin_restore_revision(
    vault: vault_types::Id,
    revision: vault_types::Revision,
    attempt: Option<vault_types::Id>,
) -> vault_types::Result<()> {
    let env = WikiVault::capture()?;
    let result = vault_service::begin_restore_revision(&env, vault, revision, attempt);
    env.finish(result)
}

#[ic_cdk::update]
fn vault_put_restore_chunk(
    vault: vault_types::Id,
    index: u32,
    data: Vec<u8>,
    attempt: Option<vault_types::Id>,
) -> vault_types::Result<()> {
    let env = WikiVault::capture()?;
    let result = vault_service::put_restore_chunk(&env, vault, index, data, attempt);
    env.finish(result)
}

#[ic_cdk::update]
fn vault_commit_restore_revision(
    vault: vault_types::Id,
    sequence: u64,
    attempt: Option<vault_types::Id>,
) -> vault_types::Result<vault_types::RestoreProgress> {
    let env = WikiVault::capture()?;
    let result = vault_service::commit_restore_revision(&env, vault, sequence, attempt);
    env.finish(result)
}

#[ic_cdk::update]
fn vault_commit_restore(
    request: vault_types::Activate,
) -> vault_types::Result<vault_types::Header> {
    let env = WikiVault::capture()?;
    let result = vault_service::commit_restore(&env, request);
    env.finish(result)
}

#[ic_cdk::update]
fn vault_get_active_export() -> vault_types::Result<Option<vault_types::Export>> {
    let env = WikiVault::capture()?;
    let result = vault_service::get_active_export(&env);
    env.finish(result)
}

#[ic_cdk::update]
fn vault_get_active_export_for_vault(
    vault: vault_types::Id,
) -> vault_types::Result<Option<vault_types::Export>> {
    let env = WikiVault::capture()?;
    let result = vault_service::get_active_export_for_vault(&env, vault);
    env.finish(result)
}

#[ic_cdk::update]
fn vault_cancel_pending_key_derivation() -> vault_types::Result<()> {
    let env = WikiVault::capture()?;
    let flight = with_service(|s| Ok(s.vault_cancel_pending_key_flight(env.owner, env.now())))
        .map_err(|_| Error::Storage)??;
    if let Some((token, actual, orphan)) = flight {
        with_service(|s| {
            s.vault_cancel_reserved_cycles(
                &env.owner().to_text(),
                &format!("derive:{token}"),
                actual,
                orphan,
                now_millis(),
            )
        })
        .map_err(|_| Error::Storage)?;
    }
    let challenges =
        with_service(|s| s.vault_recover_orphan_execution(&env.owner().to_text(), now_millis()))
            .map_err(|_| Error::Storage)?;
    with_service(|s| Ok(s.vault_clear_orphan_challenges(env.owner, &challenges)))
        .map_err(|_| Error::Storage)??;
    env.finish(Ok(()))
}
