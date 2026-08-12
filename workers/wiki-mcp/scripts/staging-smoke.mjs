import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const DEFAULT_SERVER_URL = "https://wiki-mcp-staging.kinic.xyz/mcp";
const AUTH_CACHE_VERSION = 1;
const AUTH_CACHE_ENV = "MCP_STAGING_AUTH_CACHE";
export const FIND_DATABASE_LIMIT = 50;
const EXPECTED_TOOLS = [
  "context",
  "fetch_many",
  "find_databases",
  "list",
  "memory_manifest",
  "mutate_nodes_batch",
  "read_path",
  "read_paths",
  "search",
  "write_nodes"
];
const WRITE_TOOLS = new Set(["mutate_nodes_batch", "write_nodes"]);
const VALUE_ARGUMENTS = new Set([
  "--server-url",
  "--database-id",
  "--path",
  "--write-smoke-path",
  "--query",
  "--task"
]);

export function oauthScopesForRun(writeSmokePath) {
  return writeSmokePath
    ? ["mcp:read", "mcp:write", "offline_access"]
    : ["mcp:read", "offline_access"];
}

export function authorizationUrlWithScopes(authorizationUrl, scopes) {
  const scopedUrl = new URL(authorizationUrl);
  scopedUrl.searchParams.set("scope", scopes.join(" "));
  return scopedUrl;
}

export function defaultAuthCachePath(env = process.env, home = homedir()) {
  if (env[AUTH_CACHE_ENV]) return env[AUTH_CACHE_ENV];
  const stateRoot = env.XDG_STATE_HOME || join(home, ".local", "state");
  return join(stateRoot, "kinic-wiki", "mcp-staging-smoke-oauth.json");
}

export async function openOAuthCache({ path, serverUrl, requiredScopes, reset = false }) {
  if (reset) await unlink(path).catch((error) => ignoreMissing(error));
  let state = {};
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    if (
      parsed?.version === AUTH_CACHE_VERSION &&
      parsed?.server_url === serverUrl &&
      requiredScopes.every((scope) => parsed?.scopes?.includes(scope))
    ) {
      state = parsed;
    }
  } catch (error) {
    ignoreMissingOrInvalidCache(error);
  }
  return new OAuthFileCache(path, serverUrl, requiredScopes, state);
}

class OAuthFileCache {
  constructor(path, serverUrl, requiredScopes, state) {
    this.path = path;
    this.serverUrl = serverUrl;
    this.requiredScopes = requiredScopes;
    this.state = state;
  }

  clientInformation() {
    return this.state.client_information;
  }

  tokens() {
    return this.state.tokens;
  }

  discoveryState() {
    return this.state.discovery_state;
  }

  async saveClientInformation(clientInformation) {
    this.state.client_information = clientInformation;
    await this.persist();
  }

  async saveTokens(tokens) {
    const tokenScopes = typeof tokens.scope === "string" ? tokens.scope.split(/\s+/u).filter(Boolean) : [];
    this.state.tokens = tokens;
    this.state.scopes = tokenScopes.length > 0 ? tokenScopes : this.requiredScopes;
    await this.persist();
  }

  async saveDiscoveryState(discoveryState) {
    this.state.discovery_state = discoveryState;
    await this.persist();
  }

  async invalidateCredentials(scope) {
    if (scope === "all" || scope === "client" || scope === "tokens") {
      delete this.state.tokens;
      delete this.state.client_information;
      delete this.state.scopes;
    }
    if (scope === "all" || scope === "discovery") delete this.state.discovery_state;
    await this.persist();
  }

