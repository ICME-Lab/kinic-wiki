// Where: workers/wiki-generator/tests/link-preview.test.ts
// What: Link preview module helpers, constants, and the render path with deps stubbed.
// Why: satori + a fake rasterizer exercise the full pipeline (font fetch, SVG layout,
//      PNG response) under plain node --test. The real @resvg/resvg-wasm rasterizer
//      stays runtime-only because its wasm only initializes in the Workers runtime.
import assert from "node:assert/strict";
import test from "node:test";
import {
  LINK_PREVIEW_CONTENT_TYPE,
  LINK_PREVIEW_SIZE,
  databaseLinkPreviewImageKey,
  renderLinkPreviewImage,
  setLinkPreviewDepsForTest
} from "../src/link-preview.js";
import { decodeBase64, FALLBACK_FONT_BASE64 } from "../src/assets.js";

const PNG_MAGIC = [137, 80, 78, 71, 13, 10, 26, 10];
const FAKE_PNG = new Uint8Array([...PNG_MAGIC, 1, 2, 3, 4]);

function fakeRasterizer() {
  return async () => ({
    Resvg: class {
      render() {
        return { asPng: () => FAKE_PNG };
      }
    }
  });
}

function failingFetch() {
  return async () => {
    throw new Error("CDN unreachable");
  };
}

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

test("renderLinkPreviewImage returns a PNG using the bundled fallback font when the CDN is unreachable", async () => {
  setLinkPreviewDepsForTest({ fetch: failingFetch(), loadResvg: fakeRasterizer() });
  const response = await renderLinkPreviewImage({ title: "Ask AI", description: "Query a Kinic Wiki database." });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), LINK_PREVIEW_CONTENT_TYPE);
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 8)], PNG_MAGIC);
  assert.deepEqual([...bytes], [...FAKE_PNG]);
});

test("renderLinkPreviewImage returns a PNG when the CDN font fetch succeeds", async () => {
  setLinkPreviewDepsForTest({
    fetch: async () => new Response(decodeBase64(FALLBACK_FONT_BASE64), { status: 200 }),
    loadResvg: fakeRasterizer()
  });
  const response = await renderLinkPreviewImage({ title: "Ask AI", description: "Query a Kinic Wiki database." });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), LINK_PREVIEW_CONTENT_TYPE);
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 8)], PNG_MAGIC);
  assert.deepEqual([...bytes], [...FAKE_PNG]);
});

test("renderLinkPreviewImage falls back to a placeholder PNG when the whole render fails", async () => {
  setLinkPreviewDepsForTest({
    fetch: failingFetch(),
    loadResvg: async () => {
      throw new Error("wasm init failed");
    }
  });
  const response = await renderLinkPreviewImage({ title: "Ask AI", description: "Query a Kinic Wiki database." });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), LINK_PREVIEW_CONTENT_TYPE);
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 8)], PNG_MAGIC);
  // The placeholder is the bundled static PNG, not the fake rasterizer output.
  assert.notDeepEqual([...bytes], [...FAKE_PNG]);
});