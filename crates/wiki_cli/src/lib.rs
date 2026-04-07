// Where: crates/wiki_cli/src/lib.rs
// What: Agent-facing CLI library for remote wiki reads and local mirror sync.
// Why: Keep the binary thin while command logic stays testable and reusable.
pub mod cli;
pub mod client;
pub mod commands;
#[cfg(test)]
mod commands_tests;
#[cfg(test)]
mod mirror_fixture_tests;
pub mod mirror;
