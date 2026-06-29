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
  assert.doesNotThrow(() => validateSourceRootPath("/Sources/a/b/c.md", "/Sources"));
});

test("source id is derived from file stem and relative path hash", () => {
  assert.match(sourceIdFromPath("/Sources/chatgpt/alpha.md", "/Sources"), /^alpha-[a-z0-9]+$/);
  assert.match(sourceIdFromPath("/Sources/raw/chatgpt/alpha.md", "/Sources"), /^alpha-[a-z0-9]+$/);
  assert.match(sourceIdFromPath("/Sources/web-abc/web-abc.md", "/Sources"), /^web-abc-[a-z0-9]+$/);
  assert.match(sourceIdFromPath("/Sources/loose.txt", "/Sources"), /^loose\.txt-[a-z0-9]+$/);
  assert.equal(sourceIdFromPath("/Sources/raw/web/abc.md", "/Sources"), sourceIdFromPath("/Sources/raw/web/abc.md", "/Sources"));
  assert.notEqual(sourceIdFromPath("/Sources/a/b/c.md", "/Sources"), sourceIdFromPath("/Sources/x/b/c.md", "/Sources"));
});

test("source path outside prefix is rejected", () => {
  assert.throws(() => validateSourceRootPath("/Sourcesfoo/alpha/alpha.md", "/Sources"), /under/);
  assert.throws(() => validateSourceRootPath("/Sources/", "/Sources"), /child/);
  assert.throws(() => validateSourceRootPath("/Sources//a.md", "/Sources"), /unsafe path segment/);
  assert.throws(() => validateSourceRootPath("/Sources/./a.md", "/Sources"), /unsafe path segment/);
  assert.throws(() => validateSourceRootPath("/Sources/a/../b.md", "/Sources"), /unsafe path segment/);
});
