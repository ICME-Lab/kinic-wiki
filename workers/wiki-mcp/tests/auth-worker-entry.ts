import {
  authenticateMcpRequest,
  authenticationBoundaryResponse,
  authenticationMode,
  handleAuthRoute,
  mcpUnauthorizedResponse,
  mcpWwwAuthenticateChallenge
} from "../src/auth/oauth.js";
import { McpAuthStateV2 } from "../src/auth/state.js";
import type { RuntimeEnv } from "../src/vfs.js";

export { McpAuthStateV2 };

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
      let parsedBody: unknown;
      if (request.method === "POST") {
        try {
          parsedBody = await request.json();
        } catch {
          return Response.json({ error: "bad request" }, { status: 400 });
        }
      }
      const requiresAuthentication =
        authMode === "private_required" ||
        (authMode === "private_opt_in" &&
          (request.headers.has("authorization") ||
            (Array.isArray(parsedBody) && containsConnectPrivateCall(parsedBody))));
      if (
        authMode === "private_opt_in" &&
        !request.headers.has("authorization") &&
        !Array.isArray(parsedBody) &&
        containsConnectPrivateCall(parsedBody)
      ) {
        return Response.json({
          jsonrpc: "2.0",
          id: messageId(parsedBody),
          result: {
            content: [{ type: "text", text: JSON.stringify({ error: "private connection required" }) }],
            _meta: {
              "mcp/www_authenticate": [
                mcpWwwAuthenticateChallenge(
                  env,
                  "insufficient_scope",
                  "Private connection is required"
                )
              ]
            },
            isError: true
          }
        });
      }
      if (!requiresAuthentication) {
        return Response.json({ ok: true, mode: "public" });
      }
      if (!request.headers.has("authorization")) {
        return mcpUnauthorizedResponse(env);
      }
      const authenticated = await authenticateMcpRequest(request, env);
      return "response" in authenticated
        ? authenticated.response
        : Response.json({ ok: true, mode: "private" });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  }
} satisfies ExportedHandler<RuntimeEnv>;

function containsConnectPrivateCall(body: unknown): boolean {
  const messages = Array.isArray(body) ? body : [body];
  return messages.some(
    (message) =>
      typeof message === "object" &&
      message !== null &&
      !Array.isArray(message) &&
      "method" in message &&
      message.method === "tools/call" &&
      "params" in message &&
      typeof message.params === "object" &&
      message.params !== null &&
      !Array.isArray(message.params) &&
      "name" in message.params &&
      message.params.name === "connect_private"
  );
}

function messageId(body: unknown): unknown {
  return typeof body === "object" && body !== null && !Array.isArray(body) && "id" in body
    ? body.id
    : null;
}
