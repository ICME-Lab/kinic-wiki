import { Actor, HttpAgent, type Identity } from "@icp-sdk/core/agent";
import { Principal } from "@icp-sdk/core/principal";
import { classifyApiError, classifyCanisterError, invalidCanisterIdError } from "@/lib/api-errors";
import { sortChildNodes } from "@/lib/child-sort";
import { normalizeSearchHit, type RawSearchHit } from "@/lib/search-normalizer";
import type { SearchPreviewMode } from "@/lib/search-options";
import { idlFactory } from "@/lib/vfs-idl";
import type {
  CanisterHealth,
  CyclesBillingConfig,
  ChildNode,
  DatabaseCycleEntry,
  DatabaseCycleEntryPage,
  DatabaseCyclesPendingPurchase,
  DatabaseMetadata,
  DeleteDatabaseRequest,
  DeleteNodeRequest,
  DeleteNodeResult,
  DatabaseMember,
  DatabaseRole,
  DatabaseStatus,
  DatabaseSummary,
  InitialFreeDatabaseGrantStatus,
  IndexSqlJsonQueryResult,
  LinkEdge,
  MarketCreateListingRequest,
  MarketEntitlementPage,
  MarketListing,
  MarketListingDetail,
  MarketListingPage,
  MarketListingStatus,
  MarketOrder,
  MarketOrderPage,
  MarketPurchasePreview,
  MarketUpdateListingRequest,
  UpdateDatabaseMetadataRequest,
  MkdirNodeRequest,
  MkdirNodeResult,
  MoveNodeRequest,
  MoveNodeResult,
  NodeContext,
  NodeEntryKind,
  NodeKind,
  QueryContext,
  QueryAnswerSessionCheckRequest,
  QueryAnswerSessionCheckResult,
  QueryAnswerSessionRequest,
  RecentNode,
  SearchNodeHit,
  SourceEvidence,
  SourceRunSessionCheckRequest,
  SourceCaptureTriggerSessionCheckRequest,
  SourceCaptureTriggerSessionRequest,
  WikiMetrics,
  WikiMetricsPoint,
  WikiNode,
  WriteNodeRequest,
  WriteNodeResult,
  WriteSourceForGenerationRequest,
  WriteSourceForGenerationResult
} from "@/lib/types";
import { ApiError } from "@/lib/wiki-helpers";

export type Variant = Record<string, null>;

export type RawNode = {
  path: string;
  kind: Variant;
  content: string;
  created_at: bigint;
  updated_at: bigint;
  etag: string;
  metadata_json: string;
};

export type RawCanisterHealth = {
  cycles_balance: bigint;
};

export type RawCyclesBillingConfig = {
  kinic_ledger_canister_id: string;
  billing_authority_id: string;
  cycles_per_kinic: bigint;
  min_update_cycles: bigint;
  top_up: {
    enabled: boolean;
    launcher_principal: string;
    threshold_cycles: bigint;
  };
};

export type DatabaseCyclesPurchaseRequest = {
  database_id: string;
  payment_amount_e8s: bigint;
  min_expected_cycles: bigint;
};

export type RawInitialFreeDatabaseGrantStatus = {
  available: boolean;
  grant_cycles: bigint;
  database_id: [] | [string];
  created_at_ms: [] | [bigint];
};

export type RawDatabaseSummary = {
  status: Variant;
  role: Variant;
  logical_size_bytes: bigint;
  database_id: string;
  name: string;
  metadata: [] | [RawDatabaseMetadata];
  cycles_balance: [] | [bigint];
  cycles_suspended_at_ms: [] | [bigint];
  deleted_at_ms: [] | [bigint];
};

export type RawDatabaseMetadata = {
  name: string;
  description: string;
  llm_summary: [] | [string];
  tags_json: string;
};

