"use client";

import Link from "next/link";
import { CheckCircle2, CircleAlert, ShoppingCart } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAppSession } from "@/app/app-session-provider";
import { purchaseMarketAccessWithOisy, purchaseMarketAccessWithPlug } from "@/lib/kinic-wallet";
import { formatTokenAmountFromE8s } from "@/lib/kinic-amount";
import { marketGetListing } from "@/lib/vfs-client";
import type { MarketListing } from "@/lib/types";

type ListingDetailClientProps = {
  canisterId: string;
  listingId: string;
};

type ActionState = "idle" | "loading" | "success" | "error";

export function ListingDetailClient({ canisterId, listingId }: ListingDetailClientProps) {
  const { refreshWalletBalance, wallet } = useAppSession();
  const [listing, setListing] = useState<MarketListing | null>(null);
  const [state, setState] = useState<ActionState>("loading");
  const [purchaseState, setPurchaseState] = useState<ActionState>("idle");
  const [message, setMessage] = useState<string | null>(null);

  const samples = useMemo(() => parseJsonArray(listing?.sampleQuestionsJson ?? "[]"), [listing]);
  const excerpts = useMemo(() => parseJsonArray(listing?.sampleExcerptsJson ?? "[]"), [listing]);
  const tags = useMemo(() => parseJsonArray(listing?.tagsJson ?? "[]"), [listing]);

  const load = useCallback(async () => {
    setState("loading");
    setMessage(null);
    try {
      const nextListing = await marketGetListing(canisterId, listingId);
      setListing(nextListing);
      setState("idle");
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause));
      setState("error");
    }
  }, [canisterId, listingId]);

  async function purchase() {
    if (!wallet || !listing) {
      setMessage("Connect OISY or Plug first");
      setPurchaseState("error");
      return;
    }
    setPurchaseState("loading");
    setMessage(null);
    try {
      const order =
        wallet.provider === "oisy"
          ? await purchaseMarketAccessWithOisy(
              {
                canisterId,
                listingId: listing.listingId,
                priceE8s: BigInt(listing.priceE8s),
                expectedRevision: BigInt(listing.revision)
              },
              wallet.connection
            )
          : await purchaseMarketAccessWithPlug(
              {
                canisterId,
                listingId: listing.listingId,
                priceE8s: BigInt(listing.priceE8s),
                expectedRevision: BigInt(listing.revision)
              },
              wallet.connection
            );
      setMessage(`Order ${order.orderId}`);
      setPurchaseState("success");
      await refreshWalletBalance(wallet);
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
    <main className="min-h-screen bg-white px-6 pb-10 pt-6 text-ink">
      <section className="mx-auto grid max-w-4xl gap-5">
        <Link className="text-sm font-semibold text-accent hover:underline" href="/marketplace">
          Marketplace
        </Link>

        {listing ? (
          <>
            <section className="grid gap-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="grid gap-2">
                  <h1 className="text-2xl font-semibold">{listing.title}</h1>
                  <p className="text-sm text-muted">{listing.description}</p>
                </div>
                <div className="rounded-lg border border-line px-3 py-2 text-right">
                  <p className="font-mono text-lg font-semibold">{formatTokenAmountFromE8s(listing.priceE8s)}</p>
                  <p className="text-xs text-muted">revision {listing.revision}</p>
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

            <section className="grid gap-3 md:grid-cols-2">
              <PreviewList title="Questions" items={samples} />
              <PreviewList title="Excerpts" items={excerpts} />
            </section>

            <section className="flex flex-wrap items-center gap-3">
              <button
                className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-action bg-action px-4 py-2 text-sm font-semibold text-white hover:bg-accent disabled:opacity-60"
                disabled={!wallet || purchaseState === "loading" || purchaseState === "success"}
                type="button"
                onClick={() => void purchase()}
              >
                <ShoppingCart aria-hidden size={17} />
                <span>{purchaseState === "success" ? "Purchased" : "Purchase access"}</span>
              </button>
              {!wallet ? <span className="text-sm text-muted">Connect OISY or Plug to purchase</span> : null}
            </section>
          </>
        ) : null}

        {state === "loading" ? <p className="rounded-lg border border-line bg-paper px-3 py-2 text-sm">Loading</p> : null}
        {message ? <Notice tone={state === "error" || purchaseState === "error" ? "error" : "success"} text={message} /> : null}
      </section>
    </main>
  );
}

function PreviewList({ title, items }: { title: string; items: string[] }) {
  return (
    <section className="grid gap-2 rounded-lg border border-line p-3">
      <h2 className="text-sm font-semibold">{title}</h2>
      {items.length ? (
        <ul className="grid gap-2 text-sm text-muted">
          {items.slice(0, 5).map((item) => (
            <li className="break-words" key={item}>
              {item}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">-</p>
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
