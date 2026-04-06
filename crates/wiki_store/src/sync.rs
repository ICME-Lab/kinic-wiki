// Where: crates/wiki_store/src/sync.rs
// What: Snapshot export, update fetch, and push-style commit helpers for local wiki working copies.
// Why: Local editors need clone/fetch/push semantics without changing the source-of-truth storage model.
use std::collections::{BTreeSet, HashMap};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OptionalExtension, params};
use wiki_types::{
    CommitPageRevisionInput, CommitWikiChangesRequest, CommitWikiChangesResponse,
    CommittedPageResult, ExportWikiSnapshotRequest, ExportWikiSnapshotResponse,
    FetchWikiUpdatesRequest, FetchWikiUpdatesResponse, PageChangeInput, PageChangeType,
    RejectedPageResult, SectionHashEntry, SystemPageSnapshot, WikiPageSnapshot, WikiSyncManifest,
    WikiPageType, WikiSyncManifestDelta, WikiSyncManifestEntry,
};

use crate::{
    commit::commit_revision_tx,
    hashing::sha256_hex,
    markdown::split_markdown,
    store::{load_page_by_id, load_revision},
    system_pages::refresh_system_pages_tx,
};

pub(crate) fn export_snapshot(
    conn: &Connection,
    request: ExportWikiSnapshotRequest,
) -> Result<ExportWikiSnapshotResponse, String> {
    let manifest = load_manifest(conn, None)?;
    let pages = load_page_snapshots(conn, request.page_slugs)?;
    let system_pages = if request.include_system_pages {
        load_system_page_snapshots(conn)?
    } else {
        Vec::new()
    };
    Ok(ExportWikiSnapshotResponse {
        snapshot_revision: manifest.snapshot_revision.clone(),
        pages,
        system_pages,
        manifest,
    })
}

pub(crate) fn fetch_updates(
    conn: &Connection,
    request: FetchWikiUpdatesRequest,
) -> Result<FetchWikiUpdatesResponse, String> {
    let all_pages = load_page_snapshots(conn, None)?;
    let manifest = load_manifest(conn, None)?;
    if request.known_snapshot_revision == manifest.snapshot_revision {
        return Ok(FetchWikiUpdatesResponse {
            snapshot_revision: manifest.snapshot_revision.clone(),
            changed_pages: Vec::new(),
            removed_page_ids: Vec::new(),
            system_pages: Vec::new(),
            manifest_delta: WikiSyncManifestDelta {
                upserted_pages: Vec::new(),
                removed_page_ids: Vec::new(),
            },
        });
    }

    let known = request
        .known_page_revisions
        .into_iter()
        .map(|entry| (entry.page_id, entry.revision_id))
        .collect::<std::collections::HashMap<_, _>>();
    let current_entries = manifest
        .pages
        .iter()
        .map(|entry| {
            (
                entry.page_id.clone(),
                entry.revision_id.clone(),
                entry.clone(),
            )
        })
        .collect::<Vec<_>>();

    let changed_pages = all_pages
        .iter()
        .filter(|page| known.get(&page.page_id) != Some(&page.revision_id))
        .cloned()
        .collect::<Vec<_>>();
    let removed_page_ids = known
        .keys()
        .filter(|page_id| !current_entries.iter().any(|(id, _, _)| id == *page_id))
        .cloned()
        .collect::<Vec<_>>();
    let upserted_pages = current_entries
        .into_iter()
        .filter(|(page_id, revision_id, _)| known.get(page_id) != Some(revision_id))
        .map(|(_, _, entry)| entry)
        .collect::<Vec<_>>();

    Ok(FetchWikiUpdatesResponse {
        snapshot_revision: manifest.snapshot_revision.clone(),
        changed_pages,
        removed_page_ids: removed_page_ids.clone(),
        system_pages: if request.include_system_pages {
            load_system_page_snapshots(conn)?
        } else {
            Vec::new()
        },
        manifest_delta: WikiSyncManifestDelta {
            upserted_pages,
            removed_page_ids,
        },
    })
}

