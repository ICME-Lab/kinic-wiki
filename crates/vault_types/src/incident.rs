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
    Resetting,
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
