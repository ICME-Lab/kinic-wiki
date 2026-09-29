// Where: extensions/wiki-clipper/tests/source-capture-request.test.mjs
// What: URL normalization tests for browser snapshots.
// Why: Extension-created raw sources must capture canonical HTTP(S) URLs.
import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CANISTER_ID, DEFAULT_IC_HOST, normalizedHttpUrl } from "../src/source-capture-request.js";
import { RUNTIME_DERIVATION_ORIGIN, RUNTIME_SOURCE_TRIGGER_URL, RUNTIME_WIKI_ORIGIN } from "../src/runtime-config.js";

test("production runtime defaults remain fixed", () => {
  assert.equal(DEFAULT_CANISTER_ID, "6emaw-iyaaa-aaaay-aacka-cai");
  assert.equal(DEFAULT_IC_HOST, "https://icp0.io");
  assert.equal(RUNTIME_DERIVATION_ORIGIN, "https://6emaw-iyaaa-aaaay-aacka-cai.icp0.io");
  assert.equal(RUNTIME_SOURCE_TRIGGER_URL, "https://wiki.kinic.xyz/api/source/run");
  assert.equal(RUNTIME_WIKI_ORIGIN, "https://wiki.kinic.xyz");
});

test("normalizedHttpUrl accepts only http and https", () => {
  assert.equal(normalizedHttpUrl("http://example.com/#x"), "http://example.com/");
  assert.equal(normalizedHttpUrl("https://example.com/#/page-a"), "https://example.com/#/page-a");
  assert.equal(normalizedHttpUrl("https://example.com/#!/page-b"), "https://example.com/#!/page-b");
  assert.throws(() => normalizedHttpUrl("chrome://extensions"), /http or https/);
});
