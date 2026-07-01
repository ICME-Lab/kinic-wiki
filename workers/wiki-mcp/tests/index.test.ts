// Where: workers/wiki-mcp/tests/index.test.ts
// What: Contract tests for the public read-only Kinic Wiki MCP Worker.
// Why: ChatGPT-facing tool names, output shapes, and id encoding must stay stable.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listNodes: vi.fn(),
  listDatabases: vi.fn(),
  memoryManifest: vi.fn(),
  queryContext: vi.fn(),
  queryDatabaseSqlJson: vi.fn(),
  readNode: vi.fn(),
  resolveCanisterId: vi.fn(),
  searchNodes: vi.fn(),
  sourceEvidence: vi.fn()
}));

vi.mock("../src/vfs.js", () => ({
  listDatabases: mocks.listDatabases,
  listNodes: mocks.listNodes,
  memoryManifest: mocks.memoryManifest,
  queryContext: mocks.queryContext,
  queryDatabaseSqlJson: mocks.queryDatabaseSqlJson,
  readNode: mocks.readNode,
  resolveCanisterId: mocks.resolveCanisterId,
  searchNodes: mocks.searchNodes,
  sourceEvidence: mocks.sourceEvidence
}));

import worker, {
  decodeSearchResultId,
  encodeSearchResultId,
  fetchSearchResult,
  fetchManySearchResults,
  findDatabases,
  listDatabaseNodes,
  queryTaskContext,
  readMemoryManifest,
  readPath,
  readPaths,
  readSourceEvidenceRefs,
  searchDatabase
} from "../src/index.js";

const env = {
  KINIC_WIKI_CANISTER_ID: "canister-a",
  KINIC_WIKI_IC_HOST: "https://icp0.io",
  KINIC_WIKI_PUBLIC_ORIGIN: "https://wiki.kinic.test"
};

