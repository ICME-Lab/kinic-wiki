// Where: workers/wiki-mcp/src/vfs.ts
// What: Minimal Kinic Wiki canister client for anonymous or delegated read-only MCP tools.
// Why: Authenticated identities stay request-scoped while the anonymous production actor may be reused.

import { Actor, HttpAgent, type Identity } from "@icp-sdk/core/agent";
import { Principal } from "@icp-sdk/core/principal";
import {
  candidOptional,
  isLocalReplicaHost as isLocalHost,
  unwrapCandidResult,
  variantName as candidVariantName
} from "@kinic/vfs-client-core";
import type { IiPermission } from "./auth/internet-identity.js";
import type { McpAuthStateV4 } from "./auth/state.js";

type ActorInterfaceFactory = Parameters<typeof Actor.createActor>[0];
type Variant = Record<string, unknown>;
type Result<T> = { Ok: T } | { Err: string };
type RawNodeMutationError = {
  code: Variant;
  message: string;
  failed_index: [] | [number];
  conflict_path: [] | [string];
};
type MutationResult<T> = { Ok: T } | { Err: RawNodeMutationError };

export type RuntimeEnv = {
  KINIC_WIKI_CANISTER_ID?: string;
  KINIC_WIKI_IC_HOST?: string;
  KINIC_WIKI_MCP_TARGET_ORIGIN?: string;
  KINIC_WIKI_PUBLIC_ORIGIN?: string;
  OPENAI_APPS_CHALLENGE_TOKEN?: string;
  MCP_ACCESS_POLICY?: string;
  MCP_WRITE_POLICY?: string;
  MCP_PUBLIC_ORIGIN?: string;
  MCP_KEY_ENCRYPTION_KEY?: string;
  MCP_AUTH_STATE?: DurableObjectNamespace<McpAuthStateV4>;
  MCP_REGISTRATION_RATE_LIMIT?: RateLimit;
  KINIC_WIKI_IDENTITY?: Identity;
  KINIC_WIKI_AUTHORIZATION?: {
    scopes: string[];
    iiPermission: IiPermission;
  };
};

export type DatabaseSummary = {
  databaseId: string;
  name: string;
  description: string;
  llmSummary: string | null;
  tagsJson: string;
  status: string;
};

export type SearchPreviewMode = "light" | "content-start" | "none";

export type SearchHit = {
  path: string;
  kind: string;
  score: number;
  snippet: string | null;
  preview: SearchPreview | null;
  matchReasons: string[];
};

export type SearchPreview = {
  excerpt: string | null;
  matchReason: string;
};

export type WikiNode = {
  path: string;
  kind: string;
  content: string;
  createdAt: string;
  updatedAt: string;
  etag: string;
  metadataJson: string;
};

export type NodeKind = "file" | "source" | "folder";

export type WriteNodeInput = {
  path: string;
  kind: NodeKind;
  content: string;
  metadataJson: string;
  expectedEtag: string | null;
};

export type AppendNodeInput = {
  path: string;
  content: string;
  expectedEtag: string | null;
  separator: string | null;
  metadataJson: string | null;
  kind: NodeKind | null;
};

export type EditNodeInput = {
  path: string;
  oldText: string;
  newText: string;
  expectedEtag: string;
  replaceAll: boolean;
};

export type MultiEditNodeInput = {
  path: string;
  edits: Array<{ oldText: string; newText: string }>;
  expectedEtag: string;
};

export type MoveNodeInput = {
  fromPath: string;
  toPath: string;
  expectedEtag: string;
  expectedTargetEtag: string | null;
  overwrite: boolean;
};

export type DeleteNodeInput = {
  path: string;
  expectedEtag: string;
  expectedFolderIndexEtag: string | null;
};

export type NodeMutationInput =
  | { type: "write"; value: WriteNodeInput }
  | { type: "append"; value: AppendNodeInput }
  | { type: "edit"; value: EditNodeInput }
  | { type: "multi_edit"; value: MultiEditNodeInput }
  | { type: "mkdir"; value: { path: string } }
  | { type: "move"; value: MoveNodeInput }
  | { type: "delete"; value: DeleteNodeInput };

export type MutationAck = {
  path: string;
  kind: NodeKind;
  updatedAt: string;
  etag: string;
};

export type WriteNodeOutput = { node: MutationAck; created: boolean };
export type EditNodeOutput = { node: MutationAck; replacementCount: number };
export type MkdirNodeOutput = { path: string; created: boolean };
export type MoveNodeOutput = { node: MutationAck; fromPath: string; overwrote: boolean };
export type DeleteNodeOutput = { path: string };

export type NodeMutationOutput =
  | { type: "write"; value: WriteNodeOutput }
  | { type: "append"; value: WriteNodeOutput }
  | { type: "edit"; value: EditNodeOutput }
  | { type: "multi_edit"; value: EditNodeOutput }
  | { type: "mkdir"; value: MkdirNodeOutput }
  | { type: "move"; value: MoveNodeOutput }
  | { type: "delete"; value: DeleteNodeOutput };

export type MutationErrorCode =
  | "etag_conflict"
  | "not_found"
  | "forbidden"
  | "invalid_operation"
  | "write_unavailable";

export class KinicMutationError extends Error {
  constructor(
    readonly code: MutationErrorCode,
    readonly failedIndex: number | null = null,
    readonly conflictPath: string | null = null,
    message: string = code
  ) {
    super(message);
    this.name = "KinicMutationError";
  }
}

export type NodeEntry = {
  path: string;
  kind: string;
  updatedAt: string;
  etag: string;
  hasChildren: boolean;
};

