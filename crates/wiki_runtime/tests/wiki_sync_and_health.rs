use rusqlite::Connection;
use tempfile::tempdir;
use wiki_runtime::WikiService;
use wiki_types::{
    AppendSourceChunkInput, BeginSourceUploadInput, CommitPageRevisionInput,
    CommitWikiChangesRequest, CreatePageInput, ExportWikiSnapshotRequest, FetchWikiUpdatesRequest,
    FinalizeSourceUploadInput, HealthIssueKind, KnownPageRevision, PageChangeInput, PageChangeType,
    SearchRequest, WikiPageType,
};

fn new_service() -> (tempfile::TempDir, std::path::PathBuf, WikiService) {
    let dir = tempdir().expect("temp dir should exist");
    let db_path = dir.path().join("wiki.sqlite3");
    let service = WikiService::new(db_path.clone());
    service.run_migrations().expect("migrations should succeed");
    (dir, db_path, service)
}

#[test]
fn source_upload_flow_persists_joined_body() {
    let (_dir, db_path, service) = new_service();
    let upload_id = service
        .begin_source_upload(BeginSourceUploadInput {
            source_type: "article".to_string(),
            title: Some("Chunked Source".to_string()),
            canonical_uri: None,
            sha256: "chunked-source".to_string(),
            mime_type: Some("text/markdown".to_string()),
            imported_at: 1_700_000_000,
            metadata_json: "{}".to_string(),
        })
        .expect("upload should begin");

    let first = service
        .append_source_chunk(AppendSourceChunkInput {
            upload_id: upload_id.clone(),
            chunk_text: "hello ".to_string(),
        })
        .expect("first chunk should append");
    let second = service
        .append_source_chunk(AppendSourceChunkInput {
            upload_id: upload_id.clone(),
            chunk_text: "world".to_string(),
        })
        .expect("second chunk should append");
    assert_eq!(first.chunk_count, 1);
    assert_eq!(second.chunk_count, 2);
    assert_eq!(second.byte_count, 11);

    let output = service
        .finalize_source_upload(FinalizeSourceUploadInput { upload_id })
        .expect("upload should finalize");
    assert_eq!(output.chunk_count, 2);

    let conn = Connection::open(db_path).expect("db should open");
    let body = conn
        .query_row(
            "SELECT body_text FROM source_bodies WHERE source_id = ?1",
            [output.source_id],
            |row| row.get::<_, String>(0),
        )
        .expect("body should exist");
    let temp_count = conn
        .query_row("SELECT COUNT(*) FROM source_uploads", [], |row| {
            row.get::<_, i64>(0)
        })
        .expect("upload count should query");
    assert_eq!(body, "hello world");
    assert_eq!(temp_count, 0);
}

#[test]
fn lint_health_reports_orphan_unsupported_and_markers() {
    let (_dir, _db_path, service) = new_service();
    let orphan_page = service
        .create_page(CreatePageInput {
            slug: "orphan".to_string(),
            page_type: WikiPageType::Entity,
            title: "Orphan".to_string(),
            created_at: 1_700_000_000,
        })
        .expect("page should create");
    service
        .commit_page_revision(CommitPageRevisionInput {
            page_id: orphan_page,
            expected_current_revision_id: None,
            title: "Orphan".to_string(),
            markdown: "# Orphan\n\nplain claim".to_string(),
            change_reason: "seed".to_string(),
            author_type: "test".to_string(),
            tags: Vec::new(),
            updated_at: 1_700_000_001,
        })
        .expect("revision should commit");

    let marker_page = service
        .create_page(CreatePageInput {
            slug: "marker".to_string(),
            page_type: WikiPageType::Concept,
            title: "Marker".to_string(),
            created_at: 1_700_000_000,
        })
        .expect("page should create");
    service
        .commit_page_revision(CommitPageRevisionInput {
            page_id: marker_page,
            expected_current_revision_id: None,
            title: "Marker".to_string(),
            markdown: "# Marker\n\n[source: Alpha]\n\nThis is stale and contradiction prone."
                .to_string(),
            change_reason: "seed".to_string(),
            author_type: "test".to_string(),
            tags: Vec::new(),
            updated_at: 1_700_000_002,
        })
        .expect("revision should commit");

    let report = service.lint_health().expect("health should run");
    assert!(report.issues.iter().any(|issue| {
        issue.kind == HealthIssueKind::OrphanPage && issue.page_slug.as_deref() == Some("orphan")
    }));
    assert!(report.issues.iter().any(|issue| {
        issue.kind == HealthIssueKind::UnsupportedClaim
            && issue.page_slug.as_deref() == Some("orphan")
    }));
    assert!(report.issues.iter().any(|issue| {
        issue.kind == HealthIssueKind::Contradiction && issue.page_slug.as_deref() == Some("marker")
    }));
    assert!(report.issues.iter().any(|issue| {
        issue.kind == HealthIssueKind::StaleClaim && issue.page_slug.as_deref() == Some("marker")
    }));
}

