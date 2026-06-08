// Where: /cycles client UI.
// What: collects a KINIC amount locally, then submits wallet approval and cycles purchase.
// Why: the final purchase amount belongs to wallet-facing UI state.
"use client";

import { useRouter } from "next/navigation";
import { CheckCircle2, CircleAlert, Info, PlugZap, Wallet } from "lucide-react";
import { useMemo, useState } from "react";
import { useAppSession } from "@/app/app-session-provider";
import { cyclesForPaymentAmountE8s } from "@/lib/cycles";
import { parseKinicAmountE8sInput, parseCyclesTarget } from "@/lib/cycles-url";
import { purchaseCyclesWithOisy, purchaseCyclesWithPlug } from "@/lib/kinic-wallet";
import { formatTokenAmountFromE8s } from "@/lib/kinic-amount";
import { getCyclesBillingConfig, kinicFundDatabaseCycles } from "@/lib/vfs-client";
import type { DatabaseStatus } from "@/lib/types";

type CyclesStatus = "idle" | "running" | "success" | "error";
type CyclesProvider = "oisy" | "plug";
type FundingProvider = CyclesProvider | "ii";
type PaymentSource = "wallet" | "kinic";

type CyclesClientProps = {
  canisterId: string;
  databaseId: string;
  databaseStatus: DatabaseStatus | null;
};