export type LinkEdge = {
  updatedAt: string;
  linkKind: string;
  linkText: string;
  sourcePath: string;
  rawHref: string;
  targetPath: string;
};

export type NodeContext = {
  node: WikiNode;
  incomingLinks: LinkEdge[];
  outgoingLinks: LinkEdge[];
};

export type SourceEvidenceRef = {
  linkText: string;
  viaPath: string;
  sourceContentHash: string | null;
  sourcePath: string;
  sourceUpdatedAt: string | null;
  sourceEtag: string | null;
  rawHref: string;
};

export type SourceEvidence = {
  nodePath: string;
  refs: SourceEvidenceRef[];
};

export type MemoryRoot = {
  path: string;
  kind: string;
};

export type MemoryCapability = {
  name: string;
  description: string;
};

export type CanonicalRole = {
  name: string;
  pathPattern: string;
  purpose: string;
};

export type MemoryManifest = {
  apiVersion: string;
  purpose: string;
  enabledStores: string[];
  roots: MemoryRoot[];
  entryRoots: MemoryRoot[];
  capabilities: MemoryCapability[];
  canonicalRoles: CanonicalRole[];
  writePolicy: string;
  recommendedEntrypoint: string;
  maxDepth: number;
  maxQueryLimit: number;
  budgetUnit: string;
};

export type QueryContext = {
  truncated: boolean;
  task: string;
  evidence: SourceEvidence[];
  nodes: NodeContext[];
  graphLinks: LinkEdge[];
  searchHits: SearchHit[];
  namespace: string;
};

export type IndexSqlJsonQueryResult = {
  rows: string[];
  rowCount: number;
  limit: number;
};

type RawDatabaseMetadata = {
  name: string;
  description: string;
  llm_summary: [] | [string];
  tags_json: string;
};

type RawDatabaseSummary = {
  database_id: string;
  metadata: [] | [RawDatabaseMetadata];
  name: string;
  status: Variant;
};

type RawSearchPreview = {
  excerpt: [] | [string];
  match_reason: string;
};

type RawSearchHit = {
  path: string;
  kind: Variant;
  score: number;
  snippet: [] | [string];
  preview: [] | [RawSearchPreview];
  match_reasons: string[];
};

type RawNode = {
  path: string;
  kind: Variant;
  content: string;
  created_at: bigint;
  updated_at: bigint;
  etag: string;
  metadata_json: string;
};

type RawMutationAck = {
  path: string;
  kind: Variant;
  updated_at: bigint;
  etag: string;
};

type RawWriteNodeOutput = { node: RawMutationAck; created: boolean };
type RawEditNodeOutput = { node: RawMutationAck; replacement_count: number };
type RawMkdirNodeOutput = { path: string; created: boolean };
type RawMoveNodeOutput = { node: RawMutationAck; from_path: string; overwrote: boolean };
type RawDeleteNodeOutput = { path: string };
type RawNodeMutationOutput =
  | { Write: RawWriteNodeOutput }
  | { Append: RawWriteNodeOutput }
  | { Edit: RawEditNodeOutput }
  | { MultiEdit: RawEditNodeOutput }
  | { Mkdir: RawMkdirNodeOutput }
  | { Move: RawMoveNodeOutput }
  | { Delete: RawDeleteNodeOutput };

type RawNodeEntry = {
  path: string;
  kind: Variant;
  updated_at: bigint;
  etag: string;
  has_children: boolean;
};

type RawLinkEdge = {
  updated_at: bigint;
  link_kind: string;
  link_text: string;
  source_path: string;
  raw_href: string;
  target_path: string;
};

type RawNodeContext = {
  node: RawNode;
  incoming_links: RawLinkEdge[];
  outgoing_links: RawLinkEdge[];
};

type RawSourceEvidenceRef = {
  link_text: string;
  via_path: string;
  source_content_hash: [] | [string];
  source_path: string;
  source_updated_at: [] | [bigint];
  source_etag: [] | [string];
  raw_href: string;
};

type RawSourceEvidence = {
  node_path: string;
  refs: RawSourceEvidenceRef[];
};

type RawMemoryRoot = {
  path: string;
  kind: string;
};

type RawMemoryCapability = {
  name: string;
  description: string;
};

type RawCanonicalRole = {
  name: string;
  path_pattern: string;
  purpose: string;
};

type RawMemoryManifest = {
  api_version: string;
  purpose: string;
  enabled_stores: string[];
  roots: RawMemoryRoot[];
  entry_roots: RawMemoryRoot[];
  capabilities: RawMemoryCapability[];
  canonical_roles: RawCanonicalRole[];
  write_policy: string;
  recommended_entrypoint: string;
  max_depth: number;
  max_query_limit: number;
  budget_unit: string;
};

type RawQueryContext = {
  truncated: boolean;
  task: string;
  evidence: RawSourceEvidence[];
  nodes: RawNodeContext[];
  graph_links: RawLinkEdge[];
  search_hits: RawSearchHit[];
  namespace: string;
};

type RawIndexSqlJsonQueryResult = {
  rows: string[];
  row_count: number;
  limit: number;
};

