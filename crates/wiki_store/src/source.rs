// Where: crates/wiki_store/src/source.rs
// What: Source-of-truth CRUD and readers for raw sources and system pages.
// Why: Initial wiki operation stores raw source bodies once and keeps provenance in markdown, not DB-side citations.
use rusqlite::{Connection, OptionalExtension, params};
use uuid::Uuid;
use wiki_types::{CreateSourceInput, SystemPage};

pub(crate) fn create_source_row(
    conn: &Connection,
    input: CreateSourceInput,
) -> Result<String, String> {
    if input.source_type.trim().is_empty() {
        return Err("source_type must not be empty".to_string());
    }
    if input.sha256.trim().is_empty() {
        return Err("sha256 must not be empty".to_string());
    }
    if input.body_text.trim().is_empty() {
        return Err("body_text must not be empty".to_string());
    }

    let source_id = format!("source_{}", Uuid::new_v4());
    conn.execute(
        "INSERT INTO sources (
            id, source_type, title, canonical_uri, sha256, mime_type, imported_at, metadata_json
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            source_id,
            input.source_type,
            input.title,
            input.canonical_uri,
            input.sha256,
            input.mime_type,
            input.imported_at,
            input.metadata_json,
        ],
    )
    .map_err(|error| error.to_string())?;
    conn.execute(
        "INSERT INTO source_bodies (source_id, body_text) VALUES (?1, ?2)",
        params![source_id, input.body_text],
    )
    .map_err(|error| error.to_string())?;
    Ok(source_id)
}

pub(crate) fn count_sources(conn: &Connection) -> Result<u64, String> {
    conn.query_row("SELECT COUNT(*) FROM sources", [], |row| {
        row.get::<_, i64>(0)
    })
    .map_err(|error| error.to_string())
    .and_then(to_u64)
}

pub(crate) fn load_system_page(
    conn: &Connection,
    slug: &str,
) -> Result<Option<SystemPage>, String> {
    conn.query_row(
        "SELECT slug, markdown, updated_at, etag FROM system_pages WHERE slug = ?1",
        params![slug],
        |row| {
            Ok(SystemPage {
                slug: row.get(0)?,
                markdown: row.get(1)?,
                updated_at: row.get(2)?,
                etag: row.get(3)?,
            })
        },
    )
    .optional()
    .map_err(|error| error.to_string())
}

fn to_u64(value: i64) -> Result<u64, String> {
    u64::try_from(value).map_err(|_| "count must not be negative".to_string())
}
