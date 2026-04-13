// Where: crates/wiki_types/src/lib.rs
// What: FS-first shared contracts used by store, runtime, canister, CLI, and plugin code.
// Why: The repo now has one source-of-truth model based on nodes, so old wiki-only types are removed.
mod fs;

use candid::CandidType;
use serde::{Deserialize, Serialize};

pub use fs::*;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct Status {
    pub file_count: u64,
    pub source_count: u64,
}
