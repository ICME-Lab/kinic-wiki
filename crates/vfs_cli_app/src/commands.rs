// Where: crates/vfs_cli_app/src/commands.rs
// What: Command handlers for FS-first remote reads and local mirror sync.
// Why: The CLI should mirror node paths directly and keep sync behavior explicit.
use crate::cli::{Cli, Command};
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
use std::path::{Path, PathBuf};
use vfs_cli::commands::{
    collect_paged_snapshot, collect_paged_updates, resync_required_error, run_vfs_command,
    snapshot_restart_required_error,
};
use vfs_client::VfsApi;
use vfs_types::{DeleteNodeRequest, WriteNodeRequest};
use wiki_domain::{WIKI_ROOT_PATH, validate_source_path_for_kind};

pub async fn run_command(client: &impl VfsApi, cli: Cli) -> Result<()> {
    let Cli { command, .. } = cli;
    if let Some(vfs_command) = command.as_vfs_command() {
        preflight_wiki_vfs_command(client, &vfs_command).await?;
        return run_vfs_command(client, vfs_command).await;
    }
    match command {
        Command::RebuildIndex => {
            rebuild_index(client).await?;
            println!("index rebuilt");
        }
        Command::RebuildScopeIndex { scope } => {
            rebuild_scope_index(client, &scope).await?;
            println!("scope index rebuilt: {scope}");
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
        _ => unreachable!("vfs commands should be delegated before wiki workflow dispatch"),
    }
    Ok(())
}

pub async fn pull(client: &impl VfsApi, mirror_root: &Path, resync: bool) -> Result<()> {
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
        let snapshot = collect_paged_snapshot(client, WIKI_ROOT_PATH)
            .await
            .map_err(snapshot_restart_required_error)?;
        let updates =
            collect_paged_updates(client, WIKI_ROOT_PATH, &snapshot.snapshot_revision, None)
                .await?;
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

    let updates = collect_paged_updates(client, WIKI_ROOT_PATH, &state.snapshot_revision, None)
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

pub async fn push(client: &impl VfsApi, mirror_root: &Path) -> Result<()> {
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
    collect_paged_updates(client, WIKI_ROOT_PATH, &state.snapshot_revision, None)
        .await
        .map_err(resync_required_error)?;
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

    let updates = collect_paged_updates(client, WIKI_ROOT_PATH, &state.snapshot_revision, None)
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

// CLI preflight gives fast wiki-domain errors; canister entrypoints remain the
// authoritative policy boundary.
async fn preflight_wiki_vfs_command(
    client: &impl VfsApi,
    command: &vfs_cli::cli::VfsCommand,
) -> Result<()> {
    match command {
        vfs_cli::cli::VfsCommand::WriteNode { path, kind, .. } => {
            validate_source_path_for_kind(path, &kind.to_node_kind())
                .map_err(anyhow::Error::msg)?;
        }
        vfs_cli::cli::VfsCommand::AppendNode { path, kind, .. } => {
            if let Some(kind) = kind {
                validate_source_path_for_kind(path, &kind.to_node_kind())
                    .map_err(anyhow::Error::msg)?;
            } else if let Some(node) = client.read_node(path).await? {
                validate_source_path_for_kind(path, &node.kind).map_err(anyhow::Error::msg)?;
            }
        }
        vfs_cli::cli::VfsCommand::MoveNode {
            from_path, to_path, ..
        } => {
            if let Some(node) = client.read_node(from_path).await? {
                validate_source_path_for_kind(to_path, &node.kind).map_err(anyhow::Error::msg)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn merge_snapshot_and_updates(
    snapshot_nodes: Vec<vfs_types::Node>,
    changed_nodes: Vec<vfs_types::Node>,
    removed_paths: &[String],
) -> Vec<vfs_types::Node> {
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
