//! Dedicated Vault API. The authenticated caller is always the data owner.
use super::{now_millis, with_service};
use candid::Principal;
use ic_cdk_management_canister as management;
use kinic_sqlite_compat::Connection;
use vault_service::runtime::Environment;
use vault_store::OwnerContext;
use vault_types::*;

struct Vault {
    owner: OwnerContext,
    started: u64,
    maintenance: bool,
    readonly: bool,
    derive_payment: std::cell::Cell<Option<u64>>,
    operation: std::cell::Cell<Option<(u64, bool)>>,
}
impl Vault {
    fn capture() -> Result<Self> {
        let owner = OwnerContext::authenticated(ic_cdk::api::msg_caller())?;
        Ok(Self {
            owner,
            started: meter(),
            maintenance: true,
            readonly: false,
            derive_payment: std::cell::Cell::new(None),
            operation: std::cell::Cell::new(None),
        })
    }
    fn capture_read() -> Result<Self> {
        let mut env = Self::capture_cleanup()?;
        env.readonly = true;
        Ok(env)
    }
    fn capture_cleanup() -> Result<Self> {
        let mut env = Self::capture()?;
        env.maintenance = false;
        Ok(env)
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
        if self.operation.get().is_none()
            && matches!(
                &result,
                Err(Error::Unauthorized | Error::InvalidProof | Error::Expired)
            )
        {
            return result;
        }
        let amount = self.execution_cycles();
        // Reserved completion remains chargeable after configuration changes and upgrades.
        if let Some(token) = self.operation_token() {
            with_service(|s| {
                s.vault_finish_execution(&self.owner().to_text(), &token, amount, now_millis())
            })
            .expect("Vault accounting failed");
        } else if crate::state::State.balance(&self.owner().to_text())? > 0 {
            with_service(|s| {
                s.vault_charge_execution(&self.owner().to_text(), amount, now_millis())
            })
            .expect("Vault accounting failed");
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
impl Environment for Vault {
    fn cleanup_existing_flights(
        &self,
        db: &Connection,
        targets: &[Id],
        cancel_live: bool,
    ) -> Result<bool> {
        crate::accounting::recover_pending_in(db, self.owner(), targets, cancel_live, self.now())
    }
    fn reconcile_key_gc(&self, db: &Connection, owners: &[Principal]) -> Result<()> {
        crate::accounting::reconcile_key_gc_in(db, self.owner(), owners, now_millis())
    }
    fn canister(&self) -> Principal {
        ic_cdk::api::canister_self()
    }
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
        crate::state::transaction(|db| {
            if self.maintenance {
                crate::accounting::maintain_expired_in(db, self.now())?;
            }
            self.owner.run(db, |db| {
                vault_store::config(db)?;
                let value = f(db)?;
                if self.readonly {
                    return Ok(value);
                }
                crate::accounting::track_storage_in(
                    db,
                    &self.owner().to_text(),
                    vault_store::content::usage(db)?,
                    now_millis(),
                )?;
                Ok(value)
            })
        })
    }

    fn settle_key_reservation(&self, token: u64, actual: u64) -> Result<bool> {
        settle_key_reservation_for_owner(self.owner, token, self.now(), actual)
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
        .map_err(|_| Error::Storage)
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
            context: KEY_CONTEXT_V2.to_vec(),
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
            context: KEY_CONTEXT_V2.to_vec(),
            key_id: key_id(name),
            transport_public_key: transport,
        })
        .await;
        self.derive_payment
            .set(Some(crate::key_cost::actual_payment(
                payment,
                &result,
                ic_cdk::api::msg_cycles_refunded,
            )));
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
fn set_config(config: Option<vault_types::VaultConfig>) -> vault_types::Result<()> {
    if !ic_cdk::api::is_controller(&ic_cdk::api::msg_caller()) {
        return Err(Error::Unauthorized);
    }
    with_service(|s| Ok(s.vault_set_config(config))).map_err(|_| Error::Storage)?
}
#[ic_cdk::update]
fn get_config() -> vault_types::Result<Option<vault_types::VaultConfig>> {
    // Public configuration contains no owner data and is required for exact RP/origin matching.
    OwnerContext::authenticated(ic_cdk::api::msg_caller())?;
    with_service(|s| Ok(s.vault_config())).map_err(|_| Error::Storage)?
}
#[ic_cdk::update]
fn reserve_vault(request: vault_types::Reserve) -> vault_types::Result<vault_types::Header> {
    let env = Vault::capture()?;
    let result = vault_service::reserve_vault(&env, request);
    env.finish(result)
}

#[ic_cdk::update]
fn list_unfinished_vaults() -> vault_types::Result<Vec<vault_types::UnfinishedVault>> {
    let env = Vault::capture()?;
    let result = vault_service::list_unfinished_vaults(&env);
    env.finish(result)
}

#[ic_cdk::update]
fn cancel_vault_setup(vault: vault_types::Id, attempt: vault_types::Id) -> vault_types::Result<()> {
    let env = Vault::capture()?;
    let result = vault_service::cancel_vault_setup(&env, vault, attempt);
    env.finish(result)
}

#[ic_cdk::update]
fn get_vault_header(vault: vault_types::Id) -> vault_types::Result<vault_types::Header> {
    let env = Vault::capture()?;
    let result = vault_service::get_vault_header(&env, vault);
    env.finish(result)
}

#[ic_cdk::update]
fn list_vaults() -> vault_types::Result<Vec<vault_types::Header>> {
    let env = Vault::capture()?;
    let result = vault_service::list_vaults(&env);
    env.finish(result)
}

#[ic_cdk::update]
fn list_credentials() -> vault_types::Result<Vec<vault_types::CredentialInfo>> {
    let env = Vault::capture()?;
    let result = vault_service::list_credentials(&env);
    env.finish(result)
}

#[ic_cdk::update]
async fn begin_unlock(
    request: vault_types::BeginUnlock,
) -> vault_types::Result<vault_types::Challenge> {
    let env = Vault::capture()?;
    let result = vault_service::begin_unlock(&env, request).await;
    env.finish(result)
}

#[ic_cdk::update]
async fn derive_vault_key(
    request: vault_types::Derive,
) -> vault_types::Result<vault_types::KeyReply> {
    let env = Vault::capture()?;
    let result = vault_service::derive_vault_key(&env, request).await;
    env.finish(result)
}

#[ic_cdk::update]
fn activate_vault(request: vault_types::Activate) -> vault_types::Result<vault_types::Header> {
    let env = Vault::capture()?;
    let result = vault_service::activate_vault(&env, request);
    env.finish(result)
}

#[ic_cdk::update]
fn manage_unlock_credential(request: vault_types::ManageCredential) -> vault_types::Result<()> {
    let env = Vault::capture()?;
    let result = vault_service::manage_unlock_credential(&env, request);
    env.finish(result)
}

#[ic_cdk::update]
fn prepare_unlock_credential(
    vault: vault_types::Id,
    registration: String,
) -> vault_types::Result<Vec<u8>> {
    let env = Vault::capture()?;
    let result = vault_service::prepare_unlock_credential(&env, vault, registration);
    env.finish(result)
}

#[ic_cdk::update]
fn begin_revision(request: vault_types::BeginRevision) -> vault_types::Result<vault_types::Upload> {
    let env = Vault::capture()?;
    let result = vault_service::begin_revision(&env, request);
    env.finish(result)
}

#[ic_cdk::update]
fn put_chunk(upload: vault_types::Id, index: u32, data: Vec<u8>) -> vault_types::Result<()> {
    let env = Vault::capture()?;
    let result = vault_service::put_chunk(&env, upload, index, data);
    env.finish(result)
}

#[ic_cdk::update]
fn commit_revision(upload: vault_types::Id) -> vault_types::Result<vault_types::Revision> {
    let env = Vault::capture()?;
    let result = vault_service::commit_revision(&env, upload);
    env.finish(result)
}

#[ic_cdk::update]
fn get_manifest(
    vault: vault_types::Id,
    object: vault_types::Id,
    revision: u64,
) -> vault_types::Result<vault_types::Revision> {
    let env = Vault::capture()?;
    let result = vault_service::get_manifest(&env, vault, object, revision);
    env.finish(result)
}

#[ic_cdk::update]
fn get_chunk(
    vault: vault_types::Id,
    object: vault_types::Id,
    revision: u64,
    index: u32,
) -> vault_types::Result<Vec<u8>> {
    let env = Vault::capture()?;
    let result = vault_service::get_chunk(&env, vault, object, revision, index);
    env.finish(result)
}

#[ic_cdk::update]
fn list_history(
    vault: vault_types::Id,
    object: vault_types::Id,
    before: u64,
) -> vault_types::Result<vault_types::RevisionPage> {
    let env = Vault::capture()?;
    let result = vault_service::list_history(&env, vault, object, before);
    env.finish(result)
}

#[ic_cdk::update]
fn list_objects(
    vault: vault_types::Id,
    after: vault_types::Id,
) -> vault_types::Result<vault_types::ObjectPage> {
    let env = Vault::capture()?;
    let result = vault_service::list_objects(&env, vault, after);
    env.finish(result)
}

#[ic_cdk::update]
fn get_quota(vault: vault_types::Id) -> vault_types::Result<vault_types::Quota> {
    let env = Vault::capture()?;
    let result = vault_service::get_quota(&env, vault);
    env.finish(result)
}

#[ic_cdk::update]
fn delete_object(
    vault: vault_types::Id,
    object: vault_types::Id,
    expected_revision: u64,
    operation: vault_types::Id,
) -> vault_types::Result<vault_types::Revision> {
    let env = Vault::capture()?;
    let result = vault_service::delete_object(&env, vault, object, expected_revision, operation);
    env.finish(result)
}

#[ic_cdk::update]
fn purge_object(vault: vault_types::Id, object: vault_types::Id) -> vault_types::Result<()> {
    let env = Vault::capture()?;
    let result = vault_service::purge_object(&env, vault, object);
    env.finish(result)
}

#[ic_cdk::update]
fn collect_garbage() -> vault_types::Result<u64> {
    let env = Vault::capture()?;
    let result = vault_service::collect_garbage(&env);
    env.finish(result)
}

#[ic_cdk::update]
fn begin_export(
    vault: vault_types::Id,
    export: vault_types::Id,
) -> vault_types::Result<vault_types::Export> {
    let env = Vault::capture()?;
    let result = vault_service::begin_export(&env, vault, export);
    env.finish(result)
}

#[ic_cdk::update]
fn export_index(
    export: vault_types::Id,
    after: u64,
) -> vault_types::Result<vault_types::ExportPage> {
    let env = Vault::capture()?;
    let result = vault_service::export_index(&env, export, after);
    env.finish(result)
}

#[ic_cdk::update]
fn get_export_chunk(
    export: vault_types::Id,
    object: vault_types::Id,
    revision: u64,
    index: u32,
) -> vault_types::Result<Vec<u8>> {
    let env = Vault::capture()?;
    let result = vault_service::get_export_chunk(&env, export, object, revision, index);
    env.finish(result)
}

#[ic_cdk::update]
fn finish_export(export: vault_types::Id, saved: bool) -> vault_types::Result<vault_types::Header> {
    let env = Vault::capture()?;
    let result = vault_service::finish_export(&env, export, saved);
    env.finish(result)
}

#[ic_cdk::update]
fn abort_export(export: vault_types::Id) -> vault_types::Result<vault_types::Header> {
    let env = Vault::capture()?;
    let result = vault_service::abort_export(&env, export);
    env.finish(result)
}

#[ic_cdk::update]
fn begin_restore(request: vault_types::BeginRestore) -> vault_types::Result<vault_types::Header> {
    let env = Vault::capture()?;
    let result = vault_service::begin_restore(&env, request);
    env.finish(result)
}

#[ic_cdk::update]
fn begin_restore_revision(
    vault: vault_types::Id,
    revision: vault_types::Revision,
    attempt: Option<vault_types::Id>,
) -> vault_types::Result<()> {
    let env = Vault::capture()?;
    let result = vault_service::begin_restore_revision(&env, vault, revision, attempt);
    env.finish(result)
}

#[ic_cdk::update]
fn put_restore_chunk(
    vault: vault_types::Id,
    index: u32,
    data: Vec<u8>,
    attempt: Option<vault_types::Id>,
) -> vault_types::Result<()> {
    let env = Vault::capture()?;
    let result = vault_service::put_restore_chunk(&env, vault, index, data, attempt);
    env.finish(result)
}

#[ic_cdk::update]
fn commit_restore_revision(
    vault: vault_types::Id,
    sequence: u64,
    attempt: Option<vault_types::Id>,
) -> vault_types::Result<vault_types::RestoreProgress> {
    let env = Vault::capture()?;
    let result = vault_service::commit_restore_revision(&env, vault, sequence, attempt);
    env.finish(result)
}

#[ic_cdk::update]
fn commit_restore(request: vault_types::Activate) -> vault_types::Result<vault_types::Header> {
    let env = Vault::capture()?;
    let result = vault_service::commit_restore(&env, request);
    env.finish(result)
}

#[ic_cdk::update]
fn get_active_export() -> vault_types::Result<Option<vault_types::Export>> {
    let env = Vault::capture()?;
    let result = vault_service::get_active_export(&env);
    env.finish(result)
}

#[ic_cdk::update]
fn get_active_export_for_vault(
    vault: vault_types::Id,
) -> vault_types::Result<Option<vault_types::Export>> {
    let env = Vault::capture()?;
    let result = vault_service::get_active_export_for_vault(&env, vault);
    env.finish(result)
}

#[ic_cdk::update]
fn cancel_pending_key_derivation() -> vault_types::Result<()> {
    let env = Vault::capture()?;
    let result = Err(Error::Unauthorized);
    env.finish(result)
}

#[ic_cdk::update]
async fn mutate(
    payload: Vec<u8>,
    signature: Vec<u8>,
) -> vault_types::Result<vault_types::MutationResult> {
    let env = Vault::capture_cleanup()?;
    let r = vault_service::mutations::mutate(&env, payload, signature).await;
    env.finish(r)
}
#[ic_cdk::update]
async fn bootstrap(
    request: vault_types::Bootstrap,
) -> vault_types::Result<vault_types::BootstrapReply> {
    let env = Vault::capture()?;
    let r = vault_service::generation::bootstrap(&env, request).await;
    env.finish(r)
}
#[ic_cdk::update]
fn register_bootstrap(
    attempt: vault_types::Id,
    registration: String,
) -> vault_types::Result<vault_types::GrantInfo> {
    let env = Vault::capture()?;
    let r = vault_service::generation::register(&env, attempt, registration);
    env.finish(r)
}
#[ic_cdk::update]
async fn begin_grant(
    request: vault_types::GrantRequest,
) -> vault_types::Result<vault_types::Challenge> {
    let env = Vault::capture()?;
    let r = vault_service::ceremonies::begin(&env, request).await;
    env.finish(r)
}
#[ic_cdk::update]
fn finish_grant(
    operation: vault_types::Id,
    proof: String,
) -> vault_types::Result<vault_types::GrantInfo> {
    let env = Vault::capture()?;
    let r = vault_service::ceremonies::finish(&env, operation, proof);
    env.finish(r)
}
#[ic_cdk::update]
fn begin_cleanup(
    request: vault_types::GrantRequest,
) -> vault_types::Result<vault_types::Challenge> {
    let env = Vault::capture_cleanup()?;
    let r = vault_service::cleanup::begin(&env, request);
    env.finish(r)
}
#[ic_cdk::update]
fn finish_cleanup(
    operation: vault_types::Id,
    proof: String,
) -> vault_types::Result<vault_types::GrantInfo> {
    let env = Vault::capture_cleanup()?;
    let r = vault_service::cleanup::finish(&env, operation, proof);
    env.finish(r)
}

#[ic_cdk::update]
fn cleanup_status() -> vault_types::Result<Option<vault_types::CleanupProgress>> {
    let env = Vault::capture()?;
    let r = vault_service::cleanup::status(&env);
    env.finish(r)
}

/// Aggregate capacity is public metadata; it never allocates an owner or account.
#[ic_cdk::query]
fn global_capacity() -> vault_types::Result<vault_types::GlobalCapacity> {
    crate::state::transaction(vault_store::content::global_capacity)
}

/// Release only an existing captured owner's callback token, even after config removal.
pub(crate) fn settle_key_reservation_for_owner(
    owner: OwnerContext,
    token: u64,
    now: u64,
    actual: u64,
) -> Result<bool> {
    crate::state::State.vault_settle_key_flight(owner, token, now, actual)
}

/// Owner-only encrypted status remains available when configuration is absent or incompatible.
#[ic_cdk::query]
fn incident_status() -> vault_types::Result<Option<vault_types::IncidentStatus>> {
    let owner = OwnerContext::authenticated(ic_cdk::api::msg_caller())?;
    crate::state::transaction(|db| owner.run(db, vault_store::incident::status))
}
#[ic_cdk::query]
fn incident_context() -> vault_types::Result<Option<vault_types::IncidentContext>> {
    let owner = OwnerContext::authenticated(ic_cdk::api::msg_caller())?;
    crate::state::transaction(|db| owner.run(db, vault_service::incident::context_in))
}

#[ic_cdk::query]
fn incident_source_index(
    job: vault_types::Id,
    vault: vault_types::Id,
    attempt: vault_types::Id,
    after: u64,
) -> vault_types::Result<vault_types::ExportPage> {
    let env = Vault::capture_read()?;
    vault_service::incident_wrapping::source_index(&env, job, vault, attempt, after)
}
#[ic_cdk::query]
fn incident_staged_export(
    request: vault_types::IncidentRead,
) -> vault_types::Result<vault_types::StagedExport> {
    let env = Vault::capture_read()?;
    vault_service::incident_export::descriptor(&env, request)
}
#[ic_cdk::query]
fn incident_staged_index(
    request: vault_types::IncidentRead,
    after: u64,
) -> vault_types::Result<vault_types::ExportPage> {
    let env = Vault::capture_read()?;
    vault_service::incident_export::index(&env, request, after)
}
#[ic_cdk::query]
fn incident_staged_chunk(
    request: vault_types::IncidentRead,
    object: vault_types::Id,
    revision: u64,
    index: u32,
) -> vault_types::Result<Vec<u8>> {
    let env = Vault::capture_read()?;
    vault_service::incident_export::chunk(&env, request, object, revision, index)
}
#[ic_cdk::query]
fn incident_cutover_digest() -> vault_types::Result<Vec<u8>> {
    let env = Vault::capture_read()?;
    vault_service::incident_cutover::ready_digest(&env)
}

#[ic_cdk::update]
async fn initialize_restore_namespace(operation: vault_types::Id) -> vault_types::Result<Vec<u8>> {
    let env = Vault::capture()?;
    let result = vault_service::restore_admission::initialize_namespace(&env, operation).await;
    env.finish(result)
}
#[ic_cdk::query]
fn restore_admission_status() -> vault_types::Result<Option<vault_types::RestoreAdmissionStatus>> {
    let env = Vault::capture_read()?;
    vault_service::restore_admission::status(&env)
}
#[ic_cdk::update]
fn begin_restore_admission(
    request: vault_types::RestoreAdmissionRequest,
) -> vault_types::Result<vault_types::Challenge> {
    let env = Vault::capture()?;
    let result = vault_service::restore_admission::begin(&env, request);
    env.finish(result)
}
#[ic_cdk::update]
fn register_restore_candidate(
    job: vault_types::Id,
    registration: String,
) -> vault_types::Result<vault_types::Challenge> {
    let env = Vault::capture()?;
    let result = vault_service::restore_admission::register(&env, job, registration);
    env.finish(result)
}
#[ic_cdk::update]
fn prove_restore_candidate(
    job: vault_types::Id,
    assertion: String,
) -> vault_types::Result<vault_types::RestoreAdmissionStatus> {
    let env = Vault::capture()?;
    let result = vault_service::restore_admission::possess(&env, job, assertion);
    env.finish(result)
}
#[ic_cdk::update]
fn prove_restore_current(
    job: vault_types::Id,
    signature: Vec<u8>,
) -> vault_types::Result<vault_types::RestoreAdmissionStatus> {
    let env = Vault::capture()?;
    let result = vault_service::restore_admission::prove_current(&env, job, signature);
    env.finish(result)
}
#[ic_cdk::update]
fn resume_restore_admission(job: vault_types::Id) -> vault_types::Result<vault_types::Challenge> {
    let env = Vault::capture()?;
    let result = vault_service::restore_admission::resume(&env, job);
    env.finish(result)
}
