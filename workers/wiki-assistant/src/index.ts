import { z } from "zod";
import { AssistantAuth, requireEnabled } from "./auth";
import { AssistantUser } from "./user";
import { AssistantError } from "./contracts";
import { failure, json, readJson } from "./http";
import type { Env } from "./env";
import { AssistantStore } from "./store";
import { sweep } from "./reaper";

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const receivedAt = Date.now();
    const url = new URL(request.url);
    const native = url.pathname.startsWith("/api/assistant/native/");
    const path = url.pathname.replace(/^\/api\/assistant(?:\/native)?/, "");
    try {
      if (!native) throw new AssistantError("not_found", 404);
      // All retired voice routes are unavailable, including stop.
      if (path === "/voice" || path.startsWith("/voice/"))
        throw new AssistantError("not_found", 404);
      // Cleanup stays available when the kill switch is engaged.
      if (path !== "/logout" && path !== "/end") {
        requireEnabled(env);
        if (!env.DEEPSEEK_API_KEY)
          throw new AssistantError("assistant_not_configured", 503);
      }
      if (path === "/status" && request.method === "GET")
        return json({ available: true });
      if (path === "/auth/start" && request.method === "POST") {
        const rate = await env.AUTH_RATE_LIMIT.limit({
          key: request.headers.get("cf-connecting-ip") || "unknown",
        });
        if (!rate.success) throw new AssistantError("rate_limit", 429);
        const input = z
          .object({
            consent: z.literal("2026-09-29"),
            databaseId: z.string().min(1).max(128),
            expectedPrincipal: z.string().min(1).max(100),
          })
          .strict()
          .parse(await readJson(request));
        const id = crypto.randomUUID();
        const result = await new AssistantAuth(env, id).beginNative(
          id,
          input.databaseId,
          input.expectedPrincipal,
        );
        return json({ ...result, token: id + "." + result.token });
      }
      const bearer = request.headers
        .get("authorization")
        ?.match(/^Bearer ([a-f0-9-]{36})\.([A-Za-z0-9_-]{43})$/);
      const authCookie = bearer ? { id: bearer[1], token: bearer[2] } : null;
      if (!authCookie) throw new AssistantError("authentication_required", 401);
      const auth = new AssistantAuth(env, authCookie.id);
      if (path === "/auth/complete" && request.method === "POST") {
        const input = z
          .object({ state: z.string().max(100), response: z.unknown() })
          .strict()
          .parse(await readJson(request));
        const result = await auth.completeNative(
          authCookie.token,
          input.state,
          input.response,
        );
        return json({
          principal: result.principal,
          expiresAt: result.expiresAt,
        });
      }
      if (path === "/logout" && request.method === "POST") {
        // End the owned conversation before invalidating authentication.
        try {
          const authorization = await auth.ownerForCleanup(authCookie.token);
          if (authorization) {
            const store = new AssistantStore(env),
              state = (await store.load(authorization.principal)).state;
            if (state.conversation)
              await store.requestEnd(
                authorization.principal,
                authCookie.id,
                state.conversation.id,
                receivedAt,
              );
            await (
              await new AssistantUser(env, authorization.principal, (p) =>
                ctx.waitUntil(p),
              ).initialize()
            ).endOwned(authCookie.id);
          }
        } catch {
          /* Expiry/kill switch is also enforced by the scheduled recovery worker. */
        }
        try {
          await auth.revoke(authCookie.token);
        } catch {
          /* Already expired. */
        }
        return json({ ended: true });
      }
      if (path === "/end" && request.method === "POST") {
        const owner = await auth.ownerForCleanup(authCookie.token);
        if (!owner) throw new AssistantError("authentication_required", 401);
        const conversationId = z
          .string()
          .uuid()
          .parse(url.searchParams.get("conversationId"));
        await new AssistantStore(env).requestEnd(
          owner.principal,
          owner.authId,
          conversationId,
          receivedAt,
        );
        await (
          await new AssistantUser(env, owner.principal, (p) =>
            ctx.waitUntil(p),
          ).initialize()
        ).endOwned(owner.authId, conversationId);
        return json({ ended: true });
      }
      if (
        request.method === "POST" &&
        ["/questions", "/cancel"].includes(path)
      )
        throw new AssistantError("control_connection_required", 405);
      const authorization = await auth.authorize(authCookie.token);
      if (path === "/auth" && request.method === "GET")
        return json({
          principal: authorization.principal,
          expiresAt: authorization.expiresAt,
        });
      const headers = new Headers(request.headers);
      headers.delete("cookie");
      headers.delete("authorization");
      headers.set("x-assistant-received-at", String(receivedAt));
      headers.set("x-assistant-client", "native");
      headers.set("x-assistant-auth-id", authorization.authId);
      headers.set("x-assistant-principal", authorization.principal);
      url.pathname = "/api/assistant" + path;
      const forwarded = new Request(new Request(url, request), { headers });
      if (path === "/events")
        return await env.ASSISTANT_CONNECTION.getByName(authorization.principal).fetch(forwarded);
      return await (
        await new AssistantUser(env, authorization.principal, (p) =>
          ctx.waitUntil(p),
        ).initialize(!["/conversation", "/history", "/active"].includes(path))
      ).fetch(forwarded);
    } catch (error) {
      return failure(error);
    }
  },
  async scheduled(
    _event: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ) {
    ctx.waitUntil(sweep(env));
  },
} satisfies ExportedHandler<Env>;

export { AssistantConnection } from "./connection";
