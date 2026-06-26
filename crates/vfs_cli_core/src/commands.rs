// Where: crates/vfs_cli_core/src/commands.rs
// What: Generic VFS command execution helpers.
// Why: The app-facing CLI package should delegate shared VFS command behavior instead of owning it.
use std::borrow::Cow;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::Command as ProcessCommand;

use anyhow::{Result, anyhow};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use vfs_client::VfsApi;
use vfs_types::{
    AppendNodeRequest, CyclesBillingConfig, CyclesTopUpConfig, DatabaseCyclesPurchaseRequest,
    DatabaseRestoreChunkRequest, DeleteNodeRequest, DeleteNodeResult, EditNodeRequest,
    GlobNodesRequest, GraphLinksRequest, GraphNeighborhoodRequest, IncomingLinksRequest,
    IndexSqlJsonQueryResult, KINIC_DECIMALS, KINIC_LEDGER_FEE_E8S, LinkEdge, ListChildrenRequest,
    ListNodesRequest, MarketEntitlementPage, MkdirNodeRequest, MoveNodeRequest, MultiEdit,
    MultiEditNodeRequest, NodeContextRequest, NodeEntryKind, NodeKind, OutgoingLinksRequest,
    SearchNodePathsRequest, SearchNodesRequest, WriteNodeItem, WriteNodeRequest, WriteNodesRequest,
    kinic_base_units_per_token,
};
use wiki_domain::validate_source_path_for_kind;

use crate::cli::{CyclesCommand, DatabaseCommand, MarketCommand, VfsCommand};
use crate::connection::{
    ResolvedConnection, ResolvedConnectionPreview, link_workspace_database,
    unlink_workspace_database, workspace_config_path,
};

