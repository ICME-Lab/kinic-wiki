// Where: workers/wiki-mcp/src/index.ts
// What: Remote MCP entrypoint exposing public Kinic Wiki database discovery, search, and fetch.
// Why: ChatGPT should read public wiki memory through anonymous canister queries without write access.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import {
  listDatabases,
  listNodes,
  memoryManifest,
  queryContext,
  queryDatabaseSqlJson,
  readNode,
  resolveCanisterId,
  searchNodes,
  sourceEvidence as readSourceEvidence,
  type DatabaseSummary,
  type LinkEdge,
  type MemoryManifest,
  type NodeContext,
  type NodeEntry,
  type QueryContext,
  type RuntimeEnv,
  type SearchHit,
  type SearchPreviewMode,
  type SourceEvidence,
  type WikiNode
} from "./vfs.js";

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
const DEFAULT_LIST_LIMIT = 99;
const MAX_LIST_LIMIT = 99;
const LIST_OVERFETCH_LIMIT = MAX_LIST_LIMIT + 1;
const MAX_FETCH_MANY_IDS = 10;
const MAX_READ_PATHS = 10;
const DEFAULT_CONTEXT_BUDGET_TOKENS = 2000;
const MAX_CONTEXT_BUDGET_TOKENS = 8000;
const DEFAULT_CONTEXT_DEPTH = 1;
const MAX_CONTEXT_DEPTH = 2;
const MAX_FETCH_TEXT_CHARS = 40_000;
const MIN_SQL_FETCH_TEXT_CHARS = 8_000;
const SQL_BATCH_RESPONSE_TEXT_BUDGET_CHARS = 220_000;
const DEFAULT_PREFIX = "/";
const DEFAULT_CONTEXT_NAMESPACE = "/Knowledge";
const DEFAULT_PUBLIC_ORIGIN = "https://wiki.kinic.xyz";
const MCP_TOOL_NAMES = [
  "find_databases",
  "search",
  "fetch",
  "fetch_many",
  "read_path",
  "read_paths",
  "list",
  "memory_manifest",
  "context",
  "source_evidence"
] as const;

const databaseResultOutputSchema = z.object({
  database_id: z.string(),
  name: z.string(),
  description: z.string(),
  tags: z.array(z.string()),
  url: z.string(),
  score: z.number()
});

const searchResultOutputSchema = z.object({
  id: z.string(),
  title: z.string(),
  url: z.string(),
  metadata: z.object({
    database_id: z.string(),
    path: z.string(),
    kind: z.string(),
    score: z.number(),
    snippet: z.string().nullable(),
    preview: z.string().nullable(),
    match_reasons: z.array(z.string())
  })
});

const fetchedNodeOutputSchema = z.object({
  id: z.string(),
  title: z.string(),
  text: z.string(),
  url: z.string(),
  metadata: z.object({
    database_id: z.string(),
    path: z.string(),
    kind: z.string(),
    etag: z.string(),
    created_at: z.string(),
    updated_at: z.string(),
    metadata_json: z.string(),
    truncated: z.boolean()
  })
});

const fetchItemErrorOutputSchema = z.object({
  id: z.string(),
  error: z.string(),
  is_error: z.literal(true)
});

const readPathItemErrorOutputSchema = z.object({
  path: z.string(),
  error: z.string(),
  is_error: z.literal(true)
});

const listedNodeOutputSchema = z.object({
  path: z.string(),
  kind: z.string(),
  etag: z.string(),
  updated_at: z.string(),
  has_children: z.boolean()
});

const linkEdgeOutputSchema = z.object({
  updated_at: z.string(),
  link_kind: z.string(),
  link_text: z.string(),
  source_path: z.string(),
  raw_href: z.string(),
  target_path: z.string()
});

const sourceEvidenceOutputSchema = z.object({
  node_path: z.string(),
  refs: z.array(
    z.object({
      link_text: z.string(),
      via_path: z.string(),
      source_content_hash: z.string().nullable(),
      source_path: z.string(),
      source_updated_at: z.string().nullable(),
      source_etag: z.string().nullable(),
      raw_href: z.string()
    })
  )
});

const nodeSummaryOutputSchema = z.object({
  title: z.string(),
  path: z.string(),
  kind: z.string(),
  etag: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  metadata_json: z.string(),
  text: z.string(),
  truncated: z.boolean()
});

