// Where: crates/wiki_cli/src/commands_tests.rs
// What: Tests for CLI command handlers.
// Why: Keep the command implementation file focused on production behavior.
use crate::client::WikiApi;
use crate::commands::{pull, push};
use crate::mirror::{MirrorState, save_state, write_snapshot_mirror};
use async_trait::async_trait;
use std::sync::Mutex;
use tempfile::tempdir;
use wiki_types::{
    CommitWikiChangesRequest, CommitWikiChangesResponse, ExportWikiSnapshotResponse,
    FetchWikiUpdatesResponse, PageBundle, RejectedPageResult, SearchHit, SearchRequest,
    SectionHashEntry, Status, SystemPage, SystemPageSnapshot, WikiPageSnapshot, WikiPageType,
    WikiSyncManifest, WikiSyncManifestDelta, WikiSyncManifestEntry,
};

#[derive(Default)]
struct FakeApi {
    search_hits: Vec<SearchHit>,
    page: Option<PageBundle>,
    system_page: Option<SystemPage>,
    snapshot: Option<ExportWikiSnapshotResponse>,
    fetch: Option<FetchWikiUpdatesResponse>,
    commit: Option<CommitWikiChangesResponse>,
    pushed: Mutex<Vec<CommitWikiChangesRequest>>,
}

#[async_trait]
impl WikiApi for FakeApi {
    async fn status(&self) -> anyhow::Result<Status> {
        Ok(Status {
            page_count: 1,
            source_count: 0,
            system_page_count: 2,
        })
    }

    async fn search(&self, _request: SearchRequest) -> anyhow::Result<Vec<SearchHit>> {
        Ok(self.search_hits.clone())
    }

    async fn get_page(&self, _slug: &str) -> anyhow::Result<Option<PageBundle>> {
        Ok(self.page.clone())
    }

    async fn get_system_page(&self, _slug: &str) -> anyhow::Result<Option<SystemPage>> {
        Ok(self.system_page.clone())
    }

    async fn export_wiki_snapshot(
        &self,
        _request: wiki_types::ExportWikiSnapshotRequest,
    ) -> anyhow::Result<ExportWikiSnapshotResponse> {
        Ok(self.snapshot.clone().unwrap())
    }

    async fn fetch_wiki_updates(
        &self,
        _request: wiki_types::FetchWikiUpdatesRequest,
    ) -> anyhow::Result<FetchWikiUpdatesResponse> {
        Ok(self.fetch.clone().unwrap())
    }

    async fn commit_wiki_changes(
        &self,
        request: CommitWikiChangesRequest,
    ) -> anyhow::Result<CommitWikiChangesResponse> {
        self.pushed.lock().unwrap().push(request);
        Ok(self.commit.clone().unwrap())
    }
}

#[tokio::test]
async fn pull_writes_mirror_files() {
    let dir = tempdir().unwrap();
    let mirror_root = dir.path().join("Wiki");
    let api = FakeApi {
        snapshot: Some(ExportWikiSnapshotResponse {
            snapshot_revision: "snapshot_1".into(),
            pages: vec![WikiPageSnapshot {
                page_id: "page_1".into(),
                slug: "alpha".into(),
                title: "Alpha".into(),
                page_type: WikiPageType::Overview,
                revision_id: "rev_1".into(),
                updated_at: 1,
                markdown: "# Alpha\n\nbody".into(),
                section_hashes: vec![SectionHashEntry {
                    section_path: "alpha".into(),
                    content_hash: "x".into(),
                }],
            }],
            system_pages: vec![SystemPageSnapshot {
                slug: "index.md".into(),
                markdown: "# Index".into(),
                updated_at: 1,
                etag: "e".into(),
            }],
            manifest: WikiSyncManifest {
                snapshot_revision: "snapshot_1".into(),
                pages: vec![],
            },
        }),
        ..Default::default()
    };
    pull(&api, &mirror_root).await.unwrap();
    assert!(mirror_root.join("pages/alpha.md").exists());
    assert!(mirror_root.join("index.md").exists());
}

#[tokio::test]
async fn push_sends_changed_managed_pages_and_writes_conflicts() {
    let dir = tempdir().unwrap();
    let mirror_root = dir.path().join("Wiki");
    std::fs::create_dir_all(mirror_root.join("pages")).unwrap();
    std::fs::write(
        mirror_root.join("pages/alpha.md"),
        "---\npage_id: page_1\nslug: alpha\npage_type: overview\nrevision_id: rev_1\nupdated_at: 1\nmirror: true\n---\n\n# Alpha\n\nlocal body\n",
    )
    .unwrap();
    save_state(
        &mirror_root,
        &MirrorState {
            snapshot_revision: "snapshot_1".into(),
            last_synced_at: 0,
        },
    )
    .unwrap();
    let api = FakeApi {
        commit: Some(CommitWikiChangesResponse {
            committed_pages: vec![],
            rejected_pages: vec![RejectedPageResult {
                page_id: "page_1".into(),
                reason: "conflict".into(),
                conflicting_section_paths: vec!["alpha".into()],
                local_changed_section_paths: vec!["alpha".into()],
                remote_changed_section_paths: vec!["alpha".into()],
                conflict_markdown: Some("<<<<<<< LOCAL\n".into()),
            }],
            snapshot_revision: "snapshot_2".into(),
            snapshot_was_stale: false,
            system_pages: vec![],
            manifest_delta: WikiSyncManifestDelta {
                upserted_pages: vec![WikiSyncManifestEntry {
                    page_id: "page_1".into(),
                    slug: "alpha".into(),
                    revision_id: "rev_2".into(),
                    updated_at: 2,
                }],
                removed_page_ids: vec![],
            },
        }),
        ..Default::default()
    };
    push(&api, &mirror_root).await.unwrap();
    assert_eq!(api.pushed.lock().unwrap().len(), 1);
    assert!(mirror_root.join("conflicts/alpha.conflict.md").exists());
}

#[test]
fn incremental_system_page_write_keeps_links_to_unchanged_pages() {
    let dir = tempdir().unwrap();
    let mirror_root = dir.path().join("Wiki");

    write_snapshot_mirror(
        &mirror_root,
        &[WikiPageSnapshot {
            page_id: "page_beta".into(),
            slug: "beta".into(),
            title: "Beta".into(),
            page_type: WikiPageType::Entity,
            revision_id: "rev_beta".into(),
            updated_at: 1,
            markdown: "# Beta\n\nBody.\n".into(),
            section_hashes: vec![],
        }],
        &[],
    )
    .unwrap();

    write_snapshot_mirror(
        &mirror_root,
        &[],
        &[SystemPageSnapshot {
            slug: "index.md".into(),
            markdown: "# Index\n\nSee [Beta](pages/beta.md).\n".into(),
            updated_at: 2,
            etag: "etag".into(),
        }],
    )
    .unwrap();

    let index = std::fs::read_to_string(mirror_root.join("index.md")).unwrap();
    assert!(index.contains("[[beta]]"));
}
