// Where: crates/wiki_http_adapter/src/routes.rs
// What: Route handlers that expose WikiService as local JSON endpoints.
// Why: Keep HTTP concerns small and separate from CLI startup and runtime storage logic.
use std::path::PathBuf;

use axum::{
    Json, Router,
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::Serialize;
use wiki_runtime::WikiService;
use wiki_types::{
    CommitWikiChangesRequest, CommitWikiChangesResponse, ExportWikiSnapshotRequest,
    ExportWikiSnapshotResponse, FetchWikiUpdatesRequest, FetchWikiUpdatesResponse, Status,
};

use crate::AppState;

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/status", get(status))
        .route("/export_wiki_snapshot", post(export_wiki_snapshot))
        .route("/fetch_wiki_updates", post(fetch_wiki_updates))
        .route("/commit_wiki_changes", post(commit_wiki_changes))
        .with_state(state)
}

#[derive(Debug)]
pub struct AdapterError {
    status: StatusCode,
    message: String,
}

impl AdapterError {
    fn bad_request(message: String) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message,
        }
    }

    fn internal(message: String) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message,
        }
    }
}

impl IntoResponse for AdapterError {
    fn into_response(self) -> Response {
        (self.status, Json(ErrorBody { error: self.message })).into_response()
    }
}

#[derive(Serialize)]
struct ErrorBody {
    error: String,
}

async fn status(State(state): State<AppState>) -> Result<Json<Status>, AdapterError> {
    run_service(state.database_path, |service| service.status())
        .await
        .map(Json)
}

async fn export_wiki_snapshot(
    State(state): State<AppState>,
    Json(request): Json<ExportWikiSnapshotRequest>,
) -> Result<Json<ExportWikiSnapshotResponse>, AdapterError> {
    run_service(state.database_path, move |service| service.export_wiki_snapshot(request))
        .await
        .map(Json)
}

async fn fetch_wiki_updates(
    State(state): State<AppState>,
    Json(request): Json<FetchWikiUpdatesRequest>,
) -> Result<Json<FetchWikiUpdatesResponse>, AdapterError> {
    run_service(state.database_path, move |service| service.fetch_wiki_updates(request))
        .await
        .map(Json)
}

async fn commit_wiki_changes(
    State(state): State<AppState>,
    Json(request): Json<CommitWikiChangesRequest>,
) -> Result<Json<CommitWikiChangesResponse>, AdapterError> {
    run_service(state.database_path, move |service| service.commit_wiki_changes(request))
        .await
        .map(Json)
}

async fn run_service<T, F>(database_path: PathBuf, call: F) -> Result<T, AdapterError>
where
    T: Send + 'static,
    F: FnOnce(WikiService) -> Result<T, String> + Send + 'static,
{
    tokio::task::spawn_blocking(move || {
        let service = WikiService::new(database_path);
        call(service)
    })
    .await
    .map_err(|error| AdapterError::internal(error.to_string()))?
    .map_err(classify_service_error)
}

fn classify_service_error(message: String) -> AdapterError {
    if looks_like_bad_request(&message) {
        return AdapterError::bad_request(message);
    }
    AdapterError::internal(message)
}

fn looks_like_bad_request(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("missing")
        || lower.contains("invalid")
        || lower.contains("expected")
        || lower.contains("not found")
        || lower.contains("required")
        || lower.contains("must provide")
}
