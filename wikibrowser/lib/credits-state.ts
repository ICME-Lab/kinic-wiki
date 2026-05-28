// Where: dashboard credits state helpers.
// What: maps canister credits data into display state and purchase links.
// Why: purchase amount is selected on the purchase screen, not encoded in dashboard URLs.
import type { CreditsConfig, DatabaseSummary } from "@/lib/types";
import { formatTokenAmountFromE8s } from "@/lib/credit-amount";

export type DatabaseCreditState = "active" | "low-balance" | "suspended" | "unknown";

export type DatabaseCreditView = {
  state: DatabaseCreditState;
  label: string;
  summary: string;
  balanceE8s: bigint;
  minUpdateBalanceE8s: bigint;
  configAvailable: boolean;
  purchaseAvailable: boolean;
  billable: boolean;
  reason: string | null;
};

export function databaseCreditsView(database: DatabaseSummary | null, config: CreditsConfig | null): DatabaseCreditView {
  const balance = parseOptionalE8s(database?.creditsBalanceE8s);
  const minimum = parseOptionalE8s(config?.minUpdateBalanceE8s);
  if (!database || !config) {
    return {
      state: "unknown",
      label: "Credits unavailable",
      summary: "-",
      balanceE8s: balance,
      minUpdateBalanceE8s: minimum,
      configAvailable: false,
      purchaseAvailable: false,
      billable: false,
      reason: "Credits config unavailable."
    };
  }
  if (database.status === "pending") {
    return {
      state: "suspended",
      label: "Pending",
      summary: `Pending / ${formatTokenAmountFromE8s(balance)}`,
      balanceE8s: balance,
      minUpdateBalanceE8s: minimum,
      configAvailable: true,
      purchaseAvailable: true,
      billable: false,
      reason: "Database activation is pending until its first credit purchase completes."
    };
  }
  if (database.creditsSuspendedAtMs) {
    return {
      state: "suspended",
      label: "Suspended",
      summary: `Suspended / ${formatTokenAmountFromE8s(balance)}`,
      balanceE8s: balance,
      minUpdateBalanceE8s: minimum,
      configAvailable: true,
      purchaseAvailable: true,
      billable: false,
      reason: "Database credits are suspended."
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
      purchaseAvailable: true,
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
    purchaseAvailable: true,
    billable: true,
    reason: null
  };
}

export function databaseCanWrite(database: DatabaseSummary | null, config: CreditsConfig | null): boolean {
  const role = database?.role;
  return (role === "writer" || role === "owner") && databaseCreditsView(database, config).billable;
}

export function databaseCreditsDisabledReason(database: DatabaseSummary | null, config: CreditsConfig | null): string | null {
  return databaseCreditsView(database, config).reason;
}

export function databaseCreditsHref(database: DatabaseSummary): string {
  const params = new URLSearchParams();
  params.set("databaseId", database.databaseId);
  return `/credits?${params.toString()}`;
}

function parseOptionalE8s(value: string | null | undefined): bigint {
  if (!value || !/^[0-9]+$/.test(value)) return 0n;
  return BigInt(value);
}
