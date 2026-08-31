// Where: /cycles client UI.
// What: collects a KINIC amount locally, then submits wallet approval and cycles purchase.
// Why: the final purchase amount belongs to wallet-facing UI state.
"use client";

import { useAppNavigate } from "@/lib/app-router";
import { LogIn, PlugZap, Wallet } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAppSession } from "@/app/app-session-provider";
import { connectedWalletPrincipal } from "@/app/app-session-provider";
import { balanceCanFund, KinicFundingSourceSelector, useFundingSourceChoice } from "@/app/kinic-funding-source-selector";
import { AdminContent } from "@/components/admin-shell";
import { AdminField, AdminNotice, AdminPanel } from "@/components/admin-ui";
import { parseKinicAmountE8sInput, parseCyclesTarget } from "@/lib/cycles-url";
import { databaseCyclesHref, databaseCyclesView } from "@/lib/cycles-state";
import { requiredKinicBalanceE8s } from "@/lib/cycles";
import { purchaseCyclesWithFundingSource, type FundingProvider, type KinicFundingSource } from "@/lib/kinic-wallet";
import { formatTokenAmountFromE8s } from "@/lib/kinic-amount";
import { getCyclesBillingConfig, listDatabasesAuthenticated } from "@/lib/vfs-client";
import { errorMessage } from "@/lib/wiki-helpers";
import type { CyclesBillingConfig, DatabaseStatus, DatabaseSummary } from "@/lib/types";

type CyclesStatus = "idle" | "running" | "success" | "notice" | "error";
type DatabaseLoadState = "idle" | "loading" | "ready" | "error";

type CyclesClientProps = {
  canisterId: string;
  databaseId: string;
  databaseStatus: DatabaseStatus | null;
};

