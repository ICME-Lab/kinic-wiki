import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  authorizationUrlWithScopes,
  assertPrivateRequiredToolSecurity,
  assertCallbackState,
  cleanupSmokeArtifacts,
  createOAuthState,
  defaultAuthCachePath,
  FIND_DATABASE_LIMIT,
  isMutationNotFoundResult,
  isReadPathNotFoundResult,
  oauthScopesForRun,
  openOAuthCache,
  parseArgs,
  smokeCompletionError,
  smokeWriteBatchDelete,
  smokeTempPaths,
  summarizeToolResult
} from "./staging-smoke.mjs";

const packageConfig = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const productionConfig = JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
const privateConfig = JSON.parse(readFileSync(new URL("../wrangler.private.jsonc", import.meta.url), "utf8"));
const stagingConfig = JSON.parse(readFileSync(new URL("../wrangler.staging.jsonc", import.meta.url), "utf8"));
const stagingV4UnbindConfig = JSON.parse(
  readFileSync(new URL("../wrangler.staging-v4-unbind.jsonc", import.meta.url), "utf8")
);
const stagingV4UnbindEntrypoint = readFileSync(
  new URL("../src/staging-v4-unbind.ts", import.meta.url),
  "utf8"
);

function toolErrorResult(detail) {
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(detail) }]
  };
}

test("keeps staging on its canonical custom domain and permission-aware SDK", () => {
  assert.equal(stagingConfig.workers_dev, false);
  assert.deepEqual(stagingConfig.routes, [
    {
      pattern: "wiki-mcp-staging.kinic.xyz",
      custom_domain: true
    }
  ]);
  assert.equal(stagingConfig.vars.MCP_ACCESS_POLICY, "private_required");
  assert.equal(stagingConfig.vars.MCP_WRITE_POLICY, "private");
  assert.equal(stagingConfig.vars.KINIC_WIKI_CANISTER_ID, "3ryrw-kyaaa-aaaaf-qgxpq-cai");
  assert.equal(
    stagingConfig.vars.KINIC_WIKI_MCP_TARGET_ORIGIN,
    "https://3ryrw-kyaaa-aaaaf-qgxpq-cai.ic0.app"
  );
  assert.equal(
    stagingConfig.vars.KINIC_WIKI_PUBLIC_ORIGIN,
    "https://kinic-wiki-browser-staging.hude.workers.dev"
  );
  assert.notEqual(stagingConfig.vars.KINIC_WIKI_CANISTER_ID, productionConfig.vars.KINIC_WIKI_CANISTER_ID);
  assert.equal(productionConfig.vars.MCP_WRITE_POLICY, "disabled");
  assert.equal(stagingConfig.vars.MCP_AUTH_ENABLED, undefined);
  assert.equal(packageConfig.dependencies["@icp-sdk/core"], "6.0.0");
  assert.equal(packageConfig.scripts["dev:staging"], undefined);
});

test("keeps public production anonymous and isolates staging auth state", () => {
  assert.equal(productionConfig.vars.MCP_ACCESS_POLICY, "public");
  assert.equal(productionConfig.durable_objects, undefined);
  assert.equal(stagingConfig.vars.MCP_ACCESS_POLICY, "private_required");
  assert.equal(stagingConfig.durable_objects.bindings[0].name, "MCP_AUTH_STATE");
  assert.equal(stagingConfig.durable_objects.bindings[0].class_name, "McpAuthStateV4");
  assert.deepEqual(stagingConfig.ratelimits, [
    {
      name: "MCP_REGISTRATION_RATE_LIMIT",
      namespace_id: "7802026",
      simple: { limit: 10, period: 60 }
    }
  ]);
  assert.deepEqual(stagingConfig.migrations.at(-1), {
    tag: "v4",
    new_sqlite_classes: ["McpAuthStateV4"],
    deleted_classes: ["McpAuthStateV3"]
  });
  assert.notEqual(productionConfig.name, stagingConfig.name);
});

