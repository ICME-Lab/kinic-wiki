import { createContext, useContext, useEffect, useSyncExternalStore, type ReactNode } from "react";
import type { WalletSessionManager } from "./wallet-session";

const Session = createContext<WalletSessionManager | null>(null);

export function WalletSessionProvider({ manager, children }: { manager: WalletSessionManager; children: ReactNode }) {
  useEffect(() => {
    const restore = () => { void manager.restore(); };
    restore();
    window.addEventListener("pagehide", manager.suspend);
    window.addEventListener("pageshow", restore);
    return () => {
      window.removeEventListener("pagehide", manager.suspend);
      window.removeEventListener("pageshow", restore);
      manager.suspend();
    };
  }, [manager]);
  return <Session.Provider value={manager}>{children}</Session.Provider>;
}
export function useWalletSession() {
  const manager = useContext(Session);
  if (!manager) throw new Error("WalletSessionProvider is required");
  const snapshot = useSyncExternalStore(manager.subscribe, manager.getSnapshot, manager.getSnapshot);
  return { manager, snapshot };
}
