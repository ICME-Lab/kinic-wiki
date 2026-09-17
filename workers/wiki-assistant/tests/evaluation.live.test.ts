import { expect, it } from "vitest";
import { evaluationCases } from "./evaluation-cases";
import {
  client,
  createAgent,
  cancelAgent,
  deleteAgent,
  messageText,
  sessionItems,
} from "../src/openai";
import {
  emptyToolState,
  KinicReader,
  type ReadActor,
  type Node,
} from "../src/kinic";
import { validateAnswer } from "../src/contracts";

// Opt-in only: this suite incurs API charges and is excluded from `pnpm test`.
it.each(evaluationCases)(
  "grounding evaluation: $id",
  async (fixture) => {
    if (!process.env.OPENAI_API_KEY)
      throw new Error(
        "OPENAI_API_KEY is required for the opt-in evaluation; do not paste it in test output.",
      );
    const api = client(process.env.OPENAI_API_KEY);
    const scope = "scope" in fixture ? fixture.scope : "/Knowledge";
    const notePath = scope + "/decision.md",
      sourcePath = "/Sources/approved.md";
    const node = (path: string, content: string): Node => ({
      path,
      content,
      etag: "fixture-v1",
      metadata_json: "{}",
      updated_at: 0n,
    });
    const nodes = new Map([
      [notePath, node(notePath, fixture.note)],
      ...(fixture.source === null
        ? []
        : [[sourcePath, node(sourcePath, fixture.source)] as const]),
    ]);
    const actor: ReadActor = {
      read_node: async (_db, path) => ({
        Ok: nodes.has(path) ? [nodes.get(path)!] : [],
      }),
      memory_manifest: async () => ({
        Ok: {
          api_version: "1",
          recommended_entrypoint: "query_context",
          roots: [],
        },
      }),
      query_context: async () => ({
        Ok: { nodes: [{ node: nodes.get(notePath)! }], truncated: false },
      }),
      source_evidence: async () => ({
        Ok: {
          node_path: notePath,
          refs:
            fixture.source === null
              ? []
              : [
                  {
                    source_path: sourcePath,
                    source_etag: ["fixture-v1"],
                    source_updated_at: [0n],
                  },
                ],
        },
      }),
    };
    const state = emptyToolState();
    const reader = new KinicReader(actor, "synthetic-evaluation", scope, state);
    const session = await createAgent(
      api,
      crypto.randomUUID(),
      crypto.randomUUID(),
      JSON.stringify({ question: fixture.question, scope }),
    );
    const results = new Map<string, string>();
    const started = Date.now();
    try {
      while (Date.now() - started < 90000) {
        const current = await api.beta.agents.sessions.retrieve(session.id);
        if (current.status === "failed")
          throw new Error("Agent session failed");
        for (const action of current.required_actions) {
          if (action.type !== "function_call")
            throw new Error("Unexpected action");
          const output =
            results.get(action.call_id) ??
            (await reader.execute(action.name, action.arguments));
          results.set(action.call_id, output);
          await api.beta.agents.sessions.events.create(session.id, {
            events: [
              {
                type: "agent.session.input.tool_result",
                turn_id: action.turn_id,
                call_id: action.call_id,
                success: true,
                output,
              },
            ],
          });
        }
        const turns = await api.beta.agents.sessions.turns.list(session.id, {
          limit: 1,
        });
        const turn = turns.data[0];
        if (turn?.status === "failed" || turn?.status === "cancelled")
          throw new Error("Agent turn failed");
        if (turn?.status === "completed") {
          const items = await sessionItems(api, session.id);
          const final = items.find(
            (item) =>
              item.type === "message" &&
              item.role === "assistant" &&
              item.phase === "final_answer" &&
              item.turn_id === turn.id,
          );
          expect(final).toBeDefined();
          const answer = validateAnswer(
            JSON.parse(messageText(final!)),
            state.evidence,
          );
          if ("expected" in fixture) {
            expect(answer.answer).toContain(fixture.expected);
            expect(answer.citations.some((c) => c.path === sourcePath)).toBe(
              true,
            );
          }
          if ("insufficient" in fixture) expect(answer.insufficient).toBe(true);
          if ("unverified" in fixture)
            expect(answer.insufficient || answer.unverified.length > 0).toBe(
              true,
            );
          if ("contradiction" in fixture)
            expect(answer.contradictions.length).toBeGreaterThan(0);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      throw new Error("Evaluation deadline exceeded");
    } finally {
      try {
        await cancelAgent(api, session.id);
      } catch {
        /* Delete even if cancel has already completed. */
      }
      try {
        await deleteAgent(api, session.id);
      } catch {
        throw new Error(
          `Evaluation session cleanup failed; retry deletion for ${session.id}`,
        );
      }
    }
  },
  120000,
);
