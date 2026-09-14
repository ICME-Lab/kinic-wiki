import { z } from "zod";
import { sha256 } from "@kinic/ii-server/crypto";
import { AssistantAuth, requireEnabled } from "./auth";
import { AssistantUser } from "./user";
import { AssistantError } from "./contracts";
import { cookie, failure, json, readCookie, readJson } from "./http";
import type { Env } from "./env";
export { AssistantAuth, AssistantUser };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api\/assistant/, "");
    try {
      if (request.method === "GET" && path === "/callback")
        return callbackPage();
      if (
        request.method !== "GET" ||
        request.headers.get("upgrade") === "websocket"
      ) {
        if (request.headers.get("origin") !== env.ASSISTANT_ORIGIN)
          throw new AssistantError("invalid_origin", 403);
      }
      // Cleanup stays available when the kill switch is engaged.
      if (path !== "/logout" && path !== "/end") requireEnabled(env);
      if (path === "/status" && request.method === "GET")
        return json({ available: true });
      if (path === "/auth/start" && request.method === "POST") {
        const rate = await env.AUTH_RATE_LIMIT.limit({
          key: request.headers.get("cf-connecting-ip") || "unknown",
        });
        if (!rate.success) throw new AssistantError("rate_limit", 429);
        const input = z
          .object({ consent: z.literal("2026-09-14") })
          .strict()
          .parse(await readJson(request));
        void input;
        const existing = readCookie(request);
        if (existing) {
          try {
            await env.ASSISTANT_AUTH.getByName(existing.id).revoke(
              existing.token,
            );
          } catch {
            /* Expired authentication can be replaced. */
          }
        }
        const id = crypto.randomUUID();
        const pending = await env.ASSISTANT_AUTH.getByName(id).begin(id);
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
      const authCookie = readCookie(request);
      if (!authCookie) throw new AssistantError("authentication_required", 401);
      const auth = env.ASSISTANT_AUTH.getByName(authCookie.id);
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
          if (authorization)
            await env.ASSISTANT_USERS.getByName(
              await sha256(authorization.principal),
            ).endOwned(authCookie.id);
        } catch {
          /* Expiry/kill switch is also enforced by conversation alarms. */
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
        await env.ASSISTANT_USERS.getByName(
          await sha256(owner.principal),
        ).endOwned(owner.authId, conversationId);
        return json({ ended: true });
      }
      const authorization = await auth.authorize(authCookie.token);
      if (path === "/auth" && request.method === "GET")
        return json({
          principal: authorization.principal,
          expiresAt: authorization.expiresAt,
        });
      const headers = new Headers(request.headers);
      headers.delete("cookie");
      headers.set("x-assistant-auth-id", authorization.authId);
      headers.set("x-assistant-principal", authorization.principal);
      return env.ASSISTANT_USERS.getByName(
        await sha256(authorization.principal),
      ).fetch(new Request(request, { headers }));
    } catch (error) {
      return failure(error);
    }
  },
} satisfies ExportedHandler<Env>;

function callbackPage(): Response {
  return new Response(
    `<!doctype html><html lang="ja"><meta charset="utf-8"><title>Ask AI 接続</title><body><p id="status">接続を確認しています…</p><script>
(async()=>{const p=new URLSearchParams(location.hash.slice(1));history.replaceState(null,"",location.pathname);
const status=document.getElementById("status");try{const r=await fetch("/api/assistant/auth/complete",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({state:p.get("state"),delegation:p.get("delegation")})});
const b=await r.json();if(!r.ok){status.textContent=b.error==="choose_questions_only"?"Questions only を選んで、もう一度接続してください。":"接続できませんでした。招待とII認可を確認してください。";return;}
status.textContent="接続しました。この画面を閉じてWikiへ戻ってください。";if(window.opener){window.opener.postMessage({type:"kinic-assistant-connected"},location.origin);window.close();}}
catch{status.textContent="接続できませんでした。Wikiからやり直してください。"}})();</script></body></html>`,
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
