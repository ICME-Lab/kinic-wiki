// Where: crates/vfs_cli/src/lib.rs
// What: Reusable VFS CLI library split from wiki-specific workflow code.
// Why: Generic VFS commands, connection resolution, and tool schemas should live outside the app-facing CLI package.
pub mod agent_tools;
pub mod cli;
pub mod commands;
pub mod connection;
