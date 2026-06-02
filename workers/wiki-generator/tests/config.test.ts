// Where: workers/wiki-generator/tests/config.test.ts
// What: Runtime config parser regression tests.
// Why: Numeric env vars must reject unit suffixes instead of truncating them.
import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { testEnv, TestQueue } from "./url-ingest-fixtures.js";

test("loadConfig accepts only full positive integer byte limits", () => {
  const env = testEnv(new TestQueue());

  assert.equal(loadConfig({ ...env, KINIC_WIKI_WORKER_MAX_FETCHED_BYTES: "42" }).maxFetchedBytes, 42);
  assert.equal(loadConfig({ ...env, KINIC_WIKI_WORKER_MAX_FETCHED_BYTES: "5mb" }).maxFetchedBytes, 5_000_000);
  assert.equal(loadConfig({ ...env, KINIC_WIKI_WORKER_MAX_FETCHED_BYTES: "0" }).maxFetchedBytes, 5_000_000);
});
