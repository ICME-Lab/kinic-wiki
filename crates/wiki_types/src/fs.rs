// Where: crates/wiki_types/src/fs.rs
// What: FS-first public types for the phase-1 node contract.
// Why: Later store/canister work needs fixed request/response shapes before behavior is replaced.
use candid::CandidType;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
#[serde(rename_all = "snake_case")]
pub enum NodeKind {
    File,
    Source,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
#[serde(rename_all = "snake_case")]
pub enum NodeEntryKind {
    Directory,
    File,
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
    pub deleted_at: Option<i64>,
    pub metadata_json: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct ListNodesRequest {
    pub prefix: String,
    pub recursive: bool,
    pub include_deleted: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct NodeEntry {
    pub path: String,
    pub kind: NodeEntryKind,
    pub updated_at: i64,
    pub etag: String,
    pub deleted_at: Option<i64>,
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
pub struct WriteNodeResult {
    pub node: Node,
    pub created: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct DeleteNodeRequest {
    pub path: String,
    pub expected_etag: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct DeleteNodeResult {
    pub path: String,
    pub etag: String,
    pub deleted_at: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct SearchNodesRequest {
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
    pub include_deleted: bool,
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
    pub include_deleted: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct FetchUpdatesResponse {
    pub snapshot_revision: String,
    pub changed_nodes: Vec<Node>,
    pub removed_paths: Vec<String>,
}
