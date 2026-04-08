// Where: crates/wiki_cli/src/query_page_tests.rs
// What: Tests for query-to-page draft generation.
// Why: Query results should become deterministic, adoptable draft pages.
use crate::client::WikiApi;
use crate::query_page::{QueryToPageRequest, query_to_page};
use async_trait::async_trait;
use std::fs;
use tempfile::tempdir;
use wiki_types::{
    AdoptDraftPageInput, AdoptDraftPageOutput, CommitWikiChangesRequest, CommitWikiChangesResponse,
    CreateSourceInput, ExportWikiSnapshotRequest, ExportWikiSnapshotResponse,
    FetchWikiUpdatesRequest, FetchWikiUpdatesResponse, HealthCheckReport, PageBundle, SearchHit,
    SearchRequest, Status, SystemPage, WikiPageType,
};

#[derive(Default)]
struct FakeApi {
    search_hits: Vec<SearchHit>,
    pages: Vec<PageBundle>,
}

#[async_trait]
impl WikiApi for FakeApi {
    async fn adopt_draft_page(
        &self,
        _request: AdoptDraftPageInput,
    ) -> anyhow::Result<AdoptDraftPageOutput> {
        panic!("not used in query page tests")
    }

    async fn create_source(&self, _request: CreateSourceInput) -> anyhow::Result<String> {
        panic!("not used in query page tests")
    }

