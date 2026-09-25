import { classifyWithJev } from "@kinic/jev-reranker";

type Candidate = { path: string; preview: string };
type RerankRequest = {
  databaseId: string;
  sessionNonce: string;
  question: string;
  candidates: Candidate[];
};
type RateLimitStore = CloudflareEnv["QUERY_ANSWER_RATE_LIMIT"];
type RecallEnv = Pick<CloudflareEnv,
  "KINIC_WIKI_CANISTER_ID" | "KINIC_WIKI_CLIPPER_ORIGIN" |
  "KINIC_WIKI_ALLOWED_DATABASE_ID" | "RECALL_ALLOWED_DATABASE_ID" | "QUERY_ANSWER_RATE_LIMIT" |
  "TYPESAFE_API_KEY" | "RECALL_JEV_ENABLED" | "RECALL_JEV_THRESHOLD"
>;
type Dependencies = {
  checkSession: (canisterId: string, input: { databaseId: string; sessionNonce: string }) => Promise<{ principal: string }>;
  score: typeof classifyWithJev;
  rateStore: RateLimitStore;
};

const MAX_BODY_CHARS = 12_000;
const MAX_QUESTION_CHARS = 2_000;
const MAX_CANDIDATES = 20;
const MAX_PREVIEW_CHARS = 300;
const MAX_RESULTS = 3;
const RATE_LIMIT_PER_MINUTE = 10;
const ALLOWED_ORIGINS = new Set([
  "https://wiki.kinic.xyz",
  "https://kinic.xyz",
  "chrome-extension://jcfniiflikojmbfnaoamlbbddlikchaj",
  "chrome-extension://hbnicbmdodpmihmcnfgejcdgbfmemoci",
  "chrome-extension://moebdnadaffhlddnhifmmdoecifhcbdi"
]);

let testDeps: Partial<Dependencies> | null = null;
export function setRecallRerankDepsForTest(deps?: Partial<Dependencies>): void {
  testDeps = deps ?? null;
}

export function OPTIONS(request: Request, env: RecallEnv = process.env as unknown as RecallEnv): Response {
  const origin = allowedOrigin(request, env);
  if (!origin) return errorResponse("forbidden", 403);
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}

export async function POST(request: Request, env: RecallEnv = process.env as unknown as RecallEnv): Promise<Response> {
  const origin = allowedOrigin(request, env);
  if (!origin) return errorResponse("forbidden", 403);
  if (env.RECALL_JEV_ENABLED !== "true") return errorResponse("recall_jev_disabled", 503, origin);
  const threshold = Number(env.RECALL_JEV_THRESHOLD);
  if (!env.RECALL_JEV_THRESHOLD || !Number.isFinite(threshold) || threshold < 0 || threshold > 1)
    return errorResponse("recall_jev_unconfigured", 503, origin);
  const apiKey = env.TYPESAFE_API_KEY?.trim();
  if (!apiKey || !env.KINIC_WIKI_CANISTER_ID || !env.QUERY_ANSWER_RATE_LIMIT)
    return errorResponse("recall_jev_unconfigured", 503, origin);

  let input: RerankRequest;
  try {
    const body = await request.text();
    if (body.length > MAX_BODY_CHARS) return errorResponse("request_too_large", 413, origin);
    const parsed = parseRequest(JSON.parse(body));
    if (!parsed) return errorResponse("invalid_request", 400, origin);
    input = parsed;
  } catch {
    return errorResponse("invalid_request", 400, origin);
  }
  const allowedDatabaseId = env.RECALL_ALLOWED_DATABASE_ID ?? env.KINIC_WIKI_ALLOWED_DATABASE_ID;
  if (allowedDatabaseId && input.databaseId !== allowedDatabaseId)
    return errorResponse("database_not_allowed", 403, origin);

  let principal: string;
  try {
    const checkSession = testDeps?.checkSession ?? defaultCheckSession;
    principal = (await checkSession(env.KINIC_WIKI_CANISTER_ID, input)).principal;
  } catch {
    return errorResponse("recall_session_denied", 403, origin);
  }
  const rateStore = testDeps?.rateStore ?? env.QUERY_ANSWER_RATE_LIMIT;
  try {
    if (await rateLimited(rateStore, principal, input.databaseId))
      return errorResponse("rate_limit", 429, origin);
  } catch {
    return errorResponse("rate_limit_unavailable", 503, origin);
  }

  try {
    const questions = Object.fromEntries(input.candidates.map((_, index) => [
      `candidate_${index}`,
      {
        question: `Would candidate_${index} help answer the search intent based on its path and preview?`,
        trueCriteria: "The candidate contains information useful for answering or substantiating the question.",
        falseCriteria: "The candidate is unrelated, only shares generic words, or offers no useful evidence."
      }
    ]));
    const score = testDeps?.score ?? classifyWithJev;
    const result = await score({
      state: { search_intent: input.question, candidates: input.candidates.map((candidate, index) => ({ id: `candidate_${index}`, ...candidate })) },
      questions,
      apiKey,
      workflow: "recall",
      timeoutMs: 1_500
    });
    const selectedIndices = input.candidates
      .map((candidate, index) => ({ index, path: candidate.path, probability: result.probabilities[`candidate_${index}`] }))
      .filter(({ probability }) => typeof probability === "number" && probability >= threshold)
      .sort((left, right) => right.probability - left.probability ||
        Number(!left.path.startsWith("/Knowledge/")) - Number(!right.path.startsWith("/Knowledge/")) ||
        left.index - right.index)
      .slice(0, MAX_RESULTS)
      .map(({ index }) => index);
    return Response.json({ selectedIndices }, { headers: corsHeaders(origin) });
  } catch {
    return errorResponse("jev_unavailable", 502, origin);
  }
}

