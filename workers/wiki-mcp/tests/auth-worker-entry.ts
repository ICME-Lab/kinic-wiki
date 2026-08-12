import {
  authenticateMcpRequest,
  authenticationBoundaryResponse,
  authenticationMode,
  handleAuthRoute,
  mcpUnauthorizedResponse
} from "../src/auth/oauth.js";
import { McpAuthStateV4 } from "../src/auth/state.js";
import type { RuntimeEnv } from "../src/vfs.js";

export { McpAuthStateV4 };

export default {
  async fetch(request: Request, env: RuntimeEnv): Promise<Response> {
    const authMode = authenticationMode(request, env);
    const boundaryResponse = authenticationBoundaryResponse(authMode);
    if (boundaryResponse) {
      return boundaryResponse;
    }
    const authResponse = await handleAuthRoute(request, env);
    if (authResponse) {
      return authResponse;
    }
    if (new URL(request.url).pathname === "/mcp") {
      if (request.method === "GET") {
        return new Response(null, { status: 405, headers: { allow: "POST" } });
      }
      if (request.method === "POST") {
        try {
          await request.clone().json();
        } catch {
          return Response.json({ error: "bad request" }, { status: 400 });
        }
      }
      if (authMode !== "private_required") {
        return Response.json({ ok: true, mode: "public" });
      }
      if (!request.headers.has("authorization")) {
        return mcpUnauthorizedResponse(env);
      }
      const authenticated = await authenticateMcpRequest(request, env, true);
      return "response" in authenticated
        ? authenticated.response
        : Response.json({ ok: true, mode: "private" });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  }
} satisfies ExportedHandler<RuntimeEnv>;