const DEFAULT_BROWSER_ORIGIN: &str = "https://wiki.kinic.xyz";

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
        VfsCommand::ListNodes {
            prefix,
            recursive,
            json,
        } => {
            let entries = client
                .list_nodes(ListNodesRequest {
                    database_id: database_id.to_string(),
                    prefix,
                    recursive,
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
            validate_source_path_for_write(&path, kind.to_node_kind())?;
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
            for node in &nodes {
                validate_source_path_for_write(&node.path, node.kind.clone())?;
            }
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
            if let Some(kind_arg) = kind {
                validate_source_path_for_write(&path, kind_arg.to_node_kind())?;
            }
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
            overwrite,
            json,
        } => {
            if let Some(current) = client.read_node(database_id, &from_path).await? {
                validate_source_path_for_kind(&to_path, &current.kind)
                    .map_err(anyhow::Error::msg)?;
            }
            let result = client
                .move_node(MoveNodeRequest {
                    database_id: database_id.to_string(),
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

async fn run_market_command(client: &impl VfsApi, command: MarketCommand) -> Result<()> {
    match command {
        MarketCommand::Entitlements {
            cursor,
            limit,
            json,
        } => {
            let page = client.market_list_entitlements(cursor, limit).await?;
            print_market_entitlement_page(page, json)?;
        }
    }
    Ok(())
}

fn print_market_entitlement_page(page: MarketEntitlementPage, json: bool) -> Result<()> {
    if json {
        println!("{}", serde_json::to_string_pretty(&page)?);
        return Ok(());
    }

    for entitlement in page.entitlements {
        println!(
            "{}\t{}\t{}\t{}\t{}",
            entitlement.database_id,
            entitlement.listing_id,
            entitlement.order_id,
            entitlement.status,
            entitlement.purchased_at_ms
        );
    }
    if let Some(next_cursor) = page.next_cursor {
        println!("next_cursor\t{next_cursor}");
    }
    Ok(())
}

async fn run_database_command(
    client: &impl VfsApi,
    connection: &ResolvedConnection,
    command: DatabaseCommand,
) -> Result<()> {
    match command {
        DatabaseCommand::Create { name } => {
            let result = client.create_database(&name).await?;
            println!("{}", result.database_id);
        }
        DatabaseCommand::Rename { database_id, name } => {
            client.rename_database(&database_id, &name).await?;
        }
        DatabaseCommand::List { json } => {
            let databases = client.list_databases().await?;
            if json {
                println!("{}", serde_json::to_string_pretty(&databases)?);
            } else {
                for database in databases {
                    println!(
                        "{}\t{}\t{:?}\t{:?}\t{}\t{}\t{}",
                        database.database_id,
                        database.name,
                        database.role,
                        database.status,
                        database.logical_size_bytes,
                        database.cycles_balance.unwrap_or(0),
                        database
                            .cycles_suspended_at_ms
                            .map(|value| value.to_string())
                            .unwrap_or_else(|| "-".to_string())
                    );
                }
            }
        }
        DatabaseCommand::PurchaseCycles { database_id, kinic } => {
            let payment_amount_e8s = parse_kinic_amount_e8s(&kinic)?;
            let config = client.get_cycles_billing_config().await?;
            let min_expected_cycles = cycles_for_payment_amount_e8s(payment_amount_e8s, &config)?;
            let result = client
                .purchase_database_cycles(DatabaseCyclesPurchaseRequest {
                    database_id: database_id.clone(),
                    payment_amount_e8s,
                    min_expected_cycles,
                })
                .await?;
            println!(
                "{database_id}\t{}\t{}\t{}",
                result.block_index, result.amount_cycles, result.balance_cycles
            );
        }
        DatabaseCommand::CyclesHistory { database_id, json } => {
            let page = client
                .list_database_cycle_entries(&database_id, None, 100)
                .await?;
            if json {
                println!("{}", serde_json::to_string_pretty(&page)?);
            } else {
                for entry in page.entries {
                    println!(
                        "{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}",
                        entry.entry_id,
                        entry.kind,
                        entry.amount_cycles,
                        entry.balance_after_cycles,
                        entry.caller,
                        entry.method.unwrap_or_else(|| "-".to_string()),
                        entry
                            .ledger_block_index
                            .map(|value| value.to_string())
                            .unwrap_or_else(|| "-".to_string()),
                        entry.created_at_ms
                    );
                }
            }
        }
        DatabaseCommand::CyclesPending { database_id, json } => {
            let pending = client
                .list_database_cycles_pending_purchases(&database_id)
                .await?;
            if json {
                println!("{}", serde_json::to_string_pretty(&pending)?);
            } else {
                for purchase in pending {
                    println!(
                        "{}\t{}\t{}\t{}\t{}\t{}\t{}",
                        purchase.operation_id,
                        purchase.status,
                        purchase.amount_cycles,
                        purchase.payment_amount_e8s,
                        purchase
                            .ledger_block_index
                            .map(|value| value.to_string())
                            .unwrap_or_else(|| "-".to_string()),
                        purchase.required_action,
                        purchase.created_at_ms
                    );
                }
            }
        }
        DatabaseCommand::Cycles {
            database_id,
            browser_origin,
        } => {
            open_database_cycles_page(browser_origin.as_deref(), &database_id)?;
        }
        DatabaseCommand::Link { database_id } => {
            let path = link_workspace_database(connection, &database_id)?;
            println!("{}", path.display());
        }
        DatabaseCommand::Current { json } => {
            print_database_current(&ResolvedConnectionPreview::from(connection), json)?
        }
        DatabaseCommand::Unlink => {
            run_database_unlink()?;
        }
        DatabaseCommand::Grant {
            database_id,
            principal,
            role,
        } => {
            client
                .grant_database_access(&database_id, &principal, role.to_database_role())
                .await?;
            println!("{database_id}\t{principal}\t{:?}", role.to_database_role());
        }
        DatabaseCommand::GrantCurrentIdentity { database_id, role } => {
            let principal = client
                .caller_principal()
                .ok_or_else(|| anyhow!("current identity principal is not available"))?;
            client
                .grant_database_access(&database_id, &principal, role.to_database_role())
                .await?;
            println!("{database_id}\t{principal}\t{:?}", role.to_database_role());
        }
        DatabaseCommand::Revoke {
            database_id,
            principal,
        } => {
            client
                .revoke_database_access(&database_id, &principal)
                .await?;
            println!("{database_id}\t{principal}");
        }
        DatabaseCommand::Members { database_id, json } => {
            let members = client.list_database_members(&database_id).await?;
            if json {
                println!("{}", serde_json::to_string_pretty(&members)?);
            } else {
                for member in members {
                    println!(
                        "{}\t{}\t{:?}\t{}",
                        member.database_id, member.principal, member.role, member.created_at_ms
                    );
                }
            }
        }
        DatabaseCommand::ArchiveExport {
            database_id,
            output,
            chunk_size,
            json,
        } => {
            let result = archive_export(client, &database_id, &output, chunk_size).await?;
            print_archive_result(result, json)?;
        }
        DatabaseCommand::ArchiveRestore {
            database_id,
            input,
            chunk_size,
            json,
        } => {
            let result = archive_restore(client, &database_id, &input, chunk_size).await?;
            print_archive_result(result, json)?;
        }
        DatabaseCommand::ArchiveCancel { database_id } => {
            client.cancel_database_archive(&database_id).await?;
            println!("{database_id}");
        }
        DatabaseCommand::RestoreCancel { database_id } => {
            client.cancel_database_restore(&database_id).await?;
            println!("{database_id}");
        }
    }
    Ok(())
}

pub fn open_database_cycles_page(browser_origin: Option<&str>, database_id: &str) -> Result<()> {
    let url = database_cycles_url(browser_origin, database_id)?;
    println!("{url}");
    if let Err(error) = open_browser_url(&url) {
        eprintln!("{}", browser_open_warning(&error));
    }
    Ok(())
}

pub fn database_cycles_url(browser_origin: Option<&str>, database_id: &str) -> Result<String> {
    let origin = browser_origin
        .map(str::to_string)
        .or_else(|| std::env::var("KINIC_WIKI_BROWSER_ORIGIN").ok())
        .unwrap_or_else(|| DEFAULT_BROWSER_ORIGIN.to_string());
    let origin = origin.trim_end_matches('/');
    if origin.is_empty() {
        return Err(anyhow!("browser origin must not be empty"));
    }
    if !is_browser_cycles_database_id(database_id) {
        return Err(anyhow!("database_id contains unsupported characters"));
    }
    Ok(format!(
        "{origin}/cycles?database_id={}",
        query_encode(database_id)
    ))
}

fn is_browser_cycles_database_id(database_id: &str) -> bool {
    !database_id.is_empty()
        && database_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn parse_kinic_amount_e8s(value: &str) -> Result<u64> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(anyhow!("KINIC amount must not be empty"));
    }
    let (whole, fractional) = match trimmed.split_once('.') {
        Some((whole, fractional)) => (whole, Some(fractional)),
        None => (trimmed, None),
    };
    if whole.is_empty() || !whole.chars().all(|character| character.is_ascii_digit()) {
        return Err(anyhow!(
            "KINIC amount must be a positive decimal with up to {} fractional digits",
            KINIC_DECIMALS
        ));
    }
    let fractional = fractional.unwrap_or("");
    if fractional.is_empty() && trimmed.contains('.') {
        return Err(anyhow!(
            "KINIC amount must be a positive decimal with up to {} fractional digits",
            KINIC_DECIMALS
        ));
    }
    if fractional.len() > usize::from(KINIC_DECIMALS)
        || !fractional
            .chars()
            .all(|character| character.is_ascii_digit())
    {
        return Err(anyhow!(
            "KINIC amount must be a positive decimal with up to {} fractional digits",
            KINIC_DECIMALS
        ));
    }
    let whole = whole
        .parse::<u128>()
        .map_err(|_| anyhow!("KINIC amount exceeds u64 e8s limit"))?;
    let fractional_e8s = if fractional.is_empty() {
        0
    } else {
        let padded = format!("{fractional:0<width$}", width = usize::from(KINIC_DECIMALS));
        padded
            .parse::<u128>()
            .map_err(|_| anyhow!("KINIC amount exceeds u64 e8s limit"))?
    };
    let amount = whole
        .checked_mul(u128::from(kinic_base_units_per_token()))
        .and_then(|amount| amount.checked_add(fractional_e8s))
        .ok_or_else(|| anyhow!("KINIC amount exceeds u64 e8s limit"))?;
    if amount == 0 {
        return Err(anyhow!("KINIC amount must be positive"));
    }
    u64::try_from(amount).map_err(|_| anyhow!("KINIC amount exceeds u64 e8s limit"))
}

fn query_encode(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(char::from(byte));
            }
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

pub fn open_browser_url(url: &str) -> Result<()> {
    let status = if cfg!(target_os = "macos") {
        ProcessCommand::new("open").arg(url).status()
    } else if cfg!(target_os = "windows") {
        ProcessCommand::new("rundll32")
            .arg("url.dll,FileProtocolHandler")
            .arg(url)
            .status()
    } else {
        ProcessCommand::new("xdg-open").arg(url).status()
    };
    let status = status.map_err(|error| anyhow!("failed to open browser: {error}"))?;
    if !status.success() {
        return Err(anyhow!("failed to open browser: exit status {status}"));
    }
    Ok(())
}

fn browser_open_warning(error: &anyhow::Error) -> String {
    format!("warning: could not open browser automatically; open the URL manually: {error}")
}

async fn run_cycles_command(client: &impl VfsApi, command: CyclesCommand) -> Result<()> {
    match command {
        CyclesCommand::Config { json } => {
            let config = client.get_cycles_billing_config().await?;
            if json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&CyclesBillingConfigOutput::new(
                        config,
                        KINIC_LEDGER_FEE_E8S
                    ))?
                );
            } else {
                for line in cycles_config_lines(&config, KINIC_LEDGER_FEE_E8S) {
                    println!("{line}");
                }
            }
        }
    }
    Ok(())
}

#[derive(Debug, serde::Serialize)]
struct CyclesBillingConfigOutput {
    kinic_ledger_canister_id: String,
    billing_authority_id: String,
    cycles_per_kinic: u64,
    min_update_cycles: u64,
    top_up: CyclesTopUpConfig,
    ledger_fee_e8s: u64,
}

impl CyclesBillingConfigOutput {
    fn new(config: CyclesBillingConfig, ledger_fee_e8s: u64) -> Self {
        Self {
            kinic_ledger_canister_id: config.kinic_ledger_canister_id,
            billing_authority_id: config.billing_authority_id,
            cycles_per_kinic: config.cycles_per_kinic,
            min_update_cycles: config.min_update_cycles,
            top_up: config.top_up,
            ledger_fee_e8s,
        }
    }
}

fn cycles_config_lines(config: &CyclesBillingConfig, ledger_fee_e8s: u64) -> Vec<String> {
    vec![
        format!(
            "kinic_ledger_canister_id\t{}",
            config.kinic_ledger_canister_id
        ),
        format!("billing_authority_id\t{}", config.billing_authority_id),
        format!("cycles_per_kinic\t{}", config.cycles_per_kinic),
        format!("min_update_cycles\t{}", config.min_update_cycles),
        format!("top_up_enabled\t{}", config.top_up.enabled),
        format!(
            "top_up_launcher_principal\t{}",
            config.top_up.launcher_principal
        ),
        format!(
            "top_up_threshold_cycles\t{}",
            config.top_up.threshold_cycles
        ),
        format!("ledger_fee_e8s\t{ledger_fee_e8s}"),
    ]
}

fn cycles_for_payment_amount_e8s(
    payment_amount_e8s: u64,
    config: &CyclesBillingConfig,
) -> Result<u64> {
    if payment_amount_e8s == 0 {
        return Err(anyhow!("cycles purchase payment amount must be positive"));
    }
    let cycles = u128::from(payment_amount_e8s)
        .checked_mul(u128::from(config.cycles_per_kinic))
        .ok_or_else(|| anyhow!("cycles purchase amount overflow"))?
        / u128::from(kinic_base_units_per_token());
    let cycles =
        u64::try_from(cycles).map_err(|_| anyhow!("cycles purchase amount exceeds u64"))?;
    if cycles == 0 {
        return Err(anyhow!("cycles purchase amount is too small"));
    }
    Ok(cycles)
}

#[derive(Debug, serde::Serialize)]
struct ArchiveCommandResult {
    database_id: String,
    path: String,
    size_bytes: u64,
    snapshot_hash: String,
    chunk_size: u32,
    chunk_count: u64,
}

async fn archive_export(
    client: &impl VfsApi,
    database_id: &str,
    output: &Path,
    chunk_size: u32,
) -> Result<ArchiveCommandResult> {
    validate_archive_chunk_size(chunk_size)?;
    let archive = client.begin_database_archive(database_id).await?;
    let tmp_output = archive_tmp_path(output)?;
    let mut file = match File::create(&tmp_output) {
        Ok(file) => file,
        Err(error) => {
            let _ = client.cancel_database_archive(database_id).await;
            return Err(error.into());
        }
    };
    let (snapshot_hash, chunk_count) = archive_export_chunks(
        client,
        database_id,
        archive.size_bytes,
        &mut file,
        &tmp_output,
        chunk_size,
    )
    .await?;
    if let Err(error) = client
        .finalize_database_archive(database_id, snapshot_hash.clone())
        .await
    {
        cleanup_archive_export(client, database_id, &tmp_output).await;
        return Err(error);
    }
    fs::rename(&tmp_output, output).map_err(|error| {
        anyhow!(
            "failed to move archive tmp file {} to {}: {error}",
            tmp_output.display(),
            output.display()
        )
    })?;
    Ok(ArchiveCommandResult {
        database_id: database_id.to_string(),
        path: output.display().to_string(),
        size_bytes: archive.size_bytes,
        snapshot_hash: hex_string(&snapshot_hash),
        chunk_size,
        chunk_count,
    })
}

async fn archive_restore(
    client: &impl VfsApi,
    database_id: &str,
    input: &Path,
    chunk_size: u32,
) -> Result<ArchiveCommandResult> {
    validate_archive_chunk_size(chunk_size)?;
    let mut file = File::open(input)?;
    let size_bytes = file.metadata()?.len();
    let snapshot_hash = archive_file_hash(&mut file)?;
    file.seek(SeekFrom::Start(0))?;
    client
        .begin_database_restore(database_id, snapshot_hash.clone(), size_bytes)
        .await?;
    let chunk_count = match archive_restore_chunks(client, database_id, &mut file, chunk_size).await
    {
        Ok(chunk_count) => chunk_count,
        Err(error) => {
            return Err(cleanup_archive_restore(client, database_id, error).await);
        }
    };
    if let Err(error) = client.finalize_database_restore(database_id).await {
        return Err(cleanup_archive_restore(client, database_id, error).await);
    }
    Ok(ArchiveCommandResult {
        database_id: database_id.to_string(),
        path: input.display().to_string(),
        size_bytes,
        snapshot_hash: hex_string(&snapshot_hash),
        chunk_size,
        chunk_count,
    })
}

async fn archive_restore_chunks(
    client: &impl VfsApi,
    database_id: &str,
    file: &mut File,
    chunk_size: u32,
) -> Result<u64> {
    let mut buffer = vec![0_u8; chunk_size as usize];
    let mut offset = 0_u64;
    let mut chunk_count = 0_u64;
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        client
            .write_database_restore_chunk(DatabaseRestoreChunkRequest {
                database_id: database_id.to_string(),
                offset,
                bytes: buffer[..read].to_vec(),
            })
            .await?;
        offset += read as u64;
        chunk_count += 1;
    }
    Ok(chunk_count)
}

