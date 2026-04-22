// Where: crates/wiki_cli/src/lib.rs
// What: Agent-facing CLI library for FS-first remote operations and local mirrors.
// Why: The CLI now talks to the canister using node-oriented APIs and mirrors paths directly.
pub mod agent_tools;
#[cfg(test)]
mod agent_tools_tests;
pub mod beam_bench;
pub mod cli;
pub mod client;
pub mod commands;
#[cfg(test)]
mod commands_fs_tests;
#[cfg(test)]
mod commands_maintenance_tests;
#[cfg(test)]
mod commands_sync_tests;
#[cfg(test)]
mod commands_vfs_tests;
pub mod connection;
pub mod lint_local;
pub mod maintenance;
pub mod mirror;
#[cfg(test)]
mod mirror_fs_tests;
