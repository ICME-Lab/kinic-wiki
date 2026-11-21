//! Controller management and bounded calls for execution-cycle refills.
use super::*;
use vfs_types::{BEKKO_REFILL_CANISTER, BekkoRefillOutcome, VaultRefillStatus};

#[query]
pub(super) fn get_bekko_refill_state() -> Result<BekkoRefillState, String> {
    require_controller_caller()?;
    with_service(|svc| svc.bekko_refill_state())
}
#[update]
pub(super) fn configure_bekko_refill(config: BekkoRefillConfig) -> Result<(), String> {
    require_controller_caller()?;
    with_service(|svc| svc.configure_bekko_refill(config))
}
#[update]
pub(super) async fn check_bekko_refill() -> Result<BekkoRefillState, String> {
    require_controller_caller()?;
    run_bekko_refill().await?;
    with_service(|svc| svc.bekko_refill_state())
}
#[update]
fn reconcile_bekko_refill(
    id: u64,
    resolution: BekkoRefillResolution,
    evidence: String,
) -> Result<(), String> {
    require_controller_caller()?;
    with_service(|svc| svc.reconcile_bekko_refill(id, resolution, evidence, now_nanos()))
}

#[query]
fn get_vault_refill_state() -> VaultRefillStateResult {
    require_controller_caller()
        .and_then(|()| with_service(|svc| svc.vault_refill_state()))
        .into()
}

#[derive(CandidType)]
pub(super) enum VaultRefillStateResult {
    Ok(Option<Box<VaultRefillStatus>>),
    Err(String),
}

impl From<Result<Option<VaultRefillStatus>, String>> for VaultRefillStateResult {
    fn from(result: Result<Option<VaultRefillStatus>, String>) -> Self {
        match result {
            Ok(state) => Self::Ok(state.map(Box::new)),
            Err(error) => Self::Err(error),
        }
    }
}

#[update]
fn configure_vault_refill(config: VaultRefillConfig) -> Result<(), String> {
    require_controller_caller()?;
    #[cfg(target_arch = "wasm32")]
    if config.target == ic_cdk::api::canister_self() {
        return Err("Vault refill target must differ from Wiki".into());
    }
    with_service(|svc| svc.configure_vault_refill(config))
}

#[update]
async fn check_vault_refill() -> VaultRefillStateResult {
    async {
        require_controller_caller()?;
        run_vault_refill().await?;
        with_service(|svc| svc.vault_refill_state())
    }
    .await
    .into()
}

#[update]
fn reconcile_vault_refill(
    id: u64,
    resolution: BekkoRefillResolution,
    evidence: String,
) -> Result<(), String> {
    require_controller_caller()?;
    with_service(|svc| svc.reconcile_vault_refill(id, resolution, evidence, now_nanos()))
}

#[derive(Clone, Copy)]
enum RefillTarget {
    Bekko,
    Vault,
}

async fn run_bekko_refill() -> Result<(), String> {
    run_refill(RefillTarget::Bekko).await
}

async fn run_vault_refill() -> Result<(), String> {
    run_refill(RefillTarget::Vault).await
}

async fn run_refill(target: RefillTarget) -> Result<(), String> {
    let started = with_service(|svc| match target {
        RefillTarget::Bekko => Ok(svc.begin_bekko_refill(now_nanos())?.map(|attempt| {
            let canister =
                Principal::from_text(BEKKO_REFILL_CANISTER).expect("fixed Bekko principal");
            (canister, attempt)
        })),
        RefillTarget::Vault => svc.begin_vault_refill(now_nanos()),
    })?;
    let Some((canister, attempt)) = started else {
        return Ok(());
    };
    let finish = |outcome| {
        with_service(|svc| match target {
            RefillTarget::Bekko => svc.finish_bekko_refill(attempt.id, outcome, now_nanos()),
            RefillTarget::Vault => svc.finish_vault_refill(attempt.id, outcome, now_nanos()),
        })
    };
    let balance = match read_refill_balance(canister).await {
        Ok(balance) => balance,
        Err(error) => {
            return finish(BekkoRefillOutcome::Failed(format!(
                "balance unavailable; check for freezing and recover externally if necessary: {error}"
            )));
        }
    };
    // There is no await between these fresh balances, the persisted reservation, and the deposit.
    // CDK prepays the maximum response and callback cost. A fixed safety margin
    // alone cannot cover it, especially when the liquid balance is the binding cap.
    #[cfg(target_arch = "wasm32")]
    let call_reserve = refill_deposit_call(canister, 0).get_cost();
    #[cfg(not(target_arch = "wasm32"))]
    let call_reserve = 0;
    let wiki = canister_balance_cycles().saturating_sub(call_reserve);
    #[cfg(target_arch = "wasm32")]
    let liquid = ic_cdk::api::canister_liquid_cycle_balance().saturating_sub(call_reserve);
    #[cfg(not(target_arch = "wasm32"))]
    let liquid = wiki;
    let amount = with_service(|svc| match target {
        RefillTarget::Bekko => {
            svc.reserve_bekko_refill(attempt.id, balance, wiki, liquid, now_nanos())
        }
        RefillTarget::Vault => {
            svc.reserve_vault_refill(attempt.id, balance, wiki, liquid, now_nanos())
        }
    })?;
    if let Some(amount) = amount {
        let outcome = deposit_refill_cycles(canister, amount).await;
        finish(outcome)?;
    }
    Ok(())
}

