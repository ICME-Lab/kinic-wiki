use rusqlite::Connection;
use tempfile::tempdir;
use wiki_store::WikiStore;
use wiki_types::{CommitPageRevisionInput, CreatePageInput, CreateSourceInput, WikiPageType};

#[test]
fn migrations_create_required_tables() {
    let dir = tempdir().expect("temp dir should exist");
    let store = WikiStore::new(dir.path().join("wiki.sqlite3"));
    store.run_migrations().expect("migrations should succeed");

    let conn = Connection::open(store.database_path()).expect("db should open");
    for table in [
        "schema_migrations",
        "wiki_pages",
        "wiki_revisions",
        "wiki_sections",
        "wiki_sections_fts",
        "log_events",
        "system_pages",
        "sources",
        "source_bodies",
    ] {
        let exists = conn
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1",
                [table],
                |row| row.get::<_, i64>(0),
            )
            .expect("table should exist");
        assert_eq!(exists, 1);
    }
}

#[test]
fn migrations_are_recorded_and_rerunnable() {
    let dir = tempdir().expect("temp dir should exist");
    let store = WikiStore::new(dir.path().join("wiki.sqlite3"));
    store
        .run_migrations()
        .expect("first migration should succeed");
    store
        .run_migrations()
        .expect("second migration should succeed");

    let conn = Connection::open(store.database_path()).expect("db should open");
    let versions = {
        let mut stmt = conn
            .prepare(
                "SELECT version FROM schema_migrations
                 WHERE version LIKE 'wiki_store:%'
                 ORDER BY version",
            )
            .expect("statement should prepare");
        stmt.query_map([], |row| row.get::<_, String>(0))
            .expect("query should work")
            .collect::<std::result::Result<Vec<_>, _>>()
            .expect("versions should collect")
    };
    assert_eq!(
        versions,
        vec![
            "wiki_store:000_initial".to_string(),
            "wiki_store:001_sources".to_string(),
            "wiki_store:002_plan_alignment".to_string(),
            "wiki_store:003_section_search".to_string(),
        ]
    );
}

#[test]
fn migration_backfills_search_rows_for_existing_sections() {
    let dir = tempdir().expect("temp dir should exist");
    let db_path = dir.path().join("wiki.sqlite3");
    let conn = Connection::open(&db_path).expect("db should open");

    conn.execute_batch(include_str!("../migrations/000_schema_migrations.sql"))
        .expect("schema migrations table should create");
    conn.execute_batch(include_str!("../migrations/000_initial.sql"))
        .expect("initial schema should create");
    conn.execute_batch(include_str!("../migrations/001_sources.sql"))
        .expect("sources schema should create");
    conn.execute_batch(include_str!("../migrations/002_plan_alignment.sql"))
        .expect("plan alignment schema should create");
    for version in [
        "wiki_store:000_initial",
        "wiki_store:001_sources",
        "wiki_store:002_plan_alignment",
    ] {
        conn.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (?1, 1700000000)",
            [version],
        )
        .expect("version should insert");
    }
    conn.execute(
        "INSERT INTO wiki_pages (
            id, slug, page_type, title, current_revision_id, summary_1line, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        (
            "page_alpha",
            "alpha",
            "concept",
            "Alpha",
            "revision_alpha_1",
            "Alpha summary",
            1_700_000_000_i64,
            1_700_000_000_i64,
        ),
    )
    .expect("page should insert");
    conn.execute(
        "INSERT INTO wiki_revisions (
            id, page_id, revision_no, markdown, change_reason, author_type, created_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        (
            "revision_alpha_1",
            "page_alpha",
            1_i64,
            "# Alpha\n\nlegacy body",
            "seed",
            "test",
            1_700_000_000_i64,
        ),
    )
    .expect("revision should insert");
    conn.execute(
        "INSERT INTO wiki_sections (
            id, page_id, revision_id, section_path, ordinal, heading, text, content_hash, is_current
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1)",
        (
            "section_alpha_1",
            "page_alpha",
            "revision_alpha_1",
            "alpha",
            0_i64,
            "Alpha",
            "legacy body",
            "hash-alpha",
        ),
    )
    .expect("section should insert");
    drop(conn);

    let store = WikiStore::new(db_path);
    store.run_migrations().expect("migration should succeed");

    let hits = store
        .search(wiki_types::SearchRequest {
            query_text: "legacy".to_string(),
            page_types: Vec::new(),
            top_k: 5,
        })
        .expect("search should succeed");
    assert!(hits.iter().any(|hit| hit.slug == "alpha"));
}

