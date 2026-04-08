// Where: crates/wiki_canister/src/lib.rs
// What: ICP canister entrypoints backed directly by WikiService and SQLite over WASI.
// Why: The remote wiki should have one source-of-truth implementation and one search implementation.
use std::cell::RefCell;
use std::fs::create_dir_all;
use std::ops::Range;
use std::path::{Path, PathBuf};

use candid::export_service;
use ic_cdk::{init, post_upgrade, query, update};
use ic_stable_structures::DefaultMemoryImpl;
use ic_stable_structures::memory_manager::{MemoryId, MemoryManager};
use wiki_runtime::WikiService;
use wiki_types::{
    AdoptDraftPageInput, AdoptDraftPageOutput, CommitWikiChangesRequest, CommitWikiChangesResponse,
    CreateSourceInput, ExportWikiSnapshotRequest, ExportWikiSnapshotResponse,
    FetchWikiUpdatesRequest, FetchWikiUpdatesResponse, HealthCheckReport, PageBundle, SearchHit,
    SearchRequest, Status, SystemPage,
};

const DB_PATH: &str = "./DB/wiki.sqlite3";
const FS_MEMORY_RANGE: Range<u8> = 200..210;
const DB_MEMORY_ID: u8 = 210;

thread_local! {
    static MEMORY_MANAGER: RefCell<MemoryManager<DefaultMemoryImpl>> =
        RefCell::new(MemoryManager::init(DefaultMemoryImpl::default()));
    static SERVICE: RefCell<Option<WikiService>> = const { RefCell::new(None) };
}

#[init]
fn init_hook() {
    initialize_or_trap();
}

#[post_upgrade]
fn post_upgrade_hook() {
    initialize_or_trap();
}

#[query]
fn status() -> Status {
    with_service(|service| service.status()).unwrap_or_else(|error| ic_cdk::trap(&error))
}

#[query]
fn search(request: SearchRequest) -> Result<Vec<SearchHit>, String> {
    with_service(|service| service.search(request))
}

#[query]
fn get_page(slug: String) -> Result<Option<PageBundle>, String> {
    with_service(|service| service.get_page(&slug))
}

#[query]
fn get_system_page(slug: String) -> Result<Option<SystemPage>, String> {
    with_service(|service| service.get_system_page(&slug))
}

#[query]
fn lint_health() -> Result<HealthCheckReport, String> {
    with_service(|service| service.lint_health())
}

#[query]
fn export_wiki_snapshot(
    request: ExportWikiSnapshotRequest,
) -> Result<ExportWikiSnapshotResponse, String> {
    with_service(|service| service.export_wiki_snapshot(request))
}

#[query]
fn fetch_wiki_updates(
    request: FetchWikiUpdatesRequest,
) -> Result<FetchWikiUpdatesResponse, String> {
    with_service(|service| service.fetch_wiki_updates(request))
}

#[update]
fn commit_wiki_changes(
    request: CommitWikiChangesRequest,
) -> Result<CommitWikiChangesResponse, String> {
    with_service(|service| service.commit_wiki_changes(request))
}

#[update]
fn adopt_draft_page(request: AdoptDraftPageInput) -> Result<AdoptDraftPageOutput, String> {
    with_service(|service| service.adopt_draft_page(request, now_millis()))
}

#[update]
fn create_source(request: CreateSourceInput) -> Result<String, String> {
    with_service(|service| service.create_source(request))
}

fn initialize_or_trap() {
    initialize_service().unwrap_or_else(|error| ic_cdk::trap(&error));
}

fn initialize_service() -> Result<(), String> {
    initialize_wasi_storage()?;
    let service = WikiService::new(PathBuf::from(DB_PATH));
    service.run_migrations()?;
    ensure_system_pages_exist(&service)?;
    SERVICE.with(|slot| *slot.borrow_mut() = Some(service));
    Ok(())
}

fn ensure_system_pages_exist(service: &WikiService) -> Result<(), String> {
    let index_page = service.get_system_page("index.md")?;
    let log_page = service.get_system_page("log.md")?;
    if index_page.is_some() && log_page.is_some() {
        return Ok(());
    }

    let updated_at = index_page
        .iter()
        .chain(log_page.iter())
        .map(|page| page.updated_at)
        .max()
        .unwrap_or(0);
    service.refresh_system_pages(updated_at)?;
    Ok(())
}

