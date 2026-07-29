import {
  authenticateMcpRequest,
  authenticationBoundaryResponse,
  authenticationMode,
  handleAuthRoute
} from "../src/auth/oauth.js";
import { McpAuthState } from "../src/auth/state.js";
import type { RuntimeEnv } from "../src/vfs.js";

export { McpAuthState };

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
      const authenticated = await authenticateMcpRequest(request, env);
      return "response" in authenticated ? authenticated.response : Response.json({ ok: true });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  }
} satisfies ExportedHandler<RuntimeEnv>;
