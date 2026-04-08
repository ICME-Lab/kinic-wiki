// Where: crates/wiki_store/src/commit.rs
// What: Revision commit flow, section diffing, and system page updates.
// Why: The wiki should update its source-of-truth tables and rendered system pages atomically.
use rusqlite::{Connection, Transaction, params};
use uuid::Uuid;
use wiki_types::{CommitPageRevisionInput, CommitPageRevisionOutput, SystemPage};

use crate::{
    markdown::{ParsedSection, split_markdown},
    render,
    search::replace_page_sections_in_fts_tx,
    store::{WikiStore, load_page_by_id},
    system_pages::{refresh_system_pages_tx, render_index_page_now, render_log_page_now},
};

impl WikiStore {
    pub fn render_index_page(&self, updated_at: i64) -> Result<SystemPage, String> {
        let conn = self.open()?;
        render_index_page_now(&conn, updated_at)
    }

    pub fn render_log_page(&self, limit: usize, updated_at: i64) -> Result<SystemPage, String> {
        let conn = self.open()?;
        render_log_page_now(&conn, limit, updated_at)
    }
}

pub(crate) fn commit_revision_tx(
    conn: &mut Connection,
    input: &CommitPageRevisionInput,
) -> Result<CommitPageRevisionOutput, String> {
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    let output = commit_revision_in_tx(&tx, input)?;
    tx.commit().map_err(|error| error.to_string())?;
    Ok(output)
}

pub(crate) fn commit_revision_in_tx(
    tx: &Transaction<'_>,
    input: &CommitPageRevisionInput,
) -> Result<CommitPageRevisionOutput, String> {
    let mut page =
        load_page_by_id(tx, &input.page_id)?.ok_or_else(|| "page does not exist".to_string())?;
    if input.markdown.trim().is_empty() {
        return Err("markdown must not be empty".to_string());
    }
    if page.current_revision_id != input.expected_current_revision_id {
        return Err("expected_current_revision_id does not match current revision".to_string());
    }

    let revision_no = next_revision_no(tx, &page.id)?;
    let revision_id = format!("revision_{}", Uuid::new_v4());
    let new_sections = split_markdown(&input.markdown)?;
    if new_sections.is_empty() {
        return Err("section split produced no sections".to_string());
    }
    let old_sections = load_current_section_rows(tx, &page.id)?;
    let old_by_path = old_sections
        .iter()
        .map(|section| (section.section_path.clone(), section.content_hash.clone()))
        .collect::<std::collections::HashMap<_, _>>();

    tx.execute(
        "INSERT INTO wiki_revisions (id, page_id, revision_no, markdown, change_reason, author_type, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            revision_id,
            page.id,
            revision_no,
            input.markdown,
            input.change_reason,
            input.author_type,
            input.updated_at,
        ],
    )
    .map_err(|error| error.to_string())?;

    tx.execute(
        "UPDATE wiki_sections SET is_current = 0 WHERE page_id = ?1 AND is_current = 1",
        params![page.id],
    )
    .map_err(|error| error.to_string())?;
    store_sections(tx, &page.id, &revision_id, &new_sections)?;

    page.current_revision_id = Some(revision_id.clone());
    page.title = input.title.clone();
    page.summary_1line = Some(render::summary_from_title(&input.title, &page.page_type));
    page.updated_at = input.updated_at;
    tx.execute(
        "UPDATE wiki_pages
         SET title = ?1, current_revision_id = ?2, summary_1line = ?3, updated_at = ?4
         WHERE id = ?5",
        params![
            page.title,
            revision_id,
            page.summary_1line,
            page.updated_at,
            page.id
        ],
    )
    .map_err(|error| error.to_string())?;
    replace_page_sections_in_fts_tx(
        tx,
        &page,
        &new_sections
            .iter()
            .map(|section| {
                (
                    section.section_path.clone(),
                    section.heading.clone(),
                    section.text.clone(),
                )
            })
            .collect::<Vec<_>>(),
    )?;

    append_log_event(tx, &page.id, revision_no, &input.title, input.updated_at)?;
    let (changed_section_paths, removed_section_paths, unchanged_count) =
        diff_section_paths(&new_sections, &old_by_path);
    let system_pages = refresh_system_pages_tx(tx, input.updated_at)?;

    Ok(CommitPageRevisionOutput {
        revision_id,
        revision_no: u64::try_from(revision_no)
            .map_err(|_| "revision_no must not be negative".to_string())?,
        section_count: new_sections.len() as u32,
        unchanged_section_count: unchanged_count,
        changed_section_paths,
        removed_section_paths,
        rendered_system_pages: system_pages.iter().map(|page| page.slug.clone()).collect(),
    })
}

#[derive(Clone, Debug)]
struct StoredSection {
    section_path: String,
    content_hash: String,
}

fn load_current_section_rows(
    conn: &Connection,
    page_id: &str,
) -> Result<Vec<StoredSection>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT section_path, content_hash
             FROM wiki_sections WHERE page_id = ?1 AND is_current = 1
             ORDER BY ordinal",
        )
        .map_err(|error| error.to_string())?;
    stmt.query_map(params![page_id], |row| {
        Ok(StoredSection {
            section_path: row.get(0)?,
            content_hash: row.get(1)?,
        })
    })
    .map_err(|error| error.to_string())?
    .collect::<std::result::Result<Vec<_>, _>>()
    .map_err(|error| error.to_string())
}

fn next_revision_no(conn: &Connection, page_id: &str) -> Result<i64, String> {
    conn.query_row(
        "SELECT COALESCE(MAX(revision_no), 0) + 1 FROM wiki_revisions WHERE page_id = ?1",
        params![page_id],
        |row| row.get(0),
    )
    .map_err(|error| error.to_string())
}

fn store_sections(
    conn: &Connection,
    page_id: &str,
    revision_id: &str,
    sections: &[ParsedSection],
) -> Result<(), String> {
    for section in sections {
        conn.execute(
            "INSERT INTO wiki_sections (
                id, page_id, revision_id, section_path, ordinal, heading, text, content_hash, is_current
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1)",
            params![
                format!("section_{}", Uuid::new_v4()),
                page_id,
                revision_id,
                section.section_path,
                section.ordinal,
                section.heading,
                section.text,
                section.content_hash,
            ],
        )
        .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn diff_section_paths(
    new_sections: &[ParsedSection],
    old_by_path: &std::collections::HashMap<String, String>,
) -> (Vec<String>, Vec<String>, u32) {
    let mut changed = Vec::new();
    let mut removed = old_by_path.keys().cloned().collect::<Vec<_>>();
    let mut unchanged = 0_u32;

    for section in new_sections {
        if old_by_path.get(&section.section_path) == Some(&section.content_hash) {
            unchanged += 1;
        } else {
            changed.push(section.section_path.clone());
        }
        removed.retain(|path| path != &section.section_path);
    }

    (changed, removed, unchanged)
}

fn append_log_event(
    conn: &Connection,
    page_id: &str,
    revision_no: i64,
    title: &str,
    created_at: i64,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO log_events (id, event_type, title, body_markdown, related_page_id, created_at)
         VALUES (?1, 'commit_page_revision', ?2, ?3, ?4, ?5)",
        params![
            format!("log_{}", Uuid::new_v4()),
            title,
            format!("Committed revision {revision_no}"),
            page_id,
            created_at,
        ],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}
