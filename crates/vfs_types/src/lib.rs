// Where: crates/vfs_types/src/lib.rs
// What: FS-first shared contracts exposed as the reusable VFS public boundary.
// Why: VFS consumers should depend on stable node contracts without importing wiki-specific crates.
mod fs;

use candid::CandidType;
use serde::{Deserialize, Serialize};

pub use fs::*;

pub const KINIC_DECIMALS: u8 = 8;
pub const KINIC_LEDGER_FEE_E8S: u64 = 100_000;

pub fn kinic_base_units_per_token() -> u64 {
    10_u64.pow(u32::from(KINIC_DECIMALS))
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct Status {
    pub file_count: u64,
    pub source_count: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct CanisterHealth {
    pub cycles_balance: u128,
}
