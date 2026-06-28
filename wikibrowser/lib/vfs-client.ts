import { Actor, HttpAgent, type Identity } from "@icp-sdk/core/agent";
import { Principal } from "@icp-sdk/core/principal";
import { classifyApiError, invalidCanisterIdError } from "@/lib/api-errors";
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
  DeleteDatabaseRequest,
  DeleteNodeRequest,
  DeleteNodeResult,
  DatabaseMember,
  DatabaseRole,
  DatabaseStatus,
  DatabaseSummary,
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

type Variant = Record<string, null>;

type RawNode = {
  path: string;
  kind: Variant;
  content: string;
  created_at: bigint;
  updated_at: bigint;
  etag: string;
  metadata_json: string;
};

type RawCanisterHealth = {
  cycles_balance: bigint;
};

type RawCyclesBillingConfig = {
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

type RawDatabaseSummary = {
  status: Variant;
  role: Variant;
  logical_size_bytes: bigint;
  database_id: string;
  name: string;
  cycles_balance: [] | [bigint];
  cycles_suspended_at_ms: [] | [bigint];
  deleted_at_ms: [] | [bigint];
};

type RawDatabaseCycleEntry = {
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

type RawDatabaseCycleEntryPage = {
  entries: RawDatabaseCycleEntry[];
  next_cursor: [] | [bigint];
};

type RawIndexSqlJsonQueryResult = {
  rows: string[];
  row_count: number;
  limit: number;
};

type RawWikiMetrics = {
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

type RawWikiMetricsPoint = {
  bucket_start_ms: bigint;
  metrics: RawWikiMetrics;
};

type RawDatabaseCyclesPendingPurchase = {
  operation_id: bigint;
  database_id: string;
  status: string;
  amount_cycles: bigint;
  payment_amount_e8s: bigint;
  ledger_block_index: [] | [bigint];
  created_at_ms: bigint;
  required_action: string;
};

type RawMarketListingStatus = Variant;

type RawMarketListing = {
  listing_id: string;
  seller_principal: string;
  payout_principal: string;
  database_id: string;
  title: string;
  description: string;
  llm_summary: [] | [string];
  tags_json: string;
  price_e8s: bigint;
  status: RawMarketListingStatus;
  revision: bigint;
  purchase_count: bigint;
  report_count: bigint;
  created_at_ms: bigint;
  updated_at_ms: bigint;
};

type RawMarketListingVerifiedStats = {
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

type RawMarketPreviewExcerpt = {
  path: string;
  etag: string;
  excerpt: string;
  content_chars: bigint;
};

type RawMarketCategoryGraphNode = {
  category: string;
  node_count: bigint;
};

type RawMarketCategoryGraphEdge = {
  source_category: string;
  target_category: string;
  link_count: bigint;
};

type RawMarketCategoryGraph = {
  nodes: RawMarketCategoryGraphNode[];
  edges: RawMarketCategoryGraphEdge[];
};

type RawMarketListingPreview = {
  top_level_paths: string[];
  excerpts: RawMarketPreviewExcerpt[];
  category_graph: RawMarketCategoryGraph;
  graph_links: RawLinkEdge[];
  preview_stale: boolean;
};

type RawMarketListingDetail = {
  listing: RawMarketListing;
  verified_stats: RawMarketListingVerifiedStats;
  preview: RawMarketListingPreview;
};

type RawMarketListingPage = {
  listings: RawMarketListing[];
  next_cursor: [] | [string];
};

type RawMarketCreateListingRequest = {
  database_id: string;
  payout_principal: string;
  title: string;
  description: string;
  llm_summary: [] | [string];
  tags_json: string;
  price_e8s: bigint;
};

type RawMarketUpdateListingRequest = Omit<RawMarketCreateListingRequest, "database_id"> & {
  listing_id: string;
  expected_revision: bigint;
};

type RawMarketPurchasePreview = {
  listing_id: string;
  database_id: string;
  price_e8s: bigint;
  already_entitled: boolean;
};

type RawMarketPurchaseRequest = {
  listing_id: string;
  price_e8s: bigint;
  access_principal: string;
};

type RawMarketOrder = {
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

type RawMarketOrderPage = {
  orders: RawMarketOrder[];
  next_cursor: [] | [string];
};

type RawMarketEntitlement = {
  database_id: string;
  buyer_principal: string;
  listing_id: string;
  order_id: string;
  purchased_at_ms: bigint;
  status: string;
};

type RawMarketEntitlementPage = {
  entitlements: RawMarketEntitlement[];
  next_cursor: [] | [string];
};

type RawDeleteDatabaseRequest = {
  database_id: string;
};

type RawCreateDatabaseResult = {
  database_id: string;
  name: string;
};

type RawDatabaseMember = {
  database_id: string;
  principal: string;
  role: Variant;
  created_at_ms: bigint;
};

type RawChild = {
  path: string;
  name: string;
  kind: Variant;
  updated_at: [] | [bigint];
  etag: [] | [string];
  size_bytes: [] | [bigint];
  is_virtual: boolean;
  has_children: boolean;
};

type RawRecent = {
  path: string;
  kind: Variant;
  updated_at: bigint;
  etag: string;
};

type RawWriteNodeRequest = {
  database_id: string;
  path: string;
  kind: Variant;
  content: string;
  metadata_json: string;
  expected_etag: [] | [string];
};

type RawWriteNodeResult = {
  created: boolean;
  node: RawRecent;
};

type RawWriteSourceForGenerationRequest = {
  database_id: string;
  path: string;
  content: string;
  metadata_json: string;
  expected_etag: [] | [string];
  session_nonce: string;
};

type RawWriteSourceForGenerationResult = {
  write: RawWriteNodeResult;
  session_nonce: string;
};

type RawDeleteNodeRequest = {
  database_id: string;
  path: string;
  expected_etag: [] | [string];
  expected_folder_index_etag: [] | [string];
};

type RawDeleteNodeResult = {
  path: string;
};

type RawMkdirNodeRequest = {
  database_id: string;
  path: string;
};

type RawMkdirNodeResult = {
  path: string;
  created: boolean;
};

type RawMoveNodeRequest = {
  database_id: string;
  from_path: string;
  to_path: string;
  expected_etag: [] | [string];
  overwrite: boolean;
};

type RawMoveNodeResult = {
  from_path: string;
  node: RawRecent;
  overwrote: boolean;
};

type RawSourceCaptureTriggerSessionRequest = {
  database_id: string;
  session_nonce: string;
};

type RawSourceCaptureTriggerSessionCheckRequest = {
  database_id: string;
  request_path: string;
  session_nonce: string;
};

type RawQueryAnswerSessionRequest = {
  database_id: string;
  session_nonce: string;
};

type RawQueryAnswerSessionCheckRequest = {
  database_id: string;
  session_nonce: string;
};

type RawQueryAnswerSessionCheckResult = {
  principal: string;
};

type RawSourceRunSessionCheckRequest = {
  database_id: string;
  source_path: string;
  source_etag: string;
  session_nonce: string;
};

type RawLinkEdge = {
  source_path: string;
  target_path: string;
  raw_href: string;
  link_text: string;
  link_kind: string;
  updated_at: bigint;
};

type RawNodeContext = {
  node: RawNode;
  incoming_links: RawLinkEdge[];
  outgoing_links: RawLinkEdge[];
};

type RawSourceEvidenceRef = {
  source_path: string;
  via_path: string;
  raw_href: string;
  link_text: string;
  source_etag: [] | [string];
  source_updated_at: [] | [bigint];
  source_content_hash: [] | [string];
};

type RawSourceEvidence = {
  node_path: string;
  refs: RawSourceEvidenceRef[];
};

type RawQueryContext = {
  namespace: string;
  task: string;
  search_hits: RawSearchHit[];
  nodes: RawNodeContext[];
  graph_links: RawLinkEdge[];
  evidence: RawSourceEvidence[];
  truncated: boolean;
};

type VfsActor = {
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
  rename_database: (request: { database_id: string; name: string }) => Promise<{ Ok: null } | { Err: string }>;
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

export function validateCanisterId(canisterId: string): Principal | string {
  try {
    return Principal.fromText(canisterId);
  } catch (error) {
    return error instanceof Error ? error.message : "invalid canister id";
  }
}

const actorCache = new Map<string, Promise<VfsActor>>();
const healthCache = new Map<string, Promise<CanisterHealth>>();
export async function createVfsActor(canisterId: string): Promise<VfsActor> {
  const principal = validateCanisterId(canisterId);
  if (typeof principal === "string") {
    const error = invalidCanisterIdError(principal);
    throw new ApiError(error.error, 400, error.hint, error.code);
  }
  const host = process.env.NEXT_PUBLIC_WIKI_IC_HOST ?? "https://icp0.io";
  const cacheKey = `${host}\n${canisterId}`;
  const cached = actorCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  const actorPromise = createActor(principal, host);
  actorCache.set(cacheKey, actorPromise);
  return actorPromise;
}

async function createActor(principal: Principal, host: string): Promise<VfsActor> {
  const agent = HttpAgent.createSync({ host });
  if (isLocalHost(host)) {
    await agent.fetchRootKey();
  }
  return Actor.createActor<VfsActor>((idl) => idlFactory(idl), {
    agent,
    canisterId: principal
  });
}

async function createAuthenticatedActor(canisterId: string, identity: Identity): Promise<VfsActor> {
  const principal = validateCanisterId(canisterId);
  if (typeof principal === "string") {
    const error = invalidCanisterIdError(principal);
    throw new ApiError(error.error, 400, error.hint, error.code);
  }
  const host = process.env.NEXT_PUBLIC_WIKI_IC_HOST ?? "https://icp0.io";
  const agent = HttpAgent.createSync({ host, identity });
  if (isLocalHost(host)) {
    await agent.fetchRootKey();
  }
  return Actor.createActor<VfsActor>((idl) => idlFactory(idl), {
    agent,
    canisterId: principal
  });
}

async function createReadActor(canisterId: string, identity?: Identity): Promise<VfsActor> {
  return identity ? createAuthenticatedActor(canisterId, identity) : createVfsActor(canisterId);
}

async function callVfs<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    const host = process.env.NEXT_PUBLIC_WIKI_IC_HOST ?? "https://icp0.io";
    const publicError = classifyApiError(error, host);
    throw new ApiError(publicError.error, 502, publicError.hint, publicError.code);
  }
}

function throwCanisterError(message: string): never {
  throw new ApiError(message, 400);
}

export async function readNode(canisterId: string, databaseId: string, path: string, identity?: Identity): Promise<WikiNode | null> {
  return callVfs(async () => {
    const actor = await createReadActor(canisterId, identity);
    const result = await actor.read_node(databaseId, path);
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
    const raw = result.Ok[0];
    return raw ? normalizeNode(raw) : null;
  });
}

export function canisterHealth(canisterId: string): Promise<CanisterHealth> {
  const cached = healthCache.get(canisterId);
  if (cached) {
    return cached;
  }
  const request = callVfs(async () => {
    const actor = await createVfsActor(canisterId);
    return normalizeCanisterHealth(await actor.canister_health());
  }).catch((error) => {
    healthCache.delete(canisterId);
    throw error;
  });
  healthCache.set(canisterId, request);
  return request;
}

export async function getCyclesBillingConfig(canisterId: string): Promise<CyclesBillingConfig> {
  return callVfs(async () => {
    const actor = await createVfsActor(canisterId);
    const result = await actor.get_cycles_billing_config();
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
    return normalizeCyclesBillingConfig(result.Ok);
  });
}

export async function checkDatabaseWriteCycles(canisterId: string, identity: Identity, databaseId: string): Promise<void> {
  return callVfs(async () => {
    const actor = await createAuthenticatedActor(canisterId, identity);
    const result = await actor.check_database_write_cycles(databaseId);
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
  });
}

export async function listDatabasesAuthenticated(canisterId: string, identity: Identity): Promise<DatabaseSummary[]> {
  return callVfs(async () => {
    const actor = await createAuthenticatedActor(canisterId, identity);
    const result = await actor.list_databases();
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
    return result.Ok.map((raw) => normalizeDatabaseSummary(raw));
  });
}

export async function listDatabasesPublic(canisterId: string): Promise<DatabaseSummary[]> {
  return callVfs(async () => {
    const actor = await createVfsActor(canisterId);
    const result = await actor.list_databases();
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
    return result.Ok.map((raw) => normalizeDatabaseSummary(raw));
  });
}

export async function queryIndexSqlJson(canisterId: string, identity: Identity, sql: string, limit: number): Promise<IndexSqlJsonQueryResult> {
  return callVfs(async () => {
    const actor = await createAuthenticatedActor(canisterId, identity);
    const result = await actor.query_index_sql_json(sql, limit);
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
    return normalizeIndexSqlJsonQueryResult(result.Ok);
  });
}

export async function queryDatabaseSqlJson(
  canisterId: string,
  databaseId: string,
  sql: string,
  limit: number,
  identity?: Identity
): Promise<IndexSqlJsonQueryResult> {
  return callVfs(async () => {
    const actor = await createReadActor(canisterId, identity);
    const result = await actor.query_database_sql_json(databaseId, sql, limit);
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
    return normalizeIndexSqlJsonQueryResult(result.Ok);
  });
}

export async function wikiMetrics(canisterId: string): Promise<WikiMetrics> {
  return callVfs(async () => {
    const actor = await createVfsActor(canisterId);
    const result = await actor.wiki_metrics();
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
    return normalizeWikiMetrics(result.Ok);
  });
}

// Public aggregate telemetry. The canister clamps days to 1..7.
export async function wikiMetricsSeries(canisterId: string, days: number): Promise<WikiMetricsPoint[]> {
  return callVfs(async () => {
    const actor = await createVfsActor(canisterId);
    const result = await actor.wiki_metrics_series(days);
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
    return result.Ok.map(normalizeWikiMetricsPoint);
  });
}

export async function listDatabaseCycleEntries(
  canisterId: string,
  databaseId: string,
  cursor: string | null,
  limit: number,
  identity?: Identity
): Promise<DatabaseCycleEntryPage> {
  return callVfs(async () => {
    const actor = await createReadActor(canisterId, identity);
    const result = await actor.list_database_cycle_entries(databaseId, rawDatabaseCycleCursor(cursor), limit);
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
    return normalizeDatabaseCycleEntryPage(result.Ok);
  });
}

export async function listDatabaseCyclesPendingPurchasesAuthenticated(
  canisterId: string,
  identity: Identity,
  databaseId: string
): Promise<DatabaseCyclesPendingPurchase[]> {
  return callVfs(async () => {
    const actor = await createAuthenticatedActor(canisterId, identity);
    const result = await actor.list_database_cycles_pending_purchases(databaseId);
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
    return result.Ok.map(normalizeDatabaseCyclesPendingPurchase);
  });
}

export async function marketListListings(canisterId: string, cursor: string | null, limit: number): Promise<MarketListingPage> {
  return callVfs(async () => {
    const actor = await createVfsActor(canisterId);
    const result = await actor.market_list_listings(rawTextCursor(cursor), limit);
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
    return normalizeMarketListingPage(result.Ok);
  });
}

export async function marketListSellerListings(canisterId: string, sellerPrincipal: string, cursor: string | null, limit: number): Promise<MarketListingPage> {
  return callVfs(async () => {
    const actor = await createVfsActor(canisterId);
    const result = await actor.market_list_seller_listings(sellerPrincipal, rawTextCursor(cursor), limit);
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
    return normalizeMarketListingPage(result.Ok);
  });
}

export async function marketGetListing(canisterId: string, listingId: string, identity?: Identity): Promise<MarketListingDetail> {
  return callVfs(async () => {
    const actor = await createReadActor(canisterId, identity);
    const result = await actor.market_get_listing(listingId);
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
    return normalizeMarketListingDetail(result.Ok);
  });
}

export async function marketListDatabaseListings(canisterId: string, identity: Identity, databaseId: string): Promise<MarketListing[]> {
  return callVfs(async () => {
    const actor = await createAuthenticatedActor(canisterId, identity);
    const result = await actor.market_list_database_listings(databaseId);
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
    return result.Ok.map(normalizeMarketListing);
  });
}

export async function marketListDatabaseEntitlements(canisterId: string, identity: Identity, databaseId: string, cursor: string | null, limit: number): Promise<MarketEntitlementPage> {
  return callVfs(async () => {
    const actor = await createAuthenticatedActor(canisterId, identity);
    const result = await actor.market_list_database_entitlements(databaseId, rawTextCursor(cursor), limit);
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
    return normalizeMarketEntitlementPage(result.Ok);
  });
}

export async function marketPreviewPurchase(canisterId: string, identity: Identity, listingId: string): Promise<MarketPurchasePreview> {
  return callVfs(async () => {
    const actor = await createAuthenticatedActor(canisterId, identity);
    const result = await actor.market_preview_purchase(listingId);
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
    return normalizeMarketPurchasePreview(result.Ok);
  });
}

export async function marketListEntitlements(canisterId: string, identity: Identity, cursor: string | null, limit: number): Promise<MarketEntitlementPage> {
  return callVfs(async () => {
    const actor = await createAuthenticatedActor(canisterId, identity);
    const result = await actor.market_list_entitlements(rawTextCursor(cursor), limit);
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
    return normalizeMarketEntitlementPage(result.Ok);
  });
}

export async function marketListOrders(canisterId: string, identity: Identity, cursor: string | null, limit: number): Promise<MarketOrderPage> {
  return callVfs(async () => {
    const actor = await createAuthenticatedActor(canisterId, identity);
    const result = await actor.market_list_orders(rawTextCursor(cursor), limit);
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
    return normalizeMarketOrderPage(result.Ok);
  });
}

export async function marketCreateListing(
  canisterId: string,
  identity: Identity,
  request: MarketCreateListingRequest
): Promise<MarketListing> {
  return callVfs(async () => {
    const actor = await createAuthenticatedActor(canisterId, identity);
    const result = await actor.market_create_listing(rawMarketCreateListingRequest(request));
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
    return normalizeMarketListing(result.Ok);
  });
}

export async function marketUpdateListing(
  canisterId: string,
  identity: Identity,
  request: MarketUpdateListingRequest
): Promise<MarketListing> {
  return callVfs(async () => {
    const actor = await createAuthenticatedActor(canisterId, identity);
    const result = await actor.market_update_listing(rawMarketUpdateListingRequest(request));
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
    return normalizeMarketListing(result.Ok);
  });
}

export async function marketPublishListing(canisterId: string, identity: Identity, listingId: string): Promise<MarketListing> {
  return callVfs(async () => {
    const actor = await createAuthenticatedActor(canisterId, identity);
    const result = await actor.market_publish_listing(listingId);
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
    return normalizeMarketListing(result.Ok);
  });
}

export async function marketPauseListing(canisterId: string, identity: Identity, listingId: string): Promise<MarketListing> {
  return callVfs(async () => {
    const actor = await createAuthenticatedActor(canisterId, identity);
    const result = await actor.market_pause_listing(listingId);
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
    return normalizeMarketListing(result.Ok);
  });
}

export async function marketCountActiveEntitlements(canisterId: string, identity: Identity, databaseId: string): Promise<string> {
  return callVfs(async () => {
    const actor = await createAuthenticatedActor(canisterId, identity);
    const result = await actor.market_count_active_entitlements(databaseId);
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
    return result.Ok.toString();
  });
}

export async function createDatabaseAuthenticated(canisterId: string, identity: Identity, name: string): Promise<RawCreateDatabaseResult> {
  return callVfs(async () => {
    const actor = await createAuthenticatedActor(canisterId, identity);
    const result = await actor.create_database({ name });
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
    return result.Ok;
  });
}

export async function deleteDatabaseAuthenticated(canisterId: string, identity: Identity, request: DeleteDatabaseRequest): Promise<void> {
  return callVfs(async () => {
    const actor = await createAuthenticatedActor(canisterId, identity);
    const result = await actor.delete_database({
      database_id: request.databaseId
    });
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
  });
}

export async function renameDatabaseAuthenticated(canisterId: string, identity: Identity, databaseId: string, name: string): Promise<void> {
  return callVfs(async () => {
    const actor = await createAuthenticatedActor(canisterId, identity);
    const result = await actor.rename_database({ database_id: databaseId, name });
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
  });
}

export async function writeNodeAuthenticated(canisterId: string, identity: Identity, request: WriteNodeRequest): Promise<WriteNodeResult> {
  return callVfs(async () => {
    const actor = await createAuthenticatedActor(canisterId, identity);
    const result = await actor.write_node({
      database_id: request.databaseId,
      path: request.path,
      kind: nodeKindVariant(request.kind),
      content: request.content,
      metadata_json: request.metadataJson,
      expected_etag: request.expectedEtag ? [request.expectedEtag] : []
    });
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
    return {
      created: result.Ok.created,
      node: normalizeRecentNode(result.Ok.node)
    };
  });
}

export async function writeSourceForGenerationAuthenticated(
  canisterId: string,
  identity: Identity,
  request: WriteSourceForGenerationRequest
): Promise<WriteSourceForGenerationResult> {
  return callVfs(async () => {
    const actor = await createAuthenticatedActor(canisterId, identity);
    const result = await actor.write_source_for_generation({
      database_id: request.databaseId,
      path: request.path,
      content: request.content,
      metadata_json: request.metadataJson,
      expected_etag: request.expectedEtag ? [request.expectedEtag] : [],
      session_nonce: request.sessionNonce
    });
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
    return {
      write: {
        created: result.Ok.write.created,
        node: normalizeRecentNode(result.Ok.write.node)
      },
      sessionNonce: result.Ok.session_nonce
    };
  });
}

export async function deleteNodeAuthenticated(canisterId: string, identity: Identity, request: DeleteNodeRequest): Promise<DeleteNodeResult> {
  return callVfs(async () => {
    const actor = await createAuthenticatedActor(canisterId, identity);
    const result = await actor.delete_node({
      database_id: request.databaseId,
      path: request.path,
      expected_etag: request.expectedEtag ? [request.expectedEtag] : [],
      expected_folder_index_etag: request.expectedFolderIndexEtag ? [request.expectedFolderIndexEtag] : []
    });
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
    return result.Ok;
  });
}

export async function mkdirNodeAuthenticated(canisterId: string, identity: Identity, request: MkdirNodeRequest): Promise<MkdirNodeResult> {
  return callVfs(async () => {
    const actor = await createAuthenticatedActor(canisterId, identity);
    const result = await actor.mkdir_node({
      database_id: request.databaseId,
      path: request.path
    });
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
    return result.Ok;
  });
}

export async function moveNodeAuthenticated(canisterId: string, identity: Identity, request: MoveNodeRequest): Promise<MoveNodeResult> {
  return callVfs(async () => {
    const actor = await createAuthenticatedActor(canisterId, identity);
    const result = await actor.move_node({
      database_id: request.databaseId,
      from_path: request.fromPath,
      to_path: request.toPath,
      expected_etag: request.expectedEtag ? [request.expectedEtag] : [],
      overwrite: request.overwrite
    });
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
    return {
      fromPath: result.Ok.from_path,
      node: normalizeRecentNode(result.Ok.node),
      overwrote: result.Ok.overwrote
    };
  });
}

export async function authorizeSourceCaptureTriggerSession(
  canisterId: string,
  identity: Identity,
  request: SourceCaptureTriggerSessionRequest
): Promise<void> {
  return callVfs(async () => {
    const actor = await createAuthenticatedActor(canisterId, identity);
    const result = await actor.authorize_source_capture_trigger_session(rawSourceCaptureTriggerSessionRequest(request));
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
  });
}

export async function checkSourceCaptureTriggerSession(canisterId: string, request: SourceCaptureTriggerSessionCheckRequest): Promise<void> {
  return callVfs(async () => {
    const actor = await createVfsActor(canisterId);
    const result = await actor.check_source_capture_trigger_session(rawSourceCaptureTriggerSessionCheckRequest(request));
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
  });
}

export async function authorizeQueryAnswerSession(
  canisterId: string,
  identity: Identity,
  request: QueryAnswerSessionRequest
): Promise<void> {
  return callVfs(async () => {
    const actor = await createAuthenticatedActor(canisterId, identity);
    // Compatibility note: the canister method is still ops_*; callers should use the query answer wrapper names above.
    const result = await actor.authorize_ops_answer_session(rawQueryAnswerSessionRequest(request));
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
  });
}

export async function checkQueryAnswerSession(canisterId: string, request: QueryAnswerSessionCheckRequest): Promise<QueryAnswerSessionCheckResult> {
  return callVfs(async () => {
    const actor = await createVfsActor(canisterId);
    // Compatibility note: the canister method is still ops_*; callers should use the query answer wrapper names above.
    const result = await actor.check_ops_answer_session(rawQueryAnswerSessionCheckRequest(request));
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
    return {
      principal: result.Ok.principal
    };
  });
}

export async function checkSourceRunSession(canisterId: string, request: SourceRunSessionCheckRequest): Promise<void> {
  return callVfs(async () => {
    const actor = await createVfsActor(canisterId);
    const result = await actor.check_source_run_session(rawSourceRunSessionCheckRequest(request));
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
  });
}

export async function listDatabaseMembersAuthenticated(canisterId: string, identity: Identity, databaseId: string): Promise<DatabaseMember[]> {
  return callVfs(async () => {
    const actor = await createAuthenticatedActor(canisterId, identity);
    const result = await actor.list_database_members(databaseId);
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
    return result.Ok.map(normalizeDatabaseMember);
  });
}

export async function listDatabaseMembersPublic(canisterId: string, databaseId: string): Promise<DatabaseMember[]> {
  return callVfs(async () => {
    const actor = await createVfsActor(canisterId);
    const result = await actor.list_database_members(databaseId);
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
    return result.Ok.map(normalizeDatabaseMember);
  });
}

export async function grantDatabaseAccessAuthenticated(
  canisterId: string,
  identity: Identity,
  databaseId: string,
  principal: string,
  role: DatabaseRole
): Promise<void> {
  return callVfs(async () => {
    const actor = await createAuthenticatedActor(canisterId, identity);
    const result = await actor.grant_database_access(databaseId, principal, databaseRoleVariant(role));
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
  });
}

export async function revokeDatabaseAccessAuthenticated(
  canisterId: string,
  identity: Identity,
  databaseId: string,
  principal: string
): Promise<void> {
  return callVfs(async () => {
    const actor = await createAuthenticatedActor(canisterId, identity);
    const result = await actor.revoke_database_access(databaseId, principal);
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
  });
}

export async function readNodeContext(canisterId: string, databaseId: string, path: string, linkLimit: number, identity?: Identity): Promise<NodeContext | null> {
  return callVfs(async () => {
    const actor = await createReadActor(canisterId, identity);
    const result = await actor.read_node_context({ database_id: databaseId, path, link_limit: linkLimit });
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
    const raw = result.Ok[0];
    return raw ? normalizeNodeContext(raw) : null;
  });
}

export async function listChildren(canisterId: string, databaseId: string, path: string, identity?: Identity): Promise<ChildNode[]> {
  return callVfs(async () => {
    const actor = await createReadActor(canisterId, identity);
    const result = await actor.list_children({ database_id: databaseId, path });
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
    return sortChildNodes(result.Ok.map(normalizeChild));
  });
}

export async function incomingLinks(canisterId: string, databaseId: string, path: string, limit: number, identity?: Identity): Promise<LinkEdge[]> {
  return callVfs(async () => {
    const actor = await createReadActor(canisterId, identity);
    const result = await actor.incoming_links({ database_id: databaseId, path, limit });
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
    return result.Ok.map(normalizeLinkEdge);
  });
}

export async function outgoingLinks(canisterId: string, databaseId: string, path: string, limit: number, identity?: Identity): Promise<LinkEdge[]> {
  return callVfs(async () => {
    const actor = await createReadActor(canisterId, identity);
    const result = await actor.outgoing_links({ database_id: databaseId, path, limit });
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
    return result.Ok.map(normalizeLinkEdge);
  });
}

export async function graphLinks(canisterId: string, databaseId: string, prefix: string, limit: number, identity?: Identity): Promise<LinkEdge[]> {
  return callVfs(async () => {
    const actor = await createReadActor(canisterId, identity);
    const result = await actor.graph_links({ database_id: databaseId, prefix, limit });
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
    return result.Ok.map(normalizeLinkEdge);
  });
}

export async function graphNeighborhood(canisterId: string, databaseId: string, centerPath: string, depth: number, limit: number, identity?: Identity): Promise<LinkEdge[]> {
  return callVfs(async () => {
    const actor = await createReadActor(canisterId, identity);
    const result = await actor.graph_neighborhood({ database_id: databaseId, center_path: centerPath, depth, limit });
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
    return result.Ok.map(normalizeLinkEdge);
  });
}

export async function queryContext(
  canisterId: string,
  databaseId: string,
  task: string,
  budgetTokens: number,
  identity?: Identity,
  namespace?: string
): Promise<QueryContext> {
  return callVfs(async () => {
    const actor = await createReadActor(canisterId, identity);
    const result = await actor.query_context({
      database_id: databaseId,
      task,
      entities: [],
      namespace: namespace ? [namespace] : [],
      budget_tokens: budgetTokens,
      include_evidence: false,
      depth: 1
    });
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
    return normalizeQueryContext(result.Ok);
  });
}

export async function searchNodePaths(
  canisterId: string,
  databaseId: string,
  queryText: string,
  limit: number,
  prefix: string | null,
  previewMode: SearchPreviewMode = "content-start",
  identity?: Identity
): Promise<SearchNodeHit[]> {
  return callVfs(async () => {
    const actor = await createReadActor(canisterId, identity);
    const result = await actor.search_node_paths({
      database_id: databaseId,
      query_text: queryText,
      prefix: prefix ? [prefix] : [],
      top_k: limit,
      preview_mode: searchPreviewModeArg(previewMode)
    });
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
    return result.Ok.map(normalizeSearchHit);
  });
}

export async function searchNodes(
  canisterId: string,
  databaseId: string,
  queryText: string,
  limit: number,
  prefix: string | null,
  previewMode: SearchPreviewMode = "light",
  identity?: Identity
): Promise<SearchNodeHit[]> {
  return callVfs(async () => {
    const actor = await createReadActor(canisterId, identity);
    const result = await actor.search_nodes({
      database_id: databaseId,
      query_text: queryText,
      prefix: prefix ? [prefix] : [],
      top_k: limit,
      preview_mode: searchPreviewModeArg(previewMode)
    });
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
    return result.Ok.map(normalizeSearchHit);
  });
}

function searchPreviewModeArg(mode: SearchPreviewMode): [] | [Variant] {
  if (mode === "none") return [{ None: null }];
  if (mode === "light") return [{ Light: null }];
  if (mode === "content-start") return [{ ContentStart: null }];
  return [];
}

function normalizeNode(raw: RawNode): WikiNode {
  return {
    path: raw.path,
    kind: normalizeNodeKind(raw.kind),
    content: raw.content,
    createdAt: raw.created_at.toString(),
    updatedAt: raw.updated_at.toString(),
    etag: raw.etag,
    metadataJson: raw.metadata_json
  };
}

function normalizeCanisterHealth(raw: RawCanisterHealth): CanisterHealth {
  return {
    cyclesBalance: raw.cycles_balance
  };
}

function normalizeCyclesBillingConfig(raw: RawCyclesBillingConfig): CyclesBillingConfig {
  return {
    kinicLedgerCanisterId: raw.kinic_ledger_canister_id,
    billingAuthorityId: raw.billing_authority_id,
    cyclesPerKinic: raw.cycles_per_kinic.toString(),
    minUpdateCycles: raw.min_update_cycles.toString(),
    topUp: {
      enabled: raw.top_up.enabled,
      launcherPrincipal: raw.top_up.launcher_principal,
      thresholdCycles: raw.top_up.threshold_cycles.toString()
    }
  };
}

function normalizeDatabaseSummary(raw: RawDatabaseSummary): DatabaseSummary {
  return {
    databaseId: raw.database_id,
    name: raw.name,
    role: normalizeDatabaseRole(raw.role),
    status: normalizeDatabaseStatus(raw.status),
    logicalSizeBytes: raw.logical_size_bytes.toString(),
    cyclesBalance: raw.cycles_balance[0]?.toString() ?? "0",
    cyclesSuspendedAtMs: raw.cycles_suspended_at_ms[0]?.toString() ?? null,
    deletedAtMs: raw.deleted_at_ms[0]?.toString() ?? null
  };
}

function normalizeDatabaseCycleEntryPage(raw: RawDatabaseCycleEntryPage): DatabaseCycleEntryPage {
  return {
    entries: raw.entries.map(normalizeDatabaseCycleEntry),
    nextCursor: raw.next_cursor[0]?.toString() ?? null
  };
}

function normalizeIndexSqlJsonQueryResult(raw: RawIndexSqlJsonQueryResult): IndexSqlJsonQueryResult {
  return {
    rows: raw.rows,
    rowCount: raw.row_count.toString(),
    limit: raw.limit.toString()
  };
}

function normalizeWikiMetrics(raw: RawWikiMetrics): WikiMetrics {
  return {
    usersTotal: raw.users_total.toString(),
    usersActive30d: raw.users_active_30d.toString(),
    usersNew30d: raw.users_new_30d.toString(),
    databasesTotal: raw.databases_total.toString(),
    databasesActive30d: raw.databases_active_30d.toString(),
    databasesNew30d: raw.databases_new_30d.toString(),
    paidUsersTotal: raw.paid_users_total.toString(),
    chargedKinicTotalE8s: raw.charged_kinic_total_e8s.toString(),
    chargedKinic30dE8s: raw.charged_kinic_30d_e8s.toString(),
    lastActivityAtMs: raw.last_activity_at_ms[0]?.toString() ?? null
  };
}

function normalizeWikiMetricsPoint(raw: RawWikiMetricsPoint): WikiMetricsPoint {
  return {
    bucketStartMs: raw.bucket_start_ms.toString(),
    metrics: normalizeWikiMetrics(raw.metrics)
  };
}

function normalizeDatabaseCycleEntry(raw: RawDatabaseCycleEntry): DatabaseCycleEntry {
  return {
    entryId: raw.entry_id.toString(),
    databaseId: raw.database_id,
    kind: raw.kind,
    amountCycles: raw.amount_cycles.toString(),
    balanceAfterCycles: raw.balance_after_cycles.toString(),
    caller: raw.caller,
    method: raw.method[0] ?? null,
    ledgerBlockIndex: raw.ledger_block_index[0]?.toString() ?? null,
    paymentAmountE8s: raw.payment_amount_e8s[0]?.toString() ?? null,
    cyclesPerKinic: raw.cycles_per_kinic[0]?.toString() ?? null,
    cyclesDelta: raw.cycles_delta[0]?.toString() ?? null,
    createdAtMs: raw.created_at_ms.toString()
  };
}

function normalizeDatabaseCyclesPendingPurchase(raw: RawDatabaseCyclesPendingPurchase): DatabaseCyclesPendingPurchase {
  return {
    operationId: raw.operation_id.toString(),
    databaseId: raw.database_id,
    status: raw.status,
    amountCycles: raw.amount_cycles.toString(),
    paymentAmountE8s: raw.payment_amount_e8s.toString(),
    ledgerBlockIndex: raw.ledger_block_index[0]?.toString() ?? null,
    createdAtMs: raw.created_at_ms.toString(),
    requiredAction: raw.required_action
  };
}

function normalizeMarketListingPage(raw: RawMarketListingPage): MarketListingPage {
  return {
    listings: raw.listings.map(normalizeMarketListing),
    nextCursor: raw.next_cursor[0] ?? null
  };
}

function normalizeMarketListing(raw: RawMarketListing): MarketListing {
  return {
    listingId: raw.listing_id,
    sellerPrincipal: raw.seller_principal,
    payoutPrincipal: raw.payout_principal,
    databaseId: raw.database_id,
    title: raw.title,
    description: raw.description,
    llmSummary: raw.llm_summary[0] ?? null,
    tagsJson: raw.tags_json,
    priceE8s: raw.price_e8s.toString(),
    status: normalizeMarketListingStatus(raw.status),
    revision: raw.revision.toString(),
    purchaseCount: raw.purchase_count.toString(),
    reportCount: raw.report_count.toString(),
    createdAtMs: raw.created_at_ms.toString(),
    updatedAtMs: raw.updated_at_ms.toString()
  };
}

function normalizeMarketListingDetail(raw: RawMarketListingDetail): MarketListingDetail {
  return {
    listing: normalizeMarketListing(raw.listing),
    verifiedStats: {
      totalNodes: raw.verified_stats.total_nodes.toString(),
      wikiNodes: raw.verified_stats.wiki_nodes.toString(),
      sourceNodes: raw.verified_stats.source_nodes.toString(),
      folderNodes: raw.verified_stats.folder_nodes.toString(),
      markdownChars: raw.verified_stats.markdown_chars.toString(),
      sourceChars: raw.verified_stats.source_chars.toString(),
      linkEdges: raw.verified_stats.link_edges.toString(),
      logicalSizeBytes: raw.verified_stats.logical_size_bytes.toString(),
      lastContentUpdatedAtMs: raw.verified_stats.last_content_updated_at_ms[0]?.toString() ?? null
    },
    preview: {
      topLevelPaths: raw.preview.top_level_paths,
      excerpts: raw.preview.excerpts.map((excerpt) => ({
        path: excerpt.path,
        etag: excerpt.etag,
        excerpt: excerpt.excerpt,
        contentChars: excerpt.content_chars.toString()
      })),
      categoryGraph: {
        nodes: raw.preview.category_graph.nodes.map((node) => ({
          category: node.category,
          nodeCount: node.node_count.toString()
        })),
        edges: raw.preview.category_graph.edges.map((edge) => ({
          sourceCategory: edge.source_category,
          targetCategory: edge.target_category,
          linkCount: edge.link_count.toString()
        }))
      },
      graphLinks: raw.preview.graph_links.map(normalizeLinkEdge),
      previewStale: raw.preview.preview_stale
    }
  };
}

function normalizeMarketListingStatus(status: RawMarketListingStatus): MarketListingStatus {
  if ("Active" in status) return "Active";
  return "Paused";
}

function normalizeMarketPurchasePreview(raw: RawMarketPurchasePreview): MarketPurchasePreview {
  return {
    listingId: raw.listing_id,
    databaseId: raw.database_id,
    priceE8s: raw.price_e8s.toString(),
    alreadyEntitled: raw.already_entitled
  };
}

function normalizeMarketOrderPage(raw: RawMarketOrderPage): MarketOrderPage {
  return {
    orders: raw.orders.map(normalizeMarketOrder),
    nextCursor: raw.next_cursor[0] ?? null
  };
}

function normalizeMarketOrder(raw: RawMarketOrder): MarketOrder {
  return {
    orderId: raw.order_id,
    listingId: raw.listing_id,
    databaseId: raw.database_id,
    buyerPrincipal: raw.buyer_principal,
    sellerPrincipal: raw.seller_principal,
    payoutPrincipal: raw.payout_principal,
    priceE8s: raw.price_e8s.toString(),
    ledgerBlockIndex: raw.ledger_block_index.toString(),
    createdAtMs: raw.created_at_ms.toString()
  };
}

function normalizeMarketEntitlementPage(raw: RawMarketEntitlementPage): MarketEntitlementPage {
  return {
    entitlements: raw.entitlements.map(normalizeMarketEntitlement),
    nextCursor: raw.next_cursor[0] ?? null
  };
}

function normalizeMarketEntitlement(raw: RawMarketEntitlement) {
  return {
    databaseId: raw.database_id,
    buyerPrincipal: raw.buyer_principal,
    listingId: raw.listing_id,
    orderId: raw.order_id,
    purchasedAtMs: raw.purchased_at_ms.toString(),
    status: raw.status
  };
}

function rawMarketCreateListingRequest(request: MarketCreateListingRequest): RawMarketCreateListingRequest {
  return {
    database_id: request.databaseId,
    payout_principal: request.payoutPrincipal,
    title: request.title,
    description: request.description,
    llm_summary: rawOptionalText(request.llmSummary),
    tags_json: request.tagsJson,
    price_e8s: BigInt(request.priceE8s)
  };
}

function rawMarketUpdateListingRequest(request: MarketUpdateListingRequest): RawMarketUpdateListingRequest {
  return {
    title: request.title,
    description: request.description,
    llm_summary: rawOptionalText(request.llmSummary),
    tags_json: request.tagsJson,
    price_e8s: BigInt(request.priceE8s),
    listing_id: request.listingId,
    expected_revision: BigInt(request.expectedRevision),
    payout_principal: request.payoutPrincipal
  };
}

function normalizeDatabaseMember(raw: RawDatabaseMember): DatabaseMember {
  return {
    databaseId: raw.database_id,
    principal: raw.principal,
    role: normalizeDatabaseRole(raw.role),
    createdAtMs: raw.created_at_ms.toString()
  };
}

function normalizeRecentNode(raw: RawRecent): RecentNode {
  return {
    path: raw.path,
    kind: normalizeNodeKind(raw.kind),
    updatedAt: raw.updated_at.toString(),
    etag: raw.etag
  };
}

function normalizeChild(raw: RawChild): ChildNode {
  return {
    path: raw.path,
    name: raw.name,
    kind: normalizeEntryKind(raw.kind),
    updatedAt: raw.updated_at[0]?.toString() ?? null,
    etag: raw.etag[0] ?? null,
    sizeBytes: raw.size_bytes[0]?.toString() ?? null,
    isVirtual: raw.is_virtual,
    hasChildren: raw.has_children
  };
}

function normalizeLinkEdge(raw: RawLinkEdge): LinkEdge {
  return {
    sourcePath: raw.source_path,
    targetPath: raw.target_path,
    rawHref: raw.raw_href,
    linkText: raw.link_text,
    linkKind: raw.link_kind,
    updatedAt: raw.updated_at.toString()
  };
}

function normalizeNodeContext(raw: RawNodeContext): NodeContext {
  return {
    node: normalizeNode(raw.node),
    incomingLinks: raw.incoming_links.map(normalizeLinkEdge),
    outgoingLinks: raw.outgoing_links.map(normalizeLinkEdge)
  };
}

function normalizeQueryContext(raw: RawQueryContext): QueryContext {
  return {
    namespace: raw.namespace,
    task: raw.task,
    searchHits: raw.search_hits.map(normalizeSearchHit),
    nodes: raw.nodes.map(normalizeNodeContext),
    graphLinks: raw.graph_links.map(normalizeLinkEdge),
    evidence: raw.evidence.map(normalizeSourceEvidence),
    truncated: raw.truncated
  };
}

function normalizeSourceEvidence(raw: RawSourceEvidence): SourceEvidence {
  return {
    nodePath: raw.node_path,
    refs: raw.refs.map((ref) => ({
      sourcePath: ref.source_path,
      viaPath: ref.via_path,
      rawHref: ref.raw_href,
      linkText: ref.link_text,
      sourceEtag: ref.source_etag[0] ?? null,
      sourceUpdatedAt: ref.source_updated_at[0]?.toString() ?? null,
      sourceContentHash: ref.source_content_hash[0] ?? null
    }))
  };
}

function normalizeNodeKind(kind: Variant): NodeKind {
  if ("Folder" in kind) return "folder";
  return "Source" in kind ? "source" : "file";
}

function normalizeEntryKind(kind: Variant): NodeEntryKind {
  if ("Folder" in kind) {
    return "folder";
  }
  if ("Directory" in kind) {
    return "directory";
  }
  return "Source" in kind ? "source" : "file";
}

function normalizeDatabaseRole(role: Variant): DatabaseRole {
  if ("Owner" in role) {
    return "owner";
  }
  if ("Writer" in role) {
    return "writer";
  }
  return "reader";
}



function databaseRoleVariant(role: DatabaseRole): Variant {
  if (role === "owner") {
    return { Owner: null };
  }
  if (role === "writer") {
    return { Writer: null };
  }
  return { Reader: null };
}

function nodeKindVariant(kind: NodeKind): Variant {
  if (kind === "folder") return { Folder: null };
  if (kind === "source") return { Source: null };
  return { File: null };
}

function rawDatabaseCycleCursor(cursor: string | null): [] | [bigint] {
  if (!cursor) return [];
  if (!/^[0-9]+$/.test(cursor)) {
    throw new ApiError("Invalid cycles history cursor.", 400);
  }
  return [BigInt(cursor)];
}

function rawTextCursor(cursor: string | null): [] | [string] {
  return cursor ? [cursor] : [];
}

function rawOptionalText(value: string | null): [] | [string] {
  return value === null ? [] : [value];
}

function rawSourceCaptureTriggerSessionRequest(request: SourceCaptureTriggerSessionRequest): RawSourceCaptureTriggerSessionRequest {
  return {
    database_id: request.databaseId,
    session_nonce: request.sessionNonce
  };
}

function rawSourceCaptureTriggerSessionCheckRequest(request: SourceCaptureTriggerSessionCheckRequest): RawSourceCaptureTriggerSessionCheckRequest {
  return {
    database_id: request.databaseId,
    request_path: request.requestPath,
    session_nonce: request.sessionNonce
  };
}

function rawQueryAnswerSessionRequest(request: QueryAnswerSessionRequest): RawQueryAnswerSessionRequest {
  return {
    database_id: request.databaseId,
    session_nonce: request.sessionNonce
  };
}

function rawQueryAnswerSessionCheckRequest(request: QueryAnswerSessionCheckRequest): RawQueryAnswerSessionCheckRequest {
  return {
    database_id: request.databaseId,
    session_nonce: request.sessionNonce
  };
}

function rawSourceRunSessionCheckRequest(request: SourceRunSessionCheckRequest): RawSourceRunSessionCheckRequest {
  return {
    database_id: request.databaseId,
    source_path: request.sourcePath,
    source_etag: request.sourceEtag,
    session_nonce: request.sessionNonce
  };
}

function normalizeDatabaseStatus(status: Variant): DatabaseStatus {
  if ("Active" in status) {
    return "active";
  }
  if ("Pending" in status) {
    return "pending";
  }
  if ("Deleted" in status) {
    return "deleted";
  }
  throw new ApiError(`Unknown database status variant: ${Object.keys(status).join(",")}`, 502);
}

function isLocalHost(host: string): boolean {
  return host.includes("127.0.0.1") || host.includes("localhost");
}
