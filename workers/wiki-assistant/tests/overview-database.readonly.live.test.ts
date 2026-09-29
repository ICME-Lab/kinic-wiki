import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { emptyToolState, KinicReader, type ReadActor } from "../src/kinic";

const databaseId = process.env.KINIC_LIVE_DATABASE_ID;
const canisterId = process.env.KINIC_LIVE_CANISTER_ID;

// Opt-in read-only check: exercises the real canister through the CLI without
// transmitting Wiki content to an AI provider.
it("inventories and reads real Wiki evidence", async () => {
  if (!databaseId || !canisterId)
    throw new Error("KINIC_LIVE_DATABASE_ID and KINIC_LIVE_CANISTER_ID are required");
  const cli = resolve(import.meta.dirname, "../../../target/debug/kinic-vfs-cli");
  const call = (args: string[]) => {
    try {
      return JSON.parse(execFileSync(cli, [
        "--canister-id", canisterId!, "--database-id", databaseId!,
        "--identity-mode", "identity", "--allow-non-ii-identity", ...args, "--json",
      ], { encoding: "utf8", timeout: 15_000, maxBuffer: 2_000_000, stdio: ["ignore", "pipe", "pipe"] }));
    } catch {
      throw new Error("private_wiki_cli_read_failed");
    }
  };
  const actor = {
    read_node: async (_db: string, path: string) => {
      const node = call(["read-node", "--path", path]);
      return { Ok: [{ ...node, updated_at: BigInt(node.updated_at) }] };
    },
    list_nodes: async (request: { prefix: string; recursive: boolean; limit: number }) => {
      const args = ["list-nodes", "--prefix", request.prefix, "--limit", String(request.limit)];
      if (request.recursive) args.push("--recursive");
      return { Ok: call(args).map((entry: { kind: string; updated_at: number }) => ({
        ...entry,
        kind: { [entry.kind === "file" ? "File" : entry.kind === "source" ? "Source" : "Folder"]: null },
        updated_at: BigInt(entry.updated_at),
      })) };
    },
    memory_manifest: async () => { throw new Error("unexpected memory_manifest"); },
    query_context: async () => { throw new Error("unexpected query_context"); },
    search_nodes: async () => { throw new Error("unexpected search_nodes"); },
    source_evidence: async () => { throw new Error("unexpected source_evidence"); },
  } as ReadActor;
  const state = emptyToolState();
  const reader = new KinicReader(actor, databaseId!, "database", state, 24000, 12, "", "database_overview");
  const inventory = JSON.parse(await reader.execute("wiki_inventory", {})) as {
    observed: { root: number; knowledge: number; memory: number };
    truncated: boolean;
    nodes: { path: string; preview: string }[];
  };
  expect(inventory.nodes.length).toBeGreaterThan(0);
  let readCount = 0;
  for (const node of inventory.nodes.slice(0, 4)) {
    const read = JSON.parse(await reader.execute("wiki_read", { path: node.path, start: 0 })) as {
      path: string; excerpt: string; totalCharacters: number;
    };
    expect(read.path === node.path).toBe(true);
    expect(read.excerpt.length).toBeGreaterThan(0);
    expect(read.totalCharacters).toBeGreaterThanOrEqual(read.excerpt.length);
    readCount++;
  }
  expect(state.evidence.length).toBe(readCount);
  const result = { event: "overview_database_readonly", observed: inventory.observed,
    truncated: inventory.truncated, previewCount: inventory.nodes.length, readCount };
  console.log(JSON.stringify(result));
}, 90_000);