test("adds an isolated private production worker without changing the public worker", () => {
  assert.equal(productionConfig.name, "kinic-wiki-mcp");
  assert.deepEqual(productionConfig.routes, [
    { pattern: "wiki-mcp.kinic.xyz", custom_domain: true }
  ]);
  assert.equal(productionConfig.vars.MCP_ACCESS_POLICY, "public");
  assert.equal(productionConfig.vars.MCP_WRITE_POLICY, "disabled");
  assert.equal(productionConfig.durable_objects, undefined);

  assert.equal(privateConfig.name, "kinic-wiki-mcp-private");
  assert.equal(privateConfig.workers_dev, false);
  assert.deepEqual(privateConfig.routes, [
    { pattern: "wiki-private-mcp.kinic.xyz", custom_domain: true }
  ]);
  assert.equal(privateConfig.vars.KINIC_WIKI_CANISTER_ID, productionConfig.vars.KINIC_WIKI_CANISTER_ID);
  assert.equal(privateConfig.vars.KINIC_WIKI_PUBLIC_ORIGIN, productionConfig.vars.KINIC_WIKI_PUBLIC_ORIGIN);
  assert.equal(privateConfig.vars.KINIC_WIKI_MCP_TARGET_ORIGIN, "https://6emaw-iyaaa-aaaay-aacka-cai.ic0.app");
  assert.equal(privateConfig.vars.MCP_ACCESS_POLICY, "private_required");
  assert.equal(privateConfig.vars.MCP_WRITE_POLICY, "private");
  assert.equal(privateConfig.vars.MCP_PUBLIC_ORIGIN, "https://wiki-private-mcp.kinic.xyz");
  assert.deepEqual(privateConfig.durable_objects.bindings, [
    { name: "MCP_AUTH_STATE", class_name: "McpAuthStateV4" }
  ]);
  assert.deepEqual(privateConfig.migrations, [
    { tag: "v1", new_sqlite_classes: ["McpAuthStateV4"] }
  ]);
  assert.notEqual(privateConfig.ratelimits[0].namespace_id, stagingConfig.ratelimits[0].namespace_id);
  assert.notEqual(privateConfig.name, productionConfig.name);
  assert.notEqual(privateConfig.name, stagingConfig.name);
  assert.match(packageConfig.scripts["build:private"], /wrangler\.private\.jsonc/u);
  assert.match(packageConfig.scripts["deploy:private"], /build:private.*wrangler\.private\.jsonc/u);
});

test("keeps the V4 migration unbind configuration aligned with staging", () => {
  for (const key of [
    "name",
    "compatibility_date",
    "compatibility_flags",
    "workers_dev",
    "observability",
    "routes",
    "ratelimits",
    "vars"
  ]) {
    assert.deepEqual(stagingV4UnbindConfig[key], stagingConfig[key], `${key} must stay aligned`);
  }
  assert.equal(stagingV4UnbindConfig.durable_objects, undefined);
  assert.deepEqual(stagingV4UnbindConfig.migrations, stagingConfig.migrations.slice(0, -1));
  assert.match(stagingV4UnbindEntrypoint, /McpAuthStateV4 as McpAuthStateV3/u);
  assert.match(
    packageConfig.scripts["deploy:staging"],
    /check_worker_deploy_source\.mjs.*build:staging.*wrangler deploy/u
  );
  assert.equal(
    packageConfig.scripts["deploy:staging:v4-migration"],
    "node scripts/deploy-staging-v4-migration.mjs"
  );
});

test("creates independent high-entropy OAuth states", () => {
  const first = createOAuthState();
  const second = createOAuthState();

  assert.match(first, /^[A-Za-z0-9_-]{43}$/u);
  assert.notEqual(first, second);
});

test("requires an exact OAuth callback state", () => {
  const state = createOAuthState();

  assert.doesNotThrow(() => assertCallbackState(state, state));
  assert.throws(() => assertCallbackState(`${state.slice(0, -1)}x`, state), /does not match/u);
  assert.throws(() => assertCallbackState(null, state), /missing/u);
});

test("requests reusable read credentials and adds write only for write smoke", () => {
  assert.deepEqual(oauthScopesForRun(undefined), ["mcp:read", "offline_access"]);
  assert.deepEqual(oauthScopesForRun("/Knowledge/smoke.md"), [
    "mcp:read",
    "mcp:write",
    "offline_access"
  ]);

  const authorizationUrl = authorizationUrlWithScopes(
    new URL("https://auth.example/authorize?scope=mcp%3Aread&state=state"),
    oauthScopesForRun("/Knowledge/smoke.md")
  );
  assert.equal(authorizationUrl.searchParams.get("scope"), "mcp:read mcp:write offline_access");
  assert.equal(authorizationUrl.searchParams.get("state"), "state");
});

test("resolves the OAuth cache from an override or the user state directory", () => {
  assert.equal(
    defaultAuthCachePath({ MCP_STAGING_AUTH_CACHE: "/tmp/custom-oauth.json" }, "/home/test"),
    "/tmp/custom-oauth.json"
  );
  assert.equal(
    defaultAuthCachePath({ XDG_STATE_HOME: "/state" }, "/home/test"),
    "/state/kinic-wiki/mcp-staging-smoke-oauth.json"
  );
  assert.equal(
    defaultAuthCachePath({}, "/home/test"),
    "/home/test/.local/state/kinic-wiki/mcp-staging-smoke-oauth.json"
  );
});

