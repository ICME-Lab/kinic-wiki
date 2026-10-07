"use client";

import type { Identity } from "@icp-sdk/core/agent";
import { useEffect, useMemo, useState } from "react";
import { WikiNavigationLink } from "@/components/wiki-navigation";
import { GitBranch } from "lucide-react";
import { displayPathForFolderIndex } from "@/lib/folder-index";
import { hrefForGraph, hrefForPath } from "@/lib/paths";
import { graphRequestKey } from "@/lib/request-keys";
import type { LinkEdge } from "@/lib/types";
import { graphLinks, graphNeighborhood } from "@/lib/vfs-client";
import { errorHint, errorMessage, type LoadState } from "@/lib/wiki-helpers";
import { ErrorBox } from "@/components/panel";

const GRAPH_LIMIT = 100;

type GraphNode = {
  path: string;
  x: number;
  y: number;
  r: number;
  isCenter: boolean;
};

type GraphLoadState = LoadState<LinkEdge[]> & {
  centerPath: string | null;
  requestKey: string | null;
};

export function GraphPanel({
  canisterId,
  databaseId,
  centerPath,
  depth,
  readIdentity
}: {
  canisterId: string;
  databaseId: string;
  centerPath: string | null;
  depth: 1 | 2;
  readIdentity: Identity | null;
}) {
  const readPrincipal = readIdentity?.getPrincipal().toText() ?? null;
  const isFullGraph = centerPath === null;
  const queryPath = isFullGraph ? "/Knowledge" : centerPath;
  const requestScope = isFullGraph ? `all:${queryPath}` : queryPath;
  const currentRequestKey = graphRequestKey(canisterId, databaseId, requestScope, depth, readPrincipal);
  const [links, setLinks] = useState<GraphLoadState>({ centerPath: null, requestKey: null, data: null, error: null, loading: false });
  const fullGraphHref = hrefForGraph(canisterId, databaseId, null);

  useEffect(() => {
    if (!queryPath) return;
    const requestKey = graphRequestKey(canisterId, databaseId, requestScope, depth, readPrincipal);
    let cancelled = false;
    const request = isFullGraph
      ? graphLinks(canisterId, databaseId, queryPath, GRAPH_LIMIT, readIdentity ?? undefined)
      : graphNeighborhood(canisterId, databaseId, queryPath, depth, GRAPH_LIMIT, readIdentity ?? undefined);
    request
      .then((data) => {
        if (!cancelled) setLinks({ centerPath: isFullGraph ? null : centerPath, requestKey, data, error: null, loading: false });
      })
      .catch((error: Error) => {
        if (!cancelled) setLinks({ centerPath: isFullGraph ? null : centerPath, requestKey, data: null, error: errorMessage(error), hint: errorHint(error), loading: false });
      });
    return () => {
      cancelled = true;
    };
  }, [canisterId, databaseId, centerPath, depth, isFullGraph, queryPath, readIdentity, readPrincipal, requestScope]);

  const currentLinks: LoadState<LinkEdge[]> =
    currentRequestKey && links.requestKey !== currentRequestKey ? { data: null, error: null, loading: true } : links;
  const graph = useMemo(() => buildGraph(currentLinks.data ?? [], isFullGraph ? null : centerPath), [centerPath, currentLinks.data, isFullGraph]);
  const edgeCount = currentLinks.data?.length ?? 0;
  const nodeCount = graph.nodes.length;
  const truncated = edgeCount >= GRAPH_LIMIT;

  if (currentLinks.error) return <div className="min-h-0 flex-1 p-5"><ErrorBox message={currentLinks.error} hint={currentLinks.hint} /></div>;
  if (currentLinks.loading) return <p className="min-h-0 flex-1 p-5 text-sm text-muted">Loading graph links...</p>;

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="mx-auto flex max-w-6xl flex-col gap-4 p-5">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-xl font-semibold tracking-[-0.02em] text-ink">
              <GitBranch aria-hidden className="text-muted" size={18} /> {isFullGraph ? "Database-wide graph" : "Local link graph"}
            </h2>
            <p className="mt-1 min-w-0 truncate font-mono text-xs text-muted">
              {isFullGraph ? "/Knowledge" : centerPath} · {countLabel(nodeCount, "node")} · {countLabel(edgeCount, "edge")}
              {truncated ? ` · first ${GRAPH_LIMIT} links` : ""}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {centerPath ? (
              <Segmented
                items={[
                  { label: "Local", href: hrefForGraph(canisterId, databaseId, centerPath, depth), active: !isFullGraph },
                  { label: "All", href: fullGraphHref, active: isFullGraph }
                ]}
              />
            ) : null}
            {!isFullGraph && centerPath ? (
              <Segmented
                items={[
                  { label: "Depth 1", href: hrefForGraph(canisterId, databaseId, centerPath, 1), active: depth === 1 },
                  { label: "Depth 2", href: hrefForGraph(canisterId, databaseId, centerPath, 2), active: depth === 2 }
                ]}
              />
            ) : null}
          </div>
        </header>
        <div className="relative overflow-hidden rounded-2xl border border-line bg-paper">
          {currentLinks.data?.length === 0 ? (
            <div className="flex min-h-[420px] flex-col items-center justify-center gap-3 p-8 text-center">
              <p className="text-base font-semibold text-ink">{isFullGraph ? "No indexed links found in this database." : "No indexed links around this page."}</p>
              <p className="max-w-md text-sm leading-6 text-muted">Link notes with <code className="font-mono">[[wiki links]]</code> or Markdown links and they will appear here.</p>
              {isFullGraph ? null : (
                <WikiNavigationLink className="rounded-full border border-line bg-white px-3 py-1.5 text-sm font-medium text-ink no-underline hover:border-midLine" href={fullGraphHref}>
                  Show database-wide graph
                </WikiNavigationLink>
              )}
            </div>
          ) : (
            <GraphCanvas canisterId={canisterId} databaseId={databaseId} edges={currentLinks.data ?? []} graph={graph} />
          )}
        </div>
      </div>
    </div>
  );
}

