"use client";

import { AuthClient } from "@icp-sdk/auth/client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { CreateDatabaseDialog } from "./create-database-dialog";
import { AuthControls, DatabaseBody, OfficialKinicWikiPanel, StatusPanel, WalletControls, type HeaderWalletProvider } from "./home-ui";
import { AdminHeader } from "@/components/admin-header";
import { AUTH_CLIENT_CREATE_OPTIONS, authLoginOptions } from "@/lib/auth";
import { KINIC_LEDGER_FEE_E8S } from "@/lib/cycles";
import { parseKinicAmountE8sInput } from "@/lib/cycles-url";
import { connectOisyWallet, connectPlugWallet, getConnectedWalletKinicBalance, purchaseCyclesWithOisy, purchaseCyclesWithPlug, type ConnectedKinicWallet } from "@/lib/cycles-wallet";
import { formatTokenAmountFromE8s } from "@/lib/kinic-amount";
import type { CyclesBillingConfig, DatabaseSummary } from "@/lib/types";
import { createDatabaseAuthenticated, getCyclesBillingConfig, listDatabasesAuthenticated, listDatabasesPublic } from "@/lib/vfs-client";
import type { DatabaseRow } from "./home-ui";

type LoadState = "idle" | "loading" | "ready" | "error";
type ConnectedHeaderWallet = ConnectedKinicWallet;

const CREATE_DATABASE_PURCHASE_KINIC = "1";