async function defaultCheckSession(canisterId: string, input: { databaseId: string; sessionNonce: string }): Promise<{ principal: string }> {
  const client = await import("@/lib/vfs-client");
  return client.checkQueryAnswerSession(canisterId, input);
}

function parseRequest(value: unknown): RerankRequest | null {
  if (!isRecord(value) || !isText(value.databaseId, 128) || !isText(value.sessionNonce, 128) ||
      !isText(value.question, MAX_QUESTION_CHARS) || !Array.isArray(value.candidates) ||
      value.candidates.length < 1 || value.candidates.length > MAX_CANDIDATES) return null;
  const candidates: Candidate[] = [];
  const paths = new Set<string>();
  for (const item of value.candidates) {
    if (!isRecord(item) || !isText(item.path, 512) ||
        !/^\/(Knowledge|Sources)\/[^?#\\]+$/u.test(item.path) ||
        [...item.path].some((char) => char.charCodeAt(0) < 32) ||
        item.path.split("/").some((part: string) => part === ".." || part === ".") ||
        typeof item.preview !== "string" || item.preview.length > MAX_PREVIEW_CHARS ||
        paths.has(item.path)) return null;
    paths.add(item.path);
    candidates.push({ path: item.path, preview: item.preview });
  }
  return {
    databaseId: value.databaseId.trim(),
    sessionNonce: value.sessionNonce.trim(),
    question: value.question.trim(),
    candidates
  };
}

function isText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
function allowedOrigin(request: Request, env: RecallEnv): string | null {
  const origin = request.headers.get("origin");
  return origin && (ALLOWED_ORIGINS.has(origin) || origin === env.KINIC_WIKI_CLIPPER_ORIGIN) ? origin : null;
}
function corsHeaders(origin: string): HeadersInit {
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    vary: "Origin"
  };
}
function errorResponse(error: string, status: number, origin?: string): Response {
  return Response.json({ error }, { status, headers: origin ? corsHeaders(origin) : undefined });
}
async function rateLimited(store: RateLimitStore, principal: string, databaseId: string): Promise<boolean> {
  const key = `recall:${principal}:${databaseId}:${Math.floor(Date.now() / 60_000)}`;
  const count = Number(await store.get(key)) || 0;
  if (count >= RATE_LIMIT_PER_MINUTE) return true;
  await store.put(key, String(count + 1), { expirationTtl: 120 });
  return false;
}
