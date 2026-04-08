// Where: crates/wiki_cli/src/source_to_draft_tests.rs
// What: Tests for the source-to-draft wrapper flow.
// Why: The high-level source path should be deterministic and stop if source persistence fails.
use crate::client::WikiApi;
use crate::source_to_draft::{SourceToDraftRequest, source_to_draft};
use async_trait::async_trait;
use std::fs;
use std::sync::Mutex;
use tempfile::tempdir;
use wiki_types::{
    AdoptDraftPageInput, AdoptDraftPageOutput, CommitWikiChangesRequest, CommitWikiChangesResponse,
    CreateSourceInput, ExportWikiSnapshotRequest, ExportWikiSnapshotResponse,
    FetchWikiUpdatesRequest, FetchWikiUpdatesResponse, HealthCheckReport, PageBundle, SearchHit,
    SearchRequest, Status, SystemPage,
};

#[derive(Default)]
struct FakeApi {
    created_sources: Mutex<Vec<CreateSourceInput>>,
    duplicate_sha: Option<String>,
    search_hits: Vec<SearchHit>,
}

#[async_trait]
impl WikiApi for FakeApi {
    async fn adopt_draft_page(
        &self,
        _request: AdoptDraftPageInput,
    ) -> anyhow::Result<AdoptDraftPageOutput> {
        panic!("not used in source_to_draft tests")
    }

    async fn create_source(&self, request: CreateSourceInput) -> anyhow::Result<String> {
        if self.duplicate_sha.as_ref() == Some(&request.sha256) {
            anyhow::bail!("UNIQUE constraint failed: sources.sha256");
        }
        self.created_sources.lock().unwrap().push(request);
        Ok(format!(
            "source_{}",
            self.created_sources.lock().unwrap().len()
        ))
    }

    async fn lint_health(&self) -> anyhow::Result<HealthCheckReport> {
        panic!("not used in source_to_draft tests")
    }

    async fn status(&self) -> anyhow::Result<Status> {
        Ok(Status {
            page_count: 0,
            source_count: 0,
            system_page_count: 0,
        })
    }

    async fn search(&self, _request: SearchRequest) -> anyhow::Result<Vec<SearchHit>> {
        Ok(self.search_hits.clone())
    }

    async fn get_page(&self, _slug: &str) -> anyhow::Result<Option<PageBundle>> {
        Ok(None)
    }

    async fn get_system_page(&self, _slug: &str) -> anyhow::Result<Option<SystemPage>> {
        Ok(None)
    }

    async fn export_wiki_snapshot(
        &self,
        _request: ExportWikiSnapshotRequest,
    ) -> anyhow::Result<ExportWikiSnapshotResponse> {
        panic!("not used in source_to_draft tests")
    }

    async fn fetch_wiki_updates(
        &self,
        _request: FetchWikiUpdatesRequest,
    ) -> anyhow::Result<FetchWikiUpdatesResponse> {
        panic!("not used in source_to_draft tests")
    }

    async fn commit_wiki_changes(
        &self,
        _request: CommitWikiChangesRequest,
    ) -> anyhow::Result<CommitWikiChangesResponse> {
        panic!("not used in source_to_draft tests")
    }
}

#[tokio::test]
async fn source_to_draft_creates_drafts_without_persisting_sources() {
    let dir = tempdir().unwrap();
    let vault_path = dir.path().join("vault");
    let input = dir.path().join("alpha.md");
    fs::write(&input, "# Alpha\n\nBody.\n").unwrap();

    let response = source_to_draft(
        &FakeApi::default(),
        SourceToDraftRequest {
            vault_path: vault_path.clone(),
            mirror_root: "Wiki".to_string(),
            inputs: vec![input],
            persist_sources: false,
        },
    )
    .await
    .unwrap();

    assert!(response.persisted_sources.is_empty());
    assert!(response.rejected_sources.is_empty());
    assert_eq!(response.page_map.len(), 1);
    assert!(vault_path.join("Wiki/pages/alpha.md").exists());
}

#[tokio::test]
async fn source_to_draft_persists_sources_before_generating_drafts() {
    let dir = tempdir().unwrap();
    let vault_path = dir.path().join("vault");
    let input = dir.path().join("alpha.md");
    fs::write(&input, "# Alpha\n\nBody.\n").unwrap();
    let api = FakeApi::default();

    let response = source_to_draft(
        &api,
        SourceToDraftRequest {
            vault_path: vault_path.clone(),
            mirror_root: "Wiki".to_string(),
            inputs: vec![input],
            persist_sources: true,
        },
    )
    .await
    .unwrap();

    assert_eq!(response.persisted_sources.len(), 1);
    assert!(response.rejected_sources.is_empty());
    assert_eq!(api.created_sources.lock().unwrap().len(), 1);
    assert!(vault_path.join("Wiki/pages/alpha.md").exists());
}

#[tokio::test]
async fn source_to_draft_stops_when_source_ingest_fails() {
    let dir = tempdir().unwrap();
    let vault_path = dir.path().join("vault");
    let alpha = dir.path().join("alpha.md");
    let beta = dir.path().join("beta.md");
    fs::write(&alpha, "# Alpha\n\nBody.\n").unwrap();
    fs::write(&beta, "# Beta\n\nBody.\n").unwrap();

    let duplicate_sha = {
        use sha2::{Digest, Sha256};
        hex::encode(Sha256::digest(b"# Beta\n\nBody.\n"))
    };
    let api = FakeApi {
        duplicate_sha: Some(duplicate_sha),
        ..Default::default()
    };

    let response = source_to_draft(
        &api,
        SourceToDraftRequest {
            vault_path: vault_path.clone(),
            mirror_root: "Wiki".to_string(),
            inputs: vec![alpha, beta],
            persist_sources: true,
        },
    )
    .await
    .unwrap();

    assert_eq!(response.persisted_sources.len(), 1);
    assert_eq!(response.rejected_sources.len(), 1);
    assert!(response.page_map.is_empty());
    assert!(response.draft_results.is_empty());
    assert!(
        response.rejected_sources[0]
            .reason
            .contains("UNIQUE constraint failed")
    );
    assert!(!vault_path.join("Wiki/pages").exists());
}
