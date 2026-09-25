import { afterAll, expect, it } from "vitest";
import { appendFileSync } from "node:fs";
import { evaluationCases } from "./evaluation-cases";
import {
  client,
  createAgent,
  cancelAgent,
  deleteAgent,
  inputText,
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
const startIndex = process.env.JEV_EVAL_START_CASE
  ? evaluationCases.findIndex((fixture) => fixture.id === process.env.JEV_EVAL_START_CASE)
  : 0;
if (startIndex < 0) throw new Error("JEV_EVAL_START_CASE did not match a fixture");
const selectedCases = process.env.JEV_EVAL_CASE
  ? evaluationCases.filter((fixture) => fixture.id === process.env.JEV_EVAL_CASE)
  : evaluationCases.slice(startIndex);
if (selectedCases.length === 0) throw new Error("JEV_EVAL_CASE did not match a fixture");

function trace(caseId: string, mode: EvaluationMode, step: string): void {
  if (process.env.JEV_EVAL_TRACE !== "1") return;
  const message = JSON.stringify({ event: "jev_live_evaluation_step", caseId, mode, step, at: Date.now() });
  if (process.env.JEV_EVAL_TRACE_PATH)
    appendFileSync(process.env.JEV_EVAL_TRACE_PATH, `${message}\n`);
  else console.log(message);
}

// Opt-in only: this suite incurs TypeSafe and OpenAI API charges and is excluded
// from `pnpm test`. Each case runs once with the FTS top five and once with Jev.
it.each(selectedCases)(
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
  300000,
);

afterAll(() => {
  // A per-case failure (including a --bail run) already reports its cause.
  if (metrics.length !== selectedCases.length) return;
  if (selectedCases.length !== evaluationCases.length) return;
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
    list_nodes: async () => ({ Ok: [] }),
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
    "focused_search",
  );
  const results = new Map<string, string>();
  const started = Date.now();
  const signal = AbortSignal.timeout(90_000);
  const requestId = crypto.randomUUID();
  trace(fixture.id, mode, "create_session");
  const session = await createAgent(
    api,
    crypto.randomUUID(),
    requestId,
    inputText(requestId, fixture.question, scope, undefined, [], "focused_search"),
    signal,
  );
  trace(fixture.id, mode, "session_created");
  let selectedGold = false;
  let citationReachedMs: number | null = null;
  try {
    while (!signal.aborted) {
      trace(fixture.id, mode, "retrieve_session");
      const current = await api.beta.agents.sessions.retrieve(session.id, { signal });
      trace(fixture.id, mode, `session_${current.status}`);
      if (current.status === "failed") throw new Error("Agent session failed");
      for (const action of current.required_actions) {
        if (action.type !== "function_call")
          throw new Error("Unexpected action");
        const output =
          results.get(action.call_id) ??
          (await reader.execute(action.name, action.arguments));
        trace(fixture.id, mode, `tool_${action.name}`);
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
        }, { signal });
        trace(fixture.id, mode, "tool_result_sent");
      }
      trace(fixture.id, mode, "list_turns");
      const turns = await api.beta.agents.sessions.turns.list(session.id, {
        limit: 1,
      }, { signal });
      const turn = turns.data[0];
      trace(fixture.id, mode, `turn_${turn?.status ?? "missing"}`);
      if (turn?.status === "failed" || turn?.status === "cancelled")
        throw new Error("Agent turn failed");
      if (turn?.status === "completed") {
        if (mode === "jev") {
          trace(fixture.id, mode, "list_items");
          const items = await sessionItems(api, session.id, signal);
          trace(fixture.id, mode, "items_listed");
          const final = items.find(
            (item) =>
              item.type === "message" &&
              item.role === "assistant" &&
              item.phase === "final_answer" &&
              item.turn_id === turn.id,
          );
          expect(final).toBeDefined();
          const rawAnswer = JSON.parse(messageText(final!));
          if (process.env.JEV_EVAL_DIAGNOSE_CITATIONS === "1") {
            const citations = (rawAnswer as { citations?: { id: string; quote: string }[] }).citations ?? [];
            console.log(JSON.stringify({
              event: "jev_citation_diagnostic",
              caseId: fixture.id,
              citations: citations.map(({ id, quote }) => {
                const source = state.evidence.find((item) => item.id === id);
                return { path: source?.path ?? null, quote, excerpt: source?.excerpt ?? null, exact: source?.excerpt.includes(quote) ?? false };
              }),
            }));
          }
          const answer = validateAnswer(rawAnswer, state.evidence);
          validateFixtureAnswer(fixture, answer, sourcePath);
        }
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
    trace(fixture.id, mode, "cancel_session");
    try {
      await cancelAgent(api, session.id, AbortSignal.timeout(15_000));
    } catch {
      /* Delete even if cancel has already completed. */
    }
    trace(fixture.id, mode, "delete_session");
    try {
      await deleteAgent(api, session.id, AbortSignal.timeout(15_000));
      trace(fixture.id, mode, "session_deleted");
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
  if ("unverified" in fixture) {
    // A source-backed answer that explicitly says the claim is not established
    // is also correct; it need not repeat that conclusion in `unverified`.
    const sourceBackedNegative =
      answer.citations.some((citation) => citation.path === sourcePath) &&
      /未(?:確定|確認|決定|公開|レビュー)|決まって(?:いない|いません)|確定(?:していない|していません|ではない)|確認(?:できない|できません)|不明|まだ|not (?:confirmed|decided|verified)/iu.test(answer.answer);
    expect(answer.insufficient || answer.unverified.length > 0 || sourceBackedNegative).toBe(true);
  }
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
