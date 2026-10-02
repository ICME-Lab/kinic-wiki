import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchPublicSeoPayload } from "./public-seo-http";
const body = {
  database: { metadata: { name: "Public", description: "Description" } },
  node: { content: "# Title", metadataJson: "{}" },
  children: [],
  childrenTruncated: false,
  hasContent: true,
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe("verifying public HTTP gateway", () => {
  it("uses the verified canister host, encoded path and no-store without HttpAgent", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(body));
    vi.stubGlobal("fetch", fetcher);
    expect(
      await fetchPublicSeoPayload(
        "6emaw-iyaaa-aaaay-aacka-cai",
        "db_alpha",
        "/Knowledge/日本語 #.md",
      ),
    ).toEqual(body);
    expect(fetcher).toHaveBeenCalledWith(
      "https://6emaw-iyaaa-aaaay-aacka-cai.icp0.io/api/wiki-seo/db_alpha/Knowledge/%E6%97%A5%E6%9C%AC%E8%AA%9E%20%23.md",
      expect.objectContaining({ cache: "no-store", redirect: "manual" }),
    );
  });
  it.each([404, 403, 500, 502])("fails closed on HTTP %i", async (status) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("Not found", { status })),
    );
    expect(
      await fetchPublicSeoPayload(
        "6emaw-iyaaa-aaaay-aacka-cai",
        "db_alpha",
        "/Knowledge",
      ),
    ).toBeNull();
  });
  it("rejects bad types, oversized payloads and links outside the folder", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    for (const invalid of [
      "html",
      { ...body, children: [{ path: "javascript:alert(1)", name: "bad" }] },
      { ...body, node: { content: "x".repeat(32001), metadataJson: "{}" } },
      { ...body, hasContent: "yes" },
    ]) {
      fetcher.mockResolvedValue(Response.json(invalid));
      expect(
        await fetchPublicSeoPayload(
          "6emaw-iyaaa-aaaay-aacka-cai",
          "db_alpha",
          "/Knowledge",
        ),
      ).toBeNull();
    }
    fetcher.mockRejectedValue(new TypeError("redirect disallowed"));
    expect(
      await fetchPublicSeoPayload(
        "6emaw-iyaaa-aaaay-aacka-cai",
        "db_alpha",
        "/Knowledge",
      ),
    ).toBeNull();
    expect(
      await fetchPublicSeoPayload(
        "evil.example/path-cai",
        "db_alpha",
        "/Knowledge",
      ),
    ).toBeNull();
  });
});
