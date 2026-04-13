// Where: crates/wiki_types/src/fs.rs
// What: FS-first public types for the phase-1 node contract.
// Why: Later store/canister work needs fixed request/response shapes before behavior is replaced.
use candid::CandidType;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
#[serde(rename_all = "snake_case")]
pub enum NodeKind {
    #[serde(alias = "File")]
    File,
    #[serde(alias = "Source")]
    Source,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
#[serde(rename_all = "snake_case")]
pub enum NodeEntryKind {
    #[serde(alias = "Directory")]
    Directory,
    #[serde(alias = "File")]
    File,
    #[serde(alias = "Source")]
    Source,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct Node {
    pub path: String,
    pub kind: NodeKind,
    pub content: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub etag: String,
    pub metadata_json: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct ListNodesRequest {
    pub prefix: String,
    pub recursive: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct NodeEntry {
    pub path: String,
    pub kind: NodeEntryKind,
    pub updated_at: i64,
    pub etag: String,
    pub has_children: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct WriteNodeRequest {
    pub path: String,
    pub kind: NodeKind,
    pub content: String,
    pub metadata_json: String,
    pub expected_etag: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct NodeMutationAck {
    pub path: String,
    pub kind: NodeKind,
    pub updated_at: i64,
    pub etag: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct WriteNodeResult {
    pub node: NodeMutationAck,
    pub created: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct AppendNodeRequest {
    pub path: String,
    pub content: String,
    pub expected_etag: Option<String>,
    pub separator: Option<String>,
    pub metadata_json: Option<String>,
    pub kind: Option<NodeKind>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct EditNodeRequest {
    pub path: String,
    pub old_text: String,
    pub new_text: String,
    pub expected_etag: Option<String>,
    pub replace_all: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct EditNodeResult {
    pub node: NodeMutationAck,
    pub replacement_count: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct MkdirNodeRequest {
    pub path: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct MkdirNodeResult {
    pub path: String,
    pub created: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct MoveNodeRequest {
    pub from_path: String,
    pub to_path: String,
    pub expected_etag: Option<String>,
    pub overwrite: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct MoveNodeResult {
    pub node: NodeMutationAck,
    pub from_path: String,
    pub overwrote: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
#[serde(rename_all = "snake_case")]
pub enum GlobNodeType {
    #[serde(alias = "File")]
    File,
    #[serde(alias = "Directory")]
    Directory,
    #[serde(alias = "Any")]
    Any,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct GlobNodesRequest {
    pub pattern: String,
    pub path: Option<String>,
    pub node_type: Option<GlobNodeType>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct GlobNodeHit {
    pub path: String,
    pub kind: NodeEntryKind,
    pub has_children: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct RecentNodesRequest {
    pub limit: u32,
    pub path: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct RecentNodeHit {
    pub path: String,
    pub kind: NodeKind,
    pub updated_at: i64,
    pub etag: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct MultiEdit {
    pub old_text: String,
    pub new_text: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct MultiEditNodeRequest {
    pub path: String,
    pub edits: Vec<MultiEdit>,
    pub expected_etag: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct MultiEditNodeResult {
    pub node: NodeMutationAck,
    pub replacement_count: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct DeleteNodeRequest {
    pub path: String,
    pub expected_etag: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct DeleteNodeResult {
    pub path: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct SearchNodesRequest {
    pub query_text: String,
    pub prefix: Option<String>,
    pub top_k: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct SearchNodePathsRequest {
    pub query_text: String,
    pub prefix: Option<String>,
    pub top_k: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, CandidType)]
pub struct SearchNodeHit {
    pub path: String,
    pub kind: NodeKind,
    pub snippet: String,
    pub score: f32,
    pub match_reasons: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct ExportSnapshotRequest {
    pub prefix: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct ExportSnapshotResponse {
    pub snapshot_revision: String,
    pub nodes: Vec<Node>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct FetchUpdatesRequest {
    pub known_snapshot_revision: String,
    pub prefix: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct FetchUpdatesResponse {
    pub snapshot_revision: String,
    pub changed_nodes: Vec<Node>,
    pub removed_paths: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::{GlobNodeType, NodeEntryKind, NodeKind};
    use serde::{
        Deserialize,
        de::value::{Error, StrDeserializer},
    };

    #[test]
    fn node_kind_deserializes_uppercase_aliases() {
        let kind: NodeKind = NodeKind::deserialize(StrDeserializer::<Error>::new("File"))
            .expect("uppercase alias should decode");
        assert_eq!(kind, NodeKind::File);

        let kind: NodeKind = NodeKind::deserialize(StrDeserializer::<Error>::new("source"))
            .expect("snake_case should decode");
        assert_eq!(kind, NodeKind::Source);
    }

    #[test]
    fn entry_and_glob_kinds_deserialize_uppercase_aliases() {
        let entry: NodeEntryKind =
            NodeEntryKind::deserialize(StrDeserializer::<Error>::new("Directory"))
                .expect("uppercase alias should decode");
        assert_eq!(entry, NodeEntryKind::Directory);

        let node_type: GlobNodeType =
            GlobNodeType::deserialize(StrDeserializer::<Error>::new("Any"))
                .expect("uppercase alias should decode");
        assert_eq!(node_type, GlobNodeType::Any);
    }
}