pub(crate) fn commit_wiki_changes(
    conn: &mut Connection,
    request: CommitWikiChangesRequest,
) -> Result<CommitWikiChangesResponse, String> {
    let current_snapshot = load_manifest(conn, None)?.snapshot_revision;
    let snapshot_was_stale = request.base_snapshot_revision != current_snapshot;

    let mut committed_pages = Vec::new();
    let mut rejected_pages = Vec::new();
    let mut removed_page_ids = Vec::new();
    for change in request.page_changes {
        let page_id = change.page_id.clone();
        let Some(page) = load_page_by_id(conn, &page_id)? else {
            rejected_pages.push(not_found_rejection(page_id));
            continue;
        };
        let current_revision_id = page.current_revision_id.clone().unwrap_or_default();
        if current_revision_id != change.base_revision_id {
            rejected_pages.push(build_conflict_rejection(
                conn,
                &page.id,
                &change,
                "base revision does not match current revision",
            )?);
            continue;
        }

        match change.change_type {
            PageChangeType::Update => {
                let Some(new_markdown) = change.new_markdown.clone() else {
                    rejected_pages.push(simple_rejection(
                        page.id.clone(),
                        "new_markdown is required for update",
                    ));
                    continue;
                };
                let title = first_heading_title(&new_markdown).unwrap_or(page.title.clone());
                let output = commit_revision_tx(
                    conn,
                    &CommitPageRevisionInput {
                        page_id: page.id.clone(),
                        expected_current_revision_id: Some(change.base_revision_id.clone()),
                        title,
                        markdown: new_markdown,
                        change_reason: "sync commit".to_string(),
                        author_type: "sync".to_string(),
                        tags: Vec::new(),
                        updated_at: unix_timestamp_now(),
                    },
                )?;
                committed_pages.push(CommittedPageResult {
                    page_id: page.id.clone(),
                    revision_id: output.revision_id,
                    section_hashes: load_section_hashes(conn, &page.id)?,
                });
            }
            PageChangeType::Delete => {
                delete_page_tx(conn, &page.id, unix_timestamp_now())?;
                removed_page_ids.push(page.id.clone());
            }
        }
    }

    let manifest = load_manifest(conn, None)?;
    let upserted_pages = committed_pages
        .iter()
        .map(|page| load_manifest_entry(conn, &page.page_id))
        .collect::<Result<Vec<_>, String>>()?;
    Ok(CommitWikiChangesResponse {
        committed_pages,
        rejected_pages,
        snapshot_revision: manifest.snapshot_revision.clone(),
        snapshot_was_stale,
        system_pages: load_system_page_snapshots(conn)?,
        manifest_delta: WikiSyncManifestDelta {
            upserted_pages,
            removed_page_ids,
        },
    })
}

