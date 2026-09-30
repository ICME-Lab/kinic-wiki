import { expect, it } from "vitest";
import { validateAnswer } from "../src/contracts";
import { newDeepSeekTurn, runDeepSeekTurn } from "../src/deepseek";
import { emptyToolState, KinicReader, type ReadActor, type Node } from "../src/kinic";
import { inputText } from "../src/openai";

// Explicit live configuration only. Invented evidence; no private Wiki is read.
it("answers a Japanese overview with validated citations through live DeepSeek", async () => {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY is required");
  const nodes = new Map<string, Node>([
    ["/Knowledge/overview.md", { path: "/Knowledge/overview.md",
      content: "# Project Atlas\n\nThis database records the Atlas launch plan and a UI style guide.",
      etag: "a", metadata_json: "{}", updated_at: 1n }],
    ["/Knowledge/design.md", { path: "/Knowledge/design.md",
      content: "# UI style guide\n\nThe interface uses navy and ivory colors.",
      etag: "b", metadata_json: "{}", updated_at: 2n }],
  ]);
  const actor: ReadActor = {
    read_node: async (_db, path) => ({ Ok: nodes.has(path) ? [nodes.get(path)!] : [] }),
    list_nodes: async ({ prefix }) => ({ Ok: prefix === "/Knowledge"
      ? [...nodes.values()].map((node) => ({ path: node.path, kind: { File: null },
          updated_at: node.updated_at, etag: node.etag, has_children: false }))
      : [] }),
    memory_manifest: async () => { throw new Error("unexpected memory_manifest"); },
    query_context: async () => { throw new Error("unexpected query_context"); },
    search_nodes: async () => { throw new Error("unexpected search_nodes"); },
    source_evidence: async () => { throw new Error("unexpected source_evidence"); },
  };
  const evidence = emptyToolState();
  const reader = new KinicReader(actor, "synthetic-overview", "database", evidence,
    24000, 12, "", "database_overview");
  const state = newDeepSeekTurn(inputText(crypto.randomUUID(),
    "このDBの内容とUIの配色を教えてください", "database", undefined, [],
    "database_overview", { kind: "database" }));
  const result = await runDeepSeekTurn({
    state, apiKey, scope: "database", route: "database_overview", deadline: Date.now() + 90_000,
    authorize: async () => {}, checkpoint: async () => {},
    execute: (name, args) => reader.execute(name, args),
  });
  const answer = validateAnswer(result, evidence.evidence);
  expect(evidence.inventoryObserved).toBe(2);
  expect(answer.insufficient).toBe(false);
  expect(answer.citations.length).toBeGreaterThan(0);
  expect(answer.answer).toMatch(/Atlas|アトラス/);
  expect(answer.answer).toMatch(/navy|ネイビー|紺/i);
  expect(answer.answer).toMatch(/ivory|アイボリー|象牙/i);
  console.log(JSON.stringify({ event: "deepseek_synthetic_overview",
    readCount: evidence.readPaths.length, citationCount: answer.citations.length,
    rounds: state.rounds }));
}, 120_000);
