import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  assertPrivateRequiredToolSecurity,
  assertCallbackState,
  cleanupSmokeArtifacts,
  createOAuthState,
  FIND_DATABASE_LIMIT,
  isMutationNotFoundResult,
  isReadPathNotFoundResult,
  parseArgs,
  smokeCompletionError,
  smokeWriteBatchDelete,
  smokeTempPaths,
  summarizeToolResult
} from "./staging-smoke.mjs";

const packageConfig = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const productionConfig = JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
const stagingConfig = JSON.parse(readFileSync(new URL("../wrangler.staging.jsonc", import.meta.url), "utf8"));

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

test("keeps production public until promotion and isolates staging auth state", () => {
  assert.equal(productionConfig.vars.MCP_ACCESS_POLICY, "public");
  assert.equal(productionConfig.durable_objects, undefined);
  assert.equal(stagingConfig.vars.MCP_ACCESS_POLICY, "private_required");
  assert.equal(stagingConfig.durable_objects.bindings[0].name, "MCP_AUTH_STATE");
  assert.equal(stagingConfig.durable_objects.bindings[0].class_name, "McpAuthStateV3");
  assert.deepEqual(stagingConfig.ratelimits, [
    {
      name: "MCP_REGISTRATION_RATE_LIMIT",
      namespace_id: "7802026",
      simple: { limit: 10, period: 60 }
    }
  ]);
  assert.deepEqual(stagingConfig.migrations.at(-1), {
    tag: "v3",
    new_sqlite_classes: ["McpAuthStateV3"],
    deleted_classes: ["McpAuthStateV2"]
  });
  assert.notEqual(productionConfig.name, stagingConfig.name);
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