function Segmented({ items }: { items: { label: string; href: string; active: boolean }[] }) {
  return (
    <div className="inline-flex rounded-full border border-line bg-paper p-0.5 text-xs font-medium">
      {items.map((item) => (
        <WikiNavigationLink
          aria-current={item.active ? "page" : undefined}
          className={`rounded-full px-3 py-1 no-underline transition-colors ${item.active ? "bg-white text-ink shadow-card" : "text-muted hover:text-ink"}`}
          href={item.href}
          key={item.label}
        >
          {item.label}
        </WikiNavigationLink>
      ))}
    </div>
  );
}

function GraphCanvas({
  canisterId,
  databaseId,
  edges,
  graph
}: {
  canisterId: string;
  databaseId: string;
  edges: LinkEdge[];
  graph: BuiltGraph;
}) {
  const [hovered, setHovered] = useState<string | null>(null);
  const neighbors = hovered ? graph.neighbors.get(hovered) ?? new Set<string>() : null;
  const labelled = graph.labelled;
  return (
    <svg className="block h-[clamp(420px,62vh,720px)] w-full touch-none select-none" viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} onMouseLeave={() => setHovered(null)}>
      <title>Wiki link graph</title>
      <g>
        {edges.map((edge) => {
          const source = graph.byPath.get(edge.sourcePath);
          const target = graph.byPath.get(edge.targetPath);
          if (!source || !target) return null;
          const lit = hovered !== null && (edge.sourcePath === hovered || edge.targetPath === hovered);
          return (
            <line
              key={`${edge.sourcePath}-${edge.targetPath}-${edge.rawHref}`}
              stroke={lit ? "rgb(var(--brand-accent))" : "rgb(var(--ink))"}
              strokeOpacity={lit ? 0.7 : hovered ? 0.04 : 0.12}
              strokeWidth={lit ? 1.4 : 1}
              x1={source.x}
              x2={target.x}
              y1={source.y}
              y2={target.y}
            />
          );
        })}
      </g>
      {graph.nodes.map((node) => {
        const isHovered = hovered === node.path;
        const isNeighbor = neighbors?.has(node.path) ?? false;
        const dimmed = hovered !== null && !isHovered && !isNeighbor;
        const showLabel = node.isCenter || isHovered || isNeighbor || (hovered === null && labelled.has(node.path));
        const label = shortName(displayPathForFolderIndex(node.path));
        return (
          <WikiNavigationLink aria-label={label} href={hrefForPath(canisterId, databaseId, displayPathForFolderIndex(node.path))} key={node.path}>
            <g
              className="cursor-pointer transition-opacity duration-base"
              opacity={dimmed ? 0.18 : 1}
              onFocus={() => setHovered(node.path)}
              onMouseEnter={() => setHovered(node.path)}
            >
              <circle cx={node.x} cy={node.y} fill="transparent" r={node.r + 8} />
              <circle
                cx={node.x}
                cy={node.y}
                fill={node.isCenter || isHovered ? "rgb(var(--brand-accent))" : "rgb(var(--ink))"}
                fillOpacity={node.isCenter || isHovered ? 1 : 0.72}
                r={node.r}
                stroke="rgb(var(--paper))"
                strokeWidth={1.5}
              />
              {showLabel ? (
                <text
                  className="pointer-events-none fill-ink text-[11px] font-medium"
                  paintOrder="stroke"
                  stroke="rgb(var(--paper))"
                  strokeLinejoin="round"
                  strokeWidth={4}
                  textAnchor={node.x > VIEW_W / 2 ? "start" : "end"}
                  x={node.x > VIEW_W / 2 ? node.x + node.r + 5 : node.x - node.r - 5}
                  y={node.y + 4}
                >
                  {label}
                </text>
              ) : null}
            </g>
          </WikiNavigationLink>
        );
      })}
    </svg>
  );
}

const VIEW_W = 1000;
const VIEW_H = 640;

type BuiltGraph = {
  nodes: GraphNode[];
  byPath: Map<string, GraphNode>;
  neighbors: Map<string, Set<string>>;
  labelled: Set<string>;
};

