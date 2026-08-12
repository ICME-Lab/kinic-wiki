// Where: crates/vfs_cli_core/src/commands.rs
// What: Generic VFS command execution helpers.
// Why: The app-facing CLI package should delegate shared VFS command behavior instead of owning it.
mod cycles;
mod database;
mod market;
pub(crate) use cycles::*;
pub use cycles::{database_cycles_url, open_browser_url, open_database_cycles_page};
pub(crate) use database::*;
pub(crate) use market::*;
use std::borrow::Cow;
use std::fs;
use std::process::Command as ProcessCommand;

use crate::cli::{CyclesCommand, DatabaseCommand, MarketCommand, VfsCommand};
use crate::connection::{
    ResolvedConnection, ResolvedConnectionPreview, link_workspace_database,
    unlink_workspace_database, workspace_config_path,
};
use anyhow::{Result, anyhow};
use serde::Deserialize;
use vfs_client::VfsApi;
use vfs_types::{
    AppendNodeRequest, CyclesBillingConfig, CyclesTopUpConfig, DatabaseCyclesPurchaseRequest,
    DeleteNodeRequest, DeleteNodeResult, EditNodeRequest, ExportSnapshotRequest,
    FetchUpdatesRequest, GlobNodesRequest, GraphLinksRequest, GraphNeighborhoodRequest,
    IncomingLinksRequest, IndexSqlJsonQueryResult, KINIC_DECIMALS, KINIC_LEDGER_FEE_E8S, LinkEdge,
    ListChildrenRequest, ListNodesRequest, MarketEntitlementPage, MkdirNodeRequest,
    MoveNodeRequest, MultiEdit, MultiEditNodeRequest, NodeContextRequest, NodeEntryKind, NodeKind,
    OutgoingLinksRequest, PublishNodeRequest, QueryContextRequest, SearchNodePathsRequest,
    SearchNodesRequest, SourceEvidenceRequest, UpdateDatabaseMetadataRequest, WriteNodeItem,
    WriteNodeRequest, WriteNodesRequest, kinic_base_units_per_token,
};

const DEFAULT_BROWSER_ORIGIN: &str = "https://wiki.kinic.xyz";
const DELETE_TREE_LIST_LIMIT: u32 = 100;

