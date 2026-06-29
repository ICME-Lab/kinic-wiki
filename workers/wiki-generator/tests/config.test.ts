// Where: workers/wiki-generator/tests/config.test.ts
// What: Runtime config parser regression tests.
// Why: Numeric env vars must reject unit suffixes instead of truncating them.
import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { testEnv, TestQueue } from "./source-capture-fixtures.js";

test("loadConfig accepts only full positive integer byte limits", () => {
  const env = testEnv(new TestQueue());

  assert.equal(loadConfig({ ...env, KINIC_WIKI_WORKER_MAX_FETCHED_BYTES: "42" }).maxFetchedBytes, 42);
  assert.equal(loadConfig({ ...env, KINIC_WIKI_WORKER_MAX_FETCHED_BYTES: "5mb" }).maxFetchedBytes, 5_000_000);
  assert.equal(loadConfig({ ...env, KINIC_WIKI_WORKER_MAX_FETCHED_BYTES: "0" }).maxFetchedBytes, 5_000_000);
});

test("loadConfig defaults context prefix to database root", () => {
  const env = testEnv(new TestQueue());
  delete env.KINIC_WIKI_WORKER_CONTEXT_PREFIX;

  assert.equal(loadConfig(env).contextPrefix, "/");
});

test("loadConfig respects explicit context prefix override", () => {
  const env = testEnv(new TestQueue());

  assert.equal(loadConfig({ ...env, KINIC_WIKI_WORKER_CONTEXT_PREFIX: "/Knowledge" }).contextPrefix, "/Knowledge");
});

test("loadConfig normalizes worker root prefixes", () => {
  const env = testEnv(new TestQueue());
  const config = loadConfig({
    ...env,
    KINIC_WIKI_WORKER_SOURCE_PREFIX: " /Sources/ ",
    KINIC_WIKI_WORKER_TARGET_ROOT: "/Knowledge/conversations/",
    KINIC_WIKI_WORKER_CONTEXT_PREFIX: "/Knowledge/"
  });

  assert.equal(config.sourcePrefix, "/Sources");
  assert.equal(config.targetRoot, "/Knowledge/conversations");
  assert.equal(config.contextPrefix, "/Knowledge");
});

test("loadConfig rejects non-absolute and root-only worker roots", () => {
  const env = testEnv(new TestQueue());

  assert.throws(() => loadConfig({ ...env, KINIC_WIKI_WORKER_SOURCE_PREFIX: "Sources" }), /absolute path/);
  assert.throws(() => loadConfig({ ...env, KINIC_WIKI_WORKER_SOURCE_PREFIX: "/" }), /must not be database root/);
  assert.throws(() => loadConfig({ ...env, KINIC_WIKI_WORKER_TARGET_ROOT: "Knowledge/conversations" }), /absolute path/);
  assert.throws(() => loadConfig({ ...env, KINIC_WIKI_WORKER_TARGET_ROOT: "/" }), /must not be database root/);
});
