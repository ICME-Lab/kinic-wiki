// Where: workers/wiki-generator/tests/source-path.test.ts
// What: Evidence source path validation tests.
// Why: Queueing invalid source paths should fail before VFS writes.
import assert from "node:assert/strict";
import test from "node:test";
import { sourceIdFromPath, validateCanonicalSourcePath } from "../src/source-path.js";

test("canonical evidence source path is accepted", () => {
  assert.doesNotThrow(() => validateCanonicalSourcePath("/Sources/evidence/chatgpt/alpha.md", "/Sources/evidence"));
  assert.equal(sourceIdFromPath("/Sources/evidence/chatgpt/alpha.md", "/Sources/evidence"), "chatgpt-alpha");
});

test("non-canonical evidence source paths are rejected", () => {
  assert.throws(() => validateCanonicalSourcePath("/Sources/evidence/alpha/beta.txt", "/Sources/evidence"), /<provider>\/<id>\.md/);
  assert.throws(() => validateCanonicalSourcePath("/Sources/evidence/web-abc/web-abc.md", "/Sources/evidence"), /<provider>\/<id>\.md/);
  assert.throws(() => validateCanonicalSourcePath("/Sources/evidence/chatgpt/a..b.md", "/Sources/evidence"), /<provider>\/<id>\.md/);
  assert.throws(() => validateCanonicalSourcePath("/Sources/evidencefoo/alpha/alpha.md", "/Sources/evidence"), /under/);
});