type VfsActor = {
  list_databases: () => Promise<Result<RawDatabaseSummary[]>>;
  list_nodes: (request: { database_id: string; prefix: string; recursive: boolean; limit: number }) => Promise<Result<RawNodeEntry[]>>;
  search_nodes: (request: {
    database_id: string;
    query_text: string;
    prefix: [] | [string];
    top_k: number;
    preview_mode: [] | [Variant];
  }) => Promise<Result<RawSearchHit[]>>;
  query_context: (request: {
    database_id: string;
    task: string;
    entities: string[];
    namespace: [] | [string];
    budget_tokens: number;
    include_evidence: boolean;
    depth: number;
  }) => Promise<Result<RawQueryContext>>;
  memory_manifest: (request: { database_id: string }) => Promise<Result<RawMemoryManifest>>;
  source_evidence: (request: { database_id: string; node_path: string }) => Promise<Result<RawSourceEvidence>>;
  query_database_sql_json: (databaseId: string, sql: string, limit: number) => Promise<Result<RawIndexSqlJsonQueryResult>>;
  read_node: (databaseId: string, path: string) => Promise<Result<[] | [RawNode]>>;
  write_node: (request: unknown) => Promise<MutationResult<RawWriteNodeOutput>>;
  write_nodes: (request: unknown) => Promise<MutationResult<RawWriteNodeOutput[]>>;
  append_node: (request: unknown) => Promise<MutationResult<RawWriteNodeOutput>>;
  edit_node: (request: unknown) => Promise<MutationResult<RawEditNodeOutput>>;
  multi_edit_node: (request: unknown) => Promise<MutationResult<RawEditNodeOutput>>;
  mkdir_node: (request: unknown) => Promise<MutationResult<RawMkdirNodeOutput>>;
  move_node: (request: unknown) => Promise<MutationResult<RawMoveNodeOutput>>;
  delete_node: (request: unknown) => Promise<MutationResult<RawDeleteNodeOutput>>;
  mutate_nodes_batch: (request: unknown) => Promise<MutationResult<RawNodeMutationOutput[]>>;
};

const actorCache = new Map<string, Promise<VfsActor>>();

export async function listDatabases(env: RuntimeEnv): Promise<DatabaseSummary[]> {
  const actor = await createVfsActor(env);
  const raw = unwrap(await callVfs(env, "list_databases", () => actor.list_databases()), env);
  return raw.map(normalizeDatabaseSummary).filter((database) => database.status === "active");
}

export async function searchNodes(
  env: RuntimeEnv,
  databaseId: string,
  query: string,
  prefix: string,
  limit: number,
  previewMode: SearchPreviewMode
): Promise<SearchHit[]> {
  const actor = await createVfsActor(env);
  const raw = unwrap(
    await callVfs(env, "search_nodes", () =>
      actor.search_nodes({
        database_id: databaseId,
        query_text: query,
        prefix: candidOptional(prefix),
        top_k: limit,
        preview_mode: candidOptional(rawSearchPreviewMode(previewMode))
      })
    ),
    env
  );
  return raw.map(normalizeSearchHit);
}

export async function listNodes(env: RuntimeEnv, databaseId: string, prefix: string, recursive: boolean, limit: number): Promise<NodeEntry[]> {
  const actor = await createVfsActor(env);
  const raw = unwrap(
    await callVfs(env, "list_nodes", () =>
      actor.list_nodes({ database_id: databaseId, prefix, recursive, limit })
    ),
    env
  );
  return raw.map(normalizeNodeEntry);
}

export async function readNode(env: RuntimeEnv, databaseId: string, path: string): Promise<WikiNode | null> {
  const actor = await createVfsActor(env);
  const raw = unwrap(
    await callVfs(env, "read_node", () => actor.read_node(databaseId, path)),
    env
  );
  return raw[0] ? normalizeNode(raw[0]) : null;
}

export async function writeNodes(
  env: RuntimeEnv,
  databaseId: string,
  nodes: WriteNodeInput[]
): Promise<WriteNodeOutput[]> {
  const actor = await createVfsActor(env);
  return unwrapMutation(
    await callVfs(env, "write_nodes", () =>
      actor.write_nodes({
        database_id: databaseId,
        nodes: nodes.map(rawWriteNodeItem)
      })
    )
  ).map(normalizeWriteNodeOutput);
}

export async function mutateNodesBatch(
  env: RuntimeEnv,
  databaseId: string,
  operations: NodeMutationInput[]
): Promise<NodeMutationOutput[]> {
  const actor = await createVfsActor(env);
  return unwrapMutation(
    await callVfs(env, "mutate_nodes_batch", () =>
      actor.mutate_nodes_batch({
        database_id: databaseId,
        operations: operations.map(rawNodeMutation)
      })
    )
  ).map(normalizeNodeMutationOutput);
}

export async function queryContext(
  env: RuntimeEnv,
  request: {
    databaseId: string;
    task: string;
    entities: string[];
    namespace: string;
    budgetTokens: number;
    includeEvidence: boolean;
    depth: number;
  }
): Promise<QueryContext> {
  const actor = await createVfsActor(env);
  const raw = unwrap(
    await callVfs(env, "query_context", () =>
      actor.query_context({
        database_id: request.databaseId,
        task: request.task,
        entities: request.entities,
        namespace: candidOptional(request.namespace),
        budget_tokens: request.budgetTokens,
        include_evidence: request.includeEvidence,
        depth: request.depth
      })
    ),
    env
  );
  return normalizeQueryContext(raw);
}

export async function memoryManifest(env: RuntimeEnv, databaseId: string): Promise<MemoryManifest> {
  const actor = await createVfsActor(env);
  return normalizeMemoryManifest(
    unwrap(
      await callVfs(env, "memory_manifest", () => actor.memory_manifest({ database_id: databaseId })),
      env
    )
  );
}

