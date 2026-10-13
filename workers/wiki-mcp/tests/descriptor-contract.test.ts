import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, it } from "vitest";
import { createServer } from "../src/index.js";

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

for (const privateMode of [false, true]) {
  it(`preserves the ${privateMode ? "private 16" : "public 8"}-tool descriptor contract`, async () => {
    const server = createServer({}, { accessPolicy: privateMode ? "private_required" : "public", writesAvailable: privateMode });
    const client = new Client({ name: "descriptor-contract", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(privateMode ? 16 : 8);
      const snapshot = {
        instructions: client.getInstructions(),
        // In-memory transport retains undefined fields that HTTP JSON omits.
        tools: Object.fromEntries(tools.sort((a, b) => a.name.localeCompare(b.name)).map(tool =>
          [tool.name, createHash("sha256").update(stableJson(JSON.parse(JSON.stringify(tool)))).digest("hex")]))
      };
      const file = new URL(`../schemas/mcp-${privateMode ? "private-" : ""}descriptor-hashes.json`, import.meta.url);
      // Explicit local regeneration; ordinary test runs never rewrite snapshots.
      if (process.env.UPDATE_MCP_DESCRIPTORS === "1") writeFileSync(file, JSON.stringify(snapshot, null, 2) + "\n");
      expect(snapshot).toEqual(JSON.parse(readFileSync(file, "utf8")));
      if (privateMode) {
        for (const name of ["append_nodes", "edit_nodes", "multi_edit_nodes", "create_folders", "move_nodes", "delete_nodes"]) {
          const tool = tools.find(tool => tool.name === name)!;
          expect(tool.inputSchema).not.toHaveProperty("properties.operations.items.properties.type");
          expect(tool.inputSchema).toHaveProperty("properties.operations.minItems", 1);
          expect(tool.inputSchema).toHaveProperty("properties.operations.maxItems", 100);
        }
      }
    } finally {
      await client.close();
      await server.close();
    }
  });
}
