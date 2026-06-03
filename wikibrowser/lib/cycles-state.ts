// Where: dashboard cycles state helpers.
// What: maps canister cycles data into display state and purchase links.
// Why: purchase amount is selected on the purchase screen, not encoded in dashboard URLs.
import type { CyclesBillingConfig, DatabaseSummary } from "@/lib/types";
import { formatCycles as formatCycleAmount } from "@/lib/cycles";

export type DatabaseCycleState = "active" | "low-balance" | "suspended" | "unknown";

export type DatabaseCycleView = {
  state: DatabaseCycleState;
  label: string;
  summary: string;
  balanceCycles: bigint;
  minUpdateCycles: bigint;
  configAvailable: boolean;
  purchaseAvailable: boolean;
  writeCyclesAvailable: boolean;
  reason: string | null;
};

export function databaseCyclesView(database: DatabaseSummary | null, config: CyclesBillingConfig | null): DatabaseCycleView {
  const balance = parseOptionalCycles(database?.cyclesBalance);
  const minimum = parseOptionalCycles(config?.minUpdateCycles);
  if (!database || !config) {
    return {
      state: "unknown",
      label: "Cycles unavailable",
      summary: "-",
      balanceCycles: balance,
      minUpdateCycles: minimum,
      configAvailable: false,
      purchaseAvailable: false,
      writeCyclesAvailable: false,
      reason: "Cycles config unavailable."
    };
  }
  if (database.status === "pending") {
    return {
      state: "suspended",
      label: "Pending",
      summary: `Pending / ${formatCycles(balance)}`,
      balanceCycles: balance,
      minUpdateCycles: minimum,
      configAvailable: true,
      purchaseAvailable: true,
      writeCyclesAvailable: false,
      reason: "Database activation is pending until its first cycle purchase completes."
    };
  }
  if (database.cyclesSuspendedAtMs) {
    return {
      state: "suspended",
      label: "Suspended",
      summary: `Suspended / ${formatCycles(balance)}`,
      balanceCycles: balance,
      minUpdateCycles: minimum,
      configAvailable: true,
      purchaseAvailable: true,
      writeCyclesAvailable: false,
      reason: "Database cycles are suspended."
    };
  }
  if (balance < minimum) {
    return {
      state: "low-balance",
      label: "Low balance",
      summary: `Low balance / ${formatCycles(balance)}`,
      balanceCycles: balance,
      minUpdateCycles: minimum,
      configAvailable: true,
      purchaseAvailable: true,
      writeCyclesAvailable: false,
      reason: "Database cycles balance is below the minimum update balance."
    };
  }
  return {
    state: "active",
    label: "Active",
    summary: `Active / ${formatCycles(balance)}`,
    balanceCycles: balance,
    minUpdateCycles: minimum,
    configAvailable: true,
    purchaseAvailable: true,
    writeCyclesAvailable: true,
    reason: null
  };
}

export function databaseCanWrite(database: DatabaseSummary | null, config: CyclesBillingConfig | null): boolean {
  const role = database?.role;
  return (role === "writer" || role === "owner") && databaseCyclesView(database, config).writeCyclesAvailable;
}

export function databaseCyclesDisabledReason(database: DatabaseSummary | null, config: CyclesBillingConfig | null): string | null {
  return databaseCyclesView(database, config).reason;
}

export function databaseCyclesHref(database: DatabaseSummary): string {
  const params = new URLSearchParams();
  params.set("databaseId", database.databaseId);
  params.set("status", database.status);
  return `/cycles?${params.toString()}`;
}

function parseOptionalCycles(value: string | null | undefined): bigint {
  if (!value || !/^[0-9]+$/.test(value)) return 0n;
  return BigInt(value);
}

export function formatCycles(value: bigint): string {
  return `${formatCycleAmount(value)} cycles`;
}
