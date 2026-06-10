"use client";

import Link from "next/link";
import { ShoppingCart } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAppSession } from "@/app/app-session-provider";
import { AdminNotice, AdminPanel } from "@/components/admin-ui";
import { formatTokenAmountFromE8s } from "@/lib/kinic-amount";
import { hrefForPath } from "@/lib/paths";
import { marketSellerPath } from "@/lib/marketplace-routes";
import { marketGetListing, marketPurchaseAccess } from "@/lib/vfs-client";
import type { LinkEdge, MarketListingDetail, MarketListingVerifiedStats } from "@/lib/types";

const GRAPH_LIMIT = 100;

type ListingDetailClientProps = {
  canisterId: string;
  listingId: string;
};

type ActionState = "idle" | "loading" | "success" | "error";
type PageGraphNode = {
  path: string;
  x: number;
  y: number;
};

export function ListingDetailClient({ canisterId, listingId }: ListingDetailClientProps) {
  const { authClient, principal, refreshKinicBalance } = useAppSession();
  const [detail, setDetail] = useState<MarketListingDetail | null>(null);
  const [state, setState] = useState<ActionState>("loading");
  const [purchaseState, setPurchaseState] = useState<ActionState>("idle");
  const [message, setMessage] = useState<string | null>(null);

  const listing = detail?.listing ?? null;
  const tags = useMemo(() => parseJsonArray(listing?.tagsJson ?? "[]"), [listing]);

  const load = useCallback(async () => {
    setState("loading");
    setMessage(null);
    try {
      const nextListing = await marketGetListing(canisterId, listingId);
      setDetail(nextListing);
      setState("idle");
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause));
      setState("error");
    }
  }, [canisterId, listingId]);

  async function purchase() {
    if (!authClient || !principal || !listing) {
      setMessage("Login with Internet Identity first");
      setPurchaseState("error");
      return;
    }
    setPurchaseState("loading");
    setMessage(null);
    try {
      const identity = authClient.getIdentity();
      const order = await marketPurchaseAccess(canisterId, identity, listing.listingId, listing.priceE8s);
      await refreshKinicBalance();
      setMessage(`Order ${order.orderId}. KINIC balance updated. Access is ready.`);
      setPurchaseState("success");
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause));
      setPurchaseState("error");
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  return (
    <div className="min-w-0 text-ink">
      <section className="grid gap-5">
        {listing && detail ? (
          <>
            <section className="grid gap-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="grid gap-2">
                  <h1 className="text-2xl font-semibold">{listing.title}</h1>
                  <p className="text-sm text-muted">{listing.description}</p>
                  <Link className="break-all font-mono text-xs text-muted underline-offset-4 hover:text-accent hover:underline" href={marketSellerPath(listing.sellerPrincipal)}>
                    Seller {listing.sellerPrincipal}
                  </Link>
                </div>
                <div className="flex flex-wrap items-center justify-end gap-3 rounded-lg border border-line px-3 py-2 text-right">
                  <p className="font-mono text-lg font-semibold">{formatTokenAmountFromE8s(listing.priceE8s)}</p>
                  <button
                    className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-action bg-action px-3 py-2 text-sm font-semibold text-white hover:bg-accent disabled:opacity-60"
                    disabled={!principal || purchaseState === "loading" || purchaseState === "success"}
                    type="button"
                    onClick={() => void purchase()}
                  >
                    <ShoppingCart aria-hidden size={17} />
                    <span>{purchaseState === "success" ? "Purchased" : "Purchase access"}</span>
                  </button>
                  {purchaseState === "success" ? (
                    <Link
                      className="inline-flex min-h-10 items-center rounded-lg border border-line px-3 py-2 text-sm font-semibold text-accent no-underline hover:border-accent"
                      href={hrefForPath(canisterId, listing.databaseId, "/Wiki")}
                    >
                      Open database
                    </Link>
                  ) : null}
                </div>
              </div>
              {!principal ? <span className="text-sm text-muted">Login with Internet Identity to purchase</span> : null}
              <div className="flex flex-wrap gap-2">
                {tags.map((tag) => (
                  <span className="rounded border border-line px-2 py-1 text-xs text-muted" key={tag}>
                    {tag}
                  </span>
                ))}
              </div>
            </section>

            {listing.llmSummary ? <AdminPanel padding="sm"><p className="text-sm">{listing.llmSummary}</p></AdminPanel> : null}

            <VerifiedStats stats={detail.verifiedStats} />
            <ContentsSample paths={detail.preview.topLevelPaths} />
            <RelationshipGraph links={detail.preview.graphLinks} />
          </>
        ) : null}

        {state === "loading" ? <AdminNotice tone="info" message="Loading" /> : null}
        {message ? <Notice tone={state === "error" || purchaseState === "error" ? "error" : "success"} text={message} /> : null}
      </section>
    </div>
  );
}

