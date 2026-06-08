"use client";

import Link from "next/link";
import { RefreshCw } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { marketListListings } from "@/lib/vfs-client";
import { formatTokenAmountFromE8s } from "@/lib/kinic-amount";
import { marketListingPath } from "@/lib/marketplace-routes";
import type { MarketListing } from "@/lib/types";

type MarketplaceClientProps = {
  canisterId: string;
};

type LoadState = "idle" | "loading" | "error";

export function MarketplaceClient({ canisterId }: MarketplaceClientProps) {
  const searchParams = useSearchParams();
  const [listings, setListings] = useState<MarketListing[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [state, setState] = useState<LoadState>("idle");
  const [error, setError] = useState<string | null>(null);
  const query = searchParams.get("q") ?? "";
  const sort = parseMarketSort(searchParams.get("sort"));
  const maxPriceE8s = parseKinicDecimalToE8s(searchParams.get("max"));
  const previewOnly = searchParams.get("preview") === "1";

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const nextListings = listings.filter((listing) => {
      if (needle && !`${listing.title}\n${listing.description}\n${listing.tagsJson}`.toLowerCase().includes(needle)) {
        return false;
      }
      if (maxPriceE8s !== null && parseBigIntOrZero(listing.priceE8s) > maxPriceE8s) {
        return false;
      }
      if (previewOnly && !hasListingPreview(listing)) {
        return false;
      }
      return true;
    });
    return [...nextListings].sort((left, right) => compareListings(left, right, sort));
  }, [listings, maxPriceE8s, previewOnly, query, sort]);

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
    <main className="min-w-0 text-ink">
      <section className="flex max-w-none flex-col gap-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">Marketplace</h1>
            <p className="text-sm text-muted">
              {filtered.length} matching loaded listings from {listings.length} loaded
              {cursor ? " shown from loaded pages" : ""}
            </p>
          </div>
          <button className="grid size-10 place-items-center rounded-xl border border-line bg-white hover:border-accent hover:text-accent" type="button" onClick={() => void load(null, false)}>
            <RefreshCw aria-label="Refresh listings" size={17} />
          </button>
        </div>

        {error ? <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p> : null}

        <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {filtered.map((listing) => (
            <Link
              className="grid min-h-48 gap-3 rounded-lg border border-line bg-white p-4 shadow-[0_8px_24px_#14142b0a] hover:border-accent"
              href={marketListingPath(listing.listingId)}
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

type MarketSort = "recent" | "popular" | "price_low";

function parseMarketSort(value: string | null): MarketSort {
  if (value === "popular" || value === "price_low") return value;
  return "recent";
}

function compareListings(left: MarketListing, right: MarketListing, sort: MarketSort): number {
  if (sort === "popular") {
    return compareBigIntDesc(parseBigIntOrZero(left.purchaseCount), parseBigIntOrZero(right.purchaseCount));
  }
  if (sort === "price_low") {
    return compareBigIntAsc(parseBigIntOrZero(left.priceE8s), parseBigIntOrZero(right.priceE8s));
  }
  return compareBigIntDesc(parseBigIntOrZero(left.updatedAtMs || left.createdAtMs), parseBigIntOrZero(right.updatedAtMs || right.createdAtMs));
}

function compareBigIntAsc(left: bigint, right: bigint): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareBigIntDesc(left: bigint, right: bigint): number {
  return compareBigIntAsc(right, left);
}

function parseKinicDecimalToE8s(value: string | null): bigint | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!/^\d+(?:\.\d{1,8})?$/.test(trimmed)) return null;
  const [whole, fraction = ""] = trimmed.split(".");
  return BigInt(whole) * 100_000_000n + BigInt(fraction.padEnd(8, "0"));
}

function parseBigIntOrZero(value: string): bigint {
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

function hasListingPreview(listing: MarketListing): boolean {
  if (listing.llmSummary) return true;
  try {
    const parsed: unknown = JSON.parse(listing.sampleExcerptsJson);
    return Array.isArray(parsed) && parsed.length > 0;
  } catch {
    return false;
  }
}
