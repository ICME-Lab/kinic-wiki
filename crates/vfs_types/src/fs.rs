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
    #[serde(alias = "Active")]
    Active,
    #[serde(alias = "Pending")]
    Pending,
    #[serde(alias = "Restoring")]
    Restoring,
    #[serde(alias = "Archiving")]
    Archiving,
    #[serde(alias = "Archived")]
    Archived,
    #[serde(alias = "Deleted")]
    Deleted,
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
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct DatabaseSummary {
    pub database_id: String,
    pub name: String,
    pub status: DatabaseStatus,
    pub role: DatabaseRole,
    pub logical_size_bytes: u64,
    pub cycles_balance: Option<u64>,
    pub cycles_suspended_at_ms: Option<i64>,
    pub archived_at_ms: Option<i64>,
    pub deleted_at_ms: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct CyclesBillingConfig {
    pub kinic_ledger_canister_id: String,
    pub billing_authority_id: String,
    pub cycles_per_kinic: u64,
    pub min_update_cycles: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct CyclesBillingConfigUpdate {
    pub cycles_per_kinic: u64,
    pub min_update_cycles: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct DatabaseCyclesPurchaseRequest {
    pub database_id: String,
    pub payment_amount_e8s: u64,
    pub min_expected_cycles: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct CyclesPurchaseResult {
    pub block_index: u64,
    pub amount_cycles: u64,
    pub balance_cycles: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct DatabaseCycleEntry {
    pub entry_id: u64,
    pub database_id: String,
    pub kind: String,
    pub amount_cycles: i64,
    pub balance_after_cycles: u64,
    pub payment_amount_e8s: Option<u64>,
    pub caller: String,
    pub method: Option<String>,
    pub cycles_delta: Option<u64>,
    pub cycles_per_kinic: Option<u64>,
    pub ledger_block_index: Option<u64>,
    pub created_at_ms: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct DatabaseCycleEntryPage {
    pub entries: Vec<DatabaseCycleEntry>,
    pub next_cursor: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct DatabaseCyclesPendingPurchase {
    pub operation_id: u64,
    pub database_id: String,
    pub status: String,
    pub amount_cycles: u64,
    pub payment_amount_e8s: u64,
    pub ledger_block_index: Option<u64>,
    pub created_at_ms: i64,
    pub required_action: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct KinicBalance {
    pub balance_e8s: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct KinicPendingOperation {
    pub operation_id: u64,
    pub kind: String,
    pub caller: String,
    pub status: String,
    pub amount_e8s: u64,
    pub ledger_block_index: Option<u64>,
    pub created_at_ms: i64,
    pub required_action: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct KinicPendingOperationsPageRequest {
    pub cursor_operation_id: Option<u64>,
    pub limit: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct KinicPendingOperationsPage {
    pub operations: Vec<KinicPendingOperation>,
    pub next_cursor_operation_id: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct KinicDepositRequest {
    pub amount_e8s: u64,
    pub expected_fee_e8s: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct KinicDepositResult {
    pub block_index: u64,
    pub amount_e8s: u64,
    pub balance_e8s: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct KinicWithdrawRequest {
    pub amount_e8s: u64,
    pub expected_fee_e8s: u64,
    pub to_owner: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct KinicWithdrawResult {
    pub block_index: u64,
    pub amount_e8s: u64,
    pub fee_e8s: u64,
    pub balance_e8s: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct KinicFundDatabaseCyclesRequest {
    pub database_id: String,
    pub payment_amount_e8s: u64,
    pub min_expected_cycles: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct KinicFundDatabaseCyclesResult {
    pub payment_amount_e8s: u64,
    pub amount_cycles: u64,
    pub database_balance_cycles: u64,
    pub kinic_balance_e8s: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
#[serde(rename_all = "snake_case")]
pub enum MarketListingStatus {
    #[serde(alias = "Active")]
    Active,
    #[serde(alias = "Paused")]
    Paused,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct MarketListing {
    pub listing_id: String,
    pub seller_principal: String,
    pub database_id: String,
    pub title: String,
    pub description: String,
    pub llm_summary: Option<String>,
    pub tags_json: String,
    pub price_e8s: u64,
    pub status: MarketListingStatus,
    pub revision: u64,
    pub purchase_count: u64,
    pub report_count: u64,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct MarketListingVerifiedStats {
    pub total_nodes: u64,
    pub wiki_nodes: u64,
    pub source_nodes: u64,
    pub folder_nodes: u64,
    pub markdown_chars: u64,
    pub source_chars: u64,
    pub link_edges: u64,
    pub logical_size_bytes: u64,
    pub last_content_updated_at_ms: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct MarketPreviewExcerpt {
    pub path: String,
    pub etag: String,
    pub excerpt: String,
    pub content_chars: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct MarketCategoryGraphNode {
    pub category: String,
    pub node_count: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct MarketCategoryGraphEdge {
    pub source_category: String,
    pub target_category: String,
    pub link_count: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct MarketCategoryGraph {
    pub nodes: Vec<MarketCategoryGraphNode>,
    pub edges: Vec<MarketCategoryGraphEdge>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct MarketListingPreview {
    pub top_level_paths: Vec<String>,
    pub excerpts: Vec<MarketPreviewExcerpt>,
    pub category_graph: MarketCategoryGraph,
    pub graph_links: Vec<LinkEdge>,
    pub preview_stale: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct MarketListingDetail {
    pub listing: MarketListing,
    pub verified_stats: MarketListingVerifiedStats,
    pub preview: MarketListingPreview,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct MarketListingPage {
    pub listings: Vec<MarketListing>,
    pub next_cursor: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct MarketCreateListingRequest {
    pub database_id: String,
    pub title: String,
    pub description: String,
    pub llm_summary: Option<String>,
    pub tags_json: String,
    pub price_e8s: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct MarketUpdateListingRequest {
    pub listing_id: String,
    pub expected_revision: u64,
    pub title: String,
    pub description: String,
    pub llm_summary: Option<String>,
    pub tags_json: String,
    pub price_e8s: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct MarketPurchaseRequest {
    pub listing_id: String,
    pub price_e8s: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct MarketPurchasePreview {
    pub listing_id: String,
    pub database_id: String,
    pub price_e8s: u64,
    pub buyer_balance_e8s: u64,
    pub already_entitled: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct MarketOrder {
    pub order_id: String,
    pub listing_id: String,
    pub database_id: String,
    pub buyer_principal: String,
    pub seller_principal: String,
    pub price_e8s: u64,
    pub created_at_ms: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct MarketOrderPage {
    pub orders: Vec<MarketOrder>,
    pub next_cursor: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct MarketEntitlement {
    pub database_id: String,
    pub buyer_principal: String,
    pub listing_id: String,
    pub order_id: String,
    pub purchased_at_ms: i64,
    pub status: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct MarketEntitlementPage {
    pub entitlements: Vec<MarketEntitlement>,
    pub next_cursor: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct StorageBillingBatchRequest {
    pub cursor_mount_id: Option<u16>,
    pub limit: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct StorageBillingBatchResult {
    pub processed_databases: u32,
    pub charged_databases: u32,
    pub suspended_databases: u32,
    pub paid_cycles: u64,
    pub next_cursor_mount_id: Option<u16>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct IndexSqlJsonQueryResult {
    pub rows: Vec<String>,
    pub row_count: u32,
    pub limit: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct CreateDatabaseRequest {
    pub name: String,
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
pub struct DeleteDatabaseRequest {
    pub database_id: String,
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
pub struct WriteSourceForGenerationRequest {
    pub database_id: String,
    pub path: String,
    pub content: String,
    pub metadata_json: String,
    pub expected_etag: Option<String>,
    pub session_nonce: String,
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
pub struct SourceRunSessionCheckRequest {
    pub database_id: String,
    pub source_path: String,
    pub source_etag: String,
    pub session_nonce: String,
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
pub struct WriteSourceForGenerationResult {
    pub write: WriteNodeResult,
    pub session_nonce: String,
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