// Deterministic force layout: same data always produces the same picture, no runtime animation cost.
function buildGraph(edges: LinkEdge[], centerPath: string | null): BuiltGraph {
  const pathSet = new Set(edges.flatMap((edge) => [edge.sourcePath, edge.targetPath]));
  if (centerPath) pathSet.add(centerPath);
  const paths = [...pathSet].sort((left, right) => {
    if (left === centerPath) return -1;
    if (right === centerPath) return 1;
    return left.localeCompare(right);
  });
  const neighbors = new Map<string, Set<string>>(paths.map((path) => [path, new Set<string>()]));
  for (const edge of edges) {
    if (edge.sourcePath === edge.targetPath) continue;
    neighbors.get(edge.sourcePath)?.add(edge.targetPath);
    neighbors.get(edge.targetPath)?.add(edge.sourcePath);
  }
  const count = paths.length;
  const cx = VIEW_W / 2;
  const cy = VIEW_H / 2;
  const area = (VIEW_W - 120) * (VIEW_H - 80);
  const k = Math.sqrt(area / Math.max(count, 1)) * 0.75;
  const index = new Map(paths.map((path, i) => [path, i]));
  // Golden-angle spiral seed keeps the start position stable and evenly spread.
  const pos = paths.map((path, i) => {
    if (path === centerPath) return { x: cx, y: cy };
    const r = 18 * Math.sqrt(i + 1) * (k / 30);
    const a = i * 2.399963;
    return { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r };
  });
  const links = edges
    .map((edge) => [index.get(edge.sourcePath), index.get(edge.targetPath)] as const)
    .filter((pair): pair is readonly [number, number] => pair[0] !== undefined && pair[1] !== undefined && pair[0] !== pair[1]);
  const iterations = count > 150 ? 160 : 260;
  let temperature = VIEW_W / 8;
  for (let step = 0; step < iterations; step += 1) {
    const disp = pos.map(() => ({ x: 0, y: 0 }));
    for (let i = 0; i < count; i += 1) {
      for (let j = i + 1; j < count; j += 1) {
        let dx = pos[i].x - pos[j].x;
        let dy = pos[i].y - pos[j].y;
        let dist = Math.hypot(dx, dy);
        if (dist < 0.01) {
          dx = 0.01 * (i - j);
          dy = 0.01;
          dist = 0.02;
        }
        const force = (k * k) / dist;
        disp[i].x += (dx / dist) * force;
        disp[i].y += (dy / dist) * force;
        disp[j].x -= (dx / dist) * force;
        disp[j].y -= (dy / dist) * force;
      }
    }
    for (const [a, b] of links) {
      const dx = pos[a].x - pos[b].x;
      const dy = pos[a].y - pos[b].y;
      const dist = Math.max(Math.hypot(dx, dy), 0.01);
      const force = (dist * dist) / k;
      disp[a].x -= (dx / dist) * force;
      disp[a].y -= (dy / dist) * force;
      disp[b].x += (dx / dist) * force;
      disp[b].y += (dy / dist) * force;
    }
    for (let i = 0; i < count; i += 1) {
      // Gentle gravity keeps disconnected islands on screen.
      disp[i].x -= (pos[i].x - cx) * 0.02 * k / 10;
      disp[i].y -= (pos[i].y - cy) * 0.02 * k / 10;
      if (paths[i] === centerPath) continue;
      const len = Math.max(Math.hypot(disp[i].x, disp[i].y), 0.01);
      pos[i].x += (disp[i].x / len) * Math.min(len, temperature);
      pos[i].y += (disp[i].y / len) * Math.min(len, temperature);
    }
    temperature *= 0.97;
  }
  // Fit to the viewport with padding for labels.
  const xs = pos.map((p) => p.x);
  const ys = pos.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const padX = 140;
  const padY = 48;
  const scale = Math.min((VIEW_W - padX * 2) / Math.max(maxX - minX, 1), (VIEW_H - padY * 2) / Math.max(maxY - minY, 1), 1.6);
  const offX = (VIEW_W - (maxX - minX) * scale) / 2;
  const offY = (VIEW_H - (maxY - minY) * scale) / 2;
  const maxDegree = Math.max(1, ...paths.map((path) => neighbors.get(path)?.size ?? 0));
  const nodes = paths.map((path, i) => {
    const degree = neighbors.get(path)?.size ?? 0;
    const isCenter = path === centerPath;
    return {
      path,
      x: count === 1 ? cx : offX + (pos[i].x - minX) * scale,
      y: count === 1 ? cy : offY + (pos[i].y - minY) * scale,
      r: isCenter ? 10 : 3.5 + 5 * Math.sqrt(degree / maxDegree),
      isCenter
    };
  });
  // Label only the most connected nodes when the graph is crowded; the rest appear on hover.
  const labelBudget = count <= 24 ? count : 10;
  const labelled = new Set(
    [...paths].sort((a, b) => (neighbors.get(b)?.size ?? 0) - (neighbors.get(a)?.size ?? 0)).slice(0, labelBudget)
  );
  return { nodes, byPath: new Map(nodes.map((node) => [node.path, node])), neighbors, labelled };
}

function shortName(path: string): string {
  return path.split("/").filter(Boolean).slice(-2).join("/");
}

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
