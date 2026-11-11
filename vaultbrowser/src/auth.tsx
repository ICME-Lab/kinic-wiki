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
import { loadConfig } from "./config";
type Session = {
  identity?: Identity;
  loading: boolean;
  error: string;
  login: () => void;
  logout: () => void;
};
const Context = createContext<Session>({
  loading: true,
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
    void AuthClient.create({
      idleOptions: {
        idleTimeout: 5 * 60 * 1000,
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
          setLoading(false);
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
    };
  }, []);
  const login = () => {
    const c = client.current;
    if (!live.current || !c || logoutPending.current) return;
    const token = ++serial.current;
    setIdentity(undefined);
    setError("");
    setLoading(true);
    void loadConfig()
      .then((config) => {
        if (!live.current || serial.current !== token) return;
        return c.login({
          identityProvider: config.identityProvider,
          derivationOrigin: config.derivationOrigin,
          maxTimeToLive: 8n * 3600n * 1_000_000_000n,
          onSuccess: () => {
            if (live.current && serial.current === token) {
              setIdentity(c.getIdentity());
              setLoading(false);
            }
          },
          onError: () => {
            if (live.current && serial.current === token) {
              setError("Sign-in did not complete. Try again.");
              setLoading(false);
            }
          },
        });
      })
      .catch(() => {
        if (live.current && serial.current === token) {
          setError(
            "Vault sign-in configuration is unavailable. Reload to try again.",
          );
          setLoading(false);
        }
      });
  };
  return (
    <Context
      value={{
        identity,
        loading,
        error,
        login,
        logout,
      }}
    >
      {children}
    </Context>
  );
}
