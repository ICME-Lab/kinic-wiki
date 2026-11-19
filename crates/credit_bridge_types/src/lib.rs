//! Neutral v1 wire protocol. Identity is the complete immutable tuple, never an extensible Candid type table.
//! LinkChallenge and CreditOffer are frozen v1 persistent tuples. A future wire
//! extension must introduce a new versioned type/envelope rather than extend them.
use candid::{CandidType, Principal};
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, CandidType, Serialize, Deserialize, PartialEq, Eq)]
pub enum BridgeError {
    Unauthorized,
    Disabled,
    InvalidInput,
    NotFound,
    Conflict,
    Expired,
    Capacity,
    Unavailable,
    Storage,
}
pub type BridgeResult<T> = Result<T, BridgeError>;
#[derive(Clone, Debug, CandidType, Serialize, Deserialize, PartialEq, Eq)]
pub struct BridgeConfig {
    pub peer: Principal,
    pub enabled: bool,
    pub daily_limit_cycles: u64,
    pub physical_reserve_cycles: u64,
}
#[derive(Clone, Debug, CandidType, Serialize, Deserialize, PartialEq, Eq)]
pub struct LinkChallenge {
    pub challenge: Vec<u8>,
    pub vault_owner: Principal,
    pub generation: u64,
    pub expires_at_ns: u64,
}
#[derive(Clone, Debug, CandidType, Serialize, Deserialize, PartialEq, Eq)]
pub struct LinkProof {
    pub challenge: LinkChallenge,
    pub wiki_owner: Principal,
}
#[derive(Clone, Debug, CandidType, Serialize, Deserialize, PartialEq, Eq)]
pub struct LinkStatus {
    pub vault_owner: Principal,
    pub wiki_owner: Principal,
    pub generation: u64,
    pub active: bool,
}
#[derive(Clone, Debug, CandidType, Serialize, Deserialize, PartialEq, Eq)]
pub struct BridgeRevocation {
    pub vault_owner: Principal,
    pub through_generation: u64,
}
#[derive(Clone, Debug, CandidType, Serialize, Deserialize, PartialEq, Eq)]
pub struct CreditOffer {
    pub operation: Vec<u8>,
    pub wiki_owner: Principal,
    pub vault_owner: Principal,
    pub amount_cycles: u64,
    pub expires_at_ns: u64,
    pub link_generation: u64,
}
#[derive(Clone, Debug, CandidType, Serialize, Deserialize, PartialEq, Eq)]
pub enum CreditStatus {
    Prepared,
    Accepted,
    NotAccepted,
}
#[derive(Clone, Debug, CandidType, Serialize, Deserialize, PartialEq, Eq)]
pub struct CreditReceipt {
    pub offer: CreditOffer,
    pub status: CreditStatus,
}
