// Where: crates/vfs_store/src/lib.rs
// What: FS-first persistence primitives over the SQLite source-of-truth.
// Why: The repo no longer keeps a parallel wiki-specific store layer or schema.
mod fs_helpers;
mod fs_links;
mod fs_search;
mod fs_search_bench;
mod fs_store;
mod glob_match;
mod hashing;
mod retrieval_excerpt;
mod schema;
mod sqlite;

#[cfg(target_arch = "wasm32")]
pub use crate::fs_store::StableFsStore;
pub use crate::fs_store::{FsStore, validate_sql_json_select};

/// Parse internal Markdown/wiki edges using the same rules as persisted link indexes.
pub use fs_links::extract_link_edges;
