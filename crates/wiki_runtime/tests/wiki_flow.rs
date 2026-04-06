use rusqlite::Connection;
use tempfile::tempdir;
use wiki_runtime::WikiService;
use wiki_types::{
    CommitPageRevisionInput, CreatePageInput, CreateSourceInput, SearchRequest, WikiPageType,
};

#[test]
fn commit_updates_system_pages_and_get_page() {
    let dir = tempdir().expect("temp dir should exist");
    let db_path = dir.path().join("wiki.sqlite3");
    let service = WikiService::new(db_path);
    service.run_migrations().expect("migrations should succeed");
    let page_id = service
        .create_page(CreatePageInput {
            slug: "alpha".to_string(),
            page_type: WikiPageType::Entity,
            title: "Alpha".to_string(),
            created_at: 1_700_000_000,
        })
        .expect("page should create");

    let output = service
        .commit_page_revision(CommitPageRevisionInput {
            page_id,
            expected_current_revision_id: None,
            title: "Alpha".to_string(),
            markdown: "# Alpha\n\nbody".to_string(),
            change_reason: "seed".to_string(),
            author_type: "test".to_string(),
            tags: Vec::new(),
            updated_at: 1_700_000_001,
        })
        .expect("revision should commit");

    assert_eq!(output.section_count, 1);
    assert!(
        output
            .changed_section_paths
            .iter()
            .any(|path| path == "alpha")
    );

    let page = service
        .get_page("alpha")
        .expect("get_page should succeed")
        .expect("page should exist");
    assert_eq!(page.slug, "alpha");
    assert_eq!(page.current_revision_id, output.revision_id);
    assert_eq!(page.sections.len(), 1);

    let index_page = service
        .get_system_page("index.md")
        .expect("system page lookup should succeed")
        .expect("index page should exist");
    let log_page = service
        .get_system_page("log.md")
        .expect("system page lookup should succeed")
        .expect("log page should exist");
    assert!(index_page.markdown.contains("alpha"));
    assert!(log_page.markdown.contains("commit_page_revision"));
}

#[test]
fn expected_revision_mismatch_fails() {
    let dir = tempdir().expect("temp dir should exist");
    let db_path = dir.path().join("wiki.sqlite3");
    let service = WikiService::new(db_path);
    service.run_migrations().expect("migrations should succeed");
    let page_id = service
        .create_page(CreatePageInput {
            slug: "conflict".to_string(),
            page_type: WikiPageType::Overview,
            title: "Conflict".to_string(),
            created_at: 1_700_000_000,
        })
        .expect("page should create");
    let error = service
        .commit_page_revision(CommitPageRevisionInput {
            page_id,
            expected_current_revision_id: Some("wrong".to_string()),
            title: "Conflict".to_string(),
            markdown: "# Conflict\n\nbody".to_string(),
            change_reason: "seed".to_string(),
            author_type: "test".to_string(),
            tags: Vec::new(),
            updated_at: 1_700_000_001,
        })
        .expect_err("conflicting revision should fail");
    assert!(error.contains("expected_current_revision_id"));
}

#[test]
fn system_page_failure_rolls_back_revision_write() {
    let dir = tempdir().expect("temp dir should exist");
    let db_path = dir.path().join("wiki.sqlite3");
    let service = WikiService::new(db_path.clone());
    service.run_migrations().expect("migrations should succeed");
    let page_id = service
        .create_page(CreatePageInput {
            slug: "rollback".to_string(),
            page_type: WikiPageType::Overview,
            title: "Rollback".to_string(),
            created_at: 1_700_000_000,
        })
        .expect("page should create");
    let conn = Connection::open(&db_path).expect("db should open");
    conn.execute_batch(
        "
        CREATE TRIGGER fail_system_page_insert
        BEFORE INSERT ON system_pages
        BEGIN
            SELECT RAISE(ABORT, 'system page insert failed');
        END;
        ",
    )
    .expect("trigger should create");

    let error = service
        .commit_page_revision(CommitPageRevisionInput {
            page_id: page_id.clone(),
            expected_current_revision_id: None,
            title: "Rollback".to_string(),
            markdown: "# Rollback\n\nbody".to_string(),
            change_reason: "seed".to_string(),
            author_type: "test".to_string(),
            tags: Vec::new(),
            updated_at: 1_700_000_001,
        })
        .expect_err("system page failure should abort commit");
    assert!(error.contains("system page insert failed"));

    let revision_count = conn
        .query_row(
            "SELECT COUNT(*) FROM wiki_revisions WHERE page_id = ?1",
            [&page_id],
            |row| row.get::<_, i64>(0),
        )
        .expect("revision count should query");
    let section_count = conn
        .query_row(
            "SELECT COUNT(*) FROM wiki_sections WHERE page_id = ?1",
            [&page_id],
            |row| row.get::<_, i64>(0),
        )
        .expect("section count should query");
    let system_page_count = conn
        .query_row("SELECT COUNT(*) FROM system_pages", [], |row| {
            row.get::<_, i64>(0)
        })
        .expect("system page count should query");
    assert_eq!(revision_count, 0);
    assert_eq!(section_count, 0);
    assert_eq!(system_page_count, 0);
}