    async fn lint_health(&self) -> anyhow::Result<HealthCheckReport> {
        panic!("not used in query page tests")
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

    async fn get_page(&self, slug: &str) -> anyhow::Result<Option<PageBundle>> {
        Ok(self.pages.iter().find(|page| page.slug == slug).cloned())
    }

    async fn get_system_page(&self, _slug: &str) -> anyhow::Result<Option<SystemPage>> {
        Ok(None)
    }

    async fn export_wiki_snapshot(
        &self,
        _request: ExportWikiSnapshotRequest,
    ) -> anyhow::Result<ExportWikiSnapshotResponse> {
        panic!("not used in query page tests")
    }

    async fn fetch_wiki_updates(
        &self,
        _request: FetchWikiUpdatesRequest,
    ) -> anyhow::Result<FetchWikiUpdatesResponse> {
        panic!("not used in query page tests")
    }

    async fn commit_wiki_changes(
        &self,
        _request: CommitWikiChangesRequest,
    ) -> anyhow::Result<CommitWikiChangesResponse> {
        panic!("not used in query page tests")
    }
}

#[tokio::test]
async fn query_to_page_creates_query_note_draft() {
    let dir = tempdir().unwrap();
    let vault_path = dir.path().join("vault");
    let input_path = dir.path().join("result.md");
    fs::write(
        &input_path,
        "## Finding\n\nThe agent synthesized a result.\n",
    )
    .unwrap();

    let response = query_to_page(
        &FakeApi::default(),
        QueryToPageRequest {
            vault_path: vault_path.clone(),
            mirror_root: "Wiki".to_string(),
            input: input_path,
            title: "Agent Memory Findings".to_string(),
            slug: None,
            page_type: None,
        },
    )
    .await
    .unwrap();

    assert_eq!(response.slug, "agent-memory-findings");
    assert_eq!(response.page_type, WikiPageType::QueryNote);
    let page = fs::read_to_string(vault_path.join("Wiki/pages/agent-memory-findings.md")).unwrap();
    assert!(page.contains("draft: true"));
    assert!(page.contains("page_type: query_note"));
    assert!(page.contains("## Query Result"));
}

#[tokio::test]
async fn query_to_page_respects_explicit_comparison_type() {
    let dir = tempdir().unwrap();
    let vault_path = dir.path().join("vault");
    let input_path = dir.path().join("compare.md");
    fs::write(&input_path, "# Old Heading\n\nTradeoff body.\n").unwrap();

    let response = query_to_page(
        &FakeApi::default(),
        QueryToPageRequest {
            vault_path: vault_path.clone(),
            mirror_root: "Wiki".to_string(),
            input: input_path,
            title: "Sync vs RAG".to_string(),
            slug: Some("sync-vs-rag-review".to_string()),
            page_type: Some(WikiPageType::Comparison),
        },
    )
    .await
    .unwrap();

    assert_eq!(response.page_type, WikiPageType::Comparison);
    let page = fs::read_to_string(vault_path.join("Wiki/pages/sync-vs-rag-review.md")).unwrap();
    assert!(page.contains("# Sync vs RAG"));
    assert!(!page.contains("# Old Heading"));
}

#[tokio::test]
async fn query_to_page_rejects_managed_slug_collision() {
    let dir = tempdir().unwrap();
    let vault_path = dir.path().join("vault");
    let pages_dir = vault_path.join("Wiki/pages");
    fs::create_dir_all(&pages_dir).unwrap();
    fs::write(
        pages_dir.join("existing.md"),
        "---\npage_id: page_1\nslug: existing\npage_type: entity\nrevision_id: rev_1\nupdated_at: 1\nmirror: true\n---\n\n# Existing\n",
    )
    .unwrap();
    let input_path = dir.path().join("result.md");
    fs::write(&input_path, "Body.\n").unwrap();

    let error = query_to_page(
        &FakeApi::default(),
        QueryToPageRequest {
            vault_path,
            mirror_root: "Wiki".to_string(),
            input: input_path,
            title: "Existing".to_string(),
            slug: Some("existing".to_string()),
            page_type: None,
        },
    )
    .await
    .unwrap_err();

    assert!(
        error
            .to_string()
            .contains("tracked local mirror page already exists")
    );
}

#[tokio::test]
async fn query_to_page_rejects_remote_exact_slug_collision() {
    let dir = tempdir().unwrap();
    let vault_path = dir.path().join("vault");
    let input_path = dir.path().join("result.md");
    fs::write(&input_path, "Body.\n").unwrap();

    let error = query_to_page(
        &FakeApi {
            search_hits: vec![SearchHit {
                slug: "existing-remote".to_string(),
                title: "Existing Remote".to_string(),
                page_type: WikiPageType::Entity,
                section_path: None,
                snippet: "snippet".to_string(),
                score: 1.0,
                match_reasons: vec!["slug".to_string()],
            }],
            pages: vec![PageBundle {
                page_id: "page_existing_remote".to_string(),
                slug: "existing-remote".to_string(),
                title: "Existing Remote".to_string(),
                page_type: "entity".to_string(),
                current_revision_id: "rev_existing_remote".to_string(),
                markdown: "# Existing Remote\n\nRemote body.\n".to_string(),
                sections: Vec::new(),
                updated_at: 1,
            }],
        },
        QueryToPageRequest {
            vault_path: vault_path.clone(),
            mirror_root: "Wiki".to_string(),
            input: input_path,
            title: "Existing Remote".to_string(),
            slug: Some("existing-remote".to_string()),
            page_type: None,
        },
    )
    .await
    .unwrap_err();

    assert!(
        error
            .to_string()
            .contains("remote page already exists with slug")
    );
    assert!(!vault_path.join("Wiki/pages/existing-remote.md").exists());
}

#[tokio::test]
async fn query_to_page_reports_remote_collisions_and_local_title_duplicates() {
    let dir = tempdir().unwrap();
    let vault_path = dir.path().join("vault");
    let pages_dir = vault_path.join("Wiki/pages");
    fs::create_dir_all(&pages_dir).unwrap();
    fs::write(
        pages_dir.join("other.md"),
        "---\nslug: other\ntitle: Shared Title\npage_type: query_note\ndraft: true\n---\n\n# Shared Title\n",
    )
    .unwrap();
    let input_path = dir.path().join("result.md");
    fs::write(&input_path, "Body.\n").unwrap();

    let response = query_to_page(
        &FakeApi {
            search_hits: vec![SearchHit {
                slug: "remote-alpha".to_string(),
                title: "Shared Title".to_string(),
                page_type: WikiPageType::Entity,
                section_path: None,
                snippet: "snippet".to_string(),
                score: 1.0,
                match_reasons: vec!["title".to_string()],
            }],
            pages: vec![PageBundle {
                page_id: "page_remote_alpha".to_string(),
                slug: "remote-alpha".to_string(),
                title: "Shared Title".to_string(),
                page_type: "entity".to_string(),
                current_revision_id: "rev_remote_alpha".to_string(),
                markdown: "# Shared Title\n\nRemote body.\n".to_string(),
                sections: Vec::new(),
                updated_at: 1,
            }],
        },
        QueryToPageRequest {
            vault_path,
            mirror_root: "Wiki".to_string(),
            input: input_path,
            title: "Shared Title".to_string(),
            slug: Some("new-query".to_string()),
            page_type: None,
        },
    )
    .await
    .unwrap();

    assert!(
        response
            .open_questions
            .iter()
            .any(|value| value.contains("title collision in local drafts"))
    );
    assert!(
        response
            .open_questions
            .iter()
            .any(|value| value.contains("title collision with remote page"))
    );
    let page = fs::read_to_string(dir.path().join("vault/Wiki/pages/new-query.md")).unwrap();
    assert!(page.contains("[[remote-alpha]]"));
}

#[tokio::test]
async fn query_to_page_reports_specific_remote_overlap_and_related_page() {
    let dir = tempdir().unwrap();
    let vault_path = dir.path().join("vault");
    let input_path = dir.path().join("result.md");
    fs::write(
        &input_path,
        "The draft overlaps with an existing memory page.\n",
    )
    .unwrap();

    let response = query_to_page(
        &FakeApi {
            search_hits: vec![SearchHit {
                slug: "existing-memory".to_string(),
                title: "Existing Memory".to_string(),
                page_type: WikiPageType::QueryNote,
                section_path: None,
                snippet: "existing note".to_string(),
                score: 1.0,
                match_reasons: vec!["body".to_string()],
            }],
            pages: vec![PageBundle {
                page_id: "page_existing_memory".to_string(),
                slug: "existing-memory".to_string(),
                title: "Existing Memory".to_string(),
                page_type: "query_note".to_string(),
                current_revision_id: "rev_existing_memory".to_string(),
                markdown: "# Existing Memory\n\nRemote body.\n".to_string(),
                sections: Vec::new(),
                updated_at: 1,
            }],
        },
        QueryToPageRequest {
            vault_path: vault_path.clone(),
            mirror_root: "Wiki".to_string(),
            input: input_path,
            title: "Fresh Investigation".to_string(),
            slug: Some("fresh-investigation".to_string()),
            page_type: None,
        },
    )
    .await
    .unwrap();

    assert!(
        response
            .open_questions
            .iter()
            .any(|value| value.contains("possible overlap with remote page: existing-memory"))
    );
    let page = fs::read_to_string(vault_path.join("Wiki/pages/fresh-investigation.md")).unwrap();
    assert!(page.contains("## Related Pages"));
    assert!(page.contains("[[existing-memory]]"));
}
