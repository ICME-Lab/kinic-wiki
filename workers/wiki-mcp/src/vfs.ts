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
  title: string;
  description: string;
  llmSummary: string | null;
  tagsJson: string;
  status: string;
};

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

type RawDatabaseMetadata = {
  title: string;
  description: string;
  llm_summary: [] | [string];
  tags_json: string;
};

type RawDatabaseSummary = {
  database_id: string;
  metadata: [] | [RawDatabaseMetadata];
  name: [] | [string];
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

type VfsActor = {
  list_databases: () => Promise<Result<RawDatabaseSummary[]>>;
  search_nodes: (request: {
    database_id: string;
    query_text: string;
    prefix: [] | [string];
    top_k: number;
    preview_mode: [] | [Variant];
  }) => Promise<Result<RawSearchHit[]>>;
  read_node: (databaseId: string, path: string) => Promise<Result<[] | [RawNode]>>;
};

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
  limit: number
): Promise<SearchHit[]> {
  const actor = await createVfsActor(env);
  const raw = unwrap(
    await actor.search_nodes({
      database_id: databaseId,
      query_text: query,
      prefix: [prefix],
      top_k: limit,
      preview_mode: [{ Light: null }]
    })
  );
  return raw.map(normalizeSearchHit);
}

export async function readNode(env: RuntimeEnv, databaseId: string, path: string): Promise<WikiNode | null> {
  const actor = await createVfsActor(env);
  const raw = unwrap(await actor.read_node(databaseId, path));
  return raw[0] ? normalizeNode(raw[0]) : null;
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
  const agent = HttpAgent.createSync({ host });
  if (isLocalHost(host)) {
    await agent.fetchRootKey();
  }
  return Actor.createActor<VfsActor>((idl) => idlFactory(idl), {
    agent,
    canisterId: Principal.fromText(resolveCanisterId(env))
  });
}

function unwrap<T>(result: Result<T>): T {
  if ("Err" in result) {
    throw new Error(result.Err);
  }
  return result.Ok;
}

function normalizeDatabaseSummary(raw: RawDatabaseSummary): DatabaseSummary {
  const metadata = raw.metadata[0] ?? null;
  return {
    databaseId: raw.database_id,
    title: metadata?.title ?? raw.name[0] ?? raw.database_id,
    description: metadata?.description ?? "",
    llmSummary: metadata?.llm_summary[0] ?? null,
    tagsJson: metadata?.tags_json ?? "[]",
    status: variantName(raw.status)
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
  const DatabaseStatus = idl.Variant({ Pending: idl.Null, Active: idl.Null, Deleted: idl.Null });
  const DatabaseRole = idl.Variant({ Reader: idl.Null, Writer: idl.Null, Owner: idl.Null });
  const DatabaseMetadata = idl.Record({
    title: idl.Text,
    description: idl.Text,
    llm_summary: idl.Opt(idl.Text),
    tags_json: idl.Text
  });
  const DatabaseSummary = idl.Record({
    database_id: idl.Text,
    metadata: idl.Opt(DatabaseMetadata),
    name: idl.Opt(idl.Text),
    role: DatabaseRole,
    status: DatabaseStatus,
    logical_size_bytes: idl.Nat64,
    cycles_balance: idl.Opt(idl.Nat64),
    cycles_suspended_at_ms: idl.Opt(idl.Int64),
    deleted_at_ms: idl.Opt(idl.Int64)
  });
  const NodeKind = idl.Variant({ File: idl.Null, Source: idl.Null, Folder: idl.Null });
  const Node = idl.Record({
    path: idl.Text,
    kind: NodeKind,
    content: idl.Text,
    created_at: idl.Int64,
    updated_at: idl.Int64,
    etag: idl.Text,
    metadata_json: idl.Text
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
  const ResultDatabases = idl.Variant({ Ok: idl.Vec(DatabaseSummary), Err: idl.Text });
  const ResultSearch = idl.Variant({ Ok: idl.Vec(SearchNodeHit), Err: idl.Text });
  const ResultNode = idl.Variant({ Ok: idl.Opt(Node), Err: idl.Text });
  return idl.Service({
    list_databases: idl.Func([], [ResultDatabases], ["query"]),
    search_nodes: idl.Func([SearchNodesRequest], [ResultSearch], ["query"]),
    read_node: idl.Func([idl.Text, idl.Text], [ResultNode], ["query"])
  });
};
