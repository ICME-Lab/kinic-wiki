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
    operation: std::cell::Cell<Option<u64>>,
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
        self.operation.get().map(|token| format!("derive:{token}"))
    }
    fn read<T>(&self, now: i64, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        let result = self.transaction(f);
        self.finish_at(result, now)
    }
    fn finish<T>(&self, result: Result<T>) -> Result<T> {
        self.finish_at(result, now_millis())
    }
    fn finish_at<T>(&self, result: Result<T>, now: i64) -> Result<T> {
        if self.operation.get().is_none()
            && matches!(&result, Err(Error::Unauthorized | Error::Expired))
        {
            return result;
        }
        let amount = self.execution_cycles();
        // Reserved completion remains chargeable after configuration changes and upgrades.
        if let Some(token) = self.operation_token() {
            with_service(|s| {
                s.vault_finish_execution(&self.owner().to_text(), &token, amount, now)
            })
            .expect("Vault accounting failed");
        } else if crate::state::State.balance(&self.owner().to_text())? > 0 {
            with_service(|s| s.vault_charge_execution(&self.owner().to_text(), amount, now))
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
    fn recover_pending(&self, db: &Connection, target: Option<&[u8]>) -> Result<bool> {
        crate::accounting::recover_pending_in(db, self.owner(), target, self.now())
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
    fn transaction<T>(&self, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        crate::state::transaction(|db| {
            if self.maintenance {
                crate::accounting::maintain_expired_in(db, self.now())?;
            }
            self.owner.run(db, |db| {
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
        if ic_cdk::api::canister_cycle_balance() < config.minimum_cycles as u128 {
            return Err(Error::QuotaExceeded);
        }
        with_service(|s| s.vault_require_spending(&self.owner().to_text(), now_millis()))
            .map_err(|_| Error::QuotaExceeded)
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
        self.operation.set(Some(token));
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
            context: KEY_CONTEXT.to_vec(),
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
            context: KEY_CONTEXT.to_vec(),
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
fn set_config(config: Option<VaultConfig>) -> Result<()> {
    if !ic_cdk::api::is_controller(&ic_cdk::api::msg_caller()) {
        return Err(Error::Unauthorized);
    }
    crate::state::State.vault_set_config(config)
}
#[ic_cdk::update]
fn get_config() -> Result<Option<VaultConfig>> {
    OwnerContext::authenticated(ic_cdk::api::msg_caller())?;
    crate::state::State.vault_config()
}
#[ic_cdk::update]
async fn create_vault(request: CreateVault) -> Result<Header> {
    let env = Vault::capture()?;
    let result = vault_service::create_vault(&env, request).await;
    env.finish(result)
}
#[ic_cdk::update]
async fn derive_vault_key(request: DeriveKey) -> Result<KeyReply> {
    let env = Vault::capture()?;
    let result = vault_service::derive_vault_key(&env, request).await;
    env.finish(result)
}
#[ic_cdk::update]
fn mutate(request: Mutation) -> Result<MutationResult> {
    let env = Vault::capture_cleanup()?;
    let result = vault_service::mutate(&env, request);
    env.finish(result)
}
#[ic_cdk::query]
fn global_capacity() -> Result<GlobalCapacity> {
    crate::state::transaction(vault_store::content::global_capacity)
}
pub(crate) fn settle_key_reservation_for_owner(
    owner: OwnerContext,
    token: u64,
    now: u64,
    actual: u64,
) -> Result<bool> {
    crate::state::State.vault_settle_key_flight(owner, token, now, actual)
}
#[ic_cdk::update]
fn list_vaults() -> Result<Vec<Header>> {
    let env = Vault::capture_read()?;
    env.read(now_millis(), vault_store::list)
}
#[ic_cdk::update]
fn get_vault_header(vault: Id) -> Result<Header> {
    let env = Vault::capture_read()?;
    env.read(now_millis(), |db| vault_store::header(db, &vault))
}
#[ic_cdk::update]
fn list_objects(vault: Id, after: Id) -> Result<ObjectPage> {
    let env = Vault::capture_read()?;
    env.read(now_millis(), |db| {
        vault_store::content::objects(db, &vault, &after)
    })
}
#[ic_cdk::update]
fn get_manifest(vault: Id, object: Id, revision: u64) -> Result<Revision> {
    let env = Vault::capture_read()?;
    env.read(now_millis(), |db| {
        vault_store::content::manifest(db, &vault, &object, revision)
    })
}
#[ic_cdk::update]
fn get_chunk(vault: Id, object: Id, revision: u64, index: u32) -> Result<Vec<u8>> {
    let env = Vault::capture_read()?;
    env.read(now_millis(), |db| {
        vault_store::content::chunk(db, &vault, &object, revision, index)
    })
}
#[ic_cdk::update]
fn list_history(vault: Id, object: Id, before: u64) -> Result<RevisionPage> {
    let env = Vault::capture_read()?;
    env.read(now_millis(), |db| {
        vault_store::content::history(db, &vault, &object, before)
    })
}
#[ic_cdk::update]
fn get_quota(vault: Id) -> Result<Quota> {
    let env = Vault::capture_read()?;
    env.read(now_millis(), |db| vault_store::content::quota(db, &vault))
}
#[ic_cdk::update]
fn list_pending_uploads(after: Id) -> Result<PendingUploads> {
    let env = Vault::capture_read()?;
    env.read(now_millis(), |db| {
        vault_store::content::pending_uploads(db, &after)
    })
}
#[ic_cdk::update]
fn get_upload_status(upload: Id) -> Result<UploadStatus> {
    let env = Vault::capture_read()?;
    env.read(now_millis(), |db| {
        vault_store::content::upload_status(db, &upload, env.now())
    })
}

#[cfg(test)]
mod read_accounting_tests {
    use super::*;
    #[test]
    fn private_reads_charge_positive_balance_and_allow_unfunded_without_allocation() {
        crate::state::initialize().unwrap();
        let owner = Principal::from_slice(&[41]);
        crate::state::transaction(|db| {
            db.execute(
                "INSERT INTO accounts VALUES(?1,100000000,0,0)",
                kinic_sqlite_compat::params![owner.to_text()],
            )
            .unwrap();
            Ok(())
        })
        .unwrap();
        let env = Vault {
            owner: OwnerContext::authenticated(owner).unwrap(),
            started: 0,
            maintenance: false,
            readonly: true,
            derive_payment: std::cell::Cell::new(None),
            operation: std::cell::Cell::new(None),
        };
        assert!(env.read(1, vault_store::list).unwrap().is_empty());
        assert_eq!(
            crate::state::State.balance(&owner.to_text()).unwrap(),
            80_000_000
        );
        let other = Principal::from_slice(&[42]);
        let env = Vault {
            owner: OwnerContext::authenticated(other).unwrap(),
            ..env
        };
        assert!(env.read(2, vault_store::list).unwrap().is_empty());
        crate::state::transaction(|db| {
            assert_eq!(
                db.query_row("SELECT count(*) FROM accounts", [], |r| r.get::<_, i64>(0))
                    .unwrap(),
                1
            );
            Ok(())
        })
        .unwrap();
    }
}
