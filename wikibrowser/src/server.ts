import { createStartHandler, defaultStreamHandler } from "@tanstack/react-start/server";
import { createServerEntry } from "@tanstack/react-start/server-entry";

const startFetch = createStartHandler(defaultStreamHandler);

export default createServerEntry({
  async fetch(request) {
    const url = new URL(request.url);
    if (url.hostname === "kinic.xyz") {
      url.hostname = "wiki.kinic.xyz";
      return Response.redirect(url, 308);
    }
    return startFetch(request);
  }
});
