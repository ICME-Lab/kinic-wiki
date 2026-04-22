// Where: crates/vfs_cli/src/commands.rs
// What: Generic VFS command execution and sync paging helpers.
// Why: The app-facing CLI package should delegate shared VFS command behavior instead of owning it.
use std::fs;

use anyhow::{Result, anyhow};
use vfs_client::VfsApi;
use vfs_types::{
    AppendNodeRequest, DeleteNodeRequest, EditNodeRequest, ExportSnapshotRequest,
    ExportSnapshotResponse, FetchUpdatesRequest, FetchUpdatesResponse, GlobNodesRequest,
    ListNodesRequest, MkdirNodeRequest, MoveNodeRequest, MultiEdit, MultiEditNodeRequest,
    RecentNodesRequest, SearchNodePathsRequest, SearchNodesRequest, WriteNodeRequest,
};
use wiki_domain::{WIKI_ROOT_PATH, validate_source_path_for_kind};

use crate::cli::VfsCommand;

pub const SYNC_PAGE_LIMIT: u32 = 100;
pub const SNAPSHOT_UNAVAILABLE_ERROR: &str = "known_snapshot_revision is no longer available";
pub const SNAPSHOT_INVALID_ERROR: &str = "known_snapshot_revision is invalid";
pub const SNAPSHOT_NO_LONGER_CURRENT_ERROR: &str = "snapshot_revision is no longer current";
pub const SNAPSHOT_SESSION_EXPIRED_ERROR: &str = "snapshot_session_id has expired";

pub async fn run_vfs_command(client: &impl VfsApi, command: VfsCommand) -> Result<()> {
    match command {
        VfsCommand::ReadNode { path, json } => {
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
        VfsCommand::ListNodes {
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
            let deleted_paths = delete_tree(client, &path).await?;
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
            let result = client.mkdir_node(MkdirNodeRequest { path }).await?;
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
        VfsCommand::GlobNodes {
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
        VfsCommand::RecentNodes { limit, path, json } => {
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
        VfsCommand::MultiEditNode {
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
        VfsCommand::SearchRemote {
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
        VfsCommand::SearchPathRemote {
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
    }
    Ok(())
}

pub async fn collect_paged_snapshot(client: &impl VfsApi) -> Result<ExportSnapshotResponse> {
    let mut cursor = None;
    let mut snapshot_revision = None;
    let mut snapshot_session_id = None;
    let mut nodes = Vec::new();
    loop {
        let page = client
            .export_snapshot(ExportSnapshotRequest {
                prefix: Some(WIKI_ROOT_PATH.to_string()),
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

pub async fn collect_paged_updates(
    client: &impl VfsApi,
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
                prefix: Some(WIKI_ROOT_PATH.to_string()),
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

pub fn resync_required_error(error: anyhow::Error) -> anyhow::Error {
    let message = error.to_string();
    if message.contains(SNAPSHOT_UNAVAILABLE_ERROR) || message.contains(SNAPSHOT_INVALID_ERROR) {
        anyhow!("{message}; run pull --resync")
    } else {
        error
    }
}

pub fn snapshot_restart_required_error(error: anyhow::Error) -> anyhow::Error {
    let message = error.to_string();
    if message.contains(SNAPSHOT_NO_LONGER_CURRENT_ERROR)
        || message.contains(SNAPSHOT_SESSION_EXPIRED_ERROR)
    {
        anyhow!("{message}; rerun pull")
    } else {
        error
    }
}

async fn delete_tree(client: &impl VfsApi, path: &str) -> Result<Vec<String>> {
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
    use anyhow::Result;
    use async_trait::async_trait;
    use std::path::PathBuf;
    use std::sync::Mutex;
    use tempfile::tempdir;
    use vfs_client::VfsApi;
    use vfs_types::*;

    #[derive(Default)]
    struct MockClient {
        writes: Mutex<Vec<WriteNodeRequest>>,
    }

    #[async_trait]
    impl VfsApi for MockClient {
        async fn status(&self) -> Result<Status> {
            unreachable!()
        }
        async fn read_node(&self, _path: &str) -> Result<Option<Node>> {
            Ok(None)
        }
        async fn list_nodes(&self, _request: ListNodesRequest) -> Result<Vec<NodeEntry>> {
            Ok(Vec::new())
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
}