#[test]
fn export_fetch_and_commit_sync_flow_work() {
    let (_dir, _db_path, service) = new_service();
    let page_id = service
        .create_page(CreatePageInput {
            slug: "sync-alpha".to_string(),
            page_type: WikiPageType::Overview,
            title: "Sync Alpha".to_string(),
            created_at: 1_700_000_000,
        })
        .expect("page should create");
    let first = service
        .commit_page_revision(CommitPageRevisionInput {
            page_id: page_id.clone(),
            expected_current_revision_id: None,
            title: "Sync Alpha".to_string(),
            markdown: "# Sync Alpha\n\nfirst body".to_string(),
            change_reason: "seed".to_string(),
            author_type: "test".to_string(),
            tags: Vec::new(),
            updated_at: 1_700_000_001,
        })
        .expect("revision should commit");

    let snapshot = service
        .export_wiki_snapshot(ExportWikiSnapshotRequest {
            include_system_pages: true,
            page_slugs: None,
        })
        .expect("snapshot should export");
    assert_eq!(snapshot.pages.len(), 1);
    assert_eq!(snapshot.pages[0].page_type, WikiPageType::Overview);
    assert!(!snapshot.system_pages.is_empty());

    let no_updates = service
        .fetch_wiki_updates(FetchWikiUpdatesRequest {
            known_snapshot_revision: snapshot.snapshot_revision.clone(),
            known_page_revisions: vec![KnownPageRevision {
                page_id: page_id.clone(),
                revision_id: first.revision_id.clone(),
            }],
            include_system_pages: false,
        })
        .expect("fetch should succeed");
    assert!(no_updates.changed_pages.is_empty());

    let committed = service
        .commit_wiki_changes(CommitWikiChangesRequest {
            base_snapshot_revision: snapshot.snapshot_revision.clone(),
            page_changes: vec![PageChangeInput {
                change_type: PageChangeType::Update,
                page_id: page_id.clone(),
                base_revision_id: first.revision_id.clone(),
                new_markdown: Some("# Sync Alpha Updated\n\nfresh body".to_string()),
            }],
        })
        .expect("sync commit should succeed");
    assert_eq!(committed.committed_pages.len(), 1);
    assert!(committed.rejected_pages.is_empty());
    assert!(!committed.snapshot_was_stale);

    let updates = service
        .fetch_wiki_updates(FetchWikiUpdatesRequest {
            known_snapshot_revision: snapshot.snapshot_revision,
            known_page_revisions: vec![KnownPageRevision {
                page_id,
                revision_id: first.revision_id,
            }],
            include_system_pages: true,
        })
        .expect("fetch should succeed");
    assert_eq!(updates.changed_pages.len(), 1);
    assert!(!updates.system_pages.is_empty());

    let page = service
        .get_page("sync-alpha")
        .expect("page lookup should succeed")
        .expect("page should exist");
    assert_eq!(page.title, "Sync Alpha Updated");
    let hits = service
        .search(SearchRequest {
            query_text: "fresh".to_string(),
            page_types: Vec::new(),
            top_k: 5,
        })
        .expect("search should succeed");
    assert!(hits.iter().any(|hit| hit.slug == "sync-alpha"));
}

