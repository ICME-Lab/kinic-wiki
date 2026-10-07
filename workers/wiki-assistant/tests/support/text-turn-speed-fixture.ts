import { vi } from "vitest";
import { emptyToolState, KinicReader, type Node, type ReadActor } from "../../src/kinic";
import type { Conversation, Pending } from "../../src/state";
import type { TurnContext } from "../../src/turn-context";
import type { AskAiRoute } from "../../src/routing";
export function setup(route: AskAiRoute, documents = 4) {
  const requestId = crypto.randomUUID(), now = Date.now();
  const nodes = Array.from({ length: documents }, (_, index): Node => ({
    path: `/Knowledge/overview-${index}.md`, content: `Verified document ${index}. ` + "x".repeat(4000),
    etag: `v${index}`, metadata_json: "{}", updated_at: 1n,
  }));
  const actor: ReadActor = {
    read_node: vi.fn(async (_db, path) => ({ Ok: nodes.filter(node => node.path === path).slice(0, 1) as [] | [Node] })),
    list_nodes: vi.fn(async ({ prefix }) => ({ Ok: prefix === "/Knowledge" ? nodes.map(node => ({
      path: node.path, kind: { File: null }, etag: node.etag, updated_at: node.updated_at, has_children: false,
    })) : [] })),
    search_nodes: vi.fn(async () => ({ Ok: [] })),
    query_context: vi.fn(async () => { throw new Error("Do not change the canister authorization contract"); }),
    memory_manifest: vi.fn(async () => ({ Ok: { api_version: "1", recommended_entrypoint: "query_context", roots: [] } })),
    source_evidence: vi.fn(async ({ node_path }) => ({ Ok: { node_path, refs: [] } })),
  };
  const pending: Pending = {
    input: { requestId, question: "Summarize", scope: "database", subject: { kind: "database" } },
    generation: 1, started: now, stage: "new", turnId: null, tools: emptyToolState(), results: {}, delegationId: null, route,
  };
  const conversation: Conversation = {
    format: 3, native: true, nativeTextProvider: "deepseek", id: "conversation", authId: "auth", principal: "owner",
    databaseId: "db", scope: "database", sessionId: null, generation: 1, pending, activity: now, seen: now,
    status: "working", error: null, messages: [], history: [], utterances: [], transcripts: [], delegations: [], deferred: null,
  };
  const subject = route === "selected_node_summary" ? { kind: "node" as const, path: nodes[0]!.path } : { kind: "database" as const };
  if (subject.kind === "node") pending.tools.discoveredPaths.push(subject.path);
  const reader = new KinicReader(actor, "db", "database", pending.tools, 24000, 12, "fake", route, false);
  const context: TurnContext = { conversation, pending, route, subject,
    valid: vi.fn(async () => true), reader: vi.fn(async () => reader), checkpoint: vi.fn(async () => {}),
  };
  const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    const evidence = body.messages.filter((message: { role: string }) => message.role === "tool")
      .map((message: { content: string }) => JSON.parse(message.content)).find((value: { id?: string }) => value.id);
    return Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: JSON.stringify({
      answer: evidence ? "A grounded summary" : "No evidence", insufficient: !evidence,
      citations: evidence ? [{ id: evidence.id, quote: evidence.excerpt.slice(0, 20) }] : [], contradictions: [], unverified: [],
    }) } }] });
  });
  vi.stubGlobal("fetch", fetchImpl);
  return { context, reader, actor, nodes, pending, fetchImpl, options: { apiKey: "fake", deadline: now + 90000, signal: new AbortController().signal } };
}
