// Where: crates/wiki_cli/src/agent_tools.rs
// What: Compatibility re-export for the legacy wiki_cli agent-tools module path.
// Why: Shared VFS tool plumbing now lives in vfs_cli.
pub use vfs_cli::agent_tools::*;
