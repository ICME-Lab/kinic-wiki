// Where: /credits client UI.
// What: collects a KINIC amount locally, then submits wallet approval and credits purchase.
// Why: CLI/query can seed credits, and the final purchase amount remains user-editable.
"use client";

import Link from "next/link";
import { CheckCircle2, CircleAlert, Info, PlugZap, Wallet } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { parseCreditsAmountInput, parseCreditsTarget } from "@/lib/credits-url";
import { connectOisyWallet, connectPlugWallet, purchaseCreditsWithOisy, purchaseCreditsWithPlug, type ConnectedOisyWallet, type ConnectedPlugWallet } from "@/lib/credits-wallet";
import { formatTokenAmountFromE8s } from "@/lib/credit-amount";

type CreditsStatus = "idle" | "connecting" | "running" | "success" | "error";
type CreditsProvider = "oisy" | "plug";

type CreditsClientProps = {
  canisterId: string;
  databaseId: string;
  initialCredits?: string;
};

export function CreditsClient({ canisterId, databaseId, initialCredits }: CreditsClientProps) {
  const [status, setStatus] = useState<CreditsStatus>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [provider, setProvider] = useState<CreditsProvider | null>(null);
  const [amount, setAmount] = useState(() => (initialCredits?.trim() ? initialCredits : "1"));
  const [oisyWallet, setOisyWallet] = useState<ConnectedOisyWallet | null>(null);
  const [plugWallet, setPlugWallet] = useState<ConnectedPlugWallet | null>(null);
  const configuredCanisterId = process.env.NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID ?? "";
  const parsedTarget = useMemo(() => {
    const params = new URLSearchParams();
    params.set("database_id", databaseId);
    return parseCreditsTarget(params);
  }, [databaseId]);
  const parsedAmount = useMemo(() => parseCreditsAmountInput(amount), [amount]);
  const error =
    typeof parsedTarget === "string"
      ? parsedTarget
      : !configuredCanisterId
        ? "NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID is not configured"
        : null;
  const amountError = typeof parsedAmount === "string" ? parsedAmount : null;
  const busy = status === "connecting" || status === "running";
  const selectedProvider =
    provider === "oisy" && oisyWallet
      ? "oisy"
      : provider === "plug" && plugWallet
        ? "plug"
        : oisyWallet
          ? "oisy"
          : plugWallet
            ? "plug"
            : null;
  const purchaseDisabled = !selectedProvider || Boolean(error) || Boolean(amountError) || busy;

  useEffect(() => {
    return () => {
      if (oisyWallet) void oisyWallet.wallet.disconnect();
    };
  }, [oisyWallet]);

  async function connect(nextProvider: CreditsProvider) {
    setStatus("connecting");
    setProvider(nextProvider);
    setMessage(null);
    try {
      if (nextProvider === "oisy") {
        const nextWallet = await connectOisyWallet();
        setOisyWallet(nextWallet);
        setMessage(`OISY connected ${shortPrincipal(nextWallet.owner)}`);
      } else {
        const nextWallet = await connectPlugWallet();
        setPlugWallet(nextWallet);
        setMessage(`Plug connected ${shortPrincipal(nextWallet.principal)}`);
      }
      setStatus("success");
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause));
      setStatus("error");
    }
  }

  async function purchase() {
    if (!selectedProvider) return;
    if (typeof parsedTarget === "string" || typeof parsedAmount !== "bigint" || error) return;
    const activeOisyWallet = selectedProvider === "oisy" ? oisyWallet : null;
    const activePlugWallet = selectedProvider === "plug" ? plugWallet : null;
    if (selectedProvider === "oisy" && !activeOisyWallet) return;
    if (selectedProvider === "plug" && !activePlugWallet) return;
    setStatus("running");
    setProvider(selectedProvider);
    setMessage(null);
    try {
      const request = { canisterId, databaseId: parsedTarget.databaseId, creditUnits: parsedAmount };
      const result =
        selectedProvider === "oisy" && activeOisyWallet
          ? await purchaseCreditsWithOisy(request, activeOisyWallet)
          : activePlugWallet
            ? await purchaseCreditsWithPlug(request, activePlugWallet)
            : null;
      if (!result) return;
      const balance = result.balanceCredits ? `credits balance ${result.balanceCredits}` : "credits purchase accepted";
      setMessage(
        `${result.provider} approve block ${result.approveBlockIndex}; purchased credits ${result.creditedCredits}; paid ${formatTokenAmountFromE8s(result.paymentAmountE8s)} KINIC; approved allowance ${formatTokenAmountFromE8s(result.approvedAllowanceE8s)}; ledger transfer fee in allowance ${formatTokenAmountFromE8s(result.transferFeeE8s)}; ${balance}`
      );
      if (selectedProvider === "oisy") setOisyWallet(null);
      setStatus("success");
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause));
      setStatus("error");
    }
  }

  return (
    <main className="min-h-screen bg-white px-6 py-8 text-ink">
      <section className="mx-auto flex max-w-3xl flex-col gap-6">
        <header className="border-b border-line pb-5">
          <Link className="text-sm font-medium text-accent no-underline hover:underline" href="/">
            Database dashboard
          </Link>
          <h1 className="mt-5 text-3xl font-semibold">Database purchase</h1>
        </header>

        <section className="grid gap-3 rounded-lg border border-line bg-white p-4 shadow-[0_8px_28px_#14142b0d]">
          <Field label="Database" value={databaseId || "-"} />
          <Field label="Canister" value={canisterId || "-"} />
          <label className="grid gap-2">
            <span className="text-xs font-semibold uppercase text-muted">Amount</span>
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

        <Notice tone="warning" text="Any authenticated wallet can purchase non-refundable credits for this database." />

        <div className="grid gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <WalletConnect
              connectedLabel={oisyWallet ? `OISY ${shortPrincipal(oisyWallet.owner)}` : null}
              disabled={busy}
              icon={<Wallet aria-hidden size={18} />}
              label={status === "connecting" && provider === "oisy" ? "Connecting OISY" : "Connect OISY"}
              onConnect={() => void connect("oisy")}
              onSelect={() => setProvider("oisy")}
              selected={selectedProvider === "oisy"}
            />
            <WalletConnect
              connectedLabel={plugWallet ? `Plug ${shortPrincipal(plugWallet.principal)}` : null}
              disabled={busy}
              icon={<PlugZap aria-hidden size={18} />}
              label={status === "connecting" && provider === "plug" ? "Connecting Plug" : "Connect Plug"}
              onConnect={() => void connect("plug")}
              onSelect={() => setProvider("plug")}
              selected={selectedProvider === "plug"}
            />
          </div>
          <button
            className="inline-flex min-h-12 items-center justify-center gap-2 rounded-lg border border-action bg-action px-4 py-3 font-semibold text-white hover:border-accent hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
            disabled={purchaseDisabled}
            type="button"
            onClick={() => void purchase()}
          >
            {selectedProvider === "plug" ? <PlugZap aria-hidden size={18} /> : <Wallet aria-hidden size={18} />}
            <span>{purchaseButtonLabel(selectedProvider, status, provider)}</span>
          </button>
        </div>

        {error ? <Notice tone="error" text={error} /> : null}
        {status === "success" && message ? <Notice tone="success" text={message} /> : null}
        {status === "error" && message ? <Notice tone="error" text={message} /> : null}
      </section>
    </main>
  );
}

