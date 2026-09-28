import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { validateAnswer } from "../src/contracts";
import { emptyToolState, KinicReader, type ReadActor } from "../src/kinic";
import {
  cancelAgent,
  client,
  createAgent,
  deleteAgent,
  inputText,
  messageText,
  sessionItems,
} from "../src/openai";
import { routeAskAiIntent } from "../src/routing";

const databaseId = process.env.KINIC_LIVE_DATABASE_ID;
const canisterId = process.env.KINIC_LIVE_CANISTER_ID;

// Dedicated config and explicit egress flag are both required. This reads a
// private DB and sends bounded Wiki excerpts to OpenAI, incurring API charges.
it(
  "answers a database overview from real Wiki nodes without iOS",
  async () => {
    if (process.env.KINIC_LIVE_PRIVATE_EGRESS !== "1")
      throw new Error("KINIC_LIVE_PRIVATE_EGRESS=1 is required for private Wiki egress");
    if (!databaseId || !canisterId)
      throw new Error("KINIC_LIVE_DATABASE_ID and KINIC_LIVE_CANISTER_ID are required");
    const openaiApiKey = process.env.OPENAI_API_KEY;
    const typesafeApiKey = process.env.TYPESAFE_API_KEY;
    if (!openaiApiKey || !typesafeApiKey) throw new Error("API keys are required");

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

    const question = "このDBの内容を教えて";
    const route = await routeAskAiIntent({
      question, subject: { kind: "database" }, apiKey: typesafeApiKey,
    });
    expect(route.route).toBe("database_overview");
    const state = emptyToolState();
    const reader = new KinicReader(actor, databaseId!, "database", state, 24000, 12, typesafeApiKey, route.route!);
    const api = client(openaiApiKey);
    const requestId = crypto.randomUUID();
    const signal = AbortSignal.timeout(90_000);
    const session = await createAgent(
      api, crypto.randomUUID(), requestId,
      inputText(requestId, question, "database", undefined, [], route.route!, { kind: "database" }),
      signal,
    );
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
        const turns = await api.beta.agents.sessions.turns.list(session.id, { limit: 1 }, { signal });
        const turn = turns.data[0];
        if (turn?.status === "failed" || turn?.status === "cancelled") throw new Error("Agent turn failed");
        if (turn?.status === "completed") {
          const items = await sessionItems(api, session.id, signal);
          const final = items.find((item) => item.type === "message" && item.role === "assistant" &&
            item.phase === "final_answer" && item.turn_id === turn.id);
          expect(final).toBeDefined();
          let answer;
          try {
            answer = validateAnswer(JSON.parse(messageText(final!)), state.evidence);
          } catch {
            throw new Error("private_wiki_answer_invalid");
          }
          expect(state.inventoryObserved).toBeGreaterThan(0);
          expect(state.readPaths.length).toBeGreaterThan(0);
          expect(answer.citations.length).toBeGreaterThan(0);
          console.log(JSON.stringify({ event: "database_overview_live",
            citationCount: answer.citations.length,
            inventoryObserved: state.inventoryObserved,
            inventoryTruncated: state.inventoryTruncated,
            readCount: state.readPaths.length,
            insufficient: answer.insufficient,
          }));
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      throw new Error("Overview evaluation timed out");
    } finally {
      try { await cancelAgent(api, session.id, AbortSignal.timeout(15_000)); } catch { /* completed */ }
      await deleteAgent(api, session.id, AbortSignal.timeout(15_000));
    }
  },
  120_000,
);
