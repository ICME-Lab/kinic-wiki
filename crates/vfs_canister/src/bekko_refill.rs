//! Controller management and bounded calls for execution-cycle refills.
use super::*;
#[cfg(target_arch = "wasm32")]
use vfs_types::BEKKO_REFILL_CANISTER;
use vfs_types::{BekkoRefillConfig, BekkoRefillOutcome, BekkoRefillResolution, BekkoRefillState};

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

async fn run_bekko_refill() -> Result<(), String> {
    let Some(attempt) = with_service(|svc| svc.begin_bekko_refill(now_nanos()))? else {
        return Ok(());
    };
    let balance = match read_bekko_balance().await {
        Ok(balance) => balance,
        Err(error) => {
            return with_service(|svc| {
                svc.finish_bekko_refill(attempt.id,
                BekkoRefillOutcome::Failed(format!("balance unavailable; check for freezing and recover externally if necessary: {error}")), now_nanos())
            });
        }
    };
    // There is no await between these fresh balances, the persisted reservation, and the deposit.
    let wiki = canister_balance_cycles();
    #[cfg(target_arch = "wasm32")]
    let liquid = ic_cdk::api::canister_liquid_cycle_balance();
    #[cfg(not(target_arch = "wasm32"))]
    let liquid = wiki;
    let amount = with_service(|svc| {
        svc.reserve_bekko_refill(attempt.id, balance, wiki, liquid, now_nanos())
    })?;
    if let Some(amount) = amount {
        let outcome = deposit_bekko_cycles(amount).await;
        with_service(|svc| svc.finish_bekko_refill(attempt.id, outcome, now_nanos()))?;
    }
    Ok(())
}

#[cfg(target_arch = "wasm32")]
async fn read_bekko_balance() -> Result<u128, String> {
    let response = Call::bounded_wait(
        Principal::from_text(BEKKO_REFILL_CANISTER).expect("fixed Bekko principal"),
        "cycles_balance_for_wiki",
    )
    .change_timeout(30)
    .await
    .map_err(|e| format!("balance call: {e:?}"))?;
    response
        .candid::<Result<u128, String>>()
        .map_err(|e| format!("balance decode: {e}"))?
}
#[cfg(not(target_arch = "wasm32"))]
async fn read_bekko_balance() -> Result<u128, String> {
    Err("balance call requires Wasm".into())
}

#[cfg(target_arch = "wasm32")]
async fn deposit_bekko_cycles(amount: u128) -> BekkoRefillOutcome {
    use ic_cdk::call::CallErrorExt;
    #[derive(CandidType)]
    struct DepositArgs {
        canister_id: Principal,
    }
    let result = Call::bounded_wait(Principal::management_canister(), "deposit_cycles")
        .with_arg(DepositArgs {
            canister_id: Principal::from_text(BEKKO_REFILL_CANISTER)
                .expect("fixed Bekko principal"),
        })
        .with_cycles(amount)
        .change_timeout(30)
        .await;
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
async fn deposit_bekko_cycles(_amount: u128) -> BekkoRefillOutcome {
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
    if let Err(error) = run_bekko_refill().await {
        ic_cdk::println!("Bekko refill task failed: {error}");
    }
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
