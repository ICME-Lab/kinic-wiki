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

/// Controller-only, one raw intermediate source with exactly one backed-up revision.
/// Caller must scan references against expected_snapshot_revision and retain the
/// verified backup identified by backup_manifest_sha256 before invoking this.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct ArchiveIntermediateSourceRequest {
    pub database_id: String,
    pub expected_mount: u16,
    pub path: String,
    pub expected_etag: String,
    pub expected_node_id: String,
    pub expected_revision: u64,
    pub expected_content_hash: String,
    pub expected_snapshot_revision: String,
    pub backup_manifest_sha256: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct StoragePageStats {
    pub page_size: u64,
    pub page_count: u64,
    pub freelist_pages: u64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct DatabaseStorageStats {
    pub mount_id: u16,
    pub pages: StoragePageStats,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct ArchiveIntermediateSourceResult {
    pub path: String,
    pub snapshot_revision: String,
    pub before: StoragePageStats,
    pub after: StoragePageStats,
}
