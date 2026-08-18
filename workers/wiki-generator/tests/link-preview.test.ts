// Where: workers/wiki-generator/tests/link-preview.test.ts
// What: Link preview module helpers and constants.
// Why: The full PNG render path uses satori + @resvg/resvg-wasm whose wasm only loads in the Workers
//      runtime (verified via `wrangler dev`), so it is not exercised under `node --test`.
import assert from "node:assert/strict";
import test from "node:test";
import {
  LINK_PREVIEW_CONTENT_TYPE,
  LINK_PREVIEW_SIZE,
  databaseLinkPreviewImageKey
} from "../src/link-preview.js";

test("link preview exposes PNG constants", () => {
  assert.equal(LINK_PREVIEW_CONTENT_TYPE, "image/png");
  assert.deepEqual(LINK_PREVIEW_SIZE, { width: 1200, height: 630 });
});

test("database link preview image key is namespaced and URL-encoded", () => {
  assert.equal(
    databaseLinkPreviewImageKey("db_active"),
    "db-link-preview/v1/db_active.png"
  );
  assert.equal(
    databaseLinkPreviewImageKey("db 1/2"),
    "db-link-preview/v1/db%201%2F2.png"
  );
});