async fn cleanup_archive_restore(
    client: &impl VfsApi,
    database_id: &str,
    error: anyhow::Error,
) -> anyhow::Error {
    match client.cancel_database_restore(database_id).await {
        Ok(()) => error,
        Err(cancel_error) => anyhow!("{error}; restore cancel failed: {cancel_error}"),
    }
}

async fn archive_export_chunks(
    client: &impl VfsApi,
    database_id: &str,
    archive_size_bytes: u64,
    writer: &mut impl Write,
    tmp_output: &Path,
    chunk_size: u32,
) -> Result<(Vec<u8>, u64)> {
    let mut hasher = Sha256::new();
    let mut offset = 0_u64;
    let mut chunk_count = 0_u64;
    while offset < archive_size_bytes {
        let chunk = match client
            .read_database_archive_chunk(database_id, offset, chunk_size)
            .await
        {
            Ok(chunk) => chunk,
            Err(error) => {
                cleanup_archive_export(client, database_id, tmp_output).await;
                return Err(error);
            }
        };
        if chunk.bytes.is_empty() {
            cleanup_archive_export(client, database_id, tmp_output).await;
            return Err(anyhow!("archive chunk must not be empty before EOF"));
        }
        if let Err(error) = writer.write_all(&chunk.bytes) {
            cleanup_archive_export(client, database_id, tmp_output).await;
            return Err(error.into());
        }
        hasher.update(&chunk.bytes);
        offset += chunk.bytes.len() as u64;
        chunk_count += 1;
    }
    if let Err(error) = writer.flush() {
        cleanup_archive_export(client, database_id, tmp_output).await;
        return Err(error.into());
    }
    if offset != archive_size_bytes {
        cleanup_archive_export(client, database_id, tmp_output).await;
        return Err(anyhow!("archive byte length mismatch"));
    }
    Ok((hasher.finalize().to_vec(), chunk_count))
}

async fn cleanup_archive_export(client: &impl VfsApi, database_id: &str, tmp_output: &Path) {
    let _ = client.cancel_database_archive(database_id).await;
    let _ = fs::remove_file(tmp_output);
}

fn archive_file_hash(file: &mut File) -> Result<Vec<u8>> {
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher.finalize().to_vec())
}

fn validate_archive_chunk_size(chunk_size: u32) -> Result<()> {
    if (1..=1_048_576).contains(&chunk_size) {
        Ok(())
    } else {
        Err(anyhow!("chunk-size must be between 1 and 1048576 bytes"))
    }
}

fn archive_tmp_path(output: &Path) -> Result<PathBuf> {
    let name = output
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| anyhow!("output path must include a file name"))?;
    Ok(output.with_file_name(format!(".{name}.tmp")))
}

fn print_archive_result(result: ArchiveCommandResult, json: bool) -> Result<()> {
    if json {
        println!("{}", serde_json::to_string_pretty(&result)?);
    } else {
        println!(
            "{}\t{}\t{}\t{}",
            result.database_id, result.path, result.size_bytes, result.snapshot_hash
        );
    }
    Ok(())
}

