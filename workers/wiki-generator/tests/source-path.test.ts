// Where: workers/wiki-generator/tests/source-path.test.ts
// What: Raw source path validation tests.
// Why: Queueing invalid source paths should fail before VFS writes.
import assert from "node:assert/strict";
import test from "node:test";
import { sourceIdFromPath, validateCanonicalSourcePath } from "../src/source-path.js";

test("canonical raw source path is accepted", () => {
  assert.doesNotThrow(() => validateCanonicalSourcePath("/Sources/raw/chatgpt/alpha.md", "/Sources/raw"));
  assert.equal(sourceIdFromPath("/Sources/raw/chatgpt/alpha.md", "/Sources/raw"), "chatgpt-alpha");
});

test("non-canonical raw source paths are rejected", () => {
  assert.throws(() => validateCanonicalSourcePath("/Sources/raw/alpha/beta.txt", "/Sources/raw"), /<provider>\/<id>\.md/);
  assert.throws(() => validateCanonicalSourcePath("/Sources/raw/web-abc/web-abc.md", "/Sources/raw"), /<provider>\/<id>\.md/);
  assert.throws(() => validateCanonicalSourcePath("/Sources/rawfoo/alpha/alpha.md", "/Sources/raw"), /under/);
});
