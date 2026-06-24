// Where: workers/wiki-generator/tests/source-path.test.ts
// What: Raw source path validation tests.
// Why: Queueing invalid source paths should fail before VFS writes.
import assert from "node:assert/strict";
import test from "node:test";
import { sourceIdFromPath, validateCanonicalSourcePath } from "../src/source-path.js";

test("canonical raw source path is accepted", () => {
  assert.doesNotThrow(() => validateCanonicalSourcePath("/Sources/chatgpt/alpha.md", "/Sources"));
  assert.doesNotThrow(() => validateCanonicalSourcePath("/Sources/123/alpha.md", "/Sources"));
  assert.equal(sourceIdFromPath("/Sources/chatgpt/alpha.md", "/Sources"), "chatgpt-alpha");
});

test("non-canonical raw source paths are rejected", () => {
  assert.throws(() => validateCanonicalSourcePath("/Sources/alpha/beta.txt", "/Sources"), /<provider>\/<id>\.md/);
  assert.throws(() => validateCanonicalSourcePath("/Sources/web-abc/web-abc.md", "/Sources"), /<provider>\/<id>\.md/);
  assert.throws(() => validateCanonicalSourcePath("/Sources/chatgpt/a..b.md", "/Sources"), /<provider>\/<id>\.md/);
  assert.throws(() => validateCanonicalSourcePath("/Sources/raw/alpha.md", "/Sources"), /<provider>\/<id>\.md/);
  assert.throws(() => validateCanonicalSourcePath("/Sources/sessions/alpha.md", "/Sources"), /<provider>\/<id>\.md/);
  assert.throws(() => validateCanonicalSourcePath("/Sourcesfoo/alpha/alpha.md", "/Sources"), /under/);
});