export type RawDatabaseCycleEntry = {
  method: [] | [string];
  cycles_per_kinic: [] | [bigint];
  payment_amount_e8s: [] | [bigint];
  kind: string;
  created_at_ms: bigint;
  amount_cycles: bigint;
  ledger_block_index: [] | [bigint];
  database_id: string;
  balance_after_cycles: bigint;
  caller: string;
  cycles_delta: [] | [bigint];
  entry_id: bigint;
};

export type RawDatabaseCycleEntryPage = {
  entries: RawDatabaseCycleEntry[];
  next_cursor: [] | [bigint];
};

export type RawIndexSqlJsonQueryResult = {
  rows: string[];
  row_count: number;
  limit: number;
};

export type RawWikiMetrics = {
  users_total: bigint;
  users_active_30d: bigint;
  users_new_30d: bigint;
  databases_total: bigint;
  databases_active_30d: bigint;
  databases_new_30d: bigint;
  paid_users_total: bigint;
  charged_kinic_total_e8s: bigint;
  charged_kinic_30d_e8s: bigint;
  last_activity_at_ms: [] | [bigint];
};

export type RawWikiMetricsPoint = {
  bucket_start_ms: bigint;
  metrics: RawWikiMetrics;
};

export type RawDatabaseCyclesPendingPurchase = {
  operation_id: bigint;
  database_id: string;
  status: string;
  amount_cycles: bigint;
  payment_amount_e8s: bigint;
  ledger_block_index: [] | [bigint];
  created_at_ms: bigint;
  required_action: string;
};

export type RawMarketListingStatus = Variant;

export type RawMarketListing = {
  listing_id: string;
  seller_principal: string;
  payout_principal: string;
  database_id: string;
  price_e8s: bigint;
  status: RawMarketListingStatus;
  revision: bigint;
  purchase_count: bigint;
  report_count: bigint;
  created_at_ms: bigint;
  updated_at_ms: bigint;
};

export type RawMarketListingView = {
  listing: RawMarketListing;
  database_metadata: RawDatabaseMetadata;
};

export type RawMarketListingVerifiedStats = {
  total_nodes: bigint;
  wiki_nodes: bigint;
  source_nodes: bigint;
  folder_nodes: bigint;
  markdown_chars: bigint;
  source_chars: bigint;
  link_edges: bigint;
  logical_size_bytes: bigint;
  last_content_updated_at_ms: [] | [bigint];
};

export type RawMarketPreviewExcerpt = {
  path: string;
  etag: string;
  excerpt: string;
  content_chars: bigint;
};

export type RawMarketCategoryGraphNode = {
  category: string;
  node_count: bigint;
};

export type RawMarketCategoryGraphEdge = {
  source_category: string;
  target_category: string;
  link_count: bigint;
};

export type RawMarketCategoryGraph = {
  nodes: RawMarketCategoryGraphNode[];
  edges: RawMarketCategoryGraphEdge[];
};

export type RawMarketListingPreview = {
  top_level_paths: string[];
  excerpts: RawMarketPreviewExcerpt[];
  category_graph: RawMarketCategoryGraph;
  graph_links: RawLinkEdge[];
  preview_stale: boolean;
};

export type RawMarketListingDetail = {
  listing: RawMarketListingView;
  verified_stats: RawMarketListingVerifiedStats;
  preview: RawMarketListingPreview;
};

export type RawMarketListingPage = {
  listings: RawMarketListingView[];
  next_cursor: [] | [string];
};

export type RawMarketCreateListingRequest = {
  database_id: string;
  payout_principal: string;
  price_e8s: bigint;
};

export type RawMarketUpdateListingRequest = Omit<RawMarketCreateListingRequest, "database_id"> & {
  listing_id: string;
  expected_revision: bigint;
};

export type RawMarketPurchasePreview = {
  listing_id: string;
  database_id: string;
  price_e8s: bigint;
  already_entitled: boolean;
};

export type RawMarketPurchaseRequest = {
  listing_id: string;
  price_e8s: bigint;
  access_principal: string;
};