function VerifiedStats({ stats }: { stats: MarketListingVerifiedStats }) {
  const items = [
    ["Wiki nodes", stats.wikiNodes],
    ["Source nodes", stats.sourceNodes],
    ["Folders", stats.folderNodes],
    ["Markdown chars", stats.markdownChars],
    ["Source chars", stats.sourceChars],
    ["Link edges", stats.linkEdges],
    ["Logical size", formatBytes(stats.logicalSizeBytes)],
    ["Last updated", formatDate(stats.lastContentUpdatedAtMs)]
  ];
  return (
    <AdminPanel className="grid gap-3" padding="sm">
      <h2 className="text-sm font-semibold">Verified stats</h2>
      <dl className="grid gap-2 sm:grid-cols-2">
        {items.map(([label, value]) => (
          <div className="flex min-h-9 items-center justify-between gap-3 border-b border-line/70 py-1 text-sm last:border-b-0 sm:last:border-b" key={label}>
            <dt className="text-muted">{label}</dt>
            <dd className="font-mono text-xs font-semibold text-ink">{value}</dd>
          </div>
        ))}
      </dl>
    </AdminPanel>
  );
}

function ContentsSample({ paths }: { paths: string[] }) {
  return (
    <AdminPanel className="grid gap-2" padding="sm">
      <h2 className="text-sm font-semibold">Contents sample</h2>
      {paths.length ? (
        <ul className="grid gap-2 text-sm text-muted">
          {paths.map((path) => (
            <li className="break-words font-mono text-xs" key={path}>
              {path}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">No public contents sample.</p>
      )}
    </AdminPanel>
  );
}

function RelationshipGraph({ links }: { links: LinkEdge[] }) {
  const graph = useMemo(() => buildPageGraph(links), [links]);
  const truncated = links.length >= GRAPH_LIMIT;

  return (
    <AdminPanel className="grid gap-2" padding="sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold">Relationship graph</h2>
          <span className="rounded border border-line bg-paper px-2 py-1 font-mono text-xs text-muted">Database-wide page graph</span>
        </div>
        <span className="font-mono text-xs text-muted">
          {graph.nodes.length} pages / {links.length} links
        </span>
      </div>
      {truncated ? <p className="text-sm text-muted">Showing first {GRAPH_LIMIT} links only.</p> : null}
      {graph.nodes.length ? (
        <svg className="h-80 w-full rounded border border-line bg-paper" viewBox="0 0 600 340" role="img" aria-label="Marketplace relationship graph">
          {links.map((edge) => {
            const source = graph.byPath.get(edge.sourcePath);
            const target = graph.byPath.get(edge.targetPath);
            if (!source || !target) return null;
            return (
              <line
                key={`${edge.sourcePath}-${edge.targetPath}-${edge.rawHref}`}
                stroke="#b7b7b7"
                strokeWidth="1.2"
                x1={source.x}
                x2={target.x}
                y1={source.y}
                y2={target.y}
              />
            );
          })}
          {graph.nodes.map((node) => (
            <g key={node.path}>
              <circle cx={node.x} cy={node.y} fill="#111111" r="12" />
              <text className="fill-ink text-[11px]" x={node.x + 16} y={node.y + 4}>
                {shortPath(node.path)}
              </text>
            </g>
          ))}
        </svg>
      ) : null}
      {!graph.nodes.length ? (
        <p className="text-sm text-muted">No indexed links found in this database.</p>
      ) : null}
    </AdminPanel>
  );
}

function buildPageGraph(links: LinkEdge[]): { nodes: PageGraphNode[]; byPath: Map<string, PageGraphNode> } {
  const paths = [...new Set(links.flatMap((edge) => [edge.sourcePath, edge.targetPath]))].sort((left, right) => left.localeCompare(right));
  const centerX = 300;
  const centerY = 170;
  const radius = 115;
  const nodes = paths.map((path, index) => {
    const angle = paths.length <= 1 ? 0 : (Math.PI * 2 * index) / paths.length;
    return {
      path,
      x: centerX + Math.cos(angle) * radius,
      y: centerY + Math.sin(angle) * radius
    };
  });
  return { nodes, byPath: new Map(nodes.map((node) => [node.path, node])) };
}

function Notice({ tone, text }: { tone: "success" | "error"; text: string }) {
  return <AdminNotice tone={tone} message={text} />;
}

function parseJsonArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function formatBytes(value: string): string {
  const bytes = Number(value);
  if (!Number.isFinite(bytes)) return value;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function formatDate(value: string | null): string {
  if (!value) return "-";
  const date = new Date(Number(value));
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleDateString();
}

function shortPath(path: string): string {
  return path.split("/").filter(Boolean).slice(-1)[0] ?? path;
}
