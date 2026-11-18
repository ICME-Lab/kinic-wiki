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
import { flushSync } from "react-dom";
import { loadConfig, type BrowserConfig } from "./config";
// This is a public random generation, shared only within the Vault origin's
// storage partition. A pending generation also fences a newly opening frame
// while the SDK deletes its stored delegation.
const logoutKey = "kinic-vault-logout";
const activeViewLock = "kinic-vault-authenticated-view";
const storageError =
  "Browser storage is unavailable. Open Vault in its own tab to sign in.";
function partitionMarker() {
  try {
    return localStorage.getItem(logoutKey) ?? "";
  } catch {
    return undefined;
  }
}
function partitionGeneration() {
  return partitionMarker()?.replace(/^pending:/, "");
}
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
  const [waitingForCleanup, setWaitingForCleanup] = useState(false);
  const interruptedCleanup = useRef<string | undefined>(undefined);
  const waitForCleanup = (marker: string | undefined) => {
    if (!marker?.startsWith("pending:")) {
      setWaitingForCleanup(false);
      interruptedCleanup.current = undefined;
      return;
    }
    setWaitingForCleanup(true);
    // A crashed sender releases its Web Lock even if it left the marker pending.
    // Suppress its stored delegation, but permit a deliberate new II login.
    if (navigator.locks)
      void navigator.locks.request(logoutKey, { mode: "shared" }, () => {
        if (!live.current) return;
        const current = partitionMarker();
        if (marker === current) interruptedCleanup.current = marker;
        if (current === marker || !current?.startsWith("pending:"))
          setWaitingForCleanup(false);
      });
  };
  const serial = useRef(0);
  const generation = useRef("");
  const notifications = useRef<BroadcastChannel | undefined>(undefined);
  const hasLocalSession = useRef(false);
  const releaseView = useRef<(() => Promise<void>) | undefined>(undefined);
  const holdView = () => {
    if (!navigator.locks || releaseView.current) return;
    let release!: () => void;
    const active = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = navigator.locks.request(
      activeViewLock,
      { mode: "shared" },
      () => active,
    );
    releaseView.current = () => {
      releaseView.current = undefined;
      release();
      return held;
    };
  };
  const logoutPending = useRef<
    { client: AuthClient; token: number } | undefined
  >(undefined);
  const endSession = (explicit: boolean) => {
    if (!live.current || logoutPending.current) return;
    const c = client.current;
    const stale = partitionGeneration() !== generation.current;
    const released = releaseView.current?.();
    const token = ++serial.current;
    hasLocalSession.current = false;
    let pending: string | undefined;
    if (explicit && !stale) {
      generation.current = crypto.randomUUID();
      pending = "pending:" + generation.current;
    }
    setIdentity(undefined);
    setError("");
    setLoading(true);
    if (!c || stale) {
      setLoading(false);
      return;
    }
    const transition = { client: c, token };
    logoutPending.current = transition;
    const current = () =>
      live.current && client.current === c && serial.current === token;
    // SDK logout deletes stored delegation/key data before resetting its identity.
    // Block another login until every asynchronous logout effect has settled.
    // An idle frame clears its private UI immediately. Keep shared SDK storage
    // available while another view holds an active login in this partition.
    const removeStored = async () => {
      await c.logout();
      if (pending && partitionMarker() === pending) {
        localStorage.setItem(logoutKey, pending.slice("pending:".length));
        notifications.current?.postMessage("sign-out");
      }
    };
    let cleanup: Promise<void>;
    if (pending) {
      // Reserve the deletion before observers see the pending marker. A new
      // login cannot race the SDK's last asynchronous storage removal.
      cleanup = navigator.locks
        ? navigator.locks.request(logoutKey, removeStored)
        : removeStored();
      try {
        localStorage.setItem(logoutKey, pending);
        notifications.current?.postMessage("sign-out");
      } catch {
        notifications.current?.postMessage("storage-unavailable");
      }
    } else if (released) {
      cleanup = released.then(() =>
        navigator.locks.request(
          activeViewLock,
          { ifAvailable: true },
          async (lock) => {
            if (lock && generation.current === partitionGeneration())
              await c.logout();
          },
        ),
      );
    } else {
      cleanup = c.logout();
    }
    void cleanup
      .catch(() => {
        if (current()) setError("Sign-out did not complete. Close this tab.");
      })
      .finally(() => {
        if (logoutPending.current !== transition) return;
        logoutPending.current = undefined;
        if (live.current && client.current === c) setLoading(false);
      });
  };
  useEffect(() => {
    live.current = true;
    let disposed = false;
    let ownedClient: AuthClient | undefined;
    const marker = partitionMarker();
    if (marker === undefined) {
      setError(storageError);
      setLoading(false);
      return;
    }
    const restoring = marker.replace(/^pending:/, "");
    generation.current = restoring;
    const mayRestore = !marker.startsWith("pending:");
    if (!mayRestore) waitForCleanup(marker);
    const initializing = serial.current;
    // Read the current generation, even on delayed or duplicate delivery.
    // An explicit fresh login may already belong to this new generation.
    const receive = (storageUnavailable = false) => {
      const latest = partitionGeneration();
      if (disposed) return;
      waitForCleanup(partitionMarker());
      if (!storageUnavailable && generation.current === latest) return;
      generation.current = latest ?? "";
      ++serial.current;
      hasLocalSession.current = false;
      void releaseView.current?.();
      flushSync(() => {
        setIdentity(undefined);
        if (latest === undefined || storageUnavailable) setError(storageError);
        else setError("");
        setLoading(!!logoutPending.current);
      });
    };
    const storageChanged = (event: StorageEvent) => {
      if (event.key === logoutKey) receive();
    };
    window.addEventListener("storage", storageChanged);
    const channel =
      typeof BroadcastChannel === "undefined"
        ? undefined
        : new BroadcastChannel(logoutKey);
    notifications.current = channel;
    if (channel)
      channel.onmessage = (event) =>
        receive(event.data === "storage-unavailable");
    const configuration = loadConfig().then((config) => {
      if (!disposed) preparedConfig.current = config;
    });
    const authentication = AuthClient.create({
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
            client.current !== ownedClient ||
            !hasLocalSession.current
          )
            return;
          endSession(false);
        },
      },
    }).then(async (c) => {
      if (disposed) return;
      ownedClient = c;
      client.current = c;
      const authenticated = await c.isAuthenticated();
      if (
        !disposed &&
        serial.current === initializing &&
        restoring === partitionGeneration()
      ) {
        hasLocalSession.current = mayRestore && authenticated;
        if (hasLocalSession.current) holdView();
        setIdentity(hasLocalSession.current ? c.getIdentity() : undefined);
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
      window.removeEventListener("storage", storageChanged);
      channel?.close();
      void releaseView.current?.();
      notifications.current = undefined;
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
          if (!valid) endSession(false);
          else setIdentity(c.getIdentity());
        })
        .catch(() => {
          if (current()) endSession(false);
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
    if (
      !live.current ||
      !c ||
      !config ||
      !ready ||
      loading ||
      logoutPending.current
    )
      return;
    const marker = partitionMarker();
    if (
      marker?.startsWith("pending:") &&
      interruptedCleanup.current !== marker
    ) {
      waitForCleanup(marker);
      return;
    }
    const signingIn = partitionGeneration();
    if (signingIn === undefined) {
      setError(storageError);
      return;
    }
    generation.current = signingIn;
    const token = ++serial.current;
    hasLocalSession.current = true;
    holdView();
    setIdentity(undefined);
    setError("");
    setLoading(true);
    const current = () =>
      live.current && client.current === c && serial.current === token;
    const failed = () => {
      if (current()) {
        hasLocalSession.current = false;
        void releaseView.current?.();
        setError("Sign-in did not complete. Try again.");
        setLoading(false);
      }
    };
    // Opening the popup must stay within the user's click activation.
    try {
      void Promise.resolve(
        c.login({
          identityProvider: config.identityProvider,
          derivationOrigin: config.derivationOrigin,
          maxTimeToLive: 8n * 3600n * 1_000_000_000n,
          onSuccess: () => {
            if (current() && signingIn === partitionGeneration()) {
              if (partitionMarker() === "pending:" + signingIn) {
                try {
                  localStorage.setItem(logoutKey, signingIn);
                } catch {
                  failed();
                  return;
                }
              }
              setIdentity(c.getIdentity());
              setLoading(false);
            }
          },
          onError: failed,
        }),
      ).catch(failed);
    } catch {
      failed();
    }
  };
  return (
    <Context
      value={{
        identity,
        loading: loading || waitingForCleanup,
        ready,
        error,
        login,
        logout: () => endSession(true),
      }}
    >
      {children}
    </Context>
  );
}
