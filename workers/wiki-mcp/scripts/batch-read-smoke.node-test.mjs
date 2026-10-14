import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyBatchReads } from "./batch-read-smoke.mjs";

function fakeClient(failure) {
  const paths = ["/Knowledge/ordinary.md", "/Knowledge/routing--hash.md"];
  const nodes = paths.map((path, index) => ({
    id: `id-${index}`, text: `private body ${index}`,
    metadata: { path, etag: `etag-${index}`, truncated: false }
  }));
  return {
    async callTool({ name, arguments: args }) {
      const result = {
        results: structuredClone(name === "read_paths" ? args.paths.map(path => nodes[paths.indexOf(path)]) : nodes),
        ...(name === "read_paths" ? { metadata: { batch_error: null, parse_error_count: 0 } } : {})
      };
      if (name === failure?.tool && result.results.length > 1) failure.change(result);
      return { isError: false, structuredContent: result };
    }
  };
}

const paths = ["/Knowledge/ordinary.md", "/Knowledge/routing--hash.md"];
test("compares both batch tools against single-read controls", async () => {
  assert.deepEqual(await verifyBatchReads(fakeClient(), "db_test", paths), {
    verifiedPaths: 2, singleReads: true, readPaths: true, fetchMany: true
  });
});
for (const tool of ["read_paths", "fetch_many"]) {
  test(`rejects ${tool} item errors despite top-level success`, async () => {
    const client = fakeClient({ tool, change: (result) => { result.results[1] = { is_error: true, error: "SQL comments are not allowed" }; } });
    await assert.rejects(verifyBatchReads(client, "db_test", paths), /item 1 failed/);
  });
  test(`rejects ${tool} content mismatches without printing private text`, async () => {
    const client = fakeClient({ tool, change: (result) => { result.results[1].text = "other private content"; } });
    await assert.rejects(verifyBatchReads(client, "db_test", paths), (error) => {
      assert.match(error.message, /content mismatch/);
      assert.doesNotMatch(error.message, /private/);
      return true;
    });
  });
}
test("rejects a batch_error even when all item results are present", async () => {
  const client = fakeClient({ tool: "read_paths", change: (result) => { result.metadata.batch_error = "failed"; } });
  await assert.rejects(verifyBatchReads(client, "db_test", paths), /batch failed/);
});
