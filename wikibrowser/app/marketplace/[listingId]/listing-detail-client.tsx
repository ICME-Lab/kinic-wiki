"use client";

import Link from "next/link";
import { CheckCircle, Database, FileText, GitBranch, ShoppingCart, Tag, User } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useAppSession } from "@/app/app-session-provider";
import { AdminNotice, AdminPanel } from "@/components/admin-ui";
import { formatTokenAmountFromE8s } from "@/lib/kinic-amount";
import { purchaseMarketAccessWithWallet } from "@/lib/kinic-wallet";
import { hrefForPath } from "@/lib/paths";
import { marketSellerPath } from "@/lib/marketplace-routes";
import { marketGetListing, marketPreviewPurchase } from "@/lib/vfs-client";
import type { LinkEdge, MarketListing, MarketListingDetail, MarketListingVerifiedStats, MarketPreviewExcerpt } from "@/lib/types";
import { errorMessage } from "@/lib/wiki-helpers";

const GRAPH_LIMIT = 100;
type ListingDetailClientProps = {
  canisterId: string;
  listingId: string;
};

type ActionState = "idle" | "loading" | "success" | "error";
type DetailTab = "overview" | "contents" | "graph" | "details";
type PageGraphNode = {
  path: string;
  x: number;
  y: number;
};

export function ListingDetailClient({ canisterId, listingId }: ListingDetailClientProps) {
  const { authClient, principal, refreshWalletBalance, wallet, walletBusyProvider } = useAppSession();
  const [detail, setDetail] = useState<MarketListingDetail | null>(null);
  const [state, setState] = useState<ActionState>("loading");
  const [purchaseState, setPurchaseState] = useState<ActionState>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<DetailTab>("overview");

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
      setMessage(errorMessage(cause));
      setState("error");
    }
  }, [canisterId, listingId]);

  const loadPurchasePreview = useCallback(async () => {
    if (!authClient || !principal) {
      setPurchaseState("idle");
      return;
    }
    try {
      const preview = await marketPreviewPurchase(canisterId, authClient.getIdentity(), listingId);
      setPurchaseState(preview.alreadyEntitled ? "success" : "idle");
    } catch {
      setPurchaseState((current) => (current === "success" ? "success" : "idle"));
    }
  }, [authClient, canisterId, listingId, principal]);

  async function purchase() {
    if (!authClient || !principal || !listing) {
      setMessage("Login with Internet Identity first");
      setPurchaseState("error");
      return;
    }
    if (!wallet) {
      setMessage("Connect OISY or Plug first");
      setPurchaseState("error");
      return;
    }
    setPurchaseState("loading");
    setMessage(null);
    try {
      const preview = await marketPreviewPurchase(canisterId, authClient.getIdentity(), listing.listingId);
      if (preview.alreadyEntitled) {
        setMessage("Access is already active.");
        setPurchaseState("success");
        return;
      }
      if (preview.priceE8s !== listing.priceE8s) {
        setMessage("Listing price changed. Reload the listing before purchasing.");
        setPurchaseState("error");
        await load();
        return;
      }
      const order = await purchaseMarketAccessWithWallet({ canisterId, listingId: listing.listingId, priceE8s: BigInt(listing.priceE8s), accessPrincipal: principal }, wallet);
      setMessage(`Purchase complete. Ledger block ${order.ledgerBlockIndex}.`);
      await refreshWalletBalance(wallet);
      setPurchaseState("success");
    } catch (cause) {
      const message = errorMessage(cause);
      if (message.includes("active entitlement already exists")) {
        setMessage("Access is already active.");
        setPurchaseState("success");
        return;
      }
      setMessage(message);
      setPurchaseState("error");
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadPurchasePreview();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadPurchasePreview]);

  return (
    <div className="min-w-0 text-ink">
      <section className="grid gap-5">
        {listing && detail ? (
          <>
            <section className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
              <div className="min-w-0 space-y-4">
                <div className="grid gap-3">
                  {detail.preview.previewStale ? <span className="w-fit rounded border border-amber-200 bg-amber-50 px-2 py-1 text-xs font-semibold uppercase text-amber-950">Preview stale</span> : null}
                  <h1 className="break-words text-3xl font-semibold leading-tight text-ink">{listing.title}</h1>
                  <p className="max-w-3xl whitespace-pre-wrap text-sm leading-6 text-muted">{listing.description}</p>
                  <Link className="inline-flex max-w-full items-center gap-2 break-all font-mono text-xs text-muted underline-offset-4 hover:text-accent hover:underline" href={marketSellerPath(listing.sellerPrincipal)}>
                    <User aria-hidden className="shrink-0" size={14} />
                    <span>Seller {listing.sellerPrincipal}</span>
                  </Link>
                </div>

                <TagList tags={tags} />

                {listing.llmSummary ? (
                  <div className="border-l-2 border-line pl-3">
                    <p className="whitespace-pre-wrap text-sm leading-6 text-ink">{listing.llmSummary}</p>
                  </div>
                ) : null}
              </div>

              <aside className="grid content-start gap-4 rounded-lg border border-line bg-white p-4 shadow-sm">
                <div className="flex items-start justify-between gap-3 border-b border-line pb-4">
                  <div>
                    <p className="text-xs font-semibold uppercase text-muted">Price</p>
                    <p className="mt-2 font-mono text-2xl font-semibold text-ink">{formatTokenAmountFromE8s(listing.priceE8s)}</p>
                  </div>
                  {purchaseState === "success" ? <CheckCircle aria-hidden className="mt-1 text-green-700" size={20} /> : null}
                </div>
                <div className="grid gap-3">
                  <button
                    className="inline-flex min-h-11 w-full items-center justify-center gap-2 whitespace-nowrap rounded-lg border border-action bg-action px-3 py-2 text-sm font-semibold text-white hover:bg-accent disabled:opacity-60"
                    disabled={!principal || !wallet || walletBusyProvider !== null || purchaseState === "loading" || purchaseState === "success"}
                    type="button"
                    onClick={() => void purchase()}
                  >
                    <ShoppingCart aria-hidden size={17} />
                    <span>{purchaseState === "success" ? "Purchased" : "Purchase access"}</span>
                  </button>
                  {purchaseState === "success" ? (
                    <Link
                      className="inline-flex min-h-11 w-full items-center justify-center whitespace-nowrap rounded-lg border border-line px-3 py-2 text-sm font-semibold text-accent no-underline hover:border-accent"
                      href={hrefForPath(canisterId, listing.databaseId, "/Wiki")}
                    >
                      Open database
                    </Link>
                  ) : null}
                  {!principal ? <span className="text-sm leading-5 text-muted">Login with Internet Identity to purchase</span> : null}
                  {principal && !wallet ? <span className="text-sm leading-5 text-muted">Connect OISY or Plug to approve payment</span> : null}
                </div>
              </aside>
            </section>

            <section className="grid gap-3">
              <div className="flex gap-2 overflow-x-auto border-b border-line">
                <TabButton active={activeTab === "overview"} icon={<Database aria-hidden size={15} />} label="Overview" onClick={() => setActiveTab("overview")} />
                <TabButton active={activeTab === "contents"} icon={<FileText aria-hidden size={15} />} label="Contents" onClick={() => setActiveTab("contents")} />
                <TabButton active={activeTab === "graph"} icon={<GitBranch aria-hidden size={15} />} label="Graph" onClick={() => setActiveTab("graph")} />
                <TabButton active={activeTab === "details"} icon={<Tag aria-hidden size={15} />} label="Details" onClick={() => setActiveTab("details")} />
              </div>

              {activeTab === "overview" ? <OverviewPanel listing={listing} stats={detail.verifiedStats} /> : null}
              {activeTab === "contents" ? <ContentsPanel excerpts={detail.preview.excerpts} paths={detail.preview.topLevelPaths} /> : null}
              {activeTab === "graph" ? <RelationshipGraph links={detail.preview.graphLinks} /> : null}
              {activeTab === "details" ? <NodeSizeDetails excerpts={detail.preview.excerpts} /> : null}
            </section>
          </>
        ) : null}

        {state === "loading" ? <AdminNotice tone="info" message="Loading" /> : null}
        {message ? <Notice tone={state === "error" || purchaseState === "error" ? "error" : "success"} text={message} /> : null}
      </section>
    </div>
  );
}

