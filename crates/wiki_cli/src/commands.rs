// Where: crates/wiki_cli/src/commands.rs
// What: Command handlers for FS-first remote reads and local mirror sync.
// Why: The CLI should mirror node paths directly and keep sync behavior explicit.
use crate::beam_bench::{BeamBenchArgs, BeamBenchProvider, run_beam_bench};
use crate::cli::{BeamBenchProviderArg, Cli, Command};
use crate::client::WikiApi;
use crate::lint_local::{lint_local, print_local_lint_report};
use crate::mirror::{
    MirrorState, collect_changed_nodes, collect_managed_nodes, deleted_tracked_nodes, load_state,
    merge_tracked_nodes, now_millis, read_managed_node_content, remove_mirror_paths,
    remove_stale_managed_files, save_state, tracked_nodes_from_snapshot,
    update_local_node_metadata, write_conflict_file, write_snapshot_mirror,
};
use anyhow::{Result, anyhow};
use std::collections::HashSet;
use std::fs;
use std::path::Path;
use wiki_types::{
    AppendNodeRequest, DeleteNodeRequest, EditNodeRequest, ExportSnapshotRequest,
    FetchUpdatesRequest, GlobNodesRequest, ListNodesRequest, MkdirNodeRequest, MoveNodeRequest,
    MultiEdit, MultiEditNodeRequest, RecentNodesRequest, SearchNodePathsRequest,
    SearchNodesRequest, WriteNodeRequest,
};
const REMOTE_PREFIX: &str = "/Wiki";

pub async fn run_command(client: &impl WikiApi, cli: Cli) -> Result<()> {
    let Cli {
        connection,
        command,
    } = cli;
    match command {
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
                })
                .await?;
            if json {
                println!("{}", serde_json::to_string_pretty(&hits)?);
            } else {
                for hit in hits {
                    println!("{}\t{}", hit.path, hit.snippet);
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
                    println!("{}\t{}", hit.path, hit.snippet);
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
        } => {
            pull(client, &vault_path.join(mirror_root)).await?;
        }
        Command::Push {
            vault_path,
            mirror_root,
        } => {
            push(client, &vault_path.join(mirror_root)).await?;
        }
        Command::BeamBench {
            dataset_path,
            split,
            model,
            output_dir,
            provider,
            limit,
            parallelism,
            openai_base_url,
            openai_api_key_env,
            max_tool_roundtrips,
            questions_per_conversation,
            namespace,
            codex_bin,
            codex_sandbox,
        } => {
            run_beam_bench(
                connection,
                BeamBenchArgs {
                    dataset_path,
                    split,
                    model,
                    output_dir,
                    provider: match provider {
                        BeamBenchProviderArg::Codex => BeamBenchProvider::Codex,
                        BeamBenchProviderArg::Openai => BeamBenchProvider::OpenAi,
                    },
                    limit,
                    parallelism,
                    openai_base_url,
                    openai_api_key_env,
                    max_tool_roundtrips,
                    questions_per_conversation,
                    namespace,
                    codex_bin,
                    codex_sandbox,
                },
            )
            .await?;
        }
    }
    Ok(())
}

pub async fn pull(client: &impl WikiApi, mirror_root: &Path) -> Result<()> {
    let state = load_state(mirror_root)?;
    if state.snapshot_revision.is_empty() {
        let snapshot = client
            .export_snapshot(ExportSnapshotRequest {
                prefix: Some(REMOTE_PREFIX.to_string()),
            })
            .await?;
        write_snapshot_mirror(mirror_root, &snapshot.nodes)?;
        remove_stale_managed_files(
            mirror_root,
            &snapshot
                .nodes
                .iter()
                .map(|node| node.path.clone())
                .collect::<HashSet<_>>(),
        )?;
        save_state(
            mirror_root,
            &MirrorState {
                snapshot_revision: snapshot.snapshot_revision,
                last_synced_at: now_millis(),
                tracked_nodes: tracked_nodes_from_snapshot(&snapshot.nodes),
            },
        )?;
        println!("pull complete: {} nodes", snapshot.nodes.len());
        return Ok(());
    }

    let updates = client
        .fetch_updates(FetchUpdatesRequest {
            known_snapshot_revision: state.snapshot_revision.clone(),
            prefix: Some(REMOTE_PREFIX.to_string()),
        })
        .await?;
    write_snapshot_mirror(mirror_root, &updates.changed_nodes)?;
    remove_mirror_paths(mirror_root, &updates.removed_paths)?;
    save_state(
        mirror_root,
        &MirrorState {
            snapshot_revision: updates.snapshot_revision,
            last_synced_at: now_millis(),
            tracked_nodes: merge_tracked_nodes(
                &state.tracked_nodes,
                &updates.changed_nodes,
                &updates.removed_paths,
            ),
        },
    )?;
    println!(
        "pull complete: {} changed, {} removed",
        updates.changed_nodes.len(),
        updates.removed_paths.len()
    );
    Ok(())
}

pub async fn push(client: &impl WikiApi, mirror_root: &Path) -> Result<()> {
    let state = load_state(mirror_root)?;
    if state.snapshot_revision.is_empty() {
        return Err(anyhow!("mirror state is missing; run pull first"));
    }
    let changed_nodes = collect_changed_nodes(mirror_root, state.last_synced_at)?;
    let deleted_nodes = deleted_tracked_nodes(mirror_root, &state.tracked_nodes)?;
    if changed_nodes.is_empty() && deleted_nodes.is_empty() {
        println!("push skipped: no changed wiki files");
        return Ok(());
    }
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

    let updates = client
        .fetch_updates(FetchUpdatesRequest {
            known_snapshot_revision: state.snapshot_revision,
            prefix: Some(REMOTE_PREFIX.to_string()),
        })
        .await?;
    write_snapshot_mirror(mirror_root, &updates.changed_nodes)?;
    remove_mirror_paths(mirror_root, &updates.removed_paths)?;
    save_state(
        mirror_root,
        &MirrorState {
            snapshot_revision: updates.snapshot_revision,
            last_synced_at: now_millis(),
            tracked_nodes: merge_tracked_nodes(
                &state.tracked_nodes,
                &updates.changed_nodes,
                &updates.removed_paths,
            ),
        },
    )?;
    println!(
        "push complete: {} written, {} deleted, {} conflicts",
        writes, deletes, conflicts
    );
    Ok(())
}

fn read_local_status(mirror_root: &Path) -> Result<(MirrorState, usize)> {
    let state = load_state(mirror_root)?;
    let tracked_count = collect_managed_nodes(mirror_root)?.len();
    Ok((state, tracked_count))
}

fn read_multi_edit_file(path: &Path) -> Result<Vec<MultiEdit>> {
    let content = fs::read_to_string(path)?;
    serde_json::from_str(&content).map_err(Into::into)
}
