import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import { AssistantUser } from "./user";

// D1 remains the source of truth, including authentication, cancellation and
// fenced leases. The object owns only the long-lived connection execution.
export class AssistantConnection extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const principal = request.headers.get("x-assistant-principal");
    if (!principal || !request.headers.get("x-assistant-auth-id"))
      return Response.json({ error: "authentication_required" }, { status: 401 });
    if (new URL(request.url).pathname !== "/api/assistant/events")
      return Response.json({ error: "not_found" }, { status: 404 });
    return (await new AssistantUser(this.env, principal, (p) => this.ctx.waitUntil(p)).initialize()).fetch(request);
  }
}
