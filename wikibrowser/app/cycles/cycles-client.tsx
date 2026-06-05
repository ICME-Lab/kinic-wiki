// Where: /cycles client UI.
// What: collects a KINIC amount locally, then submits wallet approval and cycles purchase.
// Why: the final purchase amount belongs to wallet-facing UI state.
"use client";

import { useRouter } from "next/navigation";
import { CheckCircle2, CircleAlert, Info, PlugZap, Wallet } from "lucide-react";
import { useMemo, useState } from "react";
import { useAppSession } from "@/app/app-session-provider";
import { parseKinicAmountE8sInput, parseCyclesTarget } from "@/lib/cycles-url";
import { purchaseCyclesWithOisy, purchaseCyclesWithPlug } from "@/lib/cycles-wallet";
import { formatTokenAmountFromE8s } from "@/lib/kinic-amount";
import type { DatabaseStatus } from "@/lib/types";

type CyclesStatus = "idle" | "running" | "success" | "error";
type CyclesProvider = "oisy" | "plug";

type CyclesClientProps = {
  canisterId: string;
  databaseId: string;
  databaseStatus: DatabaseStatus | null;
};

export function CyclesClient({ canisterId, databaseId, databaseStatus }: CyclesClientProps) {
  const router = useRouter();
  const { refreshWalletBalance, wallet, walletBalanceError, walletBusyProvider } = useAppSession();
  const [status, setStatus] = useState<CyclesStatus>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [amount, setAmount] = useState("1");
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
  const purchaseDisabled = !selectedProvider || Boolean(error) || Boolean(amountError) || busy;

  async function purchase() {
    if (!wallet || !selectedProvider) return;
    if (typeof parsedTarget === "string" || typeof parsedAmount !== "bigint" || error) return;
    setStatus("running");
    setMessage(null);
    try {
      const request = { canisterId, databaseId: parsedTarget.databaseId, paymentAmountE8s: parsedAmount };
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
        </section>

        {databaseStatus === "pending" ? <Notice tone="info" text="A newly created database is pending, not active, until this first cycles purchase completes." /> : null}
        <Notice tone="warning" text="Any authenticated wallet can purchase non-refundable cycles for this database." />

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
        {status === "error" && message ? <Notice tone="error" text={message} /> : null}
      </section>
    </main>
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
  provider: CyclesProvider;
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
