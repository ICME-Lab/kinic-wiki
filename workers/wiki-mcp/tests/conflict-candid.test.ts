import { afterEach, describe, expect, it, vi } from "vitest";
import { IDL } from "@icp-sdk/core/candid";
import type { Actor, Identity } from "@icp-sdk/core/agent";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

const mocks = vi.hoisted(() => ({ createActor: vi.fn() }));
vi.mock("@icp-sdk/core/agent", async original => ({
  ...await original<typeof import("@icp-sdk/core/agent")>(),
  Actor: { createActor: mocks.createActor }, HttpAgent: { createSync: () => ({}) }
}));
import { createServer } from "../src/index.js";
import { readNode, type RuntimeEnv } from "../src/vfs.js";
import { clipText } from "../src/text.js";

afterEach(() => vi.clearAllMocks());

// Only transport/actor calls are replaced. The real VFS Candid types, node
// normalization, conflict handler and MCP response formatter remain in use.
const wireResult = IDL.Variant({ Ok: IDL.Opt(IDL.Record({
  path: IDL.Text, kind: IDL.Variant({ File: IDL.Null }), content: IDL.Text,
  created_at: IDL.Int64, updated_at: IDL.Int64, etag: IDL.Text, metadata_json: IDL.Text
})), Err: IDL.Text });

describe.each(["write_nodes", "mutate_nodes_batch"])("%s conflict through real Candid decoding", tool => {
  it.each(["", "a".repeat(40_000), "a".repeat(40_001), "a".repeat(300_000),
    "\uFEFF日本語\0😀".repeat(30_000), "😀".repeat(80_000)])("preserves original UTF-16 size and bounded content (%#)", async content => {
    const path = "/Memory/conflict.md";
    const wire = IDL.encode([wireResult], [{ Ok: [{ path, kind: { File: null }, content,
      created_at: 1n, updated_at: 2n, etag: "current", metadata_json: "{}" }] }]);
    mocks.createActor.mockImplementation((factory: Parameters<typeof Actor.createActor>[0]) => {
      const methods = factory({ IDL }).fieldsAsObject();
      const conflict = async () => ({ Err: { code: { EtagConflict: null }, message: "stale",
        failed_index: [0], conflict_path: [path] } });
      return {
        read_node: async () => IDL.decode(methods.read_node.retTypes, wire)[0],
        write_nodes: conflict, mutate_nodes_batch: conflict
      };
    });
    const env: RuntimeEnv = {
      KINIC_WIKI_CANISTER_ID: "aaaaa-aa", KINIC_WIKI_IDENTITY: {} as Identity,
      KINIC_WIKI_AUTHORIZATION: { scopes: ["mcp:read", "mcp:write"],
        actionPermission: "all", identitySource: "internet_identity" }
    };
    const node = await readNode(env, "db_alpha", path);
    expect(node?.contentSize).toBe(content.length);
    expect(node!.content.length).toBeLessThanOrEqual(40_002);

    const server = createServer(env, { accessPolicy: "private_required", writesAvailable: true });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    try {
      const parsedBody = { jsonrpc: "2.0" as const, id: 1, method: "tools/call", params: {
        name: tool, arguments: tool === "write_nodes"
          ? { database_id: "db_alpha", nodes: [{ path, kind: "file", content: "new", metadata_json: "{}", expected_etag: "stale" }] }
          : { database_id: "db_alpha", operations: [{ type: "edit", path, old_text: "old", new_text: "new", expected_etag: "stale" }] }
      } };
      const response = await transport.handleRequest(new Request("https://wiki-mcp.test/mcp", {
        method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify(parsedBody)
      }), { parsedBody });
      expect(response.status).toBe(200);
      const text = await response.text();
      const { result } = JSON.parse(text.startsWith("event:") ? text.split("\n").find(line => line.startsWith("data: "))!.slice(6) : text);
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text)).toMatchObject({ error: "etag_conflict", current_etag: "current",
        current_content_size: content.length, current_content: clipText(content, 40_000),
        current_content_truncated: content.length > 40_000 });
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(256_000);
    } finally {
      await server.close();
    }
  });
});
