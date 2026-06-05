"use client";

import Link from "next/link";
import { RefreshCw, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { marketListListings } from "@/lib/vfs-client";
import { formatTokenAmountFromE8s } from "@/lib/kinic-amount";
import type { MarketListing } from "@/lib/types";

type MarketplaceClientProps = {
  canisterId: string;
};

type LoadState = "idle" | "loading" | "error";

export function MarketplaceClient({ canisterId }: MarketplaceClientProps) {
  const [listings, setListings] = useState<MarketListing[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [state, setState] = useState<LoadState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return listings;
    return listings.filter((listing) => {
      return `${listing.title}\n${listing.description}\n${listing.tagsJson}`.toLowerCase().includes(needle);
    });
  }, [listings, query]);

  const load = useCallback(async (nextCursor: string | null, append: boolean) => {
    if (!canisterId) {
      setError("NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID is not configured");
      setState("error");
      return;
    }
    setState("loading");
    setError(null);
    try {
      const page = await marketListListings(canisterId, nextCursor, 24);
      setListings((current) => (append ? [...current, ...page.listings] : page.listings));
      setCursor(page.nextCursor);
      setState("idle");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setState("error");
    }
  }, [canisterId]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load(null, false);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  return (
    <main className="min-h-screen bg-white px-6 pb-10 pt-6 text-ink">
      <section className="mx-auto flex max-w-6xl flex-col gap-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">Marketplace</h1>
            <p className="text-sm text-muted">{filtered.length} listings</p>
          </div>
          <Link className="rounded-lg border border-line px-3 py-2 text-sm font-semibold hover:border-accent" href="/marketplace/wallet">
            Wallet
          </Link>
        </div>

        <div className="flex min-h-11 items-center gap-2 rounded-lg border border-line px-3">
          <Search aria-hidden size={18} />
          <input
            className="min-w-0 flex-1 bg-transparent py-2 text-sm outline-none"
            placeholder="Search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <button className="grid size-9 place-items-center rounded-lg hover:bg-paper" type="button" onClick={() => void load(null, false)}>
            <RefreshCw aria-label="Refresh" size={17} />
          </button>
        </div>

        {error ? <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p> : null}

        <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {filtered.map((listing) => (
            <Link
              className="grid min-h-48 gap-3 rounded-lg border border-line bg-white p-4 shadow-[0_8px_24px_#14142b0a] hover:border-accent"
              href={`/marketplace/${listing.listingId}`}
              key={listing.listingId}
            >
              <div className="grid gap-1">
                <h2 className="line-clamp-2 text-base font-semibold">{listing.title}</h2>
                <p className="line-clamp-3 text-sm text-muted">{listing.description}</p>
              </div>
              <div className="mt-auto flex items-center justify-between gap-3 text-sm">
                <span className="font-mono font-semibold">{formatTokenAmountFromE8s(listing.priceE8s)}</span>
                <span className="text-muted">{listing.purchaseCount} sold</span>
              </div>
            </Link>
          ))}
        </section>

        {cursor ? (
          <button
            className="mx-auto min-h-11 rounded-lg border border-line px-4 text-sm font-semibold hover:border-accent disabled:opacity-60"
            disabled={state === "loading"}
            type="button"
            onClick={() => void load(cursor, true)}
          >
            Load more
          </button>
        ) : null}
      </section>
    </main>
  );
}
