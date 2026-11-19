import { createContext, useContext, useLayoutEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import type { Identity } from "@icp-sdk/core/agent";
import { createWalletSessionManager, type WalletSessionManager } from "@kinic/payments/wallet-session";
import { WalletSessionProvider } from "@kinic/payments/react";
import { useVaultAuth } from "../auth";
import type { BrowserConfig } from "../config";

type Session = {config: BrowserConfig; manager: WalletSessionManager};
const Context = createContext<Session | null>(null);
const empty = () => null;
const unsubscribe = () => () => {};
export function VaultFundingProvider({config, identity, manager: supplied, children}: {
  config?: BrowserConfig; identity?: Identity; manager?: WalletSessionManager; children: ReactNode;
}) {
  const session = useMemo(() => {
    if (!config) return null;
    const manager = supplied ?? createWalletSessionManager({
      origin: location.origin, host: config.host,
      signerUrl: config.local ? new URL("/sign", config.host).href : "https://oisy.com/sign",
    });
    return {config, manager};
  }, [config, supplied]);
  useLayoutEffect(() => { session?.manager.setIdentity(identity); }, [session, identity]);
  return <Context.Provider value={session}>
    {session && <WalletSessionProvider manager={session.manager}>{null}</WalletSessionProvider>}
    {children}
  </Context.Provider>;
}
export function AuthenticatedFundingRoot({children}: {children: ReactNode}) {
  const {identity, config} = useVaultAuth();
  return <VaultFundingProvider config={config} identity={identity}>{children}</VaultFundingProvider>;
}
export function useVaultFundingSession() {
  const session = useContext(Context);
  const manager = session?.manager;
  const snapshot = useSyncExternalStore(manager?.subscribe ?? unsubscribe, manager?.getSnapshot ?? empty, empty);
  return {session, snapshot};
}
