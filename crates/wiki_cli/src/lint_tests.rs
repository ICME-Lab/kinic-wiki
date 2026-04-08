// Where: crates/wiki_cli/src/lint_tests.rs
// What: Tests for report-only lint command behavior.
// Why: The lint CLI should surface deterministic health issues without mutating wiki state.
use crate::client::WikiApi;
use crate::lint::lint;
use async_trait::async_trait;
use wiki_types::{
    AdoptDraftPageInput, AdoptDraftPageOutput, CommitWikiChangesRequest, CommitWikiChangesResponse,
    CreateSourceInput, ExportWikiSnapshotRequest, ExportWikiSnapshotResponse,
    FetchWikiUpdatesRequest, FetchWikiUpdatesResponse, HealthCheckReport, HealthIssue,
    HealthIssueKind, PageBundle, SearchHit, SearchRequest, Status, SystemPage,
};

struct FakeApi {
    report: HealthCheckReport,
}

#[async_trait]
impl WikiApi for FakeApi {
    async fn adopt_draft_page(
        &self,
        _request: AdoptDraftPageInput,
    ) -> anyhow::Result<AdoptDraftPageOutput> {
        panic!("not used in lint tests")
    }

    async fn create_source(&self, _request: CreateSourceInput) -> anyhow::Result<String> {
        panic!("not used in lint tests")
    }

    async fn lint_health(&self) -> anyhow::Result<HealthCheckReport> {
        Ok(self.report.clone())
    }

    async fn status(&self) -> anyhow::Result<Status> {
        panic!("not used in lint tests")
    }

    async fn search(&self, _request: SearchRequest) -> anyhow::Result<Vec<SearchHit>> {
        panic!("not used in lint tests")
    }

    async fn get_page(&self, _slug: &str) -> anyhow::Result<Option<PageBundle>> {
        panic!("not used in lint tests")
    }

    async fn get_system_page(&self, _slug: &str) -> anyhow::Result<Option<SystemPage>> {
        panic!("not used in lint tests")
    }

    async fn export_wiki_snapshot(
        &self,
        _request: ExportWikiSnapshotRequest,
    ) -> anyhow::Result<ExportWikiSnapshotResponse> {
        panic!("not used in lint tests")
    }

    async fn fetch_wiki_updates(
        &self,
        _request: FetchWikiUpdatesRequest,
    ) -> anyhow::Result<FetchWikiUpdatesResponse> {
        panic!("not used in lint tests")
    }

    async fn commit_wiki_changes(
        &self,
        _request: CommitWikiChangesRequest,
    ) -> anyhow::Result<CommitWikiChangesResponse> {
        panic!("not used in lint tests")
    }
}

#[tokio::test]
async fn lint_returns_health_report() {
    let report = lint(&FakeApi {
        report: HealthCheckReport {
            issues: vec![HealthIssue {
                kind: HealthIssueKind::OrphanPage,
                page_slug: Some("orphan".to_string()),
                section_path: None,
                message: "page is not linked from any other page".to_string(),
            }],
        },
    })
    .await
    .unwrap();

    assert_eq!(report.issues.len(), 1);
    assert_eq!(report.issues[0].page_slug.as_deref(), Some("orphan"));
}
