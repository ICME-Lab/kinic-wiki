"use client";

// Where: root wikibrowser app shell.
// What: shares Internet Identity and wallet session state across dashboard and cycles pages.
// Why: funding can move between pages without losing local wallet context.
import { AuthClient } from "@icp-sdk/auth/client";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { AUTH_CLIENT_CREATE_OPTIONS, authLoginOptions } from "@/lib/auth";
import { connectOisyWallet, connectPlugWallet, getConnectedWalletKinicBalance, type ConnectedKinicWallet } from "@/lib/kinic-wallet";
import { kinicGetBalance } from "@/lib/vfs-client";
import type { HeaderWalletProvider } from "./home-ui";

type AppSessionContext = {
  authClient: AuthClient | null;
  authError: string | null;
  authLoading: boolean;
  authReady: boolean;
  principal: string | null;
  kinicBalance: string | null;
  kinicBalanceError: string | null;
  kinicBalanceLoading: boolean;
  wallet: ConnectedKinicWallet | null;
  walletBalance: string | null;
  walletBalanceError: string | null;
  walletBalanceLoading: boolean;
  walletBusyProvider: HeaderWalletProvider | null;
  walletControlsLocked: boolean;
  connectWallet: (provider: HeaderWalletProvider) => Promise<void>;
  disconnectWallet: (provider: HeaderWalletProvider) => void;
  logout: () => Promise<void>;
  login: () => Promise<void>;
  refreshKinicBalance: () => Promise<void>;
  refreshWalletBalance: (wallet: ConnectedKinicWallet) => Promise<void>;
  setWalletControlsLocked: (locked: boolean) => void;
};

const WALLET_SESSION_KEY = "kinic-wiki.wallet-session";
const AppSession = createContext<AppSessionContext | null>(null);

