//! Bounded incident protocol. Only ciphertext and public identities cross the wire.
use super::*;
#[derive(CandidType, Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct IncidentPreparation {
    pub job: Id,
    pub namespace: Vec<u8>,
    pub compromised: Vec<CredentialRevocation>,
    pub sources: Vec<Generation>,
    pub targets: Vec<PendingCreation>,
}
#[derive(CandidType, Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub enum IncidentRole {
    Source,
    Target,
}
#[derive(CandidType, Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub enum PreparationPhase {
    PendingNonce,
    Allocated,
    EnvelopesStaged,
    KitConfirmed,
    Wrapping,
    BackupVerified,
    Resetting,
    Cancelling,
    Cancelled,
    Purging,
    Purged,
}
#[derive(CandidType, Serialize, Deserialize, Debug, Clone)]
pub struct IncidentTarget {
    pub source: Header,
    pub target: Option<Generation>,
    pub attempt: Id,
    pub next_epoch: u64,
    pub reset_attempt: Option<Id>,
    pub snapshot_time: u64,
    pub snapshot_sequence: u64,
    pub phase: PreparationPhase,
    pub normal: Option<Envelope>,
    pub recovery: Option<Envelope>,
    pub recovery_verifier: Vec<u8>,
    pub envelope_digest: Vec<u8>,
    pub kit_ack: Option<Vec<u8>>,
    #[serde(default)]
    pub coverage: Option<IncidentCoverage>,
    #[serde(default)]
    pub staged_export: Option<StagedExport>,
    #[serde(default)]
    pub backup_ack: Option<IncidentBackupAck>,
}
#[derive(CandidType, Serialize, Deserialize, Debug, Clone)]
pub struct IncidentStatus {
    pub job: Id,
    pub namespace: Vec<u8>,
    pub compromised: Vec<CredentialRevocation>,
    pub semantic_config: Vec<u8>,
    pub targets: Vec<IncidentTarget>,
    pub vector_digest: Vec<u8>,
    pub complete: bool,
    #[serde(default)]
    pub cancel_digest: Option<Vec<u8>>,
    #[serde(default)]
    pub completed_digest: Option<Vec<u8>>,
}
#[derive(CandidType, Serialize, Deserialize, Debug, Clone)]
pub struct IncidentDerive {
    pub job: Id,
    pub attempt: Id,
    pub role: IncidentRole,
    pub generation: Generation,
    pub transport: Vec<u8>,
}

#[derive(CandidType, Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct CredentialRevocation {
    pub credential: Vec<u8>,
    pub version: u64,
}
#[derive(CandidType, Serialize, Deserialize, Debug, Clone)]
pub struct IncidentCredential {
    pub credential: Vec<u8>,
    pub version: u64,
    pub scope: CredentialScope,
}
#[derive(CandidType, Serialize, Deserialize, Debug, Clone)]
pub struct IncidentContext {
    pub namespace: Vec<u8>,
    pub credentials: Vec<IncidentCredential>,
}

/// Constant-size ordered coverage; the frozen source owns membership.
#[derive(CandidType, Serialize, Deserialize, Debug, Clone)]
pub struct IncidentCoverage {
    pub cursor: u64,
    pub records: u64,
    pub chunks: u64,
    pub plain_bytes: u64,
    pub source_root: Vec<u8>,
    pub target_root: Vec<u8>,
    pub complete: bool,
    pub last_batch: Vec<u8>,
}
#[derive(CandidType, Serialize, Deserialize, Debug, Clone)]
pub struct IncidentWrapper {
    pub object: Id,
    pub revision: u64,
    pub sequence: u64,
    pub source_digest: Vec<u8>,
    /// Empty only for a tombstone.
    pub wrapper: Vec<u8>,
}
#[derive(CandidType, Serialize, Deserialize, Debug, Clone)]
pub struct StagedExport {
    pub export: Export,
    pub commitment: Vec<u8>,
    pub descriptor_digest: Vec<u8>,
}
#[derive(CandidType, Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct IncidentBackupAck {
    pub descriptor_digest: Vec<u8>,
    pub commitment: Vec<u8>,
    pub archive_hash: Vec<u8>,
    pub archive_length: u64,
    pub recovery_verifier: Vec<u8>,
    pub sequence: u64,
}
#[derive(CandidType, Serialize, Deserialize, Debug, Clone)]
pub struct IncidentRead {
    pub descriptor_digest: Vec<u8>,
    pub job: Id,
    pub vault: Id,
    pub attempt: Id,
    pub export: Id,
}
