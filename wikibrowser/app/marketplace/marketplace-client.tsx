"use client";

import Link from "next/link";
import { ArrowDownAZ, Clock3, Search, Sparkles, TrendingUp } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { ChangeEvent, FormEvent } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AdminPanel } from "@/components/admin-ui";
import { Input } from "@/components/ui/input";
import { marketListListings } from "@/lib/vfs-client";
import { formatTokenAmountFromE8s } from "@/lib/kinic-amount";
import { marketListingPath } from "@/lib/marketplace-routes";
import type { MarketListingView } from "@/lib/types";
import { errorMessage } from "@/lib/wiki-helpers";

type MarketplaceClientProps = {
  canisterId: string;
};

type LoadState = "idle" | "loading" | "error";

const QUICK_FILTERS: { label: string; params: Record<string, string> }[] = [
  { label: "All listings", params: {} }
];

const SORT_ITEMS = [
  { value: "recent", label: "Recent", icon: Clock3 },
  { value: "popular", label: "Popular", icon: TrendingUp },
  { value: "price_low", label: "Low price", icon: ArrowDownAZ }
] as const;

export function MarketplaceClient({ canisterId }: MarketplaceClientProps) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [listings, setListings] = useState<MarketListingView[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [state, setState] = useState<LoadState>("idle");
  const [error, setError] = useState<string | null>(null);
  const query = searchParams.get("q") ?? "";
  const sortParam = searchParams.get("sort") ?? "";
  const sort = parseMarketSort(sortParam);
  const max = searchParams.get("max") ?? "";
  const maxPriceE8s = parseKinicDecimalToE8s(max);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const nextListings = listings.filter((view) => {
      const metadata = view.databaseMetadata;
      if (needle && !`${metadata.title}\n${metadata.description}\n${metadata.tagsJson}`.toLowerCase().includes(needle)) {
        return false;
      }
      if (maxPriceE8s !== null && parseBigIntOrZero(view.listing.priceE8s) > maxPriceE8s) {
        return false;
      }
      return true;
    });
    return [...nextListings].sort((left, right) => compareListings(left, right, sort));
  }, [listings, maxPriceE8s, query, sort]);

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
      setError(errorMessage(cause));
      setState("error");
    }
  }, [canisterId]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load(null, false);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  function replaceParams(next: Record<string, string | null>) {
    const params = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(next)) {
      if (value === null || value === "") {
        params.delete(key);
      } else {
        params.set(key, value);
      }
    }
    const queryString = params.toString();
    const targetPath = pathname.startsWith("/marketplace/") ? "/marketplace" : pathname;
    router.replace(queryString ? `${targetPath}?${queryString}` : targetPath);
  }

  function runSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const nextQuery = String(formData.get("q") ?? "").trim();
    replaceParams({ q: nextQuery || null });
  }

  function updateMax(event: ChangeEvent<HTMLInputElement>) {
    const normalized = normalizeKinicDecimalInput(event.target.value);
    replaceParams({ max: normalized || null });
  }

  return (
    <div className="min-w-0 text-ink">
      <section className="flex flex-col gap-5">
        <MarketplaceFilterBar
          max={max}
          query={query}
          sort={sort}
          onMaxChange={updateMax}
          onReplaceParams={replaceParams}
          onSearch={runSearch}
        />

        {error ? <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p> : null}

        <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {filtered.map((view) => (
            <Link className="no-underline" href={marketListingPath(view.listing.listingId)} key={view.listing.listingId}>
              <AdminPanel className="grid min-h-48 gap-3 bg-white hover:border-accent" padding="md">
              <div className="grid gap-1">
                <h2 className="line-clamp-2 text-base font-semibold">{view.databaseMetadata.title}</h2>
                <p className="line-clamp-3 text-sm text-muted">{view.databaseMetadata.description}</p>
              </div>
              <div className="mt-auto flex items-center justify-between gap-3 text-sm">
                <span className="font-mono font-semibold">{formatTokenAmountFromE8s(view.listing.priceE8s)}</span>
                <span className="text-muted">{view.listing.purchaseCount} sold</span>
              </div>
              </AdminPanel>
            </Link>
          ))}
        </section>

        {state !== "loading" && !filtered.length && cursor ? <p className="rounded-lg border border-line bg-white px-3 py-2 text-sm text-muted">Load more may reveal additional matches.</p> : null}

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
    </div>
  );
}