export function AppSessionProvider({ children }: { children: ReactNode }) {
  const canisterId = process.env.NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID ?? "";
  const kinicBalanceSeqRef = useRef(0);
  const walletBalanceSeqRef = useRef(0);
  const [authClient, setAuthClient] = useState<AuthClient | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authReady, setAuthReady] = useState(false);
  const [principal, setPrincipal] = useState<string | null>(null);
  const [kinicBalance, setKinicBalance] = useState<string | null>(null);
  const [kinicBalanceError, setKinicBalanceError] = useState<string | null>(null);
  const [kinicBalanceLoading, setKinicBalanceLoading] = useState(false);
  const [wallet, setWallet] = useState<ConnectedKinicWallet | null>(() => readStoredWallet());
  const [walletBalance, setWalletBalance] = useState<string | null>(null);
  const [walletBalanceError, setWalletBalanceError] = useState<string | null>(null);
  const [walletBalanceLoading, setWalletBalanceLoading] = useState(false);
  const [walletBusyProvider, setWalletBusyProvider] = useState<HeaderWalletProvider | null>(null);
  const [walletControlsLocked, setWalletControlsLockedState] = useState(false);

  const setWalletControlsLocked = useCallback((locked: boolean) => {
    setWalletControlsLockedState(locked);
  }, []);

  const clearStoredWallet = useCallback(() => {
    safeSessionStorageRemove(WALLET_SESSION_KEY);
  }, []);

  const storeWallet = useCallback((nextWallet: ConnectedKinicWallet) => {
    safeSessionStorageSet(
      WALLET_SESSION_KEY,
      JSON.stringify({
        provider: nextWallet.provider,
        principal: connectedWalletPrincipal(nextWallet)
      })
    );
  }, []);

  const clearWallet = useCallback(() => {
    walletBalanceSeqRef.current += 1;
    setWallet(null);
    setWalletBalance(null);
    setWalletBalanceLoading(false);
    setWalletBalanceError(null);
    setWalletBusyProvider(null);
    clearStoredWallet();
  }, [clearStoredWallet]);

  const clearKinicBalance = useCallback(() => {
    kinicBalanceSeqRef.current += 1;
    setKinicBalance(null);
    setKinicBalanceLoading(false);
    setKinicBalanceError(null);
  }, []);

  const refreshKinicBalance = useCallback(async () => {
    const balanceSeq = (kinicBalanceSeqRef.current += 1);
    const isCurrentBalance = () => balanceSeq === kinicBalanceSeqRef.current;
    if (!authClient || !principal) {
      clearKinicBalance();
      return;
    }
    setKinicBalanceLoading(true);
    setKinicBalanceError(null);
    try {
      const balance = await kinicGetBalance(canisterId, authClient.getIdentity());
      if (!isCurrentBalance()) return;
      setKinicBalance(balance.balanceE8s);
    } catch (cause) {
      if (!isCurrentBalance()) return;
      setKinicBalance(null);
      setKinicBalanceError(`KINIC balance unavailable: ${errorMessage(cause)}`);
    } finally {
      if (!isCurrentBalance()) return;
      setKinicBalanceLoading(false);
    }
  }, [authClient, canisterId, clearKinicBalance, principal]);

  const refreshWalletBalance = useCallback(
    async (nextWallet: ConnectedKinicWallet) => {
      const balanceSeq = (walletBalanceSeqRef.current += 1);
      const isCurrentBalance = () => balanceSeq === walletBalanceSeqRef.current;
      setWalletBalance(null);
      setWalletBalanceLoading(true);
      setWalletBalanceError(null);
      try {
        const balance = await getConnectedWalletKinicBalance(canisterId, nextWallet);
        if (!isCurrentBalance()) return;
        setWalletBalance(balance);
      } catch (cause) {
        if (!isCurrentBalance()) return;
        setWalletBalance(null);
        setWalletBalanceError(`KINIC balance unavailable: ${errorMessage(cause)}`);
      } finally {
        if (!isCurrentBalance()) return;
        setWalletBalanceLoading(false);
      }
    },
    [canisterId]
  );

  const connectWallet = useCallback(
    async (provider: HeaderWalletProvider) => {
      if (walletControlsLocked || walletBusyProvider) return;
      setWalletBusyProvider(provider);
      setWalletBalanceError(null);
      try {
        const nextWallet: ConnectedKinicWallet =
          provider === "oisy"
            ? { provider, connection: await connectOisyWallet() }
            : { provider, connection: await connectPlugWallet() };
        setWallet(nextWallet);
        storeWallet(nextWallet);
      } catch (cause) {
        setWalletBalance(null);
        setWalletBalanceError(errorMessage(cause));
      } finally {
        setWalletBusyProvider(null);
      }
    },
    [storeWallet, walletBusyProvider, walletControlsLocked]
  );

  const disconnectWallet = useCallback(
    (provider: HeaderWalletProvider) => {
      if (walletControlsLocked || walletBusyProvider || wallet?.provider !== provider) return;
      clearWallet();
    },
    [clearWallet, wallet, walletBusyProvider, walletControlsLocked]
  );

  const syncAuth = useCallback(
    async (client: AuthClient) => {
      const authenticated = await client.isAuthenticated();
      const nextPrincipal = authenticated ? client.getIdentity().getPrincipal().toText() : null;
      setPrincipal(nextPrincipal);
      if (!nextPrincipal) clearKinicBalance();
    },
    [clearKinicBalance]
  );

  const login = useCallback(async () => {
    if (!authClient) return;
    setAuthLoading(true);
    setAuthError(null);
    await authClient.login({
      ...authLoginOptions(),
      onSuccess: () => {
        void syncAuth(authClient).finally(() => setAuthLoading(false));
      },
      onError: (cause) => {
        setAuthError(errorMessage(cause));
        setAuthLoading(false);
      }
    });
  }, [authClient, syncAuth]);

  const logout = useCallback(async () => {
    if (!authClient) return;
    setAuthLoading(true);
    setAuthError(null);
    try {
      await authClient.logout();
      setPrincipal(null);
      clearKinicBalance();
      clearWallet();
    } catch (cause) {
      setAuthError(errorMessage(cause));
    } finally {
      setAuthLoading(false);
    }
  }, [authClient, clearKinicBalance, clearWallet]);

  useEffect(() => {
    let cancelled = false;

    AuthClient.create(AUTH_CLIENT_CREATE_OPTIONS)
      .then(async (client) => {
        if (cancelled) return;
        setAuthClient(client);
        await syncAuth(client);
        if (cancelled) return;
        setAuthReady(true);
        setAuthLoading(false);
      })
      .catch((cause) => {
        if (cancelled) return;
        setAuthError(errorMessage(cause));
        setAuthReady(false);
        setAuthLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [syncAuth]);

  useEffect(() => {
    if (!authClient || !principal) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      void refreshKinicBalance();
    });
    return () => {
      cancelled = true;
    };
  }, [authClient, principal, refreshKinicBalance]);

  useEffect(() => {
    if (!wallet) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      void refreshWalletBalance(wallet);
    });
    return () => {
      cancelled = true;
    };
  }, [refreshWalletBalance, wallet]);

  return (
    <AppSession.Provider
      value={{
        authClient,
        authError,
        authLoading,
        authReady,
        principal,
        kinicBalance,
        kinicBalanceError,
        kinicBalanceLoading,
        wallet,
        walletBalance,
        walletBalanceError,
        walletBalanceLoading,
        walletBusyProvider,
        walletControlsLocked,
        connectWallet,
        disconnectWallet,
        login,
        logout,
        refreshKinicBalance,
        refreshWalletBalance,
        setWalletControlsLocked
      }}
    >
      {children}
    </AppSession.Provider>
  );
}

export function useAppSession(): AppSessionContext {
  const session = useContext(AppSession);
  if (!session) throw new Error("AppSessionProvider is required");
  return session;
}

export function connectedWalletPrincipal(wallet: ConnectedKinicWallet): string {
  return wallet.provider === "oisy" ? wallet.connection.owner : wallet.connection.principal;
}

function readStoredWallet(): ConnectedKinicWallet | null {
  const stored = safeSessionStorageGet(WALLET_SESSION_KEY);
  if (!stored) return null;
  try {
    const parsed: unknown = JSON.parse(stored);
    if (!isRecord(parsed)) return null;
    const provider = Reflect.get(parsed, "provider");
    const principal = Reflect.get(parsed, "principal");
    if (!isWalletProvider(provider) || typeof principal !== "string" || !principal.trim()) return null;
    return provider === "oisy" ? { provider, connection: { owner: principal } } : { provider, connection: { principal } };
  } catch {
    return null;
  }
}

function safeSessionStorageGet(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSessionStorageSet(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // Wallet persistence is best effort; connection state remains valid in memory.
  }
}

function safeSessionStorageRemove(key: string): void {
  try {
    sessionStorage.removeItem(key);
  } catch {
    // Wallet persistence is best effort; disconnect state remains valid in memory.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isWalletProvider(value: unknown): value is HeaderWalletProvider {
  return value === "oisy" || value === "plug";
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Unexpected error";
}
