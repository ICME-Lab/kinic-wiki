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

import type { CreateDatabaseResult, DatabaseCyclesPurchaseRequest, RawCanisterHealth, RawChild, RawCreateDatabaseResult, RawCyclesBillingConfig, RawDatabaseCycleEntry, RawDatabaseCycleEntryPage, RawDatabaseCyclesPendingPurchase, RawDatabaseMember, RawDatabaseMetadata, RawDatabaseSummary, RawDeleteDatabaseRequest, RawDeleteNodeRequest, RawDeleteNodeResult, RawIndexSqlJsonQueryResult, RawInitialFreeDatabaseGrantStatus, RawLinkEdge, RawMarketCategoryGraph, RawMarketCategoryGraphEdge, RawMarketCategoryGraphNode, RawMarketCreateListingRequest, RawMarketEntitlement, RawMarketEntitlementPage, RawMarketListing, RawMarketListingDetail, RawMarketListingPage, RawMarketListingPreview, RawMarketListingStatus, RawMarketListingVerifiedStats, RawMarketListingView, RawMarketOrder, RawMarketOrderPage, RawMarketPreviewExcerpt, RawMarketPurchasePreview, RawMarketPurchaseRequest, RawMarketUpdateListingRequest, RawMkdirNodeRequest, RawMkdirNodeResult, RawMoveNodeRequest, RawMoveNodeResult, RawNode, RawNodeContext, RawQueryAnswerSessionCheckRequest, RawQueryAnswerSessionCheckResult, RawQueryAnswerSessionRequest, RawQueryContext, RawRecent, RawSourceCaptureTriggerSessionCheckRequest, RawSourceCaptureTriggerSessionRequest, RawSourceEvidence, RawSourceEvidenceRef, RawSourceRunSessionCheckRequest, RawUpdateDatabaseMetadataRequest, RawWikiMetrics, RawWikiMetricsPoint, RawWriteNodeRequest, RawWriteNodeResult, RawWriteSourceForGenerationRequest, RawWriteSourceForGenerationResult, Variant, VfsActor } from "./raw-types";
import { callVfs, createAuthenticatedActor, createReadActor, createVfsActor, normalizeDatabaseMetadata, normalizeLinkEdge, rawOptionalText, rawTextCursor, throwCanisterError } from "./actor";
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


export function normalizeMarketListingPage(raw: RawMarketListingPage): MarketListingPage {
  return {
    listings: raw.listings.map(normalizeMarketListingView),
    nextCursor: raw.next_cursor[0] ?? null
  };
}

export function normalizeMarketListing(raw: RawMarketListing): MarketListing {
  return {
    listingId: raw.listing_id,
    sellerPrincipal: raw.seller_principal,
    payoutPrincipal: raw.payout_principal,
    databaseId: raw.database_id,
    priceE8s: raw.price_e8s.toString(),
    status: normalizeMarketListingStatus(raw.status),
    revision: raw.revision.toString(),
    purchaseCount: raw.purchase_count.toString(),
    reportCount: raw.report_count.toString(),
    createdAtMs: raw.created_at_ms.toString(),
    updatedAtMs: raw.updated_at_ms.toString()
  };
}

export function normalizeMarketListingView(raw: RawMarketListingView) {
  return {
    listing: normalizeMarketListing(raw.listing),
    databaseMetadata: normalizeDatabaseMetadata(raw.database_metadata)
  };
}

export function normalizeMarketListingDetail(raw: RawMarketListingDetail): MarketListingDetail {
  return {
    listing: normalizeMarketListingView(raw.listing),
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

export function normalizeMarketListingStatus(status: RawMarketListingStatus): MarketListingStatus {
  if ("Active" in status) return "Active";
  return "Paused";
}

export function normalizeMarketPurchasePreview(raw: RawMarketPurchasePreview): MarketPurchasePreview {
  return {
    listingId: raw.listing_id,
    databaseId: raw.database_id,
    priceE8s: raw.price_e8s.toString(),
    alreadyEntitled: raw.already_entitled
  };
}

export function normalizeMarketOrderPage(raw: RawMarketOrderPage): MarketOrderPage {
  return {
    orders: raw.orders.map(normalizeMarketOrder),
    nextCursor: raw.next_cursor[0] ?? null
  };
}

export function normalizeMarketOrder(raw: RawMarketOrder): MarketOrder {
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

export function normalizeMarketEntitlementPage(raw: RawMarketEntitlementPage): MarketEntitlementPage {
  return {
    entitlements: raw.entitlements.map(normalizeMarketEntitlement),
    nextCursor: raw.next_cursor[0] ?? null
  };
}

export function normalizeMarketEntitlement(raw: RawMarketEntitlement) {
  return {
    databaseId: raw.database_id,
    buyerPrincipal: raw.buyer_principal,
    listingId: raw.listing_id,
    orderId: raw.order_id,
    purchasedAtMs: raw.purchased_at_ms.toString(),
    status: raw.status
  };
}

export function rawMarketCreateListingRequest(request: MarketCreateListingRequest): RawMarketCreateListingRequest {
  return {
    database_id: request.databaseId,
    payout_principal: request.payoutPrincipal,
    price_e8s: BigInt(request.priceE8s)
  };
}

export function rawMarketUpdateListingRequest(request: MarketUpdateListingRequest): RawMarketUpdateListingRequest {
  return {
    price_e8s: BigInt(request.priceE8s),
    listing_id: request.listingId,
    expected_revision: BigInt(request.expectedRevision),
    payout_principal: request.payoutPrincipal
  };
}
