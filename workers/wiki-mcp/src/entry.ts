import { parseRoutedToken, sessionName } from "./auth/routing.js";
import type { RuntimeEnv } from "./vfs.js";

export { McpAuthStateV5 } from "./auth/state.js";

export default {
  async fetch(request: Request, env: RuntimeEnv): Promise<Response> {
    if (env.MCP_ACCESS_POLICY === "private_required" && env.MCP_AUTH_STATE &&
        request.method === "POST" && new URL(request.url).pathname === "/mcp") {
      const authorization = request.headers.get("authorization");
      const sessionId = authorization?.startsWith("Bearer ")
        ? parseRoutedToken(authorization.slice(7), "mka1") : null;
      if (sessionId) {
        // Forward the original stream once. Authentication, permissions and MCP
        // processing run in this session's existing DO, including on cold starts.
        return env.MCP_AUTH_STATE.getByName(sessionName(sessionId)).fetch(request);
      }
    }
    const { default: worker } = await import("./index.js");
    return worker.fetch(request, env);
  }
} satisfies ExportedHandler<RuntimeEnv>;