test("persists and reopens OAuth credentials only for matching scopes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "kinic-mcp-oauth-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cachePath = join(directory, "nested", "oauth.json");
  const serverUrl = "https://wiki-mcp-staging.example/mcp";
  const readScopes = oauthScopesForRun(undefined);
  const cache = await openOAuthCache({ path: cachePath, serverUrl, requiredScopes: readScopes });
  const clientInformation = { client_id: "client-id", token_endpoint_auth_method: "none" };
  const tokens = {
    access_token: "access-token",
    refresh_token: "refresh-token",
    token_type: "bearer",
    scope: "mcp:read offline_access"
  };

  await cache.saveClientInformation(clientInformation);
  await cache.saveTokens(tokens);

  const reopened = await openOAuthCache({ path: cachePath, serverUrl, requiredScopes: readScopes });
  assert.deepEqual(reopened.clientInformation(), clientInformation);
  assert.deepEqual(reopened.tokens(), tokens);
  const writeReopen = await openOAuthCache({
    path: cachePath,
    serverUrl,
    requiredScopes: oauthScopesForRun("/Knowledge/smoke.md")
  });
  assert.equal(writeReopen.clientInformation(), undefined);
  assert.equal(writeReopen.tokens(), undefined);
  assert.equal(JSON.parse(await readFile(cachePath, "utf8")).version, 1);
  if (process.platform !== "win32") {
    assert.equal((await stat(cachePath)).mode & 0o777, 0o600);
  }
});

test("reset-auth removes cached OAuth credentials", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "kinic-mcp-oauth-reset-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cachePath = join(directory, "oauth.json");
  const options = {
    path: cachePath,
    serverUrl: "https://wiki-mcp-staging.example/mcp",
    requiredScopes: oauthScopesForRun(undefined)
  };
  const cache = await openOAuthCache(options);
  await cache.saveClientInformation({ client_id: "client-id" });
  await cache.saveTokens({ access_token: "access-token", token_type: "bearer" });

  const reset = await openOAuthCache({ ...options, reset: true });
  assert.equal(reset.clientInformation(), undefined);
  assert.equal(reset.tokens(), undefined);
  await assert.rejects(readFile(cachePath, "utf8"), { code: "ENOENT" });
});

test("summarizes tool results without exposing their text", () => {
  const sensitiveText = "private body mka1.session.token";
  const summary = summarizeToolResult({
    content: [{ type: "text", text: sensitiveText }],
    isError: false
  });

  assert.deepEqual(summary, { ok: true, response_bytes: Buffer.byteLength(sensitiveText) });
  assert.equal(JSON.stringify(summary).includes("private body"), false);
  assert.equal(JSON.stringify(summary).includes("mka1"), false);
});

test("derives marker-specific smoke paths while preserving the markdown extension", () => {
  const first = smokeTempPaths("/Knowledge/staging-smoke.md", "marker-a");
  const second = smokeTempPaths("/Knowledge/staging-smoke.md", "marker-b");

  assert.deepEqual(first, {
    rollbackPath: "/Knowledge/staging-smoke-marker-a-rollback.md",
    batchPaths: [
      "/Knowledge/staging-smoke-marker-a-batch-a.md",
      "/Knowledge/staging-smoke-marker-a-batch-b.md"
    ]
  });
  assert.notDeepEqual(first, second);
  assert.equal(first.batchPaths.every((path) => path.endsWith(".md")), true);
});

test("cleans a committed single artifact when the write response is lost", async () => {
  const calls = [];
  let committedContent;
  const client = {
    async callTool(request) {
      calls.push(request);
      if (request.name === "write_nodes") {
        committedContent = request.arguments.nodes[0].content;
        throw new Error("single response lost");
      }
      if (request.name === "read_path") {
        return {
          isError: false,
          content: [{ type: "text", text: `Content:\n${committedContent}` }],
          structuredContent: { metadata: { etag: "etag-recovered" } }
        };
      }
      return { isError: false };
    }
  };

  await assert.rejects(
    smokeWriteBatchDelete(client, "db_private", "/Knowledge/response-loss.md"),
    /single response lost/u
  );
  assert.deepEqual(calls.map((call) => call.name), ["write_nodes", "read_path", "mutate_nodes_batch"]);
  assert.deepEqual(calls[2].arguments.operations, [
    {
      type: "delete",
      path: "/Knowledge/response-loss.md",
      expected_etag: "etag-recovered"
    }
  ]);
});

