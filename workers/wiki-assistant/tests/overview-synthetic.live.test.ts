import { expect, it } from "vitest";
import { validateAnswer } from "../src/contracts";
import { emptyToolState, KinicReader, type ReadActor, type Node } from "../src/kinic";
import { cancelAgent, client, createAgent, deleteAgent, inputText, messageText, sessionItems } from "../src/openai";

// Opt-in OpenAI test with invented Wiki content. No private database is read.
it("generates a cited database overview from synthetic nodes", async () => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is required");
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
  const state = emptyToolState();
  const reader = new KinicReader(actor, "synthetic-overview", "database", state, 24000, 12, "", "database_overview");
  const api = client(apiKey);
  const requestId = crypto.randomUUID();
  const signal = AbortSignal.timeout(90_000);
  const session = await createAgent(api, crypto.randomUUID(), requestId,
    inputText(requestId, "このDBの内容を教えて", "database", undefined, [], "database_overview", { kind: "database" }), signal);
  const outputs = new Map<string, string>();
  try {
    while (!signal.aborted) {
      const current = await api.beta.agents.sessions.retrieve(session.id, { signal });
      if (current.status === "failed") throw new Error("Agent session failed");
      for (const action of current.required_actions) {
        if (action.type !== "function_call") throw new Error("Unexpected action");
        const output = outputs.get(action.call_id) ?? await reader.execute(action.name, action.arguments);
        outputs.set(action.call_id, output);
        await api.beta.agents.sessions.events.create(session.id, {
          events: [{ type: "agent.session.input.tool_result", turn_id: action.turn_id,
            call_id: action.call_id, success: true, output }],
        }, { signal });
      }
      const turn = (await api.beta.agents.sessions.turns.list(session.id, { limit: 1 }, { signal })).data[0];
      if (turn?.status === "failed" || turn?.status === "cancelled") throw new Error("Agent turn failed");
      if (turn?.status === "completed") {
        const final = (await sessionItems(api, session.id, signal)).find((item) =>
          item.type === "message" && item.role === "assistant" && item.phase === "final_answer" && item.turn_id === turn.id);
        expect(final).toBeDefined();
        const answer = validateAnswer(JSON.parse(messageText(final!)), state.evidence);
        expect(state.inventoryObserved).toBe(2);
        expect(state.readPaths.length).toBeGreaterThan(0);
        expect(answer.citations.length).toBeGreaterThan(0);
        expect(answer.insufficient).toBe(false);
        expect(answer.answer).toMatch(/Atlas|アトラス/);
        console.log(JSON.stringify({ event: "overview_synthetic", answer: answer.answer,
          citedPaths: answer.citations.map((citation) => citation.path), readPaths: state.readPaths }));
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error("Synthetic overview timed out");
  } finally {
    try { await cancelAgent(api, session.id, AbortSignal.timeout(15_000)); } catch { /* completed */ }
    await deleteAgent(api, session.id, AbortSignal.timeout(15_000));
  }
}, 120_000);
