//! Durable node snapshots and guarded, atomic learning publication.
use crate::{Node, WriteNodeItem, WriteNodeResult};
use candid::CandidType;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct NodeRevision {
    /// Database-local immutable identity. Moves retain it; recreation allocates a new one.
    pub node_id: String,
    pub revision: u64,
    pub node: Node,
    pub deleted: bool,
    pub content_hash: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct NodeRevisionRequest {
    pub database_id: String,
    pub path: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct NodeHistoryRequest {
    pub database_id: String,
    pub node_id: String,
    /// Exclusive upper bound; history is returned newest first.
    pub before_revision: Option<u64>,
    pub limit: u32,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct NodeHistoryPage {
    pub revisions: Vec<NodeRevision>,
    pub next_cursor: Option<u64>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct RevisionRef {
    pub path: String,
    pub node_id: String,
    pub revision: u64,
    pub etag: String,
    pub content_hash: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct LearningPublicationRequest {
    pub database_id: String,
    pub operation_id: String,
    pub targets: Vec<WriteNodeItem>,
    pub evidence: Vec<RevisionRef>,
    #[serde(default)]
    pub scope_guards: Vec<ScopeRevisionGuard>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct LearningPublicationResult {
    pub operation_id: String,
    pub nodes: Vec<WriteNodeResult>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct ScopeRevisionRequest {
    pub database_id: String,
    pub prefix: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct ScopeRevisionGuard {
    pub prefix: String,
    pub revision: u64,
}