fn initialize_wasi_storage() -> Result<(), String> {
    MEMORY_MANAGER.with(|manager| {
        let manager = manager.borrow();
        ic_wasi_polyfill::init_with_memory_manager(
            &[0u8; 32],
            &[("SQLITE_TMPDIR", "tmp")],
            &manager,
            FS_MEMORY_RANGE.clone(),
        );

        create_dir_all("tmp").map_err(|error| error.to_string())?;
        let db_parent = Path::new(DB_PATH)
            .parent()
            .ok_or_else(|| "database path is missing parent directory".to_string())?;
        create_dir_all(db_parent).map_err(|error| error.to_string())?;

        ic_wasi_polyfill::unmount_memory_file(DB_PATH);
        let memory = manager.get(MemoryId::new(DB_MEMORY_ID));
        let mount_result = ic_wasi_polyfill::mount_memory_file(
            DB_PATH,
            Box::new(memory),
            ic_wasi_polyfill::MountedFileSizePolicy::MemoryPages,
        );
        if mount_result > 0 {
            return Err(format!("failed to mount database file: {mount_result}"));
        }
        Ok(())
    })
}

fn now_millis() -> i64 {
    (ic_cdk::api::time() / 1_000_000) as i64
}

fn with_service<T, F>(f: F) -> Result<T, String>
where
    F: FnOnce(&WikiService) -> Result<T, String>,
{
    SERVICE.with(|slot| {
        let borrowed = slot.borrow();
        let service = borrowed
            .as_ref()
            .ok_or_else(|| "wiki service is not initialized".to_string())?;
        f(service)
    })
}

export_service!();

pub fn candid_interface() -> String {
    __export_service()
}

#[cfg(test)]
mod tests {
    use crate::ensure_system_pages_exist;
    use std::path::PathBuf;

    use tempfile::tempdir;
    use wiki_runtime::WikiService;
    use wiki_types::{
        AdoptDraftPageInput, CommitPageRevisionInput, CreatePageInput, CreateSourceInput,
        ExportWikiSnapshotRequest, HealthIssueKind, SearchRequest, WikiPageType,
    };

    fn create_service() -> WikiService {
        let dir = tempdir().expect("tempdir should create");
        let db_path = PathBuf::from(dir.keep()).join("wiki.sqlite3");
        let service = WikiService::new(db_path);
        service.run_migrations().expect("migrations should run");
        ensure_system_pages_exist(&service).expect("system pages should exist");
        service
    }

    #[test]
    fn empty_store_exposes_system_pages() {
        let service = create_service();

        assert!(
            service
                .status()
                .expect("status should load")
                .system_page_count
                >= 2
        );
        assert!(
            service
                .get_system_page("index.md")
                .expect("index should load")
                .is_some()
        );
        assert!(
            service
                .get_system_page("log.md")
                .expect("log should load")
                .is_some()
        );
    }