export async function sourceEvidence(env: RuntimeEnv, databaseId: string, nodePath: string): Promise<SourceEvidence> {
  const actor = await createVfsActor(env);
  return normalizeSourceEvidence(
    unwrap(
      await callVfs(env, "source_evidence", () =>
        actor.source_evidence({ database_id: databaseId, node_path: nodePath })
      ),
      env
    )
  );
}

export async function queryDatabaseSqlJson(
  env: RuntimeEnv,
  databaseId: string,
  sql: string,
  limit: number
): Promise<IndexSqlJsonQueryResult> {
  const actor = await createVfsActor(env);
  return normalizeIndexSqlJsonQueryResult(
    unwrap(
      await callVfs(env, "query_database_sql_json", () =>
        actor.query_database_sql_json(databaseId, sql, limit)
      ),
      env
    )
  );
}

export function resolveCanisterId(env: RuntimeEnv): string {
  const canisterId = env.KINIC_WIKI_CANISTER_ID?.trim();
  if (!canisterId) {
    throw new Error("KINIC_WIKI_CANISTER_ID is required");
  }
  Principal.fromText(canisterId);
  return canisterId;
}

function resolveIcHost(env: RuntimeEnv): string {
  return env.KINIC_WIKI_IC_HOST?.trim() || "https://icp0.io";
}

async function createVfsActor(env: RuntimeEnv): Promise<VfsActor> {
  const host = resolveIcHost(env);
  const canisterId = resolveCanisterId(env);
  if (env.KINIC_WIKI_IDENTITY) {
    return createVfsActorUncached(host, canisterId, env.KINIC_WIKI_IDENTITY);
  }
  const cacheKey = `${host}\n${canisterId}`;
  const cached = actorCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  const actor = createVfsActorUncached(host, canisterId).catch((error) => {
    actorCache.delete(cacheKey);
    throw error;
  });
  actorCache.set(cacheKey, actor);
  return actor;
}

async function createVfsActorUncached(host: string, canisterId: string, identity?: Identity): Promise<VfsActor> {
  const agent = HttpAgent.createSync({ host, identity });
  if (isLocalHost(host)) {
    await agent.fetchRootKey();
  }
  return Actor.createActor<VfsActor>((idl) => idlFactory(idl), {
    agent,
    canisterId: Principal.fromText(canisterId)
  });
}

function unwrap<T>(result: Result<T>, env: RuntimeEnv): T {
  return unwrapCandidResult(result, (message) =>
    new Error(env.KINIC_WIKI_IDENTITY ? "Kinic Wiki database is unavailable" : message)
  );
}

export function unwrapMutation<T>(result: MutationResult<T>): T {
  if ("Ok" in result) {
    return result.Ok;
  }
  throw new KinicMutationError(
    mutationErrorCode(result.Err.code),
    result.Err.failed_index[0] ?? null,
    result.Err.conflict_path[0] ?? null,
    result.Err.message
  );
}

function mutationErrorCode(code: Variant): MutationErrorCode {
  const name = variantName(code);
  switch (name) {
    case "etag_conflict":
    case "not_found":
    case "forbidden":
    case "write_unavailable":
    case "invalid_operation":
      return name;
    default:
      throw new Error(`unknown node mutation error code: ${name}`);
  }
}

async function callVfs<T, E = string>(
  env: RuntimeEnv,
  stage: string,
  call: () => Promise<{ Ok: T } | { Err: E }>
): Promise<{ Ok: T } | { Err: E }> {
  try {
    const result = await call();
    if ("Err" in result) {
      logAuthenticatedVfsFailure(env, `${stage}_result`);
    }
    return result;
  } catch (error) {
    if (!env.KINIC_WIKI_IDENTITY) {
      throw error;
    }
    logAuthenticatedVfsFailure(env, `${stage}_call`);
    throw new Error("Kinic Wiki database is unavailable");
  }
}

function logAuthenticatedVfsFailure(env: RuntimeEnv, stage: string): void {
  if (!env.KINIC_WIKI_IDENTITY) {
    return;
  }
  console.error(
    JSON.stringify({
      event: "vfs_call",
      trace_id: crypto.randomUUID(),
      stage,
      error_code: "database_unavailable"
    })
  );
}

function normalizeDatabaseSummary(raw: RawDatabaseSummary): DatabaseSummary {
  const metadata = databaseMetadata(raw);
  return {
    databaseId: raw.database_id,
    name: metadata.name,
    description: metadata.description,
    llmSummary: metadata.llm_summary[0] ?? null,
    tagsJson: metadata.tags_json,
    status: variantName(raw.status)
  };
}

function databaseMetadata(raw: RawDatabaseSummary): RawDatabaseMetadata {
  return raw.metadata[0] ?? {
    name: raw.name,
    description: "",
    llm_summary: [],
    tags_json: "[]"
  };
}

function normalizeSearchHit(raw: RawSearchHit): SearchHit {
  return {
    path: raw.path,
    kind: variantName(raw.kind),
    score: raw.score,
    snippet: raw.snippet[0] ?? null,
    preview: raw.preview[0]
      ? {
          excerpt: raw.preview[0].excerpt[0] ?? null,
          matchReason: raw.preview[0].match_reason
        }
      : null,
    matchReasons: raw.match_reasons
  };
}

function normalizeNodeEntry(raw: RawNodeEntry): NodeEntry {
  return {
    path: raw.path,
    kind: variantName(raw.kind),
    updatedAt: raw.updated_at.toString(),
    etag: raw.etag,
    hasChildren: raw.has_children
  };
}

function normalizeNode(raw: RawNode): WikiNode {
  return {
    path: raw.path,
    kind: variantName(raw.kind),
    content: raw.content,
    createdAt: raw.created_at.toString(),
    updatedAt: raw.updated_at.toString(),
    etag: raw.etag,
    metadataJson: raw.metadata_json
  };
}

