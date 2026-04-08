// Where: crates/wiki_store/src/store.rs
// What: Public wiki store API and read/write helpers over the source-of-truth database.
// Why: Runtime code should interact with one store object instead of raw SQL calls.
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OptionalExtension, params};
use uuid::Uuid;
use wiki_types::{
    AdoptDraftPageInput, AdoptDraftPageOutput, AppendSourceChunkInput, BeginSourceUploadInput,
    CommitPageRevisionInput, CommitPageRevisionOutput, CommitWikiChangesRequest,
    CommitWikiChangesResponse, CreatePageInput, CreateSourceInput, ExportWikiSnapshotRequest,
    ExportWikiSnapshotResponse, FetchWikiUpdatesRequest, FetchWikiUpdatesResponse,
    FinalizeSourceUploadInput, FinalizeSourceUploadOutput, HealthCheckReport, LogEvent, PageBundle,
    PageSectionView, SearchHit, SearchRequest, SourceUploadStatus, Status, SystemPage, WikiPage,
    WikiPageType, WikiRevision,
};

use crate::{
    health::run_health_checks,
    render, schema,
    source::{count_sources, create_source_row, load_system_page},
    source_upload::{append_source_chunk_row, begin_source_upload_row, finalize_source_upload_row},
    sync::{commit_wiki_changes, export_snapshot, fetch_updates},
};

pub struct WikiStore {
    database_path: PathBuf,
}

impl WikiStore {
    pub fn new(database_path: PathBuf) -> Self {
        Self { database_path }
    }

    pub fn database_path(&self) -> &Path {
        &self.database_path
    }

    pub fn run_migrations(&self) -> Result<(), String> {
        let mut conn = self.open()?;
        schema::run_migrations(&mut conn)
    }

