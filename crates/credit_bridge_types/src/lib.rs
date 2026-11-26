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
/// A Wiki owner's standing authorization to refill the linked Vault account.
/// Separate from the frozen v1 tuples: it is set by the Wiki owner and read by both sides.
#[derive(Clone, Debug, CandidType, Serialize, Deserialize, PartialEq, Eq)]
pub struct AutoTopupPolicy {
    /// The owned Wiki database that pays for refills.
    pub database_id: String,
    /// A refill may run only while the Vault balance is below this.
    pub threshold_cycles: u64,
    /// Cycles sent per refill.
    pub amount_cycles: u64,
    /// The most this policy may send per UTC day.
    pub daily_limit_cycles: u64,
    /// The database keeps at least this after a refill and its fee.
    pub min_database_cycles: u64,
}
#[derive(Clone, Debug, CandidType, Serialize, Deserialize, PartialEq, Eq)]
pub struct AutoTopupStatus {
    pub policy: AutoTopupPolicy,
    pub database_name: String,
    pub sent_today_cycles: u64,
    pub last_topup_at_ns: Option<u64>,
}