function normalizeMutationAck(raw: RawMutationAck): MutationAck {
  return {
    path: raw.path,
    kind: variantName(raw.kind) as NodeKind,
    updatedAt: raw.updated_at.toString(),
    etag: raw.etag
  };
}

function normalizeWriteNodeOutput(raw: RawWriteNodeOutput): WriteNodeOutput {
  return { node: normalizeMutationAck(raw.node), created: raw.created };
}

function normalizeEditNodeOutput(raw: RawEditNodeOutput): EditNodeOutput {
  return { node: normalizeMutationAck(raw.node), replacementCount: raw.replacement_count };
}

function normalizeMoveNodeOutput(raw: RawMoveNodeOutput): MoveNodeOutput {
  return {
    node: normalizeMutationAck(raw.node),
    fromPath: raw.from_path,
    overwrote: raw.overwrote
  };
}

function normalizeNodeMutationOutput(raw: RawNodeMutationOutput): NodeMutationOutput {
  if ("Write" in raw) return { type: "write", value: normalizeWriteNodeOutput(raw.Write) };
  if ("Append" in raw) return { type: "append", value: normalizeWriteNodeOutput(raw.Append) };
  if ("Edit" in raw) return { type: "edit", value: normalizeEditNodeOutput(raw.Edit) };
  if ("MultiEdit" in raw) return { type: "multi_edit", value: normalizeEditNodeOutput(raw.MultiEdit) };
  if ("Mkdir" in raw) return { type: "mkdir", value: raw.Mkdir };
  if ("Move" in raw) return { type: "move", value: normalizeMoveNodeOutput(raw.Move) };
  return { type: "delete", value: raw.Delete };
}

function normalizeLinkEdge(raw: RawLinkEdge): LinkEdge {
  return {
    updatedAt: raw.updated_at.toString(),
    linkKind: raw.link_kind,
    linkText: raw.link_text,
    sourcePath: raw.source_path,
    rawHref: raw.raw_href,
    targetPath: raw.target_path
  };
}

function normalizeNodeContext(raw: RawNodeContext): NodeContext {
  return {
    node: normalizeNode(raw.node),
    incomingLinks: raw.incoming_links.map(normalizeLinkEdge),
    outgoingLinks: raw.outgoing_links.map(normalizeLinkEdge)
  };
}

function normalizeSourceEvidence(raw: RawSourceEvidence): SourceEvidence {
  return {
    nodePath: raw.node_path,
    refs: raw.refs.map((ref) => ({
      linkText: ref.link_text,
      viaPath: ref.via_path,
      sourceContentHash: ref.source_content_hash[0] ?? null,
      sourcePath: ref.source_path,
      sourceUpdatedAt: ref.source_updated_at[0]?.toString() ?? null,
      sourceEtag: ref.source_etag[0] ?? null,
      rawHref: ref.raw_href
    }))
  };
}

function normalizeMemoryManifest(raw: RawMemoryManifest): MemoryManifest {
  return {
    apiVersion: raw.api_version,
    purpose: raw.purpose,
    enabledStores: raw.enabled_stores,
    roots: raw.roots.map(normalizeMemoryRoot),
    entryRoots: raw.entry_roots.map(normalizeMemoryRoot),
    capabilities: raw.capabilities.map((capability) => ({
      name: capability.name,
      description: capability.description
    })),
    canonicalRoles: raw.canonical_roles.map((role) => ({
      name: role.name,
      pathPattern: role.path_pattern,
      purpose: role.purpose
    })),
    writePolicy: raw.write_policy,
    recommendedEntrypoint: raw.recommended_entrypoint,
    maxDepth: raw.max_depth,
    maxQueryLimit: raw.max_query_limit,
    budgetUnit: raw.budget_unit
  };
}

function normalizeMemoryRoot(raw: RawMemoryRoot): MemoryRoot {
  return {
    path: raw.path,
    kind: raw.kind
  };
}

function normalizeQueryContext(raw: RawQueryContext): QueryContext {
  return {
    truncated: raw.truncated,
    task: raw.task,
    evidence: raw.evidence.map(normalizeSourceEvidence),
    nodes: raw.nodes.map(normalizeNodeContext),
    graphLinks: raw.graph_links.map(normalizeLinkEdge),
    searchHits: raw.search_hits.map(normalizeSearchHit),
    namespace: raw.namespace
  };
}

function normalizeIndexSqlJsonQueryResult(raw: RawIndexSqlJsonQueryResult): IndexSqlJsonQueryResult {
  return {
    rows: raw.rows,
    rowCount: raw.row_count,
    limit: raw.limit
  };
}

function rawNodeKind(kind: NodeKind): Variant {
  if (kind === "source") return { Source: null };
  if (kind === "folder") return { Folder: null };
  return { File: null };
}

function rawWriteNodeItem(input: WriteNodeInput) {
  return {
    path: input.path,
    kind: rawNodeKind(input.kind),
    content: input.content,
    metadata_json: input.metadataJson,
    expected_etag: candidOptional(input.expectedEtag)
  };
}

function rawEditNodeRequest(databaseId: string, input: EditNodeInput) {
  return {
    database_id: databaseId,
    path: input.path,
    old_text: input.oldText,
    new_text: input.newText,
    expected_etag: candidOptional(input.expectedEtag),
    replace_all: input.replaceAll
  };
}

