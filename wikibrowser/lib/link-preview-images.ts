// Where: wikibrowser/link preview image routes.
// What: reads cached database preview PNGs from the configured Cloudflare R2 bucket.
// Why: bot-facing image requests must avoid runtime PNG generation on the Worker path.

export const LINK_PREVIEW_IMAGE_CACHE_CONTROL = "public, max-age=300, s-maxage=86400";
export const LINK_PREVIEW_IMAGE_CONTENT_TYPE = "image/png";
const LINK_PREVIEW_PENDING_TTL_MS = 10 * 60 * 1000;
const LINK_PREVIEW_PENDING_CACHE_CONTROL = "no-store";

export type LinkPreviewImageObject = {
  body: ReadableStream<Uint8Array> | null;
  httpEtag?: string;
  customMetadata?: Record<string, string>;
  writeHttpMetadata?: (headers: Headers) => void;
};

export type LinkPreviewImageBucket = {
  get: (key: string) => Promise<LinkPreviewImageObject | null>;
  put: (
    key: string,
    value: ArrayBuffer | Uint8Array,
    options?: {
      httpMetadata?: {
        contentType?: string;
        cacheControl?: string;
      };
      customMetadata?: Record<string, string>;
    }
  ) => Promise<unknown>;
  delete?: (key: string) => Promise<unknown>;
};

export type LinkPreviewQueueMessage = {
  kind: "link_preview";
  canisterId: string;
  databaseId: string;
  requestedAt: string;
};

export type LinkPreviewQueue = {
  send: (message: LinkPreviewQueueMessage) => Promise<unknown>;
};

type LinkPreviewRuntime = {
  bucket: LinkPreviewImageBucket | null;
  queue: LinkPreviewQueue | null;
  canisterId: string;
};

export type LinkPreviewReadOptions = {
  queue?: LinkPreviewQueue | null;
  canisterId?: string;
  nowMs?: number;
};

type CloudflareContextModule = {
  getCloudflareContext: (options: { async: true }) => Promise<{ env: CloudflareEnv }>;
};

declare global {
  interface CloudflareEnv {
    LINK_PREVIEW_IMAGES?: LinkPreviewImageBucket;
    LINK_PREVIEW_QUEUE?: LinkPreviewQueue;
    NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID?: string;
    KINIC_WIKI_CANISTER_ID?: string;
  }
}

export function databaseLinkPreviewImageKey(databaseId: string): string {
  return `db-link-preview/v1/${encodeURIComponent(databaseId.trim())}.png`;
}

export function pendingDatabaseLinkPreviewImageKey(databaseId: string): string {
  return `db-link-preview/pending/v1/${encodeURIComponent(databaseId.trim())}.json`;
}

export async function linkPreviewImageBucket(): Promise<LinkPreviewImageBucket | null> {
  return (await linkPreviewRuntime())?.bucket ?? null;
}

async function linkPreviewRuntime(): Promise<LinkPreviewRuntime | null> {
  try {
    const cloudflare: CloudflareContextModule = await import("@opennextjs/cloudflare");
    const context = await cloudflare.getCloudflareContext({ async: true });
    return {
      bucket: context.env.LINK_PREVIEW_IMAGES ?? null,
      queue: context.env.LINK_PREVIEW_QUEUE ?? null,
      canisterId: context.env.NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID ?? context.env.KINIC_WIKI_CANISTER_ID ?? ""
    };
  } catch {
    return null;
  }
}

export async function readCachedDatabaseLinkPreviewImage(
  request: Request,
  databaseId: string,
  fallbackPath: "/opengraph-image.png" | "/twitter-image.png",
  bucket?: LinkPreviewImageBucket | null,
  options: LinkPreviewReadOptions = {}
): Promise<Response> {
  const runtime = bucket === undefined ? await linkPreviewRuntime() : null;
  const store = bucket === undefined ? (runtime?.bucket ?? null) : bucket;
  if (!store) return staticImageRedirect(request, fallbackPath);
  const object = await store.get(databaseLinkPreviewImageKey(databaseId));
  if (!object?.body) {
    await bestEffortEnqueueDatabaseLinkPreview(store, databaseId, {
      queue: options.queue ?? runtime?.queue ?? null,
      canisterId: options.canisterId ?? runtime?.canisterId ?? "",
      nowMs: options.nowMs
    });
    return staticImageRedirect(request, fallbackPath);
  }
  const headers = new Headers();
  object.writeHttpMetadata?.(headers);
  headers.set("Content-Type", LINK_PREVIEW_IMAGE_CONTENT_TYPE);
  headers.set("Cache-Control", LINK_PREVIEW_IMAGE_CACHE_CONTROL);
  if (object.httpEtag) headers.set("ETag", object.httpEtag);
  return new Response(object.body, { headers });
}

async function bestEffortEnqueueDatabaseLinkPreview(
  bucket: LinkPreviewImageBucket,
  databaseId: string,
  options: Required<Pick<LinkPreviewReadOptions, "queue" | "canisterId">> & Pick<LinkPreviewReadOptions, "nowMs">
): Promise<void> {
  const trimmedDatabaseId = databaseId.trim();
  if (!isQueueableDatabaseId(trimmedDatabaseId) || !options.queue || !options.canisterId) return;
  const nowMs = options.nowMs ?? Date.now();
  const pendingKey = pendingDatabaseLinkPreviewImageKey(trimmedDatabaseId);
  try {
    const pending = await bucket.get(pendingKey);
    if (pending && isFreshPendingMarker(pending, nowMs)) return;
    await bucket.put(
      pendingKey,
      new TextEncoder().encode(JSON.stringify({ databaseId: trimmedDatabaseId, requestedAtMs: nowMs })),
      {
        httpMetadata: {
          contentType: "application/json",
          cacheControl: LINK_PREVIEW_PENDING_CACHE_CONTROL
        },
        customMetadata: {
          databaseId: trimmedDatabaseId,
          requestedAtMs: String(nowMs)
        }
      }
    );
    await options.queue.send({
      kind: "link_preview",
      canisterId: options.canisterId,
      databaseId: trimmedDatabaseId,
      requestedAt: new Date(nowMs).toISOString()
    });
  } catch (error) {
    try {
      await bucket.delete?.(pendingKey);
    } catch {}
    console.warn("failed to enqueue database link preview generation", error);
  }
}

function isFreshPendingMarker(object: LinkPreviewImageObject, nowMs: number): boolean {
  const requestedAtMs = Number(object.customMetadata?.requestedAtMs ?? "");
  return Number.isFinite(requestedAtMs) && nowMs - requestedAtMs < LINK_PREVIEW_PENDING_TTL_MS;
}

function isQueueableDatabaseId(databaseId: string): boolean {
  return databaseId.length > 0 && databaseId.length <= 128;
}

function staticImageRedirect(request: Request, fallbackPath: "/opengraph-image.png" | "/twitter-image.png"): Response {
  return Response.redirect(new URL(fallbackPath, request.url), 308);
}
