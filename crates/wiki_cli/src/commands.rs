// Where: crates/wiki_cli/src/commands.rs
// What: Command handlers for FS-first remote reads and local mirror sync.
// Why: The CLI should mirror node paths directly and keep sync behavior explicit.
use crate::cli::{Cli, Command};
use crate::client::WikiApi;
use crate::lint_local::{lint_local, print_local_lint_report};
use crate::maintenance::{rebuild_index, rebuild_scope_index};
use crate::mirror::{
    MirrorState, collect_changed_nodes, collect_managed_nodes, deleted_tracked_nodes, load_state,
    merge_tracked_nodes, now_millis, read_managed_node_content, remove_mirror_paths,
    remove_stale_managed_files, save_state, snapshot_revision_is_valid,
    tracked_nodes_from_snapshot, update_local_node_metadata, write_conflict_file,
    write_snapshot_mirror,
};
use anyhow::{Result, anyhow};
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use wiki_store::validate_source_path_for_kind;
use wiki_types::{
    AppendNodeRequest, DeleteNodeRequest, EditNodeRequest, ExportSnapshotRequest,
    ExportSnapshotResponse, FetchUpdatesRequest, FetchUpdatesResponse, GlobNodesRequest,
    ListNodesRequest, MkdirNodeRequest, MoveNodeRequest, MultiEdit, MultiEditNodeRequest,
    RecentNodesRequest, SearchNodePathsRequest, SearchNodesRequest, WriteNodeRequest,
};
const REMOTE_PREFIX: &str = "/Wiki";
/// Must match `QUERY_RESULT_LIMIT_MAX` in `wiki_store` sync paging.
const SYNC_PAGE_LIMIT: u32 = 100;
const SNAPSHOT_UNAVAILABLE_ERROR: &str = "known_snapshot_revision is no longer available";
const SNAPSHOT_INVALID_ERROR: &str = "known_snapshot_revision is invalid";
const SNAPSHOT_NO_LONGER_CURRENT_ERROR: &str = "snapshot_revision is no longer current";
const SNAPSHOT_SESSION_EXPIRED_ERROR: &str = "snapshot_session_id has expired";