    #[test]
    fn get_page_and_search_use_runtime_store() {
        let service = create_service();
        let page_id = service
            .create_page(CreatePageInput {
                slug: "alpha".to_string(),
                page_type: WikiPageType::Overview,
                title: "Alpha".to_string(),
                created_at: 10,
            })
            .expect("page should create");
        service
            .commit_page_revision(CommitPageRevisionInput {
                page_id,
                expected_current_revision_id: None,
                title: "Alpha".to_string(),
                markdown: "# Alpha\n\nagent memory body".to_string(),
                change_reason: "seed".to_string(),
                author_type: "test".to_string(),
                tags: Vec::new(),
                updated_at: 11,
            })
            .expect("revision should commit");

        let page = service
            .get_page("alpha")
            .expect("page query should succeed")
            .expect("page should exist");
        assert_eq!(page.slug, "alpha");

        let hits = service
            .search(SearchRequest {
                query_text: "memory".to_string(),
                page_types: Vec::new(),
                top_k: 5,
            })
            .expect("search should succeed");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].slug, "alpha");
    }

    #[test]
    fn lint_health_uses_runtime_store() {
        let service = create_service();
        let page_id = service
            .create_page(CreatePageInput {
                slug: "orphan".to_string(),
                page_type: WikiPageType::Entity,
                title: "Orphan".to_string(),
                created_at: 10,
            })
            .expect("page should create");
        service
            .commit_page_revision(CommitPageRevisionInput {
                page_id,
                expected_current_revision_id: None,
                title: "Orphan".to_string(),
                markdown: "# Orphan\n\nplain claim".to_string(),
                change_reason: "seed".to_string(),
                author_type: "test".to_string(),
                tags: Vec::new(),
                updated_at: 11,
            })
            .expect("revision should commit");

        let report = service.lint_health().expect("lint should succeed");
        assert!(report.issues.iter().any(|issue| {
            issue.kind == HealthIssueKind::OrphanPage
                && issue.page_slug.as_deref() == Some("orphan")
        }));
    }

    #[test]
    fn snapshot_api_runs_against_sqlite_store() {
        let service = create_service();

        let snapshot = service
            .export_wiki_snapshot(ExportWikiSnapshotRequest {
                include_system_pages: true,
                page_slugs: None,
            })
            .expect("snapshot should export");

        assert_eq!(snapshot.pages.len(), 0);
        assert!(
            snapshot
                .system_pages
                .iter()
                .any(|page| page.slug == "index.md")
        );
        assert!(
            snapshot
                .system_pages
                .iter()
                .any(|page| page.slug == "log.md")
        );
    }

    #[test]
    fn ensure_system_pages_exist_does_not_rewrite_existing_pages() {
        let service = create_service();
        service
            .refresh_system_pages(42)
            .expect("system pages should refresh once");

        ensure_system_pages_exist(&service).expect("existing pages should be left alone");

        let index_page = service
            .get_system_page("index.md")
            .expect("index should load")
            .expect("index should exist");
        let log_page = service
            .get_system_page("log.md")
            .expect("log should load")
            .expect("log should exist");
        assert_eq!(index_page.updated_at, 42);
        assert_eq!(log_page.updated_at, 42);
    }

    #[test]
    fn adopt_draft_page_is_atomic_and_rejects_duplicate_slug() {
        let service = create_service();

        let adopted = service
            .adopt_draft_page(
                AdoptDraftPageInput {
                    slug: "draft-alpha".to_string(),
                    title: "Draft Alpha".to_string(),
                    page_type: WikiPageType::Entity,
                    markdown: "# Draft Alpha\n\nBody.".to_string(),
                },
                20,
            )
            .expect("draft should adopt");
        assert_eq!(adopted.slug, "draft-alpha");
        assert!(adopted.index_markdown.contains("draft-alpha"));
        assert!(adopted.log_markdown.contains("Draft Alpha"));

        let duplicate = service.adopt_draft_page(
            AdoptDraftPageInput {
                slug: "draft-alpha".to_string(),
                title: "Duplicate".to_string(),
                page_type: WikiPageType::Entity,
                markdown: "# Duplicate\n\nBody.".to_string(),
            },
            21,
        );
        assert!(duplicate.is_err());
    }

    #[test]
    fn create_source_uses_runtime_store_and_rejects_duplicate_sha() {
        let service = create_service();

        let source_id = service
            .create_source(CreateSourceInput {
                source_type: "markdown_note".to_string(),
                title: Some("Alpha".to_string()),
                canonical_uri: None,
                sha256: "sha-alpha".to_string(),
                mime_type: Some("text/markdown".to_string()),
                imported_at: 10,
                metadata_json: "{}".to_string(),
                body_text: "# Alpha\n\nBody.".to_string(),
            })
            .expect("source should create");
        assert!(!source_id.is_empty());

        let duplicate = service.create_source(CreateSourceInput {
            source_type: "markdown_note".to_string(),
            title: Some("Alpha".to_string()),
            canonical_uri: None,
            sha256: "sha-alpha".to_string(),
            mime_type: Some("text/markdown".to_string()),
            imported_at: 11,
            metadata_json: "{}".to_string(),
            body_text: "# Alpha\n\nBody.".to_string(),
        });
        assert!(duplicate.is_err());
    }
}
