"use client";

// Where: database headers in the console.
// What: one cycles indicator that follows the same billing state as the rest of the dashboard.
// Why: a fixed threshold made the battery red while the billing config still reported "Active".

import { StatusPill, type StatusTone } from "@/components/ui/status-pill";
import { cycleTone, formatCycles, formatRawCycles } from "@/lib/cycles";
import { databaseCyclesView, type DatabaseCycleState } from "@/lib/cycles-state";
import type { CyclesBillingConfig, DatabaseSummary } from "@/lib/types";

export function CycleBattery({
  config = null,
  cyclesBalance,
  database = null
}: {
  config?: CyclesBillingConfig | null;
  cyclesBalance: string | null;
  database?: DatabaseSummary | null;
}) {
  const view = database ? databaseCyclesView(database, config) : null;
  const cycles = view ? view.balanceCycles : parseCyclesBalance(cyclesBalance);
  const tone = view ? toneForState(view.state) : cycleToneFallback(cycleTone(cycles));
  const label = cycles === null ? "--" : formatCycles(cycles);
  const title = titleFor({ cycles, reason: view?.reason ?? null, state: view?.state ?? null });
  return (
    <StatusPill
      className="h-[38px] px-3"
      dot
      label={<span className="font-mono text-xs">{label}</span>}
      title={title}
      tone={tone}
    />
  );
}

function parseCyclesBalance(value: string | null): bigint | null {
  if (value === null) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function titleFor({ cycles, reason, state }: { cycles: bigint | null; reason: string | null; state: DatabaseCycleState | null }): string {
  const stateLabel =
    state === "active"
      ? "Active"
      : state === "low-balance"
        ? "Low balance"
        : state === "suspended"
          ? "Suspended"
          : state === "unknown"
            ? "State unknown"
            : null;
  const balanceLabel = cycles !== null ? `${formatRawCycles(cycles)} database cycles available` : "Database cycle balance unavailable";
  if (stateLabel && reason) return `${stateLabel} · ${balanceLabel}. ${reason}`;
  if (stateLabel) return `${stateLabel} · ${balanceLabel}`;
  return balanceLabel;
}

function toneForState(state: DatabaseCycleState): StatusTone {
  if (state === "active") return "positive";
  if (state === "low-balance") return "warn";
  if (state === "suspended") return "danger";
  return "neutral";
}

function cycleToneFallback(tone: "blue" | "amber" | "red" | "gray"): StatusTone {
  if (tone === "blue") return "info";
  if (tone === "amber") return "warn";
  if (tone === "red") return "danger";
  return "neutral";
}