pub async fn run_command(client: &impl WikiApi, cli: Cli) -> Result<()> {
    let Cli { command, .. } = cli;
    match command {
        Command::RebuildIndex => {
            rebuild_index(client).await?;
            println!("index rebuilt");
        }
        Command::RebuildScopeIndex { scope } => {
            rebuild_scope_index(client, &scope).await?;
            println!("scope index rebuilt: {scope}");
        }
        Command::ReadNode { path, json } => {
            let node = client
                .read_node(&path)
                .await?
                .ok_or_else(|| anyhow!("node not found: {path}"))?;
            if json {
                println!("{}", serde_json::to_string_pretty(&node)?);
            } else {
                println!("{}", node.content);
            }
        }
        Command::ListNodes {
            prefix,
            recursive,
            json,
        } => {
            let entries = client
                .list_nodes(ListNodesRequest { prefix, recursive })
                .await?;
            if json {
                println!("{}", serde_json::to_string_pretty(&entries)?);
            } else {
                for entry in entries {
                    println!("{}\t{:?}\t{}", entry.path, entry.kind, entry.etag);
                }
            }
        }
        Command::WriteNode {
            path,
            kind,
            input,
            metadata_json,
            expected_etag,
            json,
        } => {
            let content = fs::read_to_string(&input)?;
            validate_source_path_for_write(&path, kind.to_node_kind())?;
            let result = client
                .write_node(WriteNodeRequest {
                    path,
                    kind: kind.to_node_kind(),
                    content,
                    metadata_json,
                    expected_etag,
                })
                .await?;
            if json {
                println!("{}", serde_json::to_string_pretty(&result)?);
            } else {
                println!("{}", result.node.etag);
            }
        }
        Command::AppendNode {
            path,
            input,
            kind,
            metadata_json,
            expected_etag,
            separator,
            json,
        } => {
            let content = fs::read_to_string(&input)?;
            if let Some(kind_arg) = kind {
                validate_source_path_for_write(&path, kind_arg.to_node_kind())?;
            }
            let result = client
                .append_node(AppendNodeRequest {
                    path,
                    content,
                    expected_etag,
                    separator,
                    metadata_json,
                    kind: kind.map(|value| value.to_node_kind()),
                })
                .await?;
            if json {
                println!("{}", serde_json::to_string_pretty(&result)?);
            } else {
                println!("{}", result.node.etag);
            }
        }
        Command::EditNode {
            path,
            old_text,
            new_text,
            expected_etag,
            replace_all,
            json,
        } => {
            let result = client
                .edit_node(EditNodeRequest {
                    path,
                    old_text,
                    new_text,
                    expected_etag,
                    replace_all,
                })
                .await?;
            if json {
                println!("{}", serde_json::to_string_pretty(&result)?);
            } else {
                println!("{}\t{}", result.replacement_count, result.node.etag);
            }
        }
        Command::DeleteNode {
            path,
            expected_etag,
            json,
        } => {
            let result = client
                .delete_node(DeleteNodeRequest {
                    path,
                    expected_etag,
                })
                .await?;
            if json {
                println!("{}", serde_json::to_string_pretty(&result)?);
            } else {
                println!("{}", result.path);
            }
        }
        Command::DeleteTree { path, json } => {
            let deleted_paths = delete_tree(client, &path).await?;
            if json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&serde_json::json!({
                        "deleted_paths": deleted_paths,
                        "deleted_count": deleted_paths.len(),
                    }))?
                );
            } else {
                for deleted_path in &deleted_paths {
                    println!("{deleted_path}");
                }
                println!("deleted {} node(s)", deleted_paths.len());
            }
        }
        Command::MkdirNode { path, json } => {
            let result = client.mkdir_node(MkdirNodeRequest { path }).await?;
            if json {
                println!("{}", serde_json::to_string_pretty(&result)?);
            } else {
                println!("{}", result.path);
            }
        }
        Command::MoveNode {
            from_path,
            to_path,
            expected_etag,
            overwrite,
            json,
        } => {
            if let Some(current) = client.read_node(&from_path).await? {
                validate_source_path_for_kind(&to_path, &current.kind)
                    .map_err(anyhow::Error::msg)?;
            }
            let result = client
                .move_node(MoveNodeRequest {
                    from_path,
                    to_path,
                    expected_etag,
                    overwrite,
                })
                .await?;
            if json {
                println!("{}", serde_json::to_string_pretty(&result)?);
            } else {
                println!("{}\t{}", result.from_path, result.node.path);
            }
        }
        Command::GlobNodes {
            pattern,
            path,
            node_type,
            json,
        } => {
            let hits = client
                .glob_nodes(GlobNodesRequest {
                    pattern,
                    path: Some(path),
                    node_type: node_type.map(|value| value.to_glob_node_type()),
                })
                .await?;
            if json {
                println!("{}", serde_json::to_string_pretty(&hits)?);
            } else {
                for hit in hits {
                    println!("{}\t{:?}\t{}", hit.path, hit.kind, hit.has_children);
                }
            }
        }
        Command::RecentNodes { limit, path, json } => {
            let hits = client
                .recent_nodes(RecentNodesRequest {
                    limit,
                    path: Some(path),
                })
                .await?;
            if json {
                println!("{}", serde_json::to_string_pretty(&hits)?);
            } else {
                for hit in hits {
                    println!("{}\t{}\t{}", hit.updated_at, hit.path, hit.etag);
                }
            }
        }
        Command::MultiEditNode {
            path,
            edits_file,
            expected_etag,
            json,
        } => {
            let edits = read_multi_edit_file(&edits_file)?;
            let result = client
                .multi_edit_node(MultiEditNodeRequest {
                    path,
                    edits,
                    expected_etag,
                })
                .await?;
            if json {
                println!("{}", serde_json::to_string_pretty(&result)?);
            } else {
                println!("{}\t{}", result.replacement_count, result.node.etag);
            }
        }
        Command::SearchRemote {
            query_text,
            prefix,
            top_k,
            json,
        } => {
            let hits = client
                .search_nodes(SearchNodesRequest {
                    query_text,
                    prefix: Some(prefix),
                    top_k,
                    preview_mode: None,
                })
                .await?;
            if json {
                println!("{}", serde_json::to_string_pretty(&hits)?);
            } else {
                for hit in hits {
                    let preview = hit
                        .preview
                        .as_ref()
                        .and_then(|preview| preview.excerpt.clone())
                        .or(hit.snippet.clone())
                        .unwrap_or_default();
                    println!("{}\t{}", hit.path, preview);
                }
            }
        }
        Command::SearchPathRemote {
            query_text,
            prefix,
            top_k,
            json,
        } => {
            let hits = client
                .search_node_paths(SearchNodePathsRequest {
                    query_text,
                    prefix: Some(prefix),
                    top_k,
                })
                .await?;
            if json {
                println!("{}", serde_json::to_string_pretty(&hits)?);
            } else {
                for hit in hits {
                    println!("{}\t{}", hit.path, hit.snippet.unwrap_or_default());
                }
            }
        }
        Command::LintLocal {
            vault_path,
            mirror_root,
            json,
        } => {
            let report = lint_local(&vault_path.join(mirror_root))?;
            print_local_lint_report(&report, json)?;
        }
        Command::Status {
            vault_path,
            mirror_root,
            json,
        } => {
            let remote = client.status().await?;
            let local = vault_path
                .as_deref()
                .map(|vault| read_local_status(&vault.join(&mirror_root)))
                .transpose()?;
            if json {
                println!("{}", serde_json::to_string_pretty(&(remote, local))?);
            } else {
                println!(
                    "remote: files={} sources={}",
                    remote.file_count, remote.source_count
                );
                if let Some((state, tracked_count)) = local {
                    println!(
                        "local: snapshot_revision={} tracked_nodes={} last_synced_at={}",
                        state.snapshot_revision, tracked_count, state.last_synced_at
                    );
                }
            }
        }
        Command::Pull {
            vault_path,
            mirror_root,
            resync,
        } => {
            pull(client, &vault_path.join(mirror_root), resync).await?;
        }
        Command::Push {
            vault_path,
            mirror_root,
        } => {
            push(client, &vault_path.join(mirror_root)).await?;
        }
    }
    Ok(())
}

