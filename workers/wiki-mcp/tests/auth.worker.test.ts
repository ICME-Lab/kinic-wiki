import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { sha256 } from "../src/auth/crypto.js";
import type { PendingSessionInput } from "../src/auth/state.js";

const origin = "https://wiki-mcp-staging.kinic.xyz";
const resource = `${origin}/mcp`;
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
      scopes_supported: ["mcp:read", "offline_access"]
    });

    const server = await fetchWorker(`${origin}/.well-known/oauth-authorization-server`);
    await expect(server.json()).resolves.toMatchObject({
      issuer: origin,
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"]
    });
  });

  it("requires a bearer token on staging MCP", async () => {
    const response = await fetchWorker(`${origin}/mcp`, { method: "POST" });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("/.well-known/oauth-protected-resource/mcp");
  });

  it("serves safe callback messages without embedding connection data", async () => {
    const response = await fetchWorker(`${origin}/mcp/connect`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("read_only_required");
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

describe("McpAuthState single-use records", () => {
  it("atomically consumes state and authorization code", async () => {
    const verifier = "b".repeat(43);
    const stub = env.MCP_AUTH_STATE.getByName("session:single-use");
    await stub.createSession(await session("single-use", verifier));
    const claims = await Promise.all([
      stub.claimConnect("connect-state", "single-use.cookie", Date.now()),
      stub.claimConnect("connect-state", "single-use.cookie", Date.now())
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);

    const completed = await stub.completeConnect(Date.now() + 60_000, Date.now(), "single-use");
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
      stub.exchangeCode({
        code: completed!.code,
        clientId: "client",
        redirectUri: "https://chatgpt.com/callback",
        codeVerifier: verifier,
        issueRefreshToken: true,
        now: Date.now()
      })
    ).resolves.toBeNull();
  });

  it("rejects a missing cookie, mismatched state, wrong verifier, and expired code", async () => {
    const verifier = "e".repeat(43);
    const stub = env.MCP_AUTH_STATE.getByName("session:negative");
    await stub.createSession(await session("negative", verifier));
    await expect(stub.claimConnect("wrong", "negative.cookie", Date.now())).resolves.toBeNull();
    await expect(stub.claimConnect("connect-state", "wrong", Date.now())).resolves.toBeNull();
    await stub.claimConnect("connect-state", "negative.cookie", Date.now());
    const completed = await stub.completeConnect(Date.now() + 60_000, Date.now(), "negative");
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
    await expect(
      stub.exchangeCode({
        code: completed!.code,
        clientId: "client",
        redirectUri: "https://chatgpt.com/callback",
        codeVerifier: verifier,
        issueRefreshToken: true,
        now: Date.now() + 120_000
      })
    ).resolves.toBeNull();
  });

  it("cannot complete a connection after the session is invalidated", async () => {
    const stub = env.MCP_AUTH_STATE.getByName("session:invalidated");
    await stub.createSession(await session("invalidated", "g".repeat(43)));
    await stub.claimConnect("connect-state", "invalidated.cookie", Date.now());
    await stub.invalidate();

    await expect(stub.completeConnect(Date.now() + 60_000, Date.now(), "invalidated")).resolves.toBeNull();
  });

  it("rotates refresh tokens and rejects reuse or another resource", async () => {
    const verifier = "c".repeat(43);
    const stub = env.MCP_AUTH_STATE.getByName("session:refresh");
    await stub.createSession(await session("refresh", verifier));
    await stub.claimConnect("connect-state", "refresh.cookie", Date.now());
    const completed = await stub.completeConnect(Date.now() + 60_000, Date.now(), "refresh");
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
        refreshToken: issued!.refreshToken!,
        clientId: "client",
        resource,
        now: Date.now()
      })
    ).resolves.toBeNull();
    await expect(
      stub.rotateRefreshToken({
        refreshToken: rotated!.refreshToken!,
        clientId: "client",
        resource: `${origin}/other`,
        now: Date.now()
      })
    ).resolves.toBeNull();
  });

  it("deletes expired records with an alarm", async () => {
    const stub = env.MCP_AUTH_STATE.getByName("session:expired");
    await stub.createSession(await session("expired", "d".repeat(43)));
    await runInDurableObject(stub, async (_instance, state) => {
      const record = await state.storage.get<Record<string, unknown>>("record");
      await state.storage.put("record", { ...record, expiresAt: Date.now() - 1 });
      await state.storage.setAlarm(Date.now() + 60_000);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await expect(stub.claimConnect("connect-state", "expired.cookie", Date.now())).resolves.toBeNull();
  });
});

async function register(
  redirectUris: string[],
  tokenEndpointAuthMethod: "none" | "client_secret_basic" | "client_secret_post" = "none"
) {
  return fetchWorker(`${origin}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      redirect_uris: redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      token_endpoint_auth_method: tokenEndpointAuthMethod
    })
  });
}

async function session(sessionId: string, verifier: string, expiresAt = Date.now() + 60_000): Promise<PendingSessionInput> {
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
    createdAt: Date.now(),
    sessionCapAt: Date.now() + 60_000,
    expiresAt
  };
}

function fetchWorker(input: string, init?: RequestInit): Promise<Response> {
  return SELF.fetch(input, init);
}
