"use client";

import Link from "next/link";
import { CircleAlert } from "lucide-react";
import { useState } from "react";
import { useAppSession } from "@/app/app-session-provider";
import { depositMarketBalanceWithOisy, depositMarketBalanceWithPlug } from "@/lib/kinic-wallet";
import { formatTokenAmountFromE8s } from "@/lib/kinic-amount";

type MarketWalletClientProps = {
  canisterId: string;
};

export function MarketWalletClient({ canisterId }: MarketWalletClientProps) {
  const { refreshWalletBalance, wallet } = useAppSession();
  const [balance, setBalance] = useState<string | null>(null);
  const [amount, setAmount] = useState("1");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function deposit() {
    if (!wallet) {
      setError("Connect OISY or Plug first");
      return;
    }
    const amountE8s = parseDepositAmount(amount);
    if (!amountE8s) {
      setError("Invalid KINIC amount");
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result =
        wallet.provider === "oisy"
          ? await depositMarketBalanceWithOisy({ canisterId, amountE8s: BigInt(amountE8s) }, wallet.connection)
          : await depositMarketBalanceWithPlug({ canisterId, amountE8s: BigInt(amountE8s) }, wallet.connection);
      setBalance(result.balanceE8s);
      setMessage(`Deposit block ${result.depositBlockIndex}`);
      await refreshWalletBalance(wallet);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen bg-white px-6 pb-10 pt-6 text-ink">
      <section className="mx-auto grid max-w-5xl gap-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">Market wallet</h1>
            <p className="text-sm text-muted">{wallet ? walletPrincipal(wallet) : "Wallet disconnected"}</p>
          </div>
          <Link className="rounded-lg border border-line px-3 py-2 text-sm font-semibold hover:border-accent" href="/marketplace">
            Marketplace
          </Link>
        </div>

        <section className="grid gap-3 rounded-lg border border-line p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase text-muted">Balance</p>
              <p className="font-mono text-2xl font-semibold">{balance ? formatTokenAmountFromE8s(balance) : "-"}</p>
              <p className="mt-1 text-xs text-muted">Updated from wallet deposit and purchase results.</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <input
              className="min-h-11 min-w-0 flex-1 rounded-lg border border-line px-3 py-2 font-mono text-sm outline-none focus:border-accent"
              inputMode="decimal"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
            />
            <button
              className="min-h-11 rounded-lg border border-action bg-action px-4 text-sm font-semibold text-white hover:bg-accent disabled:opacity-60"
              disabled={!wallet || busy}
              type="button"
              onClick={() => void deposit()}
            >
              Deposit
            </button>
          </div>
        </section>

        {message ? <p className="rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800">{message}</p> : null}
        {error ? (
          <p className="inline-flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
            <CircleAlert aria-hidden className="mt-0.5 shrink-0" size={16} />
            <span>{error}</span>
          </p>
        ) : null}

        <section className="grid gap-2 rounded-lg border border-line p-4">
          <h2 className="text-sm font-semibold">History</h2>
          <p className="text-sm text-muted">Market history is wallet-principal scoped. Deposit and purchase confirmations appear after wallet-approved actions.</p>
        </section>
      </section>
    </main>
  );
}

function walletPrincipal(wallet: ReturnType<typeof useAppSession>["wallet"]): string {
  if (!wallet) return "";
  return wallet.provider === "oisy" ? wallet.connection.owner : wallet.connection.principal;
}

function parseDepositAmount(value: string): string | null {
  const trimmed = value.trim();
  if (!/^\d+(\.\d{0,8})?$/.test(trimmed)) return null;
  const [whole, fraction = ""] = trimmed.split(".");
  return `${whole}${fraction.padEnd(8, "0")}`.replace(/^0+(?=\d)/, "");
}