export function CyclesClient({ canisterId, databaseId, databaseStatus }: CyclesClientProps) {
  const router = useAppNavigate();
  const {
    authClient,
    authError,
    authLoading,
    authReady,
    setAuthControlsLocked,
    identityLedgerBalance,
    identityLedgerBalanceError,
    identityLedgerBalanceLoading,
    login,
    principal,
    refreshIdentityLedgerBalanceFor,
    refreshIdentityLedgerBalance,
    refreshWalletBalance,
    setWalletControlsLocked,
    wallet,
    walletBalance,
    walletBalanceError,
    walletBalanceLoading,
    walletBusyProvider,
    walletSessionReady
  } = useAppSession();
  const [status, setStatus] = useState<CyclesStatus>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [amount, setAmount] = useState("1");
  const [databaseLoadState, setDatabaseLoadState] = useState<DatabaseLoadState>("idle");
  const [databaseLoadError, setDatabaseLoadError] = useState<string | null>(null);
  const [databases, setDatabases] = useState<DatabaseSummary[]>([]);
  const [cyclesConfig, setCyclesConfig] = useState<CyclesBillingConfig | null>(null);
  const fundingChoice = useFundingSourceChoice(wallet !== null, walletSessionReady);
  const principalRef = useRef(principal);
  const walletRef = useRef(wallet);
  principalRef.current = principal;
  walletRef.current = wallet;
  const configuredCanisterId = import.meta.env.VITE_KINIC_WIKI_CANISTER_ID ?? "";
  const parsedTarget = useMemo(() => {
    const params = new URLSearchParams();
    params.set("database_id", databaseId);
    return parseCyclesTarget(params);
  }, [databaseId]);
  const selectedDatabase = useMemo(() => databases.find((database) => database.databaseId === databaseId) ?? null, [databaseId, databases]);
  const fundableDatabases = useMemo(() => databases.filter((database) => databaseCyclesView(database, cyclesConfig).purchaseAvailable), [cyclesConfig, databases]);
  const resolvedDatabaseStatus = selectedDatabase?.status ?? databaseStatus;
  const parsedAmount = useMemo(() => parseKinicAmountE8sInput(amount), [amount]);
  const hasNoFundableDatabases = principal !== null && databaseLoadState === "ready" && fundableDatabases.length === 0;
  const targetError = typeof parsedTarget === "string" && !hasNoFundableDatabases ? parsedTarget : null;
  const error =
    targetError ??
    (!configuredCanisterId
        ? "VITE_KINIC_WIKI_CANISTER_ID is not configured"
        : null);
  const amountError = typeof parsedAmount === "string" ? parsedAmount : null;
  const requiredBalanceE8s = typeof parsedAmount === "bigint" ? requiredKinicBalanceE8s(parsedAmount) : 0n;
  const selectedProvider: FundingProvider = fundingChoice.selected === "ii" ? "ii" : wallet?.provider ?? "oisy";
  const selectedBalance = fundingChoice.selected === "ii" ? identityLedgerBalance : walletBalance;
  const selectedBalanceError = fundingChoice.selected === "ii" ? identityLedgerBalanceError : walletBalanceError;
  const selectedBalanceLoading = fundingChoice.selected === "ii" ? identityLedgerBalanceLoading : walletBalanceLoading;
  const selectedSourceAvailable = fundingChoice.selected === "ii" ? Boolean(authClient && principal) : Boolean(wallet);
  const selectedBalanceSufficient = typeof parsedAmount === "bigint" && balanceCanFund(selectedBalance, requiredBalanceE8s);
  const busy = status === "running" || (fundingChoice.selected === "wallet" && walletBusyProvider !== null);
  const purchaseDisabled =
    parsedTarget === null ||
    typeof parsedTarget === "string" ||
    Boolean(error) ||
    Boolean(amountError) ||
    busy ||
    !selectedSourceAvailable ||
    selectedBalanceLoading ||
    Boolean(selectedBalanceError) ||
    !selectedBalanceSufficient;

  const loadDatabases = useCallback(async () => {
    if (!authClient || !principal || !canisterId) {
      setDatabases([]);
      setCyclesConfig(null);
      setDatabaseLoadState("idle");
      setDatabaseLoadError(null);
      return;
    }
    setDatabaseLoadState("loading");
    setDatabaseLoadError(null);
    try {
      const identity = authClient.getIdentity();
      const [nextDatabases, nextCyclesConfig] = await Promise.all([
        listDatabasesAuthenticated(canisterId, identity),
        getCyclesBillingConfig(canisterId)
      ]);
      setDatabases(nextDatabases);
      setCyclesConfig(nextCyclesConfig);
      setDatabaseLoadState("ready");
    } catch (cause) {
      setDatabases([]);
      setCyclesConfig(null);
      setDatabaseLoadError(errorMessage(cause));
      setDatabaseLoadState("error");
    }
  }, [authClient, canisterId, principal]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      void loadDatabases();
    });
    return () => {
      cancelled = true;
    };
  }, [loadDatabases]);

  useEffect(() => {
    setWalletControlsLocked(status === "running");
    return () => setWalletControlsLocked(false);
  }, [setWalletControlsLocked, status]);

  useEffect(() => {
    setAuthControlsLocked(status === "running");
    return () => setAuthControlsLocked(false);
  }, [setAuthControlsLocked, status]);

  function selectDatabase(nextDatabaseId: string) {
    const nextDatabase = fundableDatabases.find((database) => database.databaseId === nextDatabaseId);
    if (!nextDatabase) return;
    router.replace(databaseCyclesHref(nextDatabase));
  }

  async function purchase() {
    if (parsedTarget === null || typeof parsedTarget === "string" || typeof parsedAmount !== "bigint" || error) return;
    const principalAtSubmit = principal;
    const sourceAtSubmit: KinicFundingSource | null =
      fundingChoice.selected === "ii"
        ? authClient && principal
          ? { provider: "ii", identity: authClient.getIdentity() }
          : null
        : wallet;
    if (!sourceAtSubmit || !selectedBalanceSufficient || selectedBalanceLoading || selectedBalanceError) return;
    const sourceIsCurrent = () => {
      if (sourceAtSubmit.provider === "ii") return principalRef.current === principalAtSubmit;
      const currentWallet = walletRef.current;
      return currentWallet !== null && currentWallet.provider === sourceAtSubmit.provider && connectedWalletPrincipal(currentWallet) === connectedWalletPrincipal(sourceAtSubmit);
    };
    setStatus("running");
    setMessage(null);
    let result: Awaited<ReturnType<typeof purchaseCyclesWithFundingSource>> | null = null;
    let purchaseError: unknown = null;
    try {
      const request = { canisterId, databaseId: parsedTarget.databaseId, paymentAmountE8s: parsedAmount };
      result = await purchaseCyclesWithFundingSource(request, sourceAtSubmit);
    } catch (cause) {
      purchaseError = cause;
    }
    if (sourceIsCurrent()) {
      try {
        if (sourceAtSubmit.provider === "ii") {
          if (principalAtSubmit) await refreshIdentityLedgerBalanceFor(sourceAtSubmit.identity, principalAtSubmit);
        } else {
          await refreshWalletBalance(sourceAtSubmit);
        }
      } catch {
        // Preserve the purchase result when a balance refresh also fails.
      }
    }
    if (purchaseError !== null) {
      if (!sourceIsCurrent()) {
        setStatus("idle");
        return;
      }
      setMessage("Cycles purchase did not complete. Review the payment request or try again from Cycles.");
      setStatus("notice");
      return;
    }
    if (!result || !sourceIsCurrent()) {
      setStatus("idle");
      return;
    }
    const balance = result.balanceCycles ? `cycles balance ${result.balanceCycles}` : "cycles purchase accepted";
    setMessage(
      `${result.provider} purchased cycles ${result.purchasedCycles}; paid ${formatTokenAmountFromE8s(result.paymentAmountE8s)}; approved allowance ${formatTokenAmountFromE8s(result.approvedAllowanceE8s)}; ledger transfer fee in allowance ${formatTokenAmountFromE8s(result.transferFeeE8s)}; ${balance}`
    );
    setStatus("success");
    router.replace(cyclesPurchaseSuccessHref({
      cycles: result.purchasedCycles,
      databaseId: parsedTarget.databaseId,
      kinic: formatTokenAmountFromE8s(result.paymentAmountE8s),
      provider: result.provider
    }));
  }

  return (
    <AdminContent>
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 text-ink">
        <AdminPanel className="grid gap-3 bg-white" padding="md">
          <label className="grid gap-2">
            <span className="text-xs font-semibold uppercase text-muted">Database</span>
            <select
              className="min-h-12 rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
              disabled={!principal || databaseLoadState === "loading" || fundableDatabases.length === 0}
              value={fundableDatabases.some((database) => database.databaseId === databaseId) ? databaseId : ""}
              onChange={(event) => selectDatabase(event.target.value)}
            >
              <option value="">Select a database</option>
              {fundableDatabases.map((database) => (
                <option key={database.databaseId} value={database.databaseId}>
                  {database.metadata.name} · {database.status} · {databaseCyclesView(database, cyclesConfig).summary}
                </option>
              ))}
            </select>
          </label>
          <Field label="Database" value={databaseId || "-"} />
          <Field label="Canister" value={canisterId || "-"} />
          <label className="grid gap-2">
            <span className="text-xs font-semibold uppercase text-muted">KINIC amount</span>
            <input
              className="min-h-12 rounded-lg border border-line bg-white px-3 py-2 font-mono text-sm text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
              inputMode="decimal"
              type="text"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
            />
            {amountError ? <span className="text-xs text-red-700">{amountError}</span> : null}
          </label>
        </AdminPanel>

        {!principal ? (
          <div className="grid gap-3">
            <Notice tone="info" text="Login with Internet Identity to select a database." />
            <button
              className="inline-flex min-h-12 items-center justify-center gap-2 rounded-lg border border-action bg-action px-4 py-3 font-semibold text-white hover:border-accent hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
              data-tid="cycles-login-button"
              disabled={!authReady || authLoading || status === "running"}
              type="button"
              onClick={() => void login()}
            >
              <LogIn aria-hidden size={18} />
              <span>{authLoading ? "Preparing Internet Identity" : "Sign in with Internet Identity"}</span>
            </button>
            {authError ? <Notice tone="error" text={authError} /> : null}
          </div>
        ) : null}
        {principal && databaseLoadState === "loading" ? <Notice tone="info" text="Loading linked databases." /> : null}
        {databaseLoadError ? <Notice tone="error" text={databaseLoadError} /> : null}
        {hasNoFundableDatabases ? <Notice tone="info" text="No fundable databases linked to this principal." /> : null}
        {databaseId && principal && databaseLoadState === "ready" && !selectedDatabase ? <Notice tone="info" text="The selected database is not linked to this principal. The URL target is still shown below." /> : null}
        {resolvedDatabaseStatus === "pending" ? <Notice tone="info" text="A newly created database is pending, not active, until this first cycles purchase completes." /> : null}

        {typeof parsedAmount === "bigint" ? (
          <KinicFundingSourceSelector
            identityAccount={{
              available: Boolean(authClient && principal),
              balance: identityLedgerBalance,
              balanceError: identityLedgerBalanceError,
              balanceLoading: identityLedgerBalanceLoading,
              label: "Internet Identity",
              principal,
              refreshDisabled: !principal || identityLedgerBalanceLoading || status === "running",
              onRefresh: () => void refreshIdentityLedgerBalance()
            }}
            onSelect={fundingChoice.select}
            requiredBalanceE8s={requiredBalanceE8s}
            selected={fundingChoice.selected}
            selectionDisabled={status === "running"}
            walletAccount={{
              available: Boolean(wallet),
              balance: walletBalance,
              balanceError: walletBalanceError,
              balanceLoading: walletBalanceLoading,
              label: wallet ? providerLabel(wallet.provider) : "OISY / Plug",
              principal: wallet ? connectedWalletPrincipal(wallet) : null,
              refreshDisabled: !wallet || walletBalanceLoading || walletBusyProvider !== null || status === "running",
              onRefresh: () => {
                if (wallet) void refreshWalletBalance(wallet);
              }
            }}
          />
        ) : null}

        <div className="grid gap-3">
          <button
            className="inline-flex min-h-12 items-center justify-center gap-2 rounded-lg border border-action bg-action px-4 py-3 font-semibold text-white hover:border-accent hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
            disabled={purchaseDisabled}
            type="button"
            onClick={() => void purchase()}
          >
            {selectedProvider === "plug" ? <PlugZap aria-hidden size={18} /> : <Wallet aria-hidden size={18} />}
            <span>{purchaseButtonLabel(selectedProvider, status)}</span>
          </button>
        </div>

        {error ? <Notice tone="error" text={error} /> : null}
        {selectedBalanceError ? <Notice tone="error" text={selectedBalanceError} /> : null}
        {status === "success" && message ? <Notice tone="success" text={message} /> : null}
        {status === "notice" && message ? <Notice tone="info" text={message} /> : null}
        {status === "error" && message ? <Notice tone="error" text={message} /> : null}
      </div>
    </AdminContent>
  );
}

