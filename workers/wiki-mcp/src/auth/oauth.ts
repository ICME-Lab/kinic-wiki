import type { Identity } from "@icp-sdk/core/agent";
import type { JsonnableEd25519KeyIdentity } from "@icp-sdk/core/identity";
import type { RuntimeEnv } from "../vfs.js";
import {
  base64UrlEncode,
  decryptJson,
  encryptJson,
  randomOpaque,
  secretEquals,
  sha256
} from "./crypto.js";
import {
  generateIiKey,
  IiRegistrationError,
  IiSessionEndedError,
  INTERNET_IDENTITY_ORIGIN,
  mintKinicIdentity,
  redeemRegistration,
  restoreIiKey
} from "./internet-identity.js";
import type { ClientAuthMethod, McpAuthState, OAuthClientRecordV1, PendingSessionInput } from "./state.js";

export const STAGING_MCP_RESOURCE = "https://wiki-mcp-staging.kinic.xyz/mcp";
const STAGING_ORIGIN = "https://wiki-mcp-staging.kinic.xyz";
const CALLBACK_PATH = "/mcp/connect";
const CLIENT_PREFIX = "mcl1.";
const COOKIE_NAME = "__Host-kinic-mcp-connect";
const SESSION_CAP_MS = 8 * 60 * 60 * 1000;
const CONNECT_TTL_MS = 10 * 60 * 1000;
const CLIENT_SECRET_TTL_SECONDS = 0;
const MAX_AUTH_BODY_BYTES = 16_384;
const ALLOWED_SCOPES = new Set(["mcp:read", "offline_access"]);

type OAuthClientRegistrationRequest = {
  redirect_uris?: unknown;
  grant_types?: unknown;
  token_endpoint_auth_method?: unknown;
  client_name?: unknown;
};

export type AuthenticationMode = "disabled" | "required" | "misconfigured" | "origin_mismatch";

export function authenticationMode(request: Request, env: RuntimeEnv): AuthenticationMode {
  if (env.MCP_AUTH_ENABLED !== "true") {
    return "disabled";
  }
  const configuredOrigin = env.MCP_PUBLIC_ORIGIN?.trim();
  if (configuredOrigin !== STAGING_ORIGIN) {
    return "misconfigured";
  }
  return new URL(request.url).origin === configuredOrigin ? "required" : "origin_mismatch";
}

export function authenticationBoundaryResponse(mode: AuthenticationMode): Response | null {
  if (mode === "misconfigured") {
    return json({ error: "temporarily_unavailable" }, 503, { "cache-control": "no-store" });
  }
  if (mode === "origin_mismatch") {
    return json({ error: "not found" }, 404, { "cache-control": "no-store" });
  }
  return null;
}

export async function handleAuthRoute(request: Request, env: RuntimeEnv): Promise<Response | null> {
  if (authenticationMode(request, env) !== "required") {
    return null;
  }
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/.well-known/oauth-protected-resource/mcp") {
    return json(protectedResourceMetadata());
  }
  if (request.method === "GET" && url.pathname === "/.well-known/oauth-authorization-server") {
    return json(authorizationServerMetadata());
  }
  if (request.method === "GET" && url.pathname === "/.well-known/ii-auth-callbacks") {
    return json(
      { callbacks: [`${STAGING_ORIGIN}${CALLBACK_PATH}`] },
      200,
      { "access-control-allow-origin": INTERNET_IDENTITY_ORIGIN, "cache-control": "no-store" }
    );
  }
  if (request.method === "POST" && url.pathname === "/oauth/register") {
    return registerClient(request, env);
  }
  if (request.method === "GET" && url.pathname === "/oauth/authorize") {
    return authorize(request, env);
  }
  if (url.pathname === CALLBACK_PATH && request.method === "GET") {
    return connectPage();
  }
  if (url.pathname === CALLBACK_PATH && request.method === "POST") {
    return completeConnect(request, env);
  }
  if (url.pathname === "/oauth/token" && request.method === "POST") {
    return token(request, env);
  }
  return null;
}

