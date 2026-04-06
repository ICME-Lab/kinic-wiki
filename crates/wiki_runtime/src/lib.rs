// Where: crates/wiki_runtime/src/lib.rs
// What: Service-level orchestration for the wiki store.
// Why: Higher layers need one object that coordinates source-of-truth writes and rendered system pages.
use std::path::PathBuf;

use wiki_store::WikiStore;
use wiki_types::{
    CommitPageRevisionInput, CommitPageRevisionOutput, CreatePageInput, CreateSourceInput,
    LogEvent, PageBundle, SearchHit, SearchRequest, Status, SystemPage,
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

    pub fn get_recent_log(&self, limit: usize) -> Result<Vec<LogEvent>, String> {
        self.store.get_recent_log(limit)
    }

    pub fn status(&self) -> Result<Status, String> {
        self.store.status()
    }
}
