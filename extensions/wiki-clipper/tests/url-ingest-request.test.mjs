// Where: extensions/wiki-clipper/tests/url-ingest-request.test.mjs
// What: URL normalization tests for browser snapshots.
// Why: Extension-created evidence sources must capture canonical HTTP(S) URLs.
import assert from "node:assert/strict";
import test from "node:test";
import { buildUrlIngestRequest, normalizedHttpUrl, safeIngestRequestId } from "../src/url-ingest-request.js";

test("normalizedHttpUrl accepts only http and https", () => {
  assert.equal(normalizedHttpUrl("http://example.com/#x"), "http://example.com/");
  assert.throws(() => normalizedHttpUrl("chrome://extensions"), /http or https/);
});

test("safeIngestRequestId rejects non-canonical path segments", () => {
  assert.equal(safeIngestRequestId(123, "abc-DEF_123"), "123-abc-DEF_123");
  assert.throws(() => safeIngestRequestId(123, "../escape"), /request id/);
  assert.throws(() => safeIngestRequestId(123, "a..b"), /request id/);
});

test("buildUrlIngestRequest writes canonical request nodes", () => {
  const request = buildUrlIngestRequest({
    url: "https://example.com/page#ignored",
    requestedBy: "principal-1",
    now: new Date("2026-01-02T03:04:05.000Z"),
    uuid: "abc-123"
  });
  assert.equal(request.requestPath, "/Sources/ingest-requests/1767323045000-abc-123.md");
  assert.equal(request.writeRequest.path, request.requestPath);
  assert.equal(request.writeRequest.kind.File, null);
  assert.match(request.writeRequest.content, /kind: kinic\.url_ingest_request/);
  assert.match(request.writeRequest.content, /claimed_at: null/);
  assert.deepEqual(JSON.parse(request.writeRequest.metadataJson), {
    request_type: "url_ingest",
    url: "https://example.com/page"
  });
});