function rawMultiEditNodeRequest(databaseId: string, input: MultiEditNodeInput) {
  return {
    database_id: databaseId,
    path: input.path,
    edits: input.edits.map((edit) => ({ old_text: edit.oldText, new_text: edit.newText })),
    expected_etag: candidOptional(input.expectedEtag)
  };
}

function rawMoveNodeRequest(databaseId: string, input: MoveNodeInput) {
  return {
    database_id: databaseId,
    from_path: input.fromPath,
    to_path: input.toPath,
    expected_etag: candidOptional(input.expectedEtag),
    expected_target_etag: candidOptional(input.expectedTargetEtag),
    overwrite: input.overwrite
  };
}

function rawDeleteNodeRequest(databaseId: string, input: DeleteNodeInput) {
  return {
    database_id: databaseId,
    path: input.path,
    expected_etag: candidOptional(input.expectedEtag),
    expected_folder_index_etag: candidOptional(input.expectedFolderIndexEtag)
  };
}

function rawNodeMutation(operation: NodeMutationInput): Variant {
  switch (operation.type) {
    case "write":
      return { Write: rawWriteNodeItem(operation.value) };
    case "append":
      return {
        Append: {
          path: operation.value.path,
          content: operation.value.content,
          expected_etag: candidOptional(operation.value.expectedEtag),
          separator: candidOptional(operation.value.separator),
          metadata_json: candidOptional(operation.value.metadataJson),
          kind: candidOptional(operation.value.kind ? rawNodeKind(operation.value.kind) : null)
        }
      };
    case "edit": {
      const { database_id: _, ...item } = rawEditNodeRequest("", operation.value);
      return { Edit: item };
    }
    case "multi_edit": {
      const { database_id: _, ...item } = rawMultiEditNodeRequest("", operation.value);
      return { MultiEdit: item };
    }
    case "mkdir":
      return { Mkdir: operation.value.path };
    case "move": {
      const { database_id: _, ...item } = rawMoveNodeRequest("", operation.value);
      return { Move: item };
    }
    case "delete": {
      const { database_id: _, ...item } = rawDeleteNodeRequest("", operation.value);
      return { Delete: item };
    }
  }
}

function rawSearchPreviewMode(mode: SearchPreviewMode): Variant {
  if (mode === "content-start") {
    return { ContentStart: null };
  }
  if (mode === "none") {
    return { None: null };
  }
  return { Light: null };
}