async fn delete_tree(client: &impl WikiApi, path: &str) -> Result<Vec<String>> {
    let mut entries = client
        .list_nodes(ListNodesRequest {
            prefix: path.to_string(),
            recursive: true,
        })
        .await?;
    entries.sort_by(|left, right| {
        right
            .path
            .len()
            .cmp(&left.path.len())
            .then_with(|| left.path.cmp(&right.path))
    });
    let mut deleted_paths = Vec::with_capacity(entries.len());
    for entry in entries {
        let result = client
            .delete_node(DeleteNodeRequest {
                path: entry.path,
                expected_etag: Some(entry.etag),
            })
            .await?;
        deleted_paths.push(result.path);
    }
    Ok(deleted_paths)
}

fn validate_source_path_for_write(path: &str, kind: wiki_types::NodeKind) -> Result<()> {
    validate_source_path_for_kind(path, &kind).map_err(anyhow::Error::msg)
}

pub async fn pull(client: &impl WikiApi, mirror_root: &Path, resync: bool) -> Result<()> {
    let state = load_state(mirror_root)?;
    if !resync
        && !state.snapshot_revision.is_empty()
        && !snapshot_revision_is_valid(&state.snapshot_revision)
    {
        return Err(anyhow!(
            "mirror state snapshot_revision is invalid; run pull --resync"
        ));
    }
    if resync || state.snapshot_revision.is_empty() {
        let snapshot = collect_paged_snapshot(client)
            .await
            .map_err(snapshot_restart_required_error)?;
        let updates = collect_paged_updates(client, &snapshot.snapshot_revision, None).await?;
        let nodes = merge_snapshot_and_updates(
            snapshot.nodes,
            updates.changed_nodes,
            &updates.removed_paths,
        );
        write_snapshot_mirror(mirror_root, &nodes)?;
        remove_mirror_paths(mirror_root, &updates.removed_paths)?;
        remove_stale_managed_files(
            mirror_root,
            &nodes
                .iter()
                .map(|node| node.path.clone())
                .collect::<HashSet<_>>(),
        )?;
        save_state(
            mirror_root,
            &MirrorState {
                snapshot_revision: updates.snapshot_revision,
                last_synced_at: now_millis(),
                tracked_nodes: tracked_nodes_from_snapshot(&nodes),
            },
        )?;
        println!("pull complete: {} nodes", nodes.len());
        return Ok(());
    }

    let updates = collect_paged_updates(client, &state.snapshot_revision, None)
        .await
        .map_err(resync_required_error)?;
    let changed_nodes = updates.changed_nodes;
    let removed_paths = updates.removed_paths;
    write_snapshot_mirror(mirror_root, &changed_nodes)?;
    remove_mirror_paths(mirror_root, &removed_paths)?;
    save_state(
        mirror_root,
        &MirrorState {
            snapshot_revision: updates.snapshot_revision,
            last_synced_at: now_millis(),
            tracked_nodes: merge_tracked_nodes(
                &state.tracked_nodes,
                &changed_nodes,
                &removed_paths,
            ),
        },
    )?;
    println!(
        "pull complete: {} changed, {} removed",
        changed_nodes.len(),
        removed_paths.len()
    );
    Ok(())
}

