// Where: crates/wiki_types/src/lib.rs
// What: Compatibility re-export for the legacy wiki type crate path.
// Why: New code should import vfs_types directly; this crate remains only as a compatibility boundary.
pub use vfs_types::*;
