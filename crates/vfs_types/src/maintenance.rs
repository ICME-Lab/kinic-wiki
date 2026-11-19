//! Additive controller-only evidence rebuild contracts.
use candid::CandidType;
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct EvidenceRebuildRequest {
    pub database_id: String,
    pub expected_source_mount: u16,
    pub expected_schema: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct EvidenceRebuildStepRequest {
    pub database_id: String,
    pub migration_id: String,
    pub expected_step: u64,
    pub max_rows: u32,
    pub max_bytes: u32,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct EvidenceRebuildControlRequest {
    pub database_id: String,
    pub migration_id: String,
    pub expected_state_hash: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct EvidenceRebuildStatus {
    pub database_id: String,
    pub migration_id: String,
    pub phase: String,
    pub step: u64,
    pub state_hash: String,
    pub source_mount: u16,
    pub target_mount: u16,
    pub source_schema: String,
    pub source_guard: String,
    pub cursor_json: String,
    pub verification_digest: String,
    pub verified: bool,
    pub source_logical_bytes: u64,
    pub target_logical_bytes: u64,
    pub retained_old_logical_bytes: u64,
    pub resume_writes_allowed: bool,
}
