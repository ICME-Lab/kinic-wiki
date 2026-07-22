import { type Identity } from "@icp-sdk/core/agent";
import type {
  CyclesBillingConfig,
  DatabaseCycleEntry,
  DatabaseCycleEntryPage,
  DatabaseCyclesPendingPurchase,
  DatabaseSummary,
  InitialFreeDatabaseGrantStatus,
  IndexSqlJsonQueryResult,
  WikiMetrics,
  WikiMetricsPoint
} from "@/lib/types";

import type { RawCyclesBillingConfig, RawDatabaseCycleEntry, RawDatabaseCycleEntryPage, RawDatabaseCyclesPendingPurchase, RawInitialFreeDatabaseGrantStatus } from "./raw-types";
import { callVfs, createAuthenticatedActor, createReadActor, createVfsActor, normalizeDatabaseSummary, normalizeIndexSqlJsonQueryResult, normalizeWikiMetrics, normalizeWikiMetricsPoint, rawDatabaseCycleCursor, throwCanisterError } from "./actor";
export async function getCyclesBillingConfig(canisterId: string): Promise<CyclesBillingConfig> {
  return callVfs(async () => {
    const actor = await createVfsActor(canisterId);
    const result = await actor.get_cycles_billing_config();
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
    return normalizeCyclesBillingConfig(result.Ok);
  });
}

export async function checkDatabaseWriteCycles(canisterId: string, identity: Identity, databaseId: string): Promise<void> {
  return callVfs(async () => {
    const actor = await createAuthenticatedActor(canisterId, identity);
    const result = await actor.check_database_write_cycles(databaseId);
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
  });
}

export async function listDatabasesAuthenticated(canisterId: string, identity: Identity): Promise<DatabaseSummary[]> {
  return callVfs(async () => {
    const actor = await createAuthenticatedActor(canisterId, identity);
    const result = await actor.list_databases();
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
    return result.Ok.map((raw) => normalizeDatabaseSummary(raw));
  });
}

export async function listDatabasesPublic(canisterId: string): Promise<DatabaseSummary[]> {
  return callVfs(async () => {
    const actor = await createVfsActor(canisterId);
    const result = await actor.list_databases();
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
    return result.Ok.map((raw) => normalizeDatabaseSummary(raw));
  });
}

export async function queryIndexSqlJson(canisterId: string, identity: Identity, sql: string, limit: number): Promise<IndexSqlJsonQueryResult> {
  return callVfs(async () => {
    const actor = await createAuthenticatedActor(canisterId, identity);
    const result = await actor.query_index_sql_json(sql, limit);
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
    return normalizeIndexSqlJsonQueryResult(result.Ok);
  });
}

export async function queryDatabaseSqlJson(
  canisterId: string,
  databaseId: string,
  sql: string,
  limit: number,
  identity?: Identity
): Promise<IndexSqlJsonQueryResult> {
  return callVfs(async () => {
    const actor = await createReadActor(canisterId, identity);
    const result = await actor.query_database_sql_json(databaseId, sql, limit);
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
    return normalizeIndexSqlJsonQueryResult(result.Ok);
  });
}

export async function wikiMetrics(canisterId: string): Promise<WikiMetrics> {
  return callVfs(async () => {
    const actor = await createVfsActor(canisterId);
    const result = await actor.wiki_metrics();
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
    return normalizeWikiMetrics(result.Ok);
  });
}

// Public aggregate telemetry. The canister clamps days to 1..7.
export async function wikiMetricsSeries(canisterId: string, days: number): Promise<WikiMetricsPoint[]> {
  return callVfs(async () => {
    const actor = await createVfsActor(canisterId);
    const result = await actor.wiki_metrics_series(days);
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
    return result.Ok.map(normalizeWikiMetricsPoint);
  });
}

export async function listDatabaseCycleEntries(
  canisterId: string,
  databaseId: string,
  cursor: string | null,
  limit: number,
  identity?: Identity
): Promise<DatabaseCycleEntryPage> {
  return callVfs(async () => {
    const actor = await createReadActor(canisterId, identity);
    const result = await actor.list_database_cycle_entries(databaseId, rawDatabaseCycleCursor(cursor), limit);
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
    return normalizeDatabaseCycleEntryPage(result.Ok);
  });
}

export async function listDatabaseCyclesPendingPurchasesAuthenticated(
  canisterId: string,
  identity: Identity,
  databaseId: string
): Promise<DatabaseCyclesPendingPurchase[]> {
  return callVfs(async () => {
    const actor = await createAuthenticatedActor(canisterId, identity);
    const result = await actor.list_database_cycles_pending_purchases(databaseId);
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
    return result.Ok.map(normalizeDatabaseCyclesPendingPurchase);
  });
}


export function normalizeCyclesBillingConfig(raw: RawCyclesBillingConfig): CyclesBillingConfig {
  return {
    kinicLedgerCanisterId: raw.kinic_ledger_canister_id,
    billingAuthorityId: raw.billing_authority_id,
    cyclesPerKinic: raw.cycles_per_kinic.toString(),
    minUpdateCycles: raw.min_update_cycles.toString(),
    topUp: {
      enabled: raw.top_up.enabled,
      launcherPrincipal: raw.top_up.launcher_principal,
      thresholdCycles: raw.top_up.threshold_cycles.toString()
    }
  };
}


export function normalizeInitialFreeDatabaseGrantStatus(raw: RawInitialFreeDatabaseGrantStatus): InitialFreeDatabaseGrantStatus {
  return {
    available: raw.available,
    grantCycles: raw.grant_cycles.toString(),
    databaseId: raw.database_id[0] ?? null,
    createdAtMs: raw.created_at_ms[0]?.toString() ?? null
  };
}

export function normalizeDatabaseCycleEntryPage(raw: RawDatabaseCycleEntryPage): DatabaseCycleEntryPage {
  return {
    entries: raw.entries.map(normalizeDatabaseCycleEntry),
    nextCursor: raw.next_cursor[0]?.toString() ?? null
  };
}


export function normalizeDatabaseCycleEntry(raw: RawDatabaseCycleEntry): DatabaseCycleEntry {
  return {
    entryId: raw.entry_id.toString(),
    databaseId: raw.database_id,
    kind: raw.kind,
    amountCycles: raw.amount_cycles.toString(),
    balanceAfterCycles: raw.balance_after_cycles.toString(),
    caller: raw.caller,
    method: raw.method[0] ?? null,
    ledgerBlockIndex: raw.ledger_block_index[0]?.toString() ?? null,
    paymentAmountE8s: raw.payment_amount_e8s[0]?.toString() ?? null,
    cyclesPerKinic: raw.cycles_per_kinic[0]?.toString() ?? null,
    cyclesDelta: raw.cycles_delta[0]?.toString() ?? null,
    createdAtMs: raw.created_at_ms.toString()
  };
}

export function normalizeDatabaseCyclesPendingPurchase(raw: RawDatabaseCyclesPendingPurchase): DatabaseCyclesPendingPurchase {
  return {
    operationId: raw.operation_id.toString(),
    databaseId: raw.database_id,
    status: raw.status,
    amountCycles: raw.amount_cycles.toString(),
    paymentAmountE8s: raw.payment_amount_e8s.toString(),
    ledgerBlockIndex: raw.ledger_block_index[0]?.toString() ?? null,
    createdAtMs: raw.created_at_ms.toString(),
    requiredAction: raw.required_action
  };
}
