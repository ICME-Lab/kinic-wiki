"use client";

// Where: /metrics client UI.
// What: renders public Kinic Wiki business metrics.
// Why: operators need a fixed read-only view of usage and KINIC charge totals.

import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AdminContent } from "@/components/admin-shell";
import { AdminNotice, AdminPageHeader, AdminPanel } from "@/components/admin-ui";
import { formatTokenAmountFromE8s } from "@/lib/kinic-amount";
import type { WikiMetrics } from "@/lib/types";
import { wikiMetrics } from "@/lib/vfs-client";
import { errorMessage } from "@/lib/wiki-helpers";

type LoadState = "idle" | "loading" | "ready" | "error";

export function MetricsClient({ canisterId }: { canisterId: string }) {
  const requestSeqRef = useRef(0);
  const [metrics, setMetrics] = useState<WikiMetrics | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [error, setError] = useState<string | null>(null);

  const loadMetrics = useCallback(async () => {
    if (!canisterId) {
      requestSeqRef.current += 1;
      setMetrics(null);
      setError("NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID is not configured.");
      setLoadState("error");
      return;
    }
    const requestSeq = (requestSeqRef.current += 1);
    const isCurrentRequest = () => requestSeq === requestSeqRef.current;
    setLoadState("loading");
    setError(null);
    try {
      const result = await wikiMetrics(canisterId);
      if (!isCurrentRequest()) return;
      setMetrics(result);
      setLoadState("ready");
    } catch (cause) {
      if (!isCurrentRequest()) return;
      setMetrics(null);
      setError(errorMessage(cause));
      setLoadState("error");
    }
  }, [canisterId]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      void loadMetrics();
    });
    return () => {
      cancelled = true;
    };
  }, [loadMetrics]);

  const cards = useMemo(() => metricCards(metrics), [metrics]);
  const loading = loadState === "loading";

  return (
    <AdminContent>
      <AdminPageHeader
        title="Metrics"
        description="Public usage and KINIC charge totals."
        actions={
          <button
            aria-label="Refresh metrics"
            className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-line bg-white px-3 text-sm font-semibold text-ink shadow-sm hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-60"
            disabled={loading}
            type="button"
            onClick={() => void loadMetrics()}
          >
            <RefreshCw aria-hidden className={loading ? "animate-spin" : ""} size={16} />
            <span>Refresh</span>
          </button>
        }
      />
      {error ? <AdminNotice tone="error" message={error} /> : null}
      {loading ? <AdminNotice tone="info" message="Loading metrics..." /> : null}
      {metrics ? (
        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5" aria-label="Wiki metrics">
          {cards.map((card) => (
            <AdminPanel key={card.label} className="min-h-28">
              <div className="grid h-full content-between gap-3">
                <span className="text-xs font-semibold uppercase text-muted">{card.label}</span>
                <span className="break-words text-2xl font-semibold text-ink">{card.value}</span>
              </div>
            </AdminPanel>
          ))}
        </section>
      ) : null}
    </AdminContent>
  );
}

function metricCards(metrics: WikiMetrics | null): { label: string; value: string }[] {
  if (!metrics) return [];
  return [
    { label: "Users total", value: metrics.usersTotal },
    { label: "Users active 30d", value: metrics.usersActive30d },
    { label: "Users new 30d", value: metrics.usersNew30d },
    { label: "DBs total", value: metrics.databasesTotal },
    { label: "DBs active 30d", value: metrics.databasesActive30d },
    { label: "DBs new 30d", value: metrics.databasesNew30d },
    { label: "Paid users total", value: metrics.paidUsersTotal },
    { label: "Charged KINIC total", value: formatTokenAmountFromE8s(metrics.chargedKinicTotalE8s) },
    { label: "Charged KINIC 30d", value: formatTokenAmountFromE8s(metrics.chargedKinic30dE8s) },
    { label: "Last activity at", value: formatTimestamp(metrics.lastActivityAtMs) }
  ];
}

function formatTimestamp(value: string | null): string {
  if (!value || !/^[0-9]+$/.test(value)) return "-";
  const ms = Number(value);
  if (!Number.isSafeInteger(ms) || ms <= 0) return "-";
  return new Date(ms).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}