export async function authenticateMcpRequest(
  request: Request,
  env: RuntimeEnv
): Promise<{ identity: Identity } | { response: Response }> {
  const resourceMetadata = `${STAGING_ORIGIN}/.well-known/oauth-protected-resource/mcp`;
  const unauthorized = () =>
    json(
      { error: "invalid_token" },
      401,
      { "www-authenticate": `Bearer resource_metadata="${resourceMetadata}", error="invalid_token"` }
    );
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return { response: unauthorized() };
  }
  const tokenValue = authorization.slice(7);
  const sessionId = parseRoutedToken(tokenValue, "mka1");
  if (!sessionId) {
    return { response: unauthorized() };
  }
  const stub = authNamespace(env).getByName(sessionName(sessionId));
  const validated = await stub.validateAccessToken(tokenValue, STAGING_MCP_RESOURCE, Date.now());
  if (!validated) {
    return { response: unauthorized() };
  }
  let keyJson: JsonnableEd25519KeyIdentity;
  try {
    keyJson = await decryptJson<JsonnableEd25519KeyIdentity>(
      validated.encryptedSessionKey,
      encryptionKey(env),
      sessionKeyContext(sessionId)
    );
  } catch {
    await stub.invalidate();
    return { response: unauthorized() };
  }
  try {
    const identity = await mintKinicIdentity(restoreIiKey(keyJson));
    return { identity };
  } catch (error) {
    if (error instanceof IiSessionEndedError) {
      await stub.invalidate();
      return { response: unauthorized() };
    }
    return { response: json({ error: "temporarily_unavailable" }, 503) };
  }
}

export function mcpUnauthorizedResponse(): Response {
  return json(
    { error: "unauthorized" },
    401,
    {
      "www-authenticate": `Bearer resource_metadata="${STAGING_ORIGIN}/.well-known/oauth-protected-resource/mcp"`
    }
  );
}

function protectedResourceMetadata() {
  return {
    resource: STAGING_MCP_RESOURCE,
    authorization_servers: [STAGING_ORIGIN],
    scopes_supported: ["mcp:read", "offline_access"],
    bearer_methods_supported: ["header"]
  };
}

