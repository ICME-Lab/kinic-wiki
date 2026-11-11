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
          serial.current++;
          setIdentity(undefined);
          setLoading(false);
          void ownedClient.logout().catch(() => {
            if (!disposed && live.current && client.current === ownedClient)
              setError("Sign-out did not complete. Close this tab.");
          });
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
    if (!c) return;
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
  const logout = () => {
    serial.current++;
    setIdentity(undefined);
    setError("");
    setLoading(true);
    void client.current
      ?.logout()
      .catch(() => {
        if (live.current)
          setError("Sign-out did not complete. Close this tab.");
      })
      .finally(() => {
        if (live.current) setLoading(false);
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
