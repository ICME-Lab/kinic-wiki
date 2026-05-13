// Where: crates/vfs_cli_core/src/commands.rs
// What: Generic VFS command execution helpers.
// Why: The app-facing CLI package should delegate shared VFS command behavior instead of owning it.
use std::borrow::Cow;
use std::fs;

use anyhow::{Result, anyhow};
use candid::Principal;
use vfs_client::VfsApi;
use vfs_types::{
    AppendNodeRequest, BillingAccount, DeleteNodeRequest, EditNodeRequest, GlobNodesRequest,
    GraphLinksRequest, GraphNeighborhoodRequest, IncomingLinksRequest, LinkEdge,
    ListChildrenRequest, ListNodesRequest, MkdirNodeRequest, MoveNodeRequest, MultiEdit,
    MultiEditNodeRequest, NodeContextRequest, OutgoingLinksRequest, RecentNodesRequest,
    SearchNodePathsRequest, SearchNodesRequest, WriteNodeRequest,
};
use wiki_domain::validate_source_path_for_kind;

use crate::cli::{DatabaseCommand, VfsCommand};
use crate::connection::{
    ResolvedConnection, ResolvedConnectionPreview, link_workspace_database,
    unlink_workspace_database, workspace_config_path,
};

pub async fn run_vfs_command(
    client: &impl VfsApi,
    connection: &ResolvedConnection,
    command: VfsCommand,
) -> Result<()> {
    if let VfsCommand::Database { command } = command {
        run_database_command(client, connection, command).await?;
        return Ok(());
    }
    let database_id = connection.database_id.as_deref();
    let database_id = require_database_id(database_id)?;
    match command {
        VfsCommand::Database { .. } => {
            unreachable!("database command handled before db requirement")
        }
        VfsCommand::ReadNode { path, json } => {
            let node = client
                .read_node(database_id, &path)
                .await?
                .ok_or_else(|| anyhow!("node not found: {path}"))?;
            if json {
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
            json,
        } => {
            let result = client
                .delete_node(DeleteNodeRequest {
                    database_id: database_id.to_string(),
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
        VfsCommand::RecentNodes { limit, path, json } => {
            let hits = client
                .recent_nodes(RecentNodesRequest {
                    database_id: database_id.to_string(),
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
    }
    Ok(())
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

async fn run_database_command(
    client: &impl VfsApi,
    connection: &ResolvedConnection,
    command: DatabaseCommand,
) -> Result<()> {
    match command {
        DatabaseCommand::Create {
            display_name,
            initial_deposit_e8s,
        } => {
            let database_id = client
                .create_database(&display_name, initial_deposit_e8s)
                .await?;
            println!("{database_id}");
        }
        DatabaseCommand::List { json } => {
            let databases = client.list_databases().await?;
            if json {
                println!("{}", serde_json::to_string_pretty(&databases)?);
            } else {
                for database in databases {
                    println!(
                        "{}\t{}\t{:?}\t{:?}\t{}\t{}",
                        database.database_id,
                        database.display_name,
                        database.role,
                        database.status,
                        database.logical_size_bytes,
                        database.billing_balance_e8s
                    );
                }
            }
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
        DatabaseCommand::Rename {
            database_id,
            display_name,
        } => {
            client.rename_database(&database_id, &display_name).await?;
            println!("{database_id}\t{display_name}");
        }
        DatabaseCommand::TopUpPrincipal { amount_e8s } => {
            let result = client.top_up_principal_balance(amount_e8s).await?;
            println!("{}\t{}", result.block_index, result.balance_e8s);
        }
        DatabaseCommand::WithdrawPrincipal {
            amount_e8s,
            to_principal,
        } => {
            let owner = Principal::from_text(&to_principal)?;
            let result = client
                .withdraw_principal_balance(
                    amount_e8s,
                    BillingAccount {
                        owner,
                        subaccount: None,
                    },
                )
                .await?;
            println!("{}\t{}", result.block_index, result.balance_e8s);
        }
        DatabaseCommand::PrincipalBilling { json } => {
            let summary = client.principal_billing_summary().await?;
            if json {
                println!("{}", serde_json::to_string_pretty(&summary)?);
            } else {
                println!("{}\t{}", summary.principal, summary.balance_e8s);
            }
        }
        DatabaseCommand::TopUp {
            database_id,
            amount_e8s,
        } => {
            client.top_up_database(&database_id, amount_e8s).await?;
            println!("{database_id}\t{amount_e8s}");
        }
        DatabaseCommand::Withdraw {
            database_id,
            amount_e8s,
        } => {
            client
                .withdraw_database_balance(&database_id, amount_e8s)
                .await?;
            println!("{database_id}\t{amount_e8s}");
        }
        DatabaseCommand::BillingEntries {
            database_id,
            json,
            cursor,
            limit,
        } => {
            let page = client
                .list_database_billing_entries(&database_id, cursor, limit)
                .await?;
            if json {
                println!("{}", serde_json::to_string_pretty(&page)?);
            } else {
                for entry in page.entries {
                    println!(
                        "{}\t{}\t{}\t{}",
                        entry.entry_id, entry.kind, entry.amount_e8s, entry.balance_after_e8s
                    );
                }
            }
        }
        DatabaseCommand::BillingConfig { json } => {
            let config = client.get_billing_config().await?;
            if json {
                println!("{}", serde_json::to_string_pretty(&config)?);
            } else {
                println!(
                    "{}\t{}/{}\t{}\t{}\t{}",
                    config.kinic_ledger_canister_id,
                    config.rate_numerator_e8s,
                    config.rate_denominator_cycles,
                    config.fixed_update_fee_e8s,
                    config.min_update_balance_e8s,
                    config.min_initial_deposit_e8s
                );
            }
        }
    }
    Ok(())
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
        let result = client
            .delete_node(DeleteNodeRequest {
                database_id: database_id.to_string(),
                path: entry.path,
                expected_etag: Some(entry.etag),
            })
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

#[cfg(test)]
mod tests {
    use super::run_vfs_command;
    use crate::cli::{NodeKindArg, VfsCommand};
    use crate::connection::ResolvedConnection;
    use anyhow::Result;
    use async_trait::async_trait;
    use std::path::PathBuf;
    use std::sync::Mutex;
    use tempfile::tempdir;
    use vfs_client::VfsApi;
    use vfs_types::*;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    #[derive(Default)]
    struct MockClient {
        created: Mutex<u32>,
        database_lists: Mutex<u32>,
        writes: Mutex<Vec<WriteNodeRequest>>,
        child_lists: Mutex<Vec<ListChildrenRequest>>,
        contexts: Mutex<Vec<NodeContextRequest>>,
        neighborhoods: Mutex<Vec<GraphNeighborhoodRequest>>,
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

    #[async_trait]
    impl VfsApi for MockClient {
        async fn status(&self, _database_id: &str) -> Result<Status> {
            unreachable!()
        }
        async fn create_database(
            &self,
            _display_name: &str,
            _initial_deposit_e8s: u64,
        ) -> Result<String> {
            let mut created = self.created.lock().unwrap();
            *created += 1;
            Ok("db_k7p9x2mq4v8r".to_string())
        }
        async fn list_databases(&self) -> Result<Vec<DatabaseSummary>> {
            let mut lists = self.database_lists.lock().unwrap();
            *lists += 1;
            Ok(vec![DatabaseSummary {
                database_id: "alpha".to_string(),
                display_name: "Alpha".to_string(),
                status: DatabaseStatus::Hot,
                role: DatabaseRole::Owner,
                logical_size_bytes: 42,
                billing_balance_e8s: 100,
                billing_suspended_at_ms: None,
                archived_at_ms: None,
                deleted_at_ms: None,
            }])
        }
        async fn read_node(&self, _database_id: &str, _path: &str) -> Result<Option<Node>> {
            Ok(None)
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
            Ok(Vec::new())
        }
        async fn list_children(&self, request: ListChildrenRequest) -> Result<Vec<ChildNode>> {
            self.child_lists.lock().unwrap().push(request);
            Ok(vec![ChildNode {
                path: "/Wiki/alpha.md".to_string(),
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
        async fn append_node(&self, _request: AppendNodeRequest) -> Result<WriteNodeResult> {
            unreachable!()
        }
        async fn edit_node(&self, _request: EditNodeRequest) -> Result<EditNodeResult> {
            unreachable!()
        }
        async fn delete_node(&self, _request: DeleteNodeRequest) -> Result<DeleteNodeResult> {
            unreachable!()
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
        async fn recent_nodes(&self, _request: RecentNodesRequest) -> Result<Vec<RecentNodeHit>> {
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
                path: "/Sources/raw/source/source.md".to_string(),
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
    async fn list_children_sends_path_request() {
        let client = MockClient::default();
        run_vfs_command(
            &client,
            &test_connection(),
            VfsCommand::ListChildren {
                path: "/Wiki".to_string(),
                json: true,
            },
        )
        .await
        .expect("list children should succeed");
        assert_eq!(client.child_lists.lock().unwrap()[0].path, "/Wiki");
    }

    #[tokio::test]
    async fn database_create_uses_generated_id_command() {
        let client = MockClient::default();
        run_vfs_command(
            &client,
            &test_connection(),
            VfsCommand::Database {
                command: super::DatabaseCommand::Create {
                    display_name: "Alpha".to_string(),
                    initial_deposit_e8s: 1_000_000,
                },
            },
        )
        .await
        .expect("database create should succeed");
        assert_eq!(*client.created.lock().unwrap(), 1);
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
                path: "/Wiki/a.md".to_string(),
                link_limit: 7,
                json: true,
            },
        )
        .await
        .expect("read context should succeed");
        let contexts = client.contexts.lock().unwrap();
        assert_eq!(contexts[0].path, "/Wiki/a.md");
        assert_eq!(contexts[0].link_limit, 7);
    }

    #[tokio::test]
    async fn graph_neighborhood_sends_depth_request() {
        let client = MockClient::default();
        run_vfs_command(
            &client,
            &test_connection(),
            VfsCommand::GraphNeighborhood {
                center_path: "/Wiki/a.md".to_string(),
                depth: 2,
                limit: 9,
                json: true,
            },
        )
        .await
        .expect("graph neighborhood should succeed");
        let neighborhoods = client.neighborhoods.lock().unwrap();
        assert_eq!(neighborhoods[0].center_path, "/Wiki/a.md");
        assert_eq!(neighborhoods[0].depth, 2);
        assert_eq!(neighborhoods[0].limit, 9);
    }
}
