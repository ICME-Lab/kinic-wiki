use candid::CandidType;
use serde::{Deserialize, Serialize};

pub const BEKKO_REFILL_CANISTER: &str = "xrg4h-oiaaa-aaaal-qxrya-cai";
pub const BEKKO_REFILL_DAY_NS: u64 = 86_400_000_000_000;
/// Leave liquid cycles for call fees and callback execution in addition to the reserve.
pub const BEKKO_REFILL_FEE_MARGIN: u128 = 1_000_000_000;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct BekkoRefillConfig {
    pub enabled: bool,
    pub threshold_cycles: u128,
    pub target_cycles: u128,
    pub max_transfer_cycles: u128,
    pub max_daily_cycles: u128,
    pub wiki_reserve_cycles: u128,
}
impl Default for BekkoRefillConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            threshold_cycles: 600_000_000_000,
            target_cycles: 1_200_000_000_000,
            max_transfer_cycles: 600_000_000_000,
            max_daily_cycles: 1_200_000_000_000,
            wiki_reserve_cycles: 4_000_000_000_000,
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub enum BekkoRefillOutcome {
    Checking,
    Depositing,
    Succeeded,
    Sufficient,
    ConfigChanged,
    WikiReserve,
    DailyLimit,
    Interrupted,
    Failed(String),
    Unknown(String),
    Reconciled(BekkoRefillReconciliation),
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct BekkoRefillAttempt {
    pub id: u64,
    pub config_revision: u64,
    pub started_ns: u64,
    pub finished_ns: Option<u64>,
    pub observed_bekko_cycles: Option<u128>,
    pub amount_cycles: u128,
    pub outcome: BekkoRefillOutcome,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct BekkoRefillReservation {
    pub sent_ns: u64,
    pub amount_cycles: u128,
}
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct BekkoRefillState {
    pub config: BekkoRefillConfig,
    pub config_revision: u64,
    pub next_id: u64,
    pub active: Option<BekkoRefillAttempt>,
    pub history: Vec<BekkoRefillAttempt>,
    /// Rolling 24-hour attempted amounts, independent of the bounded audit history.
    pub reservations: Vec<BekkoRefillReservation>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub enum BekkoRefillResolution {
    Deposited,
    NotDeposited,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct BekkoRefillReconciliation {
    pub deposited: bool,
    pub evidence: String,
}
