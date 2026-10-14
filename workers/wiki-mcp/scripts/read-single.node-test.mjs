import assert from "node:assert/strict";
import test from "node:test";
import { readSingle } from "./read-single.mjs";

const path = "/Knowledge/page.md";
const node = { text: "\uFEFF本文\0😀", metadata: { path, etag: "v1" } };
function clientFor(result) {
  return {
    async callTool(request) {
      assert.deepEqual(request, {
        name: "read_paths",
        arguments: { database_id: "db", paths: [path] },
      });
      return result;
    },
  };
}

test("unwraps one successful item while preserving its display content and etag", async () => {
  const result = {
    content: [{ type: "text", text: `Content:\n${node.text}` }],
    structuredContent: { results: [node], metadata: { batch_error: null } },
  };
  const read = await readSingle(clientFor(result), "db", path);
  assert.equal(read.structuredContent, node);
  assert.equal(read.content, result.content);
});

test("promotes missing and permission item failures without inventing metadata", async () => {
  for (const error of [
    "node not found",
    "read failed: unauthorized",
    "response size exceeded",
  ]) {
    const result = {
      structuredContent: { results: [{ path, is_error: true, error }] },
    };
    const read = await readSingle(clientFor(result), "db", path);
    assert.equal(read.isError, true);
    assert.equal(read.structuredContent, undefined);
    assert.deepEqual(JSON.parse(read.content[0].text), { error });
  }
});

test("rejects malformed, mismatched and ambiguous results before callers can mutate", async () => {
  for (const structuredContent of [
    {},
    { results: [] },
    { results: [node, node] },
    { results: [node], metadata: { batch_error: "failed" } },
    { results: [{ ...node, metadata: { path: "/Other", etag: "v1" } }] },
    { results: [{ metadata: node.metadata }] },
    { results: [{ path: "/Other", is_error: true, error: "node not found" }] },
  ])
    await assert.rejects(
      readSingle(clientFor({ structuredContent }), "db", path),
      /read_paths/,
    );
});

test("preserves top-level authentication errors", async () => {
  const result = {
    isError: true,
    content: [{ type: "text", text: "unauthorized" }],
  };
  assert.equal(await readSingle(clientFor(result), "db", path), result);
});