function authorizationServerMetadata() {
  return {
    issuer: STAGING_ORIGIN,
    authorization_endpoint: `${STAGING_ORIGIN}/oauth/authorize`,
    token_endpoint: `${STAGING_ORIGIN}/oauth/token`,
    registration_endpoint: `${STAGING_ORIGIN}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"],
    scopes_supported: ["mcp:read", "offline_access"]
  };
}

async function registerClient(request: Request, env: RuntimeEnv): Promise<Response> {
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    return oauthJsonError("invalid_client_metadata", 400);
  }
  const body = await limitedJson<OAuthClientRegistrationRequest>(request);
  if (!body) {
    return oauthJsonError("invalid_client_metadata", 400);
  }
  const redirectUris = stringArray(body.redirect_uris);
  if (!redirectUris?.length || !redirectUris.every(isAllowedRedirectUri)) {
    return oauthJsonError("invalid_redirect_uri", 400);
  }
  const requestedGrantTypes = stringArray(body.grant_types) ?? ["authorization_code"];
  const grantTypes = requestedGrantTypes.filter(
    (value): value is "authorization_code" | "refresh_token" =>
      value === "authorization_code" || value === "refresh_token"
  );
  if (!grantTypes.includes("authorization_code")) {
    return oauthJsonError("invalid_client_metadata", 400);
  }
  const authMethod = (body.token_endpoint_auth_method ?? "none") as ClientAuthMethod;
  if (!["none", "client_secret_basic", "client_secret_post"].includes(authMethod)) {
    return oauthJsonError("invalid_client_metadata", 400);
  }
  const clientId = `${CLIENT_PREFIX}${randomOpaque(18)}`;
  const clientSecret = authMethod === "none" ? null : randomOpaque();
  const record: OAuthClientRecordV1 = {
    version: 1,
    kind: "oauth_client",
    clientId,
    redirectUris,
    grantTypes: [...new Set(grantTypes)],
    tokenEndpointAuthMethod: authMethod,
    clientSecretHash: clientSecret ? await sha256(clientSecret) : null,
    createdAt: Date.now()
  };
  const created = await authNamespace(env).getByName(clientName(clientId)).createClient(record);
  if (!created) {
    return oauthJsonError("server_error", 500);
  }
  return json(
    {
      client_id: clientId,
      client_id_issued_at: Math.floor(record.createdAt / 1000),
      ...(clientSecret
        ? {
            client_secret: clientSecret,
            client_secret_expires_at: CLIENT_SECRET_TTL_SECONDS
          }
        : {}),
      redirect_uris: redirectUris,
      grant_types: record.grantTypes,
      response_types: ["code"],
      token_endpoint_auth_method: authMethod,
      client_name: typeof body.client_name === "string" ? body.client_name.slice(0, 100) : undefined
    },
    201,
    { "cache-control": "no-store" }
  );
}

async function authorize(request: Request, env: RuntimeEnv): Promise<Response> {
  const url = new URL(request.url);
  const clientId = url.searchParams.get("client_id");
  const redirectUri = url.searchParams.get("redirect_uri");
  const oauthState = url.searchParams.get("state");
  const resource = url.searchParams.get("resource");
  const scope = normalizeScope(url.searchParams.get("scope"));
  const codeChallenge = url.searchParams.get("code_challenge");
  if (
    url.searchParams.get("response_type") !== "code" ||
    !clientId ||
    !redirectUri ||
    !oauthState ||
    resource !== STAGING_MCP_RESOURCE ||
    !scope ||
    !codeChallenge ||
    url.searchParams.get("code_challenge_method") !== "S256" ||
    !/^[A-Za-z0-9_-]{43}$/u.test(codeChallenge)
  ) {
    return oauthJsonError("invalid_request", 400);
  }
  const client = await getClient(env, clientId);
  if (!client) {
    return oauthJsonError("invalid_client", 400);
  }
  if (!client.redirectUris.includes(redirectUri)) {
    return oauthJsonError("invalid_request", 400);
  }
  const now = Date.now();
  const sessionId = randomOpaque(18);
  const cookieSecret = randomOpaque();
  const cookieValue = `${sessionId}.${cookieSecret}`;
  const connectState = randomOpaque();
  const registrationKey = generateIiKey();
  const sessionKey = generateIiKey();
  const key = encryptionKey(env);
  const input: PendingSessionInput = {
    sessionId,
    clientId,
    redirectUri,
    oauthState,
    scope,
    resource,
    codeChallenge,
    connectStateHash: await sha256(connectState),
    cookieHash: await sha256(cookieValue),
    registrationKey: await encryptJson(registrationKey.toJSON(), key, registrationKeyContext(sessionId)),
    sessionKey: await encryptJson(sessionKey.toJSON(), key, sessionKeyContext(sessionId)),
    createdAt: now,
    sessionCapAt: now + SESSION_CAP_MS,
    expiresAt: now + CONNECT_TTL_MS
  };
  const created = await authNamespace(env).getByName(sessionName(sessionId)).createSession(input);
  if (!created) {
    return oauthJsonError("server_error", 500);
  }
  const iiUrl = new URL("/mcp", INTERNET_IDENTITY_ORIGIN);
  const fragment = new URLSearchParams({
    registration_key: base64UrlEncode(new Uint8Array(registrationKey.getPublicKey().toDer())),
    callback: `${STAGING_ORIGIN}${CALLBACK_PATH}`,
    state: connectState,
    ttl: String(SESSION_CAP_MS / 1000)
  });
  iiUrl.hash = fragment.toString();
  return new Response(null, {
    status: 302,
    headers: {
      location: iiUrl.toString(),
      "set-cookie": `${COOKIE_NAME}=${cookieValue}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
      "cache-control": "no-store"
    }
  });
}

function connectPage(): Response {
  const html = `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Connecting Kinic Wiki</title><body><p id="status">Completing secure connection…</p>
<script>
(() => {
  const messages = {
    invalid_connection: "Connection data is invalid or expired. Start again from your AI client.",
    registration_rejected: "Internet Identity rejected this connection. Check the trusted connector and reconnect.",
    read_only_required: "Reconnect and keep Internet Identity read-only access enabled.",
    temporarily_unavailable: "Internet Identity is temporarily unavailable. Start a fresh connection and try again."
  };
  const status = document.querySelector("#status");
  const p = new URLSearchParams(location.hash.slice(1));
  const delegation = p.get("delegation");
  const state = p.get("state");
  history.replaceState(null, "", location.pathname + location.search);
  if (!delegation || !state) { status.textContent = "Connection data is missing."; return; }
  fetch(location.pathname, {
    method: "POST",
    credentials: "same-origin",
    headers: {"content-type": "application/json"},
    body: JSON.stringify({delegation, state})
  }).then(async (response) => {
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.redirect_uri) {
      status.textContent = messages[body.error] || "Connection failed. Start again from your AI client.";
      return;
    }
    location.replace(body.redirect_uri);
  }).catch(() => { status.textContent = "Connection failed. Start again from your AI client."; });
})();
</script></body></html>`;
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'; style-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
      "cache-control": "no-store"
    }
  });
}