#[test]
fn partial_export_uses_global_snapshot_revision_and_manifest_timestamps() {
    let (_dir, _db_path, service) = new_service();
    let alpha_id = service
        .create_page(CreatePageInput {
            slug: "alpha".to_string(),
            page_type: WikiPageType::Overview,
            title: "Alpha".to_string(),
            created_at: 1_700_000_000,
        })
        .expect("alpha should create");
    let alpha_first = service
        .commit_page_revision(CommitPageRevisionInput {
            page_id: alpha_id.clone(),
            expected_current_revision_id: None,
            title: "Alpha".to_string(),
            markdown: "# Alpha\n\nbody".to_string(),
            change_reason: "seed".to_string(),
            author_type: "test".to_string(),
            tags: Vec::new(),
            updated_at: 1_700_000_001,
        })
        .expect("alpha revision should commit");
    let beta_id = service
        .create_page(CreatePageInput {
            slug: "beta".to_string(),
            page_type: WikiPageType::Overview,
            title: "Beta".to_string(),
            created_at: 1_700_000_000,
        })
        .expect("beta should create");
    service
        .commit_page_revision(CommitPageRevisionInput {
            page_id: beta_id,
            expected_current_revision_id: None,
            title: "Beta".to_string(),
            markdown: "# Beta\n\nbody".to_string(),
            change_reason: "seed".to_string(),
            author_type: "test".to_string(),
            tags: Vec::new(),
            updated_at: 1_700_000_002,
        })
        .expect("beta revision should commit");

    let full_snapshot = service
        .export_wiki_snapshot(ExportWikiSnapshotRequest {
            include_system_pages: false,
            page_slugs: None,
        })
        .expect("full snapshot should export");
    let partial_snapshot = service
        .export_wiki_snapshot(ExportWikiSnapshotRequest {
            include_system_pages: false,
            page_slugs: Some(vec!["alpha".to_string()]),
        })
        .expect("partial snapshot should export");

    assert_eq!(
        partial_snapshot.snapshot_revision,
        full_snapshot.snapshot_revision
    );
    assert_eq!(partial_snapshot.pages.len(), 1);
    assert_eq!(partial_snapshot.pages[0].slug, "alpha");
    assert_eq!(partial_snapshot.pages[0].updated_at, 1_700_000_001);
    assert_eq!(partial_snapshot.manifest.pages.len(), 2);
    assert!(
        partial_snapshot
            .manifest
            .pages
            .iter()
            .any(|entry| entry.page_id == alpha_id && entry.updated_at == 1_700_000_001)
    );

    let no_updates = service
        .fetch_wiki_updates(FetchWikiUpdatesRequest {
            known_snapshot_revision: partial_snapshot.snapshot_revision,
            known_page_revisions: vec![KnownPageRevision {
                page_id: alpha_id,
                revision_id: alpha_first.revision_id,
            }],
            include_system_pages: false,
        })
        .expect("fetch should succeed");
    assert!(no_updates.changed_pages.is_empty());
    assert!(no_updates.removed_page_ids.is_empty());
}

#[test]
fn source_upload_status_reports_utf8_byte_count() {
    let (_dir, _db_path, service) = new_service();
    let upload_id = service
        .begin_source_upload(BeginSourceUploadInput {
            source_type: "article".to_string(),
            title: Some("Utf8".to_string()),
            canonical_uri: None,
            sha256: "utf8-source".to_string(),
            mime_type: Some("text/plain".to_string()),
            imported_at: 1_700_000_000,
            metadata_json: "{}".to_string(),
        })
        .expect("upload should begin");

    let status = service
        .append_source_chunk(AppendSourceChunkInput {
            upload_id,
            chunk_text: "日本語".to_string(),
        })
        .expect("chunk should append");

    assert_eq!(status.chunk_count, 1);
    assert_eq!(status.byte_count, 9);
}

#[test]
fn commit_wiki_changes_allows_stale_snapshot_for_unrelated_pages() {
    let (_dir, _db_path, service) = new_service();
    let stale_page_id = service
        .create_page(CreatePageInput {
            slug: "stale-target".to_string(),
            page_type: WikiPageType::Overview,
            title: "Stale Target".to_string(),
            created_at: 1_700_000_000,
        })
        .expect("page should create");
    let stale_page_first = service
        .commit_page_revision(CommitPageRevisionInput {
            page_id: stale_page_id.clone(),
            expected_current_revision_id: None,
            title: "Stale Target".to_string(),
            markdown: "# Stale Target\n\nbody".to_string(),
            change_reason: "seed".to_string(),
            author_type: "test".to_string(),
            tags: Vec::new(),
            updated_at: 1_700_000_001,
        })
        .expect("revision should commit");
    let snapshot = service
        .export_wiki_snapshot(ExportWikiSnapshotRequest {
            include_system_pages: false,
            page_slugs: None,
        })
        .expect("snapshot should export");

    let unrelated_page_id = service
        .create_page(CreatePageInput {
            slug: "unrelated".to_string(),
            page_type: WikiPageType::Overview,
            title: "Unrelated".to_string(),
            created_at: 1_700_000_000,
        })
        .expect("page should create");
    service
        .commit_page_revision(CommitPageRevisionInput {
            page_id: unrelated_page_id,
            expected_current_revision_id: None,
            title: "Unrelated".to_string(),
            markdown: "# Unrelated\n\nremote change".to_string(),
            change_reason: "seed".to_string(),
            author_type: "test".to_string(),
            tags: Vec::new(),
            updated_at: 1_700_000_002,
        })
        .expect("unrelated revision should commit");

    let result = service
        .commit_wiki_changes(CommitWikiChangesRequest {
            base_snapshot_revision: snapshot.snapshot_revision,
            page_changes: vec![PageChangeInput {
                change_type: PageChangeType::Update,
                page_id: stale_page_id,
                base_revision_id: stale_page_first.revision_id,
                new_markdown: Some("# Stale Target Updated\n\nbody".to_string()),
            }],
        })
        .expect("sync commit should succeed");
    assert_eq!(result.committed_pages.len(), 1);
    assert!(result.rejected_pages.is_empty());
    assert!(result.snapshot_was_stale);
}