#[test]
fn create_source_status_and_recent_log_are_available() {
    let dir = tempdir().expect("temp dir should exist");
    let db_path = dir.path().join("wiki.sqlite3");
    let service = WikiService::new(db_path);
    service.run_migrations().expect("migrations should succeed");
    service
        .create_source(CreateSourceInput {
            source_type: "article".to_string(),
            title: Some("Alpha Source".to_string()),
            canonical_uri: Some("https://example.com/alpha".to_string()),
            sha256: "source-alpha".to_string(),
            mime_type: Some("text/markdown".to_string()),
            imported_at: 1_700_000_000,
            metadata_json: "{}".to_string(),
            body_text: "quoted evidence".to_string(),
        })
        .expect("source should create");

    let page_id = service
        .create_page(CreatePageInput {
            slug: "sources".to_string(),
            page_type: WikiPageType::Overview,
            title: "Sources".to_string(),
            created_at: 1_700_000_000,
        })
        .expect("page should create");
    service
        .commit_page_revision(CommitPageRevisionInput {
            page_id,
            expected_current_revision_id: None,
            title: "Sources".to_string(),
            markdown: "# Sources\n\nSources:\n- [source: Alpha Source, section \"Results\"]"
                .to_string(),
            change_reason: "seed".to_string(),
            author_type: "test".to_string(),
            tags: Vec::new(),
            updated_at: 1_700_000_001,
        })
        .expect("revision should commit");

    let recent = service.get_recent_log(5).expect("recent log should load");
    let status = service.status().expect("status should load");
    assert!(!recent.is_empty());
    assert_eq!(status.page_count, 1);
    assert_eq!(status.source_count, 1);
    assert_eq!(status.system_page_count, 2);
}

#[test]
fn search_returns_current_sections_and_removes_old_terms() {
    let dir = tempdir().expect("temp dir should exist");
    let db_path = dir.path().join("wiki.sqlite3");
    let service = WikiService::new(db_path);
    service.run_migrations().expect("migrations should succeed");
    let page_id = service
        .create_page(CreatePageInput {
            slug: "searchable".to_string(),
            page_type: WikiPageType::Concept,
            title: "Searchable".to_string(),
            created_at: 1_700_000_000,
        })
        .expect("page should create");

    let first = service
        .commit_page_revision(CommitPageRevisionInput {
            page_id: page_id.clone(),
            expected_current_revision_id: None,
            title: "Searchable".to_string(),
            markdown: "# Searchable\n\nlegacy token".to_string(),
            change_reason: "seed".to_string(),
            author_type: "test".to_string(),
            tags: Vec::new(),
            updated_at: 1_700_000_001,
        })
        .expect("first revision should commit");

    service
        .commit_page_revision(CommitPageRevisionInput {
            page_id,
            expected_current_revision_id: Some(first.revision_id),
            title: "Searchable".to_string(),
            markdown: "# Searchable\n\nfresh token".to_string(),
            change_reason: "update".to_string(),
            author_type: "test".to_string(),
            tags: Vec::new(),
            updated_at: 1_700_000_002,
        })
        .expect("second revision should commit");

    let fresh_hits = service
        .search(SearchRequest {
            query_text: "fresh".to_string(),
            page_types: Vec::new(),
            top_k: 5,
        })
        .expect("search should succeed");
    let legacy_hits = service
        .search(SearchRequest {
            query_text: "legacy".to_string(),
            page_types: Vec::new(),
            top_k: 5,
        })
        .expect("search should succeed");

    assert!(fresh_hits.iter().any(|hit| hit.slug == "searchable"));
    assert!(
        fresh_hits
            .iter()
            .any(|hit| hit.page_type == WikiPageType::Concept)
    );
    assert!(legacy_hits.is_empty());
}

