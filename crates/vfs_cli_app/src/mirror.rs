// Where: crates/wiki_cli/src/mirror.rs
// What: Local mirror file operations shared by CLI pull and push.
// Why: The CLI mirrors remote node paths directly and tracks etags for optimistic concurrency.
#[path = "mirror_frontmatter.rs"]
mod mirror_frontmatter;

use anyhow::{Context, Result};
pub use mirror_frontmatter::{
    MirrorFrontmatter, parse_mirror_frontmatter as parse_managed_metadata, serialize_mirror_file,
    strip_any_frontmatter, strip_managed_frontmatter,
};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use vfs_types::{Node, NodeKind};
use wiki_domain::{normalize_wiki_remote_path, wiki_relative_path};

const CONFLICT_FILE_SUFFIX: &str = ".conflict.md";
const CONFLICT_HASH_SEPARATOR: &str = "--";
const CONFLICT_HASH_HEX_LEN: usize = 16;
const CONFLICT_MAX_COMPONENT_BYTES: usize = 255;
const CONFLICT_STEM_SEGMENTS: usize = 2;
const CONFLICT_FALLBACK_STEM: &str = "conflict";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ManagedNode {
    pub path: PathBuf,
    pub metadata: MirrorFrontmatter,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TrackedNodeState {
    pub path: String,
    pub kind: NodeKind,
    pub etag: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct MirrorState {
    pub snapshot_revision: String,
    pub last_synced_at: i64,
    pub tracked_nodes: Vec<TrackedNodeState>,
}

fn is_valid_snapshot_revision(snapshot_revision: &str) -> bool {
    let mut parts = snapshot_revision.split(':');
    let Some(version) = parts.next() else {
        return false;
    };
    let Some(revision) = parts.next() else {
        return false;
    };
    let Some(prefix_hex) = parts.next() else {
        return false;
    };
    if parts.next().is_some() || version != "v5" {
        return false;
    }
    if revision.is_empty() || (revision.starts_with('0') && revision != "0") {
        return false;
    }
    if !revision.chars().all(|char| char.is_ascii_digit()) {
        return false;
    }
    !prefix_hex.is_empty() && prefix_hex.chars().all(|char| char.is_ascii_hexdigit())
}

pub fn snapshot_revision_is_valid(snapshot_revision: &str) -> bool {
    is_valid_snapshot_revision(snapshot_revision.trim())
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

pub fn collect_managed_nodes(mirror_root: &Path) -> Result<Vec<ManagedNode>> {
    let mut results = Vec::new();
    collect_files(mirror_root, mirror_root, &mut results)?;
    Ok(results)
}

pub fn collect_changed_nodes(mirror_root: &Path, last_synced_at: i64) -> Result<Vec<ManagedNode>> {
    Ok(collect_managed_nodes(mirror_root)?
        .into_iter()
        .filter(|node| file_mtime_millis(&node.path).unwrap_or_default() > last_synced_at)
        .collect())
}

pub fn remove_mirror_paths(mirror_root: &Path, removed_paths: &[String]) -> Result<()> {
    for remote_path in removed_paths {
        let local_path = local_path_for_remote(mirror_root, remote_path)?;
        if local_path.exists() {
            fs::remove_file(&local_path)
                .with_context(|| format!("failed to remove {}", local_path.display()))?;
        }
    }
    Ok(())
}

pub fn remove_stale_managed_files(
    mirror_root: &Path,
    active_paths: &HashSet<String>,
) -> Result<()> {
    for node in collect_managed_nodes(mirror_root)? {
        if !active_paths.contains(&node.metadata.path) {
            fs::remove_file(&node.path)
                .with_context(|| format!("failed to remove {}", node.path.display()))?;
        }
    }
    Ok(())
}

pub fn write_node_mirror(mirror_root: &Path, node: &Node) -> Result<()> {
    let local_path = local_path_for_remote(mirror_root, &node.path)?;
    if let Some(parent) = local_path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create {}", parent.display()))?;
    }
    let frontmatter = MirrorFrontmatter {
        path: node.path.clone(),
        kind: node.kind.clone(),
        etag: node.etag.clone(),
        updated_at: node.updated_at,
        mirror: true,
    };
    fs::write(
        &local_path,
        mirror_frontmatter::serialize_mirror_file(&frontmatter, &node.content),
    )
    .with_context(|| format!("failed to write {}", local_path.display()))
}

pub fn write_snapshot_mirror(mirror_root: &Path, nodes: &[Node]) -> Result<()> {
    for node in nodes {
        write_node_mirror(mirror_root, node)?;
    }
    Ok(())
}

pub fn update_local_node_metadata(mirror_root: &Path, node: &Node) -> Result<()> {
    write_node_mirror(mirror_root, node)
}

pub fn tracked_nodes_from_snapshot(nodes: &[Node]) -> Vec<TrackedNodeState> {
    nodes
        .iter()
        .map(|node| TrackedNodeState {
            path: node.path.clone(),
            kind: node.kind.clone(),
            etag: node.etag.clone(),
        })
        .collect()
}

pub fn merge_tracked_nodes(
    tracked_nodes: &[TrackedNodeState],
    changed_nodes: &[Node],
    removed_paths: &[String],
) -> Vec<TrackedNodeState> {
    let removed = removed_paths.iter().collect::<HashSet<_>>();
    let mut merged = tracked_nodes
        .iter()
        .filter(|tracked| !removed.contains(&tracked.path))
        .cloned()
        .collect::<Vec<_>>();
    for node in changed_nodes {
        if let Some(existing) = merged.iter_mut().find(|tracked| tracked.path == node.path) {
            existing.kind = node.kind.clone();
            existing.etag = node.etag.clone();
            continue;
        }
        merged.push(TrackedNodeState {
            path: node.path.clone(),
            kind: node.kind.clone(),
            etag: node.etag.clone(),
        });
    }
    merged.sort_by(|left, right| left.path.cmp(&right.path));
    merged
}

pub fn deleted_tracked_nodes(
    mirror_root: &Path,
    tracked_nodes: &[TrackedNodeState],
) -> Result<Vec<TrackedNodeState>> {
    find_deleted_tracked_nodes(
        tracked_nodes,
        |remote_path| local_path_for_remote(mirror_root, remote_path),
        |local_path| local_path.is_file(),
    )
}

pub fn write_conflict_file(mirror_root: &Path, remote_path: &str, markdown: &str) -> Result<()> {
    let dir = mirror_root.join("conflicts");
    fs::create_dir_all(&dir).with_context(|| format!("failed to create {}", dir.display()))?;
    let path = conflict_file_path(mirror_root, remote_path)?;
    fs::write(&path, markdown).with_context(|| format!("failed to write {}", path.display()))
}

pub fn conflict_file_path(mirror_root: &Path, remote_path: &str) -> Result<PathBuf> {
    let normalized = normalize_wiki_remote_path(remote_path).map_err(anyhow::Error::msg)?;
    let relative = wiki_relative_path(&normalized).map_err(anyhow::Error::msg)?;
    let stem = short_conflict_stem(relative);
    let hash = short_conflict_hash(&normalized);
    let file_name = format!("{stem}{CONFLICT_HASH_SEPARATOR}{hash}{CONFLICT_FILE_SUFFIX}");
    Ok(mirror_root.join("conflicts").join(file_name))
}

fn short_conflict_stem(relative_path: &str) -> String {
    let mut segments = relative_path
        .split('/')
        .filter(|segment| !segment.is_empty())
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    if let Some(last) = segments.last_mut()
        && let Some(stem) = Path::new(last).file_stem().and_then(|value| value.to_str())
    {
        *last = stem.to_string();
    }
    let start = segments.len().saturating_sub(CONFLICT_STEM_SEGMENTS);
    let stem = segments[start..]
        .iter()
        .map(|segment| sanitize_conflict_segment(segment))
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>()
        .join("__");
    truncate_conflict_stem(if stem.is_empty() {
        CONFLICT_FALLBACK_STEM.to_string()
    } else {
        stem
    })
}

fn sanitize_conflict_segment(segment: &str) -> String {
    segment
        .chars()
        .fold((String::new(), false), |(mut out, last_was_dash), ch| {
            if ch.is_ascii_alphanumeric() {
                out.push(ch.to_ascii_lowercase());
                (out, false)
            } else if last_was_dash {
                (out, true)
            } else {
                out.push('-');
                (out, true)
            }
        })
        .0
        .trim_matches('-')
        .to_string()
}

fn truncate_conflict_stem(stem: String) -> String {
    let max_stem_bytes = CONFLICT_MAX_COMPONENT_BYTES
        - CONFLICT_HASH_SEPARATOR.len()
        - CONFLICT_HASH_HEX_LEN
        - CONFLICT_FILE_SUFFIX.len();
    stem.chars().take(max_stem_bytes).collect()
}

fn short_conflict_hash(normalized_remote_path: &str) -> String {
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    for byte in normalized_remote_path.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:0width$x}", width = CONFLICT_HASH_HEX_LEN)
}

pub fn read_managed_node_content(node: &ManagedNode) -> Result<String> {
    let content = fs::read_to_string(&node.path)
        .with_context(|| format!("failed to read {}", node.path.display()))?;
    Ok(strip_managed_frontmatter(&content).trim_start().to_string())
}

pub fn local_path_for_remote(mirror_root: &Path, remote_path: &str) -> Result<PathBuf> {
    let relative = wiki_relative_path(remote_path).map_err(anyhow::Error::msg)?;
    Ok(mirror_root.join(relative))
}

pub fn now_millis() -> i64 {
    system_time_millis(SystemTime::now())
}

pub fn strip_frontmatter(content: &str) -> String {
    strip_any_frontmatter(content)
}

pub fn find_deleted_tracked_nodes<ToLocalPath, LocalFileExists>(
    tracked_nodes: &[TrackedNodeState],
    to_local_path: ToLocalPath,
    local_file_exists: LocalFileExists,
) -> Result<Vec<TrackedNodeState>>
where
    ToLocalPath: Fn(&str) -> Result<PathBuf>,
    LocalFileExists: Fn(&Path) -> bool,
{
    let mut deleted = Vec::new();
    for tracked in tracked_nodes {
        let local_path = to_local_path(&tracked.path)?;
        if !local_file_exists(&local_path) {
            deleted.push(tracked.clone());
        }
    }
    Ok(deleted)
}

fn collect_files(root: &Path, current: &Path, results: &mut Vec<ManagedNode>) -> Result<()> {
    if !current.exists() {
        return Ok(());
    }
    for entry in
        fs::read_dir(current).with_context(|| format!("failed to read {}", current.display()))?
    {
        let path = entry?.path();
        if path == state_path(root) || path.starts_with(root.join("conflicts")) {
            continue;
        }
        if path.is_dir() {
            collect_files(root, &path, results)?;
            continue;
        }
        let content = fs::read_to_string(&path)
            .with_context(|| format!("failed to read {}", path.display()))?;
        if let Some(metadata) = mirror_frontmatter::parse_mirror_frontmatter(&content) {
            results.push(ManagedNode { path, metadata });
        }
    }
    Ok(())
}

fn state_path(mirror_root: &Path) -> PathBuf {
    mirror_root.join(".wiki-fs-state.json")
}

fn file_mtime_millis(path: &Path) -> Result<i64> {
    let modified = fs::metadata(path)
        .with_context(|| format!("failed to stat {}", path.display()))?
        .modified()
        .with_context(|| format!("failed to read mtime {}", path.display()))?;
    Ok(system_time_millis(modified))
}

fn system_time_millis(time: SystemTime) -> i64 {
    time.duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
