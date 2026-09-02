import { Actor, HttpAgent, type Identity } from "@icp-sdk/core/agent";
import { Principal } from "@icp-sdk/core/principal";
import { candidOptional, isLocalReplicaHost } from "@kinic/vfs-client-core";
import { classifyApiError, classifyCanisterError, invalidCanisterIdError } from "@/lib/api-errors";
import { idlFactory } from "@kinic/vfs-candid";
import type {
  CanisterHealth,
  DatabaseMetadata,
  DatabaseRole,
  DatabaseStatus,
  DatabaseSummary,
  IndexSqlJsonQueryResult,
  LinkEdge,
  WikiMetrics,
  WikiMetricsPoint
} from "@/lib/types";
import { ApiError } from "@/lib/wiki-helpers";

import type { RawDatabaseMetadata, RawDatabaseSummary, RawIndexSqlJsonQueryResult, RawLinkEdge, RawNodeMutationError, RawWikiMetrics, RawWikiMetricsPoint, Variant, VfsActor } from "./raw-types";

const DEFAULT_WIKI_IC_HOST = "https://icp0.io";

function wikiIcHost(): string {
  const viteHost = import.meta.env?.VITE_WIKI_IC_HOST;
  if (viteHost) return viteHost;
  return typeof process !== "undefined" ? process.env.VITE_WIKI_IC_HOST ?? DEFAULT_WIKI_IC_HOST : DEFAULT_WIKI_IC_HOST;
}

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
  const host = wikiIcHost();
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
  if (isLocalReplicaHost(host)) {
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
  const host = wikiIcHost();
  const agent = HttpAgent.createSync({ host, identity });
  if (isLocalReplicaHost(host)) {
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
    const host = wikiIcHost();
    const publicError = classifyApiError(error, host);
    throw new ApiError(publicError.error, 502, publicError.hint, publicError.code);
  }
}

export function throwCanisterError(message: string): never {
  const error = classifyCanisterError(message);
  throw new ApiError(error.error, error.status ?? 400, error.hint, error.code);
}

export function throwNodeMutationError(error: RawNodeMutationError): never {
  const mutation = mutationErrorMetadata(error.code);
  throw new ApiError(
    error.message,
    mutation.status,
    "The wiki canister rejected this mutation.",
    mutation.code,
    mutation.mutationCode,
    error.failed_index[0] ?? null,
    error.conflict_path[0] ?? null
  );
}

function mutationErrorMetadata(code: Variant): {
  mutationCode: "EtagConflict" | "NotFound" | "Forbidden" | "WriteUnavailable" | "InvalidOperation";
  status: number;
  code: "etag_conflict" | "node_not_found" | "forbidden" | "write_unavailable" | "invalid_operation";
} {
  if ("EtagConflict" in code) return { mutationCode: "EtagConflict", status: 409, code: "etag_conflict" };
  if ("NotFound" in code) return { mutationCode: "NotFound", status: 404, code: "node_not_found" };
  if ("Forbidden" in code) return { mutationCode: "Forbidden", status: 403, code: "forbidden" };
  if ("WriteUnavailable" in code) return { mutationCode: "WriteUnavailable", status: 503, code: "write_unavailable" };
  if ("InvalidOperation" in code) return { mutationCode: "InvalidOperation", status: 400, code: "invalid_operation" };
  throw new ApiError("Unknown node mutation error code.", 502, "The browser and canister mutation contracts may be out of sync.", "wiki_api_version_mismatch");
}


export function rawDatabaseCycleCursor(cursor: string | null): [] | [bigint] {
  if (!cursor) return [];
  if (!/^[0-9]+$/.test(cursor)) {
    throw new ApiError("Invalid cycles history cursor.", 400);
  }
  return [BigInt(cursor)];
}

export function rawTextCursor(cursor: string | null): [] | [string] {
  return cursor ? candidOptional(cursor) : [];
}

export function rawOptionalText(value: string | null): [] | [string] {
  return candidOptional(value);
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

export { isLocalReplicaHost as isLocalHost };

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
