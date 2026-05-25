"use client";

import { AuthClient } from "@icp-sdk/auth/client";
import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { Plus, TerminalSquare } from "lucide-react";
import { CreateDatabaseDialog } from "./create-database-dialog";
import { AuthControls, CreatedDatabasePanel, DatabaseBody, StatusPanel } from "./home-ui";
import { AUTH_CLIENT_CREATE_OPTIONS, authLoginOptions } from "@/lib/auth";
import type { BillingConfig, DatabaseSummary } from "@/lib/types";
import { createDatabaseAuthenticated, getBillingConfig, listDatabasesAuthenticated, listDatabasesPublic } from "@/lib/vfs-client";
import type { DatabaseRow } from "./home-ui";

type LoadState = "idle" | "loading" | "ready" | "error";

export default function HomePage() {
  const canisterId = process.env.NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID ?? "";
  const refreshSeqRef = useRef(0);
  const [authClient, setAuthClient] = useState<AuthClient | null>(null);
  const [principal, setPrincipal] = useState<string | null>(null);
  const [databases, setDatabases] = useState<DatabaseRow[]>([]);
  const [billingConfig, setBillingConfig] = useState<BillingConfig | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [publicError, setPublicError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [createdDatabase, setCreatedDatabase] = useState<{ databaseId: string; name: string } | null>(null);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [newDatabaseName, setNewDatabaseName] = useState("");
  const [creating, setCreating] = useState(false);

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
        const [publicResult, memberResult, billingConfigResult] = await Promise.allSettled([
          listDatabasesPublic(canisterId),
          identity ? listDatabasesAuthenticated(canisterId, identity) : Promise.resolve<DatabaseSummary[]>([]),
          getBillingConfig(canisterId)
        ]);
        if (publicResult.status === "rejected" && memberResult.status === "rejected") {
          throw new Error(`${errorMessage(publicResult.reason)}; ${errorMessage(memberResult.reason)}`);
        }
        const publicDatabases = publicResult.status === "fulfilled" ? publicResult.value : [];
        const memberDatabases = memberResult.status === "fulfilled" ? memberResult.value : [];
        const nextDatabases = mergeDatabaseRows(memberDatabases, publicDatabases);
        if (!isCurrentRefresh()) return;
        setDatabases(nextDatabases);
        setBillingConfig(billingConfigResult.status === "fulfilled" ? billingConfigResult.value : null);
        setPrincipal(identity?.getPrincipal().toText() ?? null);
        setPublicError(publicResult.status === "rejected" ? `Public database list unavailable: ${errorMessage(publicResult.reason)}` : null);
        setWarning(listWarning(publicResult, memberResult, billingConfigResult));
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
      ...authLoginOptions(),
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
    setBillingConfig(null);
    setCreatedDatabase(null);
    setCreateDialogOpen(false);
    setNewDatabaseName("");
    setError(null);
    setPublicError(null);
    await refreshDatabases(null);
  }

  async function createDatabase() {
    if (!authClient || !canisterId) return;
    const databaseNameInput = newDatabaseName.trim();
    const validationError = databaseNameError(databaseNameInput);
    if (validationError) {
      setError(validationError);
      setLoadState("error");
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const result = await createDatabaseAuthenticated(canisterId, authClient.getIdentity(), databaseNameInput);
      setCreatedDatabase({ databaseId: result.database_id, name: result.name });
      setCreateDialogOpen(false);
      setNewDatabaseName("");
      await refreshDatabases(authClient);
    } catch (cause) {
      setError(errorMessage(cause));
      setLoadState("error");
    } finally {
      setCreating(false);
    }
  }

  const myDatabases = databases.filter((database) => database.member);
  const publicDatabases = databases.filter((database) => !database.member && database.publicReadable);
  const trimmedDatabaseName = newDatabaseName.trim();
  const databaseNameValidationError = databaseNameError(trimmedDatabaseName);
  const createDisabled = creating || loadState === "loading" || databaseNameValidationError !== null;

  return (
    <main className="min-h-screen px-6 py-8">
      <section className="mx-auto flex max-w-6xl flex-col gap-6">
        <header className="flex flex-col gap-4 border-b border-line pb-5 sm:flex-row sm:items-end sm:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <Image className="h-11 w-11 rounded-xl shadow-sm" src="/icon.png" alt="" width={44} height={44} unoptimized />
            <div className="min-w-0">
              <p className="font-mono text-xs uppercase tracking-[0.18em] text-muted">Kinic Wiki</p>
              <h1 className="mt-1 text-3xl font-semibold text-ink">Database dashboard</h1>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Link className="inline-flex items-center justify-center gap-2 rounded-lg border border-line bg-white px-3 py-2 text-sm font-medium text-ink no-underline hover:border-accent hover:text-accent" href="/cli">
              <TerminalSquare aria-hidden size={15} />
              <span>CLI</span>
            </Link>
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
          </div>
        </header>

        {error ? <StatusPanel tone="error" message={error} /> : null}
        {warning ? <StatusPanel tone="info" message={warning} /> : null}
        {createdDatabase ? <CreatedDatabasePanel databaseId={createdDatabase.databaseId} name={createdDatabase.name} /> : null}
        <CreateDatabaseDialog
          createDisabled={createDisabled}
          creating={creating}
          databaseName={newDatabaseName}
          open={createDialogOpen}
          validationError={databaseNameValidationError}
          onCancel={() => {
            if (creating) return;
            setCreateDialogOpen(false);
            setNewDatabaseName("");
          }}
          onChange={setNewDatabaseName}
          onSubmit={() => void createDatabase()}
        />

        <section className="rounded-lg border border-line bg-paper shadow-sm">
          {principal ? (
            <div className="flex flex-col gap-3 border-b border-line px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="text-lg font-semibold text-ink">Databases</h2>
                <p className="mt-1 font-mono text-xs text-muted">{principal}</p>
              </div>
              <button
                className="inline-flex items-center justify-center gap-2 rounded-2xl border border-action bg-action px-3 py-2 text-sm font-bold text-white hover:-translate-y-[3px] hover:border-accent hover:bg-accent disabled:cursor-not-allowed disabled:translate-y-0 disabled:opacity-60"
                disabled={creating || loadState === "loading"}
                type="button"
                onClick={() => setCreateDialogOpen(true)}
              >
                <Plus aria-hidden size={15} />
                <span>{creating ? "Creating..." : "Create database"}</span>
              </button>
            </div>
          ) : (
            <div className="border-b border-line px-4 py-4">
              <h2 className="text-lg font-semibold text-ink">Public databases</h2>
              <p className="mt-1 text-sm leading-6 text-muted">Login with Internet Identity to list databases where your principal has membership.</p>
            </div>
          )}
          <DatabaseBody billingConfig={billingConfig} canisterId={canisterId} loading={loadState === "loading"} myDatabases={myDatabases} principal={principal} publicDatabases={publicDatabases} publicError={publicError} />
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

function listWarning(publicResult: PromiseSettledResult<DatabaseSummary[]>, memberResult: PromiseSettledResult<DatabaseSummary[]>, billingConfigResult: PromiseSettledResult<BillingConfig>): string | null {
  if (billingConfigResult.status === "rejected") return `Billing config unavailable: ${errorMessage(billingConfigResult.reason)}`;
  if (memberResult.status === "rejected") return `Member database list unavailable: ${errorMessage(memberResult.reason)}`;
  return null;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Unexpected error";
}

function databaseNameError(databaseName: string): string | null {
  if (databaseName.length === 0) return "Database name is required.";
  if ([...databaseName].length > 80) return "Database name must be 1..80 characters.";
  return /[\u0000-\u001f\u007f]/.test(databaseName) ? "Database name may not contain control characters." : null;
}
