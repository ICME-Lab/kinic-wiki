// Where: crates/vfs_types/src/fs.rs
// What: FS-first public types for the reusable VFS node contract.
// Why: Store, runtime, client, and canister layers should share one transport model.
use candid::CandidType;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
#[serde(rename_all = "snake_case")]
pub enum DatabaseRole {
    #[serde(alias = "Owner")]
    Owner,
    #[serde(alias = "Writer")]
    Writer,
    #[serde(alias = "Reader")]
    Reader,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct DatabaseMember {
    pub database_id: String,
    pub principal: String,
    pub role: DatabaseRole,
    pub created_at_ms: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
#[serde(rename_all = "snake_case")]
pub enum DatabaseStatus {
    #[serde(alias = "Hot")]
    Hot,
    #[serde(alias = "Archiving")]
    Archiving,
    #[serde(alias = "Archived")]
    Archived,
    #[serde(alias = "Deleted")]
    Deleted,
    #[serde(alias = "Restoring")]
    Restoring,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct DatabaseInfo {
    pub database_id: String,
    pub name: String,
    pub status: DatabaseStatus,
    pub mount_id: Option<u16>,
    pub schema_version: String,
    pub logical_size_bytes: u64,
    pub snapshot_hash: Option<Vec<u8>>,
    pub archived_at_ms: Option<i64>,
    pub deleted_at_ms: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct DatabaseSummary {
    pub database_id: String,
    pub name: String,
    pub status: DatabaseStatus,
    pub role: DatabaseRole,
    pub logical_size_bytes: u64,
    pub billing_balance_e8s: Option<u64>,
    pub billing_suspended_at_ms: Option<i64>,
    pub archived_at_ms: Option<i64>,
    pub deleted_at_ms: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct BillingConfig {
    pub kinic_ledger_canister_id: String,
    pub sns_governance_id: String,
    pub rate_numerator_e8s: u64,
    pub rate_denominator_cycles: u64,
    pub fixed_update_fee_e8s: u64,
    pub min_update_balance_e8s: u64,
    pub min_initial_deposit_e8s: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct BillingConfigUpdate {
    pub rate_numerator_e8s: u64,
    pub rate_denominator_cycles: u64,
    pub fixed_update_fee_e8s: u64,
    pub min_update_balance_e8s: u64,
    pub min_initial_deposit_e8s: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct BillingAccount {
    pub owner: candid::Principal,
    pub subaccount: Option<Vec<u8>>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct BillingTransferResult {
    pub block_index: u64,
    pub balance_e8s: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct PrincipalBillingSummary {
    pub principal: String,
    pub balance_e8s: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct PrincipalBillingEntry {
    pub entry_id: u64,
    pub principal: String,
    pub kind: String,
    pub amount_e8s: i64,
    pub balance_after_e8s: u64,
    pub database_id: Option<String>,
    pub ledger_block_index: Option<u64>,
    pub created_at_ms: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct PrincipalBillingEntryPage {
    pub entries: Vec<PrincipalBillingEntry>,
    pub next_cursor: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct DatabaseBillingEntry {
    pub entry_id: u64,
    pub database_id: String,
    pub kind: String,
    pub amount_e8s: i64,
    pub balance_after_e8s: u64,
    pub caller: String,
    pub method: Option<String>,
    pub cycles_delta: Option<u64>,
    pub rate_numerator_e8s: Option<u64>,
    pub rate_denominator_cycles: Option<u64>,
    pub fixed_update_fee_e8s: Option<u64>,
    pub usage_event_id: Option<u64>,
    pub created_at_ms: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct DatabaseBillingEntryPage {
    pub entries: Vec<DatabaseBillingEntry>,
    pub next_cursor: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct CreateDatabaseRequest {
    pub name: String,
    pub initial_deposit_e8s: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct CreateDatabaseResult {
    pub database_id: String,
    pub name: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct RenameDatabaseRequest {
    pub database_id: String,
    pub name: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct DatabaseArchiveInfo {
    pub database_id: String,
    pub size_bytes: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct DatabaseArchiveChunk {
    pub bytes: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct DatabaseRestoreChunkRequest {
    pub database_id: String,
    pub offset: u64,
    pub bytes: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
#[serde(rename_all = "snake_case")]
pub enum NodeKind {
    #[serde(alias = "File")]
    File,
    #[serde(alias = "Source")]
    Source,
    #[serde(alias = "Folder")]
    Folder,
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
    #[serde(alias = "Folder")]
    Folder,
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
    pub database_id: String,
    pub prefix: String,
    pub recursive: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct ListChildrenRequest {
    pub database_id: String,
    pub path: String,
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
pub struct ChildNode {
    pub path: String,
    pub name: String,
    pub kind: NodeEntryKind,
    pub updated_at: Option<i64>,
    pub etag: Option<String>,
    pub size_bytes: Option<u64>,
    pub is_virtual: bool,
    pub has_children: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct WriteNodeRequest {
    pub database_id: String,
    pub path: String,
    pub kind: NodeKind,
    pub content: String,
    pub metadata_json: String,
    pub expected_etag: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct WriteNodeItem {
    pub path: String,
    pub kind: NodeKind,
    pub content: String,
    pub metadata_json: String,
    pub expected_etag: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct WriteNodesRequest {
    pub database_id: String,
    pub nodes: Vec<WriteNodeItem>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct UrlIngestTriggerSessionRequest {
    pub database_id: String,
    pub session_nonce: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct UrlIngestTriggerSessionCheckRequest {
    pub database_id: String,
    pub request_path: String,
    pub session_nonce: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct OpsAnswerSessionRequest {
    pub database_id: String,
    pub session_nonce: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct OpsAnswerSessionCheckRequest {
    pub database_id: String,
    pub session_nonce: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct OpsAnswerSessionCheckResult {
    pub principal: String,
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
    pub database_id: String,
    pub path: String,
    pub content: String,
    pub expected_etag: Option<String>,
    pub separator: Option<String>,
    pub metadata_json: Option<String>,
    pub kind: Option<NodeKind>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct EditNodeRequest {
    pub database_id: String,
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
    pub database_id: String,
    pub path: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct MkdirNodeResult {
    pub path: String,
    pub created: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct MoveNodeRequest {
    pub database_id: String,
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
    pub database_id: String,
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
    pub database_id: String,
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
pub struct IncomingLinksRequest {
    pub database_id: String,
    pub path: String,
    pub limit: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct OutgoingLinksRequest {
    pub database_id: String,
    pub path: String,
    pub limit: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct GraphLinksRequest {
    pub database_id: String,
    pub prefix: String,
    pub limit: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct GraphNeighborhoodRequest {
    pub database_id: String,
    pub center_path: String,
    pub depth: u32,
    pub limit: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct LinkEdge {
    pub source_path: String,
    pub target_path: String,
    pub raw_href: String,
    pub link_text: String,
    pub link_kind: String,
    pub updated_at: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct NodeContextRequest {
    pub database_id: String,
    pub path: String,
    pub link_limit: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct NodeContext {
    pub node: Node,
    pub incoming_links: Vec<LinkEdge>,
    pub outgoing_links: Vec<LinkEdge>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct MultiEdit {
    pub old_text: String,
    pub new_text: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct MultiEditNodeRequest {
    pub database_id: String,
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
    pub database_id: String,
    pub path: String,
    pub expected_etag: Option<String>,
    pub expected_folder_index_etag: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct DeleteNodeResult {
    pub path: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct SearchNodesRequest {
    pub database_id: String,
    pub query_text: String,
    pub prefix: Option<String>,
    pub top_k: u32,
    #[serde(default)]
    pub preview_mode: Option<SearchPreviewMode>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct SearchNodePathsRequest {
    pub database_id: String,
    pub query_text: String,
    pub prefix: Option<String>,
    pub top_k: u32,
    #[serde(default)]
    pub preview_mode: Option<SearchPreviewMode>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, CandidType)]
pub struct SearchNodeHit {
    pub path: String,
    pub kind: NodeKind,
    pub snippet: Option<String>,
    #[serde(default)]
    pub preview: Option<SearchPreview>,
    pub score: f32,
    pub match_reasons: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
#[serde(rename_all = "snake_case")]
pub enum SearchPreviewMode {
    #[serde(alias = "None")]
    None,
    #[serde(alias = "Light")]
    Light,
    #[serde(alias = "ContentStart")]
    ContentStart,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
#[serde(rename_all = "snake_case")]
pub enum SearchPreviewField {
    #[serde(alias = "Content")]
    Content,
    #[serde(alias = "Path")]
    Path,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct SearchPreview {
    pub field: SearchPreviewField,
    pub match_reason: String,
    pub char_offset: u32,
    pub excerpt: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct ExportSnapshotRequest {
    pub database_id: String,
    pub prefix: Option<String>,
    pub limit: u32,
    pub cursor: Option<String>,
    pub snapshot_revision: Option<String>,
    pub snapshot_session_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct ExportSnapshotResponse {
    pub snapshot_revision: String,
    pub snapshot_session_id: Option<String>,
    pub nodes: Vec<Node>,
    pub next_cursor: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct FetchUpdatesRequest {
    pub database_id: String,
    pub known_snapshot_revision: String,
    pub prefix: Option<String>,
    pub limit: u32,
    pub cursor: Option<String>,
    pub target_snapshot_revision: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct FetchUpdatesResponse {
    pub snapshot_revision: String,
    pub changed_nodes: Vec<Node>,
    pub removed_paths: Vec<String>,
    pub next_cursor: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct MemoryRoot {
    pub path: String,
    pub kind: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct MemoryCapability {
    pub name: String,
    pub description: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct CanonicalRole {
    pub name: String,
    pub path_pattern: String,
    pub purpose: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct MemoryManifest {
    pub api_version: String,
    pub purpose: String,
    pub roots: Vec<MemoryRoot>,
    pub capabilities: Vec<MemoryCapability>,
    pub canonical_roles: Vec<CanonicalRole>,
    pub write_policy: String,
    pub recommended_entrypoint: String,
    pub max_depth: u32,
    pub max_query_limit: u32,
    pub budget_unit: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct QueryContextRequest {
    pub database_id: String,
    pub task: String,
    pub entities: Vec<String>,
    pub namespace: Option<String>,
    pub budget_tokens: u32,
    pub include_evidence: bool,
    pub depth: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, CandidType)]
pub struct QueryContext {
    pub namespace: String,
    pub task: String,
    pub search_hits: Vec<SearchNodeHit>,
    pub nodes: Vec<NodeContext>,
    pub graph_links: Vec<LinkEdge>,
    pub evidence: Vec<SourceEvidence>,
    pub truncated: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct SourceEvidenceRequest {
    pub database_id: String,
    pub node_path: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct SourceEvidenceRef {
    pub source_path: String,
    pub via_path: String,
    pub raw_href: String,
    pub link_text: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct SourceEvidence {
    pub node_path: String,
    pub refs: Vec<SourceEvidenceRef>,
}
