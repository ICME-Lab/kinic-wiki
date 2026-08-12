import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { DelegationChain } from "@icp-sdk/core/identity";
import { describe, expect, it } from "vitest";
import { encryptJson, sha256 } from "../src/auth/crypto.js";
import { generateIiKey, type KinicDelegationMaterialV1 } from "../src/auth/internet-identity.js";
import {
  DELEGATION_REFRESH_MARGIN_MS,
  OAUTH_CLIENT_IDLE_TTL_MS,
  SingleFlight,
  delegationContext,
  delegationNeedsRefresh,
  sessionKeyContext,
  type AuthorizationSessionInput,
  type AuthStateRecordV4,
  type McpAuthStateV4,
  type OAuthClientRecordV2
} from "../src/auth/state.js";

const origin = "https://wiki-mcp-staging.kinic.xyz";
const resource = `${origin}/mcp`;
const encryptionKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const encryptedValue = {
  version: 1 as const,
  algorithm: "AES-GCM" as const,
  iv: "AAAAAAAAAAAAAAAA",
  ciphertext: "AA"
};

describe("staging OAuth discovery and registration", () => {
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
    expect(started.status).toBe(302);
    expect(started.headers.get("location")).toMatch(/^https:\/\/id\.ai\/mcp#/u);
    expect(started.headers.get("set-cookie")).toContain("HttpOnly");
    expect(started.headers.get("set-cookie")).toContain("SameSite=Lax");

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
});

describe("McpAuthStateV4 single-use records", () => {
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
      const record = (await state.storage.get<AuthStateRecordV4>("record"))!;
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
      const record = (await state.storage.get<AuthStateRecordV4>("record"))!;
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
      iiPermission: "queries"
    });
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

  it("invalidates a session after sixty-four refresh rotations", async () => {
    const verifier = "j".repeat(43);
    const stub = env.MCP_AUTH_STATE.getByName("session:refresh-limit");
    await stub.createSession(await session("refresh-limit", verifier, Date.now(), Date.now() + 60_000));
    await stub.claimConnect("connect-state", "refresh-limit.cookie", Date.now());
    const completed = await stub.completeConnect(Date.now() + 60_000, "all", Date.now(), "refresh-limit");
    let issued = await stub.exchangeCode({
      code: completed!.code,
      clientId: "client",
      redirectUri: "https://chatgpt.com/callback",
      codeVerifier: verifier,
      issueRefreshToken: true,
      now: Date.now()
    });
    for (let generation = 0; generation < 64; generation += 1) {
      issued = await stub.rotateRefreshToken({
        refreshToken: issued!.refreshToken!,
        clientId: "client",
        resource,
        now: Date.now()
      });
      expect(issued).not.toBeNull();
    }
    const lastAccessToken = issued!.accessToken;
    await expect(
      stub.rotateRefreshToken({
        refreshToken: issued!.refreshToken!,
        clientId: "client",
        resource,
        now: Date.now()
      })
    ).resolves.toBeNull();
    await expect(stub.validateAccessToken(lastAccessToken, resource, Date.now())).resolves.toBeNull();
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

let registrationAddressSequence = 1;

async function register(
  redirectUris: string[],
  tokenEndpointAuthMethod: "none" | "client_secret_basic" | "client_secret_post" = "none",
  clientAddress = `198.51.100.${registrationAddressSequence++}`
) {
  return fetchWorker(`${origin}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": clientAddress },
    body: JSON.stringify({
      redirect_uris: redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      token_endpoint_auth_method: tokenEndpointAuthMethod
    })
  });
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
    registrationKey: encryptedValue,
    sessionKey: encryptedValue,
    createdAt: now,
    sessionCapAt,
    connectExpiresAt
  };
}

function alarmTime(stub: DurableObjectStub<McpAuthStateV4>) {
  return runInDurableObject(stub, async (_instance, state) => state.storage.getAlarm());
}

function fetchWorker(input: string, init?: RequestInit): Promise<Response> {
  return SELF.fetch(input, init);
}
