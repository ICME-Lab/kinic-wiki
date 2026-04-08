// Where: crates/wiki_cli/src/mirror.rs
// What: Local mirror file operations shared by CLI pull and push.
// Why: The CLI mirrors remote node paths directly and tracks etags for optimistic concurrency.
#[path = "mirror_frontmatter.rs"]
mod mirror_frontmatter;

use anyhow::{Context, Result, anyhow};
pub use mirror_frontmatter::{
    MirrorFrontmatter, parse_mirror_frontmatter as parse_managed_metadata, serialize_mirror_file,
    strip_any_frontmatter, strip_managed_frontmatter,
};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use wiki_types::{Node, NodeKind};

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

pub fn remove_stale_managed_files(mirror_root: &Path, active_paths: &HashSet<String>) -> Result<()> {
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
    nodes.iter()
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
    let current_paths = collect_managed_nodes(mirror_root)?
        .into_iter()
        .map(|node| node.metadata.path)
        .collect::<HashSet<_>>();
    Ok(tracked_nodes
        .iter()
        .filter(|tracked| !current_paths.contains(&tracked.path))
        .cloned()
        .collect())
}

pub fn write_conflict_file(mirror_root: &Path, remote_path: &str, markdown: &str) -> Result<()> {
    let dir = mirror_root.join("conflicts");
    fs::create_dir_all(&dir).with_context(|| format!("failed to create {}", dir.display()))?;
    let name = Path::new(remote_path)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("conflict");
    let path = dir.join(format!("{name}.conflict.md"));
    fs::write(&path, markdown).with_context(|| format!("failed to write {}", path.display()))
}

pub fn read_managed_node_content(node: &ManagedNode) -> Result<String> {
    let content = fs::read_to_string(&node.path)
        .with_context(|| format!("failed to read {}", node.path.display()))?;
    Ok(strip_managed_frontmatter(&content).trim_start().to_string())
}

pub fn local_path_for_remote(mirror_root: &Path, remote_path: &str) -> Result<PathBuf> {
    let relative = remote_path
        .strip_prefix("/Wiki/")
        .or_else(|| remote_path.strip_prefix("/Wiki"))
        .ok_or_else(|| anyhow!("unsupported remote path outside /Wiki: {remote_path}"))?;
    let relative = relative.trim_start_matches('/');
    Ok(mirror_root.join(relative))
}

pub fn now_millis() -> i64 {
    system_time_millis(SystemTime::now())
}

pub fn strip_frontmatter(content: &str) -> String {
    strip_any_frontmatter(content)
}

fn collect_files(root: &Path, current: &Path, results: &mut Vec<ManagedNode>) -> Result<()> {
    if !current.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(current).with_context(|| format!("failed to read {}", current.display()))? {
        let path = entry?.path();
        if path == state_path(root) || path.starts_with(root.join("conflicts")) {
            continue;
        }
        if path.is_dir() {
            collect_files(root, &path, results)?;
            continue;
        }
        let content =
            fs::read_to_string(&path).with_context(|| format!("failed to read {}", path.display()))?;
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
