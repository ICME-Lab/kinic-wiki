// Where: crates/wiki_http_adapter/src/lib.rs
// What: Thin local HTTP adapter over WikiService for the Obsidian plugin.
// Why: The plugin needs simple JSON endpoints without embedding runtime logic or canister transport details.
mod routes;

use std::path::PathBuf;

use axum::Router;

pub use routes::AdapterError;

#[derive(Clone, Debug)]
pub struct AppState {
    pub database_path: PathBuf,
}

pub fn app(database_path: PathBuf) -> Router {
    routes::router(AppState { database_path })
}
