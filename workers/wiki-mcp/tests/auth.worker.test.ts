import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { DelegationChain } from "@icp-sdk/core/identity";
import { describe, expect, it, vi } from "vitest";
import { encryptJson, sha256 } from "@kinic/ii-server/crypto";
import { generateIiKey, type KinicDelegationMaterialV1 } from "@kinic/ii-server/internet-identity";
import { handleAuthRoute } from "../src/auth/oauth.js";
import entry from "../src/entry.js";
import { II_SESSION_TTL_MS, REVIEW_SESSION_TTL_MS, MAX_REFRESH_ROTATIONS } from "../src/auth/session-policy.js";
import {
  DELEGATION_REFRESH_MARGIN_MS,
  OAUTH_CLIENT_IDLE_TTL_MS,
  SingleFlight,
  delegationContext,
  delegationNeedsRefresh,
  sessionKeyContext,
  type AuthorizationSessionInput,
  type AuthStateRecordV5,
  type McpAuthStateV5,
  type OAuthClientRecordV2
} from "../src/auth/state.js";
import {
  PAGE_STYLE,
  PAGE_STYLE_HASH
} from "../src/auth/pages.js";

const origin = "https://wiki-mcp-staging.kinic.xyz";
const resource = `${origin}/mcp`;
const encryptionKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const encryptedValue = {
  version: 1 as const,
  algorithm: "AES-GCM" as const,
  iv: "AAAAAAAAAAAAAAAA",
  ciphertext: "AA"
};

describe("MCP inside the session Durable Object", () => {
  async function activeSession(id: string, scope = "mcp:read") {
    const now = Date.now(), verifier = "v".repeat(43);
    const stub = env.MCP_AUTH_STATE.getByName(`session:${id}`);
    await stub.createSession({ ...await session(id, verifier, now), scope });
    await stub.claimConnect("connect-state", `${id}.cookie`, now);
    const completed = await stub.completeReviewConnect("review-v1", now, id);
    const issued = await stub.exchangeCode({
      code: completed!.code, clientId: "client", redirectUri: "https://chatgpt.com/callback",
      codeVerifier: verifier, issueRefreshToken: false, now
    });
    return { stub, token: issued!.accessToken };
  }
  function mcpRequest(token: string, method = "tools/list", params = {}, url = resource) {
    return new Request(url, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json",
        accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-11-25" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
    });
  }
  async function result(response: Response) {
    const text = await response.text();
    return JSON.parse(text.startsWith("event:") ? text.split("\n").find(line => line.startsWith("data: "))!.slice(6) : text);
  }

  async function iiSession(id: string, rootKey = generateIiKey(), scope = "mcp:read") {
    const now = Date.now(), verifier = "v".repeat(43);
    const targetOrigin = "https://3ryrw-kyaaa-aaaaf-qgxpq-cai.ic0.app";
    const stub = env.MCP_AUTH_STATE.getByName(`session:${id}`);
    const input = { ...await session(id, verifier, now, now + 10 * 60_000), scope };
    input.sessionKey = await encryptJson(generateIiKey().toJSON(), encryptionKey, sessionKeyContext(id));
    await stub.createSession(input);
    await stub.claimConnect("connect-state", `${id}.cookie`, now);
    const completed = await stub.completeConnect(now + 10 * 60_000, scope.includes("mcp:write") ? "all" : "queries", now, id);
    const issued = await stub.exchangeCode({ code: completed!.code, clientId: "client", redirectUri: "https://chatgpt.com/callback", codeVerifier: verifier, issueRefreshToken: true, now });
    const appKey = generateIiKey(), expiresAt = now + 5 * 60_000;
    const chain = await DelegationChain.create(rootKey, appKey.getPublicKey(), new Date(expiresAt));
    const material: KinicDelegationMaterialV1 = { version: 1, targetOrigin, expiresAt, appKey: appKey.toJSON(), delegation: chain.toJSON() };
    const encrypted = await encryptJson(material, encryptionKey, delegationContext(id, targetOrigin));
    await runInDurableObject(stub, async (_instance, state) => {
      const record = (await state.storage.get<AuthStateRecordV5>("record"))!;
      if (record.kind !== "authorization_session") throw new Error("session record missing");
      record.cachedDelegation = encrypted;
      record.cachedDelegationTargetOrigin = targetOrigin;
      record.cachedDelegationExpiresAt = expiresAt;
      await state.storage.put("record", record);
    });
    return { stub, issued: issued!, rootKey };
  }

  async function profile(token: string) {
    const response = await entry.fetch(mcpRequest(token, "tools/call", { name: "get_profile", arguments: {} }), env);
    expect(response.status).toBe(200);
    const body = await result(response);
    expect(body.result.isError).not.toBe(true);
    return body.result.structuredContent;
  }

  it("keeps the restored II profile stable across refresh, reconnect, and scope upgrades while isolating accounts", async () => {
    const first = await iiSession("profile-ii-first");
    const reconnected = await iiSession("profile-ii-reconnect", first.rootKey, "mcp:read mcp:write");
    const other = await iiSession("profile-ii-other");
    const expected = { id: first.rootKey.getPrincipal().toText() };
    expect(await profile(first.issued.accessToken)).toEqual(expected);
    const refreshed = await first.stub.rotateRefreshToken({ refreshToken: first.issued.refreshToken!, clientId: "client", resource, now: Date.now() });
    expect(refreshed).not.toBeNull();
    expect(await profile(refreshed!.accessToken)).toEqual(expected);
    const results = await Promise.all([profile(reconnected.issued.accessToken), profile(other.issued.accessToken)]);
    expect(results).toEqual([expected, { id: other.rootKey.getPrincipal().toText() }]);
    expect(results[1]).not.toEqual(expected);
    const params = { name: "get_profile", arguments: {} };
    expect((await entry.fetch(mcpRequest(first.issued.accessToken, "tools/call", params), env)).status).toBe(401);
    await first.stub.invalidate();
    expect((await entry.fetch(mcpRequest(refreshed!.accessToken, "tools/call", params), env)).status).toBe(401);
    await runInDurableObject(reconnected.stub, async (_instance, state) => {
      const record = (await state.storage.get<AuthStateRecordV5>("record"))!;
      if (record.kind !== "authorization_session") throw new Error("session record missing");
      record.accessTokenExpiresAt = Date.now() - 1;
      await state.storage.put("record", record);
    });
    expect((await entry.fetch(mcpRequest(reconnected.issued.accessToken, "tools/call", params), env)).status).toBe(401);
  });

  it("returns the configured review profile through a read-only OAuth session", async () => {
    const a = await activeSession("profile-review-a"), b = await activeSession("profile-review-b");
    expect(await profile(a.token)).toEqual({ id: env.MCP_REVIEW_IDENTITY_PRINCIPAL });
    expect(await profile(b.token)).toEqual({ id: env.MCP_REVIEW_IDENTITY_PRINCIPAL });
    expect((await entry.fetch(mcpRequest(a.token + "forged", "tools/call", { name: "get_profile", arguments: {} }), env)).status).toBe(401);
  });

  it("serves sixteen registered tools, rejects forged/cross-session tokens and observes revocation", async () => {
    const a = await activeSession("mcp-a"), b = await activeSession("mcp-b");
    const responses = await Promise.all([a, b].map(({ token }) => entry.fetch(mcpRequest(token), env)));
    for (const response of responses) {
      expect(response.status).toBe(200);
      expect((await result(response)).result.tools).toHaveLength(16);
    }
    expect((await a.stub.fetch(mcpRequest(b.token))).status).toBe(401);
    expect((await entry.fetch(mcpRequest(a.token + "forged"), env)).status).toBe(401);
    expect((await entry.fetch(mcpRequest(a.token, "tools/list", {}, "https://wrong.example/mcp"), env)).status).toBe(404);
    await a.stub.invalidate();
    expect((await entry.fetch(mcpRequest(a.token), env)).status).toBe(401);
    expect((await entry.fetch(mcpRequest(b.token), env)).status).toBe(200);
  });

  it("retains the request byte limit and read-only scope enforcement inside the DO", async () => {
    const { token } = await activeSession("mcp-readonly");
    const tooLarge = mcpRequest(token, "tools/list", { padding: "a".repeat(300_000) });
    expect((await entry.fetch(tooLarge, env)).status).toBe(413);
    const response = await entry.fetch(mcpRequest(token, "tools/call", {
      name: "delete_nodes", arguments: { database_id: "db_abcdefghijkl",
        operations: [{ path: "/OpenAIReview/scratch/test", expected_etag: "v1" }] }
    }), env);
    const body = await result(response);
    expect(body.result.isError).toBe(true);
    expect(JSON.stringify(body)).toContain("insufficient_scope");
  });
});