function MarketplaceFilterBar({
  max,
  query,
  sort,
  onMaxChange,
  onReplaceParams,
  onSearch
}: {
  max: string;
  query: string;
  sort: MarketSort;
  onMaxChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onReplaceParams: (next: Record<string, string | null>) => void;
  onSearch: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <AdminPanel ariaLabel="Marketplace filters" className="grid gap-3" padding="sm">
      <form className="flex min-w-0 flex-col gap-2 lg:flex-row lg:items-center" onSubmit={onSearch}>
        <label className="sr-only" htmlFor="market-search">Search marketplace</label>
        <div className="flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-lg border border-line bg-white px-3 focus-within:border-accent">
          <Search aria-hidden className="shrink-0 text-muted" size={16} />
          <input id="market-search" className="min-w-0 flex-1 bg-transparent py-2 text-sm outline-none" name="q" placeholder="Filter loaded listings" defaultValue={query} />
        </div>
        <label className="sr-only" htmlFor="market-max-price">Max price</label>
        <Input id="market-max-price" className="h-10 rounded-lg bg-white font-mono text-xs lg:w-36" inputMode="decimal" placeholder="0.5 KINIC" value={max} onChange={onMaxChange} />
      </form>
      <p className="text-xs text-muted">Filters and sorting apply to loaded listings only.</p>

      <div className="flex flex-wrap gap-2">
        {QUICK_FILTERS.map((filter) => {
          const active = isQuickFilterActive(filter.params, { sort, query, max });
          return (
            <button
              className={`inline-flex min-h-9 items-center gap-2 rounded-lg px-3 text-sm font-semibold transition-colors ${active ? "bg-accent text-white" : "bg-white text-muted hover:bg-accentSoft hover:text-accentText"}`}
              key={filter.label}
              type="button"
              onClick={() => {
                if (filter.label === "All listings") {
                  onReplaceParams({ q: null, sort: null, max: null });
                } else {
                  onReplaceParams(filter.params);
                }
              }}
            >
              <span>{filter.label}</span>
              {active ? <Sparkles aria-hidden size={14} /> : null}
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap gap-2">
        {SORT_ITEMS.map((item) => {
          const Icon = item.icon;
          const active = sort === item.value;
          return (
            <button
              className={`inline-flex min-h-9 items-center gap-2 rounded-lg px-3 text-sm font-semibold transition-colors ${active ? "bg-accent text-white" : "bg-white text-muted hover:bg-accentSoft hover:text-accentText"}`}
              key={item.value}
              type="button"
              onClick={() => onReplaceParams({ sort: active ? null : item.value })}
            >
              <Icon aria-hidden size={16} />
              <span>{item.label}</span>
            </button>
          );
        })}
      </div>
    </AdminPanel>
  );
}

type MarketSort = "recent" | "popular" | "price_low";

function parseMarketSort(value: string | null): MarketSort {
  if (value === "popular" || value === "price_low") return value;
  return "recent";
}

function compareListings(left: MarketListingView, right: MarketListingView, sort: MarketSort): number {
  if (sort === "popular") {
    return compareBigIntDesc(parseBigIntOrZero(left.listing.purchaseCount), parseBigIntOrZero(right.listing.purchaseCount));
  }
  if (sort === "price_low") {
    return compareBigIntAsc(parseBigIntOrZero(left.listing.priceE8s), parseBigIntOrZero(right.listing.priceE8s));
  }
  return compareBigIntDesc(parseBigIntOrZero(left.listing.updatedAtMs || left.listing.createdAtMs), parseBigIntOrZero(right.listing.updatedAtMs || right.listing.createdAtMs));
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

function isQuickFilterActive(
  params: Record<string, string>,
  current: { sort: string; query: string; max: string }
): boolean {
  if (Object.keys(params).length === 0) {
    return !current.sort && !current.query && !current.max;
  }
  if (params.sort) return current.sort === params.sort;
  return false;
}

function normalizeKinicDecimalInput(value: string): string | null {
  const normalized = value.replace(/[^\d.]/g, "");
  const [whole = "", ...fractions] = normalized.split(".");
  const fraction = fractions.join("").slice(0, 8);
  if (!whole && !fraction) return null;
  return fraction ? `${whole || "0"}.${fraction}` : whole;
}
