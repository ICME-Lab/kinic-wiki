import { VAULT_IDLE_TIMEOUT_MS } from "@kinic/vault-client/session";
import { AuthClient } from "@icp-sdk/auth/client";
import type { Identity } from "@icp-sdk/core/agent";
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { loadConfig, type BrowserConfig } from "./config";
type Session = {
  identity?: Identity;
  loading: boolean;
  ready: boolean;
  error: string;
  login: () => void;
  logout: () => void;
};
const Context = createContext<Session>({
  loading: true,
  ready: false,
  error: "",
  login: () => {},
  logout: () => {},
});
export const useVaultAuth = () => useContext(Context);
export function VaultAuthProvider({ children }: { children: ReactNode }) {
  const [identity, setIdentity] = useState<Identity>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const client = useRef<AuthClient | undefined>(undefined);
  const live = useRef(true);
  const preparedConfig = useRef<BrowserConfig | undefined>(undefined);
  const [ready, setReady] = useState(false);
  const serial = useRef(0);
  const logoutPending = useRef<
    { client: AuthClient; token: number } | undefined
  >(undefined);
  const logout = () => {
    if (!live.current || logoutPending.current) return;
    const c = client.current;
    const token = ++serial.current;
    setIdentity(undefined);
    setError("");
    setLoading(true);
    if (!c) {
      setLoading(false);
      return;
    }
    const transition = { client: c, token };
    logoutPending.current = transition;
    const current = () =>
      live.current && client.current === c && serial.current === token;
    // SDK logout deletes stored delegation/key data before resetting its identity.
    // Block another login until every asynchronous logout effect has settled.
    void c
      .logout()
      .catch(() => {
        if (current()) setError("Sign-out did not complete. Close this tab.");
      })
      .finally(() => {
        if (logoutPending.current !== transition) return;
        logoutPending.current = undefined;
        if (current()) setLoading(false);
      });
  };
  useEffect(() => {
    live.current = true;
    let disposed = false;
    let ownedClient: AuthClient | undefined;
    const initializing = serial.current;
    const configuration = loadConfig().then((config) => {
      if (!disposed) preparedConfig.current = config;
    });
    const authentication = AuthClient.create({
      idleOptions: {
        idleTimeout: VAULT_IDLE_TIMEOUT_MS,
        disableDefaultIdleCallback: true,
        // The SDK creates the manager lazily on a first login. Supplying the
        // callback here also covers restored delegations and later logins.
        onIdle: () => {
          if (
            disposed ||
            !live.current ||
            !ownedClient ||
            client.current !== ownedClient
          )
            return;
          logout();
        },
      },
    })
      .then(async (c) => {
        if (disposed) return;
        ownedClient = c;
        client.current = c;
        const authenticated = await c.isAuthenticated();
        if (!disposed && serial.current === initializing) {
          setIdentity(authenticated ? c.getIdentity() : undefined);
        }
      });
    void Promise.all([authentication, configuration])
      .then(() => {
        if (!disposed) {
          setReady(true);
          if (!logoutPending.current) setLoading(false);
        }
      })
      .catch(() => {
        if (!disposed) {
          setError("Sign-in initialization failed. Reload to try again.");
          setLoading(false);
        }
      });
    return () => {
      disposed = true;
      live.current = false;
      client.current = undefined;
      preparedConfig.current = undefined;
    };
  }, []);
  // SDK 5.0.0 checks delegation validity locally. Activity never extends its TTL.
  useEffect(() => {
    if (!identity) return;
    const c = client.current;
    const token = serial.current;
    let disposed = false;
    let checking = false;
    const current = () =>
      !disposed &&
      live.current &&
      client.current === c &&
      serial.current === token;
    const interval = window.setInterval(() => {
      if (!c || checking || !current()) return;
      checking = true;
      void c
        .isAuthenticated()
        .then((valid) => {
          if (!current()) return;
          if (!valid) logout();
          else setIdentity(c.getIdentity());
        })
        .catch(() => {
          if (current()) logout();
        })
        .finally(() => {
          checking = false;
        });
    }, 1000);
    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [identity]);
  const login = () => {
    const c = client.current;
    const config = preparedConfig.current;
    if (!live.current || !c || !config || !ready || loading || logoutPending.current) return;
    const token = ++serial.current;
    setIdentity(undefined);
    setError("");
    setLoading(true);
    const current = () => live.current && client.current === c && serial.current === token;
    const failed = () => {
      if (current()) {
        setError("Sign-in did not complete. Try again.");
        setLoading(false);
      }
    };
    // Opening the popup must stay within the user's click activation.
    try {
      void Promise.resolve(c.login({
        identityProvider: config.identityProvider,
        derivationOrigin: config.derivationOrigin,
        maxTimeToLive: 8n * 3600n * 1_000_000_000n,
        onSuccess: () => {
          if (current()) {
            setIdentity(c.getIdentity());
            setLoading(false);
          }
        },
        onError: failed,
      })).catch(failed);
    } catch {
      failed();
    }
  };
  return (
    <Context
      value={{
        identity,
        loading,
        ready,
        error,
        login,
        logout,
      }}
    >
      {children}
    </Context>
  );
}
