import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  UnauthorizedError,
  auth,
  extractWWWAuthenticateParams
} from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const DEFAULT_SERVER_URL = "https://wiki-mcp-staging.kinic.xyz/mcp";
export const FIND_DATABASE_LIMIT = 50;
const EXPECTED_TOOLS = [
  "connect_private",
  "context",
  "fetch_many",
  "find_databases",
  "list",
  "memory_manifest",
  "read_path",
  "read_paths",
  "search"
];

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

export function toolAuthenticationChallenge(result) {
  const challenges = result?._meta?.["mcp/www_authenticate"];
  if (result?.isError !== true || !Array.isArray(challenges) || typeof challenges[0] !== "string") {
    throw new Error("connect_private did not return an MCP OAuth challenge");
  }
  const challenge = challenges[0];
  if (!challenge.includes('error="insufficient_scope"') || !challenge.includes("error_description=")) {
    throw new Error("connect_private returned an incomplete MCP OAuth challenge");
  }
  return challenge;
}

export function parseAuthenticationChallenge(challenge) {
  const response = new Response(null, {
    status: 401,
    headers: { "www-authenticate": challenge }
  });
  const params = extractWWWAuthenticateParams(response);
  if (!params.resourceMetadataUrl || params.error !== "insufficient_scope") {
    throw new Error("connect_private returned invalid OAuth challenge parameters");
  }
  return params;
}

export function assertPrivateOptInToolSecurity(tools) {
  for (const tool of tools) {
    const actual = tool?._meta?.securitySchemes;
    const expected =
      tool?.name === "connect_private"
        ? [{ type: "oauth2", scopes: ["mcp:read"] }]
        : [
            { type: "noauth" },
            { type: "oauth2", scopes: ["mcp:read"] }
          ];
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`Unexpected authentication metadata for ${tool?.name ?? "unknown tool"}`);
    }
  }
}

class SmokeOAuthProvider {
  #clientInformation;
  #tokens;
  #codeVerifier;

  constructor(redirectUrl, oauthState, onRedirect) {
    this.redirectUrl = redirectUrl;
    this.oauthState = oauthState;
    this.onRedirect = onRedirect;
    this.clientMetadata = {
      client_name: "Kinic Wiki staging smoke",
      redirect_uris: [redirectUrl.toString()],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none"
    };
  }

  state() {
    return this.oauthState;
  }

  clientInformation() {
    return this.#clientInformation;
  }

  saveClientInformation(value) {
    this.#clientInformation = value;
  }

  tokens() {
    return this.#tokens;
  }

  saveTokens(value) {
    this.#tokens = value;
  }

  redirectToAuthorization(url) {
    this.onRedirect(url);
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
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const callback = await startCallbackServer(createOAuthState());
  const provider = new SmokeOAuthProvider(callback.redirectUrl, callback.oauthState, (authorizationUrl) => {
    console.log(`Authorize in your browser:\n${authorizationUrl.toString()}`);
    if (options.openBrowser) {
      openBrowser(authorizationUrl);
    }
  });
  const client = new Client({ name: "kinic-wiki-staging-smoke", version: "1.0.0" }, { capabilities: {} });
  let transport;
  try {
    transport = await connectClient(client, provider, callback.waitForCode, options.serverUrl);
    const tools = await client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name).sort();
    if (JSON.stringify(toolNames) !== JSON.stringify(EXPECTED_TOOLS)) {
      throw new Error(`Unexpected MCP tools: ${toolNames.join(", ")}`);
    }
    assertPrivateOptInToolSecurity(tools.tools);

    const publicFindResult = await client.callTool({
      name: "find_databases",
      arguments: { query: options.query, limit: FIND_DATABASE_LIMIT }
    });
    assertToolSucceeded("public find_databases", publicFindResult);

    const connectResult = await connectPrivate(
      client,
      provider,
      callback.waitForCode,
      options.serverUrl
    );
    assertToolSucceeded("connect_private", connectResult);

    const findResult = await client.callTool({
      name: "find_databases",
      arguments: { query: options.query, limit: FIND_DATABASE_LIMIT }
    });
    assertToolSucceeded("find_databases", findResult);
    const findText = toolResultText(findResult);
    const summary = {
      tools: { ok: true, count: toolNames.length },
      public_find_databases: summarizeToolResult(publicFindResult),
      connect_private: summarizeToolResult(connectResult),
      find_databases: {
        ...summarizeToolResult(findResult),
        ...(options.databaseId ? { private_database_visible: findText.includes(options.databaseId) } : {})
      }
    };
    if (options.databaseId && !summary.find_databases.private_database_visible) {
      throw new Error("The configured private database is not visible");
    }

    if (options.databaseId) {
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

    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await callback.close();
    if (transport) {
      await transport.close();
    }
  }
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

async function connectPrivate(client, provider, waitForCode, serverUrl) {
  const unauthenticatedResult = await client.callTool({
    name: "connect_private",
    arguments: {}
  });
  const challenge = toolAuthenticationChallenge(unauthenticatedResult);
  const { resourceMetadataUrl, scope } = parseAuthenticationChallenge(challenge);
  const started = await auth(provider, {
    serverUrl,
    resourceMetadataUrl,
    scope: scope ?? "mcp:read"
  });
  if (started !== "REDIRECT") {
    throw new Error("connect_private OAuth flow did not request authorization");
  }
  const authorizationCode = await waitForCode;
  const completed = await auth(provider, {
    serverUrl,
    authorizationCode,
    resourceMetadataUrl,
    scope: scope ?? "mcp:read"
  });
  if (completed !== "AUTHORIZED") {
    throw new Error("connect_private OAuth code exchange did not complete");
  }
  return client.callTool({ name: "connect_private", arguments: {} });
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

function parseArgs(args) {
  const values = new Map();
  let openBrowserRequested = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      continue;
    }
    if (arg === "--open") {
      openBrowserRequested = true;
      continue;
    }
    if (!arg.startsWith("--") || !args[index + 1] || args[index + 1].startsWith("--")) {
      throw new Error(`Invalid argument: ${arg}`);
    }
    values.set(arg, args[index + 1]);
    index += 1;
  }
  return {
    serverUrl: values.get("--server-url") ?? DEFAULT_SERVER_URL,
    databaseId: values.get("--database-id") ?? process.env.MCP_TEST_PRIVATE_DB_ID,
    path: values.get("--path") ?? process.env.MCP_TEST_PRIVATE_PATH,
    query: values.get("--query") ?? "",
    task: values.get("--task") ?? "Verify delegated access to the configured private Kinic Wiki database.",
    openBrowser: openBrowserRequested
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Staging smoke failed");
    process.exitCode = 1;
  });
}
