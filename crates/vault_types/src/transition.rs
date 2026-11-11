//! Bounded restore metadata. Admission adds no credential or ordinary authority.
use super::*;
#[derive(CandidType, Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RestoreAdmissionRequest {
    #[serde(default)]
    pub candidate_mode: Option<RestoreCandidateMode>,
    pub job: Id,
    pub target: PendingCreation,
    pub archive_digest: Vec<u8>,
    pub source_commitment: Vec<u8>,
    pub source_epoch: u64,
    pub source_generation: Option<Generation>,
    pub archive_length: u64,
    pub records: u64,
    pub reserved_bytes: u64,
}
/// None/New preserves the new physical candidate ceremony, including historical jobs.
#[derive(CandidType, Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub enum RestoreCandidateMode {
    New,
    ExistingInstances(Vec<u8>),
}
#[derive(CandidType, Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RestoreExistingCandidate {
    pub credential: Vec<u8>,
    pub version: u64,
    pub scope_digest: Vec<u8>,
}
#[derive(CandidType, Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub enum RestoreAdmissionPhase {
    Registration,
    Possession,
    CurrentProof,
    Admitted,
}
#[derive(CandidType, Serialize, Deserialize, Debug, Clone)]
#[serde(deny_unknown_fields)]
pub struct RestoreAdmissionStatus {
    pub request: RestoreAdmissionRequest,
    pub current_live: Option<Generation>,
    pub current_verifier: Vec<u8>,
    pub parent_job: Option<Id>,
    pub next_epoch: u64,
    pub phase: RestoreAdmissionPhase,
    /// Public credential material only, bounded and checked before persistence.
    pub candidate: Option<String>,
    pub candidate_digest: Vec<u8>,
    #[serde(default)]
    pub existing_candidate: Option<RestoreExistingCandidate>,
    pub challenge: Challenge,
    /// Exact bytes to sign, including the recovery proof domain and pre-nonce binding.
    pub recovery_message: Vec<u8>,
    pub semantic_config: Vec<u8>,
    pub proof_fence: Vec<u8>,
    pub issued: u64,
    #[serde(default)]
    pub pipeline: Option<RestorePipeline>,
    #[serde(default)]
    pub allocation_token: Option<u64>,
    #[serde(default)]
    pub cancel_requested: bool,
    #[serde(default)]
    pub cancel_complete: bool,
}
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(deny_unknown_fields)]
pub struct RestoreNamespaceFlight {
    pub operation: Id,
    pub token: u64,
    pub expires: u64,
    pub fence: Vec<u8>,
    pub ready: bool,
}
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(deny_unknown_fields)]
pub struct TransitionState {
    pub version: u8,
    pub incident: Option<IncidentStatus>,
    pub restore: Option<RestoreAdmissionStatus>,
    pub namespace_flight: Option<RestoreNamespaceFlight>,
}
impl Default for TransitionState {
    fn default() -> Self {
        Self {
            version: 1,
            incident: None,
            restore: None,
            namespace_flight: None,
        }
    }
}

/// Locally validated archive metadata. This is a signed client assertion, not server AEAD validation.
#[derive(CandidType, Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RestorePreflight {
    pub archive_digest: Vec<u8>,
    pub archive_length: u64,
    pub source_commitment: Vec<u8>,
    pub target_commitment: Vec<u8>,
    pub sequence: u64,
    pub records: u64,
    pub objects: u64,
    pub chunks: u64,
    pub revision_bytes: u64,
    pub peak_pending_bytes: u64,
    pub current_plain_bytes: u64,
    pub plain_bytes: u64,
    pub source_saved: bool,
    pub source_fully_verified: bool,
}
#[derive(CandidType, Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub enum RestorePhase {
    Allocated,
    EnvelopesStaged,
    KitConfirmed,
    Discarding,
    Importing,
    BackupVerified,
    Active,
    Cancelling,
    Cancelled,
}
#[derive(CandidType, Serialize, Deserialize, Debug, Clone)]
#[serde(deny_unknown_fields)]
pub struct RestorePipeline {
    pub target: Generation,
    pub phase: RestorePhase,
    pub normal: Option<Envelope>,
    pub recovery: Option<Envelope>,
    pub recovery_verifier: Vec<u8>,
    pub envelope_digest: Vec<u8>,
    pub kit_ack: Option<Vec<u8>>,
    pub preflight: Option<RestorePreflight>,
    pub old_removed: bool,
    pub discard_started: bool,
    pub cleanup_cursor: u64,
    pub backup_ack: Option<IncidentBackupAck>,
}
