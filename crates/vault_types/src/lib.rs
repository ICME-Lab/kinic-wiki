pub mod capacity;
use candid::{CandidType, Principal};
use serde::{Deserialize, Serialize};

pub const FILE_MAX: u64 = 10 * 1024 * 1024;
pub const NOTE_MAX: u64 = 256 * 1024;
pub const CHUNK_MAX: usize = 1024 * 1024 + 16;
pub const VAULT_MAX: u64 = 100 * 1024 * 1024;
pub const TOTAL_MAX: u64 = 200 * 1024 * 1024;
pub const DAY: u64 = 86400;
pub const CONTEXT: &[u8] = b"kinic-vault/kek/v1";
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
    RateLimited { retry_after: u64 },
    InvalidProof,
    Storage,
    KeyService,
    ExportInProgress,
}
#[derive(CandidType, Serialize, Deserialize, Debug, Clone)]
pub struct Config {
    pub owner: Principal,
    pub origin: String,
    pub rp_id: String,
    pub key_name: String,
    pub minimum_cycles: u64,
}
#[derive(CandidType, Serialize, Deserialize, Debug, Clone, PartialEq)]
pub enum VaultState {
    Pending,
    Active,
    Restoring,
    Purging,
}
#[derive(CandidType, Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Envelope {
    pub version: u8,
    pub nonce: Vec<u8>,
    pub ciphertext: Vec<u8>,
}
#[derive(CandidType, Serialize, Deserialize, Debug, Clone)]
pub struct Header {
    #[serde(default)]
    pub generation: Option<Generation>,
    #[serde(default)]
    pub recovery_verifier: Vec<u8>,
    pub id: Id,
    pub epoch: u64,
    pub state: VaultState,
    pub normal: Option<Envelope>,
    pub recovery: Option<Envelope>,
    pub sequence: u64,
    pub backup_sequence: Option<u64>,
    pub backup_at: Option<u64>,
    pub key_name: String,
}
#[derive(CandidType, Serialize, Deserialize, Debug, Clone)]
pub struct Reserve {
    pub vault: Id,
    pub operation: Id,
}
#[derive(CandidType, Serialize, Deserialize, Debug, Clone, PartialEq)]
pub enum Purpose {
    Unlock,
    Activate,
    AddCredential,
    RemoveCredential,
}
#[derive(CandidType, Serialize, Deserialize, Debug, Clone)]
pub struct BeginUnlock {
    pub vault: Id,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attempt: Option<Id>,
    pub epoch: u64,
    pub purpose: Purpose,
    pub transport: Vec<u8>,
    pub target: Vec<u8>,
}
#[derive(CandidType, Serialize, Deserialize, Debug, Clone)]
pub struct Challenge {
    pub bytes: Vec<u8>,
    pub expires: u64,
    pub registration: bool,
    pub credential_ids: Vec<Vec<u8>>,
}
#[derive(CandidType, Serialize, Deserialize, Debug, Clone)]
pub struct Derive {
    pub vault: Id,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attempt: Option<Id>,
    pub epoch: u64,
    pub transport: Vec<u8>,
    pub assertion: Option<String>,
}
#[derive(CandidType, Serialize, Deserialize, Debug, Clone)]
pub struct Activate {
    pub vault: Id,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attempt: Option<Id>,
    pub operation: Id,
    pub normal: Envelope,
    pub recovery: Envelope,
    pub registration: Option<String>,
    pub assertion: Option<String>,
}
#[derive(CandidType, Serialize, Deserialize, Debug, Clone)]
pub struct ManageCredential {
    pub vault: Id,
    pub remove: Option<Vec<u8>>,
    pub registration: Option<String>,
    pub assertion: String,
}
#[derive(CandidType, Serialize, Deserialize, Debug, Clone)]
pub struct KeyReply {
    pub encrypted_key: Vec<u8>,
    pub public_key: Vec<u8>,
}
#[derive(CandidType, Serialize, Deserialize, Debug, Clone)]
pub struct CredentialInfo {
    pub id: Vec<u8>,
}