fn delete_page_tx(conn: &mut Connection, page_id: &str, updated_at: i64) -> Result<(), String> {
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    let title = tx
        .query_row(
            "SELECT title FROM wiki_pages WHERE id = ?1",
            params![page_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "page does not exist".to_string())?;
    tx.execute(
        "DELETE FROM wiki_sections_fts WHERE page_id = ?1",
        params![page_id],
    )
    .map_err(|error| error.to_string())?;
    tx.execute(
        "DELETE FROM wiki_sections WHERE page_id = ?1",
        params![page_id],
    )
    .map_err(|error| error.to_string())?;
    tx.execute(
        "DELETE FROM wiki_revisions WHERE page_id = ?1",
        params![page_id],
    )
    .map_err(|error| error.to_string())?;
    tx.execute("DELETE FROM wiki_pages WHERE id = ?1", params![page_id])
        .map_err(|error| error.to_string())?;
    tx.execute(
        "INSERT INTO log_events (id, event_type, title, body_markdown, related_page_id, created_at)
         VALUES (?1, 'delete_page', ?2, ?3, ?4, ?5)",
        params![
            format!("log_delete_{}", page_id),
            title,
            "Deleted page via sync commit",
            page_id,
            updated_at,
        ],
    )
    .map_err(|error| error.to_string())?;
    refresh_system_pages_tx(&tx, updated_at)?;
    tx.commit().map_err(|error| error.to_string())
}

fn build_conflict_rejection(
    conn: &Connection,
    page_id: &str,
    change: &PageChangeInput,
    reason: &str,
) -> Result<RejectedPageResult, String> {
    let base_markdown = load_revision(conn, &change.base_revision_id)?
        .map(|revision| revision.markdown)
        .ok_or_else(|| "base revision is missing".to_string())?;
    let page = load_page_by_id(conn, page_id)?.ok_or_else(|| "page does not exist".to_string())?;
    let current_revision_id = page
        .current_revision_id
        .clone()
        .ok_or_else(|| "page has no current revision".to_string())?;
    let remote_markdown = load_revision(conn, &current_revision_id)?
        .map(|revision| revision.markdown)
        .ok_or_else(|| "current revision is missing".to_string())?;
    let local_markdown = match change.change_type {
        PageChangeType::Update => change.new_markdown.clone().unwrap_or_default(),
        PageChangeType::Delete => String::new(),
    };
    let local_changed = changed_section_paths(&base_markdown, &local_markdown)?;
    let remote_changed = changed_section_paths(&base_markdown, &remote_markdown)?;
    let conflicting_section_paths = local_changed
        .intersection(&remote_changed)
        .cloned()
        .collect::<Vec<_>>();
    Ok(RejectedPageResult {
        page_id: page_id.to_string(),
        reason: reason.to_string(),
        conflicting_section_paths,
        local_changed_section_paths: local_changed.into_iter().collect(),
        remote_changed_section_paths: remote_changed.into_iter().collect(),
        conflict_markdown: Some(render_conflict_markdown(
            &local_markdown,
            &remote_markdown,
            change.change_type == PageChangeType::Delete,
        )),
    })
}

fn changed_section_paths(
    base_markdown: &str,
    next_markdown: &str,
) -> Result<BTreeSet<String>, String> {
    let base = split_markdown(base_markdown)?
        .into_iter()
        .map(|section| (section.section_path, section.content_hash))
        .collect::<HashMap<_, _>>();
    let next = split_markdown(next_markdown)?
        .into_iter()
        .map(|section| (section.section_path, section.content_hash))
        .collect::<HashMap<_, _>>();
    let paths = base
        .keys()
        .chain(next.keys())
        .cloned()
        .collect::<BTreeSet<_>>();
    Ok(paths
        .into_iter()
        .filter(|path| base.get(path) != next.get(path))
        .collect())
}

fn render_conflict_markdown(
    local_markdown: &str,
    remote_markdown: &str,
    local_delete: bool,
) -> String {
    let local_body = if local_delete {
        "(deleted)".to_string()
    } else {
        local_markdown.to_string()
    };
    format!("<<<<<<< LOCAL\n{local_body}\n=======\n{remote_markdown}\n>>>>>>> REMOTE\n")
}

fn not_found_rejection(page_id: String) -> RejectedPageResult {
    simple_rejection(page_id, "page does not exist")
}

fn simple_rejection(page_id: String, reason: &str) -> RejectedPageResult {
    RejectedPageResult {
        page_id,
        reason: reason.to_string(),
        conflicting_section_paths: Vec::new(),
        local_changed_section_paths: Vec::new(),
        remote_changed_section_paths: Vec::new(),
        conflict_markdown: None,
    }
}

fn load_page_snapshots(
    conn: &Connection,
    page_slugs: Option<Vec<String>>,
) -> Result<Vec<WikiPageSnapshot>, String> {
    let rows = if let Some(slugs) = page_slugs {
        let mut snapshots = Vec::new();
        for slug in slugs {
            if let Some(snapshot) = load_page_snapshot_by_slug(conn, &slug)? {
                snapshots.push(snapshot);
            }
        }
        snapshots
    } else {
        let mut stmt = conn
            .prepare("SELECT id, slug FROM wiki_pages ORDER BY slug")
            .map_err(|error| error.to_string())?;
        let pairs = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| error.to_string())?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        let mut snapshots = Vec::new();
        for (_, slug) in pairs {
            if let Some(snapshot) = load_page_snapshot_by_slug(conn, &slug)? {
                snapshots.push(snapshot);
            }
        }
        snapshots
    };
    Ok(rows)
}

fn load_page_snapshot_by_slug(
    conn: &Connection,
    slug: &str,
) -> Result<Option<WikiPageSnapshot>, String> {
    let page_row = conn
        .query_row(
            "SELECT id, slug, page_type, title, current_revision_id FROM wiki_pages WHERE slug = ?1",
            params![slug],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<String>>(4)?,
                ))
            },
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let Some((page_id, slug, page_type, title, revision_id)) = page_row else {
        return Ok(None);
    };
    let revision_id = revision_id.ok_or_else(|| "page has no current revision".to_string())?;
    let revision = load_revision(conn, &revision_id)?
        .ok_or_else(|| "current revision is missing".to_string())?;
    Ok(Some(WikiPageSnapshot {
        page_id: page_id.clone(),
        slug,
        title,
        page_type: WikiPageType::from_str(&page_type).unwrap_or(WikiPageType::Overview),
        revision_id,
        updated_at: current_page_updated_at(conn, &page_id)?,
        markdown: revision.markdown,
        section_hashes: load_section_hashes(conn, &page_id)?,
    }))
}

