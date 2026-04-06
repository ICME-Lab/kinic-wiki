// Where: crates/wiki_store/src/lib.rs
// What: Store and rendering primitives for the wiki application's source-of-truth tables.
// Why: Keep revision tracking, section diffing, and system page materialization independent from runtime wiring.
mod commit;
mod hashing;
mod markdown;
mod render;
mod schema;
mod search;
mod source;
mod store;
mod system_pages;

pub use crate::store::WikiStore;
