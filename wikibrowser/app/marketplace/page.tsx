import type { Metadata } from "next";
import { Suspense } from "react";
import { MarketplaceClient } from "./marketplace-client";

export const metadata: Metadata = {
  title: "Kinic Marketplace",
  description: "Browse paid Kinic Wiki database access listings."
};

export default function MarketplacePage() {
  return (
    <Suspense fallback={<MarketplaceLoadingState />}>
      <MarketplaceClient canisterId={process.env.NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID || ""} />
    </Suspense>
  );
}

function MarketplaceLoadingState() {
  return (
    <div className="min-w-0 text-ink">
      <section className="flex flex-col gap-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="grid gap-2">
            <div className="h-8 w-40 rounded-lg bg-white" />
            <div className="h-4 w-56 rounded-lg bg-white" />
          </div>
          <div className="size-10 rounded-xl border border-line bg-white" />
        </div>
        <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          <div className="min-h-48 rounded-lg border border-line bg-white" />
          <div className="min-h-48 rounded-lg border border-line bg-white" />
          <div className="min-h-48 rounded-lg border border-line bg-white" />
        </section>
      </section>
    </div>
  );
}