describe("wiki mcp worker", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.resolveCanisterId.mockReturnValue("canister-a");
    mocks.listDatabases.mockResolvedValue([
      {
        databaseId: "db_beta",
        name: "Operations",
        description: "Runbooks and incident notes",
        llmSummary: "Production operations memory",
        tagsJson: "[\"ops\",\"runbook\"]",
        status: "active"
      },
      {
        databaseId: "db_alpha",
        name: "Agent Memory",
        description: "Project facts and preferences",
        llmSummary: "Memory for agent workflows",
        tagsJson: "[\"agent\",\"memory\"]",
        status: "active"
      },
      {
        databaseId: "db_no_metadata",
        name: "No Metadata",
        description: "",
        llmSummary: null,
        tagsJson: "[]",
        status: "active"
      }
    ]);
    mocks.searchNodes.mockResolvedValue([
      {
        path: "/Knowledge/index.md",
        kind: "file",
        score: 8.5,
        snippet: "Agent memory index",
        preview: { excerpt: "Agent memory index", matchReason: "content" },
        matchReasons: ["content"]
      }
    ]);
    mocks.listNodes.mockResolvedValue([
      {
        path: "/Knowledge/index.md",
        kind: "file",
        updatedAt: "2",
        etag: "etag-1",
        hasChildren: false
      },
      {
        path: "/Sources",
        kind: "directory",
        updatedAt: "3",
        etag: "etag-2",
        hasChildren: true
      }
    ]);
    mocks.readNode.mockResolvedValue({
      path: "/Knowledge/index.md",
      kind: "file",
      content: "Agent memory body",
      createdAt: "1",
      updatedAt: "2",
      etag: "etag-1",
      metadataJson: "{}"
    });
    mocks.memoryManifest.mockResolvedValue({
      apiVersion: "kinic-stores-v1",
      purpose: "Canister-backed memory",
      enabledStores: ["knowledge"],
      roots: [{ path: "/Knowledge", kind: "knowledge" }],
      entryRoots: [{ path: "/Knowledge", kind: "knowledge" }],
      capabilities: [{ name: "query_context", description: "Task-scoped recall" }],
      canonicalRoles: [{ name: "index", pathPattern: "index.md", purpose: "Catalog" }],
      writePolicy: "stores_read_only",
      recommendedEntrypoint: "query_context",
      maxDepth: 2,
      maxQueryLimit: 100,
      budgetUnit: "approx_chars_from_tokens"
    });
    mocks.queryContext.mockResolvedValue({
      task: "agent",
      namespace: "/Knowledge",
      truncated: false,
      nodes: [
        {
          node: {
            path: "/Knowledge/index.md",
            kind: "file",
            content: "Agent memory body",
            createdAt: "1",
            updatedAt: "2",
            etag: "etag-1",
            metadataJson: "{}"
          },
          incomingLinks: [],
          outgoingLinks: []
        }
      ],
      graphLinks: [],
      evidence: [
        {
          nodePath: "/Knowledge/index.md",
          refs: [
            {
              linkText: "Source",
              viaPath: "/Knowledge/index.md",
              sourceContentHash: "sha256:abc",
              sourcePath: "/Sources/raw/source.md",
              sourceUpdatedAt: "3",
              sourceEtag: "source-etag",
              rawHref: "/Sources/raw/source.md"
            }
          ]
        }
      ],
      searchHits: [
        {
          path: "/Knowledge/index.md",
          kind: "file",
          score: 8.5,
          snippet: "Agent memory index",
          preview: { excerpt: "Agent memory index", matchReason: "content" },
          matchReasons: ["content"]
        }
      ]
    });
    mocks.sourceEvidence.mockResolvedValue({
      nodePath: "/Knowledge/index.md",
      refs: [
        {
          linkText: "Source",
          viaPath: "/Knowledge/index.md",
          sourceContentHash: "sha256:abc",
          sourcePath: "/Sources/raw/source.md",
          sourceUpdatedAt: "3",
          sourceEtag: "source-etag",
          rawHref: "/Sources/raw/source.md"
        }
      ]
    });
    mocks.queryDatabaseSqlJson.mockResolvedValue({
      rows: [
        JSON.stringify({
          path: "/Knowledge/b.md",
          kind: "file",
          content: "Body B",
          created_at: 11,
          updated_at: 12,
          etag: "etag-b",
          metadata_json: "{}"
        }),
        JSON.stringify({
          path: "/Knowledge/a.md",
          kind: "file",
          content: "Body A",
          created_at: 9,
          updated_at: 10,
          etag: "etag-a",
          metadata_json: "{}"
        })
      ],
      rowCount: 2,
      limit: 3
    });
  });

  it("serves health", async () => {
    const response = await worker.fetch(new Request("https://mcp.example.test/health"), env);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, name: "kinic-wiki-mcp" });
  });

  it("serves root info without aliasing root POST to MCP", async () => {
    const getResponse = await worker.fetch(new Request("https://wiki-mcp.kinic.test/"), env);
    expect(getResponse.status).toBe(200);
    await expect(getResponse.json()).resolves.toEqual({
      name: "kinic-wiki-mcp",
      description: "Public, anonymous, read-only Kinic Wiki MCP server.",
      mcp_endpoint: "https://wiki-mcp.kinic.test/mcp",
      health_endpoint: "https://wiki-mcp.kinic.test/health",
      tools: [
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
      ]
    });

    const postResponse = await worker.fetch(
      new Request("https://wiki-mcp.kinic.test/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
      }),
      env
    );
    expect(postResponse.status).toBe(404);
    await expect(postResponse.json()).resolves.toEqual({ error: "not found" });
  });

  it("advertises the public read-only tools", async () => {
    const response = await postMcp({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const tools = response.result.tools as Array<{ name: string; annotations: Record<string, boolean> }>;
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "context",
      "fetch",
      "fetch_many",
      "find_databases",
      "list",
      "memory_manifest",
      "read_path",
      "read_paths",
      "search",
      "source_evidence"
    ]);
    for (const tool of tools) {
      expect(tool.annotations).toMatchObject({
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false
      });
    }
  });

  it("ranks public databases by metadata text", async () => {
    await expect(findDatabases(env, { query: "agent memory", limit: 2 })).resolves.toEqual({
      databases: [
        {
          database_id: "db_alpha",
          name: "Agent Memory",
          description: "Project facts and preferences",
          tags: ["agent", "memory"],
          url: "https://wiki.kinic.test/db/db_alpha",
          score: 18
        },
        {
          database_id: "db_beta",
          name: "Operations",
          description: "Runbooks and incident notes",
          tags: ["ops", "runbook"],
          url: "https://wiki.kinic.test/db/db_beta",
          score: 2
        }
      ]
    });
  });

  it("returns no databases for non-empty queries with no metadata match", async () => {
    await expect(findDatabases(env, { query: "no-such-domain", limit: 10 })).resolves.toEqual({
      databases: []
    });
  });

  it("searches one database and returns fetchable ids", async () => {
    const result = await searchDatabase(env, { database_id: "db_alpha", query: "agent", limit: 5 });
    expect(result).toEqual({
      results: [
        {
          id: expect.stringMatching(/^kinic-wiki:/),
          title: "index",
          url: "https://wiki.kinic.test/db/db_alpha/Knowledge/index.md",
          metadata: {
            database_id: "db_alpha",
            path: "/Knowledge/index.md",
            kind: "file",
            score: 8.5,
            snippet: "Agent memory index",
            preview: "Agent memory index",
            match_reasons: ["content"]
          }
        }
      ]
    });
    expect(mocks.searchNodes).toHaveBeenCalledWith(env, "db_alpha", "agent", "/", 5, "light");
  });

  it("search accepts content-start and none preview modes", async () => {
    await searchDatabase(env, { database_id: "db_alpha", query: "agent", limit: 5, preview_mode: "content-start" });
    await searchDatabase(env, { database_id: "db_alpha", query: "agent", limit: 5, preview_mode: "none" });

    expect(mocks.searchNodes).toHaveBeenNthCalledWith(1, env, "db_alpha", "agent", "/", 5, "content-start");
    expect(mocks.searchNodes).toHaveBeenNthCalledWith(2, env, "db_alpha", "agent", "/", 5, "none");
  });

  it("prioritizes content evidence over path-only hits", async () => {
    mocks.searchNodes.mockResolvedValueOnce([
      {
        path: "/Sources/raw/clipper",
        kind: "folder",
        score: -300000000,
        snippet: "/Sources/raw/clipper",
        preview: null,
        matchReasons: ["path"]
      },
      {
        path: "/Wiki/operators/browser-and-clipper.md",
        kind: "file",
        score: -39722.24,
        snippet: null,
        preview: { excerpt: "Build the wiki clipper extension", matchReason: "content" },
        matchReasons: ["content"]
      }
    ]);

    const result = await searchDatabase(env, { database_id: "db_alpha", query: "clipper usage", limit: 2 });
    if (!("results" in result)) {
      throw new Error("expected search results");
    }
    expect(result.results[0]).toMatchObject({
      title: "browser-and-clipper",
      metadata: {
        kind: "file",
        path: "/Wiki/operators/browser-and-clipper.md",
        preview: "Build the wiki clipper extension"
      }
    });
  });

  it("fetches one node by opaque search id", async () => {
    const id = encodeSearchResultId({
      version: 1,
      canister_id: "canister-a",
      database_id: "db_alpha",
      path: "/Knowledge/index.md"
    });
    await expect(fetchSearchResult(env, { id })).resolves.toEqual({
      id,
      title: "index",
      text: "Agent memory body",
      url: "https://wiki.kinic.test/db/db_alpha/Knowledge/index.md",
      metadata: {
        database_id: "db_alpha",
        path: "/Knowledge/index.md",
        kind: "file",
        etag: "etag-1",
        created_at: "1",
        updated_at: "2",
        metadata_json: "{}",
        truncated: false
      }
    });
    expect(mocks.readNode).toHaveBeenCalledWith(env, "db_alpha", "/Knowledge/index.md");
  });

  it("reads one node by known path", async () => {
    await expect(readPath(env, { database_id: "db_alpha", path: "/Knowledge/index.md" })).resolves.toMatchObject({
      title: "index",
      text: "Agent memory body",
      metadata: {
        database_id: "db_alpha",
        path: "/Knowledge/index.md",
        truncated: false
      }
    });
    expect(mocks.readNode).toHaveBeenCalledWith(env, "db_alpha", "/Knowledge/index.md");
  });

  it("reads known paths with one restricted SQL query", async () => {
    await expect(
      readPaths(env, { database_id: "db_alpha", paths: ["/Knowledge/a.md", "/Knowledge/b.md", "/Knowledge/missing.md"] })
    ).resolves.toMatchObject({
      results: [
        {
          title: "a",
          text: "Body A",
          metadata: {
            database_id: "db_alpha",
            path: "/Knowledge/a.md",
            etag: "etag-a"
          }
        },
        {
          title: "b",
          text: "Body B",
          metadata: {
            database_id: "db_alpha",
            path: "/Knowledge/b.md",
            etag: "etag-b"
          }
        },
        {
          path: "/Knowledge/missing.md",
          error: "node not found",
          is_error: true
        }
      ],
      metadata: {
        database_id: "db_alpha",
        requested_paths: 3,
        unique_paths: 3,
        row_count: 2,
        limit: 3,
        parse_error_count: 0
      }
    });
    expect(mocks.queryDatabaseSqlJson).toHaveBeenCalledTimes(1);
    const sql = mocks.queryDatabaseSqlJson.mock.calls[0][2];
    expect(sql).toContain("'content', substr(content, 1, 40000)");
    expect(sql).toContain("'content_truncated', length(content) > 40000");
    expect(sql).toContain("FROM fs_nodes WHERE path IN ('/Knowledge/a.md','/Knowledge/b.md','/Knowledge/missing.md') LIMIT 3");
  });

  it("lists nodes for prefix discovery without content", async () => {
    await expect(listDatabaseNodes(env, { database_id: "db_alpha", prefix: "/", recursive: true, limit: 1 })).resolves.toEqual({
      entries: [
        {
          path: "/Knowledge/index.md",
          kind: "file",
          etag: "etag-1",
          updated_at: "2",
          has_children: false
        }
      ],
      metadata: {
        database_id: "db_alpha",
        prefix: "/",
        recursive: true,
        limit: 1,
        truncated: true
      }
    });
    expect(mocks.listNodes).toHaveBeenCalledWith(env, "db_alpha", "/", true, 2);
  });

  it("does not mark list results truncated when over-fetch does not cross the limit", async () => {
    await expect(listDatabaseNodes(env, { database_id: "db_alpha", prefix: "/", recursive: true, limit: 3 })).resolves.toMatchObject({
      entries: [
        { path: "/Knowledge/index.md" },
        { path: "/Sources" }
      ],
      metadata: {
        database_id: "db_alpha",
        prefix: "/",
        recursive: true,
        limit: 3,
        truncated: false
      }
    });
    expect(mocks.listNodes).toHaveBeenCalledWith(env, "db_alpha", "/", true, 4);
  });

  it("clamps list to 99 while preserving one-row over-fetch", async () => {
    await expect(listDatabaseNodes(env, { database_id: "db_alpha", prefix: "/", recursive: false, limit: 100 })).resolves.toMatchObject({
      metadata: {
        database_id: "db_alpha",
        prefix: "/",
        recursive: false,
        limit: 99,
        truncated: false
      }
    });

    expect(mocks.listNodes).toHaveBeenCalledWith(env, "db_alpha", "/", false, 100);
  });

  it("fetches many result ids with item-level errors", async () => {
    const goodId = encodeSearchResultId({
      version: 1,
      canister_id: "canister-a",
      database_id: "db_alpha",
      path: "/Knowledge/index.md"
    });
    const staleId = encodeSearchResultId({
      version: 1,
      canister_id: "other-canister",
      database_id: "db_alpha",
      path: "/Knowledge/index.md"
    });

    await expect(fetchManySearchResults(env, { ids: [goodId, "bad", staleId] })).resolves.toMatchObject({
      results: [
        {
          id: goodId,
          title: "index",
          metadata: { path: "/Knowledge/index.md" }
        },
        {
          id: "bad",
          error: "invalid search result id",
          is_error: true
        },
        {
          id: staleId,
          error: "search result id is for another canister",
          is_error: true
        }
      ]
    });
    expect(mocks.readNode).toHaveBeenCalledWith(env, "db_alpha", "/Knowledge/index.md");
  });

  it("fetches multiple valid result ids with one restricted SQL query", async () => {
    const firstId = encodeSearchResultId({
      version: 1,
      canister_id: "canister-a",
      database_id: "db_alpha",
      path: "/Knowledge/a.md"
    });
    const secondId = encodeSearchResultId({
      version: 1,
      canister_id: "canister-a",
      database_id: "db_alpha",
      path: "/Knowledge/b.md"
    });

    await expect(fetchManySearchResults(env, { ids: [firstId, secondId] })).resolves.toMatchObject({
      results: [
        {
          id: firstId,
          title: "a",
          text: "Body A",
          metadata: { path: "/Knowledge/a.md" }
        },
        {
          id: secondId,
          title: "b",
          text: "Body B",
          metadata: { path: "/Knowledge/b.md" }
        }
      ]
    });
    expect(mocks.queryDatabaseSqlJson).toHaveBeenCalledTimes(1);
    expect(mocks.readNode).not.toHaveBeenCalled();
  });

  it("scales SQL batch content limits by requested path count", async () => {
    const paths = Array.from({ length: 10 }, (_, index) => `/Knowledge/${index}.md`);

    await readPaths(env, { database_id: "db_alpha", paths });

    const sql = mocks.queryDatabaseSqlJson.mock.calls[0][2];
    expect(sql).toContain("'content', substr(content, 1, 22000)");
    expect(sql).toContain("'content_truncated', length(content) > 22000");
  });

  it("returns item-level read_paths errors when the SQL batch fails", async () => {
    mocks.queryDatabaseSqlJson.mockRejectedValueOnce(new Error("response JSON exceeds 1048576 bytes"));

    await expect(readPaths(env, { database_id: "db_alpha", paths: ["/Knowledge/a.md", "/Knowledge/b.md"] })).resolves.toMatchObject({
      results: [
        {
          path: "/Knowledge/a.md",
          error: "batch read failed: response JSON exceeds 1048576 bytes",
          is_error: true
        },
        {
          path: "/Knowledge/b.md",
          error: "batch read failed: response JSON exceeds 1048576 bytes",
          is_error: true
        }
      ],
      metadata: {
        batch_error: "batch read failed: response JSON exceeds 1048576 bytes"
      }
    });
    expect(mocks.readNode).not.toHaveBeenCalled();
  });

  it("returns item-level fetch_many errors when the SQL batch fails", async () => {
    mocks.queryDatabaseSqlJson.mockRejectedValueOnce(new Error("response JSON exceeds 1048576 bytes"));
    const firstId = encodeSearchResultId({
      version: 1,
      canister_id: "canister-a",
      database_id: "db_alpha",
      path: "/Knowledge/a.md"
    });
    const secondId = encodeSearchResultId({
      version: 1,
      canister_id: "canister-a",
      database_id: "db_alpha",
      path: "/Knowledge/b.md"
    });

    await expect(fetchManySearchResults(env, { ids: [firstId, secondId] })).resolves.toEqual({
      results: [
        {
          id: firstId,
          error: "batch read failed: response JSON exceeds 1048576 bytes",
          is_error: true
        },
        {
          id: secondId,
          error: "batch read failed: response JSON exceeds 1048576 bytes",
          is_error: true
        }
      ]
    });
    expect(mocks.readNode).not.toHaveBeenCalled();
  });

  it("returns task-scoped context with defaults", async () => {
    await expect(queryTaskContext(env, { database_id: "db_alpha", task: "agent" })).resolves.toEqual({
      task: "agent",
      namespace: "/Knowledge",
      truncated: false,
      nodes: [
        {
          node: {
            title: "index",
            path: "/Knowledge/index.md",
            kind: "file",
            etag: "etag-1",
            created_at: "1",
            updated_at: "2",
            metadata_json: "{}",
            text: "Agent memory body",
            truncated: false
          },
          incoming_links: [],
          outgoing_links: []
        }
      ],
      graph_links: [],
      evidence: [
        {
          node_path: "/Knowledge/index.md",
          refs: [
            {
              link_text: "Source",
              via_path: "/Knowledge/index.md",
              source_content_hash: "sha256:abc",
              source_path: "/Sources/raw/source.md",
              source_updated_at: "3",
              source_etag: "source-etag",
              raw_href: "/Sources/raw/source.md"
            }
          ]
        }
      ],
      search_hits: [
        {
          title: "index",
          metadata: {
            path: "/Knowledge/index.md",
            kind: "file",
            score: 8.5,
            snippet: "Agent memory index",
            preview: "Agent memory index",
            match_reasons: ["content"]
          }
        }
      ]
    });
    expect(mocks.queryContext).toHaveBeenCalledWith(env, {
      databaseId: "db_alpha",
      task: "agent",
      entities: [],
      namespace: "/Knowledge",
      budgetTokens: 2000,
      includeEvidence: true,
      depth: 1
    });
  });

  it("returns memory manifest for a public database", async () => {
    await expect(readMemoryManifest(env, { database_id: "db_alpha" })).resolves.toEqual({
      api_version: "kinic-stores-v1",
      purpose: "Canister-backed memory",
      enabled_stores: ["knowledge"],
      roots: [{ path: "/Knowledge", kind: "knowledge" }],
      entry_roots: [{ path: "/Knowledge", kind: "knowledge" }],
      capabilities: [{ name: "query_context", description: "Task-scoped recall" }],
      canonical_roles: [{ name: "index", path_pattern: "index.md", purpose: "Catalog" }],
      write_policy: "stores_read_only",
      recommended_entrypoint: "query_context",
      max_depth: 2,
      max_query_limit: 100,
      budget_unit: "approx_chars_from_tokens"
    });
    expect(mocks.memoryManifest).toHaveBeenCalledWith(env, "db_alpha");
  });

  it("returns source evidence for a known path", async () => {
    await expect(readSourceEvidenceRefs(env, { database_id: "db_alpha", node_path: "Knowledge/index.md" })).resolves.toEqual({
      evidence: {
        node_path: "/Knowledge/index.md",
        refs: [
          {
            link_text: "Source",
            via_path: "/Knowledge/index.md",
            source_content_hash: "sha256:abc",
            source_path: "/Sources/raw/source.md",
            source_updated_at: "3",
            source_etag: "source-etag",
            raw_href: "/Sources/raw/source.md"
          }
        ]
      }
    });
    expect(mocks.sourceEvidence).toHaveBeenCalledWith(env, "db_alpha", "/Knowledge/index.md");
  });

  it("rejects invalid and stale fetch ids as tool errors", async () => {
    await expect(fetchSearchResult(env, { id: "bad" })).resolves.toMatchObject({
      isError: true,
      structuredContent: { error: "invalid search result id", id: "bad" }
    });

    const id = encodeSearchResultId({
      version: 1,
      canister_id: "other-canister",
      database_id: "db_alpha",
      path: "/Knowledge/index.md"
    });
    await expect(fetchSearchResult(env, { id })).resolves.toMatchObject({
      isError: true,
      structuredContent: { error: "search result id is for another canister", id }
    });
  });

  it("roundtrips unicode search result ids", () => {
    const payload = {
      version: 1 as const,
      canister_id: "canister-a",
      database_id: "db_alpha",
      path: "/Knowledge/日本語.md"
    };
    expect(decodeSearchResultId(encodeSearchResultId(payload))).toEqual(payload);
  });

  it("calls find_databases through MCP JSON-RPC", async () => {
    const response = await postMcp({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "find_databases", arguments: { query: "agent", limit: 1 } }
    });
    const text = response.result.content[0].text as string;
    expect(JSON.parse(text).databases).toHaveLength(1);
    expect(JSON.parse(text).databases[0].database_id).toBe("db_alpha");
  });

  it("calls source_evidence through MCP JSON-RPC", async () => {
    const response = await postMcp({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "source_evidence", arguments: { database_id: "db_alpha", node_path: "/Knowledge/index.md" } }
    });
    const text = response.result.content[0].text as string;
    expect(JSON.parse(text).evidence.node_path).toBe("/Knowledge/index.md");
  });

  it("returns http 400 for non-json MCP requests", async () => {
    const response = await worker.fetch(
      new Request("https://mcp.example.test/mcp", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "not json"
      }),
      env
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "bad request" });
  });

  it("delegates GET /mcp to the streamable transport", async () => {
    const response = await worker.fetch(new Request("https://mcp.example.test/mcp"), env);
    expect(response.status).toBe(406);
    expect(response.headers.get("access-control-allow-methods")).toBe("GET,POST,OPTIONS");
    await expect(response.json()).resolves.toMatchObject({
      error: { message: "Not Acceptable: Client must accept text/event-stream" }
    });
  });
});

async function postMcp(payload: Record<string, unknown>) {
  const response = await worker.fetch(
    new Request("https://mcp.example.test/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": "2025-06-18"
      },
      body: JSON.stringify(payload)
    }),
    env
  );
  expect(response.status).toBe(200);
  const text = await response.text();
  const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
  if (!dataLine) {
    throw new Error(`missing MCP SSE data event: ${text}`);
  }
  return JSON.parse(dataLine.slice("data: ".length));
}