export default function HomePage() {
  const canisterId = process.env.NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID ?? "";
  const refreshSeqRef = useRef(0);
  const walletBalanceSeqRef = useRef(0);
  const [authClient, setAuthClient] = useState<AuthClient | null>(null);
  const [principal, setPrincipal] = useState<string | null>(null);
  const [databases, setDatabases] = useState<DatabaseRow[]>([]);
  const [cyclesConfig, setCyclesBillingConfig] = useState<CyclesBillingConfig | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [publicError, setPublicError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [walletMessage, setWalletMessage] = useState<string | null>(null);
  const [wallet, setWallet] = useState<ConnectedHeaderWallet | null>(null);
  const [walletBalance, setWalletBalance] = useState<string | null>(null);
  const [walletBalanceLoading, setWalletBalanceLoading] = useState(false);
  const [walletBalanceError, setWalletBalanceError] = useState<string | null>(null);
  const [walletBusyProvider, setWalletBusyProvider] = useState<HeaderWalletProvider | null>(null);
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
        setPrincipal(identity?.getPrincipal().toText() ?? null);
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
    setCyclesBillingConfig(null);
    setCreateDialogOpen(false);
    setNewDatabaseName("");
    setError(null);
    setPublicError(null);
    setWalletMessage(null);
    walletBalanceSeqRef.current += 1;
    setWallet(null);
    setWalletBalance(null);
    setWalletBalanceLoading(false);
    setWalletBalanceError(null);
    await refreshDatabases(null);
  }

  async function refreshWalletBalance(nextWallet: ConnectedHeaderWallet) {
    const balanceSeq = (walletBalanceSeqRef.current += 1);
    const isCurrentBalance = () => balanceSeq === walletBalanceSeqRef.current;
    setWalletBalance(null);
    setWalletBalanceLoading(true);
    setWalletBalanceError(null);
    try {
      const balance = await getConnectedWalletKinicBalance(canisterId, nextWallet);
      if (!isCurrentBalance()) return;
      setWalletBalance(balance);
    } catch (cause) {
      if (!isCurrentBalance()) return;
      setWalletBalance(null);
      setWalletBalanceError(`KINIC balance unavailable: ${errorMessage(cause)}`);
    } finally {
      if (!isCurrentBalance()) return;
      setWalletBalanceLoading(false);
    }
  }

  async function connectWallet(provider: HeaderWalletProvider) {
    if (creating || walletBusyProvider) return;
    setWalletBusyProvider(provider);
    setError(null);
    setWalletMessage(null);
    try {
      if (provider === "oisy") {
        const connection = await connectOisyWallet();
        const nextWallet: ConnectedHeaderWallet = { provider, connection };
        setWallet(nextWallet);
        void refreshWalletBalance(nextWallet);
      } else {
        const connection = await connectPlugWallet();
        const nextWallet: ConnectedHeaderWallet = { provider, connection };
        setWallet(nextWallet);
        void refreshWalletBalance(nextWallet);
      }
    } catch (cause) {
      setError(errorMessage(cause));
      setLoadState("error");
    } finally {
      setWalletBusyProvider(null);
    }
  }

  function disconnectWallet(provider: HeaderWalletProvider) {
    if (creating || walletBusyProvider || wallet?.provider !== provider) return;
    walletBalanceSeqRef.current += 1;
    setWallet(null);
    setWalletBalance(null);
    setWalletBalanceLoading(false);
    setWalletBalanceError(null);
    setWalletMessage(null);
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
  const createUnavailable = loadState === "loading" || walletBusyProvider !== null || walletBalanceLoading || !walletReadyToFundCreate;
  const createDisabled = creating || createUnavailable || databaseNameValidationError !== null;
  const connectedWalletLabel = wallet ? `${walletLabel(wallet.provider)} ${shortPrincipal(walletPrincipal(wallet))}` : null;
  const connectedWalletBalanceLabel = walletBalance ? formatTokenAmountFromE8s(walletBalance) : null;
  const createButtonLabel = databaseCreateButtonLabel({ creating, walletConnected: Boolean(wallet), walletBalanceLoading, walletReadyToFundCreate });

  return (
    <main className="min-h-screen px-6 py-8">
      <section className="mx-auto flex max-w-6xl flex-col gap-6">
        <AdminHeader
          title="Database dashboard"
          actions={
            <>
              <WalletControls
                busyProvider={walletBusyProvider}
                connectedBalanceLabel={connectedWalletBalanceLabel}
                connectedLabel={connectedWalletLabel}
                connectedProvider={wallet?.provider ?? null}
                balanceLoading={walletBalanceLoading}
                disabled={creating}
                onConnect={(provider) => {
                  void connectWallet(provider);
                }}
                onDisconnect={disconnectWallet}
              />
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
            </>
          }
        />

        {error ? <StatusPanel tone="error" message={error} /> : null}
        {walletBalanceError ? <StatusPanel tone="error" message={walletBalanceError} /> : null}
        {warning ? <StatusPanel tone="info" message={warning} /> : null}
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
            createDatabaseAction={
              <button
                className="inline-flex items-center justify-center gap-2 rounded-lg border border-action bg-action px-3 py-2 text-sm font-bold text-white hover:border-accent hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
                disabled={creating || createUnavailable}
                type="button"
                onClick={() => setCreateDialogOpen(true)}
              >
                <Plus aria-hidden size={15} />
                <span>{createButtonLabel}</span>
              </button>
            }
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
            </div>
            <DatabaseBody cyclesConfig={cyclesConfig} loading={loadState === "loading"} myDatabases={myDatabases} principal={principal} publicDatabases={publicDatabases} publicError={publicError} />
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

function walletLabel(provider: HeaderWalletProvider): string {
  return provider === "oisy" ? "OISY" : "Plug";
}

function walletPrincipal(wallet: ConnectedHeaderWallet): string {
  return wallet.provider === "oisy" ? wallet.connection.owner : wallet.connection.principal;
}

function walletCanFundCreate(balanceE8s: string | null): boolean {
  if (!balanceE8s || !/^\d+$/.test(balanceE8s)) return false;
  return BigInt(balanceE8s) >= createDatabaseRequiredBalanceE8s();
}

function databaseCreateButtonLabel({
  creating,
  walletConnected,
  walletBalanceLoading,
  walletReadyToFundCreate
}: {
  creating: boolean;
  walletConnected: boolean;
  walletBalanceLoading: boolean;
  walletReadyToFundCreate: boolean;
}): string {
  if (creating) return "Creating...";
  if (!walletConnected) return "Connect wallet first";
  if (walletBalanceLoading) return "Checking balance...";
  if (!walletReadyToFundCreate) return "Insufficient KINIC";
  return "Create and fund database";
}

function shortPrincipal(value: string): string {
  if (value.length <= 16) return value;
  return `${value.slice(0, 8)}...${value.slice(-5)}`;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Unexpected error";
}

function databaseNameError(databaseName: string): string | null {
  if (databaseName.length === 0) return "Database name is required.";
  if ([...databaseName].length > 80) return "Database name must be 1..80 characters.";
  return /[\u0000-\u001f\u007f]/.test(databaseName) ? "Database name may not contain control characters." : null;
}