fn hex_string(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
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

fn validate_source_path_for_write(path: &str, kind: vfs_types::NodeKind) -> Result<()> {
    validate_source_path_for_kind(path, &kind).map_err(anyhow::Error::msg)
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
}

impl WriteNodeInputKind {
    fn into_node_kind(self) -> NodeKind {
        match self {
            Self::File => NodeKind::File,
            Self::Source => NodeKind::Source,
        }
    }
}

fn default_metadata_json() -> String {
    "{}".to_string()
}

#[cfg(test)]
mod tests {
    use super::{command_requires_write_cycles_available, run_vfs_command};
    use crate::cli::{CyclesCommand, NodeKindArg, VfsCommand};
    use crate::connection::ResolvedConnection;
    use anyhow::{Result, anyhow};
    use async_trait::async_trait;
    use std::path::PathBuf;
    use std::sync::Mutex;
    use tempfile::tempdir;
    use vfs_client::VfsApi;
    use vfs_types::*;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn test_cycles_top_up_config() -> CyclesTopUpConfig {
        CyclesTopUpConfig {
            enabled: true,
            launcher_principal: "xfug4-5qaaa-aaaak-afowa-cai".to_string(),
            threshold_cycles: 2_000_000_000_000,
        }
    }

    #[derive(Default)]
    struct MockClient {
        nodes: Vec<Node>,
        entries: Vec<NodeEntry>,
        created: Mutex<u32>,
        database_lists: Mutex<u32>,
        database_cycle_purchases: Mutex<Vec<DatabaseCyclesPurchaseRequest>>,
        database_cycles_history: Mutex<Vec<String>>,
        database_cycles_pending: Mutex<Vec<String>>,
        market_entitlements: Mutex<Vec<(Option<String>, u32)>>,
        database_summaries: Mutex<Vec<DatabaseSummary>>,
        sql_queries: Mutex<Vec<(String, String, u32)>>,
        cycles_configs: Mutex<u32>,
        fail_cycles_config: Mutex<bool>,
        write_cycle_checks: Mutex<Vec<String>>,
        write_cycle_check_error: Mutex<Option<String>>,
        writes: Mutex<Vec<WriteNodeRequest>>,
        write_batches: Mutex<Vec<WriteNodesRequest>>,
        deletes: Mutex<Vec<DeleteNodeRequest>>,
        child_lists: Mutex<Vec<ListChildrenRequest>>,
        contexts: Mutex<Vec<NodeContextRequest>>,
        neighborhoods: Mutex<Vec<GraphNeighborhoodRequest>>,
        archive_begun: Mutex<Vec<String>>,
        archive_chunks: Mutex<Vec<(u64, u32)>>,
        archive_finalized: Mutex<Vec<Vec<u8>>>,
        archive_cancelled: Mutex<Vec<String>>,
        restore_begun: Mutex<Vec<(String, Vec<u8>, u64)>>,
        restore_chunks: Mutex<Vec<DatabaseRestoreChunkRequest>>,
        restore_finalized: Mutex<Vec<String>>,
        restore_cancelled: Mutex<Vec<String>>,
        fail_restore_chunk: Mutex<Option<anyhow::Error>>,
        fail_restore_finalize: Mutex<Option<anyhow::Error>>,
        fail_restore_cancel: Mutex<Option<anyhow::Error>>,
    }

    struct FailingWriter;

    impl std::io::Write for FailingWriter {
        fn write(&mut self, _buf: &[u8]) -> std::io::Result<usize> {
            Err(std::io::Error::other("disk full"))
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    fn test_connection() -> ResolvedConnection {
        ResolvedConnection {
            replica_host: "http://127.0.0.1:8000".to_string(),
            canister_id: "aaaaa-aa".to_string(),
            database_id: Some("alpha".to_string()),
            replica_host_source: "test".to_string(),
            canister_id_source: "test".to_string(),
            database_id_source: Some("test".to_string()),
        }
    }

    fn node(path: &str, kind: NodeKind, etag: &str) -> Node {
        Node {
            path: path.to_string(),
            kind,
            content: String::new(),
            created_at: 1,
            updated_at: 2,
            etag: etag.to_string(),
            metadata_json: "{}".to_string(),
        }
    }

    fn entry(path: &str, kind: NodeEntryKind, etag: &str) -> NodeEntry {
        let has_children = kind == NodeEntryKind::Folder;
        NodeEntry {
            path: path.to_string(),
            kind,
            updated_at: 2,
            etag: etag.to_string(),
            has_children,
        }
    }

    #[async_trait]
    impl VfsApi for MockClient {
        async fn status(&self, _database_id: &str) -> Result<Status> {
            unreachable!()
        }
        async fn create_database(&self, name: &str) -> Result<CreateDatabaseResult> {
            let mut created = self.created.lock().unwrap();
            *created += 1;
            Ok(CreateDatabaseResult {
                database_id: "db_testgenerated".to_string(),
                name: name.to_string(),
            })
        }
        async fn purchase_database_cycles(
            &self,
            request: DatabaseCyclesPurchaseRequest,
        ) -> Result<CyclesPurchaseResult> {
            self.database_cycle_purchases.lock().unwrap().push(request);
            Ok(CyclesPurchaseResult {
                block_index: 7,
                amount_cycles: 1_250,
                balance_cycles: 1_250,
            })
        }
        async fn list_database_cycle_entries(
            &self,
            database_id: &str,
            _cursor: Option<u64>,
            _limit: u32,
        ) -> Result<DatabaseCycleEntryPage> {
            self.database_cycles_history
                .lock()
                .unwrap()
                .push(database_id.to_string());
            Ok(DatabaseCycleEntryPage {
                entries: vec![DatabaseCycleEntry {
                    entry_id: 1,
                    database_id: database_id.to_string(),
                    kind: "cycles_purchase".to_string(),
                    amount_cycles: 500_000,
                    balance_after_cycles: 500_000,
                    payment_amount_e8s: Some(50_000_000_000),
                    caller: "caller".to_string(),
                    method: Some("purchase_database_cycles".to_string()),
                    cycles_delta: None,
                    cycles_per_kinic: None,
                    ledger_block_index: Some(7),
                    created_at_ms: 1,
                }],
                next_cursor: None,
            })
        }
        async fn list_database_cycles_pending_purchases(
            &self,
            database_id: &str,
        ) -> Result<Vec<DatabaseCyclesPendingPurchase>> {
            self.database_cycles_pending
                .lock()
                .unwrap()
                .push(database_id.to_string());
            Ok(vec![DatabaseCyclesPendingPurchase {
                operation_id: 9,
                database_id: database_id.to_string(),
                status: "ambiguous".to_string(),
                amount_cycles: 1_250,
                payment_amount_e8s: 125_000_000,
                ledger_block_index: None,
                created_at_ms: 3,
                required_action: "billing_authority_review".to_string(),
            }])
        }
        async fn market_list_entitlements(
            &self,
            cursor: Option<String>,
            limit: u32,
        ) -> Result<MarketEntitlementPage> {
            self.market_entitlements
                .lock()
                .unwrap()
                .push((cursor, limit));
            Ok(MarketEntitlementPage {
                entitlements: vec![MarketEntitlement {
                    database_id: "db_market".to_string(),
                    buyer_principal: "buyer".to_string(),
                    listing_id: "listing-1".to_string(),
                    order_id: "order-1".to_string(),
                    purchased_at_ms: 123,
                    status: "active".to_string(),
                }],
                next_cursor: Some("next".to_string()),
            })
        }
        async fn get_cycles_billing_config(&self) -> Result<CyclesBillingConfig> {
            let mut configs = self.cycles_configs.lock().unwrap();
            *configs += 1;
            if *self.fail_cycles_config.lock().unwrap() {
                return Err(anyhow!("cycles config unavailable"));
            }
            Ok(CyclesBillingConfig {
                kinic_ledger_canister_id: "ryjl3-tyaaa-aaaaa-aaaba-cai".to_string(),
                billing_authority_id: "rrkah-fqaaa-aaaaa-aaaaq-cai".to_string(),
                cycles_per_kinic: 1_000,
                min_update_cycles: 1,
                top_up: test_cycles_top_up_config(),
            })
        }
        async fn check_database_write_cycles(&self, database_id: &str) -> Result<()> {
            self.write_cycle_checks
                .lock()
                .unwrap()
                .push(database_id.to_string());
            if let Some(error) = self.write_cycle_check_error.lock().unwrap().take() {
                return Err(anyhow!(error));
            }
            Ok(())
        }
        async fn rename_database(&self, _database_id: &str, _name: &str) -> Result<()> {
            Ok(())
        }
        async fn list_databases(&self) -> Result<Vec<DatabaseSummary>> {
            let mut lists = self.database_lists.lock().unwrap();
            *lists += 1;
            let summaries = self.database_summaries.lock().unwrap();
            if !summaries.is_empty() {
                return Ok(summaries.clone());
            }
            Ok(vec![DatabaseSummary {
                database_id: "alpha".to_string(),
                name: "Alpha".to_string(),
                status: DatabaseStatus::Active,
                role: DatabaseRole::Owner,
                logical_size_bytes: 42,
                cycles_balance: Some(1_000_000),
                cycles_suspended_at_ms: None,
                archived_at_ms: None,
                deleted_at_ms: None,
            }])
        }
        async fn begin_database_archive(&self, database_id: &str) -> Result<DatabaseArchiveInfo> {
            self.archive_begun
                .lock()
                .unwrap()
                .push(database_id.to_string());
            Ok(DatabaseArchiveInfo {
                database_id: database_id.to_string(),
                size_bytes: b"archive bytes".len() as u64,
            })
        }
        async fn read_database_archive_chunk(
            &self,
            _database_id: &str,
            offset: u64,
            max_bytes: u32,
        ) -> Result<DatabaseArchiveChunk> {
            self.archive_chunks
                .lock()
                .unwrap()
                .push((offset, max_bytes));
            let bytes = b"archive bytes";
            let start = offset as usize;
            let end = (start + max_bytes as usize).min(bytes.len());
            Ok(DatabaseArchiveChunk {
                bytes: bytes[start..end].to_vec(),
            })
        }
        async fn finalize_database_archive(
            &self,
            _database_id: &str,
            snapshot_hash: Vec<u8>,
        ) -> Result<()> {
            self.archive_finalized.lock().unwrap().push(snapshot_hash);
            Ok(())
        }
        async fn cancel_database_archive(&self, database_id: &str) -> Result<()> {
            self.archive_cancelled
                .lock()
                .unwrap()
                .push(database_id.to_string());
            Ok(())
        }
        async fn begin_database_restore(
            &self,
            database_id: &str,
            snapshot_hash: Vec<u8>,
            size_bytes: u64,
        ) -> Result<()> {
            self.restore_begun.lock().unwrap().push((
                database_id.to_string(),
                snapshot_hash,
                size_bytes,
            ));
            Ok(())
        }
        async fn write_database_restore_chunk(
            &self,
            request: DatabaseRestoreChunkRequest,
        ) -> Result<()> {
            if let Some(error) = self.fail_restore_chunk.lock().unwrap().take() {
                return Err(error);
            }
            self.restore_chunks.lock().unwrap().push(request);
            Ok(())
        }
        async fn finalize_database_restore(&self, database_id: &str) -> Result<()> {
            if let Some(error) = self.fail_restore_finalize.lock().unwrap().take() {
                return Err(error);
            }
            self.restore_finalized
                .lock()
                .unwrap()
                .push(database_id.to_string());
            Ok(())
        }
        async fn cancel_database_restore(&self, database_id: &str) -> Result<()> {
            if let Some(error) = self.fail_restore_cancel.lock().unwrap().take() {
                return Err(error);
            }
            self.restore_cancelled
                .lock()
                .unwrap()
                .push(database_id.to_string());
            Ok(())
        }
        async fn read_node(&self, _database_id: &str, path: &str) -> Result<Option<Node>> {
            Ok(self.nodes.iter().find(|node| node.path == path).cloned())
        }
        async fn query_database_sql_json(
            &self,
            database_id: &str,
            sql: &str,
            limit: u32,
        ) -> Result<IndexSqlJsonQueryResult> {
            self.sql_queries.lock().unwrap().push((
                database_id.to_string(),
                sql.to_string(),
                limit,
            ));
            Ok(IndexSqlJsonQueryResult {
                rows: vec![r#"{"ok":1}"#.to_string()],
                row_count: 1,
                limit,
            })
        }
        async fn read_node_context(
            &self,
            request: NodeContextRequest,
        ) -> Result<Option<NodeContext>> {
            self.contexts.lock().unwrap().push(request.clone());
            Ok(Some(NodeContext {
                node: Node {
                    path: request.path,
                    kind: NodeKind::File,
                    content: "body".to_string(),
                    created_at: 1,
                    updated_at: 2,
                    etag: "etag".to_string(),
                    metadata_json: "{}".to_string(),
                },
                incoming_links: Vec::new(),
                outgoing_links: Vec::new(),
            }))
        }
        async fn list_nodes(&self, _request: ListNodesRequest) -> Result<Vec<NodeEntry>> {
            Ok(self.entries.clone())
        }
        async fn list_children(&self, request: ListChildrenRequest) -> Result<Vec<ChildNode>> {
            self.child_lists.lock().unwrap().push(request);
            Ok(vec![ChildNode {
                path: "/Knowledge/alpha.md".to_string(),
                name: "alpha.md".to_string(),
                kind: NodeEntryKind::File,
                updated_at: Some(10),
                etag: Some("etag".to_string()),
                size_bytes: Some(5),
                is_virtual: false,
                has_children: false,
            }])
        }
        async fn write_node(&self, request: WriteNodeRequest) -> Result<WriteNodeResult> {
            self.writes.lock().unwrap().push(request.clone());
            Ok(WriteNodeResult {
                node: NodeMutationAck {
                    path: request.path,
                    kind: request.kind,
                    updated_at: 0,
                    etag: "etag".to_string(),
                },
                created: true,
            })
        }
        async fn write_nodes(&self, request: WriteNodesRequest) -> Result<Vec<WriteNodeResult>> {
            self.write_batches.lock().unwrap().push(request.clone());
            Ok(request
                .nodes
                .into_iter()
                .map(|node| WriteNodeResult {
                    node: NodeMutationAck {
                        path: node.path,
                        kind: node.kind,
                        updated_at: 0,
                        etag: "etag".to_string(),
                    },
                    created: true,
                })
                .collect())
        }
        async fn append_node(&self, _request: AppendNodeRequest) -> Result<WriteNodeResult> {
            unreachable!()
        }
        async fn edit_node(&self, _request: EditNodeRequest) -> Result<EditNodeResult> {
            unreachable!()
        }
        async fn delete_node(&self, request: DeleteNodeRequest) -> Result<DeleteNodeResult> {
            self.deletes.lock().unwrap().push(request.clone());
            Ok(DeleteNodeResult { path: request.path })
        }
        async fn move_node(&self, _request: MoveNodeRequest) -> Result<MoveNodeResult> {
            unreachable!()
        }
        async fn mkdir_node(&self, _request: MkdirNodeRequest) -> Result<MkdirNodeResult> {
            unreachable!()
        }
        async fn glob_nodes(&self, _request: GlobNodesRequest) -> Result<Vec<GlobNodeHit>> {
            unreachable!()
        }
        async fn graph_neighborhood(
            &self,
            request: GraphNeighborhoodRequest,
        ) -> Result<Vec<LinkEdge>> {
            self.neighborhoods.lock().unwrap().push(request);
            Ok(Vec::new())
        }
        async fn multi_edit_node(
            &self,
            _request: MultiEditNodeRequest,
        ) -> Result<MultiEditNodeResult> {
            unreachable!()
        }
        async fn search_nodes(&self, _request: SearchNodesRequest) -> Result<Vec<SearchNodeHit>> {
            unreachable!()
        }
        async fn search_node_paths(
            &self,
            _request: SearchNodePathsRequest,
        ) -> Result<Vec<SearchNodeHit>> {
            unreachable!()
        }
        async fn export_snapshot(
            &self,
            _request: ExportSnapshotRequest,
        ) -> Result<ExportSnapshotResponse> {
            unreachable!()
        }
        async fn fetch_updates(
            &self,
            _request: FetchUpdatesRequest,
        ) -> Result<FetchUpdatesResponse> {
            unreachable!()
        }
    }

    #[tokio::test]
    async fn write_node_supports_source_kind() {
        let dir = tempdir().expect("temp dir should exist");
        let input = PathBuf::from(dir.path()).join("source.md");
        std::fs::write(&input, "# Source").expect("input should write");
        let client = MockClient::default();
        run_vfs_command(
            &client,
            &test_connection(),
            VfsCommand::WriteNode {
                path: "/Sources/source/source.md".to_string(),
                kind: NodeKindArg::Source,
                input,
                metadata_json: "{}".to_string(),
                expected_etag: None,
                json: false,
            },
        )
        .await
        .expect("write should succeed");
        assert_eq!(client.writes.lock().unwrap()[0].kind, NodeKind::Source);
    }

    #[tokio::test]
    async fn mutating_command_checks_write_cycles_before_write() {
        let dir = tempdir().expect("temp dir should exist");
        let input = PathBuf::from(dir.path()).join("source.md");
        std::fs::write(&input, "# Source").expect("input should write");
        let client = MockClient::default();

        run_vfs_command(
            &client,
            &test_connection(),
            VfsCommand::WriteNode {
                path: "/Sources/source/source.md".to_string(),
                kind: NodeKindArg::Source,
                input,
                metadata_json: "{}".to_string(),
                expected_etag: None,
                json: true,
            },
        )
        .await
        .expect("write should pass after cycles check");

        assert_eq!(
            *client.write_cycle_checks.lock().unwrap(),
            vec!["alpha".to_string()]
        );
        assert_eq!(client.writes.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn mutating_command_rejects_canister_write_cycles_error_before_write() {
        let client = MockClient {
            write_cycle_check_error: Mutex::new(Some("database cycles are suspended".to_string())),
            ..MockClient::default()
        };

        let error = run_vfs_command(
            &client,
            &test_connection(),
            VfsCommand::MkdirNode {
                path: "/Knowledge/new".to_string(),
                json: false,
            },
        )
        .await
        .expect_err("canister cycles check should reject");

        assert!(error.to_string().contains("cycles are suspended"));
        assert_eq!(
            *client.write_cycle_checks.lock().unwrap(),
            vec!["alpha".to_string()]
        );
        assert!(client.writes.lock().unwrap().is_empty());
    }

    #[test]
    fn cycles_gate_covers_content_mutation_commands_only() {
        assert!(command_requires_write_cycles_available(
            &VfsCommand::WriteNode {
                path: "/Knowledge/a.md".to_string(),
                kind: NodeKindArg::File,
                input: PathBuf::from("a.md"),
                metadata_json: "{}".to_string(),
                expected_etag: None,
                json: false,
            }
        ));
        assert!(command_requires_write_cycles_available(
            &VfsCommand::AppendNode {
                path: "/Knowledge/a.md".to_string(),
                input: PathBuf::from("a.md"),
                kind: None,
                metadata_json: None,
                expected_etag: None,
                separator: None,
                json: false,
            }
        ));
        assert!(command_requires_write_cycles_available(
            &VfsCommand::EditNode {
                path: "/Knowledge/a.md".to_string(),
                old_text: "a".to_string(),
                new_text: "b".to_string(),
                expected_etag: None,
                replace_all: false,
                json: false,
            }
        ));
        assert!(command_requires_write_cycles_available(
            &VfsCommand::DeleteNode {
                path: "/Knowledge/a.md".to_string(),
                expected_etag: None,
                expected_folder_index_etag: None,
                json: false,
            }
        ));
        assert!(command_requires_write_cycles_available(
            &VfsCommand::DeleteTree {
                path: "/Knowledge/a".to_string(),
                json: false,
            }
        ));
        assert!(command_requires_write_cycles_available(
            &VfsCommand::MkdirNode {
                path: "/Knowledge/a".to_string(),
                json: false,
            }
        ));
        assert!(command_requires_write_cycles_available(
            &VfsCommand::MoveNode {
                from_path: "/Knowledge/a.md".to_string(),
                to_path: "/Knowledge/b.md".to_string(),
                expected_etag: None,
                overwrite: false,
                json: false,
            }
        ));
        assert!(command_requires_write_cycles_available(
            &VfsCommand::MultiEditNode {
                path: "/Knowledge/a.md".to_string(),
                edits_file: PathBuf::from("edits.json"),
                expected_etag: None,
                json: false,
            }
        ));
        assert!(!command_requires_write_cycles_available(
            &VfsCommand::ReadNode {
                path: "/Knowledge/a.md".to_string(),
                metadata_only: false,
                fields: None,
                json: false,
            }
        ));
        assert!(!command_requires_write_cycles_available(
            &VfsCommand::Database {
                command: super::DatabaseCommand::PurchaseCycles {
                    database_id: "alpha".to_string(),
                    kinic: "1".to_string(),
                },
            }
        ));
    }

    #[tokio::test]
    async fn write_nodes_dispatches_one_batch() {
        let dir = tempdir().expect("temp dir should exist");
        let input = PathBuf::from(dir.path()).join("nodes.json");
        std::fs::write(
            &input,
            r#"[
  {"path": "/Knowledge/a.md", "kind": "file", "content": "alpha"},
  {"path": "/Sources/source/source.md", "kind": "source", "content": "source", "metadata_json": "{\"url\":\"https://example.com\"}", "expected_etag": "etag-source"}
]"#,
        )
        .expect("input should write");
        let client = MockClient::default();
        run_vfs_command(
            &client,
            &test_connection(),
            VfsCommand::WriteNodes { input, json: true },
        )
        .await
        .expect("batch write should succeed");

        let batches = client.write_batches.lock().unwrap();
        assert_eq!(batches.len(), 1);
        assert_eq!(batches[0].database_id, "alpha");
        assert_eq!(batches[0].nodes.len(), 2);
        assert_eq!(batches[0].nodes[0].metadata_json, "{}");
        assert_eq!(batches[0].nodes[1].kind, NodeKind::Source);
        assert_eq!(
            batches[0].nodes[1].expected_etag.as_deref(),
            Some("etag-source")
        );
    }

    #[tokio::test]
    async fn write_nodes_rejects_invalid_source_path() {
        let dir = tempdir().expect("temp dir should exist");
        let input = PathBuf::from(dir.path()).join("nodes.json");
        std::fs::write(
            &input,
            r#"[{"path": "/Knowledge/source.md", "kind": "source", "content": "source"}]"#,
        )
        .expect("input should write");
        let client = MockClient::default();
        let error = run_vfs_command(
            &client,
            &test_connection(),
            VfsCommand::WriteNodes { input, json: true },
        )
        .await
        .expect_err("invalid source path should fail");

        assert!(error.to_string().contains("source path must stay under"));
        assert!(client.write_batches.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn write_nodes_rejects_empty_input() {
        let dir = tempdir().expect("temp dir should exist");
        let input = PathBuf::from(dir.path()).join("nodes.json");
        std::fs::write(&input, "[]").expect("input should write");
        let client = MockClient::default();
        let error = run_vfs_command(
            &client,
            &test_connection(),
            VfsCommand::WriteNodes { input, json: true },
        )
        .await
        .expect_err("empty input should fail");

        assert!(error.to_string().contains("at least one node"));
        assert!(client.write_batches.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn write_nodes_rejects_invalid_json() {
        let dir = tempdir().expect("temp dir should exist");
        let input = PathBuf::from(dir.path()).join("nodes.json");
        std::fs::write(&input, "{").expect("input should write");
        let client = MockClient::default();
        let error = run_vfs_command(
            &client,
            &test_connection(),
            VfsCommand::WriteNodes { input, json: true },
        )
        .await
        .expect_err("invalid json should fail");

        assert!(!error.to_string().is_empty());
        assert!(client.write_batches.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn write_nodes_rejects_unknown_fields() {
        let dir = tempdir().expect("temp dir should exist");
        let input = PathBuf::from(dir.path()).join("nodes.json");
        std::fs::write(
            &input,
            r#"[{"path": "/Knowledge/a.md", "kind": "file", "content": "alpha", "expected_etga": "etag"}]"#,
        )
        .expect("input should write");
        let client = MockClient::default();
        let error = run_vfs_command(
            &client,
            &test_connection(),
            VfsCommand::WriteNodes { input, json: true },
        )
        .await
        .expect_err("unknown field should fail");

        assert!(error.to_string().contains("unknown field"));
        assert!(client.write_batches.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn write_nodes_rejects_folder_kind() {
        let dir = tempdir().expect("temp dir should exist");
        let input = PathBuf::from(dir.path()).join("nodes.json");
        std::fs::write(
            &input,
            r#"[{"path": "/Knowledge/folder", "kind": "folder", "content": ""}]"#,
        )
        .expect("input should write");
        let client = MockClient::default();
        let error = run_vfs_command(
            &client,
            &test_connection(),
            VfsCommand::WriteNodes { input, json: true },
        )
        .await
        .expect_err("folder kind should fail");

        assert!(error.to_string().contains("unknown variant"));
        assert!(client.write_batches.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn list_children_sends_path_request() {
        let client = MockClient::default();
        run_vfs_command(
            &client,
            &test_connection(),
            VfsCommand::ListChildren {
                path: "/Knowledge".to_string(),
                json: true,
            },
        )
        .await
        .expect("list children should succeed");
        assert_eq!(client.child_lists.lock().unwrap()[0].path, "/Knowledge");
    }

    #[tokio::test]
    async fn delete_node_autofills_folder_index_etag() {
        let client = MockClient {
            nodes: vec![
                node("/Knowledge/topic", NodeKind::Folder, "etag-folder"),
                node("/Knowledge/topic/index.md", NodeKind::File, "etag-index"),
            ],
            ..MockClient::default()
        };
        run_vfs_command(
            &client,
            &test_connection(),
            VfsCommand::DeleteNode {
                path: "/Knowledge/topic".to_string(),
                expected_etag: Some("etag-folder".to_string()),
                expected_folder_index_etag: None,
                json: true,
            },
        )
        .await
        .expect("folder delete should succeed");

        let deletes = client.deletes.lock().unwrap();
        assert_eq!(deletes[0].path, "/Knowledge/topic");
        assert_eq!(deletes[0].expected_etag.as_deref(), Some("etag-folder"));
        assert_eq!(
            deletes[0].expected_folder_index_etag.as_deref(),
            Some("etag-index")
        );
    }

    #[tokio::test]
    async fn delete_node_keeps_explicit_folder_index_etag() {
        let client = MockClient {
            nodes: vec![
                node("/Knowledge/topic", NodeKind::Folder, "etag-folder"),
                node("/Knowledge/topic/index.md", NodeKind::File, "etag-index"),
            ],
            ..MockClient::default()
        };
        run_vfs_command(
            &client,
            &test_connection(),
            VfsCommand::DeleteNode {
                path: "/Knowledge/topic".to_string(),
                expected_etag: Some("etag-folder".to_string()),
                expected_folder_index_etag: Some("stale".to_string()),
                json: true,
            },
        )
        .await
        .expect("folder delete should dispatch");

        let deletes = client.deletes.lock().unwrap();
        assert_eq!(
            deletes[0].expected_folder_index_etag.as_deref(),
            Some("stale")
        );
    }

    #[tokio::test]
    async fn delete_tree_autofills_folder_index_etag_for_folder_entries() {
        let client = MockClient {
            nodes: vec![node(
                "/Knowledge/topic/index.md",
                NodeKind::File,
                "etag-index",
            )],
            entries: vec![
                entry(
                    "/Knowledge/topic/index.md",
                    NodeEntryKind::File,
                    "etag-index",
                ),
                entry("/Knowledge/topic", NodeEntryKind::Folder, "etag-folder"),
            ],
            ..MockClient::default()
        };
        run_vfs_command(
            &client,
            &test_connection(),
            VfsCommand::DeleteTree {
                path: "/Knowledge/topic".to_string(),
                json: true,
            },
        )
        .await
        .expect("tree delete should succeed");

        let deletes = client.deletes.lock().unwrap();
        let index_delete = deletes
            .iter()
            .find(|request| request.path == "/Knowledge/topic/index.md")
            .expect("index delete should dispatch");
        assert!(index_delete.expected_folder_index_etag.is_none());
        let folder_delete = deletes
            .iter()
            .find(|request| request.path == "/Knowledge/topic")
            .expect("folder delete should dispatch");
        assert_eq!(
            folder_delete.expected_folder_index_etag.as_deref(),
            Some("etag-index")
        );
    }

    #[tokio::test]
    async fn database_create_uses_name_and_prints_generated_id() {
        let client = MockClient::default();
        run_vfs_command(
            &client,
            &test_connection(),
            VfsCommand::Database {
                command: super::DatabaseCommand::Create {
                    name: "Team skills".to_string(),
                },
            },
        )
        .await
        .expect("database create should succeed");
        assert_eq!(*client.created.lock().unwrap(), 1);
    }

    #[tokio::test]
    async fn database_cycles_purchase_calls_client() {
        let client = MockClient::default();
        run_vfs_command(
            &client,
            &test_connection(),
            VfsCommand::Database {
                command: super::DatabaseCommand::PurchaseCycles {
                    database_id: "db_alpha".to_string(),
                    kinic: "1.25".to_string(),
                },
            },
        )
        .await
        .expect("database cycle purchase should succeed");
        assert_eq!(
            *client.database_cycle_purchases.lock().unwrap(),
            vec![DatabaseCyclesPurchaseRequest {
                database_id: "db_alpha".to_string(),
                payment_amount_e8s: 125_000_000,
                min_expected_cycles: 1_250,
            }]
        );
    }

    #[tokio::test]
    async fn database_cycles_purchase_requires_cycles_quote() {
        let client = MockClient {
            fail_cycles_config: Mutex::new(true),
            ..MockClient::default()
        };
        let error = run_vfs_command(
            &client,
            &test_connection(),
            VfsCommand::Database {
                command: super::DatabaseCommand::PurchaseCycles {
                    database_id: "db_alpha".to_string(),
                    kinic: "1.25".to_string(),
                },
            },
        )
        .await
        .expect_err("database cycle purchase should require quote config");
        assert!(error.to_string().contains("cycles config unavailable"));
        assert!(client.database_cycle_purchases.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn database_cycles_purchase_rejects_invalid_kinic_amounts() {
        for kinic in ["0", "0.000000001", "abc", "184467440737.09551616"] {
            let client = MockClient::default();
            let error = run_vfs_command(
                &client,
                &test_connection(),
                VfsCommand::Database {
                    command: super::DatabaseCommand::PurchaseCycles {
                        database_id: "db_alpha".to_string(),
                        kinic: kinic.to_string(),
                    },
                },
            )
            .await
            .expect_err("invalid KINIC amount should reject");
            assert!(error.to_string().contains("KINIC amount"));
            assert!(client.database_cycle_purchases.lock().unwrap().is_empty());
        }
    }

    #[tokio::test]
    async fn database_cycles_history_calls_client() {
        let client = MockClient::default();
        run_vfs_command(
            &client,
            &test_connection(),
            VfsCommand::Database {
                command: super::DatabaseCommand::CyclesHistory {
                    database_id: "db_alpha".to_string(),
                    json: false,
                },
            },
        )
        .await
        .expect("database cycles-history should succeed");
        assert_eq!(
            *client.database_cycles_history.lock().unwrap(),
            vec!["db_alpha".to_string()]
        );
    }

    #[tokio::test]
    async fn database_cycles_pending_calls_client() {
        let client = MockClient::default();
        run_vfs_command(
            &client,
            &test_connection(),
            VfsCommand::Database {
                command: super::DatabaseCommand::CyclesPending {
                    database_id: "db_alpha".to_string(),
                    json: false,
                },
            },
        )
        .await
        .expect("database cycles-pending should succeed");
        assert_eq!(
            *client.database_cycles_pending.lock().unwrap(),
            vec!["db_alpha".to_string()]
        );
    }

    #[tokio::test]
    async fn market_entitlements_calls_client_without_database_id() {
        let client = MockClient::default();
        let mut connection = test_connection();
        connection.database_id = None;

        run_vfs_command(
            &client,
            &connection,
            VfsCommand::Market {
                command: super::MarketCommand::Entitlements {
                    cursor: Some("cursor-1".to_string()),
                    limit: 50,
                    json: false,
                },
            },
        )
        .await
        .expect("market entitlements should not require selected database");

        assert_eq!(
            *client.market_entitlements.lock().unwrap(),
            vec![(Some("cursor-1".to_string()), 50)]
        );
    }

    #[test]
    fn database_cycles_url_uses_browser_origin() {
        let url = super::database_cycles_url(Some("http://127.0.0.1:3000/"), "db_alpha")
            .expect("url should build");

        assert_eq!(url, "http://127.0.0.1:3000/cycles?database_id=db_alpha");
    }

    #[test]
    fn database_cycles_url_rejects_unsupported_database_id() {
        for database_id in ["db alpha", "bad/path", ""] {
            let error = super::database_cycles_url(Some("http://127.0.0.1:3000/"), database_id)
                .expect_err("unsupported database id should fail");
            assert!(
                error
                    .to_string()
                    .contains("database_id contains unsupported characters")
            );
        }
    }

    #[test]
    fn database_cycles_url_rejects_empty_browser_origin() {
        let error =
            super::database_cycles_url(Some(""), "db_alpha").expect_err("empty origin should fail");
        assert!(error.to_string().contains("browser origin"));
    }

    #[test]
    fn database_cycles_open_warning_keeps_url_actionable() {
        let error = anyhow!("xdg-open missing");
        let warning = super::browser_open_warning(&error);

        assert!(warning.contains("warning: could not open browser automatically"));
        assert!(warning.contains("open the URL manually"));
        assert!(warning.contains("xdg-open missing"));
    }

    #[tokio::test]
    async fn cycles_config_json_calls_client() {
        let client = MockClient::default();
        run_vfs_command(
            &client,
            &test_connection(),
            VfsCommand::Cycles {
                command: CyclesCommand::Config { json: true },
            },
        )
        .await
        .expect("cycles config should succeed");
        assert_eq!(*client.cycles_configs.lock().unwrap(), 1);
    }

    #[test]
    fn cycles_config_text_includes_billing_authority_principal() {
        let lines = super::cycles_config_lines(
            &CyclesBillingConfig {
                kinic_ledger_canister_id: "ryjl3-tyaaa-aaaaa-aaaba-cai".to_string(),
                billing_authority_id: "rrkah-fqaaa-aaaaa-aaaaq-cai".to_string(),
                cycles_per_kinic: 1_000,
                min_update_cycles: 1,
                top_up: test_cycles_top_up_config(),
            },
            KINIC_LEDGER_FEE_E8S,
        );

        assert!(lines.contains(&"billing_authority_id\trrkah-fqaaa-aaaaa-aaaaq-cai".to_string()));
        assert!(lines.contains(&"ledger_fee_e8s\t100000".to_string()));
    }

    #[tokio::test]
    async fn database_rename_parses_and_calls_client() {
        let client = MockClient::default();
        run_vfs_command(
            &client,
            &test_connection(),
            VfsCommand::Database {
                command: super::DatabaseCommand::Rename {
                    database_id: "db_alpha".to_string(),
                    name: "Alpha renamed".to_string(),
                },
            },
        )
        .await
        .expect("database rename should succeed");
    }

    #[tokio::test]
    async fn database_list_uses_list_databases_command() {
        let client = MockClient::default();
        run_vfs_command(
            &client,
            &test_connection(),
            VfsCommand::Database {
                command: super::DatabaseCommand::List { json: false },
            },
        )
        .await
        .expect("database list should succeed");
        assert_eq!(*client.database_lists.lock().unwrap(), 1);
    }

    #[tokio::test]
    async fn database_archive_export_writes_file_and_finalizes_hash() {
        let dir = tempdir().expect("temp dir should exist");
        let output = dir.path().join("archive.sqlite");
        let client = MockClient::default();
        run_vfs_command(
            &client,
            &test_connection(),
            VfsCommand::Database {
                command: super::DatabaseCommand::ArchiveExport {
                    database_id: "alpha".to_string(),
                    output: output.clone(),
                    chunk_size: 5,
                    json: true,
                },
            },
        )
        .await
        .expect("archive export should succeed");
        assert_eq!(
            std::fs::read(&output).expect("archive file"),
            b"archive bytes"
        );
        assert_eq!(
            client.archive_chunks.lock().unwrap().as_slice(),
            &[(0, 5), (5, 5), (10, 5)]
        );
        assert_eq!(client.archive_finalized.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn database_archive_export_cleans_up_when_local_write_fails() {
        let dir = tempdir().expect("temp dir should exist");
        let tmp_output = dir.path().join(".archive.sqlite.tmp");
        std::fs::write(&tmp_output, b"partial").expect("tmp file should write");
        let client = MockClient::default();
        let mut writer = FailingWriter;

        let error = super::archive_export_chunks(
            &client,
            "alpha",
            b"archive bytes".len() as u64,
            &mut writer,
            &tmp_output,
            5,
        )
        .await
        .expect_err("local write should fail");

        assert!(error.to_string().contains("disk full"));
        assert_eq!(
            client.archive_cancelled.lock().unwrap().as_slice(),
            &["alpha".to_string()]
        );
        assert!(!tmp_output.exists());
    }

    #[tokio::test]
    async fn database_archive_restore_writes_chunks_and_finalizes() {
        let dir = tempdir().expect("temp dir should exist");
        let input = dir.path().join("archive.sqlite");
        std::fs::write(&input, b"restore bytes").expect("archive file should write");
        let client = MockClient::default();
        run_vfs_command(
            &client,
            &test_connection(),
            VfsCommand::Database {
                command: super::DatabaseCommand::ArchiveRestore {
                    database_id: "alpha".to_string(),
                    input,
                    chunk_size: 4,
                    json: true,
                },
            },
        )
        .await
        .expect("archive restore should succeed");
        let begun = client.restore_begun.lock().unwrap();
        assert_eq!(begun[0].0, "alpha");
        assert_eq!(begun[0].2, b"restore bytes".len() as u64);
        let chunks = client.restore_chunks.lock().unwrap();
        assert_eq!(chunks[0].offset, 0);
        assert_eq!(chunks[0].bytes, b"rest");
        assert_eq!(chunks[1].offset, 4);
        assert_eq!(chunks[1].bytes, b"ore ");
        assert_eq!(chunks[2].offset, 8);
        assert_eq!(chunks[2].bytes, b"byte");
        assert_eq!(chunks[3].offset, 12);
        assert_eq!(chunks[3].bytes, b"s");
        assert_eq!(client.restore_finalized.lock().unwrap()[0], "alpha");
    }

    #[tokio::test]
    async fn database_archive_restore_cancels_when_chunk_write_fails() {
        let dir = tempdir().expect("temp dir should exist");
        let input = dir.path().join("archive.sqlite");
        std::fs::write(&input, b"restore bytes").expect("archive file should write");
        let client = MockClient::default();
        *client.fail_restore_chunk.lock().unwrap() = Some(anyhow::anyhow!("chunk failed"));

        let error = run_vfs_command(
            &client,
            &test_connection(),
            VfsCommand::Database {
                command: super::DatabaseCommand::ArchiveRestore {
                    database_id: "alpha".to_string(),
                    input,
                    chunk_size: 4,
                    json: true,
                },
            },
        )
        .await
        .expect_err("chunk failure should fail restore");

        assert!(error.to_string().contains("chunk failed"));
        assert_eq!(client.restore_cancelled.lock().unwrap()[0], "alpha");
        assert!(client.restore_finalized.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn database_archive_restore_cancels_when_finalize_fails() {
        let dir = tempdir().expect("temp dir should exist");
        let input = dir.path().join("archive.sqlite");
        std::fs::write(&input, b"restore bytes").expect("archive file should write");
        let client = MockClient::default();
        *client.fail_restore_finalize.lock().unwrap() = Some(anyhow::anyhow!("finalize failed"));

        let error = run_vfs_command(
            &client,
            &test_connection(),
            VfsCommand::Database {
                command: super::DatabaseCommand::ArchiveRestore {
                    database_id: "alpha".to_string(),
                    input,
                    chunk_size: 4,
                    json: true,
                },
            },
        )
        .await
        .expect_err("finalize failure should fail restore");

        assert!(error.to_string().contains("finalize failed"));
        assert_eq!(client.restore_cancelled.lock().unwrap()[0], "alpha");
        assert_eq!(client.restore_chunks.lock().unwrap().len(), 4);
    }

    #[tokio::test]
    async fn database_archive_restore_reports_cancel_failure_with_original_error() {
        let dir = tempdir().expect("temp dir should exist");
        let input = dir.path().join("archive.sqlite");
        std::fs::write(&input, b"restore bytes").expect("archive file should write");
        let client = MockClient::default();
        *client.fail_restore_finalize.lock().unwrap() = Some(anyhow::anyhow!("finalize failed"));
        *client.fail_restore_cancel.lock().unwrap() = Some(anyhow::anyhow!("cancel failed"));

        let error = run_vfs_command(
            &client,
            &test_connection(),
            VfsCommand::Database {
                command: super::DatabaseCommand::ArchiveRestore {
                    database_id: "alpha".to_string(),
                    input,
                    chunk_size: 4,
                    json: true,
                },
            },
        )
        .await
        .expect_err("cancel failure should be reported");

        let message = error.to_string();
        assert!(message.contains("finalize failed"));
        assert!(message.contains("restore cancel failed: cancel failed"));
    }

    #[tokio::test]
    async fn database_archive_cancel_dispatches() {
        let client = MockClient::default();
        run_vfs_command(
            &client,
            &test_connection(),
            VfsCommand::Database {
                command: super::DatabaseCommand::ArchiveCancel {
                    database_id: "alpha".to_string(),
                },
            },
        )
        .await
        .expect("archive cancel should succeed");
        assert_eq!(client.archive_cancelled.lock().unwrap()[0], "alpha");
    }

    #[tokio::test]
    async fn query_sql_sends_database_sql_request() {
        let client = MockClient::default();
        run_vfs_command(
            &client,
            &test_connection(),
            VfsCommand::QuerySql {
                sql: "SELECT json_object('ok', 1) FROM fs_nodes LIMIT 1".to_string(),
                limit: 10,
                json: true,
            },
        )
        .await
        .expect("query-sql should succeed");

        assert_eq!(
            client.sql_queries.lock().unwrap().as_slice(),
            &[(
                "alpha".to_string(),
                "SELECT json_object('ok', 1) FROM fs_nodes LIMIT 1".to_string(),
                10
            )]
        );
        assert!(client.write_cycle_checks.lock().unwrap().is_empty());
    }

    #[test]
    fn sql_json_query_output_formats_rows_and_envelope() {
        let result = IndexSqlJsonQueryResult {
            rows: vec![r#"{"path":"/Knowledge/a.md"}"#.to_string()],
            row_count: 1,
            limit: 20,
        };

        assert_eq!(
            super::sql_json_query_output_lines(&result, false).expect("text output"),
            vec![r#"{"path":"/Knowledge/a.md"}"#.to_string()]
        );
        let json = super::sql_json_query_output_lines(&result, true).expect("json output");
        assert_eq!(json.len(), 1);
        assert!(json[0].contains("\"row_count\": 1"));
        assert!(json[0].contains("\"limit\": 20"));
    }

    #[tokio::test]
    async fn database_restore_cancel_dispatches() {
        let client = MockClient::default();
        run_vfs_command(
            &client,
            &test_connection(),
            VfsCommand::Database {
                command: super::DatabaseCommand::RestoreCancel {
                    database_id: "alpha".to_string(),
                },
            },
        )
        .await
        .expect("restore cancel should succeed");
        assert_eq!(client.restore_cancelled.lock().unwrap()[0], "alpha");
    }

    #[test]
    fn archive_chunk_size_is_capped() {
        assert!(super::validate_archive_chunk_size(1).is_ok());
        assert!(super::validate_archive_chunk_size(1_048_576).is_ok());
        assert!(super::validate_archive_chunk_size(0).is_err());
        assert!(super::validate_archive_chunk_size(1_048_577).is_err());
    }

    #[test]
    fn database_id_falls_back_to_env() {
        with_vfs_database_id("env-db", || {
            let database_id = super::database_id_or_env(None).expect("env database id should load");
            assert_eq!(database_id.as_ref(), "env-db");
        });
    }

    #[test]
    fn explicit_database_id_overrides_env() {
        with_vfs_database_id("env-db", || {
            let database_id =
                super::database_id_or_env(Some("flag-db")).expect("flag database id should load");
            assert_eq!(database_id.as_ref(), "flag-db");
        });
    }

    #[test]
    fn node_field_view_can_omit_content() {
        let node = vfs_types::Node {
            path: "/Knowledge/index.md".to_string(),
            kind: vfs_types::NodeKind::File,
            content: "large body".to_string(),
            created_at: 1,
            updated_at: 2,
            etag: "etag".to_string(),
            metadata_json: "{}".to_string(),
        };
        let metadata = super::node_field_view(&node, true, None).expect("metadata view");
        assert!(metadata.get("content").is_none());
        assert_eq!(metadata["path"], "/Knowledge/index.md");

        let fields =
            super::node_field_view(&node, false, Some("path,kind,etag")).expect("field view");
        assert!(fields.get("content").is_none());
        assert_eq!(
            fields.as_object().expect("fields should be object").len(),
            3
        );
    }

    fn with_vfs_database_id(value: &str, assert_fn: impl FnOnce()) {
        let _guard = ENV_LOCK.lock().expect("env lock should not be poisoned");
        let previous = std::env::var("VFS_DATABASE_ID").ok();
        unsafe {
            std::env::set_var("VFS_DATABASE_ID", value);
        }
        assert_fn();
        unsafe {
            match previous {
                Some(previous) => std::env::set_var("VFS_DATABASE_ID", previous),
                None => std::env::remove_var("VFS_DATABASE_ID"),
            }
        }
    }

    #[tokio::test]
    async fn read_node_context_sends_link_limit_request() {
        let client = MockClient::default();
        run_vfs_command(
            &client,
            &test_connection(),
            VfsCommand::ReadNodeContext {
                path: "/Knowledge/a.md".to_string(),
                link_limit: 7,
                json: true,
            },
        )
        .await
        .expect("read context should succeed");
        let contexts = client.contexts.lock().unwrap();
        assert_eq!(contexts[0].path, "/Knowledge/a.md");
        assert_eq!(contexts[0].link_limit, 7);
    }

    #[tokio::test]
    async fn graph_neighborhood_sends_depth_request() {
        let client = MockClient::default();
        run_vfs_command(
            &client,
            &test_connection(),
            VfsCommand::GraphNeighborhood {
                center_path: "/Knowledge/a.md".to_string(),
                depth: 2,
                limit: 9,
                json: true,
            },
        )
        .await
        .expect("graph neighborhood should succeed");
        let neighborhoods = client.neighborhoods.lock().unwrap();
        assert_eq!(neighborhoods[0].center_path, "/Knowledge/a.md");
        assert_eq!(neighborhoods[0].depth, 2);
        assert_eq!(neighborhoods[0].limit, 9);
    }
}
