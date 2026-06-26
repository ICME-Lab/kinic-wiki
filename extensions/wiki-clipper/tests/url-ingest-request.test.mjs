// Where: extensions/wiki-clipper/tests/url-ingest-request.test.mjs
// What: URL normalization tests for browser snapshots.
// Why: Extension-created raw sources must capture canonical HTTP(S) URLs.
import assert from "node:assert/strict";
import test from "node:test";
import { normalizedHttpUrl } from "../src/url-ingest-request.js";

test("normalizedHttpUrl accepts only http and https", () => {
  assert.equal(normalizedHttpUrl("http://example.com/#x"), "http://example.com/");
  assert.throws(() => normalizedHttpUrl("chrome://extensions"), /http or https/);
});
