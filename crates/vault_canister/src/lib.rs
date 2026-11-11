mod accounting;
mod api;
mod capacity;
mod funding;
mod http;
mod key_cost;
mod schema;
mod state;
const UPDATE_EXECUTION_BASE_CYCLES: u128 = 5_000_000;
const UPDATE_ACCOUNTING_OVERHEAD_CYCLES: u128 = 15_000_000;
fn now_nanos() -> u64 {
    ic_cdk::api::time()
}
fn now_millis() -> i64 {
    (now_nanos() / 1_000_000) as i64
}
fn with_service<T>(f: impl FnOnce(&state::State) -> Result<T, String>) -> Result<T, String> {
    f(&state::State)
}
fn initialize() {
    state::initialize().expect("Vault initialization failed");
    http::initialize();
    ic_cdk_timers::set_timer_interval(std::time::Duration::from_secs(60), || async {
        state::State
            .vault_settle_storage_timer_batch(now_millis())
            .expect("Vault maintenance failed")
    });
}
#[ic_cdk::init]
fn init() {
    initialize()
}
#[ic_cdk::post_upgrade]
fn post_upgrade() {
    initialize()
}
use funding::{FundingConfig, Payment, PurchaseRequest};
use http::{HttpRequest, HttpResponse};
ic_cdk::export_candid!();
#[test]
fn candid_contract_matches() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/vault.did");
    if std::env::var_os("WRITE_VAULT_DID").is_some() {
        std::fs::write(path, __export_service()).unwrap();
    } else {
        assert_eq!(std::fs::read_to_string(path).unwrap(), __export_service());
    }
}

#[cfg(test)]
mod capacity_tests;
#[cfg(test)]
mod tests;
