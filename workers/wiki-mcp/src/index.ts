// Where: workers/wiki-mcp/src/index.ts
// What: Remote MCP entrypoint exposing public Kinic Wiki database discovery, search, and fetch.
// Why: ChatGPT should read public wiki memory through anonymous canister queries without write access.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { listDatabases, readNode, resolveCanisterId, searchNodes, type DatabaseSummary, type RuntimeEnv, type SearchHit, type WikiNode } from "./vfs.js";

const TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: false,
  destructiveHint: false
} as const;

const DEFAULT_DATABASE_LIMIT = 10;
const MAX_DATABASE_LIMIT = 50;
const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 20;
const MAX_FETCH_TEXT_CHARS = 40_000;
const DEFAULT_PREFIX = "/";
const DEFAULT_PUBLIC_ORIGIN = "https://wiki.kinic.xyz";
const MCP_TOOL_NAMES = ["find_databases", "search", "fetch"] as const;

export default {
  async fetch(request: Request, env: RuntimeEnv): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }));
    }
    if (request.method === "GET" && url.pathname === "/") {
      return withCors(Response.json(rootInfo(url)));
    }
    if (request.method === "GET" && url.pathname === "/health") {
      return withCors(Response.json({ ok: true, name: "kinic-wiki-mcp" }));
    }
    if (url.pathname !== "/mcp" || (request.method !== "POST" && request.method !== "GET")) {
      return withCors(Response.json({ error: "not found" }, { status: 404 }));
    }

    const server = createServer(env);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    if (request.method === "GET") {
      return withCors(await transport.handleRequest(request));
    }

    let parsedBody: unknown;
    try {
      parsedBody = await parseJsonBody(request);
    } catch {
      return withCors(Response.json({ error: "bad request" }, { status: 400 }));
    }
    return withCors(await transport.handleRequest(request, { parsedBody }));
  }
} satisfies ExportedHandler<RuntimeEnv>;

function rootInfo(url: URL) {
  return {
    name: "kinic-wiki-mcp",
    description: "Public, anonymous, read-only Kinic Wiki MCP server.",
    mcp_endpoint: new URL("/mcp", url.origin).toString(),
    health_endpoint: new URL("/health", url.origin).toString(),
    tools: [...MCP_TOOL_NAMES]
  };
}

export function createServer(env: RuntimeEnv): McpServer {
  const server = new McpServer(
    {
      name: "kinic-wiki-mcp",
      version: "0.1.0"
    },
    {
      instructions:
        "Use find_databases first when the user has not provided a Kinic Wiki database id. Use search with the selected database_id, then fetch result ids before answering from node text."
    }
  );

  server.registerTool(
    "find_databases",
    {
      description: "Use this when you need to discover which anonymous-readable public Kinic Wiki database matches a user task.",
      inputSchema: {
        query: z.string().optional(),
        limit: z.number().int().min(1).max(MAX_DATABASE_LIMIT).optional()
      },
      annotations: TOOL_ANNOTATIONS
    },
    async ({ query, limit }) => toToolResult(await findDatabases(env, { query, limit }))
  );

  server.registerTool(
    "search",
    {
      description: "Use this when you need to search one selected public Kinic Wiki database for relevant nodes.",
      inputSchema: {
        database_id: z.string().min(1),
        query: z.string().min(1),
        prefix: z.string().optional(),
        limit: z.number().int().min(1).max(MAX_SEARCH_LIMIT).optional()
      },
      annotations: TOOL_ANNOTATIONS
    },
    async ({ database_id, query, prefix, limit }) =>
      toToolResult(await searchDatabase(env, { database_id, query, prefix, limit }))
  );

  server.registerTool(
    "fetch",
    {
      description: "Use this when you need the full text for one Kinic Wiki search result id returned by search.",
      inputSchema: {
        id: z.string().min(1)
      },
      annotations: TOOL_ANNOTATIONS
    },
    async ({ id }) => toToolResult(await fetchSearchResult(env, { id }))
  );

  return server;
}

export type FindDatabasesInput = {
  query?: string;
  limit?: number;
};

export type SearchInput = {
  database_id: string;
  query: string;
  prefix?: string;
  limit?: number;
};

export type FetchInput = {
  id: string;
};

export type SearchResultId = {
  version: 1;
  canister_id: string;
  database_id: string;
  path: string;
};