function purchaseButtonLabel(selectedProvider: FundingProvider, status: CyclesStatus): string {
  if (status === "running") {
    if (selectedProvider === "ii") return "Processing Internet Identity";
    if (selectedProvider === "oisy") return "Processing OISY";
    if (selectedProvider === "plug") return "Processing Plug";
  }
  if (selectedProvider === "ii") return "Purchase cycles with Internet Identity";
  if (selectedProvider === "oisy") return "Purchase cycles with OISY";
  if (selectedProvider === "plug") return "Purchase cycles with Plug";
  return "Purchase cycles";
}

function providerLabel(provider: Exclude<FundingProvider, "ii">): string {
  return provider === "oisy" ? "OISY" : "Plug";
}

function cyclesPurchaseSuccessHref({
  cycles,
  databaseId,
  kinic,
  provider
}: {
  cycles: string;
  databaseId: string;
  kinic: string;
  provider: FundingProvider;
}): string {
  const params = new URLSearchParams();
  params.set("funding", "success");
  params.set("database_id", databaseId);
  params.set("provider", provider);
  params.set("kinic", kinic);
  params.set("cycles", cycles);
  return `/dashboard?${params.toString()}`;
}

function Field({ label, value }: { label: string; value: string }) {
  return <AdminField breakAll mono label={label} value={value} />;
}

function Notice({ tone, text }: { tone: "success" | "error" | "info" | "warning"; text: string }) {
  return <AdminNotice tone={tone} message={text} />;
}
