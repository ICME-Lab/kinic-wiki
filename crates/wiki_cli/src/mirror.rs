// Where: crates/wiki_cli/src/mirror.rs
// What: Local mirror file operations shared by CLI pull and push.
// Why: Agents need the same vault-facing mirror layout that humans inspect in Obsidian.
#[path = "mirror_frontmatter.rs"]
mod mirror_frontmatter;
#[path = "mirror_normalize.rs"]
mod mirror_normalize;

use self::mirror_frontmatter::{
    parse_mirror_frontmatter, serialize_mirror_file, strip_managed_frontmatter,
};
use self::mirror_normalize::{normalize_page_markdown, normalize_system_markdown};
use anyhow::{Context, Result};
pub use mirror_frontmatter::MirrorFrontmatter;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use wiki_types::{KnownPageRevision, SystemPageSnapshot, WikiPageSnapshot};

#[derive(Clone, Debug)]
pub struct ManagedPage {
    pub path: PathBuf,
    pub metadata: MirrorFrontmatter,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct MirrorState {
    pub snapshot_revision: String,
    pub last_synced_at: i64,
}

pub fn load_state(mirror_root: &Path) -> Result<MirrorState> {
    let path = state_path(mirror_root);
    if !path.exists() {
        return Ok(MirrorState::default());
    }
    serde_json::from_str(
        &fs::read_to_string(&path).with_context(|| format!("failed to read {}", path.display()))?,
    )
    .with_context(|| format!("failed to parse {}", path.display()))
}

pub fn save_state(mirror_root: &Path, state: &MirrorState) -> Result<()> {
    fs::create_dir_all(mirror_root)
        .with_context(|| format!("failed to create {}", mirror_root.display()))?;
    let path = state_path(mirror_root);
    fs::write(&path, serde_json::to_string_pretty(state)?)
        .with_context(|| format!("failed to write {}", path.display()))
}

pub fn collect_known_pages(mirror_root: &Path) -> Result<Vec<KnownPageRevision>> {
    Ok(collect_managed_pages(mirror_root)?
        .into_iter()
        .map(|page| KnownPageRevision {
            page_id: page.metadata.page_id,
            revision_id: page.metadata.revision_id,
        })
        .collect())
}

pub fn collect_changed_pages(mirror_root: &Path, last_synced_at: i64) -> Result<Vec<ManagedPage>> {
    Ok(collect_managed_pages(mirror_root)?
        .into_iter()
        .filter(|page| file_mtime_millis(&page.path).unwrap_or_default() > last_synced_at)
        .collect())
}

pub fn remove_stale_managed_pages(
    mirror_root: &Path,
    active_page_ids: &HashSet<String>,
) -> Result<()> {
    for page in collect_managed_pages(mirror_root)? {
        if !active_page_ids.contains(&page.metadata.page_id) {
            fs::remove_file(&page.path)
                .with_context(|| format!("failed to remove {}", page.path.display()))?;
        }
    }
    Ok(())
}

pub fn remove_managed_pages_by_id(mirror_root: &Path, removed_ids: &[String]) -> Result<()> {
    let removed = removed_ids.iter().cloned().collect::<HashSet<_>>();
    for page in collect_managed_pages(mirror_root)? {
        if removed.contains(&page.metadata.page_id) {
            fs::remove_file(&page.path)
                .with_context(|| format!("failed to remove {}", page.path.display()))?;
        }
    }
    Ok(())
}

pub fn write_snapshot_mirror(
    mirror_root: &Path,
    pages: &[WikiPageSnapshot],
    system_pages: &[SystemPageSnapshot],
) -> Result<()> {
    let mut known_slugs = collect_managed_pages(mirror_root)?
        .into_iter()
        .map(|page| page.metadata.slug)
        .collect::<HashSet<_>>();
    known_slugs.extend(pages.iter().map(|page| page.slug.clone()));
    fs::create_dir_all(pages_dir(mirror_root))
        .with_context(|| format!("failed to create {}", pages_dir(mirror_root).display()))?;
    for system_page in system_pages {
        let path = mirror_root.join(&system_page.slug);
        fs::write(
            &path,
            normalize_system_markdown(&system_page.markdown, &known_slugs),
        )
        .with_context(|| format!("failed to write {}", path.display()))?;
    }
    for page in pages {
        write_page_mirror(mirror_root, page, &known_slugs)?;
    }
    Ok(())
}

pub fn write_page_mirror(
    mirror_root: &Path,
    page: &WikiPageSnapshot,
    known_slugs: &HashSet<String>,
) -> Result<()> {
    let frontmatter = MirrorFrontmatter {
        page_id: page.page_id.clone(),
        slug: page.slug.clone(),
        page_type: page.page_type.as_str().to_string(),
        revision_id: page.revision_id.clone(),
        updated_at: page.updated_at,
        mirror: true,
    };
    let path = page_path(mirror_root, &page.slug);
    fs::write(
        &path,
        serialize_mirror_file(
            &frontmatter,
            &normalize_page_markdown(&page.markdown, known_slugs),
        ),
    )
    .with_context(|| format!("failed to write {}", path.display()))
}

pub fn update_local_revision_metadata(
    mirror_root: &Path,
    page_id: &str,
    revision_id: &str,
    updated_at: i64,
) -> Result<()> {
    for page in collect_managed_pages(mirror_root)? {
        if page.metadata.page_id == page_id {
            let body = strip_managed_frontmatter(
                &fs::read_to_string(&page.path)
                    .with_context(|| format!("failed to read {}", page.path.display()))?,
            );
            let updated = MirrorFrontmatter {
                revision_id: revision_id.to_string(),
                updated_at,
                ..page.metadata
            };
            fs::write(&page.path, serialize_mirror_file(&updated, &body))
                .with_context(|| format!("failed to write {}", page.path.display()))?;
            break;
        }
    }
    Ok(())
}

pub fn write_conflict_file(mirror_root: &Path, slug: &str, markdown: &str) -> Result<()> {
    let dir = mirror_root.join("conflicts");
    fs::create_dir_all(&dir).with_context(|| format!("failed to create {}", dir.display()))?;
    let path = dir.join(format!("{slug}.conflict.md"));
    fs::write(&path, markdown).with_context(|| format!("failed to write {}", path.display()))
}

pub fn read_managed_page_markdown(page: &ManagedPage) -> Result<String> {
    let content = fs::read_to_string(&page.path)
        .with_context(|| format!("failed to read {}", page.path.display()))?;
    Ok(strip_managed_frontmatter(&content).trim_start().to_string())
}

fn collect_managed_pages(mirror_root: &Path) -> Result<Vec<ManagedPage>> {
    let dir = pages_dir(mirror_root);
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut results = Vec::new();
    for entry in fs::read_dir(&dir).with_context(|| format!("failed to read {}", dir.display()))? {
        let path = entry?.path();
        if path.extension().and_then(|value| value.to_str()) != Some("md") {
            continue;
        }
        let content = fs::read_to_string(&path)
            .with_context(|| format!("failed to read {}", path.display()))?;
        if let Some(metadata) = parse_mirror_frontmatter(&content) {
            results.push(ManagedPage { path, metadata });
        }
    }
    Ok(results)
}

fn page_path(mirror_root: &Path, slug: &str) -> PathBuf {
    pages_dir(mirror_root).join(format!("{slug}.md"))
}

fn pages_dir(mirror_root: &Path) -> PathBuf {
    mirror_root.join("pages")
}

fn state_path(mirror_root: &Path) -> PathBuf {
    mirror_root.join(".wiki-sync-state.json")
}

fn file_mtime_millis(path: &Path) -> Result<i64> {
    let modified = fs::metadata(path)
        .with_context(|| format!("failed to stat {}", path.display()))?
        .modified()
        .with_context(|| format!("failed to read mtime {}", path.display()))?;
    Ok(system_time_millis(modified))
}

pub fn now_millis() -> i64 {
    system_time_millis(SystemTime::now())
}

fn system_time_millis(time: SystemTime) -> i64 {
    time.duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
