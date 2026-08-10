// Where: extensions/wiki-clipper/tests/source-capture-request.test.mjs
// What: URL normalization tests for browser snapshots.
// Why: Extension-created raw sources must capture canonical HTTP(S) URLs.
import assert from "node:assert/strict";
import test from "node:test";
import { normalizedHttpUrl } from "../src/source-capture-request.js";

test("normalizedHttpUrl accepts only http and https", () => {
  assert.equal(normalizedHttpUrl("http://example.com/#x"), "http://example.com/");
  assert.equal(normalizedHttpUrl("https://example.com/#/page-a"), "https://example.com/#/page-a");
  assert.equal(normalizedHttpUrl("https://example.com/#!/page-b"), "https://example.com/#!/page-b");
  assert.throws(() => normalizedHttpUrl("chrome://extensions"), /http or https/);
});
