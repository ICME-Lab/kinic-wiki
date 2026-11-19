import { createContext, useCallback, useContext, useEffect, useRef, type ReactNode } from "react";
import type { WalletSessionManager } from "@kinic/payments/wallet-session";

type AcquireWallet = (create: () => WalletSessionManager) => WalletSessionManager;
const WalletOwner = createContext<AcquireWallet | null>(null);

// Public routes share the document lifetime without constructing a wallet or restoring auth.
export function WikiWalletLifetime({children}: {children: ReactNode}) {
  const manager = useRef<WalletSessionManager | null>(null);
  const acquire = useCallback<AcquireWallet>(create => manager.current ??= create(), []);
  useEffect(() => {
    const suspend = () => manager.current?.suspend();
    window.addEventListener("pagehide", suspend);
    return () => {
      window.removeEventListener("pagehide", suspend);
      suspend();
    };
  }, []);
  return <WalletOwner.Provider value={acquire}>{children}</WalletOwner.Provider>;
}

export function useWikiWalletOwner() {
  return useContext(WalletOwner);
}
