"use client";

// Where: root wikibrowser app shell.
// What: shares Internet Identity and wallet session state across dashboard and cycles pages.
// Why: funding can move between pages without losing local wallet context.
import { AuthClient } from "@icp-sdk/auth/client";
import type { Identity } from "@icp-sdk/core/agent";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { AUTH_CLIENT_CREATE_OPTIONS, authLoginOptions } from "@/lib/auth";
import { getConnectedWalletKinicBalance, getPrincipalKinicLedgerBalance, type ConnectedKinicWallet } from "@/lib/kinic-wallet";
import type { HeaderWalletProvider } from "./home-ui";

import type { WalletSessionManager, WalletSessionSnapshot } from "@kinic/payments/wallet-session";
import { createWikiWalletSession, wikiPaymentScopes } from "@/lib/wallet-runtime";
import { getCyclesBillingConfig } from "@/lib/vfs-client";

type AppSessionContext = {
  authClient: AuthClient | null;
  authError: string | null;
  authLoading: boolean;
  authReady: boolean;
  identityLedgerBalance: string | null;
  identityLedgerBalanceError: string | null;
  identityLedgerBalanceLoading: boolean;
  principal: string | null;
  wallet: ConnectedKinicWallet | null;
  walletBalance: string | null;
  walletBalanceError: string | null;
  walletBalanceLoading: boolean;
  walletBusyProvider: HeaderWalletProvider | null;
  walletControlsLocked: boolean;
  authControlsLocked: boolean;
  walletSessionReady: boolean;
  walletSession: WalletSessionManager;
  walletSnapshot: WalletSessionSnapshot;
  walletPaymentReady: boolean;
  connectWallet: (provider: HeaderWalletProvider) => Promise<void>;
  disconnectWallet: (provider: HeaderWalletProvider) => void;
  logout: () => Promise<void>;
  login: () => Promise<void>;
  refreshIdentityLedgerBalanceFor: (identity: Identity, principal: string) => Promise<void>;
  refreshIdentityLedgerBalance: () => Promise<void>;
  refreshWalletBalance: (wallet: ConnectedKinicWallet) => Promise<void>;
  setAuthControlsLocked: (locked: boolean) => void;
  setWalletControlsLocked: (locked: boolean) => void;
};

const AppSession = createContext<AppSessionContext | null>(null);

