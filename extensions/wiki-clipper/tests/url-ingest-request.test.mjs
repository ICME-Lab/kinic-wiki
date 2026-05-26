// Where: extensions/wiki-clipper/tests/url-ingest-request.test.mjs
// What: URL ingest request builder tests.
// Why: Extension-created requests must match the worker/browser contract.
import assert from "node:assert/strict";
import test from "node:test";
import { buildUrlIngestRequest, normalizedHttpUrl } from "../src/url-ingest-request.js";

test("buildUrlIngestRequest creates a file request with frontmatter", () => {
  const request = buildUrlIngestRequest({
    url: "https://example.com/post#section",
    requestedBy: "aaaaa-aa",
    now: new Date("2026-05-13T00:00:00.000Z"),
    uuid: "uuid-1"
  });
  assert.equal(request.requestPath, "/Sources/ingest-requests/1778630400000-uuid-1.md");
  assert.deepEqual(request.writeRequest.kind, { File: null });
  assert.equal(request.writeRequest.expectedEtag.length, 0);
  assert.match(request.writeRequest.content, /kind: kinic\.url_ingest_request/);
  assert.match(request.writeRequest.content, /status: queued/);
  assert.match(request.writeRequest.content, /url: "https:\/\/example\.com\/post"/);
  assert.match(request.writeRequest.content, /requested_by: "aaaaa-aa"/);
  assert.match(request.writeRequest.content, /claimed_at: null/);
  assert.match(request.writeRequest.content, /finished_at: null/);
  assert.deepEqual(JSON.parse(request.writeRequest.metadataJson), {
    request_type: "url_ingest",
    url: "https://example.com/post"
  });
});

test("normalizedHttpUrl accepts only http and https", () => {
  assert.equal(normalizedHttpUrl("http://example.com/#x"), "http://example.com/");
  assert.throws(() => normalizedHttpUrl("chrome://extensions"), /http or https/);
});