function TabButton({ active, icon, label, onClick }: { active: boolean; icon: ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      className={`inline-flex min-h-10 items-center gap-2 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-semibold ${
        active ? "border-action text-ink" : "border-transparent text-muted hover:text-ink"
      }`}
      type="button"
      onClick={onClick}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

function OverviewPanel({ listing, stats }: { listing: MarketListing; stats: MarketListingVerifiedStats }) {
  const facts = [
    ["Wiki nodes", stats.wikiNodes],
    ["Source nodes", stats.sourceNodes],
    ["Folders", stats.folderNodes],
    ["Link edges", stats.linkEdges],
    ["Logical size", formatBytes(stats.logicalSizeBytes)],
    ["Last updated", formatDate(stats.lastContentUpdatedAtMs)],
    ["Purchases", listing.purchaseCount],
    ["Seller principal", listing.sellerPrincipal],
    ["Seller payout principal", listing.payoutPrincipal]
  ];
  return (
    <div className="grid max-w-4xl gap-4">
      <h2 className="text-lg font-semibold text-ink">Overview</h2>
      <dl className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {facts.map(([label, value]) => (
          <div className="rounded-lg border border-line bg-white px-3 py-3 shadow-sm" key={label}>
            <dt className="text-xs font-semibold uppercase text-muted">{label}</dt>
            <dd className="mt-1 break-all font-mono text-sm font-semibold text-ink">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function ContentsPanel({ excerpts, paths }: { excerpts: MarketPreviewExcerpt[]; paths: string[] }) {
  return (
    <div className="grid gap-3">
      <div>
        <h2 className="text-lg font-semibold text-ink">Contents</h2>
        <p className="mt-1 text-sm leading-6 text-muted">Preview excerpts and top-level paths exposed by the canister listing preview.</p>
      </div>
      {excerpts.length ? (
        <div className="overflow-x-auto rounded-lg border border-line bg-paper">
          <table className="w-full min-w-[720px] border-collapse text-left text-sm">
            <thead className="border-b border-line text-xs uppercase text-muted">
              <tr>
                <th className="px-3 py-2 font-semibold">Path</th>
                <th className="px-3 py-2 font-semibold">Etag</th>
                <th className="px-3 py-2 font-semibold">Excerpt</th>
              </tr>
            </thead>
            <tbody>
              {excerpts.map((excerpt) => (
                <tr className="border-b border-line/70 last:border-b-0" key={`${excerpt.path}:${excerpt.etag}`}>
                  <td className="max-w-[260px] break-words px-3 py-3 font-mono text-xs text-ink">{excerpt.path}</td>
                  <td className="px-3 py-3 font-mono text-xs text-muted">{excerpt.etag}</td>
                  <td className="px-3 py-3 text-muted">{excerpt.excerpt}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : paths.length ? (
        <AdminPanel className="grid gap-2" padding="sm">
          <h3 className="text-sm font-semibold">Top-level paths</h3>
          <ul className="grid gap-2 text-sm text-muted">
            {paths.map((path) => (
              <li className="break-words font-mono text-xs" key={path}>
                {path}
              </li>
            ))}
          </ul>
        </AdminPanel>
      ) : (
        <p className="text-sm text-muted">No public contents sample.</p>
      )}
    </div>
  );
}

function NodeSizeDetails({ excerpts }: { excerpts: MarketPreviewExcerpt[] }) {
  return (
    <div className="grid gap-3">
      <div>
        <h2 className="text-lg font-semibold text-ink">Details</h2>
        <p className="mt-1 text-sm leading-6 text-muted">Wiki node character counts from the canister listing preview.</p>
      </div>
      {excerpts.length ? (
        <div className="overflow-x-auto rounded-lg border border-line bg-paper">
          <table className="w-full min-w-[620px] border-collapse text-left text-sm">
            <thead className="border-b border-line text-xs uppercase text-muted">
              <tr>
                <th className="px-3 py-2 font-semibold">Path</th>
                <th className="px-3 py-2 text-right font-semibold">Chars</th>
                <th className="px-3 py-2 font-semibold">Excerpt</th>
              </tr>
            </thead>
            <tbody>
              {excerpts.map((excerpt) => (
                <tr className="border-b border-line/70 last:border-b-0" key={`${excerpt.path}:${excerpt.etag}`}>
                  <td className="max-w-[280px] break-words px-3 py-3 font-mono text-xs text-ink">{excerpt.path}</td>
                  <td className="px-3 py-3 text-right font-mono text-xs font-semibold text-ink">{formatInteger(excerpt.contentChars)}</td>
                  <td className="px-3 py-3 text-muted">{excerpt.excerpt}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-sm text-muted">No Wiki node size details.</p>
      )}
    </div>
  );
}

function TagList({ tags }: { tags: string[] }) {
  if (!tags.length) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {tags.map((tag) => (
        <span className="inline-flex items-center gap-1 rounded border border-line px-2 py-1 text-xs text-muted" key={tag}>
          <Tag aria-hidden size={12} />
          {tag}
        </span>
      ))}
    </div>
  );
}

function RelationshipGraph({ links }: { links: LinkEdge[] }) {
  const visibleLinks = useMemo(() => links.slice(0, GRAPH_LIMIT), [links]);
  const graph = useMemo(() => buildPageGraph(visibleLinks), [visibleLinks]);
  const truncated = links.length > GRAPH_LIMIT;

  return (
    <AdminPanel className="grid gap-2" padding="sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold">Relationship graph</h2>
          <span className="rounded border border-line bg-paper px-2 py-1 font-mono text-xs text-muted">Database-wide page graph</span>
        </div>
        <span className="font-mono text-xs text-muted">
          {graph.nodes.length} pages / {visibleLinks.length} links
        </span>
      </div>
      {truncated ? <p className="text-sm text-muted">Showing first {GRAPH_LIMIT} links only.</p> : null}
      {graph.nodes.length ? (
        <svg className="h-80 w-full rounded border border-line bg-paper" viewBox="0 0 600 340" role="img" aria-label="Marketplace relationship graph">
          {visibleLinks.map((edge) => {
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

function formatInteger(value: string): string {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? new Intl.NumberFormat().format(numberValue) : value;
}

function shortPath(path: string): string {
  return path.split("/").filter(Boolean).slice(-1)[0] ?? path;
}
