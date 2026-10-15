// Where: wikibrowser/lib/browser-node-cache.ts
// What: Tiny in-memory cache helpers for the WikiBrowser reader pane.
// Why: Re-selecting already visited nodes should not repeat IC queries during one session.

import type { ChildNode, NodeContext, WikiNode } from "@/lib/types";

export type BrowserNodeCacheHit =
  | {
      kind: "node";
      context: NodeContext;
    }
  | {
      kind: "children";
      children: ChildNode[];
    };

export function readBrowserNodeCache(
  nodeContexts: Map<string, NodeContext>,
  childNodes: Map<string, ChildNode[]>,
  requestKey: string
): BrowserNodeCacheHit | null {
  const context = nodeContexts.get(requestKey);
  if (context) {
    return { kind: "node", context };
  }
  const children = childNodes.get(requestKey);
  if (children) {
    return { kind: "children", children };
  }
  return null;
}

// A description can be opened as a file or through its folder. Invalidate both
// representations, including the children fallback, before caching the saved read.
export function invalidateSavedBrowserNode(
  nodeContexts: Map<string, NodeContext>,
  childNodes: Map<string, ChildNode[]>,
  folderOverviews: Map<string, WikiNode | null>,
  requestKey: string
): void {
  nodeContexts.delete(requestKey);
  childNodes.delete(requestKey);
  folderOverviews.delete(requestKey);
}
