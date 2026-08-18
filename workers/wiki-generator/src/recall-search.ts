// Where: workers/wiki-generator/src/recall-search.ts
// What: LLM-assisted recall search: lexical candidate retrieval + semantic rerank.
// Why: Pure lexical search returns semantically unrelated nodes; the generator already
//      holds the DeepSeek key and the canister identity to rerank candidates against
//      the user's message intent.
import { fnv1aHex } from "@kinic/source-contracts";
import { loadConfig } from "./config.js";
import { extractDeepSeekResponseText, requestDeepSeekDraft } from "./openai.js";
import type { RuntimeEnv } from "./env.js";
import type { SearchNodeHit, WorkerConfig } from "./types.js";
import { createVfsClient, type VfsClient } from "./vfs.js";

export const RECALL_QUERY_MAX_CHARS = 2_000;
const RECALL_TOP_K = 20;
const RECALL_MAX_CANDIDATES = 60;
const RECALL_RESULT_LIMIT = 3;
const RECALL_SNIPPET_CHARS = 300;

export type RecallSearchInput = {
  draft: string;
  distilledQuery: string;
  canisterId: string;
  databaseId: string;
  conversationUrl?: string;
};

export type RecallSearchOutcome = {
  mode: "reranked" | "lexical";
  results: SearchNodeHit[];
};

export function parseRecallSearchInput(value: unknown): RecallSearchInput | string {
  if (!isObject(value)) return "draft, distilledQuery, canisterId, and databaseId are required";
  const draft = typeof value.draft === "string" ? value.draft.trim() : "";
  const distilledQuery = typeof value.distilledQuery === "string" ? value.distilledQuery.trim() : "";
  const canisterId = typeof value.canisterId === "string" ? value.canisterId.trim() : "";
  const databaseId = typeof value.databaseId === "string" ? value.databaseId.trim() : "";
  const conversationUrl = typeof value.conversationUrl === "string" ? value.conversationUrl : undefined;
  if (!draft || draft.length > RECALL_QUERY_MAX_CHARS) {
    return "draft is required and must not exceed 2000 characters";
  }
  if (!distilledQuery || distilledQuery.length > RECALL_QUERY_MAX_CHARS) {
    return "distilledQuery is required and must not exceed 2000 characters";
  }
  if (!canisterId) return "canisterId is required";
  if (!databaseId || databaseId.length > 128) return "databaseId is required and must not exceed 128 characters";
  return { draft, distilledQuery, canisterId, databaseId, conversationUrl };
}

export async function runRecallSearch(
  env: RuntimeEnv,
  input: RecallSearchInput,
  deps: { searchNodes?: VfsClient["searchNodes"] } = {}
): Promise<RecallSearchOutcome> {
  const config = loadConfig(env);
  if (input.canisterId !== config.canisterId) {
    throw new Error("canisterId does not match configured canister");
  }
  const searchNodes = deps.searchNodes
    ?? (await createVfsClient(config, env.KINIC_WIKI_WORKER_IDENTITY_PEM)).searchNodes;
  const [knowledge, sources] = await Promise.all([
    searchNodes(input.databaseId, input.distilledQuery, RECALL_TOP_K, "/Knowledge"),
    searchNodes(input.databaseId, input.distilledQuery, RECALL_TOP_K, "/Sources")
  ]);
  const candidates = dedupeByPath(excludeCurrentConversation([...knowledge, ...sources], input.conversationUrl)).slice(0, RECALL_MAX_CANDIDATES);
  if (candidates.length === 0) return { mode: "lexical", results: [] };

  const reranked = await rerankCandidates(env, config, input.draft, candidates);
  if (reranked.length > 0) return { mode: "reranked", results: reranked };
  return { mode: "lexical", results: candidates.slice(0, RECALL_RESULT_LIMIT) };
}

async function rerankCandidates(
  env: RuntimeEnv,
  config: WorkerConfig,
  draft: string,
  candidates: SearchNodeHit[]
): Promise<SearchNodeHit[]> {
  try {
    const body = await requestDeepSeekDraft(rerankMessages(draft, candidates), config, env.DEEPSEEK_API_KEY);
    const text = extractDeepSeekResponseText(body);
    return parseRerankResponse(text)
      .map((path) => candidates.find((candidate) => candidate.path === path))
      .filter((candidate): candidate is SearchNodeHit => Boolean(candidate))
      .slice(0, RECALL_RESULT_LIMIT);
  } catch {
    return [];
  }
}

function rerankMessages(
  draft: string,
  candidates: SearchNodeHit[]
): { role: "system" | "user"; content: string }[] {
  return [
    {
      role: "system",
      content:
        "You select the most relevant wiki memory nodes for the user's message. " +
        "Choose at most 3 paths from the provided candidates, ordered by relevance to the user's intent. " +
        "Only use candidate paths; never invent paths. Return only a JSON object matching " +
        '{"results":[{"path":"...","reason":"..."}]}.'
    },
    {
      role: "user",
      content: JSON.stringify({
        user_message: draft,
        candidates: candidates.map((candidate) => ({
          path: candidate.path,
          snippet: (candidate.previewExcerpt ?? candidate.snippet ?? "").slice(0, RECALL_SNIPPET_CHARS)
        }))
      })
    }
  ];
}

function parseRerankResponse(text: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!isObject(parsed)) return [];
  const results = parsed.results;
  if (!Array.isArray(results)) return [];
  return results
    .map((entry) => (isObject(entry) && typeof entry.path === "string" ? entry.path : ""))
    .filter((path) => path.length > 0);
}

function excludeCurrentConversation(hits: SearchNodeHit[], conversationUrl: string | undefined): SearchNodeHit[] {
  if (!conversationUrl) return hits;
  const conversationId = conversationIdFromUrl(conversationUrl);
  if (!conversationId) return hits;
  const currentHash = fnv1aHex(`chatgpt:${conversationId}`);
  return hits.filter(
    (hit) => !(hit.path.startsWith("/Sources/chatgpt/") && hit.path.endsWith(`-${currentHash}.md`))
  );
}

function conversationIdFromUrl(value: string): string {
  try {
    const match = new URL(value).pathname.match(/^\/(?:c|chat|(?:u\/\d+\/)?app)\/([^/]+)/);
    return match?.[1] ?? "";
  } catch {
    return "";
  }
}

function dedupeByPath(hits: SearchNodeHit[]): SearchNodeHit[] {
  const seen = new Set<string>();
  const deduped: SearchNodeHit[] = [];
  for (const hit of hits) {
    if (seen.has(hit.path)) continue;
    seen.add(hit.path);
    deduped.push(hit);
  }
  return deduped;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
