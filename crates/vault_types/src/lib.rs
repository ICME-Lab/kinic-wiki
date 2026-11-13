//! II caller-owned Vault wire contract. All ids are 16 bytes; time is Unix seconds.
pub mod capacity;
use candid::{CandidType, Principal};
use serde::{Deserialize, Serialize};
pub const FILE_MAX: u64 = 10 * 1024 * 1024;
pub const NOTE_MAX: u64 = 256 * 1024;
pub const CHUNK_MAX: usize = 1024 * 1024 + 16;
pub const VAULT_MAX: u64 = 100 * 1024 * 1024;
pub const TOTAL_MAX: u64 = 200 * 1024 * 1024;
pub const DAY: u64 = 86400;
pub const KEY_CONTEXT: &[u8] = b"kinic-vault/ii-only/v1";
pub const ROOT_CONTEXT: &[u8] = b"kinic-vault/root/v3";
pub type Id = Vec<u8>;
pub type Result<T> = std::result::Result<T, Error>;
#[derive(CandidType, Serialize, Deserialize, Debug, Clone, PartialEq)]
pub enum Error {
    Unauthorized,
    InvalidInput,
    NotFound,
    Conflict,
    Expired,
    Busy,
    QuotaExceeded,
    Storage,
    KeyService,
}
#[derive(CandidType, Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct VaultConfig {
    pub key_name: String,
    pub minimum_cycles: u64,
}
#[derive(CandidType, Serialize, Deserialize, Debug, Clone, PartialEq)]
pub enum VaultState {
    Pending,
    Active,
    Deleting,
    Deleted,
}
#[derive(CandidType, Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Header {
    pub id: Id,
    pub nonce: Vec<u8>,
    pub state: VaultState,
    pub sequence: u64,
    pub key_name: String,
    pub public_key: Vec<u8>,
}
#[derive(CandidType, Serialize, Deserialize, Debug, Clone)]
pub struct CreateVault {
    pub vault: Id,
    pub operation: Id,
}
#[derive(CandidType, Serialize, Deserialize, Debug, Clone)]
pub struct DeriveKey {
    pub vault: Id,
    pub operation: Id,
    pub transport: Vec<u8>,
}
#[derive(CandidType, Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct KeyReply {
    pub encrypted_key: Vec<u8>,
    pub public_key: Vec<u8>,
    pub input: Vec<u8>,
}
pub fn id(value: &[u8]) -> Result<()> {
    if value.len() == 16 {
        Ok(())
    } else {
        Err(Error::InvalidInput)
    }
}
/// Concatenation of u32 big-endian lengths and bytes, in this exact order.
pub fn key_input(canister: Principal, owner: Principal, h: &Header) -> Result<Vec<u8>> {
    id(&h.id)?;
    if owner == Principal::anonymous() || owner == Principal::management_canister() {
        return Err(Error::Unauthorized);
    }
    if h.nonce.len() != 32 || h.key_name.is_empty() || h.key_name.len() > 64 {
        return Err(Error::InvalidInput);
    }
    let mut out = Vec::new();
    for field in [
        canister.as_slice(),
        owner.as_slice(),
        &h.id,
        &h.nonce,
        h.key_name.as_bytes(),
    ] {
        out.extend_from_slice(&(field.len() as u32).to_be_bytes());
        out.extend_from_slice(field);
    }
    Ok(out)
}
#[derive(CandidType, Serialize, Deserialize, Debug, Clone)]
pub struct BeginRevision {
    pub vault: Id,
    pub object: Id,
    pub expected_revision: u64,
    pub operation: Id,
    pub plain_size: u64,
    pub manifest: Vec<u8>,
    pub chunk_hashes: Vec<Vec<u8>>,
}
#[derive(CandidType, Serialize, Deserialize, Debug, Clone)]
pub struct Upload {
    pub id: Id,
    pub revision: u64,
    pub expires: u64,
}
/// Bounded owner-only metadata; no document name or plaintext.
#[derive(CandidType, Serialize, Deserialize, Debug, Clone)]
pub struct PendingUploadSummary {
    pub upload: Id,
    pub vault: Id,
    pub expires: u64,
    pub cancel_job: Option<Id>,
}
#[derive(CandidType, Serialize, Deserialize, Debug, Clone)]
pub struct PendingUploads {
    pub entries: Vec<PendingUploadSummary>,
    pub next: Option<Id>,
}
#[derive(CandidType, Serialize, Deserialize, Debug, Clone)]
pub struct PendingUpload {
    pub request: BeginRevision,
    pub expires: u64,
    pub received: Vec<u32>,
    pub cancel_job: Option<Id>,
}
#[derive(CandidType, Serialize, Deserialize, Debug, Clone)]
pub struct CommittedUpload {
    pub vault: Id,
    pub object: Id,
    pub revision: u64,
    pub sequence: u64,
}
#[derive(CandidType, Serialize, Deserialize, Debug, Clone)]
pub enum UploadStatus {
    Pending(PendingUpload),
    Committed(CommittedUpload),
    Cancelled,
    Expired,
    Absent,
}
#[derive(CandidType, Serialize, Deserialize, Debug, Clone)]
pub struct Revision {
    pub vault: Id,
    pub object: Id,
    pub revision: u64,
    pub plain_size: u64,
    pub manifest: Vec<u8>,
    pub chunk_hashes: Vec<Vec<u8>>,
    pub deleted: bool,
    pub sequence: u64,
}
#[derive(CandidType, Serialize, Deserialize, Debug, Clone)]
pub struct RevisionPage {
    pub entries: Vec<Revision>,
    pub next: Option<u64>,
}
#[derive(CandidType, Serialize, Deserialize, Debug, Clone)]
pub struct ObjectPage {
    pub entries: Vec<Revision>,
    pub next: Option<Id>,
}
#[derive(CandidType, Serialize, Deserialize, Debug, Clone)]
pub struct Quota {
    pub current: u64,
    pub charged: u64,
    pub reserved: u64,
    pub limit: u64,
}

#[derive(CandidType, Serialize, Deserialize, Debug, Clone)]
pub struct Mutation {
    pub operation: Id,
    pub action: Action,
}
#[derive(CandidType, Serialize, Deserialize, Debug, Clone)]
pub enum Action {
    BeginRevision(BeginRevision),
    PutChunk {
        upload: Id,
        index: u32,
        bytes: Vec<u8>,
    },
    CommitRevision {
        upload: Id,
    },
    DeleteObject {
        vault: Id,
        object: Id,
        expected_revision: u64,
    },
    CancelUpload {
        vault: Id,
        upload: Id,
        job: Id,
    },
    DeleteVault {
        vault: Id,
    },
    Collect,
}
#[derive(CandidType, Serialize, Deserialize, Debug, Clone)]
pub enum MutationResult {
    Upload(Upload),
    Revision(Revision),
    Done,
    Progress(bool),
    Collected(u64),
}
#[derive(CandidType, Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct GlobalCapacity {
    pub used: u64,
    pub limit: u64,
    pub accounting_reserved: u64,
    pub overcommitted: bool,
    pub overage: u64,
}
