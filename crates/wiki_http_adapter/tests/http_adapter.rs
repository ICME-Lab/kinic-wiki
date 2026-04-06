use axum::{body::Body, http::Request};
use serde_json::{Value, json};
use tempfile::tempdir;
use tower::ServiceExt;
use wiki_http_adapter::app;
use wiki_runtime::WikiService;
use wiki_types::{
    CommitPageRevisionInput, CreatePageInput, ExportWikiSnapshotRequest, WikiPageType,
};

fn new_service() -> (tempfile::TempDir, std::path::PathBuf, WikiService) {
    let dir = tempdir().expect("temp dir should exist");
    let db_path = dir.path().join("wiki.sqlite3");
    let service = WikiService::new(db_path.clone());
    service.run_migrations().expect("migrations should succeed");
    (dir, db_path, service)
}

#[tokio::test]
async fn status_endpoint_returns_counts() {
    let (_dir, db_path, _service) = new_service();
    let response = app(db_path)
        .oneshot(Request::builder().uri("/status").body(Body::empty()).unwrap())
        .await
        .expect("request should succeed");
    assert_eq!(response.status(), 200);
    let body = read_json(response).await;
    assert_eq!(body["page_count"], 0);
    assert_eq!(body["system_page_count"], 0);
}

#[tokio::test]
async fn export_and_fetch_endpoints_return_snapshot_data() {
    let (_dir, db_path, service) = new_service();
    let page_id = create_page_with_revision(&service, "alpha", "# Alpha\n\nbody", 1_700_000_001);

    let export = post_json(
        db_path.clone(),
        "/export_wiki_snapshot",
        json!({ "include_system_pages": true, "page_slugs": null }),
    )
    .await;
    assert_eq!(export.0, 200);
    assert_eq!(export.1["pages"][0]["page_id"], page_id);
    assert_eq!(export.1["pages"][0]["page_type"], "entity");
    let snapshot_revision = export.1["snapshot_revision"]
        .as_str()
        .expect("snapshot revision should exist")
        .to_string();
    let revision_id = export.1["pages"][0]["revision_id"]
        .as_str()
        .expect("revision id should exist")
        .to_string();

    let fetch = post_json(
        db_path,
        "/fetch_wiki_updates",
        json!({
            "known_snapshot_revision": snapshot_revision,
            "known_page_revisions": [{ "page_id": page_id, "revision_id": revision_id }],
            "include_system_pages": true
        }),
    )
    .await;
    assert_eq!(fetch.0, 200);
    assert!(fetch.1["changed_pages"].as_array().expect("array").is_empty());
    assert!(fetch.1["system_pages"].as_array().expect("array").is_empty());
}

#[tokio::test]
async fn commit_endpoint_returns_partial_success_and_stale_flag() {
    let (_dir, db_path, service) = new_service();
    let alpha_id = create_page_with_revision(&service, "alpha", "# Alpha\n\nbody", 1_700_000_001);
    let beta_id = create_page_with_revision(&service, "beta", "# Beta\n\nbody", 1_700_000_002);

    let snapshot = service
        .export_wiki_snapshot(ExportWikiSnapshotRequest {
            include_system_pages: true,
            page_slugs: None,
        })
        .expect("snapshot should export");
    let alpha_revision = snapshot
        .pages
        .iter()
        .find(|page| page.page_id == alpha_id)
        .expect("alpha page")
        .revision_id
        .clone();
    let beta_revision = snapshot
        .pages
        .iter()
        .find(|page| page.page_id == beta_id)
        .expect("beta page")
        .revision_id
        .clone();

    service
        .commit_page_revision(CommitPageRevisionInput {
            page_id: beta_id.clone(),
            expected_current_revision_id: Some(beta_revision.clone()),
            title: "Beta v2".to_string(),
            markdown: "# Beta\n\nremote change".to_string(),
            change_reason: "seed".to_string(),
            author_type: "test".to_string(),
            tags: Vec::new(),
            updated_at: 1_700_000_010,
        })
        .expect("remote update should commit");

    let commit = post_json(
        db_path,
        "/commit_wiki_changes",
        json!({
            "base_snapshot_revision": snapshot.snapshot_revision,
            "page_changes": [
                {
                    "change_type": "Update",
                    "page_id": alpha_id,
                    "base_revision_id": alpha_revision,
                    "new_markdown": "# Alpha\n\nlocal change"
                },
                {
                    "change_type": "Update",
                    "page_id": beta_id,
                    "base_revision_id": beta_revision,
                    "new_markdown": "# Beta\n\nlocal conflicting change"
                }
            ]
        }),
    )
    .await;

    assert_eq!(commit.0, 200);
    assert_eq!(commit.1["snapshot_was_stale"], true);
    assert_eq!(commit.1["committed_pages"].as_array().expect("array").len(), 1);
    assert_eq!(commit.1["rejected_pages"].as_array().expect("array").len(), 1);
    let conflict = &commit.1["rejected_pages"][0];
    assert!(conflict["conflict_markdown"]
        .as_str()
        .expect("conflict markdown")
        .contains("<<<<<<< LOCAL"));
}

fn create_page_with_revision(
    service: &WikiService,
    slug: &str,
    markdown: &str,
    updated_at: i64,
) -> String {
    let page_id = service
        .create_page(CreatePageInput {
            slug: slug.to_string(),
            page_type: WikiPageType::Entity,
            title: slug.to_uppercase(),
            created_at: 1_700_000_000,
        })
        .expect("page should create");
    service
        .commit_page_revision(CommitPageRevisionInput {
            page_id: page_id.clone(),
            expected_current_revision_id: None,
            title: slug.to_uppercase(),
            markdown: markdown.to_string(),
            change_reason: "seed".to_string(),
            author_type: "test".to_string(),
            tags: Vec::new(),
            updated_at,
        })
        .expect("revision should commit");
    page_id
}

async fn post_json(db_path: std::path::PathBuf, uri: &str, body: Value) -> (u16, Value) {
    let response = app(db_path)
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(uri)
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .expect("request should succeed");
    let status = response.status().as_u16();
    (status, read_json(response).await)
}

async fn read_json(response: axum::response::Response) -> Value {
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body should read");
    serde_json::from_slice(&bytes).expect("response should be json")
}