test("cleans every committed batch artifact when the batch response is lost", async () => {
  const mainPath = "/Knowledge/batch-response-loss.md";
  const committed = new Map();
  const deletedPaths = [];
  let initialContent;
  let writeCall = 0;
  const client = {
    async callTool(request) {
      if (request.name === "write_nodes") {
        writeCall += 1;
        if (writeCall === 1) {
          initialContent = request.arguments.nodes[0].content;
          return {
            isError: false,
            structuredContent: { results: [{ node: { etag: "etag-main" } }] }
          };
        }
        if (writeCall === 2) {
          return toolErrorResult({
            error: "etag_conflict",
            path: mainPath,
            current_etag: "etag-main",
            current_content: initialContent
          });
        }
        if (writeCall === 3) {
          return toolErrorResult({ error: "etag_conflict", path: mainPath, failed_index: 1 });
        }
        for (const [index, node] of request.arguments.nodes.entries()) {
          committed.set(node.path, { content: node.content, etag: `etag-batch-${index}` });
        }
        throw new Error("batch response lost");
      }
      if (request.name === "read_path") {
        if (request.arguments.path === mainPath) {
          return {
            isError: false,
            content: [{ type: "text", text: `Content:\n${initialContent}` }],
            structuredContent: { metadata: { etag: "etag-main" } }
          };
        }
        const artifact = committed.get(request.arguments.path);
        return artifact
          ? {
              isError: false,
              content: [{ type: "text", text: `Content:\n${artifact.content}` }],
              structuredContent: { metadata: { etag: artifact.etag } }
            }
          : toolErrorResult({ error: "node not found" });
      }
      deletedPaths.push(request.arguments.operations[0].path);
      return { isError: false };
    }
  };

  await assert.rejects(smokeWriteBatchDelete(client, "db_private", mainPath), /batch response lost/u);
  assert.deepEqual(new Set(deletedPaths), new Set([mainPath, ...committed.keys()]));
  assert.equal(committed.size, 2);
});

test("continues smoke cleanup after an individual delete failure", async () => {
  const calls = [];
  const client = {
    async callTool(request) {
      calls.push(request);
      return request.arguments.operations[0].path.endsWith("batch-a.md")
        ? { isError: true, content: [{ type: "text", text: "delete failed" }] }
        : { isError: false };
    }
  };

  const failureCount = await cleanupSmokeArtifacts(client, "db_private", [
    { path: "/Knowledge/batch-a.md", expectedContent: "marker:a", etag: "etag-a" },
    { path: "/Knowledge/batch-b.md", expectedContent: "marker:b", etag: "etag-b" }
  ]);

  assert.equal(failureCount, 1);
  assert.deepEqual(
    calls.map((call) => call.arguments.operations[0].path),
    ["/Knowledge/batch-a.md", "/Knowledge/batch-b.md"]
  );
});

test("recovers a missing cleanup etag only for marker-matched content", async () => {
  const deletedPaths = [];
  const client = {
    async callTool(request) {
      if (request.name === "read_path") {
        return request.arguments.path.endsWith("owned.md")
          ? {
              isError: false,
              content: [{ type: "text", text: "Content:\nsmoke-marker:owned" }],
              structuredContent: { metadata: { etag: "etag-owned" } }
            }
          : {
              isError: false,
              content: [{ type: "text", text: "Content:\nunrelated" }],
              structuredContent: { metadata: { etag: "etag-foreign" } }
            };
      }
      deletedPaths.push(request.arguments.operations[0].path);
      return { isError: false };
    }
  };

  const failureCount = await cleanupSmokeArtifacts(client, "db_private", [
    { path: "/Knowledge/owned.md", expectedContent: "smoke-marker:owned", etag: undefined },
    { path: "/Knowledge/foreign.md", expectedContent: "smoke-marker:foreign", etag: undefined }
  ]);

  assert.equal(failureCount, 1);
  assert.deepEqual(deletedPaths, ["/Knowledge/owned.md"]);
});