export function AppSessionProvider({ children }: { children: ReactNode }) {
  const canisterId = import.meta.env.VITE_KINIC_WIKI_CANISTER_ID ?? "";
  const identityLedgerBalanceSeqRef = useRef(0);
  const walletBalanceSeqRef = useRef(0);
  const [authClient, setAuthClient] = useState<AuthClient | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authReady, setAuthReady] = useState(false);
  const [principal, setPrincipal] = useState<string | null>(null);
  const [identityLedgerBalance, setIdentityLedgerBalance] = useState<string | null>(null);
  const [identityLedgerBalanceError, setIdentityLedgerBalanceError] = useState<string | null>(null);
  const [identityLedgerBalanceLoading, setIdentityLedgerBalanceLoading] = useState(false);
  const [walletSession] = useState(createWikiWalletSession);
  const walletSnapshot = useSyncExternalStore(walletSession.subscribe, walletSession.getSnapshot, walletSession.getSnapshot);
  const [ledger, setLedger] = useState<string | null>(null);
  const wallet = useMemo<ConnectedKinicWallet | null>(() => {
    const { transport } = walletSnapshot;
    if (!transport) return null;
    const { owner, provider } = transport.account;
    if (provider === "oisy") return { provider, connection: { owner, session: walletSession, transport } };
    if (provider === "plug") return { provider, connection: { principal: owner, session: walletSession, transport } };
    return null;
  }, [walletSession, walletSnapshot]);
  const walletPaymentReady = !!wallet && !!ledger && walletSession.hasScopes(wikiPaymentScopes(canisterId, ledger));
  const connectSequence = useRef(0);
  const authSequence = useRef(0);
  const [walletBalance, setWalletBalance] = useState<string | null>(null);
  const [walletBalanceError, setWalletBalanceError] = useState<string | null>(null);
  const [walletBalanceLoading, setWalletBalanceLoading] = useState(false);
  const [walletBusyProvider, setWalletBusyProvider] = useState<HeaderWalletProvider | null>(null);
  const [walletControlsLocked, setWalletControlsLockedState] = useState(false);
  const [authControlsLocked, setAuthControlsLockedState] = useState(false);
  const [walletSessionReady, setWalletSessionReady] = useState(false);
  const principalRef = useRef(principal);
  const walletRef = useRef(wallet);
  principalRef.current = principal;
  walletRef.current = wallet;

  const setWalletControlsLocked = useCallback((locked: boolean) => {
    setWalletControlsLockedState(locked);
  }, []);

  const setAuthControlsLocked = useCallback((locked: boolean) => {
    setAuthControlsLockedState(locked);
  }, []);

  const clearIdentityLedgerBalance = useCallback(() => {
    identityLedgerBalanceSeqRef.current += 1;
    setIdentityLedgerBalance(null);
    setIdentityLedgerBalanceLoading(false);
    setIdentityLedgerBalanceError(null);
  }, []);

  const refreshIdentityLedgerBalanceFor = useCallback(
    async (identity: Identity, identityPrincipal: string) => {
      if (principalRef.current !== identityPrincipal || identity.getPrincipal().toText() !== identityPrincipal) return;
      const balanceSeq = (identityLedgerBalanceSeqRef.current += 1);
      const isCurrentBalance = () => balanceSeq === identityLedgerBalanceSeqRef.current && principalRef.current === identityPrincipal;
      setIdentityLedgerBalance(null);
      setIdentityLedgerBalanceLoading(true);
      setIdentityLedgerBalanceError(null);
      try {
        const balance = await getPrincipalKinicLedgerBalance(canisterId, identityPrincipal);
        if (!isCurrentBalance()) return;
        setIdentityLedgerBalance(balance);
      } catch (cause) {
        if (!isCurrentBalance()) return;
        setIdentityLedgerBalance(null);
        setIdentityLedgerBalanceError(`Internet Identity KINIC balance unavailable: ${errorMessage(cause)}`);
      } finally {
        if (isCurrentBalance()) setIdentityLedgerBalanceLoading(false);
      }
    },
    [canisterId]
  );

  const refreshIdentityLedgerBalance = useCallback(async () => {
    if (!authClient || !principal) {
      clearIdentityLedgerBalance();
      return;
    }
    await refreshIdentityLedgerBalanceFor(authClient.getIdentity(), principal);
  }, [authClient, clearIdentityLedgerBalance, principal, refreshIdentityLedgerBalanceFor]);

  const refreshWalletBalance = useCallback(
    async (nextWallet: ConnectedKinicWallet) => {
      const token = walletSession.capture();
      const currentWallet = walletRef.current;
      if (
        currentWallet?.connection.transport !== nextWallet.connection.transport ||
        currentWallet === null ||
        currentWallet.provider !== nextWallet.provider ||
        connectedWalletPrincipal(currentWallet) !== connectedWalletPrincipal(nextWallet)
      ) {
        return;
      }
      const balanceSeq = (walletBalanceSeqRef.current += 1);
      const submittedWalletPrincipal = connectedWalletPrincipal(nextWallet);
      const isCurrentBalance = () => {
        const currentWallet = walletRef.current;
        return (
          walletSession.isCurrent(token) && balanceSeq === walletBalanceSeqRef.current &&
          currentWallet !== null &&
          currentWallet.provider === nextWallet.provider &&
          connectedWalletPrincipal(currentWallet) === submittedWalletPrincipal
        );
      };
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
        if (isCurrentBalance()) setWalletBalanceLoading(false);
      }
    },
    [canisterId, walletSession]
  );

  const connectWallet = useCallback(
    async (provider: HeaderWalletProvider) => {
      if (walletControlsLocked || walletBusyProvider) return;
      const seq = ++connectSequence.current;
      setWalletBusyProvider(provider);
      setWalletBalanceError(null);
      try {
        let ledgerId = ledger;
        // Open the OISY signer during the gesture, even if billing configuration
        // is still loading. Scope expansion reuses this live channel.
        if (!ledgerId) {
          if (provider === "oisy") await walletSession.connect(provider, []);
          const token = walletSession.capture();
          ledgerId = (await getCyclesBillingConfig(canisterId)).kinicLedgerCanisterId;
          if (!walletSession.isCurrent(token) || seq !== connectSequence.current) return;
          setLedger(ledgerId);
        }
        await walletSession.connect(provider, wikiPaymentScopes(canisterId, ledgerId));
      } catch (cause) {
        if (seq === connectSequence.current) {
          setWalletBalance(null);
          setWalletBalanceError(errorMessage(cause));
        }
      } finally {
        if (seq === connectSequence.current) setWalletBusyProvider(null);
      }
    },
    [canisterId, ledger, walletSession, walletBusyProvider, walletControlsLocked]
  );

  const disconnectWallet = useCallback(
    (provider: HeaderWalletProvider) => {
      if (walletControlsLocked || walletSession.getSnapshot().account?.provider !== provider) return;
      connectSequence.current++;
      setWalletBusyProvider(null);
      void walletSession.disconnect().catch(cause => setWalletBalanceError(errorMessage(cause)));
    },
    [walletSession, walletControlsLocked]
  );

  const syncAuth = useCallback(
    async (client: AuthClient, active: () => boolean = () => true) => {
      const seq = ++authSequence.current;
      const authenticated = await client.isAuthenticated();
      if (!active() || seq !== authSequence.current) return;
      const identity = authenticated ? client.getIdentity() : undefined;
      walletSession.setIdentity(identity);
      setPrincipal(identity?.getPrincipal().toText() ?? null);
    },
    [walletSession]
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
      authSequence.current++;
      connectSequence.current++;
      walletSession.setIdentity(undefined);
      void walletSession.disconnect().catch(cause => setWalletBalanceError(errorMessage(cause)));
      setWalletBusyProvider(null);
      await authClient.logout();
      setPrincipal(null);
      clearIdentityLedgerBalance();
    } catch (cause) {
      setAuthError(errorMessage(cause));
      await syncAuth(authClient);
    } finally {
      setAuthLoading(false);
    }
  }, [authClient, clearIdentityLedgerBalance, syncAuth, walletSession]);

  useEffect(() => {
    let cancelled = false;

    const restore = () => {
      setWalletSessionReady(false);
      void walletSession.restore().then(() => { if (!cancelled) setWalletSessionReady(true); });
    };
    restore();
    const suspend = () => {
      connectSequence.current++;
      setWalletBusyProvider(null);
      walletSession.suspend();
    };
    window.addEventListener("pagehide", suspend);
    window.addEventListener("pageshow", restore);
    if (canisterId) void getCyclesBillingConfig(canisterId).then(config => {
      if (!cancelled) setLedger(config.kinicLedgerCanisterId);
    }).catch(() => { /* An explicit reconnect can retry configuration discovery. */ });

    AuthClient.create(AUTH_CLIENT_CREATE_OPTIONS)
      .then(async (client) => {
        if (cancelled) return;
        setAuthClient(client);
        await syncAuth(client, () => !cancelled);
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
      window.removeEventListener("pagehide", suspend);
      window.removeEventListener("pageshow", restore);
      suspend();
    };
  }, [canisterId, syncAuth, walletSession]);

  useEffect(() => {
    if (!authClient || !principal) {
      clearIdentityLedgerBalance();
      return;
    }
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      void refreshIdentityLedgerBalanceFor(authClient.getIdentity(), principal);
    });
    return () => {
      cancelled = true;
    };
  }, [authClient, clearIdentityLedgerBalance, principal, refreshIdentityLedgerBalanceFor]);

  useEffect(() => {
    setWalletBalance(null);
    setWalletBalanceLoading(false);
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
        identityLedgerBalance,
        identityLedgerBalanceError,
        identityLedgerBalanceLoading,
        principal,
        wallet,
        walletBalance,
        walletBalanceError,
        walletBalanceLoading,
        walletBusyProvider,
        walletControlsLocked,
        authControlsLocked,
        walletSessionReady: walletSessionReady && walletSnapshot.state !== "connecting",
        walletSession, walletSnapshot, walletPaymentReady,
        connectWallet,
        disconnectWallet,
        login,
        logout,
        refreshIdentityLedgerBalanceFor,
        refreshIdentityLedgerBalance,
        refreshWalletBalance,
        setAuthControlsLocked,
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

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Unexpected error";
}