describe("authorization pages", () => {
  it("matches the CSP style hash", async () => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(PAGE_STYLE));
    const base64 = btoa(String.fromCharCode(...new Uint8Array(digest)));
    expect(PAGE_STYLE_HASH).toBe(`sha256-${base64}`);
  });
});

describe("staging OAuth discovery and registration", () => {
  it("hides the reviewer form and rejects reviewer login when disabled", async () => {
    const registered = await register(["https://chatgpt.com/connector/oauth/callback"]);
    const { client_id: clientId } = await registered.json<{ client_id: string }>();
    const disabledEnv = { ...env, MCP_REVIEW_LOGIN_ENABLED: "false" };
    const response = await handleAuthRoute(
      new Request(await authorizationUrl(clientId, "d".repeat(43))), disabledEnv
    );
    expect(response?.status).toBe(200);
    const html = await response!.text();
    expect(html).toContain('class="ii-connect"');
    expect(html).not.toContain("OpenAI reviewer sign in");
    expect(html).not.toContain('action="/oauth/connect/reviewer"');
    const rejected = await handleAuthRoute(
      new Request(`${origin}/oauth/connect/reviewer`, { method: "POST" }), disabledEnv
    );
    expect(rejected?.status).toBe(503);
  });

  it("publishes RFC 9728 and RFC 8414 metadata", async () => {
    const protectedResource = await fetchWorker(`${origin}/.well-known/oauth-protected-resource/mcp`);
    expect(protectedResource.status).toBe(200);
    await expect(protectedResource.json()).resolves.toMatchObject({
      resource,
      authorization_servers: [origin],
      scopes_supported: ["mcp:read", "mcp:write", "offline_access"]
    });

    const server = await fetchWorker(`${origin}/.well-known/oauth-authorization-server`);
    await expect(server.json()).resolves.toMatchObject({
      issuer: origin,
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"]
    });
  });

  it.each(["initialize", "tools/list", "tools/call"])(
    "requires OAuth at the staging HTTP boundary for %s",
    async (method) => {
      const response = await fetchWorker(`${origin}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method,
          params: method === "tools/call" ? { name: "find_databases", arguments: {} } : {}
        })
      });
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toContain(
        "/.well-known/oauth-protected-resource/mcp"
      );
      expect(response.headers.get("www-authenticate")).toContain('scope="mcp:read"');
    }
  );

  it("ends unsupported stateless SSE requests without leaving a Worker open", async () => {
    const response = await fetchWorker(`${origin}/mcp`, {
      method: "GET",
      headers: { accept: "text/event-stream", "mcp-protocol-version": "2025-11-25" }
    });

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    await expect(response.text()).resolves.toBe("");
  });

  it("keeps every JSON-RPC batch behind the HTTP OAuth boundary", async () => {
    const response = await fetchWorker(`${origin}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([
        { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} },
        { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "find_databases", arguments: {} } }
      ])
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(
      "/.well-known/oauth-protected-resource/mcp"
    );
  });

  it("serves safe callback messages without embedding connection data", async () => {
    const response = await fetchWorker(`${origin}/mcp/connect`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain(`style-src '${PAGE_STYLE_HASH}'`);
    expect(html).toContain(`<style>${PAGE_STYLE}</style>`);
    expect(html).toContain("Connecting…");
    expect(html).toContain("temporarily_unavailable");
    expect(html).toContain("registration_rejected");
    expect(html).not.toContain("raw principal");
    expect(html).not.toContain("authorization code");
  });

  it("rejects a callback without its cookie and state binding", async () => {
    const response = await fetchWorker(`${origin}/mcp/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ delegation: "not-logged", state: "missing-cookie" })
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_connection" });
  });

  it("allows only the hosted OpenAI redirects and loopback redirects", async () => {
    const accepted = await register(["https://chatgpt.com/connector/oauth/callback", "http://127.0.0.1:43210/callback"]);
    expect(accepted.status).toBe(201);
    const acceptedBody = await accepted.json<{ client_id: string }>();
    expect(acceptedBody.client_id).toMatch(/^mcl1\./u);

    const rejected = await register(["https://attacker.example/callback"]);
    expect(rejected.status).toBe(400);
    await expect(rejected.json()).resolves.toEqual({ error: "invalid_redirect_uri" });
  });

  it("limits client registration per connecting IP", async () => {
    const address = "192.0.2.78";
    for (let index = 0; index < 10; index += 1) {
      expect((await register(["https://chatgpt.com/callback"], "none", address)).status).toBe(201);
    }
    const limited = await register(["https://chatgpt.com/callback"], "none", address);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(limited.headers.get("cache-control")).toBe("no-store");
    await expect(limited.json()).resolves.toEqual({ error: "temporarily_unavailable" });

    expect((await register(["https://chatgpt.com/callback"], "none", "192.0.2.79")).status).toBe(201);
  });

  it("does not expose staging auth or MCP routes on another origin", async () => {
    for (const path of ["/mcp", "/oauth/register", "/.well-known/oauth-authorization-server"]) {
      const response = await fetchWorker(`https://kinic-wiki-mcp-staging.example.workers.dev${path}`, {
        method: path === "/oauth/register" || path === "/mcp" ? "POST" : "GET"
      });
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ error: "not found" });
    }
  });

  it("accepts exact-limit JSON and form bodies and rejects oversized bodies", async () => {
    const registration = {
      redirect_uris: ["https://chatgpt.com/callback"],
      grant_types: ["authorization_code"],
      token_endpoint_auth_method: "none",
      client_name: ""
    };
    const emptyNameBody = JSON.stringify(registration);
    registration.client_name = "x".repeat(16_384 - emptyNameBody.length);
    const exactJsonBody = JSON.stringify(registration);
    expect(new TextEncoder().encode(exactJsonBody)).toHaveLength(16_384);

    const exactJson = await fetchWorker(`${origin}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: exactJsonBody
    });
    expect(exactJson.status).toBe(201);

    const oversizedJson = await fetchWorker(`${origin}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: `${exactJsonBody} `
    });
    expect(oversizedJson.status).toBe(400);
    await expect(oversizedJson.json()).resolves.toEqual({ error: "invalid_client_metadata" });

    const formPrefix = "grant_type=authorization_code&client_id=unknown&padding=";
    const exactFormBody = `${formPrefix}${"x".repeat(16_384 - formPrefix.length)}`;
    const exactForm = await fetchWorker(`${origin}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: exactFormBody
    });
    expect(exactForm.status).toBe(401);
    await expect(exactForm.json()).resolves.toEqual({ error: "invalid_client" });

    const oversizedForm = await fetchWorker(`${origin}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `${exactFormBody}x`
    });
    expect(oversizedForm.status).toBe(400);
    await expect(oversizedForm.json()).resolves.toEqual({ error: "invalid_request" });
  });

  it("supports none, basic, and post client authentication without weakening PKCE", async () => {
    for (const method of ["client_secret_basic", "client_secret_post"] as const) {
      const response = await register(["https://chatgpt.com/callback"], method);
      const client = await response.json<{ client_id: string; client_secret: string }>();
      const form = new URLSearchParams({
        grant_type: "authorization_code",
        code: "invalid",
        redirect_uri: "https://chatgpt.com/callback",
        code_verifier: "a".repeat(43),
        client_id: client.client_id
      });
      const headers = new Headers({ "content-type": "application/x-www-form-urlencoded" });
      if (method === "client_secret_basic") {
        form.delete("client_id");
        headers.set("authorization", `Basic ${btoa(`${client.client_id}:${client.client_secret}`)}`);
      } else {
        form.set("client_secret", client.client_secret);
      }
      const authenticated = await fetchWorker(`${origin}/oauth/token`, { method: "POST", headers, body: form.toString() });
      await expect(authenticated.json()).resolves.toEqual({ error: "invalid_grant" });

      if (method === "client_secret_basic") {
        headers.set("authorization", `Basic ${btoa(`${client.client_id}:wrong`)}`);
      } else {
        form.set("client_secret", "wrong");
      }
      const rejected = await fetchWorker(`${origin}/oauth/token`, { method: "POST", headers, body: form.toString() });
      expect(rejected.status).toBe(401);
      await expect(rejected.json()).resolves.toEqual({ error: "invalid_client" });
    }
  });

  it("requires exact redirect, canonical resource, and S256 PKCE", async () => {
    const registered = await register(["https://chatgpt.com/connector/oauth/callback"]);
    const { client_id: clientId } = await registered.json<{ client_id: string }>();
    const verifier = "a".repeat(43);
    const challenge = await sha256(verifier);
    const valid = new URL(`${origin}/oauth/authorize`);
    valid.search = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: "https://chatgpt.com/connector/oauth/callback",
      state: "client-state",
      resource,
      scope: "mcp:read offline_access",
      code_challenge: challenge,
      code_challenge_method: "S256"
    }).toString();
    const started = await fetchWorker(valid.toString(), { redirect: "manual" });
    expect(started.status).toBe(200);
    const authorizationHtml = await started.text();
    expect(authorizationHtml).toContain("Internet Identity");
    expect(authorizationHtml).toContain("OpenAI reviewer sign in");
    expect(authorizationHtml).toContain(`<style>${PAGE_STYLE}</style>`);
    expect(authorizationHtml).toContain('<html lang="en">');
    expect(authorizationHtml).toContain("Read your wiki content.");
    expect(authorizationHtml).not.toContain("<details open");
    expect(started.headers.getSetCookie().some((cookie) => cookie.includes("kinic-mcp-locale"))).toBe(false);
    expect(started.headers.get("set-cookie")).toContain("HttpOnly");
    expect(started.headers.get("set-cookie")).toContain("SameSite=Lax");
    const iiStarted = await fetchWorker(`${origin}/oauth/connect/internet-identity`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: cookieFrom(started)
      },
      body: new URLSearchParams({ connect_state: connectStateFrom(authorizationHtml) }).toString()
    });
    expect(iiStarted.status).toBe(302);
    const iiParams = new URLSearchParams(new URL(iiStarted.headers.get("location")!).hash.slice(1));
    expect(iiParams.get("ttl")).toBe(String(II_SESSION_TTL_MS / 1000));
    expect(authorizationHtml).toContain("renew this connection automatically until that approved expiry");
    expect(iiStarted.headers.get("location")).toMatch(/^https:\/\/id\.ai\/mcp#/u);

    valid.searchParams.set("redirect_uri", "https://chatgpt.com/connector/oauth/callback/");
    expect((await fetchWorker(valid.toString(), { redirect: "manual" })).status).toBe(400);
    valid.searchParams.set("redirect_uri", "https://chatgpt.com/connector/oauth/callback");
    valid.searchParams.set("resource", `${origin}/other`);
    expect((await fetchWorker(valid.toString(), { redirect: "manual" })).status).toBe(400);
    valid.searchParams.set("resource", resource);
    valid.searchParams.set("code_challenge_method", "plain");
    expect((await fetchWorker(valid.toString(), { redirect: "manual" })).status).toBe(400);

    const tokenWithWrongResource = await fetchWorker(`${origin}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        code: "invalid",
        redirect_uri: "https://chatgpt.com/connector/oauth/callback",
        code_verifier: verifier,
        resource: `${origin}/other`
      }).toString()
    });
    await expect(tokenWithWrongResource.json()).resolves.toEqual({ error: "invalid_target" });
  });

  it.each([
    "https://chatgpt.com/connector/oauth/callback",
    "https://chat.openai.com/callback",
    "http://127.0.0.1:43210/callback",
    "http://localhost:43211/callback"
  ])("authorizes the reviewer with a session-scoped form policy for %s", async (redirectUri) => {
    const registered = await register([redirectUri, "https://chatgpt.com/unused-callback"]);
    const { client_id: clientId } = await registered.json<{ client_id: string }>();
    const verifier = "r".repeat(43);
    const authorizeUrl = new URL(await authorizationUrl(clientId, verifier));
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    const started = await fetchWorker(authorizeUrl.toString(), { redirect: "manual" });
    const platformRelay = redirectUri.startsWith("https://chat") ? " https://platform.openai.com" : "";
    const expectedPolicy = `default-src 'none'; img-src data:; style-src '${PAGE_STYLE_HASH}'; form-action 'self' https://id.ai ${new URL(redirectUri).origin}${platformRelay}; base-uri 'none'; frame-ancestors 'none'`;
    expect(started.headers.get("content-security-policy")).toBe(expectedPolicy);
    const html = await started.text();
    const cookie = cookieFrom(started);
    const connectState = connectStateFrom(html);

    const rejected = await fetchWorker(`${origin}/oauth/connect/reviewer`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "cf-connecting-ip": "198.51.100.240",
        cookie
      },
      body: new URLSearchParams({
        connect_state: connectState,
        username: "openai-review",
        password: "wrong"
      }).toString()
    });
    expect(rejected.status).toBe(401);
    expect(rejected.headers.get("content-security-policy")).toBe(expectedPolicy);
    const rejectedHtml = await rejected.text();
    expect(rejectedHtml).toContain("Sign-in failed.");
    expect(rejectedHtml).toContain('<details open>');
    expect(rejectedHtml).toContain("Read and edit your wiki content.");

    const accepted = await fetchWorker(`${origin}/oauth/connect/reviewer`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "cf-connecting-ip": "198.51.100.240",
        cookie
      },
      body: new URLSearchParams({
        connect_state: connectState,
        username: "openai-review",
        password: "review-password"
      }).toString()
    });
    expect(accepted.status).toBe(302);
    const redirect = new URL(accepted.headers.get("location")!);
    expect(redirect.origin + redirect.pathname).toBe(redirectUri);
    expect(redirect.searchParams.get("state")).toBe("client-state");
    const code = redirect.searchParams.get("code");
    expect(code).toMatch(/^mkc1\./u);

    const tokenResponse = await fetchWorker(`${origin}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        code: code!,
        redirect_uri: redirectUri,
        code_verifier: verifier,
        resource
      }).toString()
    });
    expect(tokenResponse.status).toBe(200);
    await expect(tokenResponse.json()).resolves.toMatchObject({
      token_type: "Bearer",
      scope: "mcp:read mcp:write offline_access",
      resource
    });
  });

  it("binds reviewer login to its cookie and rate limits repeated attempts", async () => {
    const registered = await register(["https://chatgpt.com/connector/oauth/callback"]);
    const { client_id: clientId } = await registered.json<{ client_id: string }>();
    const started = await fetchWorker(await authorizationUrl(clientId, "l".repeat(43)));
    const html = await started.text();
    const connectState = connectStateFrom(html);
    const body = new URLSearchParams({
      connect_state: connectState,
      username: "openai-review",
      password: "wrong"
    }).toString();
    const missingCookie = await fetchWorker(`${origin}/oauth/connect/reviewer`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "cf-connecting-ip": "198.51.100.241"
      },
      body
    });
    expect(missingCookie.status).toBe(400);
    expect(missingCookie.headers.get("content-type")).toContain("text/html");
    expect(await missingCookie.text()).toContain("This sign-in link has expired or was already used.");

    let response: Response | undefined;
    for (let attempt = 0; attempt < 11; attempt += 1) {
      response = await fetchWorker(`${origin}/oauth/connect/reviewer`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "cf-connecting-ip": "198.51.100.242",
          cookie: cookieFrom(started)
        },
        body
      });
    }
    expect(response?.status).toBe(429);
    expect(response?.headers.get("retry-after")).toBe("60");
    expect(response?.headers.get("content-type")).toContain("text/html");
    expect(await response?.text()).toContain("Too many sign-in attempts.");
  });

  it("ignores ui_locales and Accept-Language and always renders English", async () => {
    const registered = await register(["https://chatgpt.com/connector/oauth/callback"]);
    const { client_id: clientId } = await registered.json<{ client_id: string }>();
    const url = new URL(await authorizationUrl(clientId, "j".repeat(43)));
    url.searchParams.set("ui_locales", "ja-JP");
    const started = await fetchWorker(url.toString(), { headers: { "accept-language": "ja-JP" } });
    const html = await started.text();
    expect(html).toContain('<html lang="en">');
    expect(html).toContain("Internet Identity");
    expect(html).toContain("Read and edit your wiki content.");
    expect(html).toContain("<details><summary>OpenAI reviewer sign in</summary>");

    const expired = await fetchWorker(`${origin}/oauth/connect/internet-identity`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", "accept-language": "ja-JP" },
      body: new URLSearchParams({ connect_state: connectStateFrom(html) }).toString()
    });
    expect(expired.status).toBe(400);
    expect(expired.headers.get("content-security-policy")).toBe(
      `default-src 'none'; img-src data:; style-src '${PAGE_STYLE_HASH}'; base-uri 'none'; frame-ancestors 'none'`
    );
    const expiredHtml = await expired.text();
    expect(expiredHtml).toContain('<html lang="en">');
    expect(expiredHtml).toContain("Couldn't connect");
  });
});

describe("McpAuthStateV5 single-use records", () => {
  it("refreshes cached delegations at the 30-second margin or on origin change", () => {
    const now = Date.now();
    const targetOrigin = "https://3ryrw-kyaaa-aaaaf-qgxpq-cai.ic0.app";
    expect(
      delegationNeedsRefresh(
        { cachedDelegationTargetOrigin: targetOrigin, cachedDelegationExpiresAt: now + DELEGATION_REFRESH_MARGIN_MS + 1 },
        targetOrigin,
        now
      )
    ).toBe(false);
    expect(
      delegationNeedsRefresh(
        { cachedDelegationTargetOrigin: targetOrigin, cachedDelegationExpiresAt: now + DELEGATION_REFRESH_MARGIN_MS },
        targetOrigin,
        now
      )
    ).toBe(true);
    expect(
      delegationNeedsRefresh(
        { cachedDelegationTargetOrigin: targetOrigin, cachedDelegationExpiresAt: now + 5 * 60_000 },
        "https://6emaw-iyaaa-aaaay-aacka-cai.ic0.app",
        now
      )
    ).toBe(true);
  });

  it("shares one in-flight delegation mint and starts a new one after completion", async () => {
    const singleFlight = new SingleFlight<string>();
    let resolve!: (value: string) => void;
    let calls = 0;
    const factory = () => {
      calls += 1;
      return new Promise<string>((complete) => {
        resolve = complete;
      });
    };

    const first = singleFlight.run(factory);
    const second = singleFlight.run(factory);
    expect(first).toBe(second);
    expect(calls).toBe(1);
    resolve("delegation");
    await expect(Promise.all([first, second])).resolves.toEqual(["delegation", "delegation"]);
    await Promise.resolve();

    const third = singleFlight.run(async () => {
      calls += 1;
      return "renewed";
    });
    await expect(third).resolves.toBe("renewed");
    expect(calls).toBe(2);
  });

  it("reuses an encrypted delegation across token validation and refresh rotation", async () => {
    const now = Date.now();
    const sessionId = "delegation-cache";
    const verifier = "d".repeat(43);
    const targetOrigin = "https://3ryrw-kyaaa-aaaaf-qgxpq-cai.ic0.app";
    const stub = env.MCP_AUTH_STATE.getByName(`session:${sessionId}`);
    const input = await session(sessionId, verifier, now, now + 10 * 60_000, now + 60_000);
    input.sessionKey = await encryptJson(
      generateIiKey().toJSON(),
      encryptionKey,
      sessionKeyContext(sessionId)
    );
    await stub.createSession(input);
    await stub.claimConnect("connect-state", `${sessionId}.cookie`, now);
    const completed = await stub.completeConnect(now + 10 * 60_000, "all", now, sessionId);
    const issued = await stub.exchangeCode({
      code: completed!.code,
      clientId: "client",
      redirectUri: "https://chatgpt.com/callback",
      codeVerifier: verifier,
      issueRefreshToken: true,
      now
    });

    const appKey = generateIiKey();
    const rootKey = generateIiKey();
    const expiresAt = now + 5 * 60_000;
    const chain = await DelegationChain.create(rootKey, appKey.getPublicKey(), new Date(expiresAt));
    const material: KinicDelegationMaterialV1 = {
      version: 1,
      targetOrigin,
      expiresAt,
      appKey: appKey.toJSON(),
      delegation: chain.toJSON()
    };
    const encryptedDelegation = await encryptJson(
      material,
      encryptionKey,
      delegationContext(sessionId, targetOrigin)
    );
    await runInDurableObject(stub, async (_instance, state) => {
      const record = (await state.storage.get<AuthStateRecordV5>("record"))!;
      if (record.kind !== "authorization_session") throw new Error("session record missing");
      record.cachedDelegation = encryptedDelegation;
      record.cachedDelegationTargetOrigin = targetOrigin;
      record.cachedDelegationExpiresAt = expiresAt;
      await state.storage.put("record", record);
    });

    await expect(stub.authenticateAccessToken(issued!.accessToken, resource, now, false)).resolves.toMatchObject({
      kind: "valid",
      delegation: null
    });
    await expect(stub.authenticateAccessToken(issued!.accessToken, resource, now, true)).resolves.toMatchObject({
      kind: "valid",
      delegation: { targetOrigin, expiresAt }
    });
    const rotated = await stub.rotateRefreshToken({
      refreshToken: issued!.refreshToken!,
      clientId: "client",
      resource,
      now: now + 1
    });
    await expect(stub.authenticateAccessToken(rotated!.accessToken, resource, now + 1, true)).resolves.toMatchObject({
      kind: "valid",
      delegation: { targetOrigin, expiresAt }
    });
  });

  it("clears a corrupt encrypted delegation without invalidating the OAuth session", async () => {
    const now = Date.now();
    const sessionId = "corrupt-delegation";
    const verifier = "c".repeat(43);
    const targetOrigin = "https://3ryrw-kyaaa-aaaaf-qgxpq-cai.ic0.app";
    const stub = env.MCP_AUTH_STATE.getByName(`session:${sessionId}`);
    const input = await session(sessionId, verifier, now, now + 10 * 60_000, now + 60_000);
    await stub.createSession(input);
    await stub.claimConnect("connect-state", `${sessionId}.cookie`, now);
    const completed = await stub.completeConnect(now + 10 * 60_000, "all", now, sessionId);
    const issued = await stub.exchangeCode({
      code: completed!.code,
      clientId: "client",
      redirectUri: "https://chatgpt.com/callback",
      codeVerifier: verifier,
      issueRefreshToken: true,
      now
    });
    await runInDurableObject(stub, async (instance, state) => {
      const record = (await state.storage.get<AuthStateRecordV5>("record"))!;
      if (record.kind !== "authorization_session") throw new Error("session record missing");
      record.cachedDelegation = encryptedValue;
      record.cachedDelegationTargetOrigin = targetOrigin;
      record.cachedDelegationExpiresAt = now + 5 * 60_000;
      await state.storage.put("record", record);
      await expect(
        (instance as unknown as { readCachedDelegation(origin: string, now: number): Promise<unknown> })
          .readCachedDelegation(targetOrigin, now)
      ).resolves.toBeNull();
    });
    await expect(stub.validateAccessToken(issued!.accessToken, resource, now)).resolves.not.toBeNull();
  });

  it("removes write scope from Questions-only II sessions", async () => {
    const verifier = "q".repeat(43);
    const stub = env.MCP_AUTH_STATE.getByName("session:questions-scope");
    const input = await session("questions-scope", verifier);
    input.scope = "mcp:read mcp:write offline_access";
    await stub.createSession(input);
    await stub.claimConnect("connect-state", "questions-scope.cookie", Date.now());

    const completed = await stub.completeConnect(Date.now() + 60_000, "queries", Date.now(), "questions-scope");
    const issued = await stub.exchangeCode({
      code: completed!.code,
      clientId: "client",
      redirectUri: "https://chatgpt.com/callback",
      codeVerifier: verifier,
      issueRefreshToken: true,
      now: Date.now()
    });

    await expect(stub.validateAccessToken(issued!.accessToken, resource, Date.now())).resolves.toMatchObject({
      scope: "mcp:read offline_access",
      actionPermission: "queries",
      identitySource: "internet_identity"
    });
  });

  it("uses the review service source and rejects stale review access versions", async () => {
    const now = Date.now();
    const verifier = "v".repeat(43);
    const validStub = env.MCP_AUTH_STATE.getByName("session:review-valid");
    await validStub.createSession(await session("review-valid", verifier, now));
    await validStub.claimConnect("connect-state", "review-valid.cookie", now);
    const completed = await validStub.completeReviewConnect("review-v1", now, "review-valid");
    const issued = await validStub.exchangeCode({
      code: completed!.code,
      clientId: "client",
      redirectUri: "https://chatgpt.com/callback",
      codeVerifier: verifier,
      issueRefreshToken: true,
      now
    });
    await expect(validStub.authenticateAccessToken(issued!.accessToken, resource, now, true)).resolves.toMatchObject({
      kind: "valid",
      identitySource: "review_service",
      actionPermission: "all",
      delegation: null
    });
    let refreshTokenHashBeforeRotation: string | null = null;
    await runInDurableObject(validStub, async (_instance, state) => {
      const record = (await state.storage.get<AuthStateRecordV5>("record"))!;
      if (record.kind !== "authorization_session") throw new Error("session record missing");
      refreshTokenHashBeforeRotation = record.currentRefreshTokenHash;
      record.reviewAccessVersion = "review-v0";
      await state.storage.put("record", record);
    });
    await expect(validStub.authenticateAccessToken(issued!.accessToken, resource, now, true)).resolves.toEqual({
      kind: "invalid"
    });
    await expect(
      validStub.rotateRefreshToken({
        refreshToken: issued!.refreshToken!,
        clientId: "client",
        resource,
        now: now + 1
      })
    ).resolves.toBeNull();
    await runInDurableObject(validStub, async (_instance, state) => {
      const record = (await state.storage.get<AuthStateRecordV5>("record"))!;
      if (record.kind !== "authorization_session") throw new Error("session record missing");
      expect(record.currentRefreshTokenHash).toBe(refreshTokenHashBeforeRotation);
      expect(record.spentRefreshTokenHashes).toEqual([]);
    });

    const staleStub = env.MCP_AUTH_STATE.getByName("session:review-stale");
    await staleStub.createSession(await session("review-stale", verifier, now));
    await staleStub.claimConnect("connect-state", "review-stale.cookie", now);
    const staleCompleted = await staleStub.completeReviewConnect("review-v0", now, "review-stale");
    const staleIssued = await staleStub.exchangeCode({
      code: staleCompleted!.code,
      clientId: "client",
      redirectUri: "https://chatgpt.com/callback",
      codeVerifier: verifier,
      issueRefreshToken: false,
      now
    });
    expect(staleIssued).toBeNull();
  });

  it("atomically consumes state and authorization code", async () => {
    const verifier = "b".repeat(43);
    const stub = env.MCP_AUTH_STATE.getByName("session:single-use");
    await stub.createSession(await session("single-use", verifier));
    const claims = await Promise.all([
      stub.claimConnect("connect-state", "single-use.cookie", Date.now()),
      stub.claimConnect("connect-state", "single-use.cookie", Date.now())
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);

    const completed = await stub.completeConnect(Date.now() + 60_000, "all", Date.now(), "single-use");
    expect(completed).not.toBeNull();
    const first = await stub.exchangeCode({
      code: completed!.code,
      clientId: "client",
      redirectUri: "https://chatgpt.com/callback",
      codeVerifier: verifier,
      issueRefreshToken: true,
      now: Date.now()
    });
    expect(first?.accessToken).toMatch(/^mka1\.single-use\./u);
    expect(first?.refreshToken).toMatch(/^mkr1\.single-use\./u);
    await expect(
      stub.validateAccessToken(first!.accessToken, resource, Date.now())
    ).resolves.toMatchObject({ sessionExpiresAt: expect.any(Number) });
    await expect(
      stub.validateAccessToken(first!.accessToken, `${origin}/other`, Date.now())
    ).resolves.toBeNull();
    await expect(
      stub.validateAccessToken(first!.accessToken, resource, first!.accessExpiresAt + 1)
    ).resolves.toBeNull();
    await expect(
      stub.validateAccessToken("mka1.single-use.invalid", resource, Date.now())
    ).resolves.toBeNull();
    await expect(
      stub.exchangeCode({
        code: "mkc1.single-use.unrelated",
        clientId: "client",
        redirectUri: "https://chatgpt.com/callback",
        codeVerifier: verifier,
        issueRefreshToken: true,
        now: Date.now()
      })
    ).resolves.toBeNull();
    await expect(stub.validateAccessToken(first!.accessToken, resource, Date.now())).resolves.not.toBeNull();
    await expect(
      stub.exchangeCode({
        code: completed!.code,
        clientId: "another-client",
        redirectUri: "https://chatgpt.com/callback",
        codeVerifier: verifier,
        issueRefreshToken: true,
        now: Date.now()
      })
    ).resolves.toBeNull();
    await expect(stub.validateAccessToken(first!.accessToken, resource, Date.now())).resolves.not.toBeNull();
    await expect(
      stub.exchangeCode({
        code: completed!.code,
        clientId: "client",
        redirectUri: "https://chatgpt.com/another-callback",
        codeVerifier: verifier,
        issueRefreshToken: true,
        now: Date.now()
      })
    ).resolves.toBeNull();
    await expect(stub.validateAccessToken(first!.accessToken, resource, Date.now())).resolves.not.toBeNull();
    await expect(
      stub.exchangeCode({
        code: completed!.code,
        clientId: "client",
        redirectUri: "https://chatgpt.com/callback",
        codeVerifier: "z".repeat(43),
        issueRefreshToken: true,
        now: Date.now()
      })
    ).resolves.toBeNull();
    await expect(stub.validateAccessToken(first!.accessToken, resource, Date.now())).resolves.not.toBeNull();
    await expect(
      stub.exchangeCode({
        code: completed!.code,
        clientId: "client",
        redirectUri: "https://chatgpt.com/callback",
        codeVerifier: verifier,
        issueRefreshToken: true,
        now: Date.now()
      })
    ).resolves.toBeNull();
    await expect(stub.validateAccessToken(first!.accessToken, resource, Date.now())).resolves.toBeNull();
    await expect(
      stub.rotateRefreshToken({
        refreshToken: first!.refreshToken!,
        clientId: "client",
        resource,
        now: Date.now()
      })
    ).resolves.toBeNull();
  });

  it("rejects a missing cookie, mismatched state, and wrong verifier", async () => {
    const verifier = "e".repeat(43);
    const stub = env.MCP_AUTH_STATE.getByName("session:negative");
    await stub.createSession(await session("negative", verifier));
    await expect(stub.claimConnect("wrong", "negative.cookie", Date.now())).resolves.toBeNull();
    await expect(stub.claimConnect("connect-state", "wrong", Date.now())).resolves.toBeNull();
    await stub.claimConnect("connect-state", "negative.cookie", Date.now());
    const completed = await stub.completeConnect(Date.now() + 60_000, "all", Date.now(), "negative");
    await expect(
      stub.exchangeCode({
        code: completed!.code,
        clientId: "client",
        redirectUri: "https://chatgpt.com/callback",
        codeVerifier: "f".repeat(43),
        issueRefreshToken: true,
        now: Date.now()
      })
    ).resolves.toBeNull();
  });

  it("expires an authorization code after ten minutes inside an eight-hour session", async () => {
    const now = Date.now();
    const verifier = "h".repeat(43);
    const stub = env.MCP_AUTH_STATE.getByName("session:code-expiry");
    await stub.createSession(
      await session("code-expiry", verifier, now, now + 8 * 60 * 60 * 1000, now + 10 * 60 * 1000)
    );
    await stub.claimConnect("connect-state", "code-expiry.cookie", now);
    const completed = await stub.completeConnect(now + 8 * 60 * 60 * 1000, "all", now, "code-expiry");
    await expect(
      stub.exchangeCode({
        code: completed!.code,
        clientId: "client",
        redirectUri: "https://chatgpt.com/callback",
        codeVerifier: verifier,
        issueRefreshToken: true,
        now: now + 10 * 60 * 1000 + 1
      })
    ).resolves.toBeNull();
  });

  it("moves the alarm from code expiry to session expiry after exchange", async () => {
    const now = Date.now();
    const sessionExpiresAt = now + 8 * 60 * 60 * 1000;
    const verifier = "i".repeat(43);
    const stub = env.MCP_AUTH_STATE.getByName("session:alarm-transition");
    await stub.createSession(
      await session("alarm-transition", verifier, now, sessionExpiresAt, now + 10 * 60 * 1000)
    );
    await stub.claimConnect("connect-state", "alarm-transition.cookie", now);
    const completed = await stub.completeConnect(sessionExpiresAt, "all", now, "alarm-transition");
    await expect(alarmTime(stub)).resolves.toBe(now + 10 * 60 * 1000);
    await stub.exchangeCode({
      code: completed!.code,
      clientId: "client",
      redirectUri: "https://chatgpt.com/callback",
      codeVerifier: verifier,
      issueRefreshToken: true,
      now
    });
    await expect(alarmTime(stub)).resolves.toBe(sessionExpiresAt);
  });

  it("cannot complete a connection after the session is invalidated", async () => {
    const stub = env.MCP_AUTH_STATE.getByName("session:invalidated");
    await stub.createSession(await session("invalidated", "g".repeat(43)));
    await stub.claimConnect("connect-state", "invalidated.cookie", Date.now());
    await stub.invalidate();

    await expect(stub.completeConnect(Date.now() + 60_000, "all", Date.now(), "invalidated")).resolves.toBeNull();
  });

  it("revokes the token family only when a spent refresh token is replayed", async () => {
    const verifier = "c".repeat(43);
    const stub = env.MCP_AUTH_STATE.getByName("session:refresh");
    await stub.createSession(await session("refresh", verifier));
    await stub.claimConnect("connect-state", "refresh.cookie", Date.now());
    const completed = await stub.completeConnect(Date.now() + 60_000, "all", Date.now(), "refresh");
    const issued = await stub.exchangeCode({
      code: completed!.code,
      clientId: "client",
      redirectUri: "https://chatgpt.com/callback",
      codeVerifier: verifier,
      issueRefreshToken: true,
      now: Date.now()
    });
    const rotated = await stub.rotateRefreshToken({
      refreshToken: issued!.refreshToken!,
      clientId: "client",
      resource,
      now: Date.now()
    });
    expect(rotated?.refreshToken).not.toBe(issued?.refreshToken);
    await expect(
      stub.rotateRefreshToken({
        refreshToken: "mkr1.refresh.unrelated",
        clientId: "client",
        resource,
        now: Date.now()
      })
    ).resolves.toBeNull();
    await expect(stub.validateAccessToken(rotated!.accessToken, resource, Date.now())).resolves.not.toBeNull();
    await expect(
      stub.rotateRefreshToken({
        refreshToken: rotated!.refreshToken!,
        clientId: "client",
        resource: `${origin}/other`,
        now: Date.now()
      })
    ).resolves.toBeNull();
    await expect(stub.validateAccessToken(rotated!.accessToken, resource, Date.now())).resolves.not.toBeNull();
    await expect(
      stub.rotateRefreshToken({
        refreshToken: issued!.refreshToken!,
        clientId: "client",
        resource,
        now: Date.now()
      })
    ).resolves.toBeNull();
    await expect(stub.validateAccessToken(rotated!.accessToken, resource, Date.now())).resolves.toBeNull();
    await expect(
      stub.rotateRefreshToken({
        refreshToken: rotated!.refreshToken!,
        clientId: "client",
        resource,
        now: Date.now()
      })
    ).resolves.toBeNull();
  });

  it("deletes expired sessions with an alarm", async () => {
    const stub = env.MCP_AUTH_STATE.getByName("session:expired");
    await stub.createSession(await session("expired", "d".repeat(43)));
    await runInDurableObject(stub, async (_instance, state) => {
      const record = await state.storage.get<Record<string, unknown>>("record");
      await state.storage.put("record", { ...record, connectExpiresAt: Date.now() - 1 });
      await state.storage.setAlarm(Date.now() + 60_000);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await expect(stub.claimConnect("connect-state", "expired.cookie", Date.now())).resolves.toBeNull();
  });

  it("extends active client expiry and deletes an idle client with an alarm", async () => {
    const now = Date.now();
    const stub = env.MCP_AUTH_STATE.getByName("client:ttl");
    const client: OAuthClientRecordV2 = {
      version: 2,
      kind: "oauth_client",
      clientId: "mcl1.ttl",
      redirectUris: ["https://chatgpt.com/callback"],
      grantTypes: ["authorization_code"],
      tokenEndpointAuthMethod: "none",
      clientSecretHash: null,
      createdAt: now,
      lastUsedAt: now,
      clientExpiresAt: now + OAUTH_CLIENT_IDLE_TTL_MS
    };
    await stub.createClient(client);
    const usedAt = now + 60_000;
    await expect(stub.getClient(usedAt)).resolves.toMatchObject({
      lastUsedAt: usedAt,
      clientExpiresAt: usedAt + OAUTH_CLIENT_IDLE_TTL_MS
    });
    await expect(alarmTime(stub)).resolves.toBe(usedAt + OAUTH_CLIENT_IDLE_TTL_MS);

    await runInDurableObject(stub, async (_instance, state) => {
      const record = await state.storage.get<OAuthClientRecordV2>("record");
      await state.storage.put("record", { ...record!, clientExpiresAt: Date.now() - 1 });
      await state.storage.setAlarm(Date.now() + 60_000);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await expect(stub.getClient(Date.now())).resolves.toBeNull();
  });
});

describe("II-approved duration and OAuth refresh", () => {
  const hour = 60 * 60 * 1000;

  async function approvedSession(id: string, lifetime = II_SESSION_TTL_MS, cap = II_SESSION_TTL_MS) {
    const now = Date.now(), verifier = "t".repeat(43);
    const stub = env.MCP_AUTH_STATE.getByName(`session:${id}`);
    const input = { ...await session(id, verifier, now, now + cap), scope: "mcp:read" };
    await stub.createSession(input);
    await stub.claimConnect("connect-state", `${id}.cookie`, now);
    const completed = await stub.completeConnect(now + lifetime, "queries", now, id);
    const issued = await stub.exchangeCode({ code: completed!.code, clientId: "client", redirectUri: "https://chatgpt.com/callback", codeVerifier: verifier, issueRefreshToken: true, now });
    expect(issued?.refreshToken).toBeTruthy();
    return { stub, issued: issued!, now };
  }

  it.each([10 * 60_000, REVIEW_SESSION_TTL_MS, II_SESSION_TTL_MS, II_SESSION_TTL_MS + hour])(
    "honors an II grant of %i ms without extending it", async lifetime => {
      const { stub, issued, now } = await approvedSession(`duration-${lifetime}`, lifetime, II_SESSION_TTL_MS + hour);
      expect(issued.sessionExpiresAt).toBe(now + Math.min(lifetime, II_SESSION_TTL_MS));
      expect(issued.accessExpiresAt).toBe(now + Math.min(lifetime, hour));
      expect(await stub.validateAccessToken(issued.accessToken, resource, issued.accessExpiresAt - 1)).not.toBeNull();
      expect(await stub.validateAccessToken(issued.accessToken, resource, issued.accessExpiresAt)).toBeNull();
    }
  );

  it("preserves the eight-hour cap of an existing session", async () => {
    const { issued, now } = await approvedSession("legacy-cap", II_SESSION_TTL_MS, REVIEW_SESSION_TTL_MS);
    expect(issued.sessionExpiresAt).toBe(now + REVIEW_SESSION_TTL_MS);
  });

  it("renews hourly for thirty days and rejects renewal at the approved expiry", async () => {
    const { stub, issued: first, now } = await approvedSession("thirty-day-renewal");
    let issued = first;
    for (let n = 1; n < 30 * 24; n++) {
      const at = now + n * hour;
      expect(await stub.validateAccessToken(issued.accessToken, resource, at)).toBeNull();
      const next = await stub.rotateRefreshToken({ refreshToken: issued.refreshToken!, clientId: "client", resource, now: at });
      expect(next).not.toBeNull();
      issued = next!;
      expect(issued.sessionExpiresAt).toBe(now + II_SESSION_TTL_MS);
      expect(issued.accessExpiresAt).toBe(at + hour);
      expect(issued.scope).toBe("mcp:read");
    }
    expect(await stub.rotateRefreshToken({ refreshToken: issued.refreshToken!, clientId: "client", resource, now: now + II_SESSION_TTL_MS })).toBeNull();
  }, 30_000);

  it("stores 4096 real replay hashes, detects the oldest replay, and bounds refresh work", async () => {
    const { stub, issued: first, now } = await approvedSession("full-replay-history");
    let issued = first;
    const samples: number[] = [];
    for (let n = 0; n < MAX_REFRESH_ROTATIONS; n++) {
      const started = performance.now();
      const next = await stub.rotateRefreshToken({ refreshToken: issued.refreshToken!, clientId: "client", resource, now: now + n });
      expect(next).not.toBeNull();
      samples.push(performance.now() - started);
      issued = next!;
    }
    const stored = await runInDurableObject(stub, async (_instance, state) => {
      const record = await state.storage.get<AuthStateRecordV5>("record");
      if (record?.kind !== "authorization_session") throw new Error("missing session");
      return { hashes: record.spentRefreshTokenHashes, bytes: new TextEncoder().encode(JSON.stringify(record)).byteLength };
    });
    expect(stored.hashes).toHaveLength(MAX_REFRESH_ROTATIONS);
    expect(stored.hashes.every(hash => /^[A-Za-z0-9_-]{43}$/u.test(hash))).toBe(true);
    expect(stored.hashes[0]).toBe(await sha256(first.refreshToken!));
    expect(stored.bytes).toBeLessThan(256 * 1024);
    console.info(JSON.stringify({ event: "oauth_refresh_benchmark", rotations: MAX_REFRESH_ROTATIONS, recordBytes: stored.bytes,
      meanWallMs: samples.reduce((a, b) => a + b, 0) / samples.length,
      first64MeanWallMs: samples.slice(0, 64).reduce((a, b) => a + b, 0) / 64,
      last64MeanWallMs: samples.slice(-64).reduce((a, b) => a + b, 0) / 64 }));
    expect(await stub.rotateRefreshToken({ refreshToken: first.refreshToken!, clientId: "client", resource, now })).toBeNull();
    expect(await stub.validateAccessToken(issued.accessToken, resource, now)).toBeNull();

    const capped = await approvedSession("replay-history-cap");
    await runInDurableObject(capped.stub, async (_instance, state) => {
      const record = await state.storage.get<AuthStateRecordV5>("record");
      if (record?.kind !== "authorization_session") throw new Error("missing session");
      record.spentRefreshTokenHashes = stored.hashes;
      await state.storage.put("record", record);
    });
    expect(await capped.stub.rotateRefreshToken({ refreshToken: capped.issued.refreshToken!, clientId: "client", resource, now: capped.now })).toBeNull();
    expect(await capped.stub.validateAccessToken(capped.issued.accessToken, resource, capped.now)).toBeNull();
  }, 60_000);

  it("revokes a replayed concurrent refresh without affecting another session", async () => {
    const a = await approvedSession("concurrent-a"), b = await approvedSession("concurrent-b");
    const results = await Promise.all([1, 2].map(() => a.stub.rotateRefreshToken({ refreshToken: a.issued.refreshToken!, clientId: "client", resource, now: a.now })));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await a.stub.validateAccessToken(results.find(Boolean)!.accessToken, resource, a.now)).toBeNull();
    expect(await b.stub.validateAccessToken(b.issued.accessToken, resource, b.now)).not.toBeNull();
  });

  const cases = ["internet_identity", "review_service"].flatMap(source =>
    [true, false].flatMap(offline => [true, false].flatMap(supports =>
      [undefined, "mcp:read", "mcp:read offline_access", "mcp:read mcp:write offline_access"].map(exchangeScope => ({ source, offline, supports, exchangeScope })))));
  it.each(cases)("uses stored consent without widening scopes (%j)", async ({ source, offline, supports, exchangeScope }) => {
    const response = await register(["https://chatgpt.com/callback"], "none", undefined, supports ? ["authorization_code", "refresh_token"] : ["authorization_code"]);
    const client = await response.json<{ client_id: string }>();
    const now = Date.now(), id = `matrix-${client.client_id.slice(5)}`, verifier = "c".repeat(43);
    const stub = env.MCP_AUTH_STATE.getByName(`session:${id}`);
    const scope = offline ? "mcp:read offline_access" : "mcp:read";
    await stub.createSession({ ...await session(id, verifier, now, now + II_SESSION_TTL_MS), clientId: client.client_id, scope });
    await stub.claimConnect("connect-state", `${id}.cookie`, now);
    const completed = source === "internet_identity"
      ? await stub.completeConnect(now + II_SESSION_TTL_MS, "queries", now, id)
      : await stub.completeReviewConnect("review-v1", now, id);
    const form = new URLSearchParams({ grant_type: "authorization_code", client_id: client.client_id, code: completed!.code,
      redirect_uri: "https://chatgpt.com/callback", code_verifier: verifier });
    if (exchangeScope !== undefined) form.set("scope", exchangeScope);
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const issued = await handleAuthRoute(new Request(`${origin}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form.toString() }), env);
      expect(issued!.status).toBe(200);
      const tokens = await issued!.json<{ refresh_token?: string; scope: string; expires_in: number; access_token: string }>();
      const expected = supports && (source === "internet_identity" || (offline && exchangeScope?.split(" ").includes("offline_access") !== false));
      expect(Boolean(tokens.refresh_token)).toBe(expected);
      expect(tokens.scope).toBe(scope);
      expect(tokens.expires_in).toBeLessThanOrEqual(3600);
      const diagnostic = JSON.parse(logs.mock.calls.at(-1)![0] as string);
      expect(diagnostic).toEqual({ event: "mcp_oauth", stage: "authorization_code", clientSupportsRefresh: supports,
        outcome: "issued", refreshIssued: expected, offlineAccessGranted: offline });
      expect(JSON.stringify(diagnostic)).not.toContain(client.client_id);
      expect(JSON.stringify(diagnostic)).not.toContain(tokens.access_token);
    } finally { logs.mockRestore(); }
    if (source === "review_service") await runInDurableObject(stub, async (_instance, state) => {
      const record = await state.storage.get<AuthStateRecordV5>("record");
      if (record?.kind !== "authorization_session") throw new Error("missing session");
      expect(record.sessionExpiresAt).toBe(now + REVIEW_SESSION_TTL_MS);
    });
  });

  it("keeps omitted DCR grant_types code-only and rejects unsupported refresh", async () => {
    const registered = await register(["https://chatgpt.com/callback"], "none", undefined, null);
    const client = await registered.json<{ client_id: string; grant_types: string[] }>();
    expect(client.grant_types).toEqual(["authorization_code"]);
    const response = await fetchWorker(`${origin}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: client.client_id, refresh_token: "mkr1.unknown.token" }).toString() });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "unauthorized_client" });
  });

  it("refreshes through the HTTP route without adding requested write scope", async () => {
    const registered = await register(["https://chatgpt.com/callback"]);
    const { client_id: clientId } = await registered.json<{ client_id: string }>();
    const now = Date.now(), id = "http-rotation", verifier = "h".repeat(43);
    const stub = env.MCP_AUTH_STATE.getByName(`session:${id}`);
    await stub.createSession({ ...await session(id, verifier, now, now + II_SESSION_TTL_MS), clientId, scope: "mcp:read" });
    await stub.claimConnect("connect-state", `${id}.cookie`, now);
    const completed = await stub.completeConnect(now + II_SESSION_TTL_MS, "queries", now, id);
    const first = await stub.exchangeCode({ code: completed!.code, clientId, redirectUri: "https://chatgpt.com/callback", codeVerifier: verifier, issueRefreshToken: true, now });
    const refresh = (refreshToken: string) => fetchWorker(`${origin}/oauth/token`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: clientId, resource, refresh_token: refreshToken, scope: "mcp:read mcp:write" }).toString()
    });
    const response = await refresh(first!.refreshToken!);
    expect(response.status).toBe(200);
    const next = await response.json<{ access_token: string; refresh_token: string; scope: string; expires_in: number }>();
    expect(next.scope).toBe("mcp:read");
    expect(next.refresh_token).not.toBe(first!.refreshToken);
    expect(next.expires_in).toBeLessThanOrEqual(3600);
    expect(await stub.validateAccessToken(next.access_token, resource, now)).toMatchObject({ scope: "mcp:read", actionPermission: "queries" });
    expect((await refresh(first!.refreshToken!)).status).toBe(400);
    expect(await stub.validateAccessToken(next.access_token, resource, now)).toBeNull();
  });
});

let registrationAddressSequence = 1;

async function register(
  redirectUris: string[],
  tokenEndpointAuthMethod: "none" | "client_secret_basic" | "client_secret_post" = "none",
  clientAddress = `198.51.100.${registrationAddressSequence++}`,
  grantTypes: string[] | null = ["authorization_code", "refresh_token"]
) {
  return fetchWorker(`${origin}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": clientAddress },
    body: JSON.stringify({
      redirect_uris: redirectUris,
      ...(grantTypes === null ? {} : { grant_types: grantTypes }),
      token_endpoint_auth_method: tokenEndpointAuthMethod
    })
  });
}

