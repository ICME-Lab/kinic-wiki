// Where: plugins/hermes/web/lib/vfs-client.ts
// What: Minimal browser-side VFS client for the Hermes evolution dashboard.
// Why: Hermes web reads and writes Skill Registry records without importing wikibrowser code.

import { Actor, HttpAgent, type Identity } from "@icp-sdk/core/agent";
import { Principal } from "@icp-sdk/core/principal";
import { classifyApiError, invalidCanisterIdError } from "@/lib/api-errors";
import { sortChildNodes } from "@/lib/child-sort";
import { normalizeSearchHit, type RawSearchHit } from "@/lib/search-normalizer";
import { idlFactory } from "@/lib/vfs-idl";
import type { ChildNode, DatabaseMember, DatabaseRole, DatabaseSummary, NodeEntryKind, NodeKind, RecentNode, WikiNode, WriteNodeRequest, WriteNodeResult, MkdirNodeRequest, MkdirNodeResult } from "@/lib/types";
import { ApiError } from "@/lib/wiki-helpers";

type Variant = Record<string, null>;
type RawNode = { path: string; kind: Variant; content: string; created_at: bigint; updated_at: bigint; etag: string; metadata_json: string };
type RawRecent = { path: string; kind: Variant; updated_at: bigint; etag: string };
type RawChild = { path: string; name: string; kind: Variant; updated_at: [] | [bigint]; etag: [] | [string]; size_bytes: [] | [bigint]; is_virtual: boolean; has_children: boolean };
type RawDatabaseSummary = { status: Variant; role: Variant; logical_size_bytes: bigint; database_id: string; name: string; archived_at_ms: [] | [bigint]; deleted_at_ms: [] | [bigint] };
type RawDatabaseMember = { database_id: string; principal: string; role: Variant; created_at_ms: bigint };
type RawWriteNodeRequest = { database_id: string; path: string; kind: Variant; content: string; metadata_json: string; expected_etag: [] | [string] };
type RawWriteNodeResult = { created: boolean; node: RawRecent };

type VfsActor = {
  list_children: (request: { database_id: string; path: string }) => Promise<{ Ok: RawChild[] } | { Err: string }>;
  list_databases: () => Promise<{ Ok: RawDatabaseSummary[] } | { Err: string }>;
  list_database_members: (databaseId: string) => Promise<{ Ok: RawDatabaseMember[] } | { Err: string }>;
  mkdir_node: (request: { database_id: string; path: string }) => Promise<{ Ok: MkdirNodeResult } | { Err: string }>;
  read_node: (databaseId: string, path: string) => Promise<{ Ok: [] | [RawNode] } | { Err: string }>;
  search_nodes: (request: { database_id: string; query_text: string; prefix: [] | [string]; top_k: number; preview_mode: [] | [Variant] }) => Promise<{ Ok: RawSearchHit[] } | { Err: string }>;
  write_node: (request: RawWriteNodeRequest) => Promise<{ Ok: RawWriteNodeResult } | { Err: string }>;
};

const actorCache = new Map<string, Promise<VfsActor>>();

export function validateCanisterId(canisterId: string): Principal | string {
  try {
    return Principal.fromText(canisterId);
  } catch (error) {
    return error instanceof Error ? error.message : "invalid canister id";
  }
}

export async function readNode(canisterId: string, databaseId: string, path: string, identity?: Identity): Promise<WikiNode | null> {
  return callVfs(async () => {
    const result = await (await createReadActor(canisterId, identity)).read_node(databaseId, path);
    if ("Err" in result) throwCanisterError(result.Err);
    return result.Ok[0] ? normalizeNode(result.Ok[0]) : null;
  });
}

export async function listChildren(canisterId: string, databaseId: string, path: string, identity?: Identity): Promise<ChildNode[]> {
  return callVfs(async () => {
    const result = await (await createReadActor(canisterId, identity)).list_children({ database_id: databaseId, path });
    if ("Err" in result) throwCanisterError(result.Err);
    return sortChildNodes(result.Ok.map(normalizeChild));
  });
}

export async function searchNodes(canisterId: string, databaseId: string, queryText: string, limit: number, prefix: string | null, identity?: Identity) {
  return callVfs(async () => {
    const result = await (await createReadActor(canisterId, identity)).search_nodes({
      database_id: databaseId,
      query_text: queryText,
      prefix: prefix ? [prefix] : [],
      top_k: limit,
      preview_mode: [{ ContentStart: null }]
    });
    if ("Err" in result) throwCanisterError(result.Err);
    return result.Ok.map(normalizeSearchHit);
  });
}

export async function listDatabasesAuthenticated(canisterId: string, identity: Identity): Promise<DatabaseSummary[]> {
  return callVfs(async () => {
    const result = await (await createAuthenticatedActor(canisterId, identity)).list_databases();
    if ("Err" in result) throw new Error(result.Err);
    return result.Ok.map(normalizeDatabaseSummary);
  });
}

export async function listDatabaseMembersAuthenticated(canisterId: string, identity: Identity, databaseId: string): Promise<DatabaseMember[]> {
  return callVfs(async () => {
    const result = await (await createAuthenticatedActor(canisterId, identity)).list_database_members(databaseId);
    if ("Err" in result) throw new Error(result.Err);
    return result.Ok.map(normalizeDatabaseMember);
  });
}

export async function listDatabaseMembersPublic(canisterId: string, databaseId: string): Promise<DatabaseMember[]> {
  return callVfs(async () => {
    const result = await (await createVfsActor(canisterId)).list_database_members(databaseId);
    if ("Err" in result) throw new Error(result.Err);
    return result.Ok.map(normalizeDatabaseMember);
  });
}