test("attempts every artifact cleanup when a batch result omits etags", async () => {
  const calls = [];
  const client = {
    async callTool(request) {
      calls.push(request);
      if (request.name === "read_path") {
        return {
          isError: false,
          content: [{ type: "text", text: `Content:\nowned-${request.arguments.path}` }],
          structuredContent: { metadata: { etag: `etag-${calls.length}` } }
        };
      }
      return { isError: false };
    }
  };

  const failureCount = await cleanupSmokeArtifacts(client, "db_private", [
    {
      path: "/Knowledge/marker-batch-a.md",
      expectedContent: "owned-/Knowledge/marker-batch-a.md",
      etag: undefined
    },
    {
      path: "/Knowledge/marker-batch-b.md",
      expectedContent: "owned-/Knowledge/marker-batch-b.md",
      etag: undefined
    }
  ]);

  assert.equal(failureCount, 0);
  assert.deepEqual(
    calls.map((call) =>
      `${call.name}:${call.name === "read_path" ? call.arguments.path : call.arguments.operations[0].path}`
    ),
    [
      "read_path:/Knowledge/marker-batch-a.md",
      "mutate_nodes_batch:/Knowledge/marker-batch-a.md",
      "read_path:/Knowledge/marker-batch-b.md",
      "mutate_nodes_batch:/Knowledge/marker-batch-b.md"
    ]
  );
});

test("preserves the primary smoke failure when cleanup also fails", () => {
  const primary = new Error("write_nodes returned an invalid result");
  const combined = smokeCompletionError(primary, 2);

  assert.equal(combined.cause, primary);
  assert.match(combined.message, /^write_nodes returned an invalid result;/u);
  assert.match(combined.message, /cleanup failed for 2 smoke artifact/u);
  assert.equal(smokeCompletionError(primary, 0), primary);
});

test("recognizes only the explicit read_path node not found error", () => {
  const toolError = (error) => ({
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ error }) }]
  });

  assert.equal(isReadPathNotFoundResult(toolError("node not found")), true);
  assert.equal(isReadPathNotFoundResult(toolError("not_found")), false);
  assert.equal(isReadPathNotFoundResult(toolError("invalid_token")), false);
  assert.equal(isReadPathNotFoundResult({ isError: true, content: [{ type: "text", text: "not JSON" }] }), false);
  assert.equal(isReadPathNotFoundResult({ isError: false }), false);
});

test("recognizes only the normalized mutation not_found error", () => {
  const toolError = (error) => ({
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ error }) }]
  });

  assert.equal(isMutationNotFoundResult(toolError("not_found")), true);
  assert.equal(isMutationNotFoundResult(toolError("node not found")), false);
  assert.equal(isMutationNotFoundResult(toolError("invalid_token")), false);
  assert.equal(isMutationNotFoundResult(toolError("etag_conflict")), false);
  assert.equal(isMutationNotFoundResult({ isError: true, content: [{ type: "text", text: "not JSON" }] }), false);
  assert.equal(isMutationNotFoundResult({ isError: false }), false);
});

test("does not treat authentication errors as completed cleanup", async () => {
  const calls = [];
  const client = {
    async callTool(request) {
      calls.push(request);
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify({ error: "invalid_token" }) }]
      };
    }
  };

  const failureCount = await cleanupSmokeArtifacts(client, "db_private", [
    { path: "/Knowledge/owned.md", expectedContent: "smoke-marker", etag: undefined }
  ]);

  assert.equal(failureCount, 1);
  assert.deepEqual(calls.map((call) => call.name), ["read_path"]);
});

test("treats a normalized mutation not_found result as completed cleanup", async () => {
  const client = {
    async callTool() {
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify({ error: "not_found" }) }]
      };
    }
  };

  const failureCount = await cleanupSmokeArtifacts(client, "db_private", [
    { path: "/Knowledge/already-absent.md", expectedContent: "smoke-marker", etag: "etag-old" }
  ]);

  assert.equal(failureCount, 0);
});

test("rejects the removed cleanup paths argument", () => {
  assert.throws(
    () => parseArgs(["--cleanup-paths", "/Knowledge/existing.md"]),
    /Invalid argument: --cleanup-paths/u
  );
});

test("accepts an explicit OAuth cache reset", () => {
  assert.equal(parseArgs(["--reset-auth"]).resetAuth, true);
  assert.equal(parseArgs([]).resetAuth, false);
});

test("keeps find_databases within the published schema limit", () => {
  assert.equal(FIND_DATABASE_LIMIT, 50);
});

test("requires OAuth-only read scopes and read-write scopes on batch mutations", () => {
  assert.doesNotThrow(() =>
    assertPrivateRequiredToolSecurity([
      {
        name: "find_databases",
        _meta: {
          securitySchemes: [{ type: "oauth2", scopes: ["mcp:read"] }]
        }
      },
      {
        name: "mutate_nodes_batch",
        _meta: {
          securitySchemes: [{ type: "oauth2", scopes: ["mcp:read", "mcp:write"] }]
        }
      }
    ])
  );
  assert.throws(
    () =>
      assertPrivateRequiredToolSecurity([
        {
          name: "find_databases",
          _meta: { securitySchemes: [{ type: "noauth" }] }
        }
      ]),
    /authentication metadata/u
  );
});