#[cfg(target_arch = "wasm32")]
async fn read_refill_balance(canister: Principal) -> Result<u128, String> {
    let response = Call::bounded_wait(canister, "cycles_balance_for_wiki")
        .change_timeout(30)
        .await
        .map_err(|e| format!("balance call: {e:?}"))?;
    response
        .candid::<Result<u128, String>>()
        .map_err(|e| format!("balance decode: {e}"))?
}
#[cfg(not(target_arch = "wasm32"))]
async fn read_refill_balance(_canister: Principal) -> Result<u128, String> {
    Err("balance call requires Wasm".into())
}

#[cfg(target_arch = "wasm32")]
fn refill_deposit_call(canister: Principal, amount: u128) -> Call<'static, 'static> {
    #[derive(CandidType)]
    struct DepositArgs {
        canister_id: Principal,
    }
    Call::bounded_wait(Principal::management_canister(), "deposit_cycles")
        .with_arg(DepositArgs {
            canister_id: canister,
        })
        .with_cycles(amount)
        .change_timeout(30)
}

#[cfg(target_arch = "wasm32")]
async fn deposit_refill_cycles(canister: Principal, amount: u128) -> BekkoRefillOutcome {
    use ic_cdk::call::CallErrorExt;
    let result = refill_deposit_call(canister, amount).await;
    match result {
        Ok(response) => match response.candid::<()>() {
            Ok(()) => BekkoRefillOutcome::Succeeded,
            Err(error) => BekkoRefillOutcome::Unknown(format!("deposit response decode: {error}")),
        },
        Err(error) if error.is_clean_reject() => {
            BekkoRefillOutcome::Failed(format!("deposit rejected: {error:?}"))
        }
        Err(error) => BekkoRefillOutcome::Unknown(format!(
            "deposit outcome unknown; do not resend: {error:?}"
        )),
    }
}
#[cfg(not(target_arch = "wasm32"))]
async fn deposit_refill_cycles(_canister: Principal, _amount: u128) -> BekkoRefillOutcome {
    BekkoRefillOutcome::Failed("deposit requires Wasm".into())
}

// Self calls give billing and self-refill separate message/rollback boundaries.
// No additional recurring timer is created. Billing never waits for an external call.
#[cfg(target_arch = "wasm32")]
pub(super) async fn run_periodic_maintenance(bill_storage: bool) {
    let own = ic_cdk::api::canister_self();
    if bill_storage {
        if let Err(error) = Call::bounded_wait(own, "periodic_storage_billing").oneway() {
            ic_cdk::println!("storage billing dispatch failed: {error:?}");
        }
    }
    if let Err(error) = Call::bounded_wait(own, "periodic_cycles_refill")
        .change_timeout(60)
        .await
    {
        ic_cdk::println!("Wiki self-refill task failed: {error:?}");
    }
    match Call::bounded_wait(own, "periodic_bekko_refill")
        .change_timeout(90)
        .await
    {
        Ok(response) => match response.candid::<Result<(), String>>() {
            Ok(Ok(())) => {}
            Ok(Err(error)) => ic_cdk::println!("Bekko refill task failed: {error}"),
            Err(error) => ic_cdk::println!("Bekko refill response decode failed: {error}"),
        },
        Err(error) => ic_cdk::println!("Bekko refill self-call failed: {error:?}"),
    }
    if let Err(error) = run_vault_refill().await {
        ic_cdk::println!("Vault refill task failed: {error}");
    }
}

#[update]
async fn periodic_bekko_refill() -> Result<(), String> {
    require_self_caller()?;
    run_bekko_refill().await
}

#[update]
fn periodic_storage_billing() -> Result<(), String> {
    require_self_caller()?;
    #[cfg(target_arch = "wasm32")]
    run_storage_billing_timer_batches();
    Ok(())
}
#[update]
async fn periodic_cycles_refill() -> Result<(), String> {
    require_self_caller()?;
    #[cfg(target_arch = "wasm32")]
    run_cycles_top_up_check_from_timer().await;
    Ok(())
}
fn require_self_caller() -> Result<(), String> {
    #[cfg(target_arch = "wasm32")]
    if caller_principal() == ic_cdk::api::canister_self() {
        return Ok(());
    }
    Err("canister self-call only".into())
}