export async function writeNodeAuthenticated(canisterId: string, identity: Identity, request: WriteNodeRequest): Promise<WriteNodeResult> {
  return callVfs(async () => {
    const result = await (await createAuthenticatedActor(canisterId, identity)).write_node({
      database_id: request.databaseId,
      path: request.path,
      kind: nodeKindVariant(request.kind),
      content: request.content,
      metadata_json: request.metadataJson,
      expected_etag: request.expectedEtag ? [request.expectedEtag] : []
    });
    if ("Err" in result) throwCanisterError(result.Err);
    return { created: result.Ok.created, node: normalizeRecentNode(result.Ok.node) };
  });
}

export async function mkdirNodeAuthenticated(canisterId: string, identity: Identity, request: MkdirNodeRequest): Promise<MkdirNodeResult> {
  return callVfs(async () => {
    const result = await (await createAuthenticatedActor(canisterId, identity)).mkdir_node({ database_id: request.databaseId, path: request.path });
    if ("Err" in result) throwCanisterError(result.Err);
    return result.Ok;
  });
}

async function createVfsActor(canisterId: string): Promise<VfsActor> {
  const principal = principalOrThrow(canisterId);
  const host = process.env.NEXT_PUBLIC_WIKI_IC_HOST ?? "https://icp0.io";
  const cacheKey = `${host}\n${canisterId}`;
  const cached = actorCache.get(cacheKey);
  if (cached) return cached;
  const actor = createActor(principal, host);
  actorCache.set(cacheKey, actor);
  return actor;
}

async function createAuthenticatedActor(canisterId: string, identity: Identity): Promise<VfsActor> {
  const principal = principalOrThrow(canisterId);
  const host = process.env.NEXT_PUBLIC_WIKI_IC_HOST ?? "https://icp0.io";
  const agent = HttpAgent.createSync({ host, identity });
  if (isLocalHost(host)) await agent.fetchRootKey();
  return Actor.createActor<VfsActor>((idl) => idlFactory(idl), { agent, canisterId: principal });
}

async function createReadActor(canisterId: string, identity?: Identity): Promise<VfsActor> {
  return identity ? createAuthenticatedActor(canisterId, identity) : createVfsActor(canisterId);
}

async function createActor(principal: Principal, host: string): Promise<VfsActor> {
  const agent = HttpAgent.createSync({ host });
  if (isLocalHost(host)) await agent.fetchRootKey();
  return Actor.createActor<VfsActor>((idl) => idlFactory(idl), { agent, canisterId: principal });
}

async function callVfs<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ApiError) throw error;
    const host = process.env.NEXT_PUBLIC_WIKI_IC_HOST ?? "https://icp0.io";
    const publicError = classifyApiError(error, host);
    throw new ApiError(publicError.error, 502, publicError.hint, publicError.code);
  }
}

function principalOrThrow(canisterId: string): Principal {
  const principal = validateCanisterId(canisterId);
  if (typeof principal !== "string") return principal;
  const error = invalidCanisterIdError(principal);
  throw new ApiError(error.error, 400, error.hint, error.code);
}

function throwCanisterError(message: string): never {
  throw new ApiError(message, 400);
}

function normalizeNode(raw: RawNode): WikiNode {
  return { path: raw.path, kind: normalizeNodeKind(raw.kind), content: raw.content, createdAt: raw.created_at.toString(), updatedAt: raw.updated_at.toString(), etag: raw.etag, metadataJson: raw.metadata_json };
}

function normalizeDatabaseSummary(raw: RawDatabaseSummary): DatabaseSummary {
  return {
    databaseId: raw.database_id,
    name: raw.name,
    role: normalizeDatabaseRole(raw.role),
    status: "Deleted" in raw.status ? "deleted" : "Archived" in raw.status ? "archived" : "Archiving" in raw.status ? "archiving" : "Restoring" in raw.status ? "restoring" : "hot",
    logicalSizeBytes: raw.logical_size_bytes.toString(),
    archivedAtMs: raw.archived_at_ms[0]?.toString() ?? null,
    deletedAtMs: raw.deleted_at_ms[0]?.toString() ?? null
  };
}

function normalizeDatabaseMember(raw: RawDatabaseMember): DatabaseMember {
  return { databaseId: raw.database_id, principal: raw.principal, role: normalizeDatabaseRole(raw.role), createdAtMs: raw.created_at_ms.toString() };
}

function normalizeRecentNode(raw: RawRecent): RecentNode {
  return { path: raw.path, kind: normalizeNodeKind(raw.kind), updatedAt: raw.updated_at.toString(), etag: raw.etag };
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

function normalizeNodeKind(kind: Variant): NodeKind {
  return "Folder" in kind ? "folder" : "Source" in kind ? "source" : "file";
}

function normalizeEntryKind(kind: Variant): NodeEntryKind {
  return "Folder" in kind ? "folder" : "Directory" in kind ? "directory" : "Source" in kind ? "source" : "file";
}

function normalizeDatabaseRole(role: Variant): DatabaseRole {
  return "Owner" in role ? "owner" : "Writer" in role ? "writer" : "reader";
}

function nodeKindVariant(kind: NodeKind): Variant {
  return kind === "folder" ? { Folder: null } : kind === "source" ? { Source: null } : { File: null };
}

function isLocalHost(host: string): boolean {
  return host.includes("127.0.0.1") || host.includes("localhost");
}
