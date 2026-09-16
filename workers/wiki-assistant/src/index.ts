import { z } from "zod";
import { AssistantAuth, requireEnabled } from "./auth";
import { AssistantUser } from "./user";
import { AssistantError } from "./contracts";
import { cookie, failure, json, readCookie, readJson } from "./http";
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
      if (!native && request.method === "GET" && path === "/callback")
        return callbackPage();
      if (
        request.method !== "GET" ||
        request.headers.get("upgrade") === "websocket"
      ) {
        if (!native && request.headers.get("origin") !== env.ASSISTANT_ORIGIN)
          throw new AssistantError("invalid_origin", 403);
      }
      // Cleanup stays available when the kill switch is engaged.
      if (path !== "/logout" && path !== "/end" && path !== "/voice/stop")
        requireEnabled(env);
      if (path === "/status" && request.method === "GET")
        return json({ available: true });
      if (native && path === "/auth/start" && request.method === "POST") {
        const rate = await env.AUTH_RATE_LIMIT.limit({
          key: request.headers.get("cf-connecting-ip") || "unknown",
        });
        if (!rate.success) throw new AssistantError("rate_limit", 429);
        const input = z
          .object({
            consent: z.literal("2026-09-16"),
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
      if (path === "/auth/start" && request.method === "POST") {
        const rate = await env.AUTH_RATE_LIMIT.limit({
          key: request.headers.get("cf-connecting-ip") || "unknown",
        });
        if (!rate.success) throw new AssistantError("rate_limit", 429);
        const input = z
          .object({ consent: z.literal("2026-09-16") })
          .strict()
          .parse(await readJson(request));
        void input;
        const existing = readCookie(request);
        if (existing) {
          try {
            await new AssistantAuth(env, existing.id).revoke(existing.token);
          } catch {
            /* Expired authentication can be replaced. */
          }
        }
        const id = crypto.randomUUID();
        const pending = await new AssistantAuth(env, id).begin(id);
        const target = new URL("https://id.ai/mcp");
        target.hash = new URLSearchParams({
          registration_key: pending.registrationKey,
          callback: env.ASSISTANT_ORIGIN + "/api/assistant/callback",
          state: pending.state,
          ttl: "3600",
        }).toString();
        return json({ url: target.toString() }, 200, {
          "set-cookie": cookie(id + "." + pending.token),
        });
      }
      const bearer = request.headers
        .get("authorization")
        ?.match(/^Bearer ([a-f0-9-]{36})\.([A-Za-z0-9_-]{43})$/);
      const authCookie = native
        ? bearer
          ? { id: bearer[1], token: bearer[2] }
          : null
        : readCookie(request);
      if (!authCookie) throw new AssistantError("authentication_required", 401);
      const auth = new AssistantAuth(env, authCookie.id);
      if (native && path === "/auth/complete" && request.method === "POST") {
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
      if (path === "/auth/complete" && request.method === "POST") {
        const input = z
          .object({
            state: z.string().max(100),
            delegation: z.string().max(50000),
          })
          .strict()
          .parse(await readJson(request));
        const result = await auth.complete(
          authCookie.token,
          input.state,
          input.delegation,
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
              await store.requestStop(
                authorization.principal,
                authCookie.id,
                state.conversation.id,
                "*",
                receivedAt,
              );
            await (
              await new AssistantUser(env, authorization.principal, (p) =>
                ctx.waitUntil(p),
              ).initialize()
            ).endOwned(authCookie.id, undefined, receivedAt);
          }
        } catch {
          /* Expiry/kill switch is also enforced by the scheduled recovery worker. */
        }
        try {
          await auth.revoke(authCookie.token);
        } catch {
          /* Already expired. */
        }
        return json({ ended: true }, 200, { "set-cookie": cookie("", 0) });
      }
      if (path === "/end" && request.method === "POST") {
        const owner = await auth.ownerForCleanup(authCookie.token);
        if (!owner) throw new AssistantError("authentication_required", 401);
        const conversationId = z
          .string()
          .uuid()
          .parse(url.searchParams.get("conversationId"));
        await new AssistantStore(env).requestStop(
          owner.principal,
          owner.authId,
          conversationId,
          "*",
          receivedAt,
        );
        await (
          await new AssistantUser(env, owner.principal, (p) =>
            ctx.waitUntil(p),
          ).initialize()
        ).endOwned(owner.authId, conversationId, receivedAt);
        return json({ ended: true });
      }
      if (path === "/voice/stop" && request.method === "POST") {
        const owner = await auth.ownerForCleanup(authCookie.token);
        if (!owner) throw new AssistantError("authentication_required", 401);
        const conversationId = z
          .string()
          .uuid()
          .parse(url.searchParams.get("conversationId"));
        const voiceId = z
          .object({ voiceId: z.string().uuid() })
          .strict()
          .parse(await readJson(request)).voiceId;
        await new AssistantStore(env).requestStop(
          owner.principal,
          owner.authId,
          conversationId,
          voiceId,
          receivedAt,
        );
        await (
          await new AssistantUser(env, owner.principal, (p) =>
            ctx.waitUntil(p),
          ).initialize()
        ).stopVoiceOwned(owner.authId, conversationId, receivedAt, voiceId);
        return json({ stopped: true });
      }
      if (
        request.method === "POST" &&
        ["/questions", "/voice", "/voice/connected", "/cancel"].includes(path)
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
      headers.set("x-assistant-client", native ? "native" : "web");
      headers.set("x-assistant-auth-id", authorization.authId);
      headers.set("x-assistant-principal", authorization.principal);
      url.pathname = "/api/assistant" + path;
      return (
        await new AssistantUser(env, authorization.principal, (p) =>
          ctx.waitUntil(p),
        ).initialize()
      ).fetch(new Request(new Request(url, request), { headers }));
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

function callbackPage(): Response {
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><title>Connect Ask AI</title><body><p id="status">Checking your connection…</p><script>
(async()=>{const p=new URLSearchParams(location.hash.slice(1));history.replaceState(null,"",location.pathname);
const status=document.getElementById("status");try{const r=await fetch("/api/assistant/auth/complete",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({state:p.get("state"),delegation:p.get("delegation")})});
const b=await r.json();if(!r.ok){status.textContent=b.error==="choose_questions_only"?"Select Questions only and try connecting again.":"Unable to connect. Check your database permission and Internet Identity authorization.";return;}
status.textContent="Connected. Close this window and return to the Wiki.";if(window.opener){window.opener.postMessage({type:"kinic-assistant-connected"},location.origin);window.close();}}
catch{status.textContent="Unable to connect. Return to the Wiki and try again."}})();</script></body></html>`,
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "content-security-policy":
          "default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
      },
    },
  );
}
