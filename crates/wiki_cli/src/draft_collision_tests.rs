// Where: crates/wiki_cli/src/draft_collision_tests.rs
// What: Regression tests for slug collisions during draft generation flows.
// Why: Duplicate slugs must fail before any local draft file is overwritten.
use crate::cli::{GenerateModeArg, GenerateOutputArg};
use crate::client::WikiApi;
use crate::generate::{GenerateDraftRequest, generate_draft};
use crate::source_to_draft::{SourceToDraftRequest, source_to_draft};
use async_trait::async_trait;
use std::fs;
use tempfile::tempdir;
use wiki_types::{
    AdoptDraftPageInput, AdoptDraftPageOutput, CommitWikiChangesRequest, CommitWikiChangesResponse,
    CreateSourceInput, ExportWikiSnapshotRequest, ExportWikiSnapshotResponse,
    FetchWikiUpdatesRequest, FetchWikiUpdatesResponse, HealthCheckReport, PageBundle, SearchHit,
    SearchRequest, Status, SystemPage,
};

#[derive(Default)]
struct FakeApi;

#[async_trait]
impl WikiApi for FakeApi {
    async fn adopt_draft_page(
        &self,
        _request: AdoptDraftPageInput,
    ) -> anyhow::Result<AdoptDraftPageOutput> {
        panic!("not used in collision tests")
    }

    async fn create_source(&self, _request: CreateSourceInput) -> anyhow::Result<String> {
        Ok("source_1".to_string())
    }

    async fn lint_health(&self) -> anyhow::Result<HealthCheckReport> {
        panic!("not used in collision tests")
    }

    async fn status(&self) -> anyhow::Result<Status> {
        panic!("not used in collision tests")
    }

    async fn search(&self, _request: SearchRequest) -> anyhow::Result<Vec<SearchHit>> {
        Ok(Vec::new())
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
        panic!("not used in collision tests")
    }

    async fn fetch_wiki_updates(
        &self,
        _request: FetchWikiUpdatesRequest,
    ) -> anyhow::Result<FetchWikiUpdatesResponse> {
        panic!("not used in collision tests")
    }

    async fn commit_wiki_changes(
        &self,
        _request: CommitWikiChangesRequest,
    ) -> anyhow::Result<CommitWikiChangesResponse> {
        panic!("not used in collision tests")
    }
}

#[tokio::test]
async fn generate_draft_fails_before_writing_when_slug_collides() {
    let dir = tempdir().unwrap();
    let vault_path = dir.path().join("vault");
    let docs_dir = dir.path().join("docs");
    let notes_dir = dir.path().join("notes");
    fs::create_dir_all(&docs_dir).unwrap();
    fs::create_dir_all(&notes_dir).unwrap();
    let alpha_docs = docs_dir.join("alpha.md");
    let alpha_notes = notes_dir.join("alpha.md");
    fs::write(&alpha_docs, "# Alpha Doc\n\nBody.\n").unwrap();
    fs::write(&alpha_notes, "# Alpha Note\n\nBody.\n").unwrap();

    let error = generate_draft(
        &FakeApi,
        GenerateDraftRequest {
            vault_path: vault_path.clone(),
            mirror_root: "Wiki".to_string(),
            inputs: vec![alpha_docs.clone(), alpha_notes.clone()],
            mode: GenerateModeArg::Direct,
            output: GenerateOutputArg::LocalDraft,
        },
    )
    .await
    .unwrap_err();

    assert!(error.to_string().contains("duplicate slug generated"));
    assert!(error.to_string().contains("alpha"));
    assert!(
        error
            .to_string()
            .contains(&alpha_docs.display().to_string())
    );
    assert!(
        error
            .to_string()
            .contains(&alpha_notes.display().to_string())
    );
    assert!(!vault_path.join("Wiki/pages/alpha.md").exists());
}

#[tokio::test]
async fn source_to_draft_fails_without_creating_local_drafts_on_slug_collision() {
    let dir = tempdir().unwrap();
    let vault_path = dir.path().join("vault");
    let docs_dir = dir.path().join("docs");
    let notes_dir = dir.path().join("notes");
    fs::create_dir_all(&docs_dir).unwrap();
    fs::create_dir_all(&notes_dir).unwrap();
    let alpha_docs = docs_dir.join("alpha.md");
    let alpha_notes = notes_dir.join("alpha.md");
    fs::write(&alpha_docs, "# Alpha Doc\n\nBody.\n").unwrap();
    fs::write(&alpha_notes, "# Alpha Note\n\nBody.\n").unwrap();

    let error = source_to_draft(
        &FakeApi,
        SourceToDraftRequest {
            vault_path: vault_path.clone(),
            mirror_root: "Wiki".to_string(),
            inputs: vec![alpha_docs, alpha_notes],
            persist_sources: false,
        },
    )
    .await
    .unwrap_err();

    assert!(error.to_string().contains("duplicate slug generated"));
    assert!(!vault_path.join("Wiki/pages").exists());
}