async function completeConnect(request: Request, env: RuntimeEnv): Promise<Response> {
  const traceId = crypto.randomUUID();
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    return connectFailureResponse(traceId, "request_validation", "invalid_connection", 400);
  }
  const body = await limitedJson<{ delegation?: unknown; state?: unknown }>(request);
  const cookieValue = readCookie(request.headers.get("cookie"), COOKIE_NAME);
  if (!body || typeof body.delegation !== "string" || typeof body.state !== "string" || !cookieValue) {
    return connectFailureResponse(traceId, "request_validation", "invalid_connection", 400);
  }
  const sessionId = cookieValue.split(".", 1)[0];
  if (!sessionId || !/^[A-Za-z0-9_-]+$/u.test(sessionId)) {
    return connectFailureResponse(traceId, "request_validation", "invalid_connection", 400);
  }
  const stub = authNamespace(env).getByName(sessionName(sessionId));
  const pending = await stub.claimConnect(body.state, cookieValue, Date.now());
  if (!pending || pending.sessionId !== sessionId) {
    return connectFailureResponse(traceId, "initiator_binding", "invalid_connection", 400);
  }
  let registrationKey: ReturnType<typeof restoreIiKey>;
  let sessionKey: ReturnType<typeof restoreIiKey>;
  try {
    const key = encryptionKey(env);
    if (!pending.registrationKey) {
      throw new Error("registration key is unavailable");
    }
    registrationKey = restoreIiKey(
      await decryptJson<JsonnableEd25519KeyIdentity>(
        pending.registrationKey,
        key,
        registrationKeyContext(sessionId)
      )
    );
    sessionKey = restoreIiKey(
      await decryptJson<JsonnableEd25519KeyIdentity>(pending.sessionKey, key, sessionKeyContext(sessionId))
    );
  } catch {
    await stub.invalidate();
    return connectFailureResponse(traceId, "local_key_restore", "invalid_connection", 400);
  }
  let registered: Awaited<ReturnType<typeof redeemRegistration>>;
  try {
    registered = await redeemRegistration(registrationKey, sessionKey, body.delegation);
  } catch (error) {
    await stub.invalidate();
    return registrationFailureResponse(traceId, error);
  }
  const completed = await stub.completeConnect(registered.grantExpiresAt, Date.now(), sessionId);
  if (!completed) {
    await stub.invalidate();
    return connectFailureResponse(traceId, "authorization_completion", "invalid_connection", 400);
  }
  logConnect("info", traceId, "registration_redeemed", "registration_redeemed", 200);
  const redirect = new URL(completed.redirectUri);
  redirect.searchParams.set("code", completed.code);
  redirect.searchParams.set("state", completed.oauthState);
  return json(
    { redirect_uri: redirect.toString() },
    200,
    {
      "set-cookie": `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
      "cache-control": "no-store"
    }
  );
}

type ConnectFailure = {
  error: "invalid_connection" | "registration_rejected" | "read_only_required" | "temporarily_unavailable";
  stage: string;
  status: 400 | 401 | 403 | 503;
  errorDescription?: string;
};

export function classifyRegistrationFailure(error: unknown): ConnectFailure {
  if (!(error instanceof IiRegistrationError)) {
    return {
      error: "temporarily_unavailable",
      stage: "registration_unknown",
      status: 503,
      errorDescription: "Internet Identity is temporarily unavailable."
    };
  }
  if (error.code === "invalid_delegation") {
    return { error: "invalid_connection", stage: error.stage, status: 400 };
  }
  if (error.code === "registration_rejected") {
    return {
      error: "registration_rejected",
      stage: error.stage,
      status: 401,
      errorDescription: "Internet Identity rejected this connection."
    };
  }
  if (error.code === "read_only_required") {
    return {
      error: "read_only_required",
      stage: error.stage,
      status: 403,
      errorDescription: "Reconnect with Internet Identity read-only access enabled."
    };
  }
  return {
    error: "temporarily_unavailable",
    stage: error.stage,
    status: 503,
    errorDescription: "Internet Identity is temporarily unavailable."
  };
}

function registrationFailureResponse(traceId: string, error: unknown): Response {
  const failure = classifyRegistrationFailure(error);
  return connectFailureResponse(
    traceId,
    failure.stage,
    failure.error,
    failure.status,
    failure.errorDescription
  );
}

function connectFailureResponse(
  traceId: string,
  stage: string,
  error: ConnectFailure["error"],
  status: ConnectFailure["status"],
  errorDescription?: string
): Response {
  logConnect("error", traceId, stage, error, status);
  return json(
    { error, ...(errorDescription ? { error_description: errorDescription } : {}) },
    status,
    { "cache-control": "no-store" }
  );
}

function logConnect(
  level: "info" | "error",
  traceId: string,
  stage: string,
  errorCode: string,
  status: number
): void {
  const entry = JSON.stringify({
    event: "mcp_connect",
    trace_id: traceId,
    stage,
    error_code: errorCode,
    status
  });
  if (level === "error") {
    console.error(entry);
  } else {
    console.log(entry);
  }
}

async function token(request: Request, env: RuntimeEnv): Promise<Response> {
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/x-www-form-urlencoded")) {
    return oauthJsonError("invalid_request", 400);
  }
  const form = await limitedForm(request);
  if (!form) {
    return oauthJsonError("invalid_request", 400);
  }
  const authenticated = await authenticateClient(request, form, env);
  if (!authenticated) {
    return oauthJsonError("invalid_client", 401);
  }
  const now = Date.now();
  if (form.get("grant_type") === "authorization_code") {
    if ((form.get("resource") ?? STAGING_MCP_RESOURCE) !== STAGING_MCP_RESOURCE) {
      return oauthJsonError("invalid_target", 400);
    }
    const code = form.get("code");
    const redirectUri = form.get("redirect_uri");
    const verifier = form.get("code_verifier");
    const sessionId = code ? parseRoutedToken(code, "mkc1") : null;
    if (!code || !redirectUri || !verifier || !sessionId) {
      return oauthJsonError("invalid_grant", 400);
    }
    const issued = await authNamespace(env).getByName(sessionName(sessionId)).exchangeCode({
      code,
      clientId: authenticated.clientId,
      redirectUri,
      codeVerifier: verifier,
      issueRefreshToken:
        authenticated.grantTypes.includes("refresh_token") && form.get("scope")?.split(/\s+/u).includes("offline_access") !== false,
      now
    });
    return issued ? tokenResponse(issued, now) : oauthJsonError("invalid_grant", 400);
  }
  if (form.get("grant_type") === "refresh_token") {
    const refreshToken = form.get("refresh_token");
    const resource = form.get("resource") ?? STAGING_MCP_RESOURCE;
    const sessionId = refreshToken ? parseRoutedToken(refreshToken, "mkr1") : null;
    if (!refreshToken || !sessionId || resource !== STAGING_MCP_RESOURCE) {
      return oauthJsonError("invalid_grant", 400);
    }
    const issued = await authNamespace(env).getByName(sessionName(sessionId)).rotateRefreshToken({
      refreshToken,
      clientId: authenticated.clientId,
      resource,
      now
    });
    return issued ? tokenResponse(issued, now) : oauthJsonError("invalid_grant", 400);
  }
  return oauthJsonError("unsupported_grant_type", 400);
}

async function authenticateClient(
  request: Request,
  form: URLSearchParams,
  env: RuntimeEnv
): Promise<OAuthClientRecordV1 | null> {
  const basic = parseBasic(request.headers.get("authorization"));
  const clientId = basic?.clientId ?? form.get("client_id");
  if (!clientId) {
    return null;
  }
  if (basic && form.has("client_id") && form.get("client_id") !== basic.clientId) {
    return null;
  }
  const client = await getClient(env, clientId);
  if (!client) {
    return null;
  }
  if (client.tokenEndpointAuthMethod === "none") {
    return basic || form.has("client_secret") ? null : client;
  }
  const suppliedSecret =
    client.tokenEndpointAuthMethod === "client_secret_basic"
      ? basic?.clientId === clientId
        ? basic.clientSecret
        : null
      : !basic
        ? form.get("client_secret")
        : null;
  return suppliedSecret && client.clientSecretHash && (await secretEquals(client.clientSecretHash, suppliedSecret))
    ? client
    : null;
}

function tokenResponse(issued: Awaited<ReturnType<McpAuthState["exchangeCode"]>> extends infer T ? NonNullable<T> : never, now: number): Response {
  return json(
    {
      access_token: issued.accessToken,
      token_type: "Bearer",
      expires_in: Math.max(0, Math.floor((issued.accessExpiresAt - now) / 1000)),
      scope: issued.scope,
      resource: issued.resource,
      ...(issued.refreshToken ? { refresh_token: issued.refreshToken } : {})
    },
    200,
    { "cache-control": "no-store", pragma: "no-cache" }
  );
}

async function getClient(env: RuntimeEnv, clientId: string): Promise<OAuthClientRecordV1 | null> {
  if (!clientId.startsWith(CLIENT_PREFIX)) {
    return null;
  }
  return authNamespace(env).getByName(clientName(clientId)).getClient();
}

function authNamespace(env: RuntimeEnv): DurableObjectNamespace<McpAuthState> {
  if (!env.MCP_AUTH_STATE) {
    throw new Error("MCP_AUTH_STATE binding is required");
  }
  return env.MCP_AUTH_STATE;
}

function encryptionKey(env: RuntimeEnv): string {
  if (!env.MCP_KEY_ENCRYPTION_KEY) {
    throw new Error("MCP_KEY_ENCRYPTION_KEY is required");
  }
  return env.MCP_KEY_ENCRYPTION_KEY;
}

function clientName(clientId: string): string {
  return `client:${clientId}`;
}

function sessionName(sessionId: string): string {
  return `session:${sessionId}`;
}

function registrationKeyContext(sessionId: string): string {
  return `session:${sessionId}:registration-key:v1`;
}

function sessionKeyContext(sessionId: string): string {
  return `session:${sessionId}:session-key:v1`;
}

function parseRoutedToken(token: string, prefix: string): string | null {
  const parts = token.split(".");
  return parts.length === 3 && parts[0] === prefix && /^[A-Za-z0-9_-]+$/u.test(parts[1]) ? parts[1] : null;
}

function normalizeScope(value: string | null): string | null {
  const scopes = [...new Set((value ?? "mcp:read").split(/\s+/u).filter(Boolean))];
  if (!scopes.includes("mcp:read") || scopes.some((scope) => !ALLOWED_SCOPES.has(scope))) {
    return null;
  }
  return scopes.join(" ");
}

function isAllowedRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash) {
      return false;
    }
    if (url.protocol === "https:" && (url.hostname === "chatgpt.com" || url.hostname === "chat.openai.com")) {
      return true;
    }
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]")
    );
  } catch {
    return false;
  }
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : null;
}

async function limitedJson<T>(request: Request): Promise<T | null> {
  try {
    const text = await readLimitedText(request, MAX_AUTH_BODY_BYTES);
    return text === null ? null : (JSON.parse(text) as T);
  } catch {
    return null;
  }
}

async function limitedForm(request: Request): Promise<URLSearchParams | null> {
  try {
    const text = await readLimitedText(request, MAX_AUTH_BODY_BYTES);
    return text === null ? null : new URLSearchParams(text);
  } catch {
    return null;
  }
}

export async function readLimitedText(request: Request, maxBytes: number): Promise<string | null> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && (!/^[0-9]+$/u.test(contentLength) || Number(contentLength) > maxBytes)) {
    return null;
  }
  if (!request.body) {
    return "";
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

function readCookie(header: string | null, name: string): string | null {
  for (const pair of header?.split(";") ?? []) {
    const [key, ...value] = pair.trim().split("=");
    if (key === name) {
      return value.join("=") || null;
    }
  }
  return null;
}

function parseBasic(header: string | null): { clientId: string; clientSecret: string } | null {
  if (!header?.startsWith("Basic ")) {
    return null;
  }
  try {
    const [encodedClientId, ...encodedSecret] = atob(header.slice(6)).split(":");
    if (!encodedClientId || !encodedSecret.length) {
      return null;
    }
    return {
      clientId: decodeURIComponent(encodedClientId),
      clientSecret: decodeURIComponent(encodedSecret.join(":"))
    };
  } catch {
    return null;
  }
}

function oauthJsonError(error: string, status: number): Response {
  return json({ error }, status, { "cache-control": "no-store" });
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...headers, "content-type": "application/json; charset=utf-8" } });
}
