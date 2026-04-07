// Where: crates/wiki_runtime/src/lib.rs
// What: Service-level orchestration for the wiki store.
// Why: Higher layers need one object that coordinates source-of-truth writes and rendered system pages.
use std::path::PathBuf;

use wiki_store::WikiStore;
use wiki_types::{
    AppendSourceChunkInput, BeginSourceUploadInput, CommitPageRevisionInput,
    CommitPageRevisionOutput, CommitWikiChangesRequest, CommitWikiChangesResponse, CreatePageInput,
    CreateSourceInput, ExportWikiSnapshotRequest, ExportWikiSnapshotResponse,
    FetchWikiUpdatesRequest, FetchWikiUpdatesResponse, FinalizeSourceUploadInput,
    FinalizeSourceUploadOutput, HealthCheckReport, LogEvent, PageBundle, SearchHit, SearchRequest,
    SourceUploadStatus, Status, SystemPage,
};

pub struct WikiService {
    store: WikiStore,
}

impl WikiService {
    pub fn new(database_path: PathBuf) -> Self {
        Self {
            store: WikiStore::new(database_path),
        }
    }

    pub fn run_migrations(&self) -> Result<(), String> {
        self.store.run_migrations()
    }

    pub fn create_page(&self, input: CreatePageInput) -> Result<String, String> {
        self.store.create_page(input)
    }

    pub fn create_source(&self, input: CreateSourceInput) -> Result<String, String> {
        self.store.create_source(input)
    }

    pub fn begin_source_upload(&self, input: BeginSourceUploadInput) -> Result<String, String> {
        self.store.begin_source_upload(input)
    }

    pub fn append_source_chunk(
        &self,
        input: AppendSourceChunkInput,
    ) -> Result<SourceUploadStatus, String> {
        self.store.append_source_chunk(input)
    }

    pub fn finalize_source_upload(
        &self,
        input: FinalizeSourceUploadInput,
    ) -> Result<FinalizeSourceUploadOutput, String> {
        self.store.finalize_source_upload(input)
    }

    pub fn commit_page_revision(
        &self,
        input: CommitPageRevisionInput,
    ) -> Result<CommitPageRevisionOutput, String> {
        self.store.commit_page_revision(input)
    }

    pub fn get_page(&self, slug: &str) -> Result<Option<PageBundle>, String> {
        self.store.get_page_by_slug(slug)
    }

    pub fn get_system_page(&self, slug: &str) -> Result<Option<SystemPage>, String> {
        self.store.get_system_page(slug)
    }

    pub fn search(&self, request: SearchRequest) -> Result<Vec<SearchHit>, String> {
        self.store.search(request)
    }

    pub fn refresh_system_pages(&self, updated_at: i64) -> Result<Vec<SystemPage>, String> {
        self.store.refresh_system_pages(updated_at)
    }

    pub fn get_recent_log(&self, limit: usize) -> Result<Vec<LogEvent>, String> {
        self.store.get_recent_log(limit)
    }

    pub fn status(&self) -> Result<Status, String> {
        self.store.status()
    }

    pub fn lint_health(&self) -> Result<HealthCheckReport, String> {
        self.store.lint_health()
    }

    pub fn export_wiki_snapshot(
        &self,
        request: ExportWikiSnapshotRequest,
    ) -> Result<ExportWikiSnapshotResponse, String> {
        self.store.export_wiki_snapshot(request)
    }

    pub fn fetch_wiki_updates(
        &self,
        request: FetchWikiUpdatesRequest,
    ) -> Result<FetchWikiUpdatesResponse, String> {
        self.store.fetch_wiki_updates(request)
    }

    pub fn commit_wiki_changes(
        &self,
        request: CommitWikiChangesRequest,
    ) -> Result<CommitWikiChangesResponse, String> {
        self.store.commit_wiki_changes(request)
    }
}
