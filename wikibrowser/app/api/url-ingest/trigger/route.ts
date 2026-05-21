// Where: wikibrowser/app/api/url-ingest/trigger/route.ts
// What: Server-side authenticated trigger for URL ingest worker requests.
// Why: Browsers and extensions must not receive the worker bearer token.

type TriggerRequest = {
  canisterId: string;
  databaseId: string;
  requestPath: string;
  sessionNonce: string;
};

type CheckSession = (canisterId: string, input: TriggerRequest) => Promise<void>;

const ALLOWED_ORIGINS = new Set([
  "https://wiki.kinic.xyz",
  "https://kinic.xyz",
  "chrome-extension://jcfniiflikojmbfnaoamlbbddlikchaj",
  "chrome-extension://hbnicbmdodpmihmcnfgejcdgbfmemoci"
]);

let checkSession: CheckSession = defaultCheckSession;

export function setUrlIngestTriggerDepsForTest(deps: { checkSession?: CheckSession } = {}): void {
  checkSession = deps.checkSession ?? defaultCheckSession;
}

export function OPTIONS(request: Request): Response {
  const origin = allowedOrigin(request);
  if (!origin) return jsonError("forbidden", 403);
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}

export async function POST(request: Request): Promise<Response> {
  const origin = allowedOrigin(request);
  if (!origin) return jsonError("forbidden", 403);
  let input: TriggerRequest;
  try {
    const body: unknown = await request.json();
    const parsed = parseTriggerRequest(body);
    if (typeof parsed === "string") {
      return jsonError(parsed, 400, origin);
    }
    input = parsed;
  } catch {
    return jsonError("invalid JSON body", 400, origin);
  }

  const generatorUrl = process.env.KINIC_WIKI_GENERATOR_URL?.trim();
  if (!generatorUrl) {
    return jsonError("KINIC_WIKI_GENERATOR_URL is not configured", 503, origin);
  }
  const token = process.env.KINIC_WIKI_WORKER_TOKEN?.trim();
  if (!token) {
    return jsonError("KINIC_WIKI_WORKER_TOKEN is not configured", 503, origin);
  }

  let endpoint: URL;
  try {
    endpoint = new URL("/url-ingest", generatorUrl.endsWith("/") ? generatorUrl : `${generatorUrl}/`);
  } catch {
    return jsonError("KINIC_WIKI_GENERATOR_URL is invalid", 503, origin);
  }

  const configuredCanisterId = (process.env.NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID ?? process.env.KINIC_WIKI_CANISTER_ID)?.trim();
  if (!configuredCanisterId) {
    return jsonError("NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID is not configured", 503, origin);
  }
  if (input.canisterId !== configuredCanisterId) {
    return jsonError("canisterId does not match configured canister", 400, origin);
  }
  try {
    await checkSession(input.canisterId, input);
  } catch {
    return jsonError("url ingest trigger session denied", 403, origin);
  }

  try {
    const response = await fetch(endpoint.toString(), {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ canisterId: input.canisterId, databaseId: input.databaseId, requestPath: input.requestPath })
    });
    if (!response.ok) {
      return jsonError(`worker trigger failed: HTTP ${response.status}`, 502, origin);
    }
    return Response.json({ accepted: true }, { headers: corsHeaders(origin) });
  } catch {
    return jsonError("worker trigger failed", 502, origin);
  }
}

function parseTriggerRequest(value: unknown): TriggerRequest | string {
  if (!isRecord(value)) return "canisterId, databaseId, and requestPath are required";
  const canisterId = value.canisterId;
  const databaseId = value.databaseId;
  const requestPath = value.requestPath;
  const sessionNonce = value.sessionNonce;
  if (typeof canisterId !== "string" || !canisterId) return "canisterId is required";
  if (typeof databaseId !== "string" || !databaseId) return "databaseId is required";
  if (typeof requestPath !== "string" || !requestPath) return "requestPath is required";
  if (typeof sessionNonce !== "string" || !sessionNonce) return "sessionNonce is required";
  if (sessionNonce.length > 128) return "sessionNonce is too long";
  if (!requestPath.startsWith("/Sources/ingest-requests/") || !requestPath.endsWith(".md")) {
    return "requestPath must be a URL ingest request path";
  }
  return { canisterId, databaseId, requestPath, sessionNonce };
}

function allowedOrigin(request: Request): string | null {
  const origin = request.headers.get("origin");
  if (!origin || !ALLOWED_ORIGINS.has(origin)) return null;
  return origin;
}

function corsHeaders(origin: string): HeadersInit {
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    vary: "Origin"
  };
}

function jsonError(error: string, status: number, origin?: string): Response {
  return Response.json({ error }, { status, headers: origin ? corsHeaders(origin) : undefined });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function defaultCheckSession(canisterId: string, input: TriggerRequest): Promise<void> {
  const vfsClient: { checkUrlIngestTriggerSession: CheckSession } = await import("@/lib/vfs-client");
  await vfsClient.checkUrlIngestTriggerSession(canisterId, input);
}
