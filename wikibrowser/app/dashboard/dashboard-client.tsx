"use client";

import { AuthClient } from "@icp-sdk/auth/client";
import Link from "next/link";
import type { FormEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AuthControls, OwnerPanel, StatusPanel, SummaryPanel } from "./dashboard-ui";
import { DELEGATION_TTL_NS, identityProviderUrl } from "@/lib/auth";
import type { DatabaseBillingEntry, DatabaseMember, DatabaseRole, DatabaseSummary } from "@/lib/types";
import {
  grantDatabaseAccessAuthenticated,
  listDatabaseBillingEntriesAuthenticated,
  listDatabaseMembersAuthenticated,
  listDatabasesAuthenticated,
  listDatabasesPublic,
  renameDatabaseAuthenticated,
  revokeDatabaseAccessAuthenticated,
  topUpDatabaseAuthenticated,
  withdrawDatabaseBalanceAuthenticated
} from "@/lib/vfs-client";

type LoadState = "idle" | "loading" | "ready" | "error";
type BusyAction = { kind: "grant"; principalText: string; role: DatabaseRole } | { kind: "revoke"; principalText: string };
type DatabaseAccessSummary = DatabaseSummary & { publicReadable: boolean };

export function DashboardDatabaseClient({ databaseId }: { databaseId: string }) {
  const canisterId = process.env.NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID ?? "";
  const refreshSeqRef = useRef(0);
  const [authClient, setAuthClient] = useState<AuthClient | null>(null);
  const [principal, setPrincipal] = useState<string | null>(null);
  const [databases, setDatabases] = useState<DatabaseAccessSummary[]>([]);
  const [members, setMembers] = useState<DatabaseMember[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [memberError, setMemberError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionTone, setActionTone] = useState<"error" | "info">("info");
  const [busy, setBusy] = useState(false);
  const [busyAction, setBusyAction] = useState<BusyAction | null>(null);
  const [billingEntries, setBillingEntries] = useState<DatabaseBillingEntry[]>([]);
  const [renameValue, setRenameValue] = useState("");
  const [topUpAmountE8s, setTopUpAmountE8s] = useState("");
  const [withdrawAmountE8s, setWithdrawAmountE8s] = useState("");

  const database = useMemo(() => databases.find((item) => item.databaseId === databaseId) ?? null, [databaseId, databases]);
  const canManage = database?.role === "owner" && !memberError;

  const refresh = useCallback(
    async (client: AuthClient | null, nextDatabaseId: string) => {
      const refreshSeq = (refreshSeqRef.current += 1);
      const isCurrentRefresh = () => refreshSeq === refreshSeqRef.current;
      if (!canisterId) {
        setError("NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID is not configured.");
        setLoadState("error");
        return;
      }
      if (!nextDatabaseId) {
        setError("Database id is missing.");
        setLoadState("error");
        return;
      }
      setLoadState("loading");
      setError(null);
      setWarning(null);
      setMemberError(null);
      try {
        const identity = client?.getIdentity() ?? null;
        const [publicResult, memberResult] = await Promise.allSettled([
          listDatabasesPublic(canisterId),
          identity ? listDatabasesAuthenticated(canisterId, identity) : Promise.resolve<DatabaseSummary[]>([])
        ]);
        if (publicResult.status === "rejected" && !identity) {
          throw new Error(errorMessage(publicResult.reason));
        }
        if (publicResult.status === "rejected" && memberResult.status === "rejected") {
          throw new Error(`${errorMessage(publicResult.reason)}; ${errorMessage(memberResult.reason)}`);
        }
        const publicDatabases = publicResult.status === "fulfilled" ? publicResult.value : [];
        const memberDatabases = memberResult.status === "fulfilled" ? memberResult.value : [];
        const nextDatabases = mergeDatabaseRows(memberDatabases, publicDatabases);
        if (!isCurrentRefresh()) return;
        const nextDatabase = nextDatabases.find((item) => item.databaseId === nextDatabaseId) ?? null;
        setPrincipal(identity?.getPrincipal().toText() ?? null);
        setDatabases(nextDatabases);
        setMembers([]);
        setBillingEntries([]);
        setRenameValue(nextDatabase?.displayName ?? "");
        if (publicResult.status === "rejected") {
          setWarning(`Public database list unavailable: ${errorMessage(publicResult.reason)}`);
        }
        if (memberResult.status === "rejected") {
          setMemberError(`Member database list unavailable: ${errorMessage(memberResult.reason)}`);
        }
        if (identity && nextDatabase?.role === "owner") {
          try {
            const nextMembers = await listDatabaseMembersAuthenticated(canisterId, identity, nextDatabaseId);
            if (!isCurrentRefresh()) return;
            setMembers(nextMembers);
          } catch (cause) {
            if (!isCurrentRefresh()) return;
            setMemberError(errorMessage(cause));
          }
        }
        if (identity && nextDatabase) {
          try {
            const page = await listDatabaseBillingEntriesAuthenticated(canisterId, identity, nextDatabaseId, null, 25);
            if (!isCurrentRefresh()) return;
            setBillingEntries(page.entries);
          } catch (cause) {
            if (!isCurrentRefresh()) return;
            setMemberError(errorMessage(cause));
          }
        }
        if (!isCurrentRefresh()) return;
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
          await refresh(client, databaseId);
        } else {
          await refresh(null, databaseId);
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
  }, [databaseId, refresh]);

  async function login() {
    if (!authClient) return;
    setError(null);
    await authClient.login({
      identityProvider: identityProviderUrl(),
      maxTimeToLive: DELEGATION_TTL_NS,
      onSuccess: () => {
        void refresh(authClient, databaseId);
      },
      onError: (cause) => {
        setError(errorMessage(cause));
        setLoadState("error");
      }
    });
  }

  async function logout() {
    if (!authClient) return;
    refreshSeqRef.current += 1;
    await authClient.logout();
    setPrincipal(null);
    setDatabases([]);
    setMembers([]);
    setBillingEntries([]);
    setError(null);
    setWarning(null);
    setMemberError(null);
    await refresh(null, databaseId);
  }

  async function grantAccess(principalText: string, role: DatabaseRole) {
    if (!authClient || !databaseId) return;
    setBusy(true);
    setBusyAction({ kind: "grant", principalText, role });
    setActionMessage(null);
    try {
      await grantDatabaseAccessAuthenticated(canisterId, authClient.getIdentity(), databaseId, principalText, role);
      setActionTone("info");
      setActionMessage("Access updated.");
      await refresh(authClient, databaseId);
    } catch (cause) {
      setActionTone("error");
      setActionMessage(errorMessage(cause));
    } finally {
      setBusy(false);
      setBusyAction(null);
    }
  }

  async function revokeAccess(principalText: string) {
    if (!authClient || !databaseId) return;
    setBusy(true);
    setBusyAction({ kind: "revoke", principalText });
    setActionMessage(null);
    try {
      await revokeDatabaseAccessAuthenticated(canisterId, authClient.getIdentity(), databaseId, principalText);
      setActionTone("info");
      setActionMessage("Access revoked.");
      await refresh(authClient, databaseId);
    } catch (cause) {
      setActionTone("error");
      setActionMessage(errorMessage(cause));
    } finally {
      setBusy(false);
      setBusyAction(null);
    }
  }

  async function renameDatabase(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!authClient || !databaseId) return;
    setBusy(true);
    setActionMessage(null);
    try {
      await renameDatabaseAuthenticated(canisterId, authClient.getIdentity(), databaseId, renameValue);
      setActionTone("info");
      setActionMessage("Database renamed.");
      await refresh(authClient, databaseId);
    } catch (cause) {
      setActionTone("error");
      setActionMessage(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function topUpDatabase(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!authClient || !databaseId) return;
    const amount = parseE8s(topUpAmountE8s);
    if (!amount) {
      setActionTone("error");
      setActionMessage("Top-up amount must be a positive integer e8s amount.");
      return;
    }
    setBusy(true);
    setActionMessage(null);
    try {
      await topUpDatabaseAuthenticated(canisterId, authClient.getIdentity(), databaseId, amount);
      setTopUpAmountE8s("");
      setActionTone("info");
      setActionMessage("Database balance topped up.");
      await refresh(authClient, databaseId);
    } catch (cause) {
      setActionTone("error");
      setActionMessage(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function withdrawDatabase(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!authClient || !databaseId) return;
    const amount = parseE8s(withdrawAmountE8s);
    if (!amount) {
      setActionTone("error");
      setActionMessage("Withdraw amount must be a positive integer e8s amount.");
      return;
    }
    setBusy(true);
    setActionMessage(null);
    try {
      await withdrawDatabaseBalanceAuthenticated(canisterId, authClient.getIdentity(), databaseId, amount);
      setWithdrawAmountE8s("");
      setActionTone("info");
      setActionMessage("Database balance withdrawn.");
      await refresh(authClient, databaseId);
    } catch (cause) {
      setActionTone("error");
      setActionMessage(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen px-6 py-8">
      <section className="mx-auto flex max-w-6xl flex-col gap-6">
        <header className="flex flex-col gap-4 border-b border-line pb-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <Link className="text-sm text-accent no-underline hover:underline" href="/">
              Dashboard
            </Link>
            {databaseId ? (
              <Link className="ml-3 text-sm text-accent no-underline hover:underline" href={`/skills/${encodeURIComponent(databaseId)}`}>
                Skill Registry
              </Link>
            ) : null}
            <h1 className="mt-2 text-3xl font-semibold text-ink">Database access</h1>
            <p className="mt-1 font-mono text-xs text-muted">{databaseId || "unknown database"}</p>
          </div>
          <AuthControls authReady={Boolean(authClient)} loading={loadState === "loading"} principal={principal} onLogin={login} onLogout={logout} />
        </header>

        {error ? <StatusPanel tone="error" message={error} /> : null}
        {warning ? <StatusPanel tone="info" message={warning} /> : null}
        {actionMessage ? <StatusPanel tone={actionTone} message={actionMessage} /> : null}

        {database ? <SummaryPanel database={database} databaseId={databaseId} principal={principal ?? "anonymous"} publicReadable={database.publicReadable} /> : null}

        {principal ? (
          database ? (
            <>
              <section className="grid gap-4 rounded-lg border border-line bg-paper p-4 shadow-sm">
                {canManage ? (
                  <form className="grid gap-3 sm:grid-cols-[1fr_auto]" onSubmit={renameDatabase}>
                    <input className="rounded-lg border border-line px-3 py-2 text-sm" value={renameValue} onChange={(event) => setRenameValue(event.target.value)} placeholder="Display name" />
                    <button className="rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink disabled:opacity-60" disabled={busy} type="submit">
                      Rename
                    </button>
                  </form>
                ) : null}
                <div className="grid gap-3 lg:grid-cols-2">
                  <form className="grid gap-3 sm:grid-cols-[1fr_auto]" onSubmit={topUpDatabase}>
                    <input className="rounded-lg border border-line px-3 py-2 font-mono text-sm" inputMode="numeric" value={topUpAmountE8s} onChange={(event) => setTopUpAmountE8s(event.target.value)} placeholder="DB top-up e8s" />
                    <button className="rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink disabled:opacity-60" disabled={busy} type="submit">
                      Top up DB
                    </button>
                  </form>
                  {canManage ? (
                    <form className="grid gap-3 sm:grid-cols-[1fr_auto]" onSubmit={withdrawDatabase}>
                      <input className="rounded-lg border border-line px-3 py-2 font-mono text-sm" inputMode="numeric" value={withdrawAmountE8s} onChange={(event) => setWithdrawAmountE8s(event.target.value)} placeholder="DB withdraw e8s" />
                      <button className="rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink disabled:opacity-60" disabled={busy} type="submit">
                        Withdraw DB
                      </button>
                    </form>
                  ) : null}
                </div>
              </section>
              {canManage ? (
                <OwnerPanel busy={busy} busyAction={busyAction} members={members} principal={principal} onGrant={grantAccess} onRevoke={revokeAccess} />
              ) : (
                <StatusPanel tone="info" message={memberError ?? "No owner permission for access management or DB withdraw."} />
              )}
              <BillingLedgerTable entries={billingEntries} />
            </>
          ) : (
            <StatusPanel tone="error" message="Database is not linked to this principal or public anonymous reads." />
          )
        ) : database ? (
          <StatusPanel tone="info" message="Login with Internet Identity to manage database access." />
        ) : (
          <section className="rounded-lg border border-line bg-paper p-8 shadow-sm">
            <p className="text-sm leading-6 text-muted">Public anonymous read is not available for this database. Login with Internet Identity to manage database access.</p>
          </section>
        )}
      </section>
    </main>
  );
}

function BillingLedgerTable({ entries }: { entries: DatabaseBillingEntry[] }) {
  if (entries.length === 0) {
    return <StatusPanel tone="info" message="No database billing entries." />;
  }
  return (
    <section className="overflow-x-auto rounded-lg border border-line bg-paper shadow-sm">
      <table className="w-full border-collapse text-left text-xs">
        <thead className="bg-white/70 uppercase tracking-[0.12em] text-muted">
          <tr>
            <th className="px-4 py-3 font-medium">Kind</th>
            <th className="px-4 py-3 font-medium">Amount</th>
            <th className="px-4 py-3 font-medium">Balance</th>
            <th className="px-4 py-3 font-medium">Method</th>
            <th className="px-4 py-3 font-medium">When</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.entryId} className="border-t border-line">
              <td className="px-4 py-3 font-mono">{entry.kind}</td>
              <td className="px-4 py-3 font-mono">{entry.amountE8s}</td>
              <td className="px-4 py-3 font-mono">{entry.balanceAfterE8s}</td>
              <td className="px-4 py-3 font-mono">{entry.method ?? "-"}</td>
              <td className="px-4 py-3 text-muted">{formatTimestamp(entry.createdAtMs)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
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

function mergeDatabaseRows(memberDatabases: DatabaseSummary[], publicDatabases: DatabaseSummary[]): DatabaseAccessSummary[] {
  const publicIds = new Set(publicDatabases.map((database) => database.databaseId));
  const rows = new Map<string, DatabaseAccessSummary>();
  for (const database of publicDatabases) {
    rows.set(database.databaseId, { ...database, publicReadable: true });
  }
  for (const database of memberDatabases) {
    rows.set(database.databaseId, { ...database, publicReadable: publicIds.has(database.databaseId) });
  }
  return [...rows.values()].sort((left, right) => left.databaseId.localeCompare(right.databaseId));
}
