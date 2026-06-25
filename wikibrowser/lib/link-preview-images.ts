// Where: wikibrowser/link preview image routes.
// What: reads cached database preview PNGs from the configured Cloudflare R2 bucket.
// Why: bot-facing image requests must avoid runtime PNG generation on the Worker path.

export const LINK_PREVIEW_IMAGE_CACHE_CONTROL = "public, max-age=300, s-maxage=86400";
export const LINK_PREVIEW_IMAGE_CONTENT_TYPE = "image/png";

export type LinkPreviewImageObject = {
  body: ReadableStream<Uint8Array> | null;
  httpEtag?: string;
  writeHttpMetadata?: (headers: Headers) => void;
};

export type LinkPreviewImageBucket = {
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

type CloudflareContextModule = {
  getCloudflareContext: (options: { async: true }) => Promise<{ env: CloudflareEnv }>;
};

declare global {
  interface CloudflareEnv {
    LINK_PREVIEW_IMAGES?: LinkPreviewImageBucket;
  }
}

export function databaseLinkPreviewImageKey(databaseId: string): string {
  return `db-link-preview/v1/${encodeURIComponent(databaseId.trim())}.png`;
}

export async function linkPreviewImageBucket(): Promise<LinkPreviewImageBucket | null> {
  try {
    const cloudflare: CloudflareContextModule = await import("@opennextjs/cloudflare");
    const context = await cloudflare.getCloudflareContext({ async: true });
    return context.env.LINK_PREVIEW_IMAGES ?? null;
  } catch {
    return null;
  }
}

export async function readCachedDatabaseLinkPreviewImage(
  request: Request,
  databaseId: string,
  fallbackPath: "/opengraph-image" | "/twitter-image",
  bucket?: LinkPreviewImageBucket | null
): Promise<Response> {
  const store = bucket === undefined ? await linkPreviewImageBucket() : bucket;
  if (!store) return staticImageRedirect(request, fallbackPath);
  const object = await store.get(databaseLinkPreviewImageKey(databaseId));
  if (!object?.body) return staticImageRedirect(request, fallbackPath);
  const headers = new Headers();
  object.writeHttpMetadata?.(headers);
  headers.set("Content-Type", LINK_PREVIEW_IMAGE_CONTENT_TYPE);
  headers.set("Cache-Control", LINK_PREVIEW_IMAGE_CACHE_CONTROL);
  if (object.httpEtag) headers.set("ETag", object.httpEtag);
  return new Response(object.body, { headers });
}

function staticImageRedirect(request: Request, fallbackPath: "/opengraph-image" | "/twitter-image"): Response {
  return Response.redirect(new URL(fallbackPath, request.url), 308);
}
