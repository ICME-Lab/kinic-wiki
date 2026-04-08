// Where: crates/wiki_cli/src/lib.rs
// What: Agent-facing CLI library for FS-first remote operations and local mirrors.
// Why: The CLI now talks to the canister using node-oriented APIs and mirrors paths directly.
pub mod cli;
pub mod client;
pub mod commands;
pub mod lint_local;
pub mod mirror;
#[cfg(test)]
mod commands_fs_tests;
#[cfg(test)]
mod mirror_fs_tests;
