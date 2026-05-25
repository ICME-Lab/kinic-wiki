import type { BillingConfig, DatabaseSummary } from "@/lib/types";

export type DatabaseBillingState = "active" | "low-balance" | "suspended" | "unknown";

export type DatabaseBillingView = {
  state: DatabaseBillingState;
  label: string;
  summary: string;
  balanceE8s: bigint;
  minUpdateBalanceE8s: bigint;
  depositAmountE8s: bigint;
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
      summary: `Balance ${balance.toString()} e8s / minimum unavailable`,
      balanceE8s: balance,
      minUpdateBalanceE8s: minimum,
      depositAmountE8s: 0n,
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
      summary: `Suspended / ${balance.toString()} e8s`,
      balanceE8s: balance,
      minUpdateBalanceE8s: minimum,
      depositAmountE8s: depositAmount(balance, minimum, true),
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
      summary: `Low balance / ${balance.toString()} e8s`,
      balanceE8s: balance,
      minUpdateBalanceE8s: minimum,
      depositAmountE8s: depositAmount(balance, minimum, false),
      configAvailable: true,
      depositAvailable: true,
      billable: false,
      reason: "Database balance is below the minimum update balance."
    };
  }
  return {
    state: "active",
    label: "Active",
    summary: `Active / ${balance.toString()} e8s`,
    balanceE8s: balance,
    minUpdateBalanceE8s: minimum,
    depositAmountE8s: 1n,
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

export function databaseDepositHref(canisterId: string, database: DatabaseSummary, config: BillingConfig): string {
  const view = databaseBillingView(database, config);
  const params = new URLSearchParams();
  params.set("canisterId", canisterId);
  params.set("databaseId", database.databaseId);
  params.set("amountE8s", view.depositAmountE8s.toString());
  return `/deposit?${params.toString()}`;
}

function depositAmount(balance: bigint, minimum: bigint, suspended: boolean): bigint {
  const amount = balance < minimum ? minimum - balance : suspended ? minimum : 1n;
  return amount > 0n ? amount : 1n;
}

function parseOptionalE8s(value: string | null | undefined): bigint {
  if (!value || !/^[0-9]+$/.test(value)) return 0n;
  return BigInt(value);
}
