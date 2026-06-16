"use client";

// Where: /metrics client UI.
// What: renders public Kinic Wiki business metrics.
// Why: operators need a fixed read-only view of usage and KINIC charge totals.

import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AdminContent } from "@/components/admin-shell";
import { AdminNotice, AdminPageHeader } from "@/components/admin-ui";
import { formatTokenAmountFromE8s } from "@/lib/kinic-amount";
import type { WikiMetrics, WikiMetricsPoint } from "@/lib/types";
import { wikiMetrics, wikiMetricsSeries } from "@/lib/vfs-client";
import { errorMessage } from "@/lib/wiki-helpers";

type LoadState = "idle" | "loading" | "ready" | "error";
type ChartSeries = {
  label: string;
  color: string;
  values: number[];
};

export function MetricsClient({ canisterId }: { canisterId: string }) {
  const requestSeqRef = useRef(0);
  const [metrics, setMetrics] = useState<WikiMetrics | null>(null);
  const [series, setSeries] = useState<WikiMetricsPoint[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [error, setError] = useState<string | null>(null);

  const loadMetrics = useCallback(async () => {
    if (!canisterId) {
      requestSeqRef.current += 1;
      setMetrics(null);
      setSeries([]);
      setError("NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID is not configured.");
      setLoadState("error");
      return;
    }
    const requestSeq = (requestSeqRef.current += 1);
    const isCurrentRequest = () => requestSeq === requestSeqRef.current;
    setLoadState("loading");
    setError(null);
    try {
      const [result, points] = await Promise.all([wikiMetrics(canisterId), wikiMetricsSeries(canisterId, 7)]);
      if (!isCurrentRequest()) return;
      setMetrics(result);
      setSeries(points);
      setLoadState("ready");
    } catch (cause) {
      if (!isCurrentRequest()) return;
      setMetrics(null);
      setSeries([]);
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
        <>
          <section className="grid gap-x-5 gap-y-3 border-y border-line py-3 sm:grid-cols-2 lg:grid-cols-5" aria-label="Wiki metrics">
            {cards.map((card) => (
              <div key={card.label} className="grid min-w-0 gap-1">
                <span className="truncate text-[11px] font-semibold uppercase leading-4 text-muted">{card.label}</span>
                <span className="truncate text-base font-semibold leading-5 text-ink">{card.value}</span>
              </div>
            ))}
          </section>
          <section className="grid gap-8 pt-4" aria-label="Wiki metrics charts">
            <MetricChart title="Activity" points={series} series={activityChartSeries(series)} />
            <MetricChart title="KINIC charge rolling 30d" points={series} series={chargeChartSeries(series)} />
          </section>
        </>
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

function activityChartSeries(points: WikiMetricsPoint[]): ChartSeries[] {
  return [
    {
      label: "Users active 30d",
      color: "#1d4ed8",
      values: points.map((point) => numberFromDecimal(point.metrics.usersActive30d))
    },
    {
      label: "Users new 30d",
      color: "#059669",
      values: points.map((point) => numberFromDecimal(point.metrics.usersNew30d))
    },
    {
      label: "DBs active 30d",
      color: "#e11d48",
      values: points.map((point) => numberFromDecimal(point.metrics.databasesActive30d))
    }
  ];
}

function chargeChartSeries(points: WikiMetricsPoint[]): ChartSeries[] {
  return [
    {
      label: "Charged KINIC 30d",
      color: "#ca8a04",
      values: points.map((point) => numberFromDecimal(point.metrics.chargedKinic30dE8s) / 100_000_000)
    }
  ];
}

function MetricChart({ title, points, series }: { title: string; points: WikiMetricsPoint[]; series: ChartSeries[] }) {
  const values = series.flatMap((line) => line.values);
  const maxValue = Math.max(0, ...values);
  const firstDate = points[0]?.bucketStartMs ?? null;
  const lastDate = points[points.length - 1]?.bucketStartMs ?? null;
  const hasPositiveData = points.length > 0 && values.some((value) => value > 0);
  const flatPositiveData = hasPositiveData && values.every((value) => value === maxValue);
  const yAxisMax = flatPositiveData ? maxValue * 2 : maxValue;
  const yAxisMid = yAxisMax / 2;
  const gridTicks = hasPositiveData ? [yAxisMax, yAxisMid, 0] : [1, 0.5, 0];

  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-normal text-muted">{title}</h2>
        <div className="grid gap-1 text-xs text-muted sm:min-w-72">
          {series.map((line) => (
            <span key={line.label} className="grid grid-cols-[auto_1fr_auto] items-center gap-2">
              <span className="h-2 w-4 rounded-full" style={{ backgroundColor: line.color }} />
              <span className="truncate">{line.label}</span>
              <span className="font-mono font-semibold tabular-nums text-ink">{formatChartValue(line.values[line.values.length - 1] ?? 0)}</span>
            </span>
          ))}
        </div>
      </div>
      <div className="relative h-52">
        <div className="absolute bottom-7 left-0 top-0 w-10">
          {gridTicks.map((tick, index) => {
            const tickMax = hasPositiveData ? yAxisMax : 1;
            const y = valueRatio(tick, tickMax) * 100;
            return (
              <span key={`${tick}-${index}`} className="absolute right-2 -translate-y-1/2 text-[11px] text-muted" style={{ top: `${y}%` }}>
                {hasPositiveData || tick === 0 ? formatChartValue(tick) : ""}
              </span>
            );
          })}
        </div>
        <div className="absolute bottom-7 left-12 right-0 top-0">
          <svg className="size-full overflow-visible" viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label={`${title} chart`}>
            {gridTicks.map((tick, index) => {
              const tickMax = hasPositiveData ? yAxisMax : 1;
              const y = valueRatio(tick, tickMax) * 100;
              return <line key={`${tick}-${index}`} x1={0} x2={100} y1={y} y2={y} stroke={tick === 0 ? "#d8dee8" : "#edf0f4"} strokeWidth={0.7} vectorEffect="non-scaling-stroke" />;
            })}
            <line x1={0} x2={0} y1={0} y2={100} stroke="#d8dee8" strokeWidth={0.7} vectorEffect="non-scaling-stroke" />
            {hasPositiveData
              ? series.map((line) => {
                  const linePoints = line.values.map((value, index) => {
                    const x = pointRatio(index, line.values.length) * 100;
                    const y = valueRatio(value, yAxisMax) * 100;
                    return { x, y };
                  });
                  const pathPoints = linePoints.map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(" ");
                  const latestPoint = linePoints[linePoints.length - 1] ?? null;
                  return (
                    <g key={line.label}>
                      <polyline points={pathPoints} fill="none" stroke={line.color} strokeWidth={3} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
                      {latestPoint ? <circle cx={latestPoint.x} cy={latestPoint.y} r={1.1} fill={line.color} stroke="#ffffff" strokeWidth={0.65} vectorEffect="non-scaling-stroke" /> : null}
                    </g>
                  );
                })
              : null}
          </svg>
          {!hasPositiveData ? <div className="absolute inset-0 grid place-items-center text-sm text-muted">No activity in this period</div> : null}
        </div>
        <div className="absolute bottom-0 left-12 right-0 flex justify-between text-[11px] text-muted">
          <span>{formatShortDate(firstDate)}</span>
          <span>{formatShortDate(lastDate)}</span>
        </div>
      </div>
    </div>
  );
}

function pointRatio(index: number, length: number): number {
  if (length <= 1) return 0.5;
  return index / (length - 1);
}

function valueRatio(value: number, maxValue: number): number {
  if (maxValue <= 0) return 1;
  return 1 - value / maxValue;
}

function numberFromDecimal(value: string): number {
  if (!/^[0-9]+$/.test(value)) return 0;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return parsed;
}

function formatChartValue(value: number): string {
  if (!Number.isFinite(value)) return "0";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  if (value % 1 === 0) return value.toString();
  return value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

function formatShortDate(value: string | null): string {
  if (!value || !/^[0-9]+$/.test(value)) return "-";
  const ms = Number(value);
  if (!Number.isSafeInteger(ms) || ms <= 0) return "-";
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
