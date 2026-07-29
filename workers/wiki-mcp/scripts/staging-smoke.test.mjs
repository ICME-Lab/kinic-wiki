import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  assertCallbackState,
  createOAuthState,
  summarizeToolResult
} from "./staging-smoke.mjs";

const packageConfig = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const stagingConfig = JSON.parse(readFileSync(new URL("../wrangler.staging.jsonc", import.meta.url), "utf8"));

test("keeps staging on its canonical custom domain and permission-aware SDK", () => {
  assert.equal(stagingConfig.workers_dev, false);
  assert.deepEqual(stagingConfig.routes, [
    {
      pattern: "wiki-mcp-staging.kinic.xyz",
      custom_domain: true
    }
  ]);
  assert.equal(packageConfig.dependencies["@icp-sdk/core"], "6.0.0");
  assert.equal(packageConfig.scripts["dev:staging"], undefined);
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
