// Where: crates/wiki_store/src/system_pages.rs
// What: Materialization of system pages and recent log readers.
// Why: Index and log pages should be rendered once and reused by store and runtime layers.
use rusqlite::{Connection, params};
use wiki_types::{LogEvent, SystemPage, WikiPage, WikiPageType};

use crate::render;

pub fn refresh_system_pages_tx(
    conn: &Connection,
    updated_at: i64,
) -> Result<Vec<SystemPage>, String> {
    let pages = load_index_pages(conn)?;
    let log_entries = to_render_log_entries(load_log_entry_rows(conn, None)?);
    let system_pages = vec![
        render::render_index_page(&pages, updated_at),
        render::render_log_page(&log_entries, updated_at),
    ];
    for page in &system_pages {
        conn.execute(
            "INSERT INTO system_pages (slug, markdown, updated_at, etag)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(slug) DO UPDATE SET markdown = excluded.markdown, updated_at = excluded.updated_at, etag = excluded.etag",
            params![page.slug, page.markdown, page.updated_at, page.etag],
        )
        .map_err(|error| error.to_string())?;
    }
    Ok(system_pages)
}

pub fn render_index_page_now(conn: &Connection, updated_at: i64) -> Result<SystemPage, String> {
    Ok(render::render_index_page(
        &load_index_pages(conn)?,
        updated_at,
    ))
}

pub fn render_log_page_now(
    conn: &Connection,
    limit: usize,
    updated_at: i64,
) -> Result<SystemPage, String> {
    Ok(render::render_log_page(
        &to_render_log_entries(load_log_entry_rows(conn, Some(limit))?),
        updated_at,
    ))
}

pub fn load_recent_log_events(
    conn: &Connection,
    limit: Option<usize>,
) -> Result<Vec<LogEvent>, String> {
    load_log_entry_rows(conn, limit)?
        .into_iter()
        .map(
            |(created_at, event_type, title, body_markdown, related_page_id)| {
                Ok(LogEvent {
                    event_type,
                    title,
                    body_markdown,
                    related_page_id,
                    created_at,
                })
            },
        )
        .collect()
}

fn load_index_pages(conn: &Connection) -> Result<Vec<WikiPage>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, slug, page_type, title, current_revision_id, summary_1line, created_at, updated_at
             FROM wiki_pages ORDER BY slug",
        )
        .map_err(|error| error.to_string())?;
    stmt.query_map([], |row| {
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
    })
    .map_err(|error| error.to_string())?
    .collect::<std::result::Result<Vec<_>, _>>()
    .map_err(|error| error.to_string())
}

fn load_log_entry_rows(
    conn: &Connection,
    limit: Option<usize>,
) -> Result<Vec<(i64, String, String, String, Option<String>)>, String> {
    let mut sql = String::from(
        "SELECT created_at, event_type, title, body_markdown, related_page_id
         FROM log_events ORDER BY created_at DESC",
    );
    if let Some(limit) = limit {
        sql.push_str(&format!(
            " LIMIT {}",
            i64::try_from(limit).unwrap_or(i64::MAX)
        ));
    }
    let mut stmt = conn.prepare(&sql).map_err(|error| error.to_string())?;
    stmt.query_map([], |row| {
        Ok((
            row.get(0)?,
            row.get(1)?,
            row.get(2)?,
            row.get(3)?,
            row.get(4)?,
        ))
    })
    .map_err(|error| error.to_string())?
    .collect::<std::result::Result<Vec<_>, _>>()
    .map_err(|error| error.to_string())
}

fn to_render_log_entries(
    entries: Vec<(i64, String, String, String, Option<String>)>,
) -> Vec<(i64, String, String, String)> {
    entries
        .into_iter()
        .map(
            |(created_at, event_type, title, body_markdown, _related_page_id)| {
                (created_at, event_type, title, body_markdown)
            },
        )
        .collect()
}
