// Where: crates/wiki_cli/src/ingest_tests.rs
// What: Tests for raw source ingestion from local markdown files.
// Why: The ingestion CLI needs deterministic success/rejection behavior before draft generation.
use crate::client::WikiApi;
use crate::ingest::{IngestSourcesRequest, ingest_sources};
use async_trait::async_trait;
use std::sync::Mutex;
use tempfile::tempdir;
use wiki_types::{
    AdoptDraftPageInput, AdoptDraftPageOutput, CommitWikiChangesRequest, CommitWikiChangesResponse,
    CreateSourceInput, ExportWikiSnapshotRequest, ExportWikiSnapshotResponse,
    FetchWikiUpdatesRequest, FetchWikiUpdatesResponse, PageBundle, SearchHit, SearchRequest,
    Status, SystemPage,
};

#[derive(Default)]
struct FakeApi {
    created_sources: Mutex<Vec<CreateSourceInput>>,
    duplicate_sha: Option<String>,
}

#[async_trait]
impl WikiApi for FakeApi {
    async fn adopt_draft_page(
        &self,
        _request: AdoptDraftPageInput,
    ) -> anyhow::Result<AdoptDraftPageOutput> {
        panic!("not used in ingest tests")
    }

    async fn create_source(&self, request: CreateSourceInput) -> anyhow::Result<String> {
        if self.duplicate_sha.as_ref() == Some(&request.sha256) {
            anyhow::bail!("UNIQUE constraint failed: sources.sha256");
        }
        self.created_sources.lock().unwrap().push(request);
        Ok("source_1".to_string())
    }

    async fn lint_health(&self) -> anyhow::Result<wiki_types::HealthCheckReport> {
        panic!("not used in ingest tests")
    }

    async fn status(&self) -> anyhow::Result<Status> {
        panic!("not used in ingest tests")
    }

    async fn search(&self, _request: SearchRequest) -> anyhow::Result<Vec<SearchHit>> {
        panic!("not used in ingest tests")
    }

    async fn get_page(&self, _slug: &str) -> anyhow::Result<Option<PageBundle>> {
        panic!("not used in ingest tests")
    }

    async fn get_system_page(&self, _slug: &str) -> anyhow::Result<Option<SystemPage>> {
        panic!("not used in ingest tests")
    }

    async fn export_wiki_snapshot(
        &self,
        _request: ExportWikiSnapshotRequest,
    ) -> anyhow::Result<ExportWikiSnapshotResponse> {
        panic!("not used in ingest tests")
    }

    async fn fetch_wiki_updates(
        &self,
        _request: FetchWikiUpdatesRequest,
    ) -> anyhow::Result<FetchWikiUpdatesResponse> {
        panic!("not used in ingest tests")
    }

    async fn commit_wiki_changes(
        &self,
        _request: CommitWikiChangesRequest,
    ) -> anyhow::Result<CommitWikiChangesResponse> {
        panic!("not used in ingest tests")
    }
}

#[tokio::test]
async fn ingest_source_creates_markdown_source_with_heading_title() {
    let dir = tempdir().unwrap();
    let input = dir.path().join("alpha.md");
    std::fs::write(&input, "# Alpha\n\nBody.\n").unwrap();
    let api = FakeApi::default();

    let response = ingest_sources(
        &api,
        IngestSourcesRequest {
            inputs: vec![input.clone()],
        },
    )
    .await
    .unwrap();

    assert_eq!(response.ingested.len(), 1);
    assert!(response.rejected.is_empty());
    let created = api.created_sources.lock().unwrap();
    assert_eq!(created.len(), 1);
    assert_eq!(created[0].source_type, "markdown_note");
    assert_eq!(created[0].mime_type.as_deref(), Some("text/markdown"));
    assert_eq!(created[0].title.as_deref(), Some("Alpha"));
    assert!(created[0].metadata_json.contains("alpha.md"));
}

#[tokio::test]
async fn ingest_source_uses_file_stem_when_heading_is_missing() {
    let dir = tempdir().unwrap();
    let input = dir.path().join("agent-memory.md");
    std::fs::write(&input, "Body.\n").unwrap();
    let api = FakeApi::default();

    let response = ingest_sources(
        &api,
        IngestSourcesRequest {
            inputs: vec![input],
        },
    )
    .await
    .unwrap();

    assert_eq!(response.ingested[0].title, "Agent Memory");
}

#[tokio::test]
async fn ingest_source_rejects_non_markdown_and_empty_files() {
    let dir = tempdir().unwrap();
    let text_input = dir.path().join("alpha.txt");
    let empty_md = dir.path().join("empty.md");
    std::fs::write(&text_input, "# Alpha\n").unwrap();
    std::fs::write(&empty_md, " \n").unwrap();

    let response = ingest_sources(
        &FakeApi::default(),
        IngestSourcesRequest {
            inputs: vec![text_input, empty_md],
        },
    )
    .await
    .unwrap();

    assert!(response.ingested.is_empty());
    assert_eq!(response.rejected.len(), 2);
}

#[tokio::test]
async fn ingest_source_reports_partial_failure() {
    let dir = tempdir().unwrap();
    let alpha = dir.path().join("alpha.md");
    let beta = dir.path().join("beta.md");
    std::fs::write(&alpha, "# Alpha\n\nBody.\n").unwrap();
    std::fs::write(&beta, "# Beta\n\nBody.\n").unwrap();

    let duplicate_sha = {
        use sha2::{Digest, Sha256};
        hex::encode(Sha256::digest(b"# Beta\n\nBody.\n"))
    };
    let api = FakeApi {
        duplicate_sha: Some(duplicate_sha),
        ..Default::default()
    };

    let response = ingest_sources(
        &api,
        IngestSourcesRequest {
            inputs: vec![alpha, beta],
        },
    )
    .await
    .unwrap();

    assert_eq!(response.ingested.len(), 1);
    assert_eq!(response.rejected.len(), 1);
}
