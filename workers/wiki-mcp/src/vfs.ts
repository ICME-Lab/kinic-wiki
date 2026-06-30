// Where: workers/wiki-mcp/src/vfs.ts
// What: Minimal anonymous Kinic Wiki canister client for public read-only MCP tools.
// Why: Remote MCP must reuse the canister read contract without depending on the browser app.

import { Actor, HttpAgent } from "@icp-sdk/core/agent";
import { Principal } from "@icp-sdk/core/principal";

type ActorInterfaceFactory = Parameters<typeof Actor.createActor>[0];
type Variant = Record<string, null>;
type Result<T> = { Ok: T } | { Err: string };

export type RuntimeEnv = {
  KINIC_WIKI_CANISTER_ID?: string;
  KINIC_WIKI_IC_HOST?: string;
  KINIC_WIKI_PUBLIC_ORIGIN?: string;
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
  query_database_sql_json: (databaseId: string, sql: string, limit: number) => Promise<Result<RawIndexSqlJsonQueryResult>>;
  read_node: (databaseId: string, path: string) => Promise<Result<[] | [RawNode]>>;
};

const actorCache = new Map<string, Promise<VfsActor>>();

export async function listDatabases(env: RuntimeEnv): Promise<DatabaseSummary[]> {
  const actor = await createVfsActor(env);
  const raw = unwrap(await actor.list_databases());
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
    await actor.search_nodes({
      database_id: databaseId,
      query_text: query,
      prefix: [prefix],
      top_k: limit,
      preview_mode: [rawSearchPreviewMode(previewMode)]
    })
  );
  return raw.map(normalizeSearchHit);
}

export async function listNodes(env: RuntimeEnv, databaseId: string, prefix: string, recursive: boolean, limit: number): Promise<NodeEntry[]> {
  const actor = await createVfsActor(env);
  const raw = unwrap(await actor.list_nodes({ database_id: databaseId, prefix, recursive, limit }));
  return raw.map(normalizeNodeEntry);
}

export async function readNode(env: RuntimeEnv, databaseId: string, path: string): Promise<WikiNode | null> {
  const actor = await createVfsActor(env);
  const raw = unwrap(await actor.read_node(databaseId, path));
  return raw[0] ? normalizeNode(raw[0]) : null;
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
    await actor.query_context({
      database_id: request.databaseId,
      task: request.task,
      entities: request.entities,
      namespace: [request.namespace],
      budget_tokens: request.budgetTokens,
      include_evidence: request.includeEvidence,
      depth: request.depth
    })
  );
  return normalizeQueryContext(raw);
}

export async function queryDatabaseSqlJson(
  env: RuntimeEnv,
  databaseId: string,
  sql: string,
  limit: number
): Promise<IndexSqlJsonQueryResult> {
  const actor = await createVfsActor(env);
  return normalizeIndexSqlJsonQueryResult(unwrap(await actor.query_database_sql_json(databaseId, sql, limit)));
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

async function createVfsActorUncached(host: string, canisterId: string): Promise<VfsActor> {
  const agent = HttpAgent.createSync({ host });
  if (isLocalHost(host)) {
    await agent.fetchRootKey();
  }
  return Actor.createActor<VfsActor>((idl) => idlFactory(idl), {
    agent,
    canisterId: Principal.fromText(canisterId)
  });
}

function unwrap<T>(result: Result<T>): T {
  if ("Err" in result) {
    throw new Error(result.Err);
  }
  return result.Ok;
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
  const key = Object.keys(value)[0] ?? "unknown";
  return key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

function isLocalHost(host: string): boolean {
  try {
    const hostname = new URL(host).hostname;
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
  } catch {
    return false;
  }
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
  const ResultDatabases = idl.Variant({ Ok: idl.Vec(DatabaseSummary), Err: idl.Text });
  const ResultNodes = idl.Variant({ Ok: idl.Vec(NodeEntry), Err: idl.Text });
  const ResultSearch = idl.Variant({ Ok: idl.Vec(SearchNodeHit), Err: idl.Text });
  const ResultNode = idl.Variant({ Ok: idl.Opt(Node), Err: idl.Text });
  const ResultQueryContext = idl.Variant({ Ok: QueryContext, Err: idl.Text });
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
    query_context: idl.Func([QueryContextRequest], [ResultQueryContext], ["query"]),
    query_database_sql_json: idl.Func([idl.Text, idl.Text, idl.Nat32], [ResultIndexSqlJsonQuery], ["query"]),
    read_node: idl.Func([idl.Text, idl.Text], [ResultNode], ["query"])
  });
};
