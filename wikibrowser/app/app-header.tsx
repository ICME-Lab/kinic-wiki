"use client";

// Where: root wikibrowser layout.
// What: renders the shared dashboard/cycles header with wallet and II controls.
// Why: funding pages should keep the same wallet session and management shell.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { CircleAlert, X } from "lucide-react";
import { useState } from "react";
import { AdminHeader } from "@/components/admin-header";
import { parseDepositAmount } from "@/lib/kinic-deposit";
import { depositKinicBalanceWithIdentity } from "@/lib/kinic-wallet";
import { formatTokenAmountFromE8s } from "@/lib/kinic-amount";
import { AuthControls, WalletControls } from "./home-ui";
import { connectedWalletPrincipal, useAppSession } from "./app-session-provider";

export function AppHeader() {
  const pathname = usePathname();
  const {
    authClient,
    authLoading,
    authReady,
    connectWallet,
    disconnectWallet,
    kinicBalance,
    kinicBalanceError,
    kinicBalanceLoading,
    login,
    logout,
    principal,
    refreshKinicBalance,
    wallet,
    walletBalance,
    walletBalanceLoading,
    walletBusyProvider,
    walletControlsLocked
  } = useAppSession();
  const [kinicModalOpen, setKinicModalOpen] = useState(false);

  const isMarketplace = pathname === "/marketplace" || pathname.startsWith("/marketplace/");
  if (pathname !== "/dashboard" && pathname !== "/cycles" && !isMarketplace) return null;

  const title = pathname === "/cycles" ? "Database cycles purchase" : isMarketplace ? "Kinic marketplace" : "Database dashboard";
  const connectedWalletLabel = wallet ? `${walletLabel(wallet.provider)} ${shortPrincipal(connectedWalletPrincipal(wallet))}` : null;
  const connectedWalletBalanceLabel = walletBalance ? formatTokenAmountFromE8s(walletBalance) : null;
  const kinicBalanceLabel = kinicBalanceLoading
    ? "Loading"
    : kinicBalanceError
      ? "Unavailable"
      : principal && kinicBalance !== null
        ? formatTokenAmountFromE8s(kinicBalance)
        : "- KINIC";

  return (
    <div className="px-6 pt-8">
      <section className={isMarketplace ? "max-w-none" : "mx-auto max-w-6xl"}>
        <AdminHeader
          title={title}
          nav={<HeaderNav pathname={pathname} />}
          actions={
            <>
              <button
                aria-label="KINIC balance"
                className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-line bg-white px-3 py-2 text-sm font-medium text-ink hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-60"
                disabled={authLoading}
                type="button"
                onClick={() => setKinicModalOpen(true)}
              >
                <span className="font-mono">{kinicBalanceLabel}</span>
              </button>
              <WalletControls
                busyProvider={walletBusyProvider}
                connectedBalanceLabel={connectedWalletBalanceLabel}
                connectedLabel={connectedWalletLabel}
                connectedProvider={wallet?.provider ?? null}
                balanceLoading={walletBalanceLoading}
                disabled={walletControlsLocked}
                onConnect={(provider) => {
                  void connectWallet(provider);
                }}
                onDisconnect={disconnectWallet}
              />
              <AuthControls
                authReady={authReady && Boolean(authClient)}
                principal={principal}
                loading={authLoading}
                onLogin={() => {
                  void login();
                }}
                onLogout={() => {
                  void logout();
                }}
              />
            </>
          }
        />
        {kinicModalOpen ? (
          <KinicDepositModal
            authClient={authClient}
            authReady={authReady}
            balance={kinicBalance}
            balanceError={kinicBalanceError}
            balanceLoading={kinicBalanceLoading}
            canisterId={process.env.NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID ?? ""}
            login={login}
            principal={principal}
            refreshKinicBalance={refreshKinicBalance}
            onClose={() => setKinicModalOpen(false)}
          />
        ) : null}
      </section>
    </div>
  );
}

function walletLabel(provider: "oisy" | "plug"): string {
  return provider === "oisy" ? "OISY" : "Plug";
}

function HeaderNav({ pathname }: { pathname: string }) {
  return (
    <nav className="flex flex-wrap gap-3 text-sm font-semibold">
      {pathname !== "/dashboard" ? (
        <Link className="text-accent no-underline hover:underline" href="/dashboard">
          Dashboard
        </Link>
      ) : null}
      {pathname !== "/marketplace" ? (
        <Link className="text-accent no-underline hover:underline" href="/marketplace">
          Marketplace
        </Link>
      ) : null}
    </nav>
  );
}

type KinicDepositModalProps = {
  authClient: ReturnType<typeof useAppSession>["authClient"];
  authReady: boolean;
  balance: string | null;
  balanceError: string | null;
  balanceLoading: boolean;
  canisterId: string;
  login: () => Promise<void>;
  principal: string | null;
  refreshKinicBalance: () => Promise<void>;
  onClose: () => void;
};

function KinicDepositModal({
  authClient,
  authReady,
  balance,
  balanceError,
  balanceLoading,
  canisterId,
  login,
  principal,
  refreshKinicBalance,
  onClose
}: KinicDepositModalProps) {
  const [amount, setAmount] = useState("1");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const currentBalance = balanceLoading ? "Loading" : balance !== null ? formatTokenAmountFromE8s(balance) : "-";

  async function deposit() {
    if (!authClient || !principal) {
      setError("Login with Internet Identity first");
      return;
    }
    const amountE8s = parseDepositAmount(amount);
    if (!amountE8s) {
      setError("Enter an amount greater than 0 KINIC");
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await depositKinicBalanceWithIdentity({ canisterId, amountE8s: BigInt(amountE8s) }, authClient.getIdentity());
      setMessage(`Deposit block ${result.depositBlockIndex}. Balance ${formatTokenAmountFromE8s(result.balanceE8s)}`);
      await refreshKinicBalance();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/35 px-4 py-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section className="grid w-full max-w-md gap-4 rounded-lg border border-line bg-white p-4 text-ink shadow-[0_18px_60px_#14142b33]">
        <div className="flex items-start justify-between gap-3">
          <div className="grid gap-1">
            <h2 className="text-lg font-semibold">Deposit KINIC</h2>
            <p className="break-all text-xs text-muted">{principal ?? (authReady ? "Internet Identity disconnected" : "Loading identity")}</p>
          </div>
          <button className="grid size-9 place-items-center rounded-lg hover:bg-paper" type="button" onClick={onClose}>
            <X aria-label="Close" size={17} />
          </button>
        </div>

        <div className="grid gap-1 rounded-lg border border-line p-3">
          <p className="text-xs font-semibold uppercase text-muted">Balance</p>
          <p className="font-mono text-2xl font-semibold">{currentBalance}</p>
          {balanceError ? <p className="text-xs text-red-700">{balanceError}</p> : null}
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
            disabled={!principal || busy}
            type="button"
            onClick={() => void deposit()}
          >
            Deposit
          </button>
          {!principal ? (
            <button className="min-h-11 rounded-lg border border-line px-4 text-sm font-semibold hover:border-accent" disabled={!authReady} type="button" onClick={() => void login()}>
              Login
            </button>
          ) : null}
        </div>

        {message ? <p className="rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800">{message}</p> : null}
        {error ? (
          <p className="inline-flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
            <CircleAlert aria-hidden className="mt-0.5 shrink-0" size={16} />
            <span>{error}</span>
          </p>
        ) : null}
      </section>
    </div>
  );
}

function shortPrincipal(value: string): string {
  if (value.length <= 16) return value;
  return `${value.slice(0, 8)}...${value.slice(-5)}`;
}
