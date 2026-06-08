"use client";

import Link from "next/link";
import { CheckCircle2, CircleAlert, ShoppingCart } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAppSession } from "@/app/app-session-provider";
import { formatTokenAmountFromE8s } from "@/lib/kinic-amount";
import { hrefForPath } from "@/lib/paths";
import { marketGetListing, marketPurchaseAccess } from "@/lib/vfs-client";
import type { MarketCategoryGraph, MarketListingDetail, MarketListingVerifiedStats, MarketPreviewExcerpt } from "@/lib/types";

type ListingDetailClientProps = {
  canisterId: string;
  listingId: string;
};

type ActionState = "idle" | "loading" | "success" | "error";

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
    <main className="min-w-0 text-ink">
      <section className="grid max-w-5xl gap-5">
        <Link className="text-sm font-semibold text-accent hover:underline" href="/marketplace">
          Marketplace
        </Link>

        {listing && detail ? (
          <>
            <section className="grid gap-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="grid gap-2">
                  <h1 className="text-2xl font-semibold">{listing.title}</h1>
                  <p className="text-sm text-muted">{listing.description}</p>
                </div>
                <div className="rounded-lg border border-line px-3 py-2 text-right">
                  <p className="font-mono text-lg font-semibold">{formatTokenAmountFromE8s(listing.priceE8s)}</p>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {tags.map((tag) => (
                  <span className="rounded border border-line px-2 py-1 text-xs text-muted" key={tag}>
                    {tag}
                  </span>
                ))}
              </div>
            </section>

            {listing.llmSummary ? <p className="rounded-lg border border-line bg-paper p-3 text-sm">{listing.llmSummary}</p> : null}

            <VerifiedStats stats={detail.verifiedStats} />
            <ContentsSample paths={detail.preview.topLevelPaths} />
            <RelationshipGraph graph={detail.preview.categoryGraph} />
            <SampleExcerpts excerpts={detail.preview.excerpts} stale={detail.preview.previewStale} />

            <section className="flex flex-wrap items-center gap-3">
              <button
                className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-action bg-action px-4 py-2 text-sm font-semibold text-white hover:bg-accent disabled:opacity-60"
                disabled={!principal || purchaseState === "loading" || purchaseState === "success"}
                type="button"
                onClick={() => void purchase()}
              >
                <ShoppingCart aria-hidden size={17} />
                <span>{purchaseState === "success" ? "Purchased" : "Purchase access"}</span>
              </button>
              {!principal ? <span className="text-sm text-muted">Login with Internet Identity to purchase</span> : null}
              {purchaseState === "success" ? (
                <Link
                  className="inline-flex min-h-11 items-center rounded-lg border border-line px-4 py-2 text-sm font-semibold text-accent no-underline hover:border-accent"
                  href={hrefForPath(canisterId, listing.databaseId, "/Wiki")}
                >
                  Open database
                </Link>
              ) : null}
            </section>
          </>
        ) : null}

        {state === "loading" ? <p className="rounded-lg border border-line bg-paper px-3 py-2 text-sm">Loading</p> : null}
        {message ? <Notice tone={state === "error" || purchaseState === "error" ? "error" : "success"} text={message} /> : null}
      </section>
    </main>
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
    <section className="grid gap-3 rounded-lg border border-line p-3">
      <h2 className="text-sm font-semibold">Verified stats</h2>
      <dl className="grid gap-2 sm:grid-cols-2">
        {items.map(([label, value]) => (
          <div className="flex min-h-9 items-center justify-between gap-3 border-b border-line/70 py-1 text-sm last:border-b-0 sm:last:border-b" key={label}>
            <dt className="text-muted">{label}</dt>
            <dd className="font-mono text-xs font-semibold text-ink">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function ContentsSample({ paths }: { paths: string[] }) {
  return (
    <section className="grid gap-2 rounded-lg border border-line p-3">
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
    </section>
  );
}

function RelationshipGraph({ graph }: { graph: MarketCategoryGraph }) {
  const positioned = useMemo(() => {
    const centerX = 300;
    const centerY = 170;
    const radius = 115;
    return graph.nodes.map((node, index) => {
      const angle = graph.nodes.length <= 1 ? 0 : (Math.PI * 2 * index) / graph.nodes.length;
      return {
        ...node,
        x: centerX + Math.cos(angle) * radius,
        y: centerY + Math.sin(angle) * radius
      };
    });
  }, [graph.nodes]);
  const byCategory = useMemo(() => new Map(positioned.map((node) => [node.category, node])), [positioned]);
  return (
    <section className="grid gap-2 rounded-lg border border-line p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Relationship graph</h2>
        <span className="font-mono text-xs text-muted">
          {graph.nodes.length} categories / {graph.edges.length} edges
        </span>
      </div>
      {graph.nodes.length ? (
        <svg className="h-80 w-full rounded border border-line bg-paper" viewBox="0 0 600 340" role="img" aria-label="Marketplace relationship graph">
          {graph.edges.map((edge) => {
            const source = byCategory.get(edge.sourceCategory);
            const target = byCategory.get(edge.targetCategory);
            if (!source || !target) return null;
            return (
              <line
                key={`${edge.sourceCategory}-${edge.targetCategory}`}
                stroke="#b7b7b7"
                strokeWidth={Math.min(5, 1 + Number(edge.linkCount))}
                x1={source.x}
                x2={target.x}
                y1={source.y}
                y2={target.y}
              />
            );
          })}
          {positioned.map((node) => (
            <g key={node.category}>
              <circle cx={node.x} cy={node.y} fill="#111111" r="12" />
              <text className="fill-ink text-[11px]" x={node.x + 16} y={node.y + 4}>
                {shortCategory(node.category)}
              </text>
            </g>
          ))}
        </svg>
      ) : (
        <p className="text-sm text-muted">No public relationship graph.</p>
      )}
    </section>
  );
}

function SampleExcerpts({ excerpts, stale }: { excerpts: MarketPreviewExcerpt[]; stale: boolean }) {
  return (
    <section className="grid gap-2 rounded-lg border border-line p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Sample excerpts</h2>
        {stale ? <span className="rounded border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-900">stale preview</span> : null}
      </div>
      {excerpts.length ? (
        <ul className="grid gap-3">
          {excerpts.map((item) => (
            <li className="grid gap-1 border-b border-line pb-3 last:border-b-0 last:pb-0" key={`${item.path}-${item.etag}`}>
              <p className="font-mono text-xs text-muted">{item.path}</p>
              <p className="text-sm leading-6 text-ink">{item.excerpt}</p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">No public excerpts.</p>
      )}
    </section>
  );
}

function Notice({ tone, text }: { tone: "success" | "error"; text: string }) {
  const Icon = tone === "success" ? CheckCircle2 : CircleAlert;
  const className = tone === "success" ? "border-green-200 bg-green-50 text-green-800" : "border-red-200 bg-red-50 text-red-800";
  return (
    <p className={`inline-flex items-start gap-2 rounded-lg border px-3 py-2 text-sm ${className}`}>
      <Icon aria-hidden className="mt-0.5 shrink-0" size={16} />
      <span>{text}</span>
    </p>
  );
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

function shortCategory(path: string): string {
  return path.split("/").filter(Boolean).slice(-1)[0] ?? path;
}
