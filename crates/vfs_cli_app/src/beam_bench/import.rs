// Where: crates/wiki_cli/src/beam_bench/import.rs
// What: Write BEAM conversation pages and their structured wiki notes to the canister.
// Why: The harness needs a stable import boundary while note rendering stays in a dedicated module.
use anyhow::Result;
use serde::Serialize;
use vfs_client::VfsApi;
use vfs_types::{NodeKind, WriteNodeRequest};

use super::dataset::BeamConversation;
use super::navigation::{
    conversation_base_path, namespace_base_path, namespace_index_path, raw_source_path,
};
use super::notes::build_documents;

#[derive(Debug, Clone, Serialize)]
pub struct ImportedConversation {
    pub conversation_id: String,
    pub namespace_path: String,
    pub namespace_index_path: String,
    pub base_path: String,
    pub note_paths: Vec<String>,
    pub notes: Vec<ImportedNote>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ImportedNote {
    pub path: String,
    pub content: String,
    pub note_type: String,
}

pub fn plan_imported_conversation(
    namespace: &str,
    conversation: &BeamConversation,
) -> ImportedConversation {
    let namespace_path = namespace_base_path(namespace);
    let namespace_index_path = namespace_index_path(namespace);
    let base_path = conversation_base_path(namespace, &conversation.conversation_id);
    let documents = build_documents(
        conversation,
        &base_path,
        &raw_source_path(namespace, &conversation.conversation_id),
    );
    let mut note_paths = Vec::with_capacity(documents.len());
    let mut notes = Vec::with_capacity(documents.len());
    for (path, content) in documents {
        let note_type = note_type_for_path(&path, &base_path);
        note_paths.push(path.clone());
        notes.push(ImportedNote {
            path,
            content,
            note_type,
        });
    }
    ImportedConversation {
        conversation_id: conversation.conversation_id.clone(),
        namespace_path,
        namespace_index_path,
        base_path,
        note_paths,
        notes,
    }
}

pub async fn import_conversation(
    client: &impl VfsApi,
    namespace: &str,
    conversation: &BeamConversation,
) -> Result<ImportedConversation> {
    let imported = plan_imported_conversation(namespace, conversation);
    for note in &imported.notes {
        let expected_etag = client.read_node(&note.path).await?.map(|node| node.etag);
        client
            .write_node(WriteNodeRequest {
                path: note.path.clone(),
                kind: NodeKind::File,
                content: note.content.clone(),
                metadata_json: "{}".to_string(),
                expected_etag,
            })
            .await?;
    }
    Ok(imported)
}

fn note_type_for_path(path: &str, base_path: &str) -> String {
    let relative = path
        .strip_prefix(base_path)
        .unwrap_or(path)
        .trim_start_matches('/');
    relative
        .split('/')
        .next()
        .filter(|segment| !segment.is_empty())
        .unwrap_or("root")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::{import_conversation, plan_imported_conversation};
    use crate::beam_bench::dataset::BeamConversation;
    use anyhow::Result;
    use async_trait::async_trait;
    use serde_json::json;
    use std::sync::Mutex;
    use vfs_client::VfsApi;
    use vfs_types::{
        AppendNodeRequest, DeleteNodeRequest, DeleteNodeResult, EditNodeRequest, EditNodeResult,
        ExportSnapshotRequest, ExportSnapshotResponse, FetchUpdatesRequest, FetchUpdatesResponse,
        GlobNodeHit, GlobNodesRequest, ListNodesRequest, MkdirNodeRequest, MkdirNodeResult,
        MoveNodeRequest, MoveNodeResult, MultiEditNodeRequest, MultiEditNodeResult, Node,
        NodeEntry, RecentNodeHit, RecentNodesRequest, SearchNodeHit, SearchNodePathsRequest,
        SearchNodesRequest, Status, WriteNodeRequest, WriteNodeResult,
    };

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
            unreachable!()
        }
        async fn write_node(&self, request: WriteNodeRequest) -> Result<WriteNodeResult> {
            self.writes
                .lock()
                .expect("writes should lock")
                .push(request.clone());
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
    async fn import_conversation_uses_namespace_in_base_path() {
        let client = MockClient::default();

        let imported = import_conversation(&client, "Run A", &sample_conversation())
            .await
            .expect("conversation should import");

        assert_eq!(imported.namespace_path, "/Wiki/run-a");
        assert_eq!(imported.namespace_index_path, "/Wiki/run-a/index.md");
        assert_eq!(imported.base_path, "/Wiki/run-a/conv-1");
        assert!(
            imported
                .note_paths
                .iter()
                .any(|path| { path.starts_with("/Sources/raw/run-a-conv-1/") })
        );
        assert!(
            imported
                .note_paths
                .iter()
                .filter(|path| !path.starts_with("/Sources/raw/"))
                .all(|path| { path.starts_with("/Wiki/run-a/conv-1/") })
        );
        let writes = client.writes.lock().expect("writes should lock");
        assert_eq!(writes.len(), imported.note_paths.len());
        assert!(
            writes
                .iter()
                .any(|request| { request.path.starts_with("/Sources/raw/run-a-conv-1/") })
        );
        assert!(
            writes
                .iter()
                .filter(|request| !request.path.starts_with("/Sources/raw/"))
                .all(|request| { request.path.starts_with("/Wiki/run-a/conv-1/") })
        );
    }

    #[test]
    fn planning_conversation_keeps_note_metadata_without_writes() {
        let imported = plan_imported_conversation("Run A", &sample_conversation());

        assert_eq!(imported.namespace_path, "/Wiki/run-a");
        assert_eq!(imported.namespace_index_path, "/Wiki/run-a/index.md");
        assert_eq!(imported.base_path, "/Wiki/run-a/conv-1");
        assert_eq!(imported.note_paths.len(), imported.notes.len());
        assert!(
            imported
                .notes
                .iter()
                .any(|note| note.path.starts_with("/Sources/raw/run-a-conv-1/"))
        );
        assert!(
            imported
                .notes
                .iter()
                .filter(|note| !note.path.starts_with("/Sources/raw/"))
                .all(|note| note.path.starts_with("/Wiki/run-a/conv-1/"))
        );
    }
}
