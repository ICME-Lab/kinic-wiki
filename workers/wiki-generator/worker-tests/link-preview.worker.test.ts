// Where: workers/wiki-generator/worker-tests/link-preview.worker.test.ts
// What: Renders a database link preview with the real Wasm modules in workerd.
// Why: The render path catches every error and serves a placeholder, so only a byte-level check inside the Workers runtime can tell whether rendering works.
import { afterEach, describe, expect, it } from "vitest";
import { decodeBase64, PLACEHOLDER_PNG_BASE64 } from "../src/assets.js";
import { LINK_PREVIEW_SIZE, renderLinkPreviewImage, setLinkPreviewDepsForTest } from "../src/link-preview.js";

const PNG_MAGIC = [137, 80, 78, 71, 13, 10, 26, 10];
const unreachableCdn: typeof fetch = async () => {
  throw new Error("CDN unreachable");
};

async function renderBytes(title: string): Promise<Uint8Array> {
  const response = await renderLinkPreviewImage({ title, description: "Query a Kinic Wiki database." });
  expect(response.status).toBe(200);
  return new Uint8Array(await response.arrayBuffer());
}

describe("database link preview rendering", () => {
  afterEach(() => setLinkPreviewDepsForTest());

  it("rasterizes a real PNG instead of serving the placeholder", async () => {
    // Use the bundled font so the result does not depend on CDN reachability.
    setLinkPreviewDepsForTest({ fetch: unreachableCdn });

    const bytes = await renderBytes("Ask AI");
    const placeholder = new Uint8Array(decodeBase64(PLACEHOLDER_PNG_BASE64));

    expect([...bytes.slice(0, 8)]).toEqual(PNG_MAGIC);
    expect(bytes).not.toEqual(placeholder);
    const ihdr = new DataView(bytes.buffer, bytes.byteOffset + 16, 8);
    expect({ width: ihdr.getUint32(0), height: ihdr.getUint32(4) }).toEqual(LINK_PREVIEW_SIZE);
  });

  it("draws the requested text into the image", async () => {
    setLinkPreviewDepsForTest({ fetch: unreachableCdn });

    const first = await renderBytes("Ask AI");
    const second = await renderBytes("A completely different database title");

    expect(second).not.toEqual(first);
  });
});
