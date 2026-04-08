// Where: crates/wiki_cli/src/lib.rs
// What: Agent-facing CLI library for remote wiki reads and local mirror sync.
// Why: Keep the binary thin while command logic stays testable and reusable.
pub mod adopt;
pub mod cli;
pub mod client;
pub mod commands;
#[cfg(test)]
mod commands_tests;
#[cfg(test)]
mod draft_collision_tests;
pub mod generate;
mod generate_helpers;
#[cfg(test)]
mod generate_tests;
pub mod ingest;
#[cfg(test)]
mod ingest_tests;
pub mod lint;
pub mod lint_local;
#[cfg(test)]
mod lint_local_tests;
#[cfg(test)]
mod lint_tests;
pub mod mirror;
#[cfg(test)]
mod mirror_fixture_tests;
pub mod query_page;
#[cfg(test)]
mod query_page_tests;
pub mod source_to_draft;
#[cfg(test)]
mod source_to_draft_tests;
