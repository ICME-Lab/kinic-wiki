"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AdminPanel } from "@/components/admin-ui";
import { formatTokenAmountFromE8s } from "@/lib/kinic-amount";
import { marketListingPath } from "@/lib/marketplace-routes";
import type { MarketListingView } from "@/lib/types";
import { marketListSellerListings } from "@/lib/vfs-client";
import { errorMessage } from "@/lib/wiki-helpers";

type SellerProfileClientProps = {
  canisterId: string;
  principal: string;
};

type LoadState = "idle" | "loading" | "error";

const LISTING_PAGE_LIMIT = 24;

export function SellerProfileClient({ canisterId, principal }: SellerProfileClientProps) {
  const [listings, setListings] = useState<MarketListingView[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState<string | null>(null);

  const purchases = useMemo(() => listings.reduce((total, view) => total + parseNonNegativeInteger(view.listing.purchaseCount), 0n), [listings]);

  const load = useCallback(
    async (nextCursor: string | null, append: boolean) => {
      if (!canisterId) {
        setError("NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID is not configured");
        setState("error");
        return;
      }
      setState("loading");
      setError(null);
      try {
        const page = await marketListSellerListings(canisterId, principal, nextCursor, LISTING_PAGE_LIMIT);
        setListings((current) => (append ? [...current, ...page.listings] : page.listings));
        setCursor(page.nextCursor);
        setState("idle");
      } catch (cause) {
        setError(errorMessage(cause));
        setState("error");
      }
    },
    [canisterId, principal]
  );

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load(null, false);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  return (
    <div className="min-w-0 text-ink">
      <section className="grid gap-5">
        <AdminPanel className="grid gap-3 bg-white" padding="sm">
          <div className="grid gap-1">
            <span className="text-xs font-semibold uppercase text-muted">Seller</span>
            <span className="break-all font-mono text-xs text-ink">{principal}</span>
          </div>
          <dl className="grid gap-2 sm:grid-cols-2">
            <SellerStat label="Loaded seller listings" value={listings.length.toString()} />
            <SellerStat label="Purchases" value={purchases.toString()} />
          </dl>
          <p className="text-xs text-muted">Stats use loaded seller marketplace listings.</p>
        </AdminPanel>

        {error ? <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p> : null}

        <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {listings.map((view) => (
            <Link className="no-underline" href={marketListingPath(view.listing.listingId)} key={view.listing.listingId}>
              <AdminPanel className="grid min-h-48 gap-3 bg-white hover:border-accent" padding="md">
                <div className="grid gap-1">
                  <h2 className="line-clamp-2 text-base font-semibold">{view.databaseMetadata.title}</h2>
                  <p className="line-clamp-3 text-sm text-muted">{view.databaseMetadata.description}</p>
                  <p className="break-all font-mono text-xs text-muted">Payout {view.listing.payoutPrincipal}</p>
                </div>
                <div className="mt-auto flex items-center justify-between gap-3 text-sm">
                  <span className="font-mono font-semibold">{formatTokenAmountFromE8s(view.listing.priceE8s)}</span>
                  <span className="text-muted">{view.listing.purchaseCount} sold</span>
                </div>
              </AdminPanel>
            </Link>
          ))}
        </section>

        {state !== "loading" && !listings.length ? <p className="rounded-lg border border-line bg-white px-3 py-2 text-sm text-muted">No public listings for this seller.</p> : null}

        {cursor ? (
          <button className="mx-auto min-h-11 rounded-lg border border-line px-4 text-sm font-semibold hover:border-accent disabled:opacity-60" disabled={state === "loading"} type="button" onClick={() => void load(cursor, true)}>
            Load more
          </button>
        ) : null}
      </section>
    </div>
  );
}

function SellerStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-line px-3 py-2">
      <dt className="text-xs font-semibold uppercase text-muted">{label}</dt>
      <dd className="mt-1 font-mono text-lg font-semibold">{value}</dd>
    </div>
  );
}

function parseNonNegativeInteger(value: string): bigint {
  return /^\d+$/.test(value) ? BigInt(value) : 0n;
}