#[test]
fn commit_wiki_changes_supports_delete() {
    let (_dir, _db_path, service) = new_service();
    let page_id = service
        .create_page(CreatePageInput {
            slug: "delete-me".to_string(),
            page_type: WikiPageType::Overview,
            title: "Delete Me".to_string(),
            created_at: 1_700_000_000,
        })
        .expect("page should create");
    let first = service
        .commit_page_revision(CommitPageRevisionInput {
            page_id: page_id.clone(),
            expected_current_revision_id: None,
            title: "Delete Me".to_string(),
            markdown: "# Delete Me\n\nbody".to_string(),
            change_reason: "seed".to_string(),
            author_type: "test".to_string(),
            tags: Vec::new(),
            updated_at: 1_700_000_001,
        })
        .expect("revision should commit");
    let snapshot = service
        .export_wiki_snapshot(ExportWikiSnapshotRequest {
            include_system_pages: false,
            page_slugs: None,
        })
        .expect("snapshot should export");

    let result = service
        .commit_wiki_changes(CommitWikiChangesRequest {
            base_snapshot_revision: snapshot.snapshot_revision,
            page_changes: vec![PageChangeInput {
                change_type: PageChangeType::Delete,
                page_id: page_id.clone(),
                base_revision_id: first.revision_id,
                new_markdown: None,
            }],
        })
        .expect("delete should succeed");
    assert!(result.rejected_pages.is_empty());
    assert!(!result.snapshot_was_stale);
    assert!(
        result
            .manifest_delta
            .removed_page_ids
            .iter()
            .any(|removed| removed == &page_id)
    );
    assert!(
        service
            .get_page("delete-me")
            .expect("lookup should succeed")
            .is_none()
    );
}

#[test]
fn commit_wiki_changes_returns_section_conflict_payload() {
    let (_dir, _db_path, service) = new_service();
    let page_id = service
        .create_page(CreatePageInput {
            slug: "conflict-page".to_string(),
            page_type: WikiPageType::Overview,
            title: "Conflict Page".to_string(),
            created_at: 1_700_000_000,
        })
        .expect("page should create");
    let first = service
        .commit_page_revision(CommitPageRevisionInput {
            page_id: page_id.clone(),
            expected_current_revision_id: None,
            title: "Conflict Page".to_string(),
            markdown: "# Intro\n\nbase\n\n## Shared\n\nold".to_string(),
            change_reason: "seed".to_string(),
            author_type: "test".to_string(),
            tags: Vec::new(),
            updated_at: 1_700_000_001,
        })
        .expect("revision should commit");
    service
        .commit_page_revision(CommitPageRevisionInput {
            page_id: page_id.clone(),
            expected_current_revision_id: Some(first.revision_id.clone()),
            title: "Conflict Page".to_string(),
            markdown: "# Intro\n\nbase\n\n## Shared\n\nremote".to_string(),
            change_reason: "remote".to_string(),
            author_type: "test".to_string(),
            tags: Vec::new(),
            updated_at: 1_700_000_002,
        })
        .expect("remote revision should commit");

    let latest_snapshot = service
        .export_wiki_snapshot(ExportWikiSnapshotRequest {
            include_system_pages: false,
            page_slugs: None,
        })
        .expect("latest snapshot should export");

    let result = service
        .commit_wiki_changes(CommitWikiChangesRequest {
            base_snapshot_revision: latest_snapshot.snapshot_revision,
            page_changes: vec![PageChangeInput {
                change_type: PageChangeType::Update,
                page_id,
                base_revision_id: first.revision_id,
                new_markdown: Some("# Intro\n\nbase\n\n## Shared\n\nlocal".to_string()),
            }],
        })
        .expect("sync commit should return conflict payload");
    assert!(result.committed_pages.is_empty());
    assert_eq!(result.rejected_pages.len(), 1);
    assert!(!result.snapshot_was_stale);
    assert!(result.rejected_pages[0].reason.contains("base revision"));
    assert!(
        result.rejected_pages[0]
            .conflicting_section_paths
            .iter()
            .any(|path| path == "intro/shared")
    );
    assert!(
        result.rejected_pages[0]
            .conflict_markdown
            .as_deref()
            .unwrap_or_default()
            .contains("<<<<<<< LOCAL")
    );
}