const contextSearchHitOutputSchema = z.object({
  title: z.string(),
  metadata: z.object({
    path: z.string(),
    kind: z.string(),
    score: z.number(),
    snippet: z.string().nullable(),
    preview: z.string().nullable(),
    match_reasons: z.array(z.string())
  })
});

const findDatabasesOutputSchema = z.object({
  databases: z.array(databaseResultOutputSchema)
});

const searchOutputSchema = z.object({
  results: z.array(searchResultOutputSchema)
});

const fetchManyOutputSchema = z.object({
  results: z.array(z.union([fetchedNodeOutputSchema, fetchItemErrorOutputSchema]))
});

const readPathsOutputSchema = z.object({
  results: z.array(z.union([fetchedNodeOutputSchema, readPathItemErrorOutputSchema])),
  metadata: z.object({
    database_id: z.string(),
    requested_paths: z.number().int(),
    unique_paths: z.number().int(),
    row_count: z.number().int(),
    limit: z.number().int(),
    parse_error_count: z.number().int(),
    batch_error: z.string().nullable()
  })
});

const listOutputSchema = z.object({
  entries: z.array(listedNodeOutputSchema),
  metadata: z.object({
    database_id: z.string(),
    prefix: z.string(),
    recursive: z.boolean(),
    limit: z.number().int(),
    truncated: z.boolean()
  })
});

const memoryRootOutputSchema = z.object({
  path: z.string(),
  kind: z.string()
});

const memoryCapabilityOutputSchema = z.object({
  name: z.string(),
  description: z.string()
});

const memoryManifestOutputSchema = z.object({
  api_version: z.string(),
  purpose: z.string(),
  enabled_stores: z.array(z.string()),
  roots: z.array(memoryRootOutputSchema),
  entry_roots: z.array(memoryRootOutputSchema),
  capabilities: z.array(memoryCapabilityOutputSchema),
  canonical_roles: z.array(
    z.object({
      name: z.string(),
      path_pattern: z.string(),
      purpose: z.string()
    })
  ),
  write_policy: z.string(),
  recommended_entrypoint: z.string(),
  max_depth: z.number().int(),
  max_query_limit: z.number().int(),
  budget_unit: z.string()
});

const contextOutputSchema = z.object({
  task: z.string(),
  namespace: z.string(),
  truncated: z.boolean(),
  nodes: z.array(
    z.object({
      node: nodeSummaryOutputSchema,
      incoming_links: z.array(linkEdgeOutputSchema),
      outgoing_links: z.array(linkEdgeOutputSchema)
    })
  ),
  graph_links: z.array(linkEdgeOutputSchema),
  evidence: z.array(sourceEvidenceOutputSchema),
  search_hits: z.array(contextSearchHitOutputSchema)
});

