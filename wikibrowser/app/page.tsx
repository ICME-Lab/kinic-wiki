"use client";

import { AuthClient } from "@icp-sdk/auth/client";
import type { FormEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { AuthControls, CreatedDatabasePanel, DatabaseBody, StatusPanel } from "./home-ui";
import { DELEGATION_TTL_NS, identityProviderUrl } from "@/lib/auth";
import type { DatabaseSummary, PrincipalBillingEntry, PrincipalBillingSummary } from "@/lib/types";
import {
  createDatabaseAuthenticated,
  listDatabasesAuthenticated,
  listDatabasesPublic,
  listPrincipalBillingEntriesAuthenticated,
  principalBillingSummaryAuthenticated,
  topUpPrincipalBalanceAuthenticated,
  withdrawPrincipalBalanceAuthenticated
} from "@/lib/vfs-client";
import type { DatabaseRow } from "./home-ui";

type LoadState = "idle" | "loading" | "ready" | "error";

export default function HomePage() {
  const canisterId = process.env.NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID ?? "";
  const refreshSeqRef = useRef(0);
  const [authClient, setAuthClient] = useState<AuthClient | null>(null);
  const [principal, setPrincipal] = useState<string | null>(null);
  const [databases, setDatabases] = useState<DatabaseRow[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [publicError, setPublicError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [createdDatabaseId, setCreatedDatabaseId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [principalBilling, setPrincipalBilling] = useState<PrincipalBillingSummary | null>(null);
  const [principalEntries, setPrincipalEntries] = useState<PrincipalBillingEntry[]>([]);
  const [billingBusy, setBillingBusy] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState("New database");
  const [initialDepositE8s, setInitialDepositE8s] = useState("1000000");
  const [topUpAmountE8s, setTopUpAmountE8s] = useState("");
  const [withdrawAmountE8s, setWithdrawAmountE8s] = useState("");
  const [withdrawToPrincipal, setWithdrawToPrincipal] = useState("");

  const refreshDatabases = useCallback(
    async (client: AuthClient | null) => {
      const refreshSeq = (refreshSeqRef.current += 1);
      const isCurrentRefresh = () => refreshSeq === refreshSeqRef.current;
      if (!canisterId) {
        setError("NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID is not configured.");
        setLoadState("error");
        return;
      }
      setLoadState("loading");
      setError(null);
      setPublicError(null);
      setWarning(null);
      try {
        const identity = client?.getIdentity() ?? null;
        const [publicResult, memberResult, billingResult, entriesResult] = await Promise.allSettled([
          listDatabasesPublic(canisterId),
          identity ? listDatabasesAuthenticated(canisterId, identity) : Promise.resolve<DatabaseSummary[]>([]),
          identity ? principalBillingSummaryAuthenticated(canisterId, identity) : Promise.resolve<PrincipalBillingSummary | null>(null),
          identity ? listPrincipalBillingEntriesAuthenticated(canisterId, identity, null, 10) : Promise.resolve({ entries: [], nextCursor: null })
        ]);
        if (publicResult.status === "rejected" && memberResult.status === "rejected") {
          throw new Error(`${errorMessage(publicResult.reason)}; ${errorMessage(memberResult.reason)}`);
        }
        const publicDatabases = publicResult.status === "fulfilled" ? publicResult.value : [];
        const memberDatabases = memberResult.status === "fulfilled" ? memberResult.value : [];
        const nextDatabases = mergeDatabaseRows(memberDatabases, publicDatabases);
        if (!isCurrentRefresh()) return;
        setDatabases(nextDatabases);
        setPrincipal(identity?.getPrincipal().toText() ?? null);
        setPrincipalBilling(billingResult.status === "fulfilled" ? billingResult.value : null);
        setPrincipalEntries(entriesResult.status === "fulfilled" ? entriesResult.value.entries : []);
        setPublicError(publicResult.status === "rejected" ? `Public database list unavailable: ${errorMessage(publicResult.reason)}` : null);
        setWarning(listWarning(publicResult, memberResult));
        setLoadState("ready");
      } catch (cause) {
        if (!isCurrentRefresh()) return;
        setError(errorMessage(cause));
        setLoadState("error");
      }
    },
    [canisterId]
  );

  useEffect(() => {
    let cancelled = false;

    AuthClient.create()
      .then(async (client) => {
        if (cancelled) return;
        setAuthClient(client);
        if (await client.isAuthenticated()) {
          await refreshDatabases(client);
        } else {
          await refreshDatabases(null);
        }
      })
      .catch((cause) => {
        if (cancelled) return;
        setError(errorMessage(cause));
        setLoadState("error");
      });

    return () => {
      cancelled = true;
    };
  }, [refreshDatabases]);

  async function login() {
    if (!authClient) return;
    setError(null);
    await authClient.login({
      identityProvider: identityProviderUrl(),
      maxTimeToLive: DELEGATION_TTL_NS,
      onSuccess: () => {
        void refreshDatabases(authClient);
      },
      onError: (cause) => {
        setError(errorMessage(cause));
        setLoadState("error");
      }
    });
  }

  async function logout() {
    if (!authClient) return;
    await authClient.logout();
    setPrincipal(null);
    setPrincipalBilling(null);
    setPrincipalEntries([]);
    setCreatedDatabaseId(null);
    setError(null);
    setPublicError(null);
    await refreshDatabases(null);
  }

  async function createDatabase(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!authClient || !canisterId) return;
    const parsedDeposit = parseE8s(initialDepositE8s);
    if (!parsedDeposit) {
      setError("Initial deposit must be a positive integer e8s amount.");
      setLoadState("error");
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const databaseId = await createDatabaseAuthenticated(canisterId, authClient.getIdentity(), displayName, parsedDeposit);
      setCreatedDatabaseId(databaseId);
      await refreshDatabases(authClient);
    } catch (cause) {
      setError(errorMessage(cause));
      setLoadState("error");
    } finally {
      setCreating(false);
    }
  }

  async function topUpPrincipal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!authClient || !canisterId) return;
    const amount = parseE8s(topUpAmountE8s);
    if (!amount) {
      setError("Top-up amount must be a positive integer e8s amount.");
      setLoadState("error");
      return;
    }
    setBillingBusy("top-up-principal");
    setError(null);
    try {
      await topUpPrincipalBalanceAuthenticated(canisterId, authClient.getIdentity(), amount);
      setTopUpAmountE8s("");
      await refreshDatabases(authClient);
    } catch (cause) {
      setError(errorMessage(cause));
      setLoadState("error");
    } finally {
      setBillingBusy(null);
    }
  }

  async function withdrawPrincipal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!authClient || !canisterId) return;
    const amount = parseE8s(withdrawAmountE8s);
    if (!amount || !withdrawToPrincipal.trim()) {
      setError("Withdraw amount and destination principal are required.");
      setLoadState("error");
      return;
    }
    setBillingBusy("withdraw-principal");
    setError(null);
    try {
      await withdrawPrincipalBalanceAuthenticated(canisterId, authClient.getIdentity(), amount, withdrawToPrincipal.trim());
      setWithdrawAmountE8s("");
      await refreshDatabases(authClient);
    } catch (cause) {
      setError(errorMessage(cause));
      setLoadState("error");
    } finally {
      setBillingBusy(null);
    }
  }

  const myDatabases = databases.filter((database) => database.member);
  const publicDatabases = databases.filter((database) => !database.member && database.publicReadable);

  return (
    <main className="min-h-screen px-6 py-8">
      <section className="mx-auto flex max-w-6xl flex-col gap-6">
        <header className="flex flex-col gap-4 border-b border-line pb-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="font-mono text-xs uppercase tracking-[0.18em] text-muted">Kinic Wiki</p>
            <h1 className="mt-2 text-3xl font-semibold text-ink">Database dashboard</h1>
          </div>
          <AuthControls
            authReady={Boolean(authClient)}
            principal={principal}
            loading={loadState === "loading"}
            onLogin={login}
            onLogout={logout}
            onRefresh={() => {
              if (authClient) void refreshDatabases(authClient);
            }}
          />
        </header>

        {error ? <StatusPanel tone="error" message={error} /> : null}
        {warning ? <StatusPanel tone="info" message={warning} /> : null}
        {createdDatabaseId ? <CreatedDatabasePanel databaseId={createdDatabaseId} /> : null}

        <section className="rounded-lg border border-line bg-paper shadow-sm">
          {principal ? (
            <div className="flex flex-col gap-3 border-b border-line px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="text-lg font-semibold text-ink">Databases</h2>
                <p className="mt-1 font-mono text-xs text-muted">{principal}</p>
              </div>
              <p className="text-sm text-muted">Principal balance: <span className="font-mono text-ink">{principalBilling?.balanceE8s ?? "0"} e8s</span></p>
            </div>
          ) : (
            <div className="border-b border-line px-4 py-4">
              <h2 className="text-lg font-semibold text-ink">Public databases</h2>
              <p className="mt-1 text-sm leading-6 text-muted">Login with Internet Identity to list databases where your principal has membership.</p>
            </div>
          )}
          {principal ? (
            <div className="grid gap-4 border-b border-line p-4">
              <form className="grid gap-3 lg:grid-cols-[1fr_180px_auto]" onSubmit={createDatabase}>
                <input className="rounded-lg border border-line px-3 py-2 text-sm" value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Display name" />
                <input className="rounded-lg border border-line px-3 py-2 font-mono text-sm" inputMode="numeric" value={initialDepositE8s} onChange={(event) => setInitialDepositE8s(event.target.value)} placeholder="initial e8s" />
                <button className="rounded-lg border border-accent bg-accent px-3 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-60" disabled={creating || loadState === "loading"} type="submit">
                  {creating ? "Creating..." : "Create database"}
                </button>
              </form>
              <div className="grid gap-3 lg:grid-cols-2">
                <form className="grid gap-3 sm:grid-cols-[1fr_auto]" onSubmit={topUpPrincipal}>
                  <input className="rounded-lg border border-line px-3 py-2 font-mono text-sm" inputMode="numeric" value={topUpAmountE8s} onChange={(event) => setTopUpAmountE8s(event.target.value)} placeholder="principal top-up e8s" />
                  <button className="rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink disabled:opacity-60" disabled={billingBusy !== null} type="submit">
                    {billingBusy === "top-up-principal" ? "Topping up..." : "Top up principal"}
                  </button>
                </form>
                <form className="grid gap-3 sm:grid-cols-[140px_1fr_auto]" onSubmit={withdrawPrincipal}>
                  <input className="rounded-lg border border-line px-3 py-2 font-mono text-sm" inputMode="numeric" value={withdrawAmountE8s} onChange={(event) => setWithdrawAmountE8s(event.target.value)} placeholder="e8s" />
                  <input className="rounded-lg border border-line px-3 py-2 font-mono text-sm" value={withdrawToPrincipal} onChange={(event) => setWithdrawToPrincipal(event.target.value)} placeholder="destination principal" />
                  <button className="rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink disabled:opacity-60" disabled={billingBusy !== null} type="submit">
                    {billingBusy === "withdraw-principal" ? "Withdrawing..." : "Withdraw"}
                  </button>
                </form>
              </div>
              {principalEntries.length > 0 ? (
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse text-left text-xs">
                    <tbody>
                      {principalEntries.map((entry) => (
                        <tr key={entry.entryId} className="border-t border-line">
                          <td className="px-2 py-2 font-mono">{entry.kind}</td>
                          <td className="px-2 py-2 font-mono">{entry.amountE8s}</td>
                          <td className="px-2 py-2 font-mono">{entry.balanceAfterE8s}</td>
                          <td className="px-2 py-2 text-muted">{formatTimestamp(entry.createdAtMs)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </div>
          ) : null}
          <DatabaseBody loading={loadState === "loading"} myDatabases={myDatabases} principal={principal} publicDatabases={publicDatabases} publicError={publicError} />
        </section>
      </section>
    </main>
  );
}

function mergeDatabaseRows(memberDatabases: DatabaseSummary[], publicDatabases: DatabaseSummary[]): DatabaseRow[] {
  const publicIds = new Set(publicDatabases.map((database) => database.databaseId));
  const rows = new Map<string, DatabaseRow>();
  for (const database of publicDatabases) {
    rows.set(database.databaseId, { ...database, member: false, publicReadable: true });
  }
  for (const database of memberDatabases) {
    rows.set(database.databaseId, { ...database, member: true, publicReadable: publicIds.has(database.databaseId) });
  }
  return [...rows.values()].sort((left, right) => left.databaseId.localeCompare(right.databaseId));
}

function listWarning(publicResult: PromiseSettledResult<DatabaseSummary[]>, memberResult: PromiseSettledResult<DatabaseSummary[]>): string | null {
  if (memberResult.status === "rejected") return `Member database list unavailable: ${errorMessage(memberResult.reason)}`;
  return null;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Unexpected error";
}

function parseE8s(value: string): bigint | null {
  const trimmed = value.trim();
  if (!/^[1-9][0-9]*$/.test(trimmed)) return null;
  return BigInt(trimmed);
}

function formatTimestamp(value: string): string {
  const milliseconds = Number(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toLocaleString() : value;
}