pub async fn push(client: &impl WikiApi, mirror_root: &Path) -> Result<()> {
    let state = load_state(mirror_root)?;
    if state.snapshot_revision.is_empty() {
        let state_exists = mirror_state_exists(mirror_root);
        let message = if state_exists {
            "mirror state snapshot_revision is invalid; run pull --resync"
        } else {
            "mirror state is missing; run pull first"
        };
        return Err(anyhow!(message));
    }
    if !snapshot_revision_is_valid(&state.snapshot_revision) {
        return Err(anyhow!(
            "mirror state snapshot_revision is invalid; run pull --resync"
        ));
    }
    let changed_nodes = collect_changed_nodes(mirror_root, state.last_synced_at)?;
    let deleted_nodes = deleted_tracked_nodes(mirror_root, &state.tracked_nodes)?;
    if changed_nodes.is_empty() && deleted_nodes.is_empty() {
        println!("push skipped: no changed wiki files");
        return Ok(());
    }
    let preflight = collect_paged_updates(client, &state.snapshot_revision, None)
        .await
        .map_err(resync_required_error)?;
    let preflight_snapshot_revision = preflight.snapshot_revision;
    let mut conflicts = 0usize;
    let mut writes = 0usize;
    for node in &changed_nodes {
        let result = client
            .write_node(WriteNodeRequest {
                path: node.metadata.path.clone(),
                kind: node.metadata.kind.clone(),
                content: read_managed_node_content(node)?,
                metadata_json: "{}".to_string(),
                expected_etag: Some(node.metadata.etag.clone()),
            })
            .await;
        match result {
            Ok(updated) => {
                let refreshed = client
                    .read_node(&updated.node.path)
                    .await?
                    .ok_or_else(|| anyhow!("node not found after write: {}", updated.node.path))?;
                update_local_node_metadata(mirror_root, &refreshed)?;
                writes += 1;
            }
            Err(error) => {
                conflicts += 1;
                write_conflict_file(
                    mirror_root,
                    &node.metadata.path,
                    &read_managed_node_content(node)?,
                )?;
                eprintln!("write conflict for {}: {error}", node.metadata.path);
            }
        }
    }

    let mut deletes = 0usize;
    for tracked in &deleted_nodes {
        let result = client
            .delete_node(DeleteNodeRequest {
                path: tracked.path.clone(),
                expected_etag: Some(tracked.etag.clone()),
            })
            .await;
        match result {
            Ok(_) => deletes += 1,
            Err(error) => {
                conflicts += 1;
                eprintln!("delete conflict for {}: {error}", tracked.path);
            }
        }
    }

    let updates = collect_paged_updates(client, &preflight_snapshot_revision, None)
        .await
        .map_err(resync_required_error)?;
    let changed_nodes = updates.changed_nodes;
    let removed_paths = updates.removed_paths;
    write_snapshot_mirror(mirror_root, &changed_nodes)?;
    remove_mirror_paths(mirror_root, &removed_paths)?;
    save_state(
        mirror_root,
        &MirrorState {
            snapshot_revision: updates.snapshot_revision,
            last_synced_at: now_millis(),
            tracked_nodes: merge_tracked_nodes(
                &state.tracked_nodes,
                &changed_nodes,
                &removed_paths,
            ),
        },
    )?;
    println!(
        "push complete: {} written, {} deleted, {} conflicts",
        writes, deletes, conflicts
    );
    Ok(())
}

