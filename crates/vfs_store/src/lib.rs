// Where: crates/vfs_store/src/lib.rs
// What: FS-first persistence primitives over the SQLite source-of-truth.
// Why: The repo no longer keeps a parallel wiki-specific store layer or schema.
mod fs_helpers;
mod fs_links;
mod fs_search;
mod fs_search_bench;
mod fs_store;
mod git_repository;
mod glob_match;
mod hashing;
mod schema;
mod sqlite;

#[cfg(target_arch = "wasm32")]
pub use crate::fs_store::StableFsStore;
pub use crate::fs_store::{FsStore, validate_sql_json_select};

#[cfg(all(debug_assertions, not(target_arch = "wasm32")))]
#[doc(hidden)]
pub fn set_git_finalize_failpoint_for_test(stage: u8) {
    git_repository::set_finalize_failpoint(stage);
}
