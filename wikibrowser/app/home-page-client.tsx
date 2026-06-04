"use client";

import type { AuthClient } from "@icp-sdk/auth/client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useAppSession } from "./app-session-provider";
import { CreateDatabaseDialog } from "./create-database-dialog";
import { DatabaseBody, OfficialKinicWikiPanel, StatusPanel } from "./home-ui";
import { KINIC_LEDGER_FEE_E8S } from "@/lib/cycles";
import { parseKinicAmountE8sInput } from "@/lib/cycles-url";
import { purchaseCyclesWithOisy, purchaseCyclesWithPlug } from "@/lib/cycles-wallet";
import { formatTokenAmountFromE8s } from "@/lib/kinic-amount";
import type { CyclesBillingConfig, DatabaseSummary } from "@/lib/types";
import { createDatabaseAuthenticated, getCyclesBillingConfig, listDatabasesAuthenticated, listDatabasesPublic } from "@/lib/vfs-client";
import type { DatabaseRow } from "./home-ui";

type LoadState = "idle" | "loading" | "ready" | "error";

const CREATE_DATABASE_PURCHASE_KINIC = "1";

export function HomePageClient() {
  const canisterId = process.env.NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID ?? "";
  const searchParams = useSearchParams();
  const refreshSeqRef = useRef(0);
  const {
    authClient,
    authError,
    authReady,
    authRefreshSeq,
    principal,
    refreshWalletBalance,
    setWalletControlsLocked,
    wallet,
    walletBalance,
    walletBalanceError,
    walletBalanceLoading,
    walletBusyProvider
  } = useAppSession();
  const [databases, setDatabases] = useState<DatabaseRow[]>([]);
  const [cyclesConfig, setCyclesBillingConfig] = useState<CyclesBillingConfig | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [error, setError] = useState<string | null>(null);
  const [publicError, setPublicError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [walletMessage, setWalletMessage] = useState<string | null>(null);
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
        const [cyclesResult, publicResult, memberResult] = await Promise.allSettled([
          getCyclesBillingConfig(canisterId),
          listDatabasesPublic(canisterId),
          identity ? listDatabasesAuthenticated(canisterId, identity) : Promise.resolve<DatabaseSummary[]>([])
        ]);
        if (publicResult.status === "rejected" && memberResult.status === "rejected") {
          throw new Error(`${errorMessage(publicResult.reason)}; ${errorMessage(memberResult.reason)}`);
        }
        const publicDatabases = publicResult.status === "fulfilled" ? publicResult.value : [];
        const memberDatabases = memberResult.status === "fulfilled" ? memberResult.value : [];
        const nextDatabases = mergeDatabaseRows(memberDatabases, publicDatabases);
        if (!isCurrentRefresh()) return;
        setDatabases(nextDatabases);
        setCyclesBillingConfig(cyclesResult.status === "fulfilled" ? cyclesResult.value : null);
        setPublicError(publicResult.status === "rejected" ? `Public database list unavailable: ${errorMessage(publicResult.reason)}` : null);
        setWarning(listWarning(memberResult));
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
    if (!authReady) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      const databaseRefreshClient = principal && authClient ? authClient : null;
      void refreshDatabases(databaseRefreshClient);
    });
    return () => {
      cancelled = true;
    };
  }, [authClient, authReady, authRefreshSeq, principal, refreshDatabases]);

  useEffect(() => {
    setWalletControlsLocked(creating);
    return () => setWalletControlsLocked(false);
  }, [creating, setWalletControlsLocked]);

  useEffect(() => {
    if (principal) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setCyclesBillingConfig(null);
      setCreateDialogOpen(false);
      setNewDatabaseName("");
      setWalletMessage(null);
    });
    return () => {
      cancelled = true;
    };
  }, [principal]);

  async function createDatabase() {
    if (!authClient || !canisterId) return;
    const databaseNameInput = newDatabaseName.trim();
    const validationError = databaseNameError(databaseNameInput);
    if (validationError) {
      setError(validationError);
      setLoadState("error");
      return;
    }
    if (!wallet) {
      setError(`Connect OISY or Plug with at least ${formatTokenAmountFromE8s(createDatabaseRequiredBalanceE8s())} before creating a database.`);
      setLoadState("error");
      return;
    }
    if (!walletCanFundCreate(walletBalance)) {
      setError(`Create database requires at least ${formatTokenAmountFromE8s(createDatabaseRequiredBalanceE8s())} in the connected wallet.`);
      setLoadState("error");
      return;
    }
    setCreating(true);
    setError(null);
    setWalletMessage(null);
    let createdDatabaseId: string | null = null;
    try {
      const result = await createDatabaseAuthenticated(canisterId, authClient.getIdentity(), databaseNameInput);
      createdDatabaseId = result.database_id;
      setCreateDialogOpen(false);
      setNewDatabaseName("");
      const paymentAmountE8s = createDatabasePurchaseAmountE8s();
      setWalletMessage(`Database created pending. Requesting ${walletLabel(wallet.provider)} approval for ${formatTokenAmountFromE8s(paymentAmountE8s)}.`);
      const purchaseResult =
        wallet.provider === "oisy"
          ? await purchaseCyclesWithOisy({ canisterId, databaseId: result.database_id, paymentAmountE8s }, wallet.connection)
          : await purchaseCyclesWithPlug({ canisterId, databaseId: result.database_id, paymentAmountE8s }, wallet.connection);
      setWalletMessage(
        `${walletLabel(wallet.provider)} purchased cycles ${purchaseResult.purchasedCycles}; paid ${formatTokenAmountFromE8s(purchaseResult.paymentAmountE8s)}; database activation can complete.`
      );
      await refreshWalletBalance(wallet);
      await refreshDatabases(authClient);
    } catch (cause) {
      const message = errorMessage(cause);
      if (createdDatabaseId) {
        await refreshDatabases(authClient);
        setError(`Database created pending, but initial cycles purchase failed: ${message}`);
      } else {
        setError(message);
      }
      setLoadState("error");
    } finally {
      setCreating(false);
    }
  }

  const myDatabases = databases.filter((database) => database.member);
  const publicDatabases = databases.filter((database) => !database.member && database.publicReadable);
  const trimmedDatabaseName = newDatabaseName.trim();
  const databaseNameValidationError = databaseNameError(trimmedDatabaseName);
  const walletReadyToFundCreate = walletCanFundCreate(walletBalance);
  const createUnavailable = !principal || loadState === "loading" || walletBusyProvider !== null || walletBalanceLoading || !walletReadyToFundCreate;
  const createDisabled = creating || createUnavailable || databaseNameValidationError !== null;
  const createButtonLabel = databaseCreateButtonLabel({
    creating,
    iiConnected: Boolean(principal),
    walletConnected: Boolean(wallet),
    walletBalanceLoading,
    walletReadyToFundCreate
  });
  const fundingSuccessMessage = dashboardFundingSuccessMessage(searchParams);
  const createDatabaseAction = (
    <button
      className="inline-flex items-center justify-center gap-2 rounded-lg border border-action bg-action px-3 py-2 text-sm font-bold text-white hover:border-accent hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
      disabled={creating || createUnavailable}
      type="button"
      onClick={() => setCreateDialogOpen(true)}
    >
      <Plus aria-hidden size={15} />
      <span>{createButtonLabel}</span>
    </button>
  );

  return (
    <main className="min-h-screen px-6 pb-8 pt-6">
      <section className="mx-auto flex max-w-6xl flex-col gap-6">
        {authError ? <StatusPanel tone="error" message={authError} /> : null}
        {error ? <StatusPanel tone="error" message={error} /> : null}
        {walletBalanceError ? <StatusPanel tone="error" message={walletBalanceError} /> : null}
        {warning ? <StatusPanel tone="info" message={warning} /> : null}
        {fundingSuccessMessage ? <StatusPanel tone="info" message={fundingSuccessMessage} /> : null}
        {walletMessage ? <StatusPanel tone="info" message={walletMessage} /> : null}
        <CreateDatabaseDialog
          createDisabled={createDisabled}
          creating={creating}
          databaseName={newDatabaseName}
          open={createDialogOpen}
          requiredBalanceLabel={formatTokenAmountFromE8s(createDatabaseRequiredBalanceE8s())}
          validationError={databaseNameValidationError}
          onCancel={() => {
            if (creating) return;
            setCreateDialogOpen(false);
            setNewDatabaseName("");
          }}
          onChange={setNewDatabaseName}
          onSubmit={() => void createDatabase()}
        />

        <OfficialKinicWikiPanel />

        {principal ? (
          <DatabaseBody
            createDatabaseAction={createDatabaseAction}
            cyclesConfig={cyclesConfig}
            loading={loadState === "loading"}
            myDatabases={myDatabases}
            principal={principal}
            publicDatabases={publicDatabases}
            publicError={publicError}
          />
        ) : (
          <section className="rounded-lg border border-line bg-paper shadow-sm">
            <div className="flex flex-col gap-3 border-b border-line px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="text-lg font-semibold text-ink">Public databases</h2>
                <p className="mt-1 text-sm leading-6 text-muted">Public databases open without login. Login with Internet Identity to show My databases linked to your principal.</p>
              </div>
              {createDatabaseAction}
            </div>
            <DatabaseBody createDatabaseAction={createDatabaseAction} cyclesConfig={cyclesConfig} loading={loadState === "loading"} myDatabases={myDatabases} principal={principal} publicDatabases={publicDatabases} publicError={publicError} />
          </section>
        )}
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

function listWarning(memberResult: PromiseSettledResult<DatabaseSummary[]>): string | null {
  if (memberResult.status === "rejected") return `Member database list unavailable: ${errorMessage(memberResult.reason)}`;
  return null;
}

function createDatabasePurchaseAmountE8s(): bigint {
  const parsed = parseKinicAmountE8sInput(CREATE_DATABASE_PURCHASE_KINIC);
  if (typeof parsed === "string") throw new Error(parsed);
  return parsed;
}

function createDatabaseRequiredBalanceE8s(): bigint {
  return createDatabasePurchaseAmountE8s() + KINIC_LEDGER_FEE_E8S * 2n;
}

function walletLabel(provider: "oisy" | "plug"): string {
  return provider === "oisy" ? "OISY" : "Plug";
}

function walletCanFundCreate(balanceE8s: string | null): boolean {
  if (!balanceE8s || !/^\d+$/.test(balanceE8s)) return false;
  return BigInt(balanceE8s) >= createDatabaseRequiredBalanceE8s();
}

function databaseCreateButtonLabel({
  creating,
  iiConnected,
  walletConnected,
  walletBalanceLoading,
  walletReadyToFundCreate
}: {
  creating: boolean;
  iiConnected: boolean;
  walletConnected: boolean;
  walletBalanceLoading: boolean;
  walletReadyToFundCreate: boolean;
}): string {
  if (creating) return "Creating...";
  if (!iiConnected) return "Connect Internet Identity";
  if (!walletConnected) return "Connect OISY or Plug";
  if (walletBalanceLoading) return "Checking balance...";
  if (!walletReadyToFundCreate) return "Insufficient KINIC";
  return "Create and fund database";
}

function dashboardFundingSuccessMessage(params: { get(name: string): string | null }): string | null {
  if (params.get("funding") !== "success") return null;
  const databaseId = params.get("database_id") ?? "";
  const provider = params.get("provider") ?? "";
  const kinic = params.get("kinic") ?? "";
  const cycles = params.get("cycles") ?? "";
  if (!/^[a-zA-Z0-9_-]+$/.test(databaseId)) return null;
  if (provider !== "oisy" && provider !== "plug") return null;
  if (!/^(?:<0\.001|[0-9]+\.[0-9]{3}) KINIC$/.test(kinic)) return null;
  if (!/^(?:[0-9]+|[0-9]{1,3}(?:,[0-9]{3})+)$/.test(cycles)) return null;
  return `${walletLabel(provider)} purchased ${cycles} cycles for ${databaseId}; paid ${kinic}.`;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Unexpected error";
}

function databaseNameError(databaseName: string): string | null {
  if (databaseName.length === 0) return "Database name is required.";
  if ([...databaseName].length > 80) return "Database name must be 1..80 characters.";
  return /[\u0000-\u001f\u007f]/.test(databaseName) ? "Database name may not contain control characters." : null;
}