fn load_section_hashes(conn: &Connection, page_id: &str) -> Result<Vec<SectionHashEntry>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT section_path, content_hash
             FROM wiki_sections WHERE page_id = ?1 AND is_current = 1
             ORDER BY ordinal",
        )
        .map_err(|error| error.to_string())?;
    stmt.query_map(params![page_id], |row| {
        Ok(SectionHashEntry {
            section_path: row.get(0)?,
            content_hash: row.get(1)?,
        })
    })
    .map_err(|error| error.to_string())?
    .collect::<std::result::Result<Vec<_>, _>>()
    .map_err(|error| error.to_string())
}

fn load_system_page_snapshots(conn: &Connection) -> Result<Vec<SystemPageSnapshot>, String> {
    let mut stmt = conn
        .prepare("SELECT slug, markdown, updated_at, etag FROM system_pages ORDER BY slug")
        .map_err(|error| error.to_string())?;
    stmt.query_map([], |row| {
        Ok(SystemPageSnapshot {
            slug: row.get(0)?,
            markdown: row.get(1)?,
            updated_at: row.get(2)?,
            etag: row.get(3)?,
        })
    })
    .map_err(|error| error.to_string())?
    .collect::<std::result::Result<Vec<_>, _>>()
    .map_err(|error| error.to_string())
}

fn load_manifest(
    conn: &Connection,
    page_slugs: Option<Vec<String>>,
) -> Result<WikiSyncManifest, String> {
    let entries = load_manifest_entries(conn, page_slugs)?;
    let hash_input = entries
        .iter()
        .map(|entry| {
            format!(
                "{}:{}:{}:{}",
                entry.page_id, entry.slug, entry.revision_id, entry.updated_at
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    Ok(WikiSyncManifest {
        snapshot_revision: sha256_hex(&hash_input),
        pages: entries,
    })
}

fn load_manifest_entries(
    conn: &Connection,
    page_slugs: Option<Vec<String>>,
) -> Result<Vec<WikiSyncManifestEntry>, String> {
    if let Some(slugs) = page_slugs {
        let mut entries = Vec::new();
        for slug in slugs {
            if let Some(entry) = load_manifest_entry_by_slug(conn, &slug)? {
                entries.push(entry);
            }
        }
        return Ok(entries);
    }

    let mut stmt = conn
        .prepare(
            "SELECT id, slug, current_revision_id, updated_at
             FROM wiki_pages ORDER BY slug",
        )
        .map_err(|error| error.to_string())?;
    stmt.query_map([], |row| {
        Ok(WikiSyncManifestEntry {
            page_id: row.get(0)?,
            slug: row.get(1)?,
            revision_id: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
            updated_at: row.get(3)?,
        })
    })
    .map_err(|error| error.to_string())?
    .collect::<std::result::Result<Vec<_>, _>>()
    .map_err(|error| error.to_string())
}

fn load_manifest_entry_by_slug(
    conn: &Connection,
    slug: &str,
) -> Result<Option<WikiSyncManifestEntry>, String> {
    conn.query_row(
        "SELECT id, slug, current_revision_id, updated_at
         FROM wiki_pages WHERE slug = ?1",
        params![slug],
        |row| {
            Ok(WikiSyncManifestEntry {
                page_id: row.get(0)?,
                slug: row.get(1)?,
                revision_id: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                updated_at: row.get(3)?,
            })
        },
    )
    .optional()
    .map_err(|error| error.to_string())
}

fn load_manifest_entry(conn: &Connection, page_id: &str) -> Result<WikiSyncManifestEntry, String> {
    conn.query_row(
        "SELECT id, slug, current_revision_id, updated_at FROM wiki_pages WHERE id = ?1",
        params![page_id],
        |row| {
            Ok(WikiSyncManifestEntry {
                page_id: row.get(0)?,
                slug: row.get(1)?,
                revision_id: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                updated_at: row.get(3)?,
            })
        },
    )
    .map_err(|error| error.to_string())
}

fn current_page_updated_at(conn: &Connection, page_id: &str) -> Result<i64, String> {
    conn.query_row(
        "SELECT updated_at FROM wiki_pages WHERE id = ?1",
        params![page_id],
        |row| row.get(0),
    )
    .map_err(|error| error.to_string())
}

fn first_heading_title(markdown: &str) -> Option<String> {
    split_markdown(markdown)
        .ok()?
        .into_iter()
        .find_map(|section| section.heading)
}

fn unix_timestamp_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_secs()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}
