// Where: crates/wiki_runtime/src/lib.rs
// What: Compatibility re-export for the legacy wiki runtime crate path.
// Why: New code should import vfs_runtime directly; this crate remains only as a compatibility boundary.
pub use vfs_runtime::VfsService;
pub use vfs_runtime::VfsService as WikiService;