#[test]
fn commit_wiki_changes_partially_succeeds_when_snapshot_is_stale() {
    let (_dir, _db_path, service) = new_service();
    let stable_page_id = service
        .create_page(CreatePageInput {
            slug: "stable-page".to_string(),
            page_type: WikiPageType::Overview,
            title: "Stable Page".to_string(),
            created_at: 1_700_000_000,
        })
        .expect("page should create");
    let stable_first = service
        .commit_page_revision(CommitPageRevisionInput {
            page_id: stable_page_id.clone(),
            expected_current_revision_id: None,
            title: "Stable Page".to_string(),
            markdown: "# Stable Page\n\nbody".to_string(),
            change_reason: "seed".to_string(),
            author_type: "test".to_string(),
            tags: Vec::new(),
            updated_at: 1_700_000_001,
        })
        .expect("revision should commit");
    let conflict_page_id = service
        .create_page(CreatePageInput {
            slug: "conflict-target".to_string(),
            page_type: WikiPageType::Overview,
            title: "Conflict Target".to_string(),
            created_at: 1_700_000_000,
        })
        .expect("page should create");
    let conflict_first = service
        .commit_page_revision(CommitPageRevisionInput {
            page_id: conflict_page_id.clone(),
            expected_current_revision_id: None,
            title: "Conflict Target".to_string(),
            markdown: "# Root\n\nbase\n\n## Shared\n\nold".to_string(),
            change_reason: "seed".to_string(),
            author_type: "test".to_string(),
            tags: Vec::new(),
            updated_at: 1_700_000_002,
        })
        .expect("revision should commit");

    let snapshot = service
        .export_wiki_snapshot(ExportWikiSnapshotRequest {
            include_system_pages: false,
            page_slugs: None,
        })
        .expect("snapshot should export");

    let unrelated_page_id = service
        .create_page(CreatePageInput {
            slug: "remote-only".to_string(),
            page_type: WikiPageType::Overview,
            title: "Remote Only".to_string(),
            created_at: 1_700_000_000,
        })
        .expect("page should create");
    service
        .commit_page_revision(CommitPageRevisionInput {
            page_id: unrelated_page_id,
            expected_current_revision_id: None,
            title: "Remote Only".to_string(),
            markdown: "# Remote Only\n\nchange".to_string(),
            change_reason: "seed".to_string(),
            author_type: "test".to_string(),
            tags: Vec::new(),
            updated_at: 1_700_000_003,
        })
        .expect("unrelated remote revision should commit");
    service
        .commit_page_revision(CommitPageRevisionInput {
            page_id: conflict_page_id.clone(),
            expected_current_revision_id: Some(conflict_first.revision_id.clone()),
            title: "Conflict Target".to_string(),
            markdown: "# Root\n\nbase\n\n## Shared\n\nremote".to_string(),
            change_reason: "remote".to_string(),
            author_type: "test".to_string(),
            tags: Vec::new(),
            updated_at: 1_700_000_004,
        })
        .expect("conflicting remote revision should commit");

    let result = service
        .commit_wiki_changes(CommitWikiChangesRequest {
            base_snapshot_revision: snapshot.snapshot_revision,
            page_changes: vec![
                PageChangeInput {
                    change_type: PageChangeType::Update,
                    page_id: stable_page_id.clone(),
                    base_revision_id: stable_first.revision_id,
                    new_markdown: Some("# Stable Page Updated\n\nbody".to_string()),
                },
                PageChangeInput {
                    change_type: PageChangeType::Update,
                    page_id: conflict_page_id,
                    base_revision_id: conflict_first.revision_id,
                    new_markdown: Some("# Root\n\nbase\n\n## Shared\n\nlocal".to_string()),
                },
            ],
        })
        .expect("sync commit should return mixed result");

    assert!(result.snapshot_was_stale);
    assert_eq!(result.committed_pages.len(), 1);
    assert_eq!(result.rejected_pages.len(), 1);
    assert_eq!(result.committed_pages[0].page_id, stable_page_id);
    assert!(
        result.rejected_pages[0]
            .conflicting_section_paths
            .iter()
            .any(|path| path == "root/shared")
    );
}
