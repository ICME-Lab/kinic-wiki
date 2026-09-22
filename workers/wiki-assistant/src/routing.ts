import { classifyWithJev, JevError } from "@kinic/jev-reranker";
import { AssistantError, type QuestionSubject } from "./contracts";

export const ASK_AI_ROUTE_MINIMUM = 0.7;
export const ASK_AI_ROUTE_MARGIN = 0.15;

export const askAiRouteNames = [
  "database_overview",
  "focused_search",
  "selected_node_summary",
  "conversation",
] as const;
export type AskAiRoute = (typeof askAiRouteNames)[number];

export type AskAiRouteResult = {
  route: AskAiRoute | null;
  durationMs: number;
};

export type AskAiRoutingHistoryItem = {
  role: "user" | "assistant";
  text: string;
};

export const ASK_AI_ROUTING_HISTORY_MESSAGES = 6;
export const ASK_AI_ROUTING_HISTORY_CHARACTERS = 4_000;

export function boundedRoutingHistory(
  items: readonly AskAiRoutingHistoryItem[],
): AskAiRoutingHistoryItem[] {
  const selected: AskAiRoutingHistoryItem[] = [];
  let remaining = ASK_AI_ROUTING_HISTORY_CHARACTERS;
  for (
    let index = items.length - 1;
    index >= 0 && selected.length < ASK_AI_ROUTING_HISTORY_MESSAGES && remaining > 0;
    index--
  ) {
    const item = items[index]!;
    const text = item.text.trim();
    if (!text) continue;
    const characters = Array.from(text);
    const bounded = characters.slice(0, remaining).join("");
    if (!bounded) continue;
    selected.push({ role: item.role, text: bounded });
    remaining -= Array.from(bounded).length;
  }
  return selected.reverse();
}

export async function routeAskAiIntent(input: {
  question: string;
  subject: QuestionSubject;
  history?: readonly AskAiRoutingHistoryItem[];
  apiKey: string;
}): Promise<AskAiRouteResult> {
  try {
    const result = await classifyWithJev({
      apiKey: input.apiKey,
      workflow: "ask_ai_route",
      state: {
        user_question: input.question,
        selected_target: input.subject,
        recent_conversation: boundedRoutingHistory(input.history ?? []),
      },
      questions: {
        database_overview: {
          question:
            "Does the user want a broad inventory, tour, or summary of what the selected database contains?",
          trueCriteria:
            "The request asks what is in the database overall, its main themes, sections, notes, or contents.",
          falseCriteria:
            "The request asks for one fact, one selected item, or a task that does not require the Wiki.",
        },
        focused_search: {
          question:
            "Does the user want a particular fact, topic, claim, or answer found and verified in the selected database?",
          trueCriteria:
            "The request has a focused information need that should retrieve relevant notes, including a follow-up whose referent is established by the recent conversation.",
          falseCriteria:
            "The request asks for a database-wide overview, a selected-item summary, or ordinary conversation.",
        },
        selected_node_summary: {
          question:
            "Does the user want the currently selected node or folder itself summarized or explained?",
          trueCriteria:
            "The request refers to the selected node or folder as the object to summarize or explain.",
          falseCriteria:
            "There is no selected node or folder, or the request concerns the database broadly or a separate topic.",
        },
        conversation: {
          question:
            "Can the request be completed as ordinary conversation or a transformation of user-provided text without reading the Wiki?",
          trueCriteria:
            "It is a greeting, brainstorming, drafting, rewriting, translation, or transformation whose needed text is supplied in the current request or recent conversation.",
          falseCriteria:
            "It asks about stored Wiki content or needs factual retrieval or verification.",
        },
      },
    });
    const ranked = askAiRouteNames
      .map((route, index) => ({
        route,
        index,
        probability: result.probabilities[route],
      }))
      .sort(
        (left, right) =>
          right.probability - left.probability || left.index - right.index,
      );
    const first = ranked[0]!;
    const second = ranked[1]!;
    return {
      route:
        first.probability >= ASK_AI_ROUTE_MINIMUM &&
        first.probability - second.probability >= ASK_AI_ROUTE_MARGIN
          ? first.route
          : null,
      durationMs: result.durationMs,
    };
  } catch (error) {
    if (error instanceof JevError)
      throw new AssistantError("jev_unavailable", 503);
    throw error;
  }
}

export function clarificationFor(question: string): string {
  return /[\u3040-\u30ff\u3400-\u9fff]/u.test(question)
    ? "DB全体の概要を知りたいのか、特定のページを要約したいのか、特定の情報を検索したいのかを教えてください。"
    : "Please clarify whether you want an overview of the whole database, a summary of a selected page, or a search for specific information.";
}
