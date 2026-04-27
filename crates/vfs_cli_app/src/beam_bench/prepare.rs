// Where: crates/vfs_cli_app/src/beam_bench/prepare.rs
// What: BEAM benchmark namespace preparation that writes notes and indexes before eval.
// Why: Eval must stay read-only while prepare owns the canister mutation lifecycle.
use anyhow::Result;
use serde::Serialize;
use std::path::PathBuf;
use vfs_cli::connection::ResolvedConnection;
use vfs_client::{CanisterVfsClient, VfsApi};
use vfs_types::{NodeKind, WriteNodeRequest};
use wiki_domain::WIKI_INDEX_PATH;

use super::dataset::{BeamConversation, load_dataset};
use super::import::{ImportedConversation, import_conversation};
use super::manifest::{build_prepare_manifest, manifest_path_for_namespace};
use super::navigation::{namespace_index_path, sync_beam_indexes};

#[derive(Debug, Clone)]
pub struct BeamPrepareArgs {
    pub dataset_path: PathBuf,
    pub split: String,
    pub limit: usize,
    pub namespace: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct PrepareSummary {
    pub namespace: String,
    pub prepared_conversations: usize,
    pub written_notes: usize,
    pub namespace_index_path: String,
    pub root_index_path: String,
}

pub async fn run_beam_prepare(
    connection: ResolvedConnection,
    args: BeamPrepareArgs,
) -> Result<PrepareSummary> {
    let dataset = load_dataset(&args.dataset_path, &args.split, args.limit)?;
    let client = CanisterVfsClient::new(&connection.replica_host, &connection.canister_id).await?;
    prepare_dataset(&client, &args.namespace, &args.split, &dataset).await
}

async fn prepare_dataset(
    client: &impl VfsApi,
    namespace: &str,
    split: &str,
    dataset: &[BeamConversation],
) -> Result<PrepareSummary> {
    let mut prepared_conversations = 0usize;
    let mut written_notes = 0usize;
    let mut imported = Vec::<ImportedConversation>::with_capacity(dataset.len());

    for conversation in dataset {
        let imported_conversation = import_conversation(client, namespace, conversation).await?;
        prepared_conversations += 1;
        written_notes += imported_conversation.notes.len();
        imported.push(imported_conversation);
    }
    if !dataset.is_empty() {
        sync_beam_indexes(client, namespace).await?;
    }
    let manifest = build_prepare_manifest(namespace, split, dataset, &imported);
    write_prepare_manifest(client, &manifest).await?;

    Ok(PrepareSummary {
        namespace: namespace.to_string(),
        prepared_conversations,
        written_notes,
        namespace_index_path: namespace_index_path(namespace),
        root_index_path: WIKI_INDEX_PATH.to_string(),
    })
}

async fn write_prepare_manifest(
    client: &impl VfsApi,
    manifest: &super::manifest::PrepareManifest,
) -> Result<()> {
    let path = manifest_path_for_namespace(&manifest.namespace);
    let content = serde_json::to_string_pretty(manifest)?;
    let expected_etag = client.read_node(&path).await?.map(|node| node.etag);
    client
        .write_node(WriteNodeRequest {
            path,
            kind: NodeKind::File,
            content,
            metadata_json: "{}".to_string(),
            expected_etag,
        })
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::prepare_dataset;
    use crate::beam_bench::dataset::BeamConversation;
    use anyhow::Result;
    use async_trait::async_trait;
    use serde_json::json;
    use std::collections::BTreeMap;
    use std::sync::Mutex;
    use vfs_client::VfsApi;
    use vfs_types::{
        AppendNodeRequest, DeleteNodeRequest, DeleteNodeResult, EditNodeRequest, EditNodeResult,
        ExportSnapshotRequest, ExportSnapshotResponse, FetchUpdatesRequest, FetchUpdatesResponse,
        GlobNodeHit, GlobNodesRequest, ListNodesRequest, MkdirNodeRequest, MkdirNodeResult,
        MoveNodeRequest, MoveNodeResult, MultiEditNodeRequest, MultiEditNodeResult, Node,
        NodeEntry, NodeEntryKind, NodeKind, RecentNodeHit, RecentNodesRequest, SearchNodeHit,
        SearchNodePathsRequest, SearchNodesRequest, Status, WriteNodeRequest, WriteNodeResult,
    };

    #[derive(Default)]
    struct MockClient {
        nodes: Mutex<BTreeMap<String, String>>,
    }

    #[async_trait]
    impl VfsApi for MockClient {
        async fn status(&self) -> Result<Status> {
            unreachable!()
        }
        async fn read_node(&self, path: &str) -> Result<Option<Node>> {
            Ok(self
                .nodes
                .lock()
                .expect("nodes should lock")
                .get(path)
                .map(|content| Node {
                    path: path.to_string(),
                    kind: NodeKind::File,
                    content: content.clone(),
                    created_at: 0,
                    metadata_json: "{}".to_string(),
                    updated_at: 0,
                    etag: format!("etag-{path}"),
                }))
        }
        async fn list_nodes(&self, request: ListNodesRequest) -> Result<Vec<NodeEntry>> {
            Ok(self
                .nodes
                .lock()
                .expect("nodes should lock")
                .keys()
                .filter(|path| path.starts_with(&request.prefix))
                .map(|path| NodeEntry {
                    path: path.clone(),
                    kind: NodeEntryKind::File,
                    updated_at: 0,
                    etag: format!("etag-{path}"),
                    has_children: false,
                })
                .collect())
        }
        async fn list_children(
            &self,
            _request: vfs_types::ListChildrenRequest,
        ) -> Result<Vec<vfs_types::ChildNode>> {
            unreachable!()
        }
        async fn write_node(&self, request: WriteNodeRequest) -> Result<WriteNodeResult> {
            self.nodes
                .lock()
                .expect("nodes should lock")
                .insert(request.path.clone(), request.content.clone());
            Ok(WriteNodeResult {
                node: vfs_types::NodeMutationAck {
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

    fn sample_conversation() -> BeamConversation {
        BeamConversation {
            conversation_id: "Conv 1".to_string(),
            conversation_seed: json!({"category":"General","title":"Calendar planning"}),
            narratives: "A short planning conversation.".to_string(),
            user_profile: json!({"user_info":"Sample profile"}),
            conversation_plan: "Confirm the meeting date.".to_string(),
            user_questions: json!([{"messages":["When is the meeting?"]}]),
            chat: json!([[{"role":"user","content":"Meeting is on March 15, 2024."}]]),
            probing_questions: "{}".to_string(),
        }
    }

    #[tokio::test]
    async fn prepare_dataset_writes_notes_and_indexes() {
        let client = MockClient::default();
        let summary = prepare_dataset(&client, "Run A", "100K", &[sample_conversation()])
            .await
            .expect("prepare should succeed");

        assert_eq!(summary.prepared_conversations, 1);
        assert!(summary.written_notes >= 6);
        let nodes = client.nodes.lock().expect("nodes should lock");
        assert!(nodes.contains_key("/Wiki/run-a/index.md"));
        assert!(nodes.contains_key("/Wiki/index.md"));
        assert!(nodes.contains_key("/Wiki/run-a/conv-1/index.md"));
        assert!(nodes.contains_key("/Wiki/run-a/_beam_prepare_manifest.json"));
    }
}
