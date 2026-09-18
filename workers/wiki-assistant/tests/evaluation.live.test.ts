import { afterAll, expect, it } from "vitest";
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
import { validateAnswer, type Answer } from "../src/contracts";

type EvaluationFixture = (typeof evaluationCases)[number];
type EvaluationMode = "fts" | "jev";
type EvaluationRun = {
  selectedGold: boolean;
  citationReachedMs: number | null;
  jevDurationMs: number;
};
type EvaluationMetric = {
  caseId: string;
  fts: EvaluationRun;
  jev: EvaluationRun;
};

const metrics: EvaluationMetric[] = [];

// Opt-in only: this suite incurs TypeSafe and OpenAI API charges and is excluded
// from `pnpm test`. Each case runs once with the FTS top five and once with Jev.
it.each(evaluationCases)(
  "grounding evaluation: $id",
  async (fixture) => {
    const openaiApiKey = process.env.OPENAI_API_KEY;
    const typesafeApiKey = process.env.TYPESAFE_API_KEY;
    if (!openaiApiKey)
      throw new Error(
        "OPENAI_API_KEY is required for the opt-in evaluation; do not paste it in test output.",
      );
    if (!typesafeApiKey)
      throw new Error(
        "TYPESAFE_API_KEY is required for the opt-in Jev evaluation; do not paste it in test output.",
      );

    const caseIndex = evaluationCases.findIndex(
      (candidate) => candidate.id === fixture.id,
    );
    const fts = await runEvaluation(
      fixture,
      caseIndex,
      "fts",
      openaiApiKey,
      typesafeApiKey,
    );
    const jev = await runEvaluation(
      fixture,
      caseIndex,
      "jev",
      openaiApiKey,
      typesafeApiKey,
    );
    metrics.push({ caseId: `case-${caseIndex + 1}`, fts, jev });
  },
  240000,
);

afterAll(() => {
  expect(metrics).toHaveLength(evaluationCases.length);
  const ftsRecall = recallAtFive(metrics.map(({ fts }) => fts));
  const jevRecall = recallAtFive(metrics.map(({ jev }) => jev));
  const ftsMedianMs = medianReached(
    metrics.map(({ fts }) => fts.citationReachedMs),
  );
  const jevMedianMs = medianReached(
    metrics.map(({ jev }) => jev.citationReachedMs),
  );
  const jevP95Ms = percentile(
    metrics.map(({ jev }) => jev.jevDurationMs),
    0.95,
  );

  console.log(
    JSON.stringify({
      event: "jev_live_evaluation",
      cases: metrics.length,
      ftsRecallAt5: ftsRecall,
      jevRecallAt5: jevRecall,
      ftsMedianCorrectCitationMs: printableDuration(ftsMedianMs),
      jevMedianCorrectCitationMs: printableDuration(jevMedianMs),
      jevP95Ms,
    }),
  );

  expect(jevRecall).toBeGreaterThanOrEqual(ftsRecall);
  expect(jevMedianMs).toBeLessThan(ftsMedianMs);
  expect(jevP95Ms).toBeLessThanOrEqual(1000);
});

async function runEvaluation(
  fixture: EvaluationFixture,
  caseIndex: number,
  mode: EvaluationMode,
  openaiApiKey: string,
  typesafeApiKey: string,
): Promise<EvaluationRun> {
  const api = client(openaiApiKey);
  const scope = "scope" in fixture ? fixture.scope : "/Knowledge";
  const caseNumber = String(caseIndex + 1).padStart(2, "0");
  const notePath = `${scope}/evidence-${caseNumber}.md`;
  const sourcePath = `/Sources/approved-${caseNumber}.md`;
  const goldRank = caseIndex + 1;
  const distractors = Array.from({ length: 19 }, (_, index) => ({
    path: `${scope}/candidate-${caseNumber}-${String(index + 1).padStart(2, "0")}.md`,
    content: `Synthetic unrelated candidate ${index + 1}; it contains no answer to this evaluation question.`,
  }));
  let distractorIndex = 0;
  const ftsCandidates = Array.from({ length: 20 }, (_, index) => {
    if (index + 1 === goldRank)
      return {
        path: notePath,
        snippet: [fixture.note.slice(0, 600)] as [string],
        preview: [] as [],
      };
    const distractor = distractors[distractorIndex++]!;
    return {
      path: distractor.path,
      snippet: [distractor.content] as [string],
      preview: [] as [],
    };
  });
  const node = (path: string, content: string): Node => ({
    path,
    content,
    etag: "fixture-v1",
    metadata_json: "{}",
    updated_at: 0n,
  });
  const nodes = new Map([
    [notePath, node(notePath, fixture.note)],
    ...distractors.map(
      ({ path, content }) => [path, node(path, content)] as const,
    ),
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
    search_nodes: async () => ({
      Ok: mode === "fts" ? ftsCandidates.slice(0, 5) : ftsCandidates,
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
  const reader = new KinicReader(
    actor,
    "synthetic-evaluation",
    scope,
    state,
    24000,
    12,
    typesafeApiKey,
  );
  const results = new Map<string, string>();
  const started = Date.now();
  const session = await createAgent(
    api,
    crypto.randomUUID(),
    crypto.randomUUID(),
    JSON.stringify({ question: fixture.question, scope }),
  );
  let selectedGold = false;
  let citationReachedMs: number | null = null;
  try {
    while (Date.now() - started < 90000) {
      const current = await api.beta.agents.sessions.retrieve(session.id);
      if (current.status === "failed") throw new Error("Agent session failed");
      for (const action of current.required_actions) {
        if (action.type !== "function_call")
          throw new Error("Unexpected action");
        const output =
          results.get(action.call_id) ??
          (await reader.execute(action.name, action.arguments));
        results.set(action.call_id, output);
        if (action.name === "wiki_query") {
          const paths = (
            JSON.parse(output) as { nodes: { path: string }[] }
          ).nodes.map(({ path }) => path);
          selectedGold ||= paths.includes(notePath);
        }
        if (
          citationReachedMs === null &&
          state.evidence.some(({ path }) => path === notePath)
        )
          citationReachedMs = Date.now() - started;
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
        if (mode === "jev") validateFixtureAnswer(fixture, answer, sourcePath);
        return {
          selectedGold,
          citationReachedMs,
          jevDurationMs: state.jevDurationMs,
        };
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
}

function validateFixtureAnswer(
  fixture: EvaluationFixture,
  answer: Answer,
  sourcePath: string,
): void {
  if ("expected" in fixture) {
    expect(answer.answer).toContain(fixture.expected);
    expect(
      answer.citations.some((citation) => citation.path === sourcePath),
    ).toBe(true);
  }
  if ("insufficient" in fixture) expect(answer.insufficient).toBe(true);
  if ("unverified" in fixture)
    expect(answer.insufficient || answer.unverified.length > 0).toBe(true);
  if ("contradiction" in fixture)
    expect(answer.contradictions.length).toBeGreaterThan(0);
}

function recallAtFive(runs: EvaluationRun[]): number {
  return runs.filter(({ selectedGold }) => selectedGold).length / runs.length;
}

function medianReached(values: (number | null)[]): number {
  const sorted = values
    .map((value) => value ?? Number.POSITIVE_INFINITY)
    .sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
}

function percentile(values: number[], quantile: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)]!;
}

function printableDuration(value: number): number | "unreached" {
  return Number.isFinite(value) ? value : "unreached";
}