export type RawMarketOrder = {
  order_id: string;
  listing_id: string;
  database_id: string;
  buyer_principal: string;
  seller_principal: string;
  payout_principal: string;
  price_e8s: bigint;
  ledger_block_index: bigint;
  created_at_ms: bigint;
};

export type RawMarketOrderPage = {
  orders: RawMarketOrder[];
  next_cursor: [] | [string];
};

export type RawMarketEntitlement = {
  database_id: string;
  buyer_principal: string;
  listing_id: string;
  order_id: string;
  purchased_at_ms: bigint;
  status: string;
};

export type RawMarketEntitlementPage = {
  entitlements: RawMarketEntitlement[];
  next_cursor: [] | [string];
};

export type RawDeleteDatabaseRequest = {
  database_id: string;
};

export type RawCreateDatabaseResult = {
  database_id: string;
  name: string;
  status: Variant;
  initial_free_grant_applied: boolean;
};

export type CreateDatabaseResult = {
  database_id: string;
  name: string;
  status: DatabaseStatus;
  initial_free_grant_applied: boolean;
};

export type RawUpdateDatabaseMetadataRequest = RawDatabaseMetadata & {
  database_id: string;
};

export type RawDatabaseMember = {
  database_id: string;
  principal: string;
  role: Variant;
  created_at_ms: bigint;
};

export type RawChild = {
  path: string;
  name: string;
  kind: Variant;
  updated_at: [] | [bigint];
  etag: [] | [string];
  size_bytes: [] | [bigint];
  is_virtual: boolean;
  has_children: boolean;
};

export type RawRecent = {
  path: string;
  kind: Variant;
  updated_at: bigint;
  etag: string;
};

export type RawWriteNodeRequest = {
  database_id: string;
  path: string;
  kind: Variant;
  content: string;
  metadata_json: string;
  expected_etag: [] | [string];
};

export type RawWriteNodeResult = {
  created: boolean;
  node: RawRecent;
};

export type RawWriteSourceForGenerationRequest = {
  database_id: string;
  path: string;
  content: string;
  metadata_json: string;
  expected_etag: [] | [string];
  session_nonce: string;
};

export type RawWriteSourceForGenerationResult = {
  write: RawWriteNodeResult;
  session_nonce: string;
};

export type RawDeleteNodeRequest = {
  database_id: string;
  path: string;
  expected_etag: [] | [string];
  expected_folder_index_etag: [] | [string];
};

export type RawDeleteNodeResult = {
  path: string;
};

export type RawMkdirNodeRequest = {
  database_id: string;
  path: string;
};

export type RawMkdirNodeResult = {
  path: string;
  created: boolean;
};

export type RawMoveNodeRequest = {
  database_id: string;
  from_path: string;
  to_path: string;
  expected_etag: [] | [string];
  overwrite: boolean;
};

export type RawMoveNodeResult = {
  from_path: string;
  node: RawRecent;
  overwrote: boolean;
};

export type RawSourceCaptureTriggerSessionRequest = {
  database_id: string;
  session_nonce: string;
};

export type RawSourceCaptureTriggerSessionCheckRequest = {
  database_id: string;
  request_path: string;
  session_nonce: string;
};

export type RawQueryAnswerSessionRequest = {
  database_id: string;
  session_nonce: string;
};

export type RawQueryAnswerSessionCheckRequest = {
  database_id: string;
  session_nonce: string;
};

export type RawQueryAnswerSessionCheckResult = {
  principal: string;
};

export type RawSourceRunSessionCheckRequest = {
  database_id: string;
  source_path: string;
  source_etag: string;
  session_nonce: string;
};

export type RawLinkEdge = {
  source_path: string;
  target_path: string;
  raw_href: string;
  link_text: string;
  link_kind: string;
  updated_at: bigint;
};

export type RawNodeContext = {
  node: RawNode;
  incoming_links: RawLinkEdge[];
  outgoing_links: RawLinkEdge[];
};

export type RawSourceEvidenceRef = {
  source_path: string;
  via_path: string;
  raw_href: string;
  link_text: string;
  source_etag: [] | [string];
  source_updated_at: [] | [bigint];
  source_content_hash: [] | [string];
};