    pub fn create_page(&self, input: CreatePageInput) -> Result<String, String> {
        let conn = self.open()?;
        let page_id = format!("page_{}", Uuid::new_v4());
        conn.execute(
            "INSERT INTO wiki_pages (
                id, slug, page_type, title, current_revision_id, summary_1line, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6, ?7)",
            params![
                page_id,
                input.slug,
                input.page_type.as_str(),
                input.title,
                render::summary_from_title(&input.title, &input.page_type),
                input.created_at,
                input.created_at,
            ],
        )
        .map_err(|error| error.to_string())?;
        Ok(page_id)
    }

    pub fn adopt_draft_page(
        &self,
        input: AdoptDraftPageInput,
        adopted_at: i64,
    ) -> Result<AdoptDraftPageOutput, String> {
        if input.slug.trim().is_empty() {
            return Err("slug must not be empty".to_string());
        }
        if input.title.trim().is_empty() {
            return Err("title must not be empty".to_string());
        }
        if input.markdown.trim().is_empty() {
            return Err("markdown must not be empty".to_string());
        }

        let mut conn = self.open()?;
        let tx = conn.transaction().map_err(|error| error.to_string())?;
        if load_page_by_slug(&tx, &input.slug)?.is_some() {
            return Err(format!("page slug already exists: {}", input.slug));
        }

        let page_id = format!("page_{}", Uuid::new_v4());
        tx.execute(
            "INSERT INTO wiki_pages (
                id, slug, page_type, title, current_revision_id, summary_1line, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6, ?7)",
            params![
                page_id,
                input.slug,
                input.page_type.as_str(),
                input.title,
                render::summary_from_title(&input.title, &input.page_type),
                adopted_at,
                adopted_at,
            ],
        )
        .map_err(|error| error.to_string())?;

        let revision = crate::commit::commit_revision_in_tx(
            &tx,
            &CommitPageRevisionInput {
                page_id: page_id.clone(),
                expected_current_revision_id: None,
                title: input.title.clone(),
                markdown: input.markdown,
                change_reason: "adopt_draft_page".to_string(),
                author_type: "agent".to_string(),
                tags: Vec::new(),
                updated_at: adopted_at,
            },
        )?;
        tx.commit().map_err(|error| error.to_string())?;

        let snapshot = export_snapshot(
            &conn,
            ExportWikiSnapshotRequest {
                include_system_pages: false,
                page_slugs: None,
            },
        )?;
        let index_page = load_system_page(&conn, "index.md")?
            .ok_or_else(|| "index.md is missing after draft adoption".to_string())?;
        let log_page = load_system_page(&conn, "log.md")?
            .ok_or_else(|| "log.md is missing after draft adoption".to_string())?;
        Ok(AdoptDraftPageOutput {
            page_id,
            slug: input.slug,
            revision_id: revision.revision_id,
            updated_at: adopted_at,
            snapshot_revision: snapshot.snapshot_revision,
            index_markdown: index_page.markdown,
            log_markdown: log_page.markdown,
        })
    }

    pub fn create_source(&self, input: CreateSourceInput) -> Result<String, String> {
        let conn = self.open()?;
        create_source_row(&conn, input)
    }

    pub fn begin_source_upload(&self, input: BeginSourceUploadInput) -> Result<String, String> {
        let conn = self.open()?;
        begin_source_upload_row(&conn, input)
    }

    pub fn append_source_chunk(
        &self,
        input: AppendSourceChunkInput,
    ) -> Result<SourceUploadStatus, String> {
        let conn = self.open()?;
        append_source_chunk_row(&conn, input)
    }

    pub fn finalize_source_upload(
        &self,
        input: FinalizeSourceUploadInput,
    ) -> Result<FinalizeSourceUploadOutput, String> {
        let mut conn = self.open()?;
        finalize_source_upload_row(&mut conn, input)
    }

    pub fn commit_page_revision(
        &self,
        input: CommitPageRevisionInput,
    ) -> Result<CommitPageRevisionOutput, String> {
        let mut conn = self.open()?;
        crate::commit::commit_revision_tx(&mut conn, &input)
    }

    pub fn refresh_system_pages(&self, updated_at: i64) -> Result<Vec<SystemPage>, String> {
        let mut conn = self.open()?;
        let tx = conn.transaction().map_err(|error| error.to_string())?;
        let pages = crate::system_pages::refresh_system_pages_tx(&tx, updated_at)?;
        tx.commit().map_err(|error| error.to_string())?;
        Ok(pages)
    }

    pub fn get_page_by_slug(&self, slug: &str) -> Result<Option<PageBundle>, String> {
        let conn = self.open()?;
        let page = load_page_by_slug(&conn, slug)?;
        let Some(page) = page else {
            return Ok(None);
        };
        let Some(revision_id) = page.current_revision_id.clone() else {
            return Ok(None);
        };
        let revision = load_revision(&conn, &revision_id)?
            .ok_or_else(|| "current revision is missing".to_string())?;
        let sections = load_current_sections(&conn, &page.id)?
            .into_iter()
            .map(|section| PageSectionView {
                section_path: section.0,
                heading: section.1,
                text: section.2,
            })
            .collect();
        Ok(Some(PageBundle {
            page_id: page.id.clone(),
            slug: page.slug.clone(),
            title: page.title.clone(),
            page_type: page.page_type.as_str().to_string(),
            current_revision_id: revision.id.clone(),
            markdown: revision.markdown,
            sections,
            updated_at: page.updated_at,
        }))
    }

    pub fn get_system_page(&self, slug: &str) -> Result<Option<SystemPage>, String> {
        let conn = self.open()?;
        load_system_page(&conn, slug)
    }

    pub fn search(&self, request: SearchRequest) -> Result<Vec<SearchHit>, String> {
        let conn = self.open()?;
        crate::search::search_sections(&conn, request)
    }

    pub fn get_recent_log(&self, limit: usize) -> Result<Vec<LogEvent>, String> {
        let conn = self.open()?;
        crate::system_pages::load_recent_log_events(&conn, Some(limit))
    }

    pub fn status(&self) -> Result<Status, String> {
        let conn = self.open()?;
        Ok(Status {
            page_count: count_table_rows(&conn, "wiki_pages")?,
            source_count: count_sources(&conn)?,
            system_page_count: count_table_rows(&conn, "system_pages")?,
        })
    }

    pub fn lint_health(&self) -> Result<HealthCheckReport, String> {
        let conn = self.open()?;
        run_health_checks(&conn)
    }

    pub fn export_wiki_snapshot(
        &self,
        request: ExportWikiSnapshotRequest,
    ) -> Result<ExportWikiSnapshotResponse, String> {
        let conn = self.open()?;
        export_snapshot(&conn, request)
    }

    pub fn fetch_wiki_updates(
        &self,
        request: FetchWikiUpdatesRequest,
    ) -> Result<FetchWikiUpdatesResponse, String> {
        let conn = self.open()?;
        fetch_updates(&conn, request)
    }

    pub fn commit_wiki_changes(
        &self,
        request: CommitWikiChangesRequest,
    ) -> Result<CommitWikiChangesResponse, String> {
        let mut conn = self.open()?;
        commit_wiki_changes(&mut conn, request)
    }

    pub(crate) fn open(&self) -> Result<Connection, String> {
        Connection::open(&self.database_path).map_err(|error| error.to_string())
    }
}

