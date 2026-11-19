//! Test-only canister: authenticated balance endpoint and a deposit relay which
//! pauses its response AFTER forwarding the attached cycles to management.
use candid::{CandidType, Principal};
use ic_cdk::{call::Call, update};
use serde::Deserialize;
use std::cell::Cell;

thread_local! {
    static DELAY_BALANCE: Cell<bool> = const { Cell::new(false) };
    static DELAY_DEPOSIT: Cell<bool> = const { Cell::new(false) };
}
fn wiki() -> Principal {
    Principal::from_text("6emaw-iyaaa-aaaay-aacka-cai").unwrap()
}
fn require_wiki() {
    assert_eq!(ic_cdk::api::msg_caller(), wiki());
}
#[update]
fn set_delays(balance: bool, deposit: bool) {
    assert!(ic_cdk::api::is_controller(&ic_cdk::api::msg_caller()));
    DELAY_BALANCE.set(balance);
    DELAY_DEPOSIT.set(deposit);
}
// Omitting the optional transform field is valid Candid record subtyping.
#[derive(CandidType)]
struct HttpArgs {
    url: String,
    max_response_bytes: Option<u64>,
    method: HttpMethod,
    headers: Vec<Header>,
    body: Option<Vec<u8>>,
}
#[derive(CandidType)]
#[allow(non_camel_case_types)]
enum HttpMethod {
    get,
}
#[derive(CandidType)]
struct Header {
    name: String,
    value: String,
}
async fn hold_response(stage: &str) {
    Call::unbounded_wait(Principal::management_canister(), "http_request")
        .with_arg(HttpArgs {
            url: format!("https://refill-fault.invalid/{stage}"),
            max_response_bytes: Some(1000),
            method: HttpMethod::get,
            headers: vec![],
            body: None,
        })
        .with_cycles(30_000_000_000)
        .await
        .expect("test runner must release the held HTTP response");
}
#[update]
async fn cycles_balance_for_wiki() -> Result<u128, String> {
    require_wiki();
    if DELAY_BALANCE.get() {
        hold_response("balance").await;
    }
    Ok(ic_cdk::api::canister_cycle_balance())
}
#[derive(CandidType, Deserialize)]
struct DepositArgs {
    canister_id: Principal,
}
#[update]
async fn deposit_cycles(args: DepositArgs) {
    require_wiki();
    assert_eq!(
        args.canister_id,
        Principal::from_text("xrg4h-oiaaa-aaaal-qxrya-cai").unwrap()
    );
    let amount = ic_cdk::api::msg_cycles_accept(ic_cdk::api::msg_cycles_available());
    Call::unbounded_wait(Principal::management_canister(), "deposit_cycles")
        .with_arg(args)
        .with_cycles(amount)
        .await
        .expect("real management deposit");
    if DELAY_DEPOSIT.get() {
        hold_response("deposit").await;
    }
}