const sourceEvidenceRefsOutputSchema = z.object({
  evidence: sourceEvidenceOutputSchema
});

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
        "Use find_databases first when the user has not provided a Kinic Wiki database id. For normal questions, start with context. For broad, list, or classification tasks, do not stop at the first search result or a single fetch: build a candidate set with multiple search queries, use list with prefix / when /Knowledge is thin to discover /Sources or nonstandard prefixes, separate title/path matches from topic or ability-term matches, fetch enough evidence with fetch_many for result ids or read_paths for known paths, and report coverage limits, excluded candidates, fetched count, and truncated results."
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
      outputSchema: findDatabasesOutputSchema,
      annotations: TOOL_ANNOTATIONS
    },
    async ({ query, limit }) => toToolResult(await findDatabases(env, { query, limit }))
  );

  server.registerTool(
    "search",
    {
      description:
        "Search one selected public Kinic Wiki database. Use multiple queries for broad/list/classification tasks. Use prefix / for whole-DB recall, /Knowledge for curated notes, and /Sources for raw evidence when curated notes are thin. Use content-start preview for candidate classification.",
      inputSchema: {
        database_id: z.string().min(1),
        query: z.string().min(1),
        prefix: z.string().optional(),
        limit: z.number().int().min(1).max(MAX_SEARCH_LIMIT).optional(),
        preview_mode: z.enum(["light", "content-start", "none"]).optional()
      },
      outputSchema: searchOutputSchema,
      annotations: TOOL_ANNOTATIONS
    },
    async ({ database_id, query, prefix, limit, preview_mode }) =>
      toToolResult(await searchDatabase(env, { database_id, query, prefix, limit, preview_mode }))
  );

  server.registerTool(
    "fetch",
    {
      description:
        "Fetch full text for one Kinic Wiki search result id returned by search. Use for final evidence checks; for several result ids use fetch_many and report truncation.",
      inputSchema: {
        id: z.string().min(1)
      },
      outputSchema: fetchedNodeOutputSchema,
      annotations: TOOL_ANNOTATIONS
    },
    async ({ id }) => toToolResult(await fetchSearchResult(env, { id }))
  );

  server.registerTool(
    "fetch_many",
    {
      description:
        "Fetch full text for up to 10 Kinic Wiki search result ids. Use after candidate search for broad or list questions instead of repeated single fetch calls. Item-level errors are returned without failing the whole call.",
      inputSchema: {
        ids: z.array(z.string().min(1)).min(1).max(MAX_FETCH_MANY_IDS)
      },
      outputSchema: fetchManyOutputSchema,
      annotations: TOOL_ANNOTATIONS
    },
    async ({ ids }) => toToolResult(await fetchManySearchResults(env, { ids }))
  );

  server.registerTool(
    "read_path",
    {
      description: "Read full text for one known VFS path without a search result id. Use when list, context, or prior evidence already supplied the path.",
      inputSchema: {
        database_id: z.string().min(1),
        path: z.string().min(1)
      },
      outputSchema: fetchedNodeOutputSchema,
      annotations: TOOL_ANNOTATIONS
    },
    async ({ database_id, path }) => toToolResult(await readPath(env, { database_id, path }))
  );

  server.registerTool(
    "read_paths",
    {
      description:
        "Read full text for 2 to 10 known VFS paths in one restricted SQL query. Use for multiple paths from list, context, or search metadata instead of repeated read_path/fetch calls.",
      inputSchema: {
        database_id: z.string().min(1),
        paths: z.array(z.string().min(1)).min(2).max(MAX_READ_PATHS)
      },
      outputSchema: readPathsOutputSchema,
      annotations: TOOL_ANNOTATIONS
    },
    async ({ database_id, paths }) => toToolResult(await readPaths(env, { database_id, paths }))
  );

  server.registerTool(
    "list",
    {
      description:
        "List nodes under a prefix without reading content. Use prefix / for root inventory and prefix discovery, /Knowledge for curated notes, and /Sources for raw evidence inventory.",
      inputSchema: {
        database_id: z.string().min(1),
        prefix: z.string().optional(),
        recursive: z.boolean().optional(),
        limit: z.number().int().min(1).max(MAX_LIST_LIMIT).optional()
      },
      outputSchema: listOutputSchema,
      annotations: TOOL_ANNOTATIONS
    },
    async ({ database_id, prefix, recursive, limit }) =>
      toToolResult(await listDatabaseNodes(env, { database_id, prefix, recursive, limit }))
  );

  server.registerTool(
    "memory_manifest",
    {
      description: "Discover Store API roots, capabilities, roles, and limits for one public Kinic Wiki database.",
      inputSchema: {
        database_id: z.string().min(1)
      },
      outputSchema: memoryManifestOutputSchema,
      annotations: TOOL_ANNOTATIONS
    },
    async ({ database_id }) => toToolResult(await readMemoryManifest(env, { database_id }))
  );

  server.registerTool(
    "context",
    {
      description:
        "Read task-scoped wiki context through query_context. Use this first for normal questions and before broad source investigation; answer from returned nodes and evidence, not search hits alone.",
      inputSchema: {
        database_id: z.string().min(1),
        task: z.string().min(1),
        entities: z.array(z.string()).optional(),
        namespace: z.string().optional(),
        budget_tokens: z.number().int().min(1).max(MAX_CONTEXT_BUDGET_TOKENS).optional(),
        include_evidence: z.boolean().optional(),
        depth: z.number().int().min(0).max(MAX_CONTEXT_DEPTH).optional()
      },
      outputSchema: contextOutputSchema,
      annotations: TOOL_ANNOTATIONS
    },
    async ({ database_id, task, entities, namespace, budget_tokens, include_evidence, depth }) =>
      toToolResult(
        await queryTaskContext(env, {
          database_id,
          task,
          entities,
          namespace,
          budget_tokens,
          include_evidence,
          depth
        })
    )
  );

  server.registerTool(
    "source_evidence",
    {
      description: "Read source evidence references for one known Kinic Wiki knowledge node path.",
      inputSchema: {
        database_id: z.string().min(1),
        node_path: z.string().min(1)
      },
      outputSchema: sourceEvidenceRefsOutputSchema,
      annotations: TOOL_ANNOTATIONS
    },
    async ({ database_id, node_path }) => toToolResult(await readSourceEvidenceRefs(env, { database_id, node_path }))
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
  preview_mode?: SearchPreviewMode;
};