export type RawSourceEvidence = {
  node_path: string;
  refs: RawSourceEvidenceRef[];
};

export type RawQueryContext = {
  namespace: string;
  task: string;
  search_hits: RawSearchHit[];
  nodes: RawNodeContext[];
  graph_links: RawLinkEdge[];
  evidence: RawSourceEvidence[];
  truncated: boolean;
};

export type VfsActor = {
  // Query answer wrappers keep the public browser naming while the current canister Candid surface still exposes ops_* session methods.
  authorize_ops_answer_session: (request: RawQueryAnswerSessionRequest) => Promise<{ Ok: null } | { Err: string }>;
  authorize_source_capture_trigger_session: (request: RawSourceCaptureTriggerSessionRequest) => Promise<{ Ok: null } | { Err: string }>;
  canister_health: () => Promise<RawCanisterHealth>;
  check_ops_answer_session: (request: RawQueryAnswerSessionCheckRequest) => Promise<{ Ok: RawQueryAnswerSessionCheckResult } | { Err: string }>;
  check_source_run_session: (request: RawSourceRunSessionCheckRequest) => Promise<{ Ok: null } | { Err: string }>;
  check_source_capture_trigger_session: (request: RawSourceCaptureTriggerSessionCheckRequest) => Promise<{ Ok: null } | { Err: string }>;
  check_database_write_cycles: (databaseId: string) => Promise<{ Ok: null } | { Err: string }>;
  create_database: (request: { name: string }) => Promise<{ Ok: RawCreateDatabaseResult } | { Err: string }>;
  delete_database: (request: RawDeleteDatabaseRequest) => Promise<{ Ok: null } | { Err: string }>;
  delete_node: (request: RawDeleteNodeRequest) => Promise<{ Ok: RawDeleteNodeResult } | { Err: string }>;
  get_cycles_billing_config: () => Promise<{ Ok: RawCyclesBillingConfig } | { Err: string }>;
  get_initial_free_database_grant_status: () => Promise<{ Ok: RawInitialFreeDatabaseGrantStatus } | { Err: string }>;
  grant_database_access: (databaseId: string, principal: string, role: Variant) => Promise<{ Ok: null } | { Err: string }>;
  list_database_cycle_entries: (databaseId: string, cursor: [] | [bigint], limit: number) => Promise<{ Ok: RawDatabaseCycleEntryPage } | { Err: string }>;
  list_database_cycles_pending_purchases: (databaseId: string) => Promise<{ Ok: RawDatabaseCyclesPendingPurchase[] } | { Err: string }>;
  market_count_active_entitlements: (databaseId: string) => Promise<{ Ok: bigint } | { Err: string }>;
  market_create_listing: (request: RawMarketCreateListingRequest) => Promise<{ Ok: RawMarketListing } | { Err: string }>;
  market_get_listing: (listingId: string) => Promise<{ Ok: RawMarketListingDetail } | { Err: string }>;
  market_list_database_entitlements: (databaseId: string, cursor: [] | [string], limit: number) => Promise<{ Ok: RawMarketEntitlementPage } | { Err: string }>;
  market_list_database_listings: (databaseId: string) => Promise<{ Ok: RawMarketListing[] } | { Err: string }>;
  market_list_entitlements: (cursor: [] | [string], limit: number) => Promise<{ Ok: RawMarketEntitlementPage } | { Err: string }>;
  market_list_listings: (cursor: [] | [string], limit: number) => Promise<{ Ok: RawMarketListingPage } | { Err: string }>;
  market_list_seller_listings: (sellerPrincipal: string, cursor: [] | [string], limit: number) => Promise<{ Ok: RawMarketListingPage } | { Err: string }>;
  market_list_orders: (cursor: [] | [string], limit: number) => Promise<{ Ok: RawMarketOrderPage } | { Err: string }>;
  market_pause_listing: (listingId: string) => Promise<{ Ok: RawMarketListing } | { Err: string }>;
  market_preview_purchase: (listingId: string) => Promise<{ Ok: RawMarketPurchasePreview } | { Err: string }>;
  market_publish_listing: (listingId: string) => Promise<{ Ok: RawMarketListing } | { Err: string }>;
  market_purchase_access: (request: RawMarketPurchaseRequest) => Promise<{ Ok: RawMarketOrder } | { Err: string }>;
  market_update_listing: (request: RawMarketUpdateListingRequest) => Promise<{ Ok: RawMarketListing } | { Err: string }>;
  mkdir_node: (request: RawMkdirNodeRequest) => Promise<{ Ok: RawMkdirNodeResult } | { Err: string }>;
  move_node: (request: RawMoveNodeRequest) => Promise<{ Ok: RawMoveNodeResult } | { Err: string }>;
  list_databases: () => Promise<{ Ok: RawDatabaseSummary[] } | { Err: string }>;
  list_database_members: (databaseId: string) => Promise<{ Ok: RawDatabaseMember[] } | { Err: string }>;
  revoke_database_access: (databaseId: string, principal: string) => Promise<{ Ok: null } | { Err: string }>;
  update_database_metadata: (request: RawUpdateDatabaseMetadataRequest) => Promise<{ Ok: RawDatabaseMetadata } | { Err: string }>;
  read_node: (databaseId: string, path: string) => Promise<{ Ok: [] | [RawNode] } | { Err: string }>;
  list_children: (request: { database_id: string; path: string }) => Promise<{ Ok: RawChild[] } | { Err: string }>;
  incoming_links: (request: { database_id: string; path: string; limit: number }) => Promise<{ Ok: RawLinkEdge[] } | { Err: string }>;
  outgoing_links: (request: { database_id: string; path: string; limit: number }) => Promise<{ Ok: RawLinkEdge[] } | { Err: string }>;
  graph_links: (request: { database_id: string; prefix: string; limit: number }) => Promise<{ Ok: RawLinkEdge[] } | { Err: string }>;
  graph_neighborhood: (request: { database_id: string; center_path: string; depth: number; limit: number }) => Promise<{ Ok: RawLinkEdge[] } | { Err: string }>;
  read_node_context: (request: { database_id: string; path: string; link_limit: number }) => Promise<{ Ok: [] | [RawNodeContext] } | { Err: string }>;
  query_context: (request: {
    database_id: string;
    task: string;
    entities: string[];
    namespace: [] | [string];
    budget_tokens: number;
    include_evidence: boolean;
    depth: number;
  }) => Promise<{ Ok: RawQueryContext } | { Err: string }>;
  query_database_sql_json: (databaseId: string, sql: string, limit: number) => Promise<{ Ok: RawIndexSqlJsonQueryResult } | { Err: string }>;
  query_index_sql_json: (sql: string, limit: number) => Promise<{ Ok: RawIndexSqlJsonQueryResult } | { Err: string }>;
  wiki_metrics: () => Promise<{ Ok: RawWikiMetrics } | { Err: string }>;
  wiki_metrics_series: (days: number) => Promise<{ Ok: RawWikiMetricsPoint[] } | { Err: string }>;
  search_node_paths: (request: {
    database_id: string;
    query_text: string;
    prefix: [] | [string];
    top_k: number;
    preview_mode: [] | [Variant];
  }) => Promise<{ Ok: RawSearchHit[] } | { Err: string }>;
  search_nodes: (request: {
    database_id: string;
    query_text: string;
    prefix: [] | [string];
    top_k: number;
    preview_mode: [] | [Variant];
  }) => Promise<{ Ok: RawSearchHit[] } | { Err: string }>;
  write_node: (request: RawWriteNodeRequest) => Promise<{ Ok: RawWriteNodeResult } | { Err: string }>;
  write_source_for_generation: (request: RawWriteSourceForGenerationRequest) => Promise<
    { Ok: RawWriteSourceForGenerationResult } | { Err: string }
  >;
};
