// Where: wikibrowser/app/api/source/run/route.ts
// What: Server-side authenticated trigger for source generation jobs.
// Why: Extensions must not receive the worker bearer token.

type SourceRunRequest = {
  canisterId: string;
  databaseId: string;
  sourcePath: string;
  sourceEtag: string;
  sessionNonce: string;
};

type CheckSession = (canisterId: string, input: { databaseId: string; sourcePath: string; sourceEtag: string; sessionNonce: string }) => Promise<void>;

const ALLOWED_ORIGINS = new Set([
  "https://wiki.kinic.xyz",
  "https://kinic.xyz",
  "chrome-extension://jcfniiflikojmbfnaoamlbbddlikchaj",
  "chrome-extension://hbnicbmdodpmihmcnfgejcdgbfmemoci",
  "chrome-extension://moebdnadaffhlddnhifmmdoecifhcbdi"
]);
const RESERVED_SOURCE_PROVIDERS = new Set(["raw", "sessions", "skill-runs", "source-capture-requests", "ingest-requests"]);
const MAX_SOURCE_STEM_BYTES = 128;
const SOURCE_STEM_ENCODER = new TextEncoder();

let checkSession: CheckSession = defaultCheckSession;

export function setSourceRunDepsForTest(deps: { checkSession?: CheckSession } = {}): void {
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
  let input: SourceRunRequest;
  try {
    const body: unknown = await request.json();
    const parsed = parseSourceRunRequest(body);
    if (typeof parsed === "string") return jsonError(parsed, 400, origin);
    input = parsed;
  } catch {
    return jsonError("invalid JSON body", 400, origin);
  }

  const generatorUrl = process.env.KINIC_WIKI_GENERATOR_URL?.trim();
  if (!generatorUrl) return jsonError("KINIC_WIKI_GENERATOR_URL is not configured", 503, origin);
  const token = process.env.KINIC_WIKI_WORKER_TOKEN?.trim();
  if (!token) return jsonError("KINIC_WIKI_WORKER_TOKEN is not configured", 503, origin);

  let endpoint: URL;
  try {
    endpoint = new URL("/run", generatorUrl.endsWith("/") ? generatorUrl : `${generatorUrl}/`);
  } catch {
    return jsonError("KINIC_WIKI_GENERATOR_URL is invalid", 503, origin);
  }

  const configuredCanisterId = (process.env.NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID ?? process.env.KINIC_WIKI_CANISTER_ID)?.trim();
  if (!configuredCanisterId) return jsonError("NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID is not configured", 503, origin);
  if (input.canisterId !== configuredCanisterId) return jsonError("canisterId does not match configured canister", 400, origin);

  try {
    await checkSession(input.canisterId, {
      databaseId: input.databaseId,
      sourcePath: input.sourcePath,
      sourceEtag: input.sourceEtag,
      sessionNonce: input.sessionNonce
    });
  } catch {
    return jsonError("source run session denied", 403, origin);
  }

  try {
    const response = await fetch(endpoint.toString(), {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        databaseId: input.databaseId,
        sourcePath: input.sourcePath,
        sourceEtag: input.sourceEtag,
        sessionNonce: input.sessionNonce,
        dryRun: false
      })
    });
    if (response.status === 409) return jsonError("source etag mismatch", 409, origin);
    if (!response.ok) return jsonError(`worker trigger failed: HTTP ${response.status}`, 502, origin);
    return Response.json({ accepted: true }, { status: 202, headers: corsHeaders(origin) });
  } catch {
    return jsonError("worker trigger failed", 502, origin);
  }
}

function parseSourceRunRequest(value: unknown): SourceRunRequest | string {
  if (!isRecord(value)) return "canisterId, databaseId, sourcePath, sourceEtag, and sessionNonce are required";
  const canisterId = value.canisterId;
  const databaseId = value.databaseId;
  const sourcePath = value.sourcePath;
  const sourceEtag = value.sourceEtag;
  const sessionNonce = value.sessionNonce;
  if (typeof canisterId !== "string" || !canisterId) return "canisterId is required";
  if (typeof databaseId !== "string" || !databaseId) return "databaseId is required";
  if (typeof sourcePath !== "string" || !sourcePath) return "sourcePath is required";
  if (!isCanonicalKnowledgeSourcePath(sourcePath)) return "sourcePath must use /Sources/<provider>/<id>.md";
  if (typeof sourceEtag !== "string" || !sourceEtag) return "sourceEtag is required";
  if (typeof sessionNonce !== "string" || !sessionNonce) return "sessionNonce is required";
  if (sessionNonce.length > 128) return "sessionNonce is too long";
  return { canisterId, databaseId, sourcePath, sourceEtag, sessionNonce };
}

function isCanonicalKnowledgeSourcePath(path: string): boolean {
  const prefix = "/Sources/";
  if (!path.startsWith(prefix)) return false;
  const parts = path.slice(prefix.length).split("/");
  if (parts.length !== 2) return false;
  const [provider, fileName] = parts;
  return isSafeProviderSegment(provider) && !RESERVED_SOURCE_PROVIDERS.has(provider) && isSafeMarkdownFile(fileName);
}

function isSafeProviderSegment(value: string | undefined): value is string {
  return /^[a-z0-9]{1,32}$/.test(value ?? "");
}

function isSafeMarkdownFile(value: string | undefined): boolean {
  const fileName = value ?? "";
  if (!fileName.endsWith(".md")) return false;
  return isSafeSourceStem(fileName.slice(0, -".md".length));
}

function isSafeSourceStem(value: string): boolean {
  const chars = [...value];
  if (chars.length === 0 || SOURCE_STEM_ENCODER.encode(value).length > MAX_SOURCE_STEM_BYTES || value.includes("..")) return false;
  const [first, ...rest] = chars;
  return isUnicodeAlphanumeric(first ?? "") && rest.every(isSourceStemChar);
}

function isSourceStemChar(value: string): boolean {
  return isUnicodeAlphanumeric(value) || value === "." || value === "_" || value === "-";
}

function isUnicodeAlphanumeric(value: string): boolean {
  return /^[\p{L}\p{N}]$/u.test(value);
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

async function defaultCheckSession(canisterId: string, input: { databaseId: string; sourcePath: string; sourceEtag: string; sessionNonce: string }): Promise<void> {
  const vfsClient: { checkSourceRunSession: CheckSession } = await import("@/lib/vfs-client");
  await vfsClient.checkSourceRunSession(canisterId, input);
}
