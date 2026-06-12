"use client";

// Where: root wikibrowser layout.
// What: renders the shared dashboard/cycles header with external wallet controls.
// Why: external wallet funding stays separate from the sidebar App account controls.
import { usePathname } from "next/navigation";
import { AdminHeader } from "@/components/admin-header";
import { formatTokenAmountFromE8s } from "@/lib/kinic-amount";
import { WalletControls } from "./home-ui";
import { connectedWalletPrincipal, useAppSession } from "./app-session-provider";

export function AppHeader() {
  const pathname = usePathname();
  const {
    connectWallet,
    disconnectWallet,
    wallet,
    walletBalance,
    walletBalanceLoading,
    walletBusyProvider,
    walletControlsLocked
  } = useAppSession();

  const isDashboard = pathname === "/dashboard" || pathname.startsWith("/dashboard/");
  const isMarketplace = pathname === "/marketplace" || pathname.startsWith("/marketplace/");
  const isCycles = pathname === "/cycles";
  const isProfile = pathname === "/profile";
  const isCli = pathname === "/cli";
  if (!isDashboard && !isCycles && !isMarketplace && !isProfile && !isCli) return null;

  const connectedWalletLabel = wallet ? `${walletLabel(wallet.provider)} ${shortPrincipal(connectedWalletPrincipal(wallet))}` : null;
  const connectedWalletBalanceLabel = walletBalance ? formatTokenAmountFromE8s(walletBalance) : null;
  return (
    <div className="px-6 pt-4">
      <section className="max-w-none">
        <AdminHeader
          title="Console"
          nav={null}
          actions={
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