  async persist() {
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const tempPath = `${this.path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    const payload = `${JSON.stringify({
      version: AUTH_CACHE_VERSION,
      server_url: this.serverUrl,
      scopes: this.state.scopes ?? [],
      client_information: this.state.client_information,
      tokens: this.state.tokens,
      discovery_state: this.state.discovery_state
    })}\n`;
    try {
      await writeFile(tempPath, payload, { encoding: "utf8", mode: 0o600 });
      await chmod(tempPath, 0o600);
      await rename(tempPath, this.path);
    } finally {
      await unlink(tempPath).catch((error) => ignoreMissing(error));
    }
  }
}

function ignoreMissing(error) {
  if (error?.code !== "ENOENT") throw error;
}

function ignoreMissingOrInvalidCache(error) {
  if (error?.code === "ENOENT" || error instanceof SyntaxError) return;
  throw error;
}

export function createOAuthState() {
  return randomBytes(32).toString("base64url");
}

export function assertCallbackState(actual, expected) {
  if (typeof actual !== "string") {
    throw new Error("OAuth callback state is missing");
  }
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  if (actualBytes.byteLength !== expectedBytes.byteLength || !timingSafeEqual(actualBytes, expectedBytes)) {
    throw new Error("OAuth callback state does not match");
  }
}

export function summarizeToolResult(result) {
  const text = toolResultText(result);
  return {
    ok: result?.isError !== true,
    response_bytes: Buffer.byteLength(text)
  };
}

export function assertPrivateRequiredToolSecurity(tools) {
  for (const tool of tools) {
    const actual = tool?._meta?.securitySchemes;
    const expected = WRITE_TOOLS.has(tool?.name)
      ? [{ type: "oauth2", scopes: ["mcp:read", "mcp:write"] }]
      : [{ type: "oauth2", scopes: ["mcp:read"] }];
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`Unexpected authentication metadata for ${tool?.name ?? "unknown tool"}`);
    }
  }
}

export function smokeTempPaths(path, marker) {
  return {
    rollbackPath: smokeSiblingPath(path, `${marker}-rollback`),
    batchPaths: [
      smokeSiblingPath(path, `${marker}-batch-a`),
      smokeSiblingPath(path, `${marker}-batch-b`)
    ]
  };
}

export async function cleanupSmokeArtifacts(client, databaseId, artifacts) {
  let failureCount = 0;
  for (const artifact of artifacts) {
    try {
      let etag = artifact.etag;
      if (typeof etag !== "string") {
        const read = await client.callTool({
          name: "read_path",
          arguments: { database_id: databaseId, path: artifact.path }
        });
        if (isReadPathNotFoundResult(read)) {
          continue;
        }
        assertToolSucceeded("smoke cleanup read_path", read);
        if (!toolResultText(read).includes(artifact.expectedContent)) {
          throw new Error("smoke cleanup content marker did not match");
        }
        etag = read.structuredContent?.metadata?.etag;
        if (typeof etag !== "string") {
          throw new Error("smoke cleanup read_path did not return an etag");
        }
      }
      const deleted = await client.callTool({
        name: "mutate_nodes_batch",
        arguments: {
          database_id: databaseId,
          operations: [{ type: "delete", path: artifact.path, expected_etag: etag }]
        }
      });
      if (isMutationNotFoundResult(deleted)) {
        continue;
      }
      assertToolSucceeded("smoke cleanup mutate_nodes_batch", deleted);
    } catch {
      failureCount += 1;
    }
  }
  return failureCount;
}

export function smokeCompletionError(operationError, cleanupFailureCount) {
  if (operationError !== undefined) {
    if (cleanupFailureCount === 0) {
      return operationError instanceof Error ? operationError : new Error("Staging smoke failed");
    }
    const message = operationError instanceof Error ? operationError.message : "Staging smoke failed";
    return new Error(`${message}; cleanup failed for ${cleanupFailureCount} smoke artifact(s)`, {
      cause: operationError
    });
  }
  return cleanupFailureCount === 0
    ? null
    : new Error(`Cleanup failed for ${cleanupFailureCount} smoke artifact(s)`);
}

class SmokeOAuthProvider {
  #clientInformation;
  #tokens;
  #codeVerifier;

  constructor(redirectUrl, oauthState, onRedirect, cache, requiredScopes) {
    this.redirectUrl = redirectUrl;
    this.oauthState = oauthState;
    this.onRedirect = onRedirect;
    this.cache = cache;
    this.requiredScopes = requiredScopes;
    this.clientMetadata = {
      client_name: "Kinic Wiki staging smoke",
      redirect_uris: [redirectUrl.toString()],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: requiredScopes.join(" ")
    };
  }

  state() {
    return this.oauthState;
  }

  clientInformation() {
    return this.#clientInformation ?? this.cache.clientInformation();
  }

  async saveClientInformation(value) {
    this.#clientInformation = value;
    await this.cache.saveClientInformation(value);
  }

  tokens() {
    return this.#tokens ?? this.cache.tokens();
  }

  async saveTokens(value) {
    this.#tokens = value;
    await this.cache.saveTokens(value);
  }

  redirectToAuthorization(url) {
    this.onRedirect(authorizationUrlWithScopes(url, this.requiredScopes));
  }

  saveCodeVerifier(value) {
    this.#codeVerifier = value;
  }

  codeVerifier() {
    if (!this.#codeVerifier) {
      throw new Error("PKCE verifier is unavailable");
    }
    return this.#codeVerifier;
  }

  discoveryState() {
    return this.cache.discoveryState();
  }

  saveDiscoveryState(value) {
    return this.cache.saveDiscoveryState(value);
  }

  async invalidateCredentials(scope) {
    if (scope === "all" || scope === "client" || scope === "tokens") {
      this.#clientInformation = undefined;
      this.#tokens = undefined;
    }
    if (scope === "all" || scope === "verifier") this.#codeVerifier = undefined;
    await this.cache.invalidateCredentials(scope);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const requiredScopes = oauthScopesForRun(options.writeSmokePath);
  const cache = await openOAuthCache({
    path: options.authCachePath,
    serverUrl: options.serverUrl,
    requiredScopes,
    reset: options.resetAuth
  });
  const callback = await startCallbackServer(createOAuthState());
  const provider = new SmokeOAuthProvider(
    callback.redirectUrl,
    callback.oauthState,
    (authorizationUrl) => {
      console.log(`Authorize in your browser:\n${authorizationUrl.toString()}`);
      if (options.openBrowser) openBrowser(authorizationUrl);
    },
    cache,
    requiredScopes
  );
  const client = new Client({ name: "kinic-wiki-staging-smoke", version: "1.0.0" }, { capabilities: {} });
  let transport;
  try {
    transport = await connectClient(client, provider, callback.waitForCode, options.serverUrl);
    console.error("staging smoke stage: tools");
    const tools = await client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name).sort();
    if (JSON.stringify(toolNames) !== JSON.stringify(EXPECTED_TOOLS)) {
      throw new Error(`Unexpected MCP tools: ${toolNames.join(", ")}`);
    }
    assertPrivateRequiredToolSecurity(tools.tools);

    console.error("staging smoke stage: private-read");
    const findResult = await client.callTool({
      name: "find_databases",
      arguments: { query: options.query, limit: FIND_DATABASE_LIMIT }
    });
    assertToolSucceeded("find_databases", findResult);
    const findText = toolResultText(findResult);
    const summary = {
      tools: { ok: true, count: toolNames.length },
      find_databases: {
        ...summarizeToolResult(findResult),
        ...(options.databaseId ? { private_database_visible: findText.includes(options.databaseId) } : {})
      }
    };
    if (options.databaseId && !summary.find_databases.private_database_visible) {
      throw new Error("The configured private database is not visible");
    }

    if (options.databaseId) {
      console.error("staging smoke stage: context");
      const contextResult = await client.callTool({
        name: "context",
        arguments: {
          database_id: options.databaseId,
          task: options.task,
          namespace: "/Knowledge",
          budget_tokens: 1000,
          include_evidence: true,
          depth: 1
        }
      });
      assertToolSucceeded("context", contextResult);
      summary.context = summarizeToolResult(contextResult);
    }

    if (options.databaseId && options.path) {
      const readResult = await client.callTool({
        name: "read_path",
        arguments: { database_id: options.databaseId, path: options.path }
      });
      assertToolSucceeded("read_path", readResult);
      summary.read_path = summarizeToolResult(readResult);
    }

    if (options.writeSmokePath) {
      if (!options.databaseId) {
        throw new Error("--write-smoke-path requires --database-id");
      }
      console.error("staging smoke stage: write-suite");
      summary.write_batch_delete = await smokeWriteBatchDelete(client, options.databaseId, options.writeSmokePath);
    }

    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await callback.close();
    if (transport) {
      await transport.close();
    }
  }
}

export async function smokeWriteBatchDelete(client, databaseId, path) {
  const marker = randomBytes(8).toString("hex");
  const { rollbackPath, batchPaths } = smokeTempPaths(path, marker);
  const mainArtifact = { path, expectedContent: `staging-smoke:${marker}`, etag: undefined };
  const rollbackContent = `staging-smoke-rollback:${marker}`;
  const batchArtifacts = batchPaths.map((batchPath, index) => ({
    path: batchPath,
    expectedContent: `staging-smoke-batch:${marker}:${index}`,
    etag: undefined
  }));
  const artifacts = [];
  let operationError;
  let summary;
  try {
    artifacts.push(mainArtifact);
    const created = await client.callTool({
      name: "write_nodes",
      arguments: { database_id: databaseId, nodes: [{ path, kind: "file", content: mainArtifact.expectedContent, metadata_json: "{}" }] }
    });
    assertToolSucceeded("write_nodes single", created);
    let etag = created.structuredContent?.results?.[0]?.node?.etag;
    mainArtifact.etag = etag;
    if (typeof etag !== "string") {
      throw new Error("write_nodes single did not return an etag");
    }

    console.error("staging smoke write stage: etag-conflict");
    const conflict = await client.callTool({
      name: "write_nodes",
      arguments: {
        database_id: databaseId,
        nodes: [{ path, kind: "file", content: "stale-write-must-not-commit", metadata_json: "{}", expected_etag: `stale-${marker}` }]
      }
    });
    const conflictDetail = assertEtagConflict("write_nodes stale etag", conflict, path, etag);
    if (!conflictDetail.current_content.includes(marker)) {
      throw new Error("etag_conflict did not return the current content");
    }

    console.error("staging smoke write stage: atomic-rollback");
    const rollback = await client.callTool({
      name: "write_nodes",
      arguments: {
        database_id: databaseId,
        nodes: [
          { path: rollbackPath, kind: "file", content: rollbackContent, metadata_json: "{}" },
          { path, kind: "file", content: "stale-batch-must-not-commit", metadata_json: "{}", expected_etag: `stale-${marker}` }
        ]
      }
    });
    const rollbackDetail = assertEtagConflict("write_nodes atomic rollback", rollback, path, etag, false);
    if (rollbackDetail.failed_index !== 1) {
      throw new Error("write_nodes did not identify the failed batch index");
    }
    const currentAfterConflict = await client.callTool({
      name: "read_path",
      arguments: { database_id: databaseId, path }
    });
    assertToolSucceeded("write_nodes conflict reread", currentAfterConflict);
    if (
      currentAfterConflict.structuredContent?.metadata?.etag !== etag ||
      !toolResultText(currentAfterConflict).includes(marker)
    ) {
      throw new Error("write_nodes conflict reread did not return the unchanged current node");
    }
    const rolledBackRead = await client.callTool({
      name: "read_path",
      arguments: { database_id: databaseId, path: rollbackPath }
    });
    if (!isReadPathNotFoundResult(rolledBackRead)) {
      throw new Error(
        rolledBackRead?.isError === true
          ? "write_nodes rollback verification returned an unexpected MCP tool error"
          : "write_nodes left a partial write after an etag conflict"
      );
    }

    console.error("staging smoke write stage: write-nodes");
    artifacts.push(...batchArtifacts);
    const writtenBatch = await client.callTool({
      name: "write_nodes",
      arguments: {
        database_id: databaseId,
        nodes: batchArtifacts.map((artifact) => ({
          path: artifact.path,
          kind: "file",
          content: artifact.expectedContent,
          metadata_json: "{}"
        }))
      }
    });
    assertToolSucceeded("write_nodes", writtenBatch);
    const batchEtags = writtenBatch.structuredContent?.results?.map(
      (result) => result?.node?.etag ?? result?.value?.node?.etag
    );
    if (Array.isArray(batchEtags)) {
      for (let index = 0; index < batchPaths.length; index += 1) {
        batchArtifacts[index].etag = batchEtags[index];
      }
    }
    if (
      !Array.isArray(batchEtags) ||
      batchEtags.length !== batchPaths.length ||
      batchEtags.some((value) => typeof value !== "string")
    ) {
      throw new Error("write_nodes did not return every batch etag");
    }

    console.error("staging smoke write stage: mutate-batch");
    const batch = await client.callTool({
      name: "mutate_nodes_batch",
      arguments: {
        database_id: databaseId,
        operations: [{ type: "append", path, content: "\nbatch-ok", expected_etag: etag }]
      }
    });
    assertToolSucceeded("mutate_nodes_batch", batch);
    etag = batch.structuredContent?.results?.[0]?.value?.node?.etag;
    mainArtifact.etag = etag;
    if (typeof etag !== "string") {
      throw new Error("mutate_nodes_batch did not return an etag");
    }
    summary = {
      write_nodes_single: summarizeToolResult(created),
      etag_conflict: summarizeToolResult(conflict),
      atomic_rollback: summarizeToolResult(rollback),
      write_nodes: summarizeToolResult(writtenBatch),
      mutate_nodes_batch: summarizeToolResult(batch),
      cleanup_batch: { ok: true }
    };
  } catch (error) {
    operationError = error instanceof Error ? error : new Error("Staging smoke failed");
  }
  console.error("staging smoke write stage: cleanup");
  const cleanupFailureCount = await cleanupSmokeArtifacts(client, databaseId, artifacts);
  const completionError = smokeCompletionError(operationError, cleanupFailureCount);
  if (completionError) {
    throw completionError;
  }
  return summary;
}

function assertEtagConflict(name, result, expectedPath, expectedEtag, requireCurrent = true) {
  if (result?.isError !== true) {
    throw new Error(`${name} unexpectedly succeeded`);
  }
  let detail;
  try {
    detail = JSON.parse(toolResultText(result));
  } catch {
    throw new Error(`${name} did not return a JSON error`);
  }
  if (
    detail?.error !== "etag_conflict" ||
    detail?.path !== expectedPath ||
    (requireCurrent && detail?.current_etag !== expectedEtag)
  ) {
    throw new Error(
      `${name} returned an incomplete etag conflict: ${JSON.stringify({
        error: detail?.error ?? null,
        failed_index: detail?.failed_index ?? null,
        path_matches: detail?.path === expectedPath,
        current_etag_present: typeof detail?.current_etag === "string",
        current_etag_matches: detail?.current_etag === expectedEtag,
        current_content_present: typeof detail?.current_content === "string"
      })}`
    );
  }
  return detail;
}

export function isReadPathNotFoundResult(result) {
  if (result?.isError !== true) {
    return false;
  }
  try {
    return JSON.parse(toolResultText(result))?.error === "node not found";
  } catch {
    return false;
  }
}

export function isMutationNotFoundResult(result) {
  if (result?.isError !== true) {
    return false;
  }
  try {
    return JSON.parse(toolResultText(result))?.error === "not_found";
  } catch {
    return false;
  }
}

function smokeSiblingPath(path, suffix) {
  return path.endsWith(".md") ? `${path.slice(0, -3)}-${suffix}.md` : `${path}-${suffix}`;
}

async function connectClient(client, provider, waitForCode, serverUrl) {
  let transport = new StreamableHTTPClientTransport(new URL(serverUrl), { authProvider: provider });
  try {
    await client.connect(transport);
    return transport;
  } catch (error) {
    if (!(error instanceof UnauthorizedError)) {
      throw error;
    }
  }
  const authorizationCode = await waitForCode;
  await transport.finishAuth(authorizationCode);
  transport = new StreamableHTTPClientTransport(new URL(serverUrl), { authProvider: provider });
  await client.connect(transport);
  return transport;
}

async function startCallbackServer(oauthState) {
  let resolveCode;
  let rejectCode;
  const waitForCode = new Promise((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  const server = createServer((request, response) => {
    if (request.url === "/favicon.ico") {
      response.writeHead(404).end();
      return;
    }
    try {
      const callbackUrl = new URL(request.url ?? "", "http://127.0.0.1");
      const oauthError = callbackUrl.searchParams.get("error");
      if (oauthError) {
        throw new Error(`OAuth authorization failed: ${oauthError}`);
      }
      assertCallbackState(callbackUrl.searchParams.get("state"), oauthState);
      const code = callbackUrl.searchParams.get("code");
      if (!code) {
        throw new Error("OAuth authorization code is missing");
      }
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store"
      });
      response.end("<!doctype html><title>Kinic Wiki connected</title><p>Connection complete. Return to the terminal.</p>");
      resolveCode(code);
    } catch (error) {
      response.writeHead(400, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store"
      });
      response.end("OAuth callback rejected.");
      rejectCode(error);
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Loopback callback address is unavailable");
  }
  return {
    oauthState,
    redirectUrl: new URL(`http://127.0.0.1:${address.port}/callback`),
    waitForCode,
    close: () =>
      new Promise((resolve, reject) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close((error) => (error ? reject(error) : resolve()));
      })
  };
}