#[test]
fn search_prefers_exact_slug_or_title_and_filters_page_types() {
    let dir = tempdir().expect("temp dir should exist");
    let db_path = dir.path().join("wiki.sqlite3");
    let service = WikiService::new(db_path);
    service.run_migrations().expect("migrations should succeed");

    let alpha_id = service
        .create_page(CreatePageInput {
            slug: "alpha".to_string(),
            page_type: WikiPageType::Entity,
            title: "Alpha".to_string(),
            created_at: 1_700_000_000,
        })
        .expect("alpha page should create");
    service
        .commit_page_revision(CommitPageRevisionInput {
            page_id: alpha_id,
            expected_current_revision_id: None,
            title: "Alpha".to_string(),
            markdown: "# Alpha\n\nbroad keyword".to_string(),
            change_reason: "seed".to_string(),
            author_type: "test".to_string(),
            tags: Vec::new(),
            updated_at: 1_700_000_001,
        })
        .expect("alpha revision should commit");

    let beta_id = service
        .create_page(CreatePageInput {
            slug: "beta".to_string(),
            page_type: WikiPageType::Concept,
            title: "Broad Keyword".to_string(),
            created_at: 1_700_000_000,
        })
        .expect("beta page should create");
    service
        .commit_page_revision(CommitPageRevisionInput {
            page_id: beta_id,
            expected_current_revision_id: None,
            title: "Broad Keyword".to_string(),
            markdown: "# Broad Keyword\n\nalpha appears often alpha alpha".to_string(),
            change_reason: "seed".to_string(),
            author_type: "test".to_string(),
            tags: Vec::new(),
            updated_at: 1_700_000_002,
        })
        .expect("beta revision should commit");

    let alpha_hits = service
        .search(SearchRequest {
            query_text: "alpha".to_string(),
            page_types: Vec::new(),
            top_k: 5,
        })
        .expect("search should succeed");
    assert_eq!(
        alpha_hits.first().map(|hit| hit.slug.as_str()),
        Some("alpha")
    );
    assert!(
        alpha_hits
            .first()
            .map(|hit| hit
                .match_reasons
                .iter()
                .any(|reason| reason == "exact_slug"))
            .unwrap_or(false)
    );

    let entity_hits = service
        .search(SearchRequest {
            query_text: "keyword".to_string(),
            page_types: vec![WikiPageType::Entity],
            top_k: 5,
        })
        .expect("search should succeed");
    assert!(entity_hits.iter().all(|hit| hit.slug == "alpha"));
    assert!(
        entity_hits
            .iter()
            .all(|hit| hit.page_type == WikiPageType::Entity)
    );
}

#[test]
fn search_returns_matching_sections_for_multi_section_pages() {
    let dir = tempdir().expect("temp dir should exist");
    let db_path = dir.path().join("wiki.sqlite3");
    let service = WikiService::new(db_path);
    service.run_migrations().expect("migrations should succeed");

    let page_id = service
        .create_page(CreatePageInput {
            slug: "multi".to_string(),
            page_type: WikiPageType::Overview,
            title: "Multi".to_string(),
            created_at: 1_700_000_000,
        })
        .expect("page should create");
    service
        .commit_page_revision(CommitPageRevisionInput {
            page_id,
            expected_current_revision_id: None,
            title: "Multi".to_string(),
            markdown: "# Intro\n\nshared\n\n# Target\n\nneedle token".to_string(),
            change_reason: "seed".to_string(),
            author_type: "test".to_string(),
            tags: Vec::new(),
            updated_at: 1_700_000_001,
        })
        .expect("revision should commit");

    let hits = service
        .search(SearchRequest {
            query_text: "needle".to_string(),
            page_types: Vec::new(),
            top_k: 5,
        })
        .expect("search should succeed");

    assert!(hits.iter().any(|hit| hit.slug == "multi"));
    assert!(
        hits.iter()
            .any(|hit| hit.section_path.as_deref() == Some("target"))
    );
}

#[test]
fn search_with_empty_query_returns_empty_results() {
    let dir = tempdir().expect("temp dir should exist");
    let db_path = dir.path().join("wiki.sqlite3");
    let service = WikiService::new(db_path);
    service.run_migrations().expect("migrations should succeed");

    let hits = service
        .search(SearchRequest {
            query_text: "".to_string(),
            page_types: Vec::new(),
            top_k: 5,
        })
        .expect("search should succeed");

    assert!(hits.is_empty());
}
