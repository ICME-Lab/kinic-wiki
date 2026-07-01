// Where: wikibrowser/app/api/link-preview/regenerate/route.ts
// What: regenerates cached per-database link preview PNGs into R2.
// Why: database-specific previews should update explicitly, not during bot image fetches.

type DatabaseSummaryForPreview = {
  databaseId: string;
  metadata: {
    name: string;
    description: string;
  };
};

type LinkPreviewImageInput = {
  eyebrow?: string;
  accent?: string;
  title?: string;
  description?: string;
  tags?: string[];
};

type LinkPreviewImageObject = {
  body: ReadableStream<Uint8Array> | null;
  httpEtag?: string;
  writeHttpMetadata?: (headers: Headers) => void;
};

type LinkPreviewImageBucket = {
  get: (key: string) => Promise<LinkPreviewImageObject | null>;
  put: (
    key: string,
    value: ArrayBuffer,
    options?: {
      httpMetadata?: {
        contentType?: string;
        cacheControl?: string;
      };
      customMetadata?: Record<string, string>;
    }
  ) => Promise<unknown>;
};

type LinkPreviewRegenerateDeps = {
  bucket: LinkPreviewImageBucket;
  listDatabasesPublic: (canisterId: string) => Promise<DatabaseSummaryForPreview[]>;
  renderImage: (input: LinkPreviewImageInput) => Promise<Response>;
};

type RegenerateInput = {
  databaseId: string;
};

type CloudflareContextModule = {
  getCloudflareContext: (options: { async: true }) => Promise<{ env: CloudflareEnv }>;
};

declare global {
  interface CloudflareEnv {
    LINK_PREVIEW_IMAGES?: LinkPreviewImageBucket;
  }

  interface SubtleCrypto {
    timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean;
  }
}

const LINK_PREVIEW_IMAGE_CACHE_CONTROL = "public, max-age=300, s-maxage=86400";
const LINK_PREVIEW_IMAGE_CONTENT_TYPE = "image/png";
const MAX_DATABASE_ID_CHARS = 128;

let testDeps: Partial<LinkPreviewRegenerateDeps> | null = null;

export function setLinkPreviewRegenerateDepsForTest(deps?: Partial<LinkPreviewRegenerateDeps>): void {
  testDeps = deps ?? null;
}

export async function POST(request: Request): Promise<Response> {
  const token = process.env.KINIC_WIKI_LINK_PREVIEW_REGEN_TOKEN?.trim();
  if (!token) return jsonError("KINIC_WIKI_LINK_PREVIEW_REGEN_TOKEN is not configured", 503);
  if (!(await isAuthorized(request, token))) return jsonError("forbidden", 403);

  let input: RegenerateInput;
  try {
    const parsed = parseRegenerateInput(await request.json());
    if (typeof parsed === "string") return jsonError(parsed, 400);
    input = parsed;
  } catch {
    return jsonError("invalid JSON body", 400);
  }

  const canisterId = configuredCanisterId();
  if (!canisterId) return jsonError("KINIC_WIKI_CANISTER_ID is not configured", 503);
  const bucket = testDeps?.bucket ?? (await defaultLinkPreviewImageBucket());
  if (!bucket) return jsonError("LINK_PREVIEW_IMAGES is not configured", 503);

  try {
    const listDatabasesPublic = testDeps?.listDatabasesPublic ?? defaultListDatabasesPublic;
    const databases = await listDatabasesPublic(canisterId);
    const database = databases.find((item) => item.databaseId === input.databaseId) ?? null;
    if (!database) return jsonError("database not found in public list", 404);
    const renderImage = testDeps?.renderImage ?? defaultRenderImage;
    const renderStartMs = performance.now();
    const title = database.metadata.name;
    const description = database.metadata.description || `Browse, search, and query the ${title} wiki database.`;
    const image = await renderImage({
      eyebrow: "Kinic Wiki database",
      accent: "Public wiki database",
      title,
      description,
      tags: [database.databaseId, "/Knowledge", "Search", "Query"]
    });
    const renderDurationMs = Math.round((performance.now() - renderStartMs) * 100) / 100;
    console.info("link preview image rendered", {
      databaseId: database.databaseId,
      renderDurationMs
    });
    const imageBytes = await image.arrayBuffer();
    const key = databaseLinkPreviewImageKey(database.databaseId);
    await bucket.put(key, imageBytes, {
      httpMetadata: {
        contentType: LINK_PREVIEW_IMAGE_CONTENT_TYPE,
        cacheControl: LINK_PREVIEW_IMAGE_CACHE_CONTROL
      },
      customMetadata: {
        databaseId: database.databaseId,
        databaseTitle: title,
        generatedAt: new Date().toISOString()
      }
    });
    return Response.json({
      ok: true,
      key,
      databaseId: database.databaseId,
      databaseTitle: title,
      bytes: imageBytes.byteLength,
      renderDurationMs
    });
  } catch {
    return jsonError("link preview regeneration failed", 502);
  }
}

function parseRegenerateInput(value: unknown): RegenerateInput | string {
  if (!isRecord(value)) return "databaseId is required";
  if (typeof value.databaseId !== "string") return "databaseId is required";
  const databaseId = value.databaseId.trim();
  if (!databaseId) return "databaseId is required";
  if (databaseId.length > MAX_DATABASE_ID_CHARS) return "databaseId is too long";
  return { databaseId };
}

function configuredCanisterId(): string {
  return (process.env.NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID ?? process.env.KINIC_WIKI_CANISTER_ID ?? "").trim();
}

async function defaultLinkPreviewImageBucket(): Promise<LinkPreviewImageBucket | null> {
  try {
    const cloudflare: CloudflareContextModule = await import("@opennextjs/cloudflare");
    const context = await cloudflare.getCloudflareContext({ async: true });
    return context.env.LINK_PREVIEW_IMAGES ?? null;
  } catch {
    return null;
  }
}

async function defaultListDatabasesPublic(canisterId: string): Promise<DatabaseSummaryForPreview[]> {
  const vfsClient: { listDatabasesPublic: (canisterId: string) => Promise<DatabaseSummaryForPreview[]> } = await import("@/lib/vfs-client");
  return vfsClient.listDatabasesPublic(canisterId);
}

async function defaultRenderImage(input: LinkPreviewImageInput): Promise<Response> {
  const imageModule: { renderLinkPreviewImage: (input: LinkPreviewImageInput) => Promise<Response> } = await import("@/app/link-preview-image");
  return imageModule.renderLinkPreviewImage(input);
}

async function isAuthorized(request: Request, token: string): Promise<boolean> {
  const header = request.headers.get("authorization") ?? "";
  return timingSafeEqual(header, `Bearer ${token}`);
}

async function timingSafeEqual(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  if (leftBytes.length !== rightBytes.length) {
    await crypto.subtle.digest("SHA-256", leftBytes);
    return false;
  }
  return crypto.subtle.timingSafeEqual(leftBytes, rightBytes);
}

function databaseLinkPreviewImageKey(databaseId: string): string {
  return `db-link-preview/v1/${encodeURIComponent(databaseId.trim())}.png`;
}

function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
