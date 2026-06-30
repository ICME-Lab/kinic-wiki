// Where: crates/vfs_cli_app/src/lib.rs
// What: Agent-facing CLI library for canister-backed wiki operations.
// Why: The CLI talks to the canister using node-oriented APIs.
#[cfg(test)]
mod agent_tools_tests;
pub mod claude;
pub mod cli;
pub mod codex;
pub mod commands;
#[cfg(test)]
mod commands_fs_tests;
#[cfg(test)]
mod commands_maintenance_tests;
pub mod context_pack;
pub mod conversation_wiki;
pub mod github_ingest;
pub mod github_source;
pub mod hermes;
pub mod identity;
pub mod identity_mode;
pub mod maintenance;
mod plugin_payload;
mod purge_source_capture;
pub mod skill_registry;
#[cfg(test)]
mod skill_registry_tests;
