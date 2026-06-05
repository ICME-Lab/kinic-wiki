"use client";

// Where: root wikibrowser layout.
// What: renders the shared dashboard/cycles header with wallet and II controls.
// Why: funding pages should keep the same wallet session and management shell.
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
    wallet,
    walletBalance,
    walletBalanceLoading,
    walletBusyProvider,
    walletControlsLocked
  } = useAppSession();

  if (pathname !== "/dashboard" && pathname !== "/cycles") return null;

  const title = pathname === "/cycles" ? "Database cycles purchase" : "Database dashboard";
  const connectedWalletLabel = wallet ? `${walletLabel(wallet.provider)} ${shortPrincipal(connectedWalletPrincipal(wallet))}` : null;
  const connectedWalletBalanceLabel = walletBalance ? formatTokenAmountFromE8s(walletBalance) : null;

  return (
    <div className="px-6 pt-8">
      <section className="mx-auto max-w-6xl">
        <AdminHeader
          title={title}
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

function shortPrincipal(value: string): string {
  if (value.length <= 16) return value;
  return `${value.slice(0, 8)}...${value.slice(-5)}`;
}