export async function findDatabases(env: RuntimeEnv, input: FindDatabasesInput) {
  const query = normalizeQuery(input.query ?? "");
  const limit = clampInt(input.limit, DEFAULT_DATABASE_LIMIT, MAX_DATABASE_LIMIT);
  const databases = await listDatabases(env);
  return {
    databases: rankDatabases(databases, query)
      .slice(0, limit)
      .map(({ database, score }) => ({
        database_id: database.databaseId,
        title: database.title,
        description: database.description,
        tags: parseTags(database.tagsJson),
        url: databaseUrl(env, database.databaseId),
        score
      }))
  };
}

export async function searchDatabase(env: RuntimeEnv, input: SearchInput) {
  const databaseId = input.database_id.trim();
  if (!databaseId) {
    return toolError("database_id is required", { error: "database_id is required" });
  }
  const query = normalizeQuery(input.query);
  if (!query) {
    return toolError("query is required", { error: "query is required", database_id: databaseId });
  }
  const prefix = normalizePrefix(input.prefix);
  const limit = clampInt(input.limit, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
  const canisterId = resolveCanisterId(env);
  const hits = await searchNodes(env, databaseId, query, prefix, limit);
  return {
    results: orderSearchHitsForRetrieval(hits).map((hit) => searchResult(env, canisterId, databaseId, hit))
  };
}

export async function fetchSearchResult(env: RuntimeEnv, input: FetchInput) {
  const decoded = decodeSearchResultId(input.id);
  if (!decoded) {
    return toolError("invalid search result id", { error: "invalid search result id", id: input.id });
  }
  const canisterId = resolveCanisterId(env);
  if (decoded.canister_id !== canisterId) {
    return toolError("search result id is for another canister", {
      error: "search result id is for another canister",
      id: input.id
    });
  }
  const node = await readNode(env, decoded.database_id, decoded.path);
  if (!node) {
    return toolError("node not found", { error: "node not found", id: input.id });
  }
  return fetchedNode(env, input.id, decoded.database_id, node);
}

export function encodeSearchResultId(payload: SearchResultId): string {
  return `kinic-wiki:${base64UrlEncode(JSON.stringify(payload))}`;
}

export function decodeSearchResultId(id: string): SearchResultId | null {
  if (!id.startsWith("kinic-wiki:")) {
    return null;
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(base64UrlDecode(id.slice("kinic-wiki:".length)));
  } catch {
    return null;
  }
  if (!isRecord(decoded)) {
    return null;
  }
  if (
    decoded.version !== 1 ||
    typeof decoded.canister_id !== "string" ||
    typeof decoded.database_id !== "string" ||
    typeof decoded.path !== "string"
  ) {
    return null;
  }
  return {
    version: 1,
    canister_id: decoded.canister_id,
    database_id: decoded.database_id,
    path: decoded.path
  };
}

function searchResult(env: RuntimeEnv, canisterId: string, databaseId: string, hit: SearchHit) {
  const id = encodeSearchResultId({
    version: 1,
    canister_id: canisterId,
    database_id: databaseId,
    path: hit.path
  });
  return {
    id,
    title: titleFromPath(hit.path),
    url: nodeUrl(env, databaseId, hit.path),
    metadata: {
      database_id: databaseId,
      path: hit.path,
      kind: hit.kind,
      score: hit.score,
      snippet: hit.snippet,
      preview: hit.preview?.excerpt ?? null,
      match_reasons: hit.matchReasons
    }
  };
}

function orderSearchHitsForRetrieval(hits: SearchHit[]): SearchHit[] {
  return [...hits].sort((left, right) => {
    const evidenceDiff = evidenceRank(right) - evidenceRank(left);
    if (evidenceDiff !== 0) {
      return evidenceDiff;
    }
    return kindRank(left.kind) - kindRank(right.kind);
  });
}

function evidenceRank(hit: SearchHit): number {
  if (hit.preview?.excerpt?.trim()) {
    return 2;
  }
  if (hit.snippet?.trim() && hit.snippet.trim() !== hit.path) {
    return 1;
  }
  return 0;
}

function kindRank(kind: string): number {
  if (kind === "file") {
    return 0;
  }
  if (kind === "source") {
    return 1;
  }
  if (kind === "folder") {
    return 2;
  }
  return 3;
}

function fetchedNode(env: RuntimeEnv, id: string, databaseId: string, node: WikiNode) {
  const text = clipText(node.content, MAX_FETCH_TEXT_CHARS);
  return {
    id,
    title: titleFromPath(node.path),
    text,
    url: nodeUrl(env, databaseId, node.path),
    metadata: {
      database_id: databaseId,
      path: node.path,
      kind: node.kind,
      etag: node.etag,
      created_at: node.createdAt,
      updated_at: node.updatedAt,
      metadata_json: node.metadataJson,
      truncated: text.length !== node.content.length
    }
  };
}

function rankDatabases(databases: DatabaseSummary[], query: string): Array<{ database: DatabaseSummary; score: number }> {
  const tokens = queryTokens(query);
  return databases
    .map((database) => ({ database, score: scoreDatabase(database, tokens) }))
    .sort((left, right) => right.score - left.score || left.database.title.localeCompare(right.database.title) || left.database.databaseId.localeCompare(right.database.databaseId));
}

function scoreDatabase(database: DatabaseSummary, tokens: string[]): number {
  if (tokens.length === 0) {
    return 0;
  }
  const tags = parseTags(database.tagsJson).join(" ");
  const fields = [
    { text: database.title, weight: 4 },
    { text: tags, weight: 3 },
    { text: database.llmSummary ?? "", weight: 2 },
    { text: database.description, weight: 1 }
  ];
  let score = 0;
  for (const token of tokens) {
    for (const field of fields) {
      if (field.text.toLowerCase().includes(token)) {
        score += field.weight;
      }
    }
  }
  return score;
}

function parseTags(tagsJson: string): string[] {
  try {
    const decoded: unknown = JSON.parse(tagsJson);
    if (Array.isArray(decoded)) {
      return decoded.filter((tag): tag is string => typeof tag === "string" && tag.trim().length > 0).map((tag) => tag.trim());
    }
  } catch {
    return [];
  }
  return [];
}

function normalizeQuery(query: string): string {
  return query.replace(/\s+/g, " ").trim();
}

function normalizePrefix(prefix: string | undefined): string {
  const normalized = prefix?.trim();
  if (!normalized) {
    return DEFAULT_PREFIX;
  }
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function queryTokens(query: string): string[] {
  return normalizeQuery(query)
    .toLowerCase()
    .split(" ")
    .filter(Boolean);
}

function clampInt(value: number | undefined, defaultValue: number, maxValue: number): number {
  if (value === undefined || !Number.isInteger(value)) {
    return defaultValue;
  }
  return Math.min(Math.max(value, 1), maxValue);
}

function titleFromPath(path: string): string {
  const name = path.split("/").filter(Boolean).at(-1) ?? path;
  return name.replace(/\.[^.]+$/, "") || path;
}

function databaseUrl(env: RuntimeEnv, databaseId: string): string {
  return new URL(`/db/${encodeURIComponent(databaseId)}`, publicOrigin(env)).toString();
}

function nodeUrl(env: RuntimeEnv, databaseId: string, path: string): string {
  const suffix = path
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return new URL(`/db/${encodeURIComponent(databaseId)}${suffix ? `/${suffix}` : ""}`, publicOrigin(env)).toString();
}

function publicOrigin(env: RuntimeEnv): string {
  return env.KINIC_WIKI_PUBLIC_ORIGIN?.trim() || DEFAULT_PUBLIC_ORIGIN;
}

function clipText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars - 3).trimEnd()}...`;
}

function toToolResult(payload: Record<string, unknown> | ToolErrorResult) {
  return isToolErrorResult(payload) ? payload : { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

function toolError(message: string, payload: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: message }],
    structuredContent: payload,
    isError: true
  };
}

type ToolErrorResult = ReturnType<typeof toolError>;

function isToolErrorResult(value: Record<string, unknown> | ToolErrorResult): value is ToolErrorResult {
  return value.isError === true;
}

async function parseJsonBody(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    throw new Error("bad request");
  }
  return request.json();
}

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-headers", "content-type,mcp-session-id,last-event-id,mcp-protocol-version");
  headers.set("access-control-allow-methods", "GET,POST,OPTIONS");
  headers.set("access-control-expose-headers", "mcp-session-id,mcp-protocol-version");
  return new Response(response.body, { status: response.status, headers });
}

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const binary = String.fromCharCode(...bytes);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64UrlDecode(value: string): string {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