pub async fn run_vfs_command(
    client: &impl VfsApi,
    connection: &ResolvedConnection,
    command: VfsCommand,
) -> Result<()> {
    let database_id = connection.database_id.as_deref();
    let command = match command {
        VfsCommand::Cycles { command } => {
            run_cycles_command(client, command).await?;
            return Ok(());
        }
        VfsCommand::Database { command } => {
            run_database_command(client, connection, command).await?;
            return Ok(());
        }
        VfsCommand::Market { command } => {
            run_market_command(client, command).await?;
            return Ok(());
        }
        VfsCommand::ReadPublicNode { public_id, json } => {
            let node = client
                .read_public_node(&public_id)
                .await?
                .ok_or_else(|| anyhow!("public node not found: {public_id}"))?;
            if json {
                println!("{}", serde_json::to_string_pretty(&node)?);
            } else {
                println!("{}", node.content);
            }
            return Ok(());
        }
        command => command,
    };
    let database_id = require_database_id(database_id)?;
    if command_requires_write_cycles_available(&command) {
        require_write_cycles_available(client, database_id).await?;
    }
    match command {
        VfsCommand::Cycles { .. } => {
            unreachable!("cycles command handled before db requirement")
        }
        VfsCommand::Database { .. } => {
            unreachable!("database command handled before db requirement")
        }
        VfsCommand::Market { .. } => {
            unreachable!("market command handled before db requirement")
        }
        VfsCommand::ReadPublicNode { .. } => {
            unreachable!("public node read handled before db requirement")
        }
        VfsCommand::ReadNode {
            path,
            metadata_only,
            fields,
            json,
        } => {
            let node = client
                .read_node(database_id, &path)
                .await?
                .ok_or_else(|| anyhow!("node not found: {path}"))?;
            if metadata_only || fields.is_some() {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&node_field_view(
                        &node,
                        metadata_only,
                        fields.as_deref()
                    )?)?
                );
            } else if json {
                println!("{}", serde_json::to_string_pretty(&node)?);
            } else {
                println!("{}", node.content);
            }
        }
        VfsCommand::PublishNode { path, json } => {
            let publication = client
                .publish_node(PublishNodeRequest {
                    database_id: database_id.to_string(),
                    path,
                })
                .await?;
            if json {
                println!("{}", serde_json::to_string_pretty(&publication)?);
            } else {
                println!("{}", publication.public_id);
            }
        }
        VfsCommand::GetNodePublication { path, json } => {
            let publication = client
                .get_node_publication(PublishNodeRequest {
                    database_id: database_id.to_string(),
                    path,
                })
                .await?;
            if json {
                println!("{}", serde_json::to_string_pretty(&publication)?);
            } else if let Some(publication) = publication {
                println!("{}", publication.public_id);
            } else {
                println!("unpublished");
            }
        }
        VfsCommand::UnpublishNode { path, json } => {
            client
                .unpublish_node(PublishNodeRequest {
                    database_id: database_id.to_string(),
                    path: path.clone(),
                })
                .await?;
            if json {
                println!("{}", serde_json::to_string_pretty(&())?);
            } else {
                println!("{path}");
            }
        }
        VfsCommand::ListNodes {
            prefix,
            recursive,
            limit,
            json,
        } => {
            let entries = client
                .list_nodes(ListNodesRequest {
                    database_id: database_id.to_string(),
                    prefix,
                    recursive,
                    limit,
                })
                .await?;
            if json {
                println!("{}", serde_json::to_string_pretty(&entries)?);
            } else {
                for entry in entries {
                    println!("{}\t{:?}\t{}", entry.path, entry.kind, entry.etag);
                }
            }
        }
        VfsCommand::ListChildren { path, json } => {
            let children = client
                .list_children(ListChildrenRequest {
                    database_id: database_id.to_string(),
                    path,
                })
                .await?;
            if json {
                println!("{}", serde_json::to_string_pretty(&children)?);
            } else {
                for child in children {
                    println!(
                        "{}\t{:?}\t{}",
                        child.path,
                        child.kind,
                        child.etag.unwrap_or_default()
                    );
                }
            }
        }
        VfsCommand::WriteNode {
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
                    database_id: database_id.to_string(),
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
        VfsCommand::WriteNodes { input, json } => {
            let nodes = read_write_nodes_file(&input)?;
            let results = client
                .write_nodes(WriteNodesRequest {
                    database_id: database_id.to_string(),
                    nodes,
                })
                .await?;
            if json {
                println!("{}", serde_json::to_string_pretty(&results)?);
            } else {
                for result in results {
                    println!(
                        "{}\t{}\t{}",
                        result.node.path, result.node.etag, result.created
                    );
                }
            }
        }
        VfsCommand::AppendNode {
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
                    database_id: database_id.to_string(),
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
        VfsCommand::EditNode {
            path,
            old_text,
            new_text,
            expected_etag,
            replace_all,
            json,
        } => {
            let result = client
                .edit_node(EditNodeRequest {
                    database_id: database_id.to_string(),
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
        VfsCommand::DeleteNode {
            path,
            expected_etag,
            expected_folder_index_etag,
            json,
        } => {
            let result = delete_node_with_folder_index(
                client,
                database_id,
                path,
                expected_etag,
                expected_folder_index_etag,
                None,
            )
            .await?;
            if json {
                println!("{}", serde_json::to_string_pretty(&result)?);
            } else {
                println!("{}", result.path);
            }
        }
        VfsCommand::DeleteTree { path, json } => {
            let deleted_paths = delete_tree(client, database_id, &path).await?;
            if json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(
                        &serde_json::json!({ "deleted_paths": deleted_paths, "deleted_count": deleted_paths.len() })
                    )?
                );
            } else {
                for deleted_path in &deleted_paths {
                    println!("{deleted_path}");
                }
                println!("deleted {} node(s)", deleted_paths.len());
            }
        }
        VfsCommand::MkdirNode { path, json } => {
            let result = client
                .mkdir_node(MkdirNodeRequest {
                    database_id: database_id.to_string(),
                    path,
                })
                .await?;
            if json {
                println!("{}", serde_json::to_string_pretty(&result)?);
            } else {
                println!("{}", result.path);
            }
        }
        VfsCommand::MoveNode {
            from_path,
            to_path,
            expected_etag,
            expected_target_etag,
            overwrite,
            json,
        } => {
            let result = client
                .move_node(MoveNodeRequest {
                    database_id: database_id.to_string(),
                    from_path,
                    to_path,
                    expected_etag,
                    expected_target_etag,
                    overwrite,
                })
                .await?;
            if json {
                println!("{}", serde_json::to_string_pretty(&result)?);
            } else {
                println!("{}\t{}", result.from_path, result.node.path);
            }
        }
        VfsCommand::GlobNodes {
            pattern,
            path,
            node_type,
            json,
        } => {
            let hits = client
                .glob_nodes(GlobNodesRequest {
                    database_id: database_id.to_string(),
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
        VfsCommand::ReadNodeContext {
            path,
            link_limit,
            json,
        } => {
            let context = client
                .read_node_context(NodeContextRequest {
                    database_id: database_id.to_string(),
                    path,
                    link_limit,
                })
                .await?
                .ok_or_else(|| anyhow!("node not found"))?;
            if json {
                println!("{}", serde_json::to_string_pretty(&context)?);
            } else {
                println!("{}", context.node.content);
                print_link_summary("incoming", &context.incoming_links);
                print_link_summary("outgoing", &context.outgoing_links);
            }
        }
        VfsCommand::GraphNeighborhood {
            center_path,
            depth,
            limit,
            json,
        } => {
            let links = client
                .graph_neighborhood(GraphNeighborhoodRequest {
                    database_id: database_id.to_string(),
                    center_path,
                    depth,
                    limit,
                })
                .await?;
            print_links(links, json)?;
        }
        VfsCommand::GraphLinks {
            prefix,
            limit,
            json,
        } => {
            let links = client
                .graph_links(GraphLinksRequest {
                    database_id: database_id.to_string(),
                    prefix,
                    limit,
                })
                .await?;
            print_links(links, json)?;
        }
        VfsCommand::IncomingLinks { path, limit, json } => {
            let links = client
                .incoming_links(IncomingLinksRequest {
                    database_id: database_id.to_string(),
                    path,
                    limit,
                })
                .await?;
            print_links(links, json)?;
        }
        VfsCommand::OutgoingLinks { path, limit, json } => {
            let links = client
                .outgoing_links(OutgoingLinksRequest {
                    database_id: database_id.to_string(),
                    path,
                    limit,
                })
                .await?;
            print_links(links, json)?;
        }
        VfsCommand::MultiEditNode {
            path,
            edits_file,
            expected_etag,
            json,
        } => {
            let edits = read_multi_edit_file(&edits_file)?;
            let result = client
                .multi_edit_node(MultiEditNodeRequest {
                    database_id: database_id.to_string(),
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
        VfsCommand::SearchRemote {
            query_text,
            prefix,
            top_k,
            preview_mode,
            json,
        } => {
            let hits = client
                .search_nodes(SearchNodesRequest {
                    database_id: database_id.to_string(),
                    query_text,
                    prefix: Some(prefix),
                    top_k,
                    preview_mode: preview_mode.map(|mode| mode.to_search_preview_mode()),
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
        VfsCommand::SearchPathRemote {
            query_text,
            prefix,
            top_k,
            preview_mode,
            json,
        } => {
            let hits = client
                .search_node_paths(SearchNodePathsRequest {
                    database_id: database_id.to_string(),
                    query_text,
                    prefix: Some(prefix),
                    top_k,
                    preview_mode: preview_mode.map(|mode| mode.to_search_preview_mode()),
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
        VfsCommand::QuerySql { sql, limit, json } => {
            let result = client
                .query_database_sql_json(database_id, &sql, limit)
                .await?;
            for line in sql_json_query_output_lines(&result, json)? {
                println!("{line}");
            }
        }
        VfsCommand::MemoryManifest { json } => {
            let manifest = client.memory_manifest(database_id).await?;
            if json {
                println!("{}", serde_json::to_string_pretty(&manifest)?);
            } else {
                println!("api_version\t{}", manifest.api_version);
                println!(
                    "recommended_entrypoint\t{}",
                    manifest.recommended_entrypoint
                );
                println!("write_policy\t{}", manifest.write_policy);
                for root in manifest.roots {
                    println!("root\t{}\t{}", root.kind, root.path);
                }
            }
        }
        VfsCommand::QueryContext {
            task,
            entities,
            namespace,
            budget_tokens,
            depth,
            no_evidence,
            json,
        } => {
            let context = client
                .query_context(QueryContextRequest {
                    database_id: database_id.to_string(),
                    task,
                    entities,
                    namespace,
                    budget_tokens,
                    include_evidence: !no_evidence,
                    depth,
                })
                .await?;
            if json {
                println!("{}", serde_json::to_string_pretty(&context)?);
            } else {
                println!("namespace\t{}", context.namespace);
                println!("truncated\t{}", context.truncated);
                for node_context in context.nodes {
                    println!("node\t{}", node_context.node.path);
                }
                for evidence in context.evidence {
                    println!("evidence\t{}\t{}", evidence.node_path, evidence.refs.len());
                }
                for hit in context.search_hits {
                    println!("search_hit\t{}", hit.path);
                }
            }
        }
        VfsCommand::SourceEvidence { node_path, json } => {
            let evidence = client
                .source_evidence(SourceEvidenceRequest {
                    database_id: database_id.to_string(),
                    node_path,
                })
                .await?;
            if json {
                println!("{}", serde_json::to_string_pretty(&evidence)?);
            } else {
                println!("node_path\t{}", evidence.node_path);
                for reference in evidence.refs {
                    println!(
                        "ref\t{}\t{}\t{}",
                        reference.source_path, reference.via_path, reference.raw_href
                    );
                }
            }
        }
        VfsCommand::ExportSnapshot {
            prefix,
            limit,
            cursor,
            snapshot_revision,
            json,
        } => {
            let snapshot = client
                .export_snapshot(ExportSnapshotRequest {
                    database_id: database_id.to_string(),
                    prefix,
                    limit,
                    cursor,
                    snapshot_revision,
                    snapshot_session_id: None,
                })
                .await?;
            if json {
                println!("{}", serde_json::to_string_pretty(&snapshot)?);
            } else {
                println!("snapshot_revision\t{}", snapshot.snapshot_revision);
                if let Some(next_cursor) = snapshot.next_cursor {
                    println!("next_cursor\t{next_cursor}");
                }
                for node in snapshot.nodes {
                    println!("node\t{}", node.path);
                }
            }
        }
        VfsCommand::FetchUpdates {
            known_snapshot_revision,
            prefix,
            limit,
            cursor,
            target_snapshot_revision,
            json,
        } => {
            let updates = client
                .fetch_updates(FetchUpdatesRequest {
                    database_id: database_id.to_string(),
                    known_snapshot_revision,
                    prefix,
                    limit,
                    cursor,
                    target_snapshot_revision,
                })
                .await?;
            if json {
                println!("{}", serde_json::to_string_pretty(&updates)?);
            } else {
                println!("snapshot_revision\t{}", updates.snapshot_revision);
                if let Some(next_cursor) = updates.next_cursor {
                    println!("next_cursor\t{next_cursor}");
                }
                for node in updates.changed_nodes {
                    println!("changed\t{}", node.path);
                }
                for path in updates.removed_paths {
                    println!("removed\t{path}");
                }
            }
        }
    }
    Ok(())
}

fn command_requires_write_cycles_available(command: &VfsCommand) -> bool {
    matches!(
        command,
        VfsCommand::WriteNode { .. }
            | VfsCommand::AppendNode { .. }
            | VfsCommand::EditNode { .. }
            | VfsCommand::DeleteNode { .. }
            | VfsCommand::DeleteTree { .. }
            | VfsCommand::MkdirNode { .. }
            | VfsCommand::MoveNode { .. }
            | VfsCommand::MultiEditNode { .. }
    )
}

async fn require_write_cycles_available(client: &impl VfsApi, database_id: &str) -> Result<()> {
    client.check_database_write_cycles(database_id).await
}

fn print_links(links: Vec<LinkEdge>, json: bool) -> Result<()> {
    if json {
        println!("{}", serde_json::to_string_pretty(&links)?);
    } else {
        for link in links {
            println!(
                "{}\t{}\t{}\t{}",
                link.source_path, link.target_path, link.link_kind, link.link_text
            );
        }
    }
    Ok(())
}

fn sql_json_query_output_lines(
    result: &IndexSqlJsonQueryResult,
    json: bool,
) -> Result<Vec<String>> {
    if json {
        return Ok(vec![serde_json::to_string_pretty(result)?]);
    }
    Ok(result.rows.clone())
}

pub(crate) async fn delete_node_with_folder_index(
    client: &impl VfsApi,
    database_id: &str,
    path: String,
    expected_etag: Option<String>,
    expected_folder_index_etag: Option<String>,
    kind_hint: Option<NodeEntryKind>,
) -> Result<DeleteNodeResult> {
    let expected_folder_index_etag = match expected_folder_index_etag {
        Some(etag) => Some(etag),
        None if should_probe_folder_index(client, database_id, &path, kind_hint).await? => {
            read_folder_index_etag(client, database_id, &path).await?
        }
        None => None,
    };
    client
        .delete_node(DeleteNodeRequest {
            database_id: database_id.to_string(),
            path,
            expected_etag,
            expected_folder_index_etag,
        })
        .await
}

async fn should_probe_folder_index(
    client: &impl VfsApi,
    database_id: &str,
    path: &str,
    kind_hint: Option<NodeEntryKind>,
) -> Result<bool> {
    match kind_hint {
        Some(NodeEntryKind::Folder) => Ok(true),
        Some(_) => Ok(false),
        None => Ok(client
            .read_node(database_id, path)
            .await?
            .is_some_and(|node| node.kind == NodeKind::Folder)),
    }
}

async fn read_folder_index_etag(
    client: &impl VfsApi,
    database_id: &str,
    folder_path: &str,
) -> Result<Option<String>> {
    let index_path = format!("{}/index.md", folder_path.trim_end_matches('/'));
    Ok(client
        .read_node(database_id, &index_path)
        .await?
        .and_then(|node| (node.kind == NodeKind::File).then_some(node.etag)))
}

fn node_field_view(
    node: &vfs_types::Node,
    metadata_only: bool,
    fields: Option<&str>,
) -> Result<serde_json::Value> {
    let value = serde_json::to_value(node)?;
    let object = value
        .as_object()
        .ok_or_else(|| anyhow!("node did not serialize to an object"))?;
    let selected_fields = if let Some(fields) = fields {
        fields
            .split(',')
            .map(str::trim)
            .filter(|field| !field.is_empty())
            .map(str::to_string)
            .collect::<Vec<_>>()
    } else if metadata_only {
        [
            "path",
            "kind",
            "etag",
            "metadata_json",
            "created_at",
            "updated_at",
        ]
        .into_iter()
        .map(str::to_string)
        .collect()
    } else {
        Vec::new()
    };
    if selected_fields.is_empty() {
        return Err(anyhow!("at least one field is required"));
    }
    let mut output = serde_json::Map::new();
    for field in selected_fields {
        let Some(next_value) = object.get(&field) else {
            return Err(anyhow!("unknown node field: {field}"));
        };
        output.insert(field, next_value.clone());
    }
    Ok(serde_json::Value::Object(output))
}

pub fn print_database_current(connection: &ResolvedConnectionPreview, json: bool) -> Result<()> {
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "canister_id": connection.canister_id,
                "canister_id_source": connection.canister_id_source,
                "database_id": connection.database_id,
                "database_id_source": connection.database_id_source,
                "replica_host": connection.replica_host,
                "replica_host_source": connection.replica_host_source
            }))?
        );
    } else {
        println!(
            "canister_id: {}",
            connection.canister_id.as_deref().unwrap_or("")
        );
        println!(
            "database_id: {}",
            connection.database_id.as_deref().unwrap_or("")
        );
        println!("replica_host: {}", connection.replica_host);
        println!(
            "source: {}",
            connection
                .database_id_source
                .as_deref()
                .unwrap_or("unresolved")
        );
    }
    Ok(())
}

pub fn run_database_unlink() -> Result<()> {
    let path = unlink_workspace_database()?.unwrap_or(workspace_config_path()?);
    println!("{}", path.display());
    Ok(())
}

fn require_database_id(database_id: Option<&str>) -> Result<&str> {
    database_id
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow!("database id is required; set --database-id, VFS_DATABASE_ID, or run database link <database-id>"))
}

pub fn database_id_or_env(database_id: Option<&str>) -> Result<Cow<'_, str>> {
    if let Some(database_id) = database_id.filter(|value| !value.is_empty()) {
        return Ok(Cow::Borrowed(database_id));
    }
    let env_database_id = std::env::var("VFS_DATABASE_ID").unwrap_or_default();
    if env_database_id.is_empty() {
        Err(anyhow!(
            "database id is required; set --database-id, VFS_DATABASE_ID, or run database link <database-id>"
        ))
    } else {
        Ok(Cow::Owned(env_database_id))
    }
}

fn print_link_summary(label: &str, links: &[LinkEdge]) {
    println!("{label}\t{}", links.len());
    for link in links {
        println!(
            "{label}\t{}\t{}\t{}\t{}",
            link.source_path, link.target_path, link.link_kind, link.link_text
        );
    }
}

async fn delete_tree(client: &impl VfsApi, database_id: &str, path: &str) -> Result<Vec<String>> {
    let mut entries = client
        .list_nodes(ListNodesRequest {
            database_id: database_id.to_string(),
            prefix: path.to_string(),
            recursive: true,
            limit: DELETE_TREE_LIST_LIMIT,
        })
        .await?;
    if entries.len() >= DELETE_TREE_LIST_LIMIT as usize {
        return Err(anyhow!(
            "delete-tree target exceeds the list limit; narrow the prefix or add list_nodes paging before deleting"
        ));
    }
    entries.sort_by(|left, right| {
        right
            .path
            .len()
            .cmp(&left.path.len())
            .then_with(|| left.path.cmp(&right.path))
    });
    let mut deleted_paths = Vec::with_capacity(entries.len());
    for entry in entries {
        let result = delete_node_with_folder_index(
            client,
            database_id,
            entry.path,
            Some(entry.etag),
            None,
            Some(entry.kind),
        )
        .await?;
        deleted_paths.push(result.path);
    }
    Ok(deleted_paths)
}

fn read_multi_edit_file(path: &std::path::Path) -> Result<Vec<MultiEdit>> {
    let content = fs::read_to_string(path)?;
    serde_json::from_str(&content).map_err(Into::into)
}

fn read_write_nodes_file(path: &std::path::Path) -> Result<Vec<WriteNodeItem>> {
    let content = fs::read_to_string(path)?;
    let nodes: Vec<WriteNodeInputItem> = serde_json::from_str(&content)?;
    if nodes.is_empty() {
        return Err(anyhow!("write-nodes input must contain at least one node"));
    }
    Ok(nodes
        .into_iter()
        .map(WriteNodeInputItem::into_item)
        .collect())
}

fn read_database_metadata_input(
    database_id: &str,
    path: &std::path::Path,
) -> Result<UpdateDatabaseMetadataRequest> {
    let content = fs::read_to_string(path)?;
    let input: DatabaseMetadataInput = serde_json::from_str(&content)?;
    input.into_request(database_id)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DatabaseMetadataInput {
    name: String,
    description: String,
    llm_summary: Option<String>,
    tags_json: String,
}

impl DatabaseMetadataInput {
    fn into_request(self, database_id: &str) -> Result<UpdateDatabaseMetadataRequest> {
        let name = self.name.trim().to_string();
        if name.is_empty() {
            return Err(anyhow!("database metadata name must not be empty"));
        }
        let tags_json = self.tags_json.trim().to_string();
        validate_tags_json(&tags_json)?;
        Ok(UpdateDatabaseMetadataRequest {
            database_id: database_id.to_string(),
            name,
            description: self.description.trim().to_string(),
            llm_summary: self.llm_summary.and_then(non_empty_trimmed),
            tags_json,
        })
    }
}

fn validate_tags_json(tags_json: &str) -> Result<()> {
    let tags: Vec<String> = serde_json::from_str(tags_json).map_err(|error| {
        anyhow!("database metadata tags_json must be a JSON string array: {error}")
    })?;
    if tags.iter().any(|tag| tag.trim().is_empty()) {
        return Err(anyhow!(
            "database metadata tags_json must not contain empty tags"
        ));
    }
    Ok(())
}

fn non_empty_trimmed(value: String) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WriteNodeInputItem {
    path: String,
    kind: WriteNodeInputKind,
    content: String,
    #[serde(default = "default_metadata_json")]
    metadata_json: String,
    expected_etag: Option<String>,
}

impl WriteNodeInputItem {
    fn into_item(self) -> WriteNodeItem {
        WriteNodeItem {
            path: self.path,
            kind: self.kind.into_node_kind(),
            content: self.content,
            metadata_json: self.metadata_json,
            expected_etag: self.expected_etag,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum WriteNodeInputKind {
    File,
    Source,
    Folder,
}

impl WriteNodeInputKind {
    fn into_node_kind(self) -> NodeKind {
        match self {
            Self::File => NodeKind::File,
            Self::Source => NodeKind::Source,
            Self::Folder => NodeKind::Folder,
        }
    }
}

fn default_metadata_json() -> String {
    "{}".to_string()
}

#[cfg(test)]
mod tests;