async function authorizationUrl(clientId: string, verifier: string): Promise<string> {
  const url = new URL(`${origin}/oauth/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: "https://chatgpt.com/connector/oauth/callback",
    state: "client-state",
    resource,
    scope: "mcp:read mcp:write offline_access",
    code_challenge: "",
    code_challenge_method: "S256"
  }).toString();
  url.searchParams.set("code_challenge", await sha256(verifier));
  return url.toString();
}

function cookieFrom(response: Response): string {
  const header = response.headers.get("set-cookie");
  if (!header) throw new Error("authorization cookie is missing");
  return header.split(";", 1)[0];
}

function connectStateFrom(html: string): string {
  const match = html.match(/name="connect_state" value="([A-Za-z0-9_-]+)"/u);
  if (!match) throw new Error("connect state is missing");
  return match[1];
}

async function session(
  sessionId: string,
  verifier: string,
  now = Date.now(),
  sessionCapAt = now + 60_000,
  connectExpiresAt = now + 60_000
): Promise<AuthorizationSessionInput> {
  return {
    sessionId,
    clientId: "client",
    redirectUri: "https://chatgpt.com/callback",
    oauthState: "oauth-state",
    scope: "mcp:read offline_access",
    resource,
    codeChallenge: await sha256(verifier),
    connectStateHash: await sha256("connect-state"),
    cookieHash: await sha256(`${sessionId}.cookie`),
    registrationPublicKey: "registration-public-key",
    registrationKey: encryptedValue,
    sessionKey: encryptedValue,
    createdAt: now,
    sessionCapAt,
    connectExpiresAt
  };
}

function alarmTime(stub: DurableObjectStub<McpAuthStateV5>) {
  return runInDurableObject(stub, async (_instance, state) => state.storage.getAlarm());
}

function fetchWorker(input: string, init?: RequestInit): Promise<Response> {
  return SELF.fetch(input, init);
}