pub(crate) fn load_page_by_id(
    conn: &Connection,
    page_id: &str,
) -> Result<Option<WikiPage>, String> {
    conn.query_row(
        "SELECT id, slug, page_type, title, current_revision_id, summary_1line, created_at, updated_at
         FROM wiki_pages WHERE id = ?1",
        params![page_id],
        map_page,
    )
    .optional()
    .map_err(|error| error.to_string())
}

fn load_page_by_slug(conn: &Connection, slug: &str) -> Result<Option<WikiPage>, String> {
    conn.query_row(
        "SELECT id, slug, page_type, title, current_revision_id, summary_1line, created_at, updated_at
         FROM wiki_pages WHERE slug = ?1",
        params![slug],
        map_page,
    )
    .optional()
    .map_err(|error| error.to_string())
}

pub(crate) fn load_revision(
    conn: &Connection,
    revision_id: &str,
) -> Result<Option<WikiRevision>, String> {
    conn.query_row(
        "SELECT id, page_id, revision_no, markdown, change_reason, author_type, created_at
         FROM wiki_revisions WHERE id = ?1",
        params![revision_id],
        |row| {
            Ok(WikiRevision {
                id: row.get(0)?,
                page_id: row.get(1)?,
                revision_no: row.get(2)?,
                markdown: row.get(3)?,
                change_reason: row.get(4)?,
                author_type: row.get(5)?,
                created_at: row.get(6)?,
            })
        },
    )
    .optional()
    .map_err(|error| error.to_string())
}

pub(crate) fn load_current_sections(
    conn: &Connection,
    page_id: &str,
) -> Result<Vec<(String, Option<String>, String)>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT section_path, heading, text
             FROM wiki_sections
             WHERE page_id = ?1 AND is_current = 1
             ORDER BY ordinal",
        )
        .map_err(|error| error.to_string())?;
    stmt.query_map(params![page_id], |row| {
        Ok((row.get(0)?, row.get(1)?, row.get(2)?))
    })
    .map_err(|error| error.to_string())?
    .collect::<std::result::Result<Vec<_>, _>>()
    .map_err(|error| error.to_string())
}

fn map_page(row: &rusqlite::Row<'_>) -> rusqlite::Result<WikiPage> {
    let page_type = row.get::<_, String>(2)?;
    Ok(WikiPage {
        id: row.get(0)?,
        slug: row.get(1)?,
        page_type: WikiPageType::from_str(&page_type).unwrap_or(WikiPageType::Overview),
        title: row.get(3)?,
        current_revision_id: row.get(4)?,
        summary_1line: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

fn count_table_rows(conn: &Connection, table: &str) -> Result<u64, String> {
    let sql = format!("SELECT COUNT(*) FROM {table}");
    conn.query_row(&sql, [], |row| row.get::<_, i64>(0))
        .map_err(|error| error.to_string())
        .and_then(|value| {
            u64::try_from(value).map_err(|_| "count must not be negative".to_string())
        })
}
