import { describe, expect, it } from "vitest";
import { invalidateSavedBrowserNode, readBrowserNodeCache } from "./browser-node-cache";
import { nodeRequestKey } from "./request-keys";
import type { ChildNode, NodeContext, WikiNode } from "./types";

function overview(content: string, etag: string): WikiNode {
  return { path: "/Knowledge/demo/overview.md", kind: "file", content, etag, createdAt: "0", updatedAt: "1", metadataJson: "{}" };
}
function context(node: WikiNode): NodeContext {
  return { node, incomingLinks: [], outgoingLinks: [] };
}
function visitedOverview() {
  const key = nodeRequestKey("canister", "db", "/Knowledge/demo/overview.md", "writer");
  const old = overview("Old description", "old-etag");
  return {
    key,
    nodeContexts: new Map<string, NodeContext>([[key, context(old)]]),
    childNodes: new Map<string, ChildNode[]>([[key, []]]),
    folderOverviews: new Map<string, WikiNode | null>([[key, old]])
  };
}

describe("saving a description through either editor", () => {
  it("forces a fresh file read after saving through the folder, including the empty-children fallback", () => {
    const cache = visitedOverview();
    const saved = overview("Saved through folder", "saved-etag");
    invalidateSavedBrowserNode(cache.nodeContexts, cache.childNodes, cache.folderOverviews, cache.key);
    cache.folderOverviews.set(cache.key, saved);

    // Opening overview.md must fetch the saved version instead of returning old
    // text or mistaking the cached empty children list for a virtual directory.
    expect(readBrowserNodeCache(cache.nodeContexts, cache.childNodes, cache.key)).toBeNull();
    cache.nodeContexts.set(cache.key, context(saved));
    expect(readBrowserNodeCache(cache.nodeContexts, cache.childNodes, cache.key)).toEqual({ kind: "node", context: context(saved) });
  });

  it("invalidates a cached missing or stale folder description after a file save", () => {
    for (const cached of [null, overview("Old description", "old-etag")]) {
      const cache = visitedOverview();
      cache.folderOverviews.set(cache.key, cached);
      const saved = overview("Saved as a file", "saved-etag");
      invalidateSavedBrowserNode(cache.nodeContexts, cache.childNodes, cache.folderOverviews, cache.key);
      cache.nodeContexts.set(cache.key, context(saved));

      // Missing from the map (unlike a cached null) makes the folder load its description again.
      expect(cache.folderOverviews.has(cache.key)).toBe(false);
      expect(readBrowserNodeCache(cache.nodeContexts, cache.childNodes, cache.key)).toEqual({ kind: "node", context: context(saved) });
    }
  });

  it("preserves caches for other principals and databases", () => {
    const cache = visitedOverview();
    const otherKeys = [nodeRequestKey("canister", "other-db", "/Knowledge/demo/overview.md", "writer"), nodeRequestKey("canister", "db", "/Knowledge/demo/overview.md", null)];
    for (const key of otherKeys) {
      cache.nodeContexts.set(key, context(overview("Other view", "other-etag")));
      cache.childNodes.set(key, []);
      cache.folderOverviews.set(key, null);
    }
    invalidateSavedBrowserNode(cache.nodeContexts, cache.childNodes, cache.folderOverviews, cache.key);
    for (const key of otherKeys) {
      expect(readBrowserNodeCache(cache.nodeContexts, cache.childNodes, key)?.kind).toBe("node");
      expect(cache.folderOverviews.has(key)).toBe(true);
    }
  });
});
