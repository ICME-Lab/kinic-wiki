import { createStartHandler, defaultStreamHandler } from "@tanstack/react-start/server";
import { createServerEntry } from "@tanstack/react-start/server-entry";
import { env } from "cloudflare:workers";

const startFetch = createStartHandler(defaultStreamHandler);

type PublicCacheRule = {
  prefix: string;
  ttlSeconds: number;
  exact: boolean;
};

const PUBLIC_CACHE_RULES: PublicCacheRule[] = [
  { prefix: "/", ttlSeconds: 60, exact: true },
  { prefix: "/p/", ttlSeconds: 60, exact: false },
  { prefix: "/support", ttlSeconds: 300, exact: false },
  { prefix: "/privacy-policy", ttlSeconds: 300, exact: false },
  { prefix: "/docs", ttlSeconds: 300, exact: false }
];

export default createServerEntry({
  async fetch(request) {
    const url = new URL(request.url);
    if (url.hostname === "kinic.xyz") {
      url.hostname = "wiki.kinic.xyz";
      return Response.redirect(url, 308);
    }

    const ttlSeconds = request.method === "GET" && url.search === "" ? publicCacheTtl(url.pathname) : null;
    const cache = ttlSeconds !== null && typeof caches !== "undefined" ? (caches as unknown as { default: Cache }).default : null;
    const cacheKey = new Request(url, { method: "GET" });

    if (cache) {
      const cached = await cache.match(cacheKey);
      if (cached) return applyStaging(cached);
    }

    const response = await startFetch(request);
    if (cache && ttlSeconds !== null && response.status === 200 && !response.headers.has("set-cookie")) {
      const headers = new Headers(response.headers);
      headers.set("Cache-Control", `public, max-age=${ttlSeconds}, s-maxage=${ttlSeconds}`);
      const cacheable = new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers
      });
      await cache.put(cacheKey, cacheable.clone()).catch(() => {
        // Caching is best-effort; serve the uncached response on failure.
      });
      return applyStaging(cacheable);
    }

    return applyStaging(response);
  }
});

function publicCacheTtl(pathname: string): number | null {
  for (const rule of PUBLIC_CACHE_RULES) {
    if (rule.exact ? pathname === rule.prefix : pathname.startsWith(rule.prefix)) {
      return rule.ttlSeconds;
    }
  }
  return null;
}

function applyStaging(response: Response): Response {
  if (env.KINIC_DEPLOYMENT_ENV !== "staging") return response;
  const headers = new Headers(response.headers);
  headers.set("X-Robots-Tag", "noindex, nofollow");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}