pub fn id(value: &[u8]) -> Result<()> {
    if value.len() == 16 {
        Ok(())
    } else {
        Err(Error::InvalidInput)
    }
}
pub fn envelope(e: &Envelope) -> Result<()> {
    if e.version == 1 && e.nonce.len() == 12 && e.ciphertext.len() == 48 {
        Ok(())
    } else {
        Err(Error::InvalidInput)
    }
}
pub fn key_input(vault: &[u8], epoch: u64) -> Result<Vec<u8>> {
    id(vault)?;
    Ok([vault, &epoch.to_be_bytes()].concat())
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
pub struct Export {
    pub record_count: u64,
    pub chunk_count: u64,
    pub plain_bytes: u64,
    pub id: Id,
    pub vault: Id,
    pub sequence: u64,
    pub expires: u64,
    pub state: String,
    pub header: Header,
}
#[derive(CandidType, Serialize, Deserialize, Debug, Clone)]
pub struct ExportPage {
    pub entries: Vec<Revision>,
    pub next: Option<u64>,
}
#[derive(CandidType, Serialize, Deserialize, Debug, Clone)]
pub struct BeginRestore {
    pub header: Header,
    pub operation: Id,
    pub count: u64,
    pub root: Vec<u8>,
    pub reserved_bytes: u64,
}
#[derive(CandidType, Serialize, Deserialize, Debug, Clone)]
pub struct RestoreProgress {
    pub count: u64,
    pub sequence: u64,
    pub root: Vec<u8>,
}

#[derive(CandidType, Serialize, Deserialize, Debug, Clone)]
pub struct UnfinishedVault {
    pub namespace: Option<Vec<u8>>,
    pub vault: Id,
    pub attempt: Id,
    pub state: VaultState,
    pub expires: u64,
    pub cleaning: bool,
}

/// Exact WebAuthn deployment configuration, independent from II derivation origin.
#[derive(CandidType, Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct VaultConfig {
    pub origin: String,
    pub rp_id: String,
    pub key_name: String,
    pub minimum_cycles: u64,
}
pub fn owner_key_input(owner: Principal, vault: &[u8], epoch: u64) -> Result<Vec<u8>> {
    id(vault)?;
    if owner == Principal::anonymous() || owner == Principal::management_canister() {
        return Err(Error::Unauthorized);
    }
    Ok([
        b"kinic-wiki/private-vault/v1".as_slice(),
        &[owner.as_slice().len() as u8],
        owner.as_slice(),
        vault,
        &epoch.to_be_bytes(),
    ]
    .concat())
}

#[cfg(test)]
mod integration_tests {
    use super::*;
    #[test]
    fn private_key_derivation_binds_owner_vault_and_epoch_without_changing_archive_ids() {
        let a = Principal::self_authenticating([1; 32]);
        let b = Principal::self_authenticating([2; 32]);
        let input = owner_key_input(a, &[7; 16], 3).unwrap();
        assert_ne!(input, owner_key_input(b, &[7; 16], 3).unwrap());
        assert_ne!(input, owner_key_input(a, &[8; 16], 3).unwrap());
        assert_ne!(input, owner_key_input(a, &[7; 16], 4).unwrap());
        assert!(input.ends_with(&[&[7u8; 16][..], &3u64.to_be_bytes()].concat()));
        assert_eq!(
            key_input(&[7; 16], 3).unwrap(),
            [&[7u8; 16][..], &3u64.to_be_bytes()].concat()
        );
    }
}

pub mod generation;
pub use generation::*;

pub mod mutation;
pub use mutation::*;

/// Shared logical capacity; accounting is reserved globally, never billed per owner.
#[derive(CandidType, Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct GlobalCapacity {
    pub used: u64,
    pub limit: u64,
    pub accounting_reserved: u64,
    pub legacy_excess: u64,
    pub overcommitted: bool,
    pub overage: u64,
}
