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
export function validateCanisterId(canisterId: string): Principal | string {
  try {
    return Principal.fromText(canisterId);
  } catch (error) {
    return error instanceof Error ? error.message : "invalid canister id";
  }
}

export const actorCache = new Map<string, Promise<VfsActor>>();
export const healthCache = new Map<string, Promise<CanisterHealth>>();
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

export async function createActor(principal: Principal, host: string): Promise<VfsActor> {
  const agent = HttpAgent.createSync({ host });
  if (isLocalHost(host)) {
    await agent.fetchRootKey();
  }
  return Actor.createActor<VfsActor>((idl) => idlFactory(idl), {
    agent,
    canisterId: principal
  });
}

export async function createAuthenticatedActor(canisterId: string, identity: Identity): Promise<VfsActor> {
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

export async function createReadActor(canisterId: string, identity?: Identity): Promise<VfsActor> {
  return identity ? createAuthenticatedActor(canisterId, identity) : createVfsActor(canisterId);
}

export async function callVfs<T>(operation: () => Promise<T>): Promise<T> {
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

export function throwCanisterError(message: string): never {
  const error = classifyCanisterError(message);
  throw new ApiError(error.error, error.status ?? 400, error.hint, error.code);
}


export function rawDatabaseCycleCursor(cursor: string | null): [] | [bigint] {
  if (!cursor) return [];
  if (!/^[0-9]+$/.test(cursor)) {
    throw new ApiError("Invalid cycles history cursor.", 400);
  }
  return [BigInt(cursor)];
}

export function rawTextCursor(cursor: string | null): [] | [string] {
  return cursor ? [cursor] : [];
}

export function rawOptionalText(value: string | null): [] | [string] {
  return value === null ? [] : [value];
}

export function normalizeDatabaseSummary(raw: RawDatabaseSummary): DatabaseSummary {
  return {
    databaseId: raw.database_id,
    name: raw.name,
    metadata: normalizeDatabaseMetadata(databaseMetadataOrFallback(raw)),
    role: normalizeDatabaseRole(raw.role),
    status: normalizeDatabaseStatus(raw.status),
    logicalSizeBytes: raw.logical_size_bytes.toString(),
    cyclesBalance: raw.cycles_balance[0]?.toString() ?? "0",
    cyclesSuspendedAtMs: raw.cycles_suspended_at_ms[0]?.toString() ?? null,
    deletedAtMs: raw.deleted_at_ms[0]?.toString() ?? null
  };
}

export function databaseMetadataOrFallback(raw: RawDatabaseSummary): RawDatabaseMetadata {
  return raw.metadata[0] ?? {
    name: raw.name,
    description: "",
    llm_summary: [],
    tags_json: "[]"
  };
}

export function normalizeDatabaseMetadata(raw: RawDatabaseMetadata): DatabaseMetadata {
  return {
    name: raw.name,
    description: raw.description,
    llmSummary: raw.llm_summary[0] ?? null,
    tagsJson: raw.tags_json
  };
}

export function normalizeIndexSqlJsonQueryResult(raw: RawIndexSqlJsonQueryResult): IndexSqlJsonQueryResult {
  return {
    rows: raw.rows,
    rowCount: raw.row_count.toString(),
    limit: raw.limit.toString()
  };
}

export function normalizeWikiMetrics(raw: RawWikiMetrics): WikiMetrics {
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

export function normalizeWikiMetricsPoint(raw: RawWikiMetricsPoint): WikiMetricsPoint {
  return {
    bucketStartMs: raw.bucket_start_ms.toString(),
    metrics: normalizeWikiMetrics(raw.metrics)
  };
}

export function isLocalHost(host: string): boolean {
  return host.includes("127.0.0.1") || host.includes("localhost");
}

export function normalizeDatabaseRole(role: Variant): DatabaseRole {
  if ("Owner" in role) {
    return "owner";
  }
  if ("Writer" in role) {
    return "writer";
  }
  return "reader";
}

export function normalizeDatabaseStatus(status: Variant): DatabaseStatus {
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

export function normalizeLinkEdge(raw: RawLinkEdge): LinkEdge {
  return {
    sourcePath: raw.source_path,
    targetPath: raw.target_path,
    rawHref: raw.raw_href,
    linkText: raw.link_text,
    linkKind: raw.link_kind,
    updatedAt: raw.updated_at.toString()
  };
}