function toolResultText(result) {
  if (!result || !Array.isArray(result.content)) {
    return "";
  }
  return result.content
    .map((item) => {
      if (item.type === "text") {
        return item.text;
      }
      if (item.type === "resource" && "text" in item.resource) {
        return item.resource.text;
      }
      return "";
    })
    .join("");
}

function assertToolSucceeded(name, result) {
  if (result?.isError === true) {
    throw new Error(`${name} returned an MCP tool error`);
  }
}

function openBrowser(url) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url.toString()] : [url.toString()];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
}

export function parseArgs(args) {
  const values = new Map();
  let openBrowserRequested = false;
  let resetAuthRequested = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      continue;
    }
    if (arg === "--open") {
      openBrowserRequested = true;
      continue;
    }
    if (arg === "--reset-auth") {
      resetAuthRequested = true;
      continue;
    }
    if (!VALUE_ARGUMENTS.has(arg) || !args[index + 1] || args[index + 1].startsWith("--")) {
      throw new Error(`Invalid argument: ${arg}`);
    }
    values.set(arg, args[index + 1]);
    index += 1;
  }
  return {
    serverUrl: values.get("--server-url") ?? DEFAULT_SERVER_URL,
    databaseId: values.get("--database-id") ?? process.env.MCP_TEST_PRIVATE_DB_ID,
    path: values.get("--path") ?? process.env.MCP_TEST_PRIVATE_PATH,
    writeSmokePath: values.get("--write-smoke-path") ?? process.env.MCP_TEST_WRITE_PATH,
    query: values.get("--query") ?? "",
    task: values.get("--task") ?? "Verify delegated access to the configured private Kinic Wiki database.",
    openBrowser: openBrowserRequested,
    resetAuth: resetAuthRequested,
    authCachePath: defaultAuthCachePath()
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Staging smoke failed");
    process.exitCode = 1;
  });
}
