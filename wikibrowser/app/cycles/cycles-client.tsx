// Where: /cycles client UI.
// What: collects a KINIC amount locally, then submits wallet approval and cycles purchase.
// Why: the final purchase amount belongs to wallet-facing UI state.
"use client";

import { useRouter } from "next/navigation";
import { PlugZap, Wallet } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAppSession } from "@/app/app-session-provider";
import { AdminContent } from "@/components/admin-shell";
import { AdminField, AdminNotice, AdminPanel } from "@/components/admin-ui";
import { parseKinicAmountE8sInput, parseCyclesTarget } from "@/lib/cycles-url";
import { databaseCyclesHref, databaseCyclesView } from "@/lib/cycles-state";
import { purchaseCyclesWithWallet } from "@/lib/kinic-wallet";
import { formatTokenAmountFromE8s } from "@/lib/kinic-amount";
import { walletRuntime } from "@/lib/wallet-runtime";
import { getCyclesBillingConfig, listDatabasesAuthenticated } from "@/lib/vfs-client";
import type { CyclesBillingConfig, DatabaseStatus, DatabaseSummary } from "@/lib/types";

type CyclesStatus = "idle" | "running" | "success" | "notice" | "error";
type CyclesProvider = "oisy" | "plug";
type FundingProvider = CyclesProvider;
type DatabaseLoadState = "idle" | "loading" | "ready" | "error";

type CyclesClientProps = {
  canisterId: string;
  databaseId: string;
  databaseStatus: DatabaseStatus | null;
};

export function CyclesClient({ canisterId, databaseId, databaseStatus }: CyclesClientProps) {
  const router = useRouter();
  const { authClient, principal, refreshWalletBalance, wallet, walletBalanceError, walletBusyProvider } = useAppSession();
  const [status, setStatus] = useState<CyclesStatus>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [amount, setAmount] = useState("1");
  const [databaseLoadState, setDatabaseLoadState] = useState<DatabaseLoadState>("idle");
  const [databaseLoadError, setDatabaseLoadError] = useState<string | null>(null);
  const [databases, setDatabases] = useState<DatabaseSummary[]>([]);
  const [cyclesConfig, setCyclesConfig] = useState<CyclesBillingConfig | null>(null);
  const configuredCanisterId = process.env.NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID ?? "";
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
        ? "NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID is not configured"
        : null);
  const amountError = typeof parsedAmount === "string" ? parsedAmount : null;
  const busy = status === "running" || walletBusyProvider !== null;
  const selectedProvider = wallet?.provider ?? null;
  const runtime = walletRuntime();
  const purchaseDisabled =
    parsedTarget === null ||
    typeof parsedTarget === "string" ||
    Boolean(error) ||
    Boolean(amountError) ||
    busy ||
    !selectedProvider ||
    !runtime.externalWalletsAvailable;

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
      setDatabaseLoadError(cause instanceof Error ? cause.message : String(cause));
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

  function selectDatabase(nextDatabaseId: string) {
    const nextDatabase = fundableDatabases.find((database) => database.databaseId === nextDatabaseId);
    if (!nextDatabase) return;
    router.replace(databaseCyclesHref(nextDatabase));
  }

  async function purchase() {
    if (parsedTarget === null || typeof parsedTarget === "string" || typeof parsedAmount !== "bigint" || error) return;
    setStatus("running");
    setMessage(null);
    try {
      const request = { canisterId, databaseId: parsedTarget.databaseId, paymentAmountE8s: parsedAmount };
      if (!wallet || !selectedProvider) return;
        const result = await purchaseCyclesWithWallet(request, wallet);
      const balance = result.balanceCycles ? `cycles balance ${result.balanceCycles}` : "cycles purchase accepted";
      setMessage(
        `${result.provider} purchased cycles ${result.purchasedCycles}; paid ${formatTokenAmountFromE8s(result.paymentAmountE8s)}; approved allowance ${formatTokenAmountFromE8s(result.approvedAllowanceE8s)}; ledger transfer fee in allowance ${formatTokenAmountFromE8s(result.transferFeeE8s)}; ${balance}`
      );
      await refreshWalletBalance(wallet);
      setStatus("success");
      router.replace(cyclesPurchaseSuccessHref({
        cycles: result.purchasedCycles,
        databaseId: parsedTarget.databaseId,
        kinic: formatTokenAmountFromE8s(result.paymentAmountE8s),
        provider: result.provider
      }));
    } catch (cause) {
      void cause;
      setMessage("Cycles purchase did not complete. Review the wallet prompt or try again from Cycles.");
      setStatus("notice");
    }
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
                  {database.name} · {database.status} · {databaseCyclesView(database, cyclesConfig).summary}
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

        {!principal ? <Notice tone="info" text="Login with Internet Identity to select a database." /> : null}
        {principal && databaseLoadState === "loading" ? <Notice tone="info" text="Loading linked databases." /> : null}
        {databaseLoadError ? <Notice tone="error" text={databaseLoadError} /> : null}
        {hasNoFundableDatabases ? <Notice tone="info" text="No fundable databases linked to this principal." /> : null}
        {databaseId && principal && databaseLoadState === "ready" && !selectedDatabase ? <Notice tone="info" text="The selected database is not linked to this principal. The URL target is still shown below." /> : null}
        {resolvedDatabaseStatus === "pending" ? <Notice tone="info" text="A newly created database is pending, not active, until this first cycles purchase completes." /> : null}

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
        {walletBalanceError ? <Notice tone="error" text={walletBalanceError} /> : null}
        {status === "success" && message ? <Notice tone="success" text={message} /> : null}
        {status === "notice" && message ? <Notice tone="info" text={message} /> : null}
        {status === "error" && message ? <Notice tone="error" text={message} /> : null}
      </div>
    </AdminContent>
  );
}

function purchaseButtonLabel(selectedProvider: CyclesProvider | null, status: CyclesStatus): string {
  if (status === "running") {
    if (selectedProvider === "oisy") return "Processing OISY";
    if (selectedProvider === "plug") return "Processing Plug";
  }
  if (selectedProvider === "oisy") return "Purchase cycles with OISY";
  if (selectedProvider === "plug") return "Purchase cycles with Plug";
  return "Purchase cycles";
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
