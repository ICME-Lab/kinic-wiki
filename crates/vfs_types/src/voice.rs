use candid::CandidType;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct VoiceRate {
    pub version: u64,
    pub cycles_per_minute: u64,
    pub authority: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct VoicePolicy {
    pub database_id: String,
    pub principal: String,
    pub enabled: bool,
    pub daily_budget_cycles: u64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct VoiceReserveRequest {
    pub session_id: String,
    pub database_id: String,
    pub principal: String,
    pub rate_version: u64,
    pub reserved_seconds: u64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct VoiceSettleRequest {
    pub session_id: String,
    pub confirmed_seconds: u64,
    pub close: bool,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct VoiceStopRequest {
    pub session_id: String,
    pub final_seconds: u64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct VoiceReservation {
    pub session_id: String,
    pub database_id: String,
    pub principal: String,
    pub rate_version: u64,
    pub cycles_per_minute: u64,
    pub usage_day: i64,
    pub created_at_ms: i64,
    pub expires_at_ms: i64,
    pub reserved_seconds: u64,
    pub confirmed_seconds: u64,
    pub held_cycles: u64,
    pub charged_cycles: u64,
    pub closed: bool,
    pub stopped_seconds: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct VoiceAccess {
    pub policy: VoicePolicy,
    pub rate: VoiceRate,
    pub remaining_cycles: u64,
    pub balance_cycles: u64,
}