#[test]
fn commit_revision_reports_changed_and_removed_sections() {
    let dir = tempdir().expect("temp dir should exist");
    let store = WikiStore::new(dir.path().join("wiki.sqlite3"));
    store.run_migrations().expect("migrations should succeed");
    let page_id = store
        .create_page(CreatePageInput {
            slug: "diff-page".to_string(),
            page_type: WikiPageType::Overview,
            title: "Diff Page".to_string(),
            created_at: 1_700_000_000,
        })
        .expect("page should create");

    let first = store
        .commit_page_revision(CommitPageRevisionInput {
            page_id: page_id.clone(),
            expected_current_revision_id: None,
            title: "Diff Page".to_string(),
            markdown: "# Keep\n\nsame\n\n# Remove\n\nold".to_string(),
            change_reason: "first".to_string(),
            author_type: "test".to_string(),
            tags: Vec::new(),
            updated_at: 1_700_000_001,
        })
        .expect("first revision should commit");

    let second = store
        .commit_page_revision(CommitPageRevisionInput {
            page_id: page_id.clone(),
            expected_current_revision_id: Some(first.revision_id),
            title: "Diff Page".to_string(),
            markdown: "# Keep\n\nsame\n\n# Add\n\nnew".to_string(),
            change_reason: "second".to_string(),
            author_type: "test".to_string(),
            tags: Vec::new(),
            updated_at: 1_700_000_002,
        })
        .expect("second revision should commit");

    assert_eq!(second.unchanged_section_count, 1);
    assert!(
        second
            .changed_section_paths
            .iter()
            .any(|path| path == "add")
    );
    assert!(
        second
            .removed_section_paths
            .iter()
            .any(|path| path == "remove")
    );
}

#[test]
fn current_page_bundle_uses_intro_and_duplicate_section_paths() {
    let dir = tempdir().expect("temp dir should exist");
    let store = WikiStore::new(dir.path().join("wiki.sqlite3"));
    store.run_migrations().expect("migrations should succeed");
    store
        .create_page(CreatePageInput {
            slug: "shape".to_string(),
            page_type: WikiPageType::Concept,
            title: "Shape".to_string(),
            created_at: 1_700_000_000,
        })
        .and_then(|page_id| {
            store.commit_page_revision(CommitPageRevisionInput {
                page_id,
                expected_current_revision_id: None,
                title: "Shape".to_string(),
                markdown: "Lead\n\n# Root\n\n## Child\n\none\n\n## Child\n\ntwo".to_string(),
                change_reason: "shape".to_string(),
                author_type: "test".to_string(),
                tags: Vec::new(),
                updated_at: 1_700_000_001,
            })
        })
        .expect("revision should commit");

    let page = store
        .get_page_by_slug("shape")
        .expect("page lookup should succeed")
        .expect("page should exist");
    let paths = page
        .sections
        .iter()
        .map(|section| section.section_path.as_str())
        .collect::<Vec<_>>();
    assert!(paths.contains(&"__intro__"));
    assert!(paths.contains(&"root/child"));
    assert!(paths.contains(&"root/child-2"));
}

#[test]
fn source_ingest_persists_full_body_once() {
    let dir = tempdir().expect("temp dir should exist");
    let store = WikiStore::new(dir.path().join("wiki.sqlite3"));
    store.run_migrations().expect("migrations should succeed");
    let source_id = store
        .create_source(CreateSourceInput {
            source_type: "article".to_string(),
            title: Some("Alpha".to_string()),
            canonical_uri: Some("https://example.com/alpha".to_string()),
            sha256: "sha-alpha".to_string(),
            mime_type: Some("text/markdown".to_string()),
            imported_at: 1_700_000_000,
            metadata_json: "{}".to_string(),
            body_text: "source body".to_string(),
        })
        .expect("source should create");

    let conn = Connection::open(store.database_path()).expect("db should open");
    let count = conn
        .query_row(
            "SELECT COUNT(*) FROM source_bodies WHERE source_id = ?1",
            [source_id.as_str()],
            |row| row.get::<_, i64>(0),
        )
        .expect("source body count should query");
    let body = conn
        .query_row(
            "SELECT body_text FROM source_bodies WHERE source_id = ?1",
            [source_id.as_str()],
            |row| row.get::<_, String>(0),
        )
        .expect("source body should exist");
    assert_eq!(count, 1);
    assert_eq!(body, "source body");
}

#[test]
fn search_escapes_fts_special_characters() {
    let dir = tempdir().expect("temp dir should exist");
    let store = WikiStore::new(dir.path().join("wiki.sqlite3"));
    store.run_migrations().expect("migrations should succeed");
    let page_id = store
        .create_page(CreatePageInput {
            slug: "special".to_string(),
            page_type: WikiPageType::Concept,
            title: "Special".to_string(),
            created_at: 1_700_000_000,
        })
        .expect("page should create");

    store
        .commit_page_revision(CommitPageRevisionInput {
            page_id,
            expected_current_revision_id: None,
            title: "Special".to_string(),
            markdown: "# Special\n\nC++ and foo-bar stay searchable.".to_string(),
            change_reason: "seed".to_string(),
            author_type: "test".to_string(),
            tags: Vec::new(),
            updated_at: 1_700_000_001,
        })
        .expect("revision should commit");

    let cxx_hits = store
        .search(wiki_types::SearchRequest {
            query_text: "C++".to_string(),
            page_types: Vec::new(),
            top_k: 5,
        })
        .expect("search should succeed");
    let hyphen_hits = store
        .search(wiki_types::SearchRequest {
            query_text: "foo-bar".to_string(),
            page_types: Vec::new(),
            top_k: 5,
        })
        .expect("search should succeed");
    let quote_hits = store
        .search(wiki_types::SearchRequest {
            query_text: "\"unterminated".to_string(),
            page_types: Vec::new(),
            top_k: 5,
        })
        .expect("search should succeed");

    assert!(cxx_hits.iter().any(|hit| hit.slug == "special"));
    assert!(hyphen_hits.iter().any(|hit| hit.slug == "special"));
    assert!(quote_hits.is_empty());
}
