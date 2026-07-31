import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  assertPrivateOptInToolSecurity,
  assertCallbackState,
  createOAuthState,
  FIND_DATABASE_LIMIT,
  parseAuthenticationChallenge,
  summarizeToolResult,
  toolAuthenticationChallenge
} from "./staging-smoke.mjs";

const packageConfig = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const productionConfig = JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
const stagingConfig = JSON.parse(readFileSync(new URL("../wrangler.staging.jsonc", import.meta.url), "utf8"));

test("keeps staging on its canonical custom domain and permission-aware SDK", () => {
  assert.equal(stagingConfig.workers_dev, false);
  assert.deepEqual(stagingConfig.routes, [
    {
      pattern: "wiki-mcp-staging.kinic.xyz",
      custom_domain: true
    }
  ]);
  assert.equal(stagingConfig.vars.MCP_ACCESS_POLICY, "private_opt_in");
  assert.equal(stagingConfig.vars.MCP_AUTH_ENABLED, undefined);
  assert.equal(packageConfig.dependencies["@icp-sdk/core"], "6.0.0");
  assert.equal(packageConfig.scripts["dev:staging"], undefined);
});

test("keeps production public until promotion and isolates staging auth state", () => {
  assert.equal(productionConfig.vars.MCP_ACCESS_POLICY, "public");
  assert.equal(productionConfig.durable_objects, undefined);
  assert.equal(stagingConfig.vars.MCP_ACCESS_POLICY, "private_opt_in");
  assert.equal(stagingConfig.durable_objects.bindings[0].name, "MCP_AUTH_STATE");
  assert.equal(stagingConfig.durable_objects.bindings[0].class_name, "McpAuthStateV2");
  assert.deepEqual(stagingConfig.ratelimits, [
    {
      name: "MCP_REGISTRATION_RATE_LIMIT",
      namespace_id: "7802026",
      simple: { limit: 10, period: 60 }
    }
  ]);
  assert.deepEqual(stagingConfig.migrations.at(-1), {
    tag: "v2",
    new_sqlite_classes: ["McpAuthStateV2"],
    deleted_classes: ["McpAuthState"]
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

test("keeps find_databases within the published schema limit", () => {
  assert.equal(FIND_DATABASE_LIMIT, 50);
});

test("extracts the OAuth resource metadata from a tool-level challenge", () => {
  const challenge =
    'Bearer resource_metadata="https://wiki-mcp-staging.kinic.xyz/.well-known/oauth-protected-resource/mcp", error="insufficient_scope", error_description="Private connection is required"';
  const result = {
    isError: true,
    _meta: { "mcp/www_authenticate": [challenge] }
  };

  assert.equal(toolAuthenticationChallenge(result), challenge);
  assert.equal(
    parseAuthenticationChallenge(challenge).resourceMetadataUrl?.toString(),
    "https://wiki-mcp-staging.kinic.xyz/.well-known/oauth-protected-resource/mcp"
  );
});

test("requires optional OAuth on read tools and OAuth-only on connect_private", () => {
  assert.doesNotThrow(() =>
    assertPrivateOptInToolSecurity([
      {
        name: "find_databases",
        _meta: {
          securitySchemes: [
            { type: "noauth" },
            { type: "oauth2", scopes: ["mcp:read"] }
          ]
        }
      },
      {
        name: "connect_private",
        _meta: {
          securitySchemes: [{ type: "oauth2", scopes: ["mcp:read"] }]
        }
      }
    ])
  );
  assert.throws(
    () =>
      assertPrivateOptInToolSecurity([
        {
          name: "connect_private",
          _meta: { securitySchemes: [{ type: "noauth" }] }
        }
      ]),
    /authentication metadata/u
  );
});