async fn collect_paged_snapshot(client: &impl WikiApi) -> Result<ExportSnapshotResponse> {
    let mut cursor = None;
    let mut snapshot_revision = None;
    let mut snapshot_session_id = None;
    let mut nodes = Vec::new();
    loop {
        let page = client
            .export_snapshot(ExportSnapshotRequest {
                prefix: Some(REMOTE_PREFIX.to_string()),
                limit: SYNC_PAGE_LIMIT,
                cursor: cursor.clone(),
                snapshot_revision: snapshot_revision.clone(),
                snapshot_session_id: snapshot_session_id.clone(),
            })
            .await?;
        snapshot_revision = Some(page.snapshot_revision.clone());
        snapshot_session_id = page.snapshot_session_id.clone();
        nodes.extend(page.nodes);
        let Some(next_cursor) = page.next_cursor else {
            return Ok(ExportSnapshotResponse {
                snapshot_revision: snapshot_revision.unwrap_or_default(),
                snapshot_session_id,
                nodes,
                next_cursor: None,
            });
        };
        cursor = Some(next_cursor);
    }
}

async fn collect_paged_updates(
    client: &impl WikiApi,
    known_snapshot_revision: &str,
    target_snapshot_revision: Option<String>,
) -> Result<FetchUpdatesResponse> {
    let mut cursor = None;
    let mut target_snapshot_revision = target_snapshot_revision;
    let mut changed_nodes = Vec::new();
    let mut removed_paths = Vec::new();
    loop {
        let page = client
            .fetch_updates(FetchUpdatesRequest {
                known_snapshot_revision: known_snapshot_revision.to_string(),
                prefix: Some(REMOTE_PREFIX.to_string()),
                limit: SYNC_PAGE_LIMIT,
                cursor: cursor.clone(),
                target_snapshot_revision: target_snapshot_revision.clone(),
            })
            .await?;
        target_snapshot_revision = Some(page.snapshot_revision.clone());
        changed_nodes.extend(page.changed_nodes);
        removed_paths.extend(page.removed_paths);
        let Some(next_cursor) = page.next_cursor else {
            return Ok(FetchUpdatesResponse {
                snapshot_revision: target_snapshot_revision.unwrap_or_default(),
                changed_nodes,
                removed_paths,
                next_cursor: None,
            });
        };
        cursor = Some(next_cursor);
    }
}

fn resync_required_error(error: anyhow::Error) -> anyhow::Error {
    let message = error.to_string();
    if message.contains(SNAPSHOT_UNAVAILABLE_ERROR) || message.contains(SNAPSHOT_INVALID_ERROR) {
        anyhow!("{message}; run pull --resync")
    } else {
        error
    }
}

fn snapshot_restart_required_error(error: anyhow::Error) -> anyhow::Error {
    let message = error.to_string();
    if message.contains(SNAPSHOT_NO_LONGER_CURRENT_ERROR)
        || message.contains(SNAPSHOT_SESSION_EXPIRED_ERROR)
    {
        anyhow!("{message}; rerun pull")
    } else {
        error
    }
}

fn merge_snapshot_and_updates(
    snapshot_nodes: Vec<wiki_types::Node>,
    changed_nodes: Vec<wiki_types::Node>,
    removed_paths: &[String],
) -> Vec<wiki_types::Node> {
    let removed = removed_paths.iter().collect::<HashSet<_>>();
    let mut merged = BTreeMap::new();
    for node in snapshot_nodes {
        if removed.contains(&node.path) {
            continue;
        }
        merged.insert(node.path.clone(), node);
    }
    for node in changed_nodes {
        if removed.contains(&node.path) {
            continue;
        }
        merged.insert(node.path.clone(), node);
    }
    merged.into_values().collect()
}

fn read_local_status(mirror_root: &Path) -> Result<(MirrorState, usize)> {
    let state = load_state(mirror_root)?;
    let tracked_count = collect_managed_nodes(mirror_root)?.len();
    Ok((state, tracked_count))
}

fn mirror_state_exists(mirror_root: &Path) -> bool {
    let mut path = PathBuf::from(mirror_root);
    path.push(".wiki-fs-state.json");
    path.exists()
}

fn read_multi_edit_file(path: &Path) -> Result<Vec<MultiEdit>> {
    let content = fs::read_to_string(path)?;
    serde_json::from_str(&content).map_err(Into::into)
}