export function CyclesClient({ canisterId, databaseId, databaseStatus }: CyclesClientProps) {
  const router = useRouter();
  const { authClient, authLoading, login, principal, refreshKinicBalance, refreshWalletBalance, wallet, walletBalanceError, walletBusyProvider } = useAppSession();
  const [status, setStatus] = useState<CyclesStatus>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [amount, setAmount] = useState("1");
  const [paymentSource, setPaymentSource] = useState<PaymentSource>("wallet");
  const configuredCanisterId = process.env.NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID ?? "";
  const parsedTarget = useMemo(() => {
    const params = new URLSearchParams();
    params.set("database_id", databaseId);
    return parseCyclesTarget(params);
  }, [databaseId]);
  const parsedAmount = useMemo(() => parseKinicAmountE8sInput(amount), [amount]);
  const error =
    typeof parsedTarget === "string"
      ? parsedTarget
      : !configuredCanisterId
        ? "NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID is not configured"
        : null;
  const amountError = typeof parsedAmount === "string" ? parsedAmount : null;
  const busy = status === "running" || walletBusyProvider !== null;
  const selectedProvider = wallet?.provider ?? null;
  const kinicBalancePendingDisabled = paymentSource === "kinic" && databaseStatus === "pending";
  const purchaseDisabled =
    Boolean(error) ||
    Boolean(amountError) ||
    busy ||
    (paymentSource === "wallet" ? !selectedProvider : authLoading || !authClient || kinicBalancePendingDisabled);

  async function purchase() {
    if (typeof parsedTarget === "string" || typeof parsedAmount !== "bigint" || error) return;
    setStatus("running");
    setMessage(null);
    try {
      const request = { canisterId, databaseId: parsedTarget.databaseId, paymentAmountE8s: parsedAmount };
      if (paymentSource === "kinic") {
        if (!authClient || !principal) {
          await login();
          setStatus("idle");
          return;
        }
        const config = await getCyclesBillingConfig(canisterId);
        const minExpectedCycles = cyclesForPaymentAmountE8s(parsedAmount, BigInt(config.cyclesPerKinic));
        const result = await kinicFundDatabaseCycles(
          canisterId,
          authClient.getIdentity(),
          parsedTarget.databaseId,
          parsedAmount.toString(),
          minExpectedCycles.toString()
        );
        setMessage(
          `Internet Identity funded cycles ${result.amountCycles}; paid ${formatTokenAmountFromE8s(result.paymentAmountE8s)} from KINIC balance; database cycles balance ${result.databaseBalanceCycles}; KINIC balance ${formatTokenAmountFromE8s(result.kinicBalanceE8s)}`
        );
        await refreshKinicBalance();
        setStatus("success");
        router.replace(cyclesPurchaseSuccessHref({
          cycles: result.amountCycles,
          databaseId: parsedTarget.databaseId,
          kinic: formatTokenAmountFromE8s(result.paymentAmountE8s),
          provider: "ii"
        }));
        return;
      }
      if (!wallet || !selectedProvider) return;
      const result =
        wallet.provider === "oisy"
          ? await purchaseCyclesWithOisy(request, wallet.connection)
          : await purchaseCyclesWithPlug(request, wallet.connection);
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
      setMessage(cause instanceof Error ? cause.message : String(cause));
      setStatus("error");
    }
  }

  return (
    <main className="min-h-screen bg-white px-6 pb-8 pt-6 text-ink">
      <section className="mx-auto flex max-w-3xl flex-col gap-6">
        <section className="grid gap-3 rounded-lg border border-line bg-white p-4 shadow-[0_8px_28px_#14142b0d]">
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
          <div className="grid gap-2">
            <span className="text-xs font-semibold uppercase text-muted">Payment source</span>
            <div className="grid grid-cols-2 rounded-lg border border-line bg-paper p-1 text-sm font-semibold">
              <button
                className={`min-h-10 rounded-md px-3 ${paymentSource === "wallet" ? "bg-white text-ink shadow-sm" : "text-muted hover:text-ink"}`}
                type="button"
                onClick={() => setPaymentSource("wallet")}
              >
                Wallet KINIC
              </button>
              <button
                className={`min-h-10 rounded-md px-3 ${paymentSource === "kinic" ? "bg-white text-ink shadow-sm" : "text-muted hover:text-ink"}`}
                disabled={databaseStatus === "pending"}
                type="button"
                onClick={() => setPaymentSource("kinic")}
              >
                KINIC balance
              </button>
            </div>
          </div>
        </section>

        {databaseStatus === "pending" ? <Notice tone="info" text="A newly created database is pending, not active, until this first cycles purchase completes." /> : null}
        <Notice tone="warning" text="Any authenticated wallet can purchase non-refundable cycles for this database. Active databases can also use the Internet Identity KINIC balance." />

        <div className="grid gap-3">
          <button
            className="inline-flex min-h-12 items-center justify-center gap-2 rounded-lg border border-action bg-action px-4 py-3 font-semibold text-white hover:border-accent hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
            disabled={purchaseDisabled}
            type="button"
            onClick={() => void purchase()}
          >
            {selectedProvider === "plug" ? <PlugZap aria-hidden size={18} /> : <Wallet aria-hidden size={18} />}
            <span>{purchaseButtonLabel(selectedProvider, status, paymentSource)}</span>
          </button>
        </div>

        {error ? <Notice tone="error" text={error} /> : null}
        {paymentSource === "wallet" && walletBalanceError ? <Notice tone="error" text={walletBalanceError} /> : null}
        {paymentSource === "kinic" && !principal ? <Notice tone="info" text="Login with Internet Identity to use KINIC balance." /> : null}
        {status === "success" && message ? <Notice tone="success" text={message} /> : null}
        {status === "error" && message ? <Notice tone="error" text={message} /> : null}
      </section>
    </main>
  );
}

function purchaseButtonLabel(selectedProvider: CyclesProvider | null, status: CyclesStatus, paymentSource: PaymentSource): string {
  if (paymentSource === "kinic") {
    return status === "running" ? "Processing Internet Identity" : "Fund cycles from KINIC balance";
  }
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
  return (
    <div className="grid gap-1">
      <span className="text-xs font-semibold uppercase text-muted">{label}</span>
      <span className="break-all font-mono text-sm">{value}</span>
    </div>
  );
}

function Notice({ tone, text }: { tone: "success" | "error" | "info" | "warning"; text: string }) {
  const Icon = tone === "success" ? CheckCircle2 : tone === "info" ? Info : CircleAlert;
  const classes =
    tone === "success"
      ? "border-green-200 bg-green-50 text-green-900"
      : tone === "error"
        ? "border-red-200 bg-red-50 text-red-900"
        : tone === "warning"
          ? "border-amber-200 bg-amber-50 text-amber-950"
        : "border-infoLine bg-infoSoft text-ink";
  return (
    <div className={`flex items-start gap-2 rounded-lg border p-3 text-sm ${classes}`}>
      <Icon aria-hidden className="mt-0.5 shrink-0" size={16} />
      <span className="break-words">{text}</span>
    </div>
  );
}
