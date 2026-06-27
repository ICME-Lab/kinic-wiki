// Where: workers/wiki-generator/tests/source-path.test.ts
// What: Raw source path prefix and source id tests.
// Why: Queueing stays under the configured source root without imposing a source schema.
import assert from "node:assert/strict";
import test from "node:test";
import { sourceIdFromPath, validateSourceRootPath } from "../src/source-path.js";

test("source path under prefix is accepted", () => {
  assert.doesNotThrow(() => validateSourceRootPath("/Sources/chatgpt/alpha.md", "/Sources"));
  assert.doesNotThrow(() => validateSourceRootPath("/Sources/123/alpha.md", "/Sources"));
  assert.doesNotThrow(() => validateSourceRootPath("/Sources/raw/chatgpt/alpha.md", "/Sources"));
  assert.doesNotThrow(() => validateSourceRootPath("/Sources/web-abc/web-abc.md", "/Sources"));
});

test("source id is derived from nearest parent and file stem", () => {
  assert.equal(sourceIdFromPath("/Sources/chatgpt/alpha.md", "/Sources"), "chatgpt-alpha");
  assert.equal(sourceIdFromPath("/Sources/raw/chatgpt/alpha.md", "/Sources"), "chatgpt-alpha");
  assert.equal(sourceIdFromPath("/Sources/web-abc/web-abc.md", "/Sources"), "web-abc-web-abc");
  assert.equal(sourceIdFromPath("/Sources/loose.txt", "/Sources"), "loose.txt");
});

test("source path outside prefix is rejected", () => {
  assert.throws(() => validateSourceRootPath("/Sourcesfoo/alpha/alpha.md", "/Sources"), /under/);
  assert.throws(() => validateSourceRootPath("/Sources/", "/Sources"), /child/);
});
