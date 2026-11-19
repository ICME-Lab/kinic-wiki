//! Owner endpoints bind storage to the caller. Team endpoints resolve a specific vault first.
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
        Ok(Self::new(owner, meter()))
    }
    fn new(owner: OwnerContext, started: u64) -> Self {
        Self {
            owner,
            started,
            maintenance: true,
            readonly: false,
            derive_payment: std::cell::Cell::new(None),
            operation: std::cell::Cell::new(None),
        }
    }
    fn scoped(caller: Principal, vault: &[u8], readonly: bool) -> Result<(Self, VaultAccess)> {
        let started = meter();
        let access =
            crate::state::transaction(|db| vault_store::sharing::access(db, caller, vault))?;
        let mut env = Self::new(OwnerContext::authenticated(access.owner)?, started);
        env.readonly = readonly;
        env.maintenance = false;
        Ok((env, access))
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
    crate::state::transaction(|db| {
        let mut capacity = vault_store::content::global_capacity(db)?;
        let accounting = crate::capacity::accounting_reserved(db)?;
        capacity.used = capacity
            .used
            .checked_add(accounting)
            .ok_or(Error::Storage)?;
        capacity.accounting_reserved = capacity
            .accounting_reserved
            .checked_add(accounting)
            .ok_or(Error::Storage)?;
        Ok(capacity)
    })
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

// All shared endpoints are updates so revocation is ordered with subsequent
// reads. Clients must recheck access even when they already hold a cached root.
#[ic_cdk::update]
fn get_vault_access(vault: Id) -> Result<VaultAccess> {
    let (env, access) = Vault::scoped(ic_cdk::api::msg_caller(), &vault, true)?;
    env.finish(Ok(access))
}
#[ic_cdk::update]
fn list_accessible_vaults(after: Id) -> Result<VaultAccessPage> {
    let env = Vault::capture_read()?;
    let page =
        crate::state::transaction(|db| vault_store::sharing::accessible(db, env.owner(), &after))?;
    charge_access_page(&page, env.execution_cycles(), now_millis())?;
    Ok(page)
}
// Each returned vault pays its share, including when a member has no account.
// Empty pages neither expose another principal nor create account records.
fn charge_access_page(page: &VaultAccessPage, amount: u64, now: i64) -> Result<()> {
    let n = page.entries.len() as u64;
    if n == 0 {
        return Ok(());
    }
    let mut charges = std::collections::BTreeMap::new();
    for (index, access) in page.entries.iter().enumerate() {
        *charges.entry(access.owner).or_insert(0) +=
            amount / n + u64::from((index as u64) < amount % n);
    }
    crate::state::transaction(|db| {
        for (owner, charge) in charges {
            crate::accounting::charge_read_in(db, &owner.to_text(), charge, now)?;
        }
        Ok(())
    })
}
fn scoped_read<T>(
    vault: &[u8],
    read: impl FnOnce(&Connection, Principal, &[u8]) -> Result<T>,
) -> Result<T> {
    let caller = ic_cdk::api::msg_caller();
    let (env, _) = Vault::scoped(caller, vault, true)?;
    env.read(now_millis(), |db| read(db, caller, vault))
}
#[ic_cdk::update]
fn shared_list_objects(vault: Id, after: Id) -> Result<ObjectPage> {
    scoped_read(&vault, |db, _, v| {
        vault_store::content::objects(db, v, &after)
    })
}
#[ic_cdk::update]
fn shared_get_manifest(vault: Id, object: Id, revision: u64) -> Result<Revision> {
    scoped_read(&vault, |db, _, v| {
        vault_store::content::manifest(db, v, &object, revision)
    })
}
#[ic_cdk::update]
fn shared_get_chunk(vault: Id, object: Id, revision: u64, index: u32) -> Result<Vec<u8>> {
    scoped_read(&vault, |db, _, v| {
        vault_store::content::chunk(db, v, &object, revision, index)
    })
}
#[ic_cdk::update]
fn shared_list_history(vault: Id, object: Id, before: u64) -> Result<RevisionPage> {
    scoped_read(&vault, |db, _, v| {
        vault_store::content::history(db, v, &object, before)
    })
}
#[ic_cdk::update]
fn shared_get_quota(vault: Id) -> Result<Quota> {
    scoped_read(&vault, |db, _, v| vault_store::content::vault_quota(db, v))
}
#[ic_cdk::update]
fn shared_list_pending_uploads(vault: Id, after: Id) -> Result<PendingUploads> {
    scoped_read(&vault, |db, caller, v| {
        vault_store::sharing::pending_uploads(db, caller, v, &after)
    })
}
#[ic_cdk::update]
fn shared_get_upload_status(vault: Id, upload: Id) -> Result<UploadStatus> {
    scoped_read(&vault, |db, caller, v| {
        vault_store::sharing::upload_status(
            db,
            caller,
            v,
            &upload,
            super::now_nanos() / 1_000_000_000,
        )
    })
}
#[ic_cdk::update]
fn shared_mutate(vault: Id, request: Mutation) -> Result<MutationResult> {
    let caller = ic_cdk::api::msg_caller();
    let (env, _) = Vault::scoped(caller, &vault, false)?;
    env.finish(vault_service::shared_mutate(&env, caller, &vault, request))
}
#[ic_cdk::update]
async fn shared_derive_vault_key(request: DeriveKey) -> Result<KeyReply> {
    let caller = ic_cdk::api::msg_caller();
    let (env, _) = Vault::scoped(caller, &request.vault, false)?;
    env.finish(vault_service::shared_derive_vault_key(&env, caller, request).await)
}
#[ic_cdk::update]
fn list_vault_members(vault: Id) -> Result<Vec<VaultMember>> {
    scoped_read(&vault, vault_store::sharing::members)
}
#[ic_cdk::update]
fn set_vault_member(vault: Id, member: Principal, role: AccessRole) -> Result<()> {
    let caller = ic_cdk::api::msg_caller();
    let (env, access) = Vault::scoped(caller, &vault, false)?;
    if access.role != AccessRole::Owner {
        return Err(Error::Unauthorized);
    }
    let result = env.require_spending().and_then(|_| {
        env.transaction(|db| vault_store::sharing::set_member(db, caller, &vault, member, role))
    });
    env.finish(result)
}
#[ic_cdk::update]
fn remove_vault_member(vault: Id, member: Principal) -> Result<()> {
    let caller = ic_cdk::api::msg_caller();
    let (env, _) = Vault::scoped(caller, &vault, false)?;
    env.finish(
        env.transaction(|db| vault_store::sharing::remove_member(db, caller, &vault, member)),
    )
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
                "INSERT INTO accounts(owner,balance_cycles,storage_bytes,storage_charged_at_ms) VALUES(?1,100000000,0,0)",
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

#[cfg(test)]
mod team_billing_tests {
    use super::*;
    #[test]
    fn scoped_reads_charge_the_recorded_owner_and_deny_other_vaults() {
        crate::state::initialize().unwrap();
        let owner = Principal::from_slice(&[45]);
        let member = Principal::from_slice(&[46]);
        let h = Header {
            name: None,
            id: vec![42; 16],
            nonce: vec![2; 32],
            state: VaultState::Active,
            sequence: 0,
            key_name: "k".into(),
            public_key: vec![],
        };
        crate::state::transaction(|db|{
            for principal in [owner,member]{db.execute("INSERT INTO accounts(owner,balance_cycles,storage_charged_at_ms) VALUES(?1,100000000,0)",kinic_sqlite_compat::params![principal.to_text()]).unwrap();}
            db.execute("INSERT INTO vaults(owner,id,operation,header) VALUES(?1,?2,?3,?4)",kinic_sqlite_compat::params![owner.as_slice(),h.id,vec![3u8;16],serde_json::to_string(&h).unwrap()]).unwrap();
            OwnerContext::authenticated(owner)?.run(db,|db|vault_store::sharing::set_member(db,owner,&h.id,member,AccessRole::Viewer))
        }).unwrap();
        let (env, access) = Vault::scoped(member, &h.id, true).unwrap();
        assert_eq!(access.owner, owner);
        env.read(1, |db| vault_store::content::objects(db, &h.id, &[]))
            .unwrap();
        assert!(matches!(
            Vault::scoped(member, &[41; 16], true),
            Err(Error::Unauthorized)
        ));
        assert_eq!(
            crate::state::State.balance(&owner.to_text()).unwrap(),
            80_000_000
        );
        assert_eq!(
            crate::state::State.balance(&member.to_text()).unwrap(),
            100_000_000
        );
        let page =
            crate::state::transaction(|db| vault_store::sharing::accessible(db, member, &[]))
                .unwrap();
        charge_access_page(&page, 20_000_000, 2).unwrap();
        assert_eq!(
            crate::state::State.balance(&owner.to_text()).unwrap(),
            60_000_000
        );
        assert_eq!(
            crate::state::State.balance(&member.to_text()).unwrap(),
            100_000_000
        );
    }

    #[test]
    fn shared_key_settles_recorded_owner_subsidy_after_member_revocation() {
        use crate::state::{self, State};
        use kinic_sqlite_compat::params;
        state::initialize().unwrap();
        let owner = Principal::from_slice(&[45]);
        let member = Principal::from_slice(&[46]);
        let account = State.initialize_account(owner, 0).unwrap();
        let h = Header {
            id: vec![42; 16],
            name: None,
            nonce: vec![2; 32],
            state: VaultState::Active,
            sequence: 0,
            key_name: "k".into(),
            public_key: vec![],
        };
        state::transaction(|db| {
            db.execute(
                "INSERT INTO vaults(owner,id,operation,header) VALUES(?1,?2,?3,?4)",
                params![
                    owner.as_slice(),
                    h.id,
                    vec![3u8; 16],
                    serde_json::to_string(&h).unwrap()
                ],
            )
            .unwrap();
            OwnerContext::authenticated(owner)?.run(db, |db| {
                vault_store::sharing::set_member(db, owner, &h.id, member, AccessRole::Viewer)
            })
        })
        .unwrap();
        let (env, _) = Vault::scoped(member, &h.id, false).unwrap();
        let fee = 26_153_846_153;
        let execution = 20_000_000;
        state::transaction(|db| {
            env.owner
                .run(db, |db| vault_store::keys::reserve(db, &h.id, 1, 1, fee))
        })
        .unwrap();
        State
            .vault_reserve_cycles(&env.owner().to_text(), "derive:1", fee + execution, 1000)
            .unwrap();
        state::transaction(|db| {
            env.owner.run(db, |db| {
                vault_store::keys::mark_sent(db, 1, fee)?;
                vault_store::sharing::remove_member(db, owner, &h.id, member)
            })
        })
        .unwrap();

        settle_key_reservation_for_owner(env.owner, 1, 2, fee).unwrap();
        State
            .vault_reconcile_refunded_cycles(&env.owner().to_text(), "derive:1", fee, 2000)
            .unwrap();
        env.operation.set(Some(1));
        assert_eq!(
            env.finish_at::<()>(Err(Error::Unauthorized), 2000),
            Err(Error::Unauthorized)
        );
        assert!(matches!(
            Vault::scoped(member, &h.id, true),
            Err(Error::Unauthorized)
        ));
        assert_eq!(
            State.balance(&owner.to_text()).unwrap(),
            account.balance - execution
        );
        state::transaction(|db| {
            assert!(!crate::key_subsidy::available_in(db, &owner.to_text())?);
            assert_eq!(
                db.query_row(
                    "SELECT count(*) FROM accounts WHERE owner=?1",
                    [member.to_text()],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
                0
            );
            Ok(())
        })
        .unwrap();
    }
}
