// Where: workers/wiki-generator/tests/link-preview.test.ts
// What: Link preview image renderer regression tests.
// Why: Keep the Worker renderer independent from Next.js while producing valid PNG responses.
import assert from "node:assert/strict";
import test from "node:test";
import { LINK_PREVIEW_CONTENT_TYPE, renderLinkPreviewImage } from "../src/link-preview.js";

test("link preview renderer returns a PNG without Next.js", async () => {
  const response = await renderLinkPreviewImage({
    title: "Ask AI",
    description: "Query a Kinic Wiki database."
  });
  const bytes = new Uint8Array(await response.arrayBuffer());

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), LINK_PREVIEW_CONTENT_TYPE);
  assert.deepEqual([...bytes.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
});
