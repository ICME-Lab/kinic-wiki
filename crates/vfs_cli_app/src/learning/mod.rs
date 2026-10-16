//! CLI-owned orchestration for agent experience, retrieval and guarded learning.
mod model;
mod outbox;
mod retrieval;
pub use model::*;
pub use outbox::*;
pub use retrieval::*;
#[cfg(test)]
mod tests;

pub mod cli;
pub mod workflow;

#[cfg(test)]
mod integration_tests;

mod evidence;
pub use evidence::*;

pub mod project;
#[cfg(test)]
mod project_tests;

pub mod jobs;

pub mod redaction;
