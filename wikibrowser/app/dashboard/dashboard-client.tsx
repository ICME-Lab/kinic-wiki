"use client";

import { AuthClient } from "@icp-sdk/auth/client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AuthControls, OwnerPanel, ReadonlyMembersPanel, StatusPanel, SummaryPanel } from "./dashboard-ui";
import { AUTH_CLIENT_CREATE_OPTIONS, authLoginOptions } from "@/lib/auth";
import type { DatabaseMember, DatabaseRole, DatabaseSummary } from "@/lib/types";
import {
  grantDatabaseAccessAuthenticated,
  listDatabaseMembersAuthenticated,
  listDatabaseMembersPublic,
  listDatabasesAuthenticated,
  listDatabasesPublic,
  renameDatabaseAuthenticated,
  revokeDatabaseAccessAuthenticated
} from "@/lib/vfs-client";

type LoadState = "idle" | "loading" | "ready" | "error";
type BusyAction = { kind: "grant"; principalText: string; role: DatabaseRole } | { kind: "revoke"; principalText: string } | { kind: "rename" };
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
        setPrincipal(client?.getIdentity().getPrincipal().toText() ?? null);
        setDatabases([]);
        setMembers([]);
        setError(null);
        setWarning(null);
        setMemberError(null);
        setLoadState("ready");
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
        } else if (nextDatabase?.publicReadable) {
          try {
            const nextMembers = await listDatabaseMembersPublic(canisterId, nextDatabaseId);
            if (!isCurrentRefresh()) return;
            setMembers(nextMembers);
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
    AuthClient.create(AUTH_CLIENT_CREATE_OPTIONS)
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
      ...authLoginOptions(),
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

  async function renameDatabase(name: string) {
    if (!authClient || !databaseId) return;
    setBusy(true);
    setBusyAction({ kind: "rename" });
    setActionMessage(null);
    try {
      await renameDatabaseAuthenticated(canisterId, authClient.getIdentity(), databaseId, name);
      setActionTone("info");
      setActionMessage("Database name updated.");
      await refresh(authClient, databaseId);
    } catch (cause) {
      setActionTone("error");
      setActionMessage(errorMessage(cause));
    } finally {
      setBusy(false);
      setBusyAction(null);
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
            <h1 className="mt-2 text-3xl font-semibold text-ink">{database?.name ?? "Database access"}</h1>
            <p className="mt-1 font-mono text-xs text-muted">{databaseId || "unknown database"}</p>
          </div>
          <AuthControls authReady={Boolean(authClient)} loading={loadState === "loading"} principal={principal} onLogin={login} onLogout={logout} />
        </header>

        {error ? <StatusPanel tone="error" message={error} /> : null}
        {warning ? <StatusPanel tone="info" message={warning} /> : null}
        {actionMessage ? <StatusPanel tone={actionTone} message={actionMessage} /> : null}

        {database ? <SummaryPanel database={database} databaseId={databaseId} principal={principal ?? "anonymous"} publicReadable={database.publicReadable} /> : null}

        {database ? (
          canManage ? (
            <OwnerPanel busy={busy} busyAction={busyAction} databaseName={database.name} members={members} principal={principal ?? "anonymous"} onGrant={grantAccess} onRename={renameDatabase} onRevoke={revokeAccess} />
          ) : database.publicReadable ? (
            <ReadonlyMembersPanel memberError={memberError} members={members} principal={principal ?? "anonymous"} />
          ) : principal ? (
            <StatusPanel tone="info" message={memberError ?? "No management permission for this database."} />
          ) : (
            <StatusPanel tone="info" message="Login with Internet Identity to manage database access." />
          )
        ) : !databaseId ? (
          <section className="rounded-lg border border-line bg-paper p-8 shadow-sm">
            <h2 className="text-lg font-semibold text-ink">Select a database to manage</h2>
            <p className="mt-2 text-sm leading-6 text-muted">Open the Database dashboard, then choose Access on a database row.</p>
            <Link className="mt-5 inline-flex rounded-2xl border border-action bg-action px-4 py-2 text-sm font-bold text-white no-underline hover:-translate-y-[3px] hover:border-accent hover:bg-accent" href="/">
              Open Database dashboard
            </Link>
          </section>
        ) : (
          <section className="rounded-lg border border-line bg-paper p-8 shadow-sm">
            <p className="text-sm leading-6 text-muted">Public anonymous read is not available for this database. Login with Internet Identity to manage database access.</p>
          </section>
        )}
      </section>
    </main>
  );
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Unexpected error";
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
  return [...rows.values()].sort((left, right) => left.name.localeCompare(right.name) || left.databaseId.localeCompare(right.databaseId));
}
