// Where: dashboard billing state helpers.
// What: maps canister billing data into display state and deposit links.
// Why: deposit amount is selected on the deposit screen, not encoded in dashboard URLs.
import type { BillingConfig, DatabaseSummary } from "@/lib/types";
import { formatTokenAmountFromE8s } from "@/lib/token-amount";

export type DatabaseBillingState = "active" | "low-balance" | "suspended" | "unknown";

export type DatabaseBillingView = {
  state: DatabaseBillingState;
  label: string;
  summary: string;
  balanceE8s: bigint;
  minUpdateBalanceE8s: bigint;
  configAvailable: boolean;
  depositAvailable: boolean;
  billable: boolean;
  reason: string | null;
};

export function databaseBillingView(database: DatabaseSummary | null, config: BillingConfig | null): DatabaseBillingView {
  const balance = parseOptionalE8s(database?.billingBalanceE8s);
  const minimum = parseOptionalE8s(config?.minUpdateBalanceE8s);
  if (!database || !config) {
    return {
      state: "unknown",
      label: "Billing unavailable",
      summary: "-",
      balanceE8s: balance,
      minUpdateBalanceE8s: minimum,
      configAvailable: false,
      depositAvailable: false,
      billable: false,
      reason: "Billing config unavailable."
    };
  }
  if (database.billingSuspendedAtMs) {
    return {
      state: "suspended",
      label: "Suspended",
      summary: `Suspended / ${formatTokenAmountFromE8s(balance)}`,
      balanceE8s: balance,
      minUpdateBalanceE8s: minimum,
      configAvailable: true,
      depositAvailable: true,
      billable: false,
      reason: "Database billing is suspended."
    };
  }
  if (balance < minimum) {
    return {
      state: "low-balance",
      label: "Low balance",
      summary: `Low balance / ${formatTokenAmountFromE8s(balance)}`,
      balanceE8s: balance,
      minUpdateBalanceE8s: minimum,
      configAvailable: true,
      depositAvailable: true,
      billable: false,
      reason: "Database balance is below the minimum update balance."
    };
  }
  return {
    state: "active",
    label: "Active",
    summary: `Active / ${formatTokenAmountFromE8s(balance)}`,
    balanceE8s: balance,
    minUpdateBalanceE8s: minimum,
    configAvailable: true,
    depositAvailable: true,
    billable: true,
    reason: null
  };
}

export function databaseCanWrite(database: DatabaseSummary | null, config: BillingConfig | null): boolean {
  const role = database?.role;
  return (role === "writer" || role === "owner") && databaseBillingView(database, config).billable;
}

export function databaseBillingDisabledReason(database: DatabaseSummary | null, config: BillingConfig | null): string | null {
  return databaseBillingView(database, config).reason;
}

export function databaseDepositHref(database: DatabaseSummary): string {
  const params = new URLSearchParams();
  params.set("databaseId", database.databaseId);
  return `/deposit?${params.toString()}`;
}

function parseOptionalE8s(value: string | null | undefined): bigint {
  if (!value || !/^[0-9]+$/.test(value)) return 0n;
  return BigInt(value);
}
