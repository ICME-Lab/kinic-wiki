"use client";

// Where: root wikibrowser layout.
// What: renders the shared dashboard/cycles header with wallet and II controls.
// Why: funding pages should keep the same wallet session and management shell.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AdminHeader } from "@/components/admin-header";
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
    login,
    logout,
    principal,
    refreshAuth,
    wallet,
    walletBalance,
    walletBalanceLoading,
    walletBusyProvider,
    walletControlsLocked
  } = useAppSession();

  const isMarketplace = pathname === "/marketplace" || pathname.startsWith("/marketplace/");
  if (pathname !== "/" && pathname !== "/cycles" && !isMarketplace) return null;

  const title = pathname === "/cycles" ? "Database cycles purchase" : isMarketplace ? "Kinic marketplace" : "Database dashboard";
  const connectedWalletLabel = wallet ? `${walletLabel(wallet.provider)} ${shortPrincipal(connectedWalletPrincipal(wallet))}` : null;
  const connectedWalletBalanceLabel = walletBalance ? formatTokenAmountFromE8s(walletBalance) : null;

  return (
    <div className="px-6 pt-8">
      <section className="mx-auto max-w-6xl">
        <AdminHeader
          title={title}
          nav={<HeaderNav pathname={pathname} />}
          actions={
            <>
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
                onRefresh={() => {
                  void refreshAuth();
                }}
              />
            </>
          }
        />
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
      {pathname !== "/" ? (
        <Link className="text-accent no-underline hover:underline" href="/">
          Dashboard
        </Link>
      ) : null}
      {pathname !== "/marketplace" ? (
        <Link className="text-accent no-underline hover:underline" href="/marketplace">
          Marketplace
        </Link>
      ) : null}
      {pathname !== "/marketplace/wallet" ? (
        <Link className="text-accent no-underline hover:underline" href="/marketplace/wallet">
          Wallet
        </Link>
      ) : null}
    </nav>
  );
}

function shortPrincipal(value: string): string {
  if (value.length <= 16) return value;
  return `${value.slice(0, 8)}...${value.slice(-5)}`;
}