export type FetchInput = {
  id: string;
};

export type FetchManyInput = {
  ids: string[];
};

export type ReadPathInput = {
  database_id: string;
  path: string;
};

export type ReadPathsInput = {
  database_id: string;
  paths: string[];
};

export type ListInput = {
  database_id: string;
  prefix?: string;
  recursive?: boolean;
  limit?: number;
};

export type ContextInput = {
  database_id: string;
  task: string;
  entities?: string[];
  namespace?: string;
  budget_tokens?: number;
  include_evidence?: boolean;
  depth?: number;
};

export type MemoryManifestInput = {
  database_id: string;
};

export type SourceEvidenceInput = {
  database_id: string;
  node_path: string;
};

export type SearchResultId = {
  version: 1;
  canister_id: string;
  database_id: string;
  path: string;
};

type SqlWikiNode = WikiNode & {
  contentTruncated: boolean;
};

type ValidFetchManyItem = {
  index: number;
  id: string;
  decoded: SearchResultId;
};

type SqlNodesByPath = {
  nodesByPath: Map<string, SqlWikiNode>;
  rowCount: number;
  limit: number;
  uniquePaths: string[];
  parseErrorCount: number;
  batchError: string | null;
};

export async function findDatabases(env: RuntimeEnv, input: FindDatabasesInput) {
  const query = normalizeQuery(input.query ?? "");
  const limit = clampInt(input.limit, DEFAULT_DATABASE_LIMIT, MAX_DATABASE_LIMIT);
  const databases = await listDatabases(env);
  const ranked = rankDatabases(databases, query);
  const filtered = query ? ranked.filter(({ score }) => score > 0) : ranked;
  return {
    databases: filtered
      .slice(0, limit)
      .map(({ database, score }) => ({
        database_id: database.databaseId,
        name: database.name,
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
  const previewMode = input.preview_mode ?? "light";
  const canisterId = resolveCanisterId(env);
  const hits = await searchNodes(env, databaseId, query, prefix, limit, previewMode);
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

export async function fetchManySearchResults(env: RuntimeEnv, input: FetchManyInput) {
  const canisterId = resolveCanisterId(env);
  const ids = input.ids.slice(0, MAX_FETCH_MANY_IDS);
  const results: Array<Record<string, unknown> | null> = [];
  const validItems: ValidFetchManyItem[] = [];
  for (const [index, id] of ids.entries()) {
    const decoded = decodeSearchResultId(id);
    if (!decoded) {
      results[index] = fetchItemError(id, "invalid search result id");
    } else if (decoded.canister_id !== canisterId) {
      results[index] = fetchItemError(id, "search result id is for another canister");
    } else {
      validItems.push({ index, id, decoded });
      results[index] = null;
    }
  }

  const groups = groupFetchManyItemsByDatabase(validItems);
  await Promise.all([...groups.values()].map((group) => fillFetchManyGroup(env, group, results)));
  return { results };
}

export async function readPath(env: RuntimeEnv, input: ReadPathInput) {
  const databaseId = input.database_id.trim();
  if (!databaseId) {
    return toolError("database_id is required", { error: "database_id is required" });
  }
  const path = normalizePrefix(input.path);
  const node = await readNode(env, databaseId, path);
  if (!node) {
    return toolError("node not found", { error: "node not found", database_id: databaseId, path });
  }
  const id = encodeSearchResultId({
    version: 1,
    canister_id: resolveCanisterId(env),
    database_id: databaseId,
    path
  });
  return fetchedNode(env, id, databaseId, node);
}

export async function readPaths(env: RuntimeEnv, input: ReadPathsInput) {
  const databaseId = input.database_id.trim();
  if (!databaseId) {
    return toolError("database_id is required", { error: "database_id is required" });
  }
  const paths = input.paths.slice(0, MAX_READ_PATHS).map((path) => normalizePrefix(path));
  const batch = await readSqlNodesByPath(env, databaseId, paths);
  const canisterId = resolveCanisterId(env);
  return {
    results: paths.map((path) => {
      if (batch.batchError) {
        return readPathItemError(path, batch.batchError);
      }
      const node = batch.nodesByPath.get(path);
      if (!node) {
        return readPathItemError(path, "node not found");
      }
      const id = encodeSearchResultId({
        version: 1,
        canister_id: canisterId,
        database_id: databaseId,
        path
      });
      return fetchedNode(env, id, databaseId, node, node.contentTruncated);
    }),
    metadata: {
      database_id: databaseId,
      requested_paths: paths.length,
      unique_paths: batch.uniquePaths.length,
      row_count: batch.rowCount,
      limit: batch.limit,
      parse_error_count: batch.parseErrorCount,
      batch_error: batch.batchError
    }
  };
}

export async function listDatabaseNodes(env: RuntimeEnv, input: ListInput) {
  const databaseId = input.database_id.trim();
  if (!databaseId) {
    return toolError("database_id is required", { error: "database_id is required" });
  }
  const prefix = normalizePrefix(input.prefix);
  const recursive = input.recursive ?? false;
  const limit = clampInt(input.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
  const fetchLimit = Math.min(limit + 1, LIST_OVERFETCH_LIMIT);
  const entries = await listNodes(env, databaseId, prefix, recursive, fetchLimit);
  const truncated = entries.length > limit;
  return {
    entries: entries.slice(0, limit).map(listedNode),
    metadata: {
      database_id: databaseId,
      prefix,
      recursive,
      limit,
      truncated
    }
  };
}

export async function queryTaskContext(env: RuntimeEnv, input: ContextInput) {
  const databaseId = input.database_id.trim();
  if (!databaseId) {
    return toolError("database_id is required", { error: "database_id is required" });
  }
  const task = normalizeQuery(input.task);
  if (!task) {
    return toolError("task is required", { error: "task is required", database_id: databaseId });
  }
  const context = await queryContext(env, {
    databaseId,
    task,
    entities: input.entities ?? [],
    namespace: normalizePrefix(input.namespace ?? DEFAULT_CONTEXT_NAMESPACE),
    budgetTokens: clampInt(input.budget_tokens, DEFAULT_CONTEXT_BUDGET_TOKENS, MAX_CONTEXT_BUDGET_TOKENS),
    includeEvidence: input.include_evidence ?? true,
    depth: clampIntRange(input.depth, DEFAULT_CONTEXT_DEPTH, 0, MAX_CONTEXT_DEPTH)
  });
  return taskContext(context);
}

export async function readMemoryManifest(env: RuntimeEnv, input: MemoryManifestInput) {
  const databaseId = input.database_id.trim();
  if (!databaseId) {
    return toolError("database_id is required", { error: "database_id is required" });
  }
  return manifestResult(await memoryManifest(env, databaseId));
}

export async function readSourceEvidenceRefs(env: RuntimeEnv, input: SourceEvidenceInput) {
  const databaseId = input.database_id.trim();
  if (!databaseId) {
    return toolError("database_id is required", { error: "database_id is required" });
  }
  const nodePath = normalizePrefix(input.node_path);
  return {
    evidence: sourceEvidence(await readSourceEvidence(env, databaseId, nodePath))
  };
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

async function fetchSearchResultItem(env: RuntimeEnv, id: string, canisterId: string) {
  const decoded = decodeSearchResultId(id);
  if (!decoded) {
    return fetchItemError(id, "invalid search result id");
  }
  if (decoded.canister_id !== canisterId) {
    return fetchItemError(id, "search result id is for another canister");
  }
  const node = await readNode(env, decoded.database_id, decoded.path);
  if (!node) {
    return fetchItemError(id, "node not found");
  }
  return fetchedNode(env, id, decoded.database_id, node);
}

function groupFetchManyItemsByDatabase(items: ValidFetchManyItem[]): Map<string, ValidFetchManyItem[]> {
  const groups = new Map<string, ValidFetchManyItem[]>();
  for (const item of items) {
    const group = groups.get(item.decoded.database_id) ?? [];
    group.push(item);
    groups.set(item.decoded.database_id, group);
  }
  return groups;
}

async function fillFetchManyGroup(env: RuntimeEnv, group: ValidFetchManyItem[], results: Array<Record<string, unknown> | null>) {
  if (group.length === 1) {
    const [item] = group;
    results[item.index] = await fetchSearchResultItem(env, item.id, item.decoded.canister_id);
    return;
  }

  const databaseId = group[0].decoded.database_id;
  const batch = await readSqlNodesByPath(
    env,
    databaseId,
    group.map((item) => item.decoded.path)
  );
  for (const item of group) {
    if (batch.batchError) {
      results[item.index] = fetchItemError(item.id, batch.batchError);
      continue;
    }
    const node = batch.nodesByPath.get(item.decoded.path);
    results[item.index] = node ? fetchedNode(env, item.id, databaseId, node, node.contentTruncated) : fetchItemError(item.id, "node not found");
  }
}

function fetchItemError(id: string, error: string) {
  return {
    id,
    error,
    is_error: true
  };
}

function readPathItemError(path: string, error: string) {
  return {
    path,
    error,
    is_error: true
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

function listedNode(entry: NodeEntry) {
  return {
    path: entry.path,
    kind: entry.kind,
    etag: entry.etag,
    updated_at: entry.updatedAt,
    has_children: entry.hasChildren
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

function taskContext(context: QueryContext) {
  return {
    task: context.task,
    namespace: context.namespace,
    truncated: context.truncated,
    nodes: context.nodes.map(nodeContext),
    graph_links: context.graphLinks.map(linkEdge),
    evidence: context.evidence.map(sourceEvidence),
    search_hits: context.searchHits.map((hit) => ({
      title: titleFromPath(hit.path),
      metadata: {
        path: hit.path,
        kind: hit.kind,
        score: hit.score,
        snippet: hit.snippet,
        preview: hit.preview?.excerpt ?? null,
        match_reasons: hit.matchReasons
      }
    }))
  };
}

function manifestResult(manifest: MemoryManifest) {
  return {
    api_version: manifest.apiVersion,
    purpose: manifest.purpose,
    enabled_stores: manifest.enabledStores,
    roots: manifest.roots,
    entry_roots: manifest.entryRoots,
    capabilities: manifest.capabilities,
    canonical_roles: manifest.canonicalRoles.map((role) => ({
      name: role.name,
      path_pattern: role.pathPattern,
      purpose: role.purpose
    })),
    write_policy: manifest.writePolicy,
    recommended_entrypoint: manifest.recommendedEntrypoint,
    max_depth: manifest.maxDepth,
    max_query_limit: manifest.maxQueryLimit,
    budget_unit: manifest.budgetUnit
  };
}

function nodeContext(context: NodeContext) {
  return {
    node: nodeSummary(context.node),
    incoming_links: context.incomingLinks.map(linkEdge),
    outgoing_links: context.outgoingLinks.map(linkEdge)
  };
}

function nodeSummary(node: WikiNode) {
  return {
    title: titleFromPath(node.path),
    path: node.path,
    kind: node.kind,
    etag: node.etag,
    created_at: node.createdAt,
    updated_at: node.updatedAt,
    metadata_json: node.metadataJson,
    text: clipText(node.content, MAX_FETCH_TEXT_CHARS),
    truncated: node.content.length > MAX_FETCH_TEXT_CHARS
  };
}

function linkEdge(edge: LinkEdge) {
  return {
    updated_at: edge.updatedAt,
    link_kind: edge.linkKind,
    link_text: edge.linkText,
    source_path: edge.sourcePath,
    raw_href: edge.rawHref,
    target_path: edge.targetPath
  };
}

function sourceEvidence(evidence: SourceEvidence) {
  return {
    node_path: evidence.nodePath,
    refs: evidence.refs.map((ref) => ({
      link_text: ref.linkText,
      via_path: ref.viaPath,
      source_content_hash: ref.sourceContentHash,
      source_path: ref.sourcePath,
      source_updated_at: ref.sourceUpdatedAt,
      source_etag: ref.sourceEtag,
      raw_href: ref.rawHref
    }))
  };
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

function fetchedNode(env: RuntimeEnv, id: string, databaseId: string, node: WikiNode, explicitTruncated?: boolean) {
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
      truncated: explicitTruncated ?? text.length !== node.content.length
    }
  };
}

function readPathsSql(paths: string[], contentCharLimit: number): string {
  const pathList = paths.map(sqlStringLiteral).join(",");
  return `SELECT json_object('path', path, 'kind', kind, 'etag', etag, 'created_at', created_at, 'updated_at', updated_at, 'metadata_json', metadata_json, 'content', substr(content, 1, ${contentCharLimit}), 'content_truncated', length(content) > ${contentCharLimit}) FROM fs_nodes WHERE path IN (${pathList}) LIMIT ${paths.length}`;
}

async function readSqlNodesByPath(env: RuntimeEnv, databaseId: string, paths: string[]): Promise<SqlNodesByPath> {
  const uniquePaths = [...new Set(paths)];
  if (uniquePaths.length === 0) {
    return {
      nodesByPath: new Map<string, SqlWikiNode>(),
      rowCount: 0,
      limit: 0,
      uniquePaths,
      parseErrorCount: 0,
      batchError: null
    };
  }
  const contentCharLimit = sqlBatchContentCharLimit(uniquePaths.length);
  const sql = readPathsSql(uniquePaths, contentCharLimit);
  let result: Awaited<ReturnType<typeof queryDatabaseSqlJson>>;
  try {
    result = await queryDatabaseSqlJson(env, databaseId, sql, uniquePaths.length);
  } catch (error) {
    return {
      nodesByPath: new Map<string, SqlWikiNode>(),
      rowCount: 0,
      limit: uniquePaths.length,
      uniquePaths,
      parseErrorCount: 0,
      batchError: batchReadError(error)
    };
  }
  const nodesByPath = new Map<string, SqlWikiNode>();
  let parseErrorCount = 0;

  for (const row of result.rows) {
    const node = parseSqlNodeRow(row);
    if (node) {
      nodesByPath.set(node.path, node);
    } else {
      parseErrorCount += 1;
    }
  }

  return {
    nodesByPath,
    rowCount: result.rowCount,
    limit: result.limit,
    uniquePaths,
    parseErrorCount,
    batchError: null
  };
}

function sqlBatchContentCharLimit(uniquePathCount: number): number {
  const fairShare = Math.floor(SQL_BATCH_RESPONSE_TEXT_BUDGET_CHARS / Math.max(uniquePathCount, 1));
  return Math.min(Math.max(fairShare, MIN_SQL_FETCH_TEXT_CHARS), MAX_FETCH_TEXT_CHARS);
}

function batchReadError(error: unknown): string {
  return `batch read failed: ${error instanceof Error ? error.message : String(error)}`;
}

function sqlStringLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function parseSqlNodeRow(row: string): SqlWikiNode | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(row);
  } catch {
    return null;
  }
  if (!isRecord(decoded)) {
    return null;
  }
  const path = requiredString(decoded.path);
  const kind = requiredString(decoded.kind);
  const content = requiredString(decoded.content);
  const etag = requiredString(decoded.etag);
  const metadataJson = requiredString(decoded.metadata_json);
  const createdAt = scalarToString(decoded.created_at);
  const updatedAt = scalarToString(decoded.updated_at);
  const contentTruncated = scalarToBoolean(decoded.content_truncated);
  if (!path || !kind || content === null || !etag || metadataJson === null || !createdAt || !updatedAt) {
    return null;
  }
  return {
    path,
    kind,
    content,
    etag,
    metadataJson,
    createdAt,
    updatedAt,
    contentTruncated
  };
}

function requiredString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function scalarToString(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

function scalarToBoolean(value: unknown): boolean {
  return value === true || value === 1 || value === "1";
}

function rankDatabases(databases: DatabaseSummary[], query: string): Array<{ database: DatabaseSummary; score: number }> {
  const tokens = queryTokens(query);
  return databases
    .map((database) => ({ database, score: scoreDatabase(database, tokens) }))
    .sort((left, right) => right.score - left.score || left.database.name.localeCompare(right.database.name) || left.database.databaseId.localeCompare(right.database.databaseId));
}

function scoreDatabase(database: DatabaseSummary, tokens: string[]): number {
  if (tokens.length === 0) {
    return 0;
  }
  const tags = parseTags(database.tagsJson).join(" ");
  const fields = [
    { text: database.name, weight: 4 },
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

function clampIntRange(value: number | undefined, defaultValue: number, minValue: number, maxValue: number): number {
  if (value === undefined || !Number.isInteger(value)) {
    return defaultValue;
  }
  return Math.min(Math.max(value, minValue), maxValue);
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
  return isToolErrorResult(payload) ? payload : { content: [{ type: "text" as const, text: JSON.stringify(payload) }], structuredContent: payload };
}

function toolError(message: string, payload: Record<string, unknown>) {
  const contentPayload = { ...payload, error: typeof payload.error === "string" ? payload.error : message };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(contentPayload) }],
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
