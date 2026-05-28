// Where: dashboard credits state helpers.
// What: maps canister credits data into display state and purchase links.
// Why: purchase amount is selected on the purchase screen, not encoded in dashboard URLs.
import type { CreditsConfig, DatabaseSummary } from "@/lib/types";

export type DatabaseCreditState = "active" | "low-balance" | "suspended" | "unknown";

export type DatabaseCreditView = {
  state: DatabaseCreditState;
  label: string;
  summary: string;
  balanceCredits: bigint;
  minUpdateCredits: bigint;
  configAvailable: boolean;
  purchaseAvailable: boolean;
  writeCreditsAvailable: boolean;
  reason: string | null;
};

export function databaseCreditsView(database: DatabaseSummary | null, config: CreditsConfig | null): DatabaseCreditView {
  const balance = parseOptionalCredits(database?.creditsBalance);
  const minimum = parseOptionalCredits(config?.minUpdateCredits);
  if (!database || !config) {
    return {
      state: "unknown",
      label: "Credits unavailable",
      summary: "-",
      balanceCredits: balance,
      minUpdateCredits: minimum,
      configAvailable: false,
      purchaseAvailable: false,
      writeCreditsAvailable: false,
      reason: "Credits config unavailable."
    };
  }
  if (database.status === "pending") {
    return {
      state: "suspended",
      label: "Pending",
      summary: `Pending / ${formatCredits(balance)}`,
      balanceCredits: balance,
      minUpdateCredits: minimum,
      configAvailable: true,
      purchaseAvailable: true,
      writeCreditsAvailable: false,
      reason: "Database activation is pending until its first credit purchase completes."
    };
  }
  if (database.creditsSuspendedAtMs) {
    return {
      state: "suspended",
      label: "Suspended",
      summary: `Suspended / ${formatCredits(balance)}`,
      balanceCredits: balance,
      minUpdateCredits: minimum,
      configAvailable: true,
      purchaseAvailable: true,
      writeCreditsAvailable: false,
      reason: "Database credits are suspended."
    };
  }
  if (balance < minimum) {
    return {
      state: "low-balance",
      label: "Low balance",
      summary: `Low balance / ${formatCredits(balance)}`,
      balanceCredits: balance,
      minUpdateCredits: minimum,
      configAvailable: true,
      purchaseAvailable: true,
      writeCreditsAvailable: false,
      reason: "Database credits balance is below the minimum update balance."
    };
  }
  return {
    state: "active",
    label: "Active",
    summary: `Active / ${formatCredits(balance)}`,
    balanceCredits: balance,
    minUpdateCredits: minimum,
    configAvailable: true,
    purchaseAvailable: true,
    writeCreditsAvailable: true,
    reason: null
  };
}

export function databaseCanWrite(database: DatabaseSummary | null, config: CreditsConfig | null): boolean {
  const role = database?.role;
  return (role === "writer" || role === "owner") && databaseCreditsView(database, config).writeCreditsAvailable;
}

export function databaseCreditsDisabledReason(database: DatabaseSummary | null, config: CreditsConfig | null): string | null {
  return databaseCreditsView(database, config).reason;
}

export function databaseCreditsHref(database: DatabaseSummary): string {
  const params = new URLSearchParams();
  params.set("databaseId", database.databaseId);
  return `/credits?${params.toString()}`;
}

function parseOptionalCredits(value: string | null | undefined): bigint {
  if (!value || !/^[0-9]+$/.test(value)) return 0n;
  return BigInt(value);
}

function formatCredits(value: bigint): string {
  return `${value.toString()} credits`;
}
