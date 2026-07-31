import { createStartHandler, defaultStreamHandler } from "@tanstack/react-start/server";
import { createServerEntry } from "@tanstack/react-start/server-entry";
import { env } from "cloudflare:workers";

const startFetch = createStartHandler(defaultStreamHandler);

export default createServerEntry({
  async fetch(request) {
    const url = new URL(request.url);
    if (url.hostname === "kinic.xyz") {
      url.hostname = "wiki.kinic.xyz";
      return Response.redirect(url, 308);
    }
    const response = await startFetch(request);
    if (env.KINIC_DEPLOYMENT_ENV !== "staging") return response;
    const headers = new Headers(response.headers);
    headers.set("X-Robots-Tag", "noindex, nofollow");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers
    });
  }
});
