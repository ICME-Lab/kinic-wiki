"use client";

import type { Identity } from "@icp-sdk/core/agent";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { GitBranch } from "lucide-react";
import { hrefForGraph, hrefForPath } from "@/lib/paths";
import { graphRequestKey } from "@/lib/request-keys";
import type { LinkEdge } from "@/lib/types";
import { graphNeighborhood } from "@/lib/vfs-client";
import { errorHint, errorMessage, type LoadState } from "@/lib/wiki-helpers";
import { ErrorBox } from "@/components/panel";

const GRAPH_LIMIT = 100;

type GraphNode = {
  path: string;
  x: number;
  y: number;
  isCenter: boolean;
};

type GraphLoadState = LoadState<LinkEdge[]> & {
  centerPath: string | null;
  requestKey: string | null;
};

export function GraphPanel({ canisterId, databaseId, centerPath, depth, readIdentity, readMode = null }: { canisterId: string; databaseId: string; centerPath: string | null; depth: 1 | 2; readIdentity: Identity | null; readMode?: "anonymous" | null }) {
  const readPrincipal = readIdentity?.getPrincipal().toText() ?? null;
  const currentRequestKey = graphRequestKey(canisterId, databaseId, centerPath, depth, readPrincipal);
  const [links, setLinks] = useState<GraphLoadState>({ centerPath: null, requestKey: null, data: null, error: null, loading: false });

  useEffect(() => {
    const requestKey = graphRequestKey(canisterId, databaseId, centerPath, depth, readPrincipal);
    if (!centerPath || !requestKey) {
      return;
    }
    let cancelled = false;
    graphNeighborhood(canisterId, databaseId, centerPath, depth, GRAPH_LIMIT, readIdentity ?? undefined)
      .then((data) => {
        if (!cancelled) setLinks({ centerPath, requestKey, data, error: null, loading: false });
      })
      .catch((error: Error) => {
        if (!cancelled) setLinks({ centerPath, requestKey, data: null, error: errorMessage(error), hint: errorHint(error), loading: false });
      });
    return () => {
      cancelled = true;
    };
  }, [canisterId, databaseId, centerPath, depth, readIdentity, readPrincipal]);

  const currentLinks: LoadState<LinkEdge[]> = !centerPath
    ? { data: null, error: null, loading: false }
    : currentRequestKey && links.requestKey !== currentRequestKey
      ? { data: null, error: null, loading: true }
      : links;
  const graph = useMemo(() => buildGraph(currentLinks.data ?? [], centerPath), [centerPath, currentLinks.data]);
  const edgeCount = currentLinks.data?.length ?? 0;
  const nodeCount = graph.nodes.length;
  const truncated = edgeCount >= GRAPH_LIMIT;

  if (currentLinks.error) return <div className="min-h-0 flex-1 p-5"><ErrorBox message={currentLinks.error} hint={currentLinks.hint} /></div>;
  if (currentLinks.loading) return <p className="min-h-0 flex-1 p-5 text-sm text-muted">Loading graph links...</p>;
  return (
    <div className="min-h-0 flex-1 overflow-auto p-5">
      <div className="mx-auto flex max-w-5xl flex-col gap-4">
        <div className="border-b border-line pb-4">
          <p className="font-mono text-xs uppercase tracking-[0.18em] text-muted">Graph</p>
          <h2 className="mt-1 flex items-center gap-2 text-2xl font-semibold tracking-[-0.04em]">
            <GitBranch size={20} /> Local link graph
          </h2>
          {centerPath ? (
            <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
              <span className="font-mono text-xs text-muted">{centerPath}</span>
              <span className="rounded-lg border border-line bg-white px-2 py-1 font-mono text-xs text-muted">{nodeCount} nodes</span>
              <span className="rounded-lg border border-line bg-white px-2 py-1 font-mono text-xs text-muted">{edgeCount} edges</span>
              <Link className={`rounded-lg border border-line px-2 py-1 no-underline ${depth === 1 ? "bg-accent text-white" : "bg-white text-ink"}`} href={hrefForGraph(canisterId, databaseId, centerPath, 1, readMode)}>
                depth 1
              </Link>
              <Link className={`rounded-lg border border-line px-2 py-1 no-underline ${depth === 2 ? "bg-accent text-white" : "bg-white text-ink"}`} href={hrefForGraph(canisterId, databaseId, centerPath, 2, readMode)}>
                depth 2
              </Link>
            </div>
          ) : null}
          {truncated ? (
            <p className="mt-2 text-sm text-muted">Limit reached. Showing first {GRAPH_LIMIT} neighborhood links only.</p>
          ) : null}
        </div>
        {!centerPath ? (
          <p className="rounded-xl border border-line bg-paper p-4 text-sm text-muted">Open Graph from a wiki page to inspect its local neighborhood.</p>
        ) : (
          <div className="rounded-2xl border border-line bg-paper p-4">
            <svg className="h-[520px] w-full" viewBox="0 0 920 520" role="img" aria-label="Wiki link graph">
              {currentLinks.data?.map((edge) => {
                const source = graph.byPath.get(edge.sourcePath);
                const target = graph.byPath.get(edge.targetPath);
                if (!source || !target) return null;
                return <line key={`${edge.sourcePath}-${edge.targetPath}-${edge.rawHref}`} x1={source.x} y1={source.y} x2={target.x} y2={target.y} stroke="#e6e6e6" strokeWidth="1.2" />;
              })}
              {graph.nodes.map((node) => (
                <Link key={node.path} href={hrefForPath(canisterId, databaseId, node.path, undefined, undefined, undefined, undefined, readMode)}>
                  <circle cx={node.x} cy={node.y} r={node.isCenter ? "16" : "12"} fill={node.isCenter ? "#ff2686" : "#000000"} />
                  <text x={node.x + 16} y={node.y + 4} className="fill-ink text-[11px]">
                    {shortName(node.path)}
                  </text>
                </Link>
              ))}
            </svg>
            {currentLinks.data?.length === 0 ? (
              <p className="mt-3 text-sm text-muted">No indexed links around this page.</p>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

function buildGraph(edges: LinkEdge[], centerPath: string | null): { nodes: GraphNode[]; byPath: Map<string, GraphNode> } {
  const pathSet = new Set(edges.flatMap((edge) => [edge.sourcePath, edge.targetPath]));
  if (centerPath) {
    pathSet.add(centerPath);
  }
  const paths = [...pathSet].sort((left, right) => {
    if (left === centerPath) return -1;
    if (right === centerPath) return 1;
    return left.localeCompare(right);
  });
  const centerX = 460;
  const centerY = 260;
  const radius = 190;
  const nodes = paths.map((path, index) => {
    if (path === centerPath) {
      return { path, x: centerX, y: centerY, isCenter: true };
    }
    const angle = paths.length <= 1 ? 0 : (Math.PI * 2 * index) / paths.length;
    return {
      path,
      x: centerX + Math.cos(angle) * radius,
      y: centerY + Math.sin(angle) * radius,
      isCenter: false
    };
  });
  return { nodes, byPath: new Map(nodes.map((node) => [node.path, node])) };
}

function shortName(path: string): string {
  return path.split("/").filter(Boolean).slice(-2).join("/");
}
