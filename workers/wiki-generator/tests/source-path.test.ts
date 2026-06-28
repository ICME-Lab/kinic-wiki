// Where: workers/wiki-generator/tests/source-path.test.ts
// What: Evidence source path validation tests.
// Why: Queueing invalid source paths should fail before VFS writes.
import assert from "node:assert/strict";
import test from "node:test";
import { sourceIdFromPath, validateCanonicalSourcePath } from "../src/source-path.js";

test("canonical evidence source path is accepted", () => {
  assert.doesNotThrow(() => validateCanonicalSourcePath("/Sources/chatgpt/alpha.md", "/Sources"));
  assert.doesNotThrow(() => validateCanonicalSourcePath("/Sources/web/会議-メモ-1a2b3c4d.md", "/Sources"));
  assert.equal(sourceIdFromPath("/Sources/chatgpt/alpha.md", "/Sources"), "chatgpt-alpha");
  assert.equal(sourceIdFromPath("/Sources/web/会議-メモ-1a2b3c4d.md", "/Sources"), "web-会議-メモ-1a2b3c4d");
});

test("non-canonical evidence source paths are rejected", () => {
  assert.throws(() => validateCanonicalSourcePath("/Sources/alpha/beta.txt", "/Sources"), /<provider>\/<id>\.md/);
  assert.throws(() => validateCanonicalSourcePath("/Sources/web-abc/web-abc.md", "/Sources"), /<provider>\/<id>\.md/);
  assert.throws(() => validateCanonicalSourcePath("/Sources/chatgpt/a..b.md", "/Sources"), /<provider>\/<id>\.md/);
  assert.throws(() => validateCanonicalSourcePath("/Sources/chatgpt/a/b.md", "/Sources"), /<provider>\/<id>\.md/);
  assert.throws(() => validateCanonicalSourcePath("/Sources/chatgpt/-abc.md", "/Sources"), /<provider>\/<id>\.md/);
  assert.throws(() => validateCanonicalSourcePath("/Sources/source-capture-requests/alpha.md", "/Sources"), /<provider>\/<id>\.md/);
  assert.throws(() => validateCanonicalSourcePath("/Sources/ingest-requests/alpha.md", "/Sources"), /<provider>\/<id>\.md/);
  assert.throws(() => validateCanonicalSourcePath("/Sourcesfoo/alpha/alpha.md", "/Sources"), /under/);
});