function variantName(value: Variant): string {
  const key = candidVariantName(value) ?? "unknown";
  return key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

const idlFactory: ActorInterfaceFactory = ({ IDL: idl }) => {
  const DatabaseStatus = idl.Variant({
    Pending: idl.Null,
    Active: idl.Null,
    Deleted: idl.Null
  });
  const DatabaseRole = idl.Variant({ Reader: idl.Null, Writer: idl.Null, Owner: idl.Null });
  const DatabaseMetadata = idl.Record({
    name: idl.Text,
    description: idl.Text,
    llm_summary: idl.Opt(idl.Text),
    tags_json: idl.Text
  });
  const DatabaseSummary = idl.Record({
    database_id: idl.Text,
    metadata: idl.Opt(DatabaseMetadata),
    name: idl.Text,
    role: DatabaseRole,
    status: DatabaseStatus,
    logical_size_bytes: idl.Nat64,
    cycles_balance: idl.Opt(idl.Nat64),
    cycles_suspended_at_ms: idl.Opt(idl.Int64),
    deleted_at_ms: idl.Opt(idl.Int64)
  });
  const NodeKind = idl.Variant({ File: idl.Null, Source: idl.Null, Folder: idl.Null });
  const NodeEntryKind = idl.Variant({ File: idl.Null, Source: idl.Null, Folder: idl.Null, Directory: idl.Null });
  const Node = idl.Record({
    path: idl.Text,
    kind: NodeKind,
    content: idl.Text,
    created_at: idl.Int64,
    updated_at: idl.Int64,
    etag: idl.Text,
    metadata_json: idl.Text
  });
  const NodeMutationAck = idl.Record({
    path: idl.Text,
    kind: NodeKind,
    updated_at: idl.Int64,
    etag: idl.Text
  });
  const NodeMutationErrorCode = idl.Variant({
    EtagConflict: idl.Null,
    NotFound: idl.Null,
    Forbidden: idl.Null,
    WriteUnavailable: idl.Null,
    InvalidOperation: idl.Null
  });
  const NodeMutationError = idl.Record({
    code: NodeMutationErrorCode,
    message: idl.Text,
    failed_index: idl.Opt(idl.Nat32),
    conflict_path: idl.Opt(idl.Text)
  });
  const WriteNodeResult = idl.Record({ node: NodeMutationAck, created: idl.Bool });
  const EditNodeResult = idl.Record({ node: NodeMutationAck, replacement_count: idl.Nat32 });
  const MkdirNodeResult = idl.Record({ path: idl.Text, created: idl.Bool });
  const MoveNodeResult = idl.Record({
    node: NodeMutationAck,
    from_path: idl.Text,
    overwrote: idl.Bool
  });
  const DeleteNodeResult = idl.Record({ path: idl.Text });
  const WriteNodeItem = idl.Record({
    path: idl.Text,
    kind: NodeKind,
    content: idl.Text,
    metadata_json: idl.Text,
    expected_etag: idl.Opt(idl.Text)
  });
  const WriteNodeRequest = idl.Record({
    database_id: idl.Text,
    path: idl.Text,
    kind: NodeKind,
    content: idl.Text,
    metadata_json: idl.Text,
    expected_etag: idl.Opt(idl.Text)
  });
  const WriteNodesRequest = idl.Record({ database_id: idl.Text, nodes: idl.Vec(WriteNodeItem) });
  const AppendNodeItem = idl.Record({
    path: idl.Text,
    content: idl.Text,
    expected_etag: idl.Opt(idl.Text),
    separator: idl.Opt(idl.Text),
    metadata_json: idl.Opt(idl.Text),
    kind: idl.Opt(NodeKind)
  });
  const AppendNodeRequest = idl.Record({
    database_id: idl.Text,
    path: idl.Text,
    content: idl.Text,
    expected_etag: idl.Opt(idl.Text),
    separator: idl.Opt(idl.Text),
    metadata_json: idl.Opt(idl.Text),
    kind: idl.Opt(NodeKind)
  });
  const EditNodeItem = idl.Record({
    path: idl.Text,
    old_text: idl.Text,
    new_text: idl.Text,
    expected_etag: idl.Opt(idl.Text),
    replace_all: idl.Bool
  });
  const EditNodeRequest = idl.Record({
    database_id: idl.Text,
    path: idl.Text,
    old_text: idl.Text,
    new_text: idl.Text,
    expected_etag: idl.Opt(idl.Text),
    replace_all: idl.Bool
  });
  const MultiEdit = idl.Record({ old_text: idl.Text, new_text: idl.Text });
  const MultiEditNodeItem = idl.Record({
    path: idl.Text,
    edits: idl.Vec(MultiEdit),
    expected_etag: idl.Opt(idl.Text)
  });
  const MultiEditNodeRequest = idl.Record({
    database_id: idl.Text,
    path: idl.Text,
    edits: idl.Vec(MultiEdit),
    expected_etag: idl.Opt(idl.Text)
  });
  const MkdirNodeRequest = idl.Record({ database_id: idl.Text, path: idl.Text });
  const MoveNodeItem = idl.Record({
    from_path: idl.Text,
    to_path: idl.Text,
    expected_etag: idl.Opt(idl.Text),
    expected_target_etag: idl.Opt(idl.Text),
    overwrite: idl.Bool
  });
  const MoveNodeRequest = idl.Record({
    database_id: idl.Text,
    from_path: idl.Text,
    to_path: idl.Text,
    expected_etag: idl.Opt(idl.Text),
    expected_target_etag: idl.Opt(idl.Text),
    overwrite: idl.Bool
  });
  const DeleteNodeItem = idl.Record({
    path: idl.Text,
    expected_etag: idl.Opt(idl.Text),
    expected_folder_index_etag: idl.Opt(idl.Text)
  });
  const DeleteNodeRequest = idl.Record({
    database_id: idl.Text,
    path: idl.Text,
    expected_etag: idl.Opt(idl.Text),
    expected_folder_index_etag: idl.Opt(idl.Text)
  });
  const NodeMutation = idl.Variant({
    Write: WriteNodeItem,
    Append: AppendNodeItem,
    Edit: EditNodeItem,
    MultiEdit: MultiEditNodeItem,
    Mkdir: idl.Text,
    Move: MoveNodeItem,
    Delete: DeleteNodeItem
  });
  const MutateNodesBatchRequest = idl.Record({
    database_id: idl.Text,
    operations: idl.Vec(NodeMutation)
  });
  const NodeMutationResult = idl.Variant({
    Write: WriteNodeResult,
    Append: WriteNodeResult,
    Edit: EditNodeResult,
    MultiEdit: EditNodeResult,
    Mkdir: MkdirNodeResult,
    Move: MoveNodeResult,
    Delete: DeleteNodeResult
  });
  const NodeEntry = idl.Record({
    path: idl.Text,
    kind: NodeEntryKind,
    updated_at: idl.Int64,
    etag: idl.Text,
    has_children: idl.Bool
  });
  const LinkEdge = idl.Record({
    updated_at: idl.Int64,
    link_kind: idl.Text,
    link_text: idl.Text,
    source_path: idl.Text,
    raw_href: idl.Text,
    target_path: idl.Text
  });
  const NodeContext = idl.Record({
    node: Node,
    incoming_links: idl.Vec(LinkEdge),
    outgoing_links: idl.Vec(LinkEdge)
  });
  const SearchPreviewField = idl.Variant({ Path: idl.Null, Content: idl.Null });
  const SearchPreviewMode = idl.Variant({ Light: idl.Null, ContentStart: idl.Null, None: idl.Null });
  const SearchPreview = idl.Record({
    field: SearchPreviewField,
    char_offset: idl.Nat32,
    match_reason: idl.Text,
    excerpt: idl.Opt(idl.Text)
  });
  const SearchNodeHit = idl.Record({
    path: idl.Text,
    kind: NodeKind,
    snippet: idl.Opt(idl.Text),
    preview: idl.Opt(SearchPreview),
    score: idl.Float32,
    match_reasons: idl.Vec(idl.Text)
  });
  const SearchNodesRequest = idl.Record({
    database_id: idl.Text,
    query_text: idl.Text,
    prefix: idl.Opt(idl.Text),
    top_k: idl.Nat32,
    preview_mode: idl.Opt(SearchPreviewMode)
  });
  const ListNodesRequest = idl.Record({
    database_id: idl.Text,
    prefix: idl.Text,
    recursive: idl.Bool,
    limit: idl.Nat32
  });
  const SourceEvidenceRef = idl.Record({
    link_text: idl.Text,
    via_path: idl.Text,
    source_content_hash: idl.Opt(idl.Text),
    source_path: idl.Text,
    source_updated_at: idl.Opt(idl.Int64),
    source_etag: idl.Opt(idl.Text),
    raw_href: idl.Text
  });
  const SourceEvidence = idl.Record({
    node_path: idl.Text,
    refs: idl.Vec(SourceEvidenceRef)
  });
  const MemoryRoot = idl.Record({
    path: idl.Text,
    kind: idl.Text
  });
  const MemoryCapability = idl.Record({
    name: idl.Text,
    description: idl.Text
  });
  const CanonicalRole = idl.Record({
    name: idl.Text,
    path_pattern: idl.Text,
    purpose: idl.Text
  });
  const MemoryManifest = idl.Record({
    api_version: idl.Text,
    purpose: idl.Text,
    enabled_stores: idl.Vec(idl.Text),
    roots: idl.Vec(MemoryRoot),
    entry_roots: idl.Vec(MemoryRoot),
    capabilities: idl.Vec(MemoryCapability),
    canonical_roles: idl.Vec(CanonicalRole),
    write_policy: idl.Text,
    recommended_entrypoint: idl.Text,
    max_depth: idl.Nat32,
    max_query_limit: idl.Nat32,
    budget_unit: idl.Text
  });
  const QueryContext = idl.Record({
    truncated: idl.Bool,
    task: idl.Text,
    evidence: idl.Vec(SourceEvidence),
    nodes: idl.Vec(NodeContext),
    graph_links: idl.Vec(LinkEdge),
    search_hits: idl.Vec(SearchNodeHit),
    namespace: idl.Text
  });
  const QueryContextRequest = idl.Record({
    database_id: idl.Text,
    task: idl.Text,
    entities: idl.Vec(idl.Text),
    namespace: idl.Opt(idl.Text),
    budget_tokens: idl.Nat32,
    include_evidence: idl.Bool,
    depth: idl.Nat32
  });
  const DatabaseIdRequest = idl.Record({ database_id: idl.Text });
  const SourceEvidenceRequest = idl.Record({
    database_id: idl.Text,
    node_path: idl.Text
  });
  const ResultDatabases = idl.Variant({ Ok: idl.Vec(DatabaseSummary), Err: idl.Text });
  const ResultNodes = idl.Variant({ Ok: idl.Vec(NodeEntry), Err: idl.Text });
  const ResultSearch = idl.Variant({ Ok: idl.Vec(SearchNodeHit), Err: idl.Text });
  const ResultNode = idl.Variant({ Ok: idl.Opt(Node), Err: idl.Text });
  const ResultWriteNode = idl.Variant({ Ok: WriteNodeResult, Err: NodeMutationError });
  const ResultWriteNodes = idl.Variant({ Ok: idl.Vec(WriteNodeResult), Err: NodeMutationError });
  const ResultEditNode = idl.Variant({ Ok: EditNodeResult, Err: NodeMutationError });
  const ResultMkdirNode = idl.Variant({ Ok: MkdirNodeResult, Err: NodeMutationError });
  const ResultMoveNode = idl.Variant({ Ok: MoveNodeResult, Err: NodeMutationError });
  const ResultDeleteNode = idl.Variant({ Ok: DeleteNodeResult, Err: NodeMutationError });
  const ResultMutationBatch = idl.Variant({
    Ok: idl.Vec(NodeMutationResult),
    Err: NodeMutationError
  });
  const ResultMemoryManifest = idl.Variant({ Ok: MemoryManifest, Err: idl.Text });
  const ResultQueryContext = idl.Variant({ Ok: QueryContext, Err: idl.Text });
  const ResultSourceEvidence = idl.Variant({ Ok: SourceEvidence, Err: idl.Text });
  const IndexSqlJsonQueryResult = idl.Record({
    rows: idl.Vec(idl.Text),
    row_count: idl.Nat32,
    limit: idl.Nat32
  });
  const ResultIndexSqlJsonQuery = idl.Variant({ Ok: IndexSqlJsonQueryResult, Err: idl.Text });
  return idl.Service({
    list_databases: idl.Func([], [ResultDatabases], ["query"]),
    list_nodes: idl.Func([ListNodesRequest], [ResultNodes], ["query"]),
    search_nodes: idl.Func([SearchNodesRequest], [ResultSearch], ["query"]),
    memory_manifest: idl.Func([DatabaseIdRequest], [ResultMemoryManifest], ["query"]),
    query_context: idl.Func([QueryContextRequest], [ResultQueryContext], ["query"]),
    source_evidence: idl.Func([SourceEvidenceRequest], [ResultSourceEvidence], ["query"]),
    query_database_sql_json: idl.Func([idl.Text, idl.Text, idl.Nat32], [ResultIndexSqlJsonQuery], ["query"]),
    read_node: idl.Func([idl.Text, idl.Text], [ResultNode], ["query"]),
    write_node: idl.Func([WriteNodeRequest], [ResultWriteNode], []),
    write_nodes: idl.Func([WriteNodesRequest], [ResultWriteNodes], []),
    append_node: idl.Func([AppendNodeRequest], [ResultWriteNode], []),
    edit_node: idl.Func([EditNodeRequest], [ResultEditNode], []),
    multi_edit_node: idl.Func([MultiEditNodeRequest], [ResultEditNode], []),
    mkdir_node: idl.Func([MkdirNodeRequest], [ResultMkdirNode], []),
    move_node: idl.Func([MoveNodeRequest], [ResultMoveNode], []),
    delete_node: idl.Func([DeleteNodeRequest], [ResultDeleteNode], []),
    mutate_nodes_batch: idl.Func([MutateNodesBatchRequest], [ResultMutationBatch], [])
  });
};
