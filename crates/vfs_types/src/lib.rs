// Where: crates/vfs_types/src/lib.rs
// What: FS-first shared contracts exposed as the reusable VFS public boundary.
// Why: VFS consumers should depend on stable node contracts without importing wiki-specific crates.
mod fs;

use candid::CandidType;
use serde::{Deserialize, Serialize};

pub use fs::*;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct Status {
    pub file_count: u64,
    pub source_count: u64,
}
