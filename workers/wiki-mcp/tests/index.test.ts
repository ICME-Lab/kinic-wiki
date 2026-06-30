// Where: workers/wiki-mcp/tests/index.test.ts
// What: Contract tests for the public read-only Kinic Wiki MCP Worker.
// Why: ChatGPT-facing tool names, output shapes, and id encoding must stay stable.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listDatabases: vi.fn(),
  readNode: vi.fn(),
  resolveCanisterId: vi.fn(),
  searchNodes: vi.fn()
}));

vi.mock("../src/vfs.js", () => ({
  listDatabases: mocks.listDatabases,
  readNode: mocks.readNode,
  resolveCanisterId: mocks.resolveCanisterId,
  searchNodes: mocks.searchNodes
}));

import worker, {
  decodeSearchResultId,
  encodeSearchResultId,
  fetchSearchResult,
  findDatabases,
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
        title: "Operations",
        description: "Runbooks and incident notes",
        llmSummary: "Production operations memory",
        tagsJson: "[\"ops\",\"runbook\"]",
        status: "active"
      },
      {
        databaseId: "db_alpha",
        title: "Agent Memory",
        description: "Project facts and preferences",
        llmSummary: "Memory for agent workflows",
        tagsJson: "[\"agent\",\"memory\"]",
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
    mocks.readNode.mockResolvedValue({
      path: "/Knowledge/index.md",
      kind: "file",
      content: "Agent memory body",
      createdAt: "1",
      updatedAt: "2",
      etag: "etag-1",
      metadataJson: "{}"
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
      tools: ["find_databases", "search", "fetch"]
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
    expect(tools.map((tool) => tool.name).sort()).toEqual(["fetch", "find_databases", "search"]);
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
          title: "Agent Memory",
          description: "Project facts and preferences",
          tags: ["agent", "memory"],
          url: "https://wiki.kinic.test/db/db_alpha",
          score: 18
        },
        {
          database_id: "db_beta",
          title: "Operations",
          description: "Runbooks and incident notes",
          tags: ["ops", "runbook"],
          url: "https://wiki.kinic.test/db/db_beta",
          score: 2
        }
      ]
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
    expect(mocks.searchNodes).toHaveBeenCalledWith(env, "db_alpha", "agent", "/", 5);
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
