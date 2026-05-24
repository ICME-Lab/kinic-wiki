"use client";

import Link from "next/link";
import { CheckCircle2, CircleAlert, PlugZap, Wallet } from "lucide-react";
import { useMemo, useState } from "react";
import { parseDepositQuery } from "@/lib/deposit-url";
import { depositWithOisy, depositWithPlug } from "@/lib/deposit-wallet";

type DepositStatus = "idle" | "running" | "success" | "error";
type DepositProvider = "oisy" | "plug";

type DepositClientProps = {
  canisterId: string;
  databaseId: string;
  amountE8s: string;
};

export function DepositClient({ canisterId, databaseId, amountE8s }: DepositClientProps) {
  const [status, setStatus] = useState<DepositStatus>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [provider, setProvider] = useState<DepositProvider | null>(null);
  const parsed = useMemo(() => {
    const params = new URLSearchParams();
    params.set("database_id", databaseId);
    params.set("amount_e8s", amountE8s);
    return parseDepositQuery(params);
  }, [amountE8s, databaseId]);
  const error = typeof parsed === "string" ? parsed : !canisterId ? "NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID is not configured" : null;

  async function deposit(nextProvider: DepositProvider) {
    if (typeof parsed === "string" || !canisterId) return;
    setStatus("running");
    setProvider(nextProvider);
    setMessage(null);
    try {
      const request = { canisterId, databaseId: parsed.databaseId, amountE8s: parsed.amountE8s };
      const result = nextProvider === "oisy" ? await depositWithOisy(request) : await depositWithPlug(request);
      const balance = result.balanceE8s ? `DB balance ${result.balanceE8s} e8s` : "top-up accepted";
      setMessage(
        `${result.provider} approve block ${result.approveBlockIndex}; DB credited ${result.creditedAmountE8s} e8s; approved allowance ${result.approvedAllowanceE8s} e8s including ${result.transferFeeE8s} e8s transfer fee; ${balance}`
      );
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
          <h1 className="mt-5 text-3xl font-semibold">Database deposit</h1>
        </header>

        <section className="grid gap-3 rounded-lg border border-line bg-white p-4 shadow-[0_8px_28px_#14142b0d]">
          <Field label="Database" value={databaseId || "-"} />
          <Field label="Amount e8s" value={amountE8s || "-"} />
          <Field label="Canister" value={canisterId || "-"} />
        </section>

        <div className="flex flex-col gap-3 sm:flex-row">
          <button
            className="inline-flex min-h-12 items-center justify-center gap-2 rounded-lg border border-action bg-action px-4 py-3 font-semibold text-white hover:border-accent hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
            disabled={Boolean(error) || status === "running"}
            type="button"
            onClick={() => void deposit("oisy")}
          >
            <Wallet aria-hidden size={18} />
            <span>{status === "running" && provider === "oisy" ? "Processing OISY" : "OISY"}</span>
          </button>
          <button
            className="inline-flex min-h-12 items-center justify-center gap-2 rounded-lg border border-line bg-white px-4 py-3 font-semibold text-ink shadow-[0_4px_10px_#14142b0a] hover:border-accent hover:bg-accent hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
            disabled={Boolean(error) || status === "running"}
            type="button"
            onClick={() => void deposit("plug")}
          >
            <PlugZap aria-hidden size={18} />
            <span>{status === "running" && provider === "plug" ? "Processing Plug" : "Plug"}</span>
          </button>
        </div>

        {error ? <Notice tone="error" text={error} /> : null}
        {status === "success" && message ? <Notice tone="success" text={message} /> : null}
        {status === "error" && message ? <Notice tone="error" text={message} /> : null}
      </section>
    </main>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1">
      <span className="text-xs font-semibold uppercase text-muted">{label}</span>
      <span className="break-all font-mono text-sm">{value}</span>
    </div>
  );
}

function Notice({ tone, text }: { tone: "success" | "error"; text: string }) {
  const Icon = tone === "success" ? CheckCircle2 : CircleAlert;
  const classes = tone === "success" ? "border-green-200 bg-green-50 text-green-900" : "border-red-200 bg-red-50 text-red-900";
  return (
    <div className={`flex items-start gap-2 rounded-lg border p-3 text-sm ${classes}`}>
      <Icon aria-hidden className="mt-0.5 shrink-0" size={16} />
      <span className="break-words">{text}</span>
    </div>
  );
}