function WalletConnect({
  connectedLabel,
  disabled,
  icon,
  label,
  onConnect,
  onSelect,
  selected
}: {
  connectedLabel: string | null;
  disabled: boolean;
  icon: ReactNode;
  label: string;
  onConnect: () => void;
  onSelect: () => void;
  selected: boolean;
}) {
  return (
    <div className="grid gap-2">
      {connectedLabel ? (
        <button
          className={`inline-flex min-h-12 items-center justify-center gap-2 rounded-lg border px-4 py-3 font-semibold shadow-[0_4px_10px_#14142b0a] disabled:cursor-not-allowed disabled:opacity-60 ${
            selected ? "border-action bg-action text-white" : "border-line bg-white text-ink hover:border-accent hover:text-accent"
          }`}
          disabled={disabled}
          type="button"
          onClick={onSelect}
        >
          {icon}
          <span>{connectedLabel}</span>
        </button>
      ) : (
        <button
          className="inline-flex min-h-12 items-center justify-center gap-2 rounded-lg border border-line bg-white px-4 py-3 font-semibold text-ink shadow-[0_4px_10px_#14142b0a] hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-60"
          disabled={disabled}
          type="button"
          onClick={onConnect}
        >
          {icon}
          <span>{label}</span>
        </button>
      )}
    </div>
  );
}

function purchaseButtonLabel(selectedProvider: CreditsProvider | null, status: CreditsStatus, activeProvider: CreditsProvider | null): string {
  if (status === "running" && activeProvider === selectedProvider) {
    if (selectedProvider === "oisy") return "Processing OISY";
    if (selectedProvider === "plug") return "Processing Plug";
  }
  if (selectedProvider === "oisy") return "Purchase credits with OISY";
  if (selectedProvider === "plug") return "Purchase credits with Plug";
  return "Purchase credits";
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1">
      <span className="text-xs font-semibold uppercase text-muted">{label}</span>
      <span className="break-all font-mono text-sm">{value}</span>
    </div>
  );
}

function shortPrincipal(value: string): string {
  if (value.length <= 16) return value;
  return `${value.slice(0, 8)}...${value.slice(-5)}`;
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
