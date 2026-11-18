// @vitest-environment jsdom
import {
  render,
  screen,
  fireEvent,
  act,
  waitFor,
  within,
  cleanup,
} from "@testing-library/react";
import { afterEach, beforeEach, it, expect, vi } from "vitest";
const mock = vi.hoisted(() => ({
  create: vi.fn(),
  load: vi.fn(),
  disk: new Map<string, string>(),
}));
vi.mock("@icp-sdk/auth/client", () => ({
  IdbStorage: class {
    async get(key: string) { return mock.disk.get(key) ?? null; }
    async set(key: string, value: string) { mock.disk.set(key, value); }
    async remove(key: string) { mock.disk.delete(key); }
  },
  KEY_STORAGE_KEY: "identity",
  KEY_STORAGE_DELEGATION: "delegation",
  AuthClient: {
    create: mock.create,
  },
}));
vi.mock("./config", () => ({
  loadConfig: mock.load,
}));
import { VaultAuthProvider, useVaultAuth } from "./auth";
function Child() {
  const s = useVaultAuth();
  return (
    <>
      <span>{s.identity ? "signed" : "unsigned"}</span>
      <span>{s.loading ? "loading" : "ready"}</span>
      <output data-testid="auth-error">{s.error}</output>
      <output data-testid="auth-principal">
        {s.identity?.getPrincipal().toText() ?? "anonymous"}
      </output>
      <button onClick={s.login}>login</button>
      <button onClick={s.logout}>logout</button>
    </>
  );
}
beforeEach(() => {
  localStorage.clear();
  mock.disk.clear();
  mock.load.mockResolvedValue({ identityProvider: "https://id.ai", derivationOrigin: "https://vault.example" });
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.useRealTimers();
});
it("opens II with only its own certified derivation origin and removes identity before async logout completes", async () => {
  const identity = {
    getPrincipal: () => ({
      toText: () => "vault-principal",
    }),
  };
  const login = vi.fn();
  let finish!: () => void;
  const c = {
    isAuthenticated: async () => false,
    getIdentity: () => identity,
    login,
    logout: vi.fn(
      () =>
        new Promise<void>((r) => {
          finish = r;
        }),
    ),
    idleManager: {
      registerCallback: vi.fn(),
    },
  };
  mock.create.mockResolvedValue(c);
  mock.load.mockResolvedValue({
    identityProvider: "https://id.ai",
    derivationOrigin: "https://rrkah-fqaaa-aaaaa-aaaaq-cai.icp0.io",
  });
  render(
    <VaultAuthProvider>
      <Child />
    </VaultAuthProvider>,
  );
  await waitFor(() => expect(mock.create).toHaveBeenCalled());
  expect(mock.create.mock.calls[0][0].idleOptions.onIdle).toBeTypeOf(
    "function",
  );
  expect(c.idleManager.registerCallback).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("login"));
  await waitFor(() => expect(login).toHaveBeenCalled());
  const args = login.mock.calls[0][0];
  expect(args.derivationOrigin).toBe(
    "https://rrkah-fqaaa-aaaaa-aaaaq-cai.icp0.io",
  );
  expect(args.identityProvider).toBe("https://id.ai");
  args.onSuccess();
  await screen.findByText("signed");
  fireEvent.click(screen.getByText("logout"));
  expect(screen.queryByText("signed")).toBeNull();
  expect(screen.getByText("unsigned")).toBeTruthy();
  finish();
});
it("never authenticates when certified configuration fails validation", async () => {
  const login = vi.fn();
  mock.create.mockResolvedValue({
    isAuthenticated: async () => false,
    login,
    idleManager: {
      registerCallback: vi.fn(),
    },
  });
  mock.load.mockRejectedValue(Error("wrong origin"));
  render(
    <VaultAuthProvider>
      <Child />
    </VaultAuthProvider>,
  );
  await waitFor(() => expect(mock.create).toHaveBeenCalled());
  fireEvent.click(screen.getByText("login"));
  await waitFor(() => expect(mock.load).toHaveBeenCalled());
  expect(login).not.toHaveBeenCalled();
  expect(screen.getByText("unsigned")).toBeTruthy();
});
it("does not open an obsolete II login after logout while configuration is loading", async () => {
  const login = vi.fn(),
    logout = vi.fn(async () => {});
  let resolve!: (v: unknown) => void;
  mock.create.mockResolvedValue({
    isAuthenticated: async () => false,
    login,
    logout,
    idleManager: { registerCallback: vi.fn() },
  });
  mock.load.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  render(
    <VaultAuthProvider>
      <Child />
    </VaultAuthProvider>,
  );
  await waitFor(() => expect(screen.getByText("unsigned")).toBeTruthy());
  await waitFor(() => expect(mock.create).toHaveBeenCalled());
  fireEvent.click(screen.getByText("login"));
  await waitFor(() => expect(mock.load).toHaveBeenCalled());
  fireEvent.click(screen.getByText("logout"));
  resolve({
    identityProvider: "https://id.ai",
    derivationOrigin: "https://rrkah-fqaaa-aaaaa-aaaaq-cai.icp0.io",
  });
  await waitFor(() => expect(logout).toHaveBeenCalled());
  await new Promise((r) => setTimeout(r, 0));
  expect(login).not.toHaveBeenCalled();
});

it("logs out after idle on the first login when the SDK creates its manager lazily", async () => {
  const identity = {
    getPrincipal: () => ({ toText: () => "vault-principal" }),
  };
  let options: any;
  let loginOptions: any;
  const c = {
    idleManager: undefined,
    isAuthenticated: async () => false,
    getIdentity: () => identity,
    login: vi.fn((value) => {
      loginOptions = value;
    }),
    logout: vi.fn(async () => {}),
  };
  mock.create.mockImplementation(async (value) => {
    options = value;
    return c;
  });
  mock.load.mockResolvedValue({
    identityProvider: "https://id.ai",
    derivationOrigin: "https://vault.example",
  });
  const view = render(
    <VaultAuthProvider>
      <Child />
    </VaultAuthProvider>,
  );
  await waitFor(() => expect(mock.create).toHaveBeenCalled());
  fireEvent.click(screen.getByText("login"));
  await waitFor(() => expect(c.login).toHaveBeenCalled());
  await act(async () => loginOptions.onSuccess());
  expect(screen.getByText("signed")).toBeTruthy();
  expect(options.idleOptions.idleTimeout).toBe(1800000);
  expect(options.idleOptions.onIdle).toBeTypeOf("function");
  await act(async () => options.idleOptions.onIdle());
  expect(screen.getByText("unsigned")).toBeTruthy();
  expect(c.logout).toHaveBeenCalledTimes(1);
  // A previously issued login completion cannot resurrect the expired identity.
  await act(async () => loginOptions.onSuccess());
  expect(screen.getByText("unsigned")).toBeTruthy();
  fireEvent.click(screen.getByText("login"));
  await waitFor(() => expect(c.login).toHaveBeenCalledTimes(2));
  await act(async () => loginOptions.onSuccess());
  expect(screen.getByText("signed")).toBeTruthy();
  await act(async () => options.idleOptions.onIdle());
  expect(screen.getByText("unsigned")).toBeTruthy();
  expect(c.logout).toHaveBeenCalledTimes(2);
  view.unmount();
  options.idleOptions.onIdle();
  expect(c.logout).toHaveBeenCalledTimes(2);
});

it("clears a restored identity on idle and prevents a pending configuration response from opening II", async () => {
  let options: any;
  let resolve!: (v: unknown) => void;
  const c = {
    idleManager: { registerCallback: vi.fn() },
    isAuthenticated: async () => true,
    getIdentity: () => ({ getPrincipal: () => ({ toText: () => "restored" }) }),
    login: vi.fn(),
    logout: vi.fn(async () => {}),
  };
  mock.create.mockImplementation(async (value) => {
    options = value;
    return c;
  });
  mock.load.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  render(
    <VaultAuthProvider>
      <Child />
    </VaultAuthProvider>,
  );
  await screen.findByText("signed");
  fireEvent.click(screen.getByText("login"));
  await waitFor(() => expect(mock.load).toHaveBeenCalled());
  await act(async () => options.idleOptions.onIdle());
  await act(async () =>
    resolve({
      identityProvider: "https://id.ai",
      derivationOrigin: "https://vault.example",
    }),
  );
  expect(screen.getByText("unsigned")).toBeTruthy();
  expect(c.login).not.toHaveBeenCalled();
  expect(c.idleManager.registerCallback).not.toHaveBeenCalled();
  expect(c.logout).toHaveBeenCalledTimes(1);
});

it.each(["idle", "manual"] as const)(
  "serializes %s logout storage removal before another login on the same SDK client",
  async (reason) => {
    const identity = (name: string) => ({
      getPrincipal: () => ({ toText: () => name }),
    });
    let sdkIdentity = identity("old"),
      options: any;
    const storage = new Map([
      ["key", "old"],
      ["delegation", "old"],
      ["vector", "old"],
    ]);
    const removals: Array<() => void> = [];
    const c = {
      isAuthenticated: async () => true,
      getIdentity: () => sdkIdentity,
      // Installed AuthClient.logout awaits these three removals before resetting identity.
      logout: vi.fn(async () => {
        for (const key of ["key", "delegation", "vector"])
          await new Promise<void>((resolve) =>
            removals.push(() => {
              storage.delete(key);
              resolve();
            }),
          );
        sdkIdentity = identity("anonymous");
      }),
      login: vi.fn(async (o: any) => {
        storage.set("delegation", "new");
        sdkIdentity = identity("new");
        o.onSuccess();
      }),
    };
    mock.create.mockImplementation(async (o) => {
      options = o;
      return c;
    });
    mock.load.mockResolvedValue({
      identityProvider: "https://id.ai",
      derivationOrigin: "https://vault.example",
    });
    render(
      <VaultAuthProvider>
        <Child />
      </VaultAuthProvider>,
    );
    await screen.findByText("signed");
    await act(async () => {
      if (reason === "idle") options.idleOptions.onIdle();
      else fireEvent.click(screen.getByText("logout"));
    });
    expect(screen.getByText("unsigned")).toBeTruthy();
    expect(screen.getByText("loading")).toBeTruthy();
    for (let index = 0; index < 3; index++) {
      // Deliberately bypass a disabled UI control: the provider API must guard entry too.
      await act(async () => fireEvent.click(screen.getByText("login")));
      expect(c.login).not.toHaveBeenCalled();
      expect(mock.load).toHaveBeenCalledOnce();
      // Repeated logout notifications must not launch another storage deletion.
      await act(async () => options.idleOptions.onIdle());
      expect(c.logout).toHaveBeenCalledTimes(1);
      await act(async () => removals[index]());
      if (index < 2) expect(screen.getByText("loading")).toBeTruthy();
    }
    expect(screen.getByText("ready")).toBeTruthy();
    expect(screen.getByTestId("auth-principal").textContent).toBe("anonymous");
    expect(c.getIdentity().getPrincipal().toText()).toBe("anonymous");
    await act(async () => fireEvent.click(screen.getByText("login")));
    expect(c.login).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("auth-principal").textContent).toBe("new");
    expect(c.getIdentity().getPrincipal().toText()).toBe("new");
    expect(storage.get("delegation")).toBe("new");
  },
);

it.each(["resolve", "reject"] as const)(
  "ignores stale logout %s and idle callbacks after unmount while a new provider is signing in",
  async (completion) => {
    let oldOptions: any,
      finish!: () => void,
      resolveConfig!: (value: unknown) => void;
    const old = {
      isAuthenticated: async () => true,
      getIdentity: () => ({ getPrincipal: () => ({ toText: () => "old" }) }),
      logout: vi.fn(
        () =>
          new Promise<void>((resolve, reject) => {
            finish = () =>
              completion === "resolve"
                ? resolve()
                : reject(Error("delayed storage failure"));
          }),
      ),
    };
    const next = {
      isAuthenticated: async () => false,
      getIdentity: () => ({ getPrincipal: () => ({ toText: () => "new" }) }),
      login: vi.fn(async (o: any) => o.onSuccess()),
      logout: vi.fn(async () => {}),
    };
    mock.create
      .mockImplementationOnce(async (options) => {
        oldOptions = options;
        return old;
      })
      .mockResolvedValueOnce(next);
    mock.load.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveConfig = resolve;
        }),
    );
    const first = render(
      <VaultAuthProvider>
        <Child />
      </VaultAuthProvider>,
    );
    await screen.findByText("signed");
    await act(async () => oldOptions.idleOptions.onIdle());
    first.unmount();
    render(
      <VaultAuthProvider>
        <Child />
      </VaultAuthProvider>,
    );
    await waitFor(() => expect(mock.load).toHaveBeenCalledTimes(2));
    expect(screen.getByText("loading")).toBeTruthy();
    fireEvent.click(screen.getByText("login"));
    expect(next.login).not.toHaveBeenCalled();
    await act(async () => {
      finish();
      oldOptions.idleOptions.onIdle();
    });
    expect(screen.getByText("loading")).toBeTruthy();
    expect(screen.getByText("unsigned")).toBeTruthy();
    expect(screen.getByTestId("auth-error").textContent).toBe("");
    expect(old.logout).toHaveBeenCalledTimes(1);
    expect(next.logout).not.toHaveBeenCalled();
    await act(async () =>
      resolveConfig({
        identityProvider: "https://id.ai",
        derivationOrigin: "https://vault.example",
      }),
    );
    expect(screen.getByText("ready")).toBeTruthy();
    fireEvent.click(screen.getByText("login"));
    await waitFor(() => expect(screen.getByTestId("auth-principal").textContent).toBe("new"));
  },
);

it("expires an active typing user before delayed SDK logout settles", async () => {
  let valid = true;
  let finish!: () => void;
  const c = {
    isAuthenticated: vi.fn(async () => valid),
    getIdentity: () => ({ getPrincipal: () => ({ toText: () => "active" }) }),
    logout: vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    ),
  };
  mock.create.mockResolvedValue(c);
  vi.useFakeTimers();
  await act(async () => {
    render(
      <VaultAuthProvider>
        <Child />
      </VaultAuthProvider>,
    );
  });
  expect(screen.getByText("signed")).toBeTruthy();
  // Typing cannot extend the delegation deadline.
  valid = false;
  fireEvent.keyDown(window, { key: "a" });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(screen.getByText("unsigned")).toBeTruthy();
  expect(screen.getByText("loading")).toBeTruthy();
  expect(c.logout).toHaveBeenCalledOnce();
  await act(async () => finish());
  vi.useRealTimers();
});

it("ignores an old validity poll after a new login and refreshes changed identity objects", async () => {
  let poll!: (valid: boolean) => void;
  let sdkIdentity = { getPrincipal: () => ({ toText: () => "old" }) };
  const c = {
    isAuthenticated: vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockImplementation(
        () =>
          new Promise<boolean>((r) => {
            poll = r;
          }),
      ),
    getIdentity: () => sdkIdentity,
    logout: vi.fn(async () => {}),
    login: vi.fn(async (o: { onSuccess: () => void }) => {
      sdkIdentity = { getPrincipal: () => ({ toText: () => "new" }) };
      o.onSuccess();
    }),
  };
  mock.create.mockResolvedValue(c);
  mock.load.mockResolvedValue({
    identityProvider: "https://id.ai",
    derivationOrigin: "https://vault.example",
  });
  vi.useFakeTimers();
  await act(async () => {
    render(
      <VaultAuthProvider>
        <Child />
      </VaultAuthProvider>,
    );
  });
  expect(screen.getByText("signed")).toBeTruthy();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(poll).toBeTypeOf("function");
  await act(async () => fireEvent.click(screen.getByText("logout")));
  await act(async () => fireEvent.click(screen.getByText("login")));
  await act(async () => poll(false));
  expect(screen.getByTestId("auth-principal").textContent).toBe("new");
  expect(c.logout).toHaveBeenCalledOnce();
  sdkIdentity = { getPrincipal: () => ({ toText: () => "refreshed" }) };
  c.isAuthenticated.mockResolvedValue(true);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(screen.getByTestId("auth-principal").textContent).toBe("refreshed");
  vi.useRealTimers();
});

it("prepares config before enabling sign-in and invokes SDK login synchronously on the click", async () => {
  let finish!: (config: unknown) => void;
  const login = vi.fn();
  mock.create.mockResolvedValue({ isAuthenticated: async () => false, login });
  mock.load.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const view = render(<VaultAuthProvider><Child /></VaultAuthProvider>);
  await waitFor(() => expect(mock.load).toHaveBeenCalledOnce());
  expect(screen.getByText("loading")).toBeTruthy();
  fireEvent.click(screen.getByText("login"));
  expect(login).not.toHaveBeenCalled();
  await act(async () => finish({ identityProvider: "https://id.ai", derivationOrigin: "https://vault.example" }));
  expect(screen.getByText("ready")).toBeTruthy();
  fireEvent.click(screen.getByText("login"));
  expect(login).toHaveBeenCalledOnce();
  expect(mock.load).toHaveBeenCalledOnce();
  view.unmount();
  login.mock.calls[0][0].onSuccess();
});

it("requires reload after config failure, then prepares a fresh provider without a click-time fetch", async () => {
  const login = vi.fn();
  mock.create.mockResolvedValue({ isAuthenticated: async () => false, login });
  mock.load.mockRejectedValueOnce(Error("ConfigurationUnavailable"));
  const first = render(<VaultAuthProvider><Child /></VaultAuthProvider>);
  await screen.findByText("Sign-in initialization failed. Reload to try again.");
  fireEvent.click(screen.getByText("login"));
  expect(login).not.toHaveBeenCalled();
  expect(mock.load).toHaveBeenCalledOnce();
  first.unmount();
  render(<VaultAuthProvider><Child /></VaultAuthProvider>);
  await screen.findByText("ready");
  fireEvent.click(screen.getByText("login"));
  expect(login).toHaveBeenCalledOnce();
  expect(mock.load).toHaveBeenCalledTimes(2);
});
it("does not open a delayed sign-in when config finishes after provider unmount", async () => {
  const login = vi.fn();
  let resolve!: (config: unknown) => void;
  mock.create.mockResolvedValue({ isAuthenticated: async () => false, login });
  mock.load.mockImplementation(() => new Promise(r => { resolve = r; }));
  const view = render(<VaultAuthProvider><Child /></VaultAuthProvider>);
  await waitFor(() => expect(mock.load).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByText("login"));
  view.unmount();
  await act(async () => resolve({ identityProvider: "https://id.ai", derivationOrigin: "https://vault.example" }));
  expect(login).not.toHaveBeenCalled();
});

function restoredSDK() {
  const identity = { getPrincipal: () => ({ toText: () => "same-principal" }) };
  return {
    getIdentity: () => identity,
    isAuthenticated: vi.fn(async () => true),
    login: vi.fn(async (options: { onSuccess: () => void }) =>
      options.onSuccess(),
    ),
    logout: vi.fn(async () => {}),
  };
}
function privateView() {
  const mounted = render(
    <VaultAuthProvider>
      <Child />
    </VaultAuthProvider>,
  );
  return within(mounted.container);
}

it("explicit sign-out clears a sibling and prevents an unfinished restore from publishing", async () => {
  const slow = restoredSDK();
  let finish!: (valid: boolean) => void;
  slow.isAuthenticated.mockImplementation(
    () =>
      new Promise((r) => {
        finish = r;
      }),
  );
  mock.create
    .mockResolvedValueOnce(restoredSDK())
    .mockResolvedValueOnce(restoredSDK())
    .mockResolvedValueOnce(slow);
  const a = privateView(),
    b = privateView(),
    starting = privateView();
  await a.findByText("signed");
  await b.findByText("signed");
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  fireEvent.click(a.getByRole("button", { name: "logout" }));
  await b.findByText("unsigned");
  await act(async () => finish(true));
  await starting.findByText("ready");
  expect(starting.getByText("unsigned")).toBeTruthy();
});

it("keeps a sibling active on local idle", async () => {
  const aSDK = restoredSDK(),
    bSDK = restoredSDK();
  mock.create.mockResolvedValueOnce(aSDK).mockResolvedValueOnce(bSDK);
  const a = privateView(),
    b = privateView();
  await a.findByText("signed");
  await b.findByText("signed");
  await act(async () => mock.create.mock.calls[1][0].idleOptions.onIdle());
  expect(b.getByText("unsigned")).toBeTruthy();
  expect(a.getByText("signed")).toBeTruthy();
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
  expect(a.getByText("signed")).toBeTruthy();
});

it("keeps a newly mounted frame anonymous during asynchronous removal of the stored delegation", async () => {
  const sender = restoredSDK();
  let finish!: () => void;
  sender.logout.mockImplementation(
    () =>
      new Promise((r) => {
        finish = r;
      }),
  );
  mock.create
    .mockResolvedValueOnce(sender)
    .mockResolvedValueOnce(restoredSDK());
  const a = privateView();
  await a.findByText("signed");
  fireEvent.click(a.getByRole("button", { name: "logout" }));
  const starting = privateView();
  expect(starting.getByText("unsigned")).toBeTruthy();
  await act(async () => finish());
  await starting.findByText("ready");
  expect(starting.getByText("unsigned")).toBeTruthy();
});

it("retains the anonymous view with a recovery message when the browser denies partition storage", async () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new DOMException("Access denied", "SecurityError");
  });
  try {
    const view = privateView();
    await view.findByText(/storage is unavailable/i);
    expect(view.getByText("unsigned")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "login" }));
    expect(mock.create).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
  }
});

it("delivers a queued sign-out to the old sibling while preserving a third view's fresh login", async () => {
  const notify = BroadcastChannel.prototype.postMessage;
  let deliver!: () => void;
  const transport = vi
    .spyOn(BroadcastChannel.prototype, "postMessage")
    .mockImplementation(function (this: BroadcastChannel, value) {
      deliver = () => notify.call(this, value);
    });
  try {
    const fresh = restoredSDK();
    fresh.isAuthenticated.mockResolvedValue(false);
    mock.create
      .mockResolvedValueOnce(restoredSDK())
      .mockResolvedValueOnce(restoredSDK())
      .mockResolvedValueOnce(fresh);
    const sender = privateView(),
      older = privateView(),
      newer = privateView();
    await sender.findByText("signed");
    await older.findByText("signed");
    await newer.findByText("ready");
    fireEvent.click(sender.getByRole("button", { name: "logout" }));
    await sender.findByText("ready");
    expect(older.getByText("signed")).toBeTruthy();
    fireEvent.click(newer.getByRole("button", { name: "login" }));
    await newer.findByText("signed");
    await act(async () => deliver());
    await older.findByText("unsigned");
    expect(newer.getByText("signed")).toBeTruthy();
  } finally {
    transport.mockRestore();
  }
});

it("keeps the persisted sign-in for another active Vault view when its sibling expires locally", async () => {
  const { locks } = await import("node:worker_threads");
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: locks,
  });
  let stored = true;
  const instance = () => ({
    ...restoredSDK(),
    isAuthenticated: async () => stored,
    logout: async () => {
      stored = false;
    },
  });
  mock.create.mockImplementation(async () => instance());
  try {
    const active = privateView(),
      idle = privateView();
    await active.findByText("signed");
    await idle.findByText("signed");
    await act(async () => mock.create.mock.calls[1][0].idleOptions.onIdle());
    await idle.findByText("ready");
    expect(idle.getByText("unsigned")).toBeTruthy();
    expect(active.getByText("signed")).toBeTruthy();
    const restored = privateView();
    await restored.findByText("signed");
  } finally {
    cleanup();
    Reflect.deleteProperty(navigator, "locks");
  }
});

it("waits for another frame's pending SDK deletion before starting a fresh same-principal login", async () => {
  const { locks } = await import("node:worker_threads");
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: locks,
  });
  const sender = restoredSDK(),
    fresh = restoredSDK();
  let finish!: () => void;
  let stored = "old";
  sender.logout.mockImplementation(async () => {
    await new Promise<void>((r) => {
      finish = r;
    });
    stored = "";
  });
  fresh.login.mockImplementation(async (o) => {
    stored = "fresh";
    o.onSuccess();
  });
  mock.create.mockResolvedValueOnce(sender).mockResolvedValueOnce(fresh);
  try {
    const a = privateView();
    await a.findByText("signed");
    fireEvent.click(a.getByRole("button", { name: "logout" }));
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    const c = privateView();
    await waitFor(() => expect(fresh.isAuthenticated).toHaveBeenCalled());
    fireEvent.click(c.getByRole("button", { name: "login" }));
    expect(fresh.login).not.toHaveBeenCalled();
    await act(async () => finish());
    await c.findByText("ready");
    fireEvent.click(c.getByRole("button", { name: "login" }));
    await c.findByText("signed");
    expect(stored).toBe("fresh");
  } finally {
    cleanup();
    Reflect.deleteProperty(navigator, "locks");
  }
});

it("deletes the persisted delegation after the only authenticated view goes idle", async () => {
  const { locks } = await import("node:worker_threads");
  Object.defineProperty(navigator, "locks", { configurable: true, value: locks });
  let stored = true;
  mock.create.mockImplementation(async () => ({
    ...restoredSDK(),
    isAuthenticated: async () => stored,
    logout: async () => { stored = false; },
  }));
  try {
    const sole = privateView();
    await sole.findByText("signed");
    await act(async () => mock.create.mock.calls[0][0].idleOptions.onIdle());
    await sole.findByText("ready");
    cleanup();
    const reloaded = privateView();
    await reloaded.findByText("ready");
    expect(reloaded.getByText("unsigned")).toBeTruthy();
  } finally {
    cleanup();
    Reflect.deleteProperty(navigator, "locks");
  }
});

type TestStorage = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
};
// The real SDK restores at create(), writes both credential records before
// onSuccess, and removes them asynchronously at logout().
function persistentSDK() {
  const saves: Array<(credential: string) => Promise<void>> = [];
  let pauseRemoval: (() => Promise<void>) | undefined;
  const disk: TestStorage = {
    get: async (k) => mock.disk.get(k) ?? null,
    set: async (k, v) => {
      mock.disk.set(k, v);
    },
    remove: async (k) => {
      mock.disk.delete(k);
    },
  };
  mock.create.mockImplementation(
    async ({ storage = disk }: { storage?: TestStorage }) => {
      let credential = await storage.get("delegation");
      const key = await storage.get("identity");
      if (key !== credential) credential = null;
      return {
        isAuthenticated: async () => !!credential,
        getIdentity: () => ({
          getPrincipal: () => ({ toText: () => "same-principal" }),
        }),
        login: (o: { onSuccess: () => void }) => {
          saves.push(async (value) => {
            credential = value;
            await storage.set("delegation", value);
            await storage.set("identity", value);
            await o.onSuccess();
          });
        },
        logout: async () => {
          await pauseRemoval?.();
          await storage.remove("identity");
          await storage.remove("delegation");
          credential = null;
        },
      };
    },
  );
  return {
    saves,
    pause: (f: () => Promise<void>) => {
      pauseRemoval = f;
    },
  };
}

it.each(["no new login", "fresh sibling", "same view signs in again"] as const)(
  "fences writes before the obsolete II success callback with %s",
  async (scenario) => {
    const { locks } = await import("node:worker_threads");
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: locks,
    });
    const sdk = persistentSDK();
    try {
      const pending = privateView();
      await pending.findByText("ready");
      fireEvent.click(pending.getByText("login"));
      await waitFor(() => expect(sdk.saves).toHaveLength(1));
      // Another frame restores an already signed-in delegation.
      mock.disk.set("identity", "existing");
      mock.disk.set("delegation", "existing");
      const owner = privateView();
      await owner.findByText("signed");
      fireEvent.click(owner.getByText("logout"));
      await owner.findByText("ready");
      await pending.findByText("ready");
      if (scenario !== "no new login") {
        const next = scenario === "fresh sibling" ? privateView() : pending;
        await next.findByText("ready");
        fireEvent.click(next.getByText("login"));
        await waitFor(() => expect(sdk.saves).toHaveLength(2));
        await act(async () => sdk.saves[1]("fresh"));
        await next.findByText("signed");
      }
      await act(async () => sdk.saves[0]("obsolete"));
      const restored = privateView();
      await restored.findByText("ready");
      if (scenario === "no new login") {
        expect(restored.getByText("unsigned")).toBeTruthy();
        expect(mock.disk.has("delegation")).toBe(false);
      } else {
        expect(restored.getByText("signed")).toBeTruthy();
        expect(mock.disk.get("delegation")).toBe("fresh");
        expect(mock.disk.get("identity")).toBe("fresh");
      }
    } finally {
      cleanup();
      Reflect.deleteProperty(navigator, "locks");
    }
  },
);

it("restores only after a sole idle view finishes deleting persisted credentials", async () => {
  const { locks } = await import("node:worker_threads");
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: locks,
  });
  const sdk = persistentSDK();
  mock.disk.set("identity", "existing");
  mock.disk.set("delegation", "existing");
  let finish!: () => void;
  sdk.pause(
    () =>
      new Promise<void>((r) => {
        finish = r;
      }),
  );
  try {
    const last = privateView();
    await last.findByText("signed");
    await act(async () => mock.create.mock.calls[0][0].idleOptions.onIdle());
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    const mounting = privateView();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(mounting.getByText("unsigned")).toBeTruthy();
    await act(async () => finish());
    await mounting.findByText("ready");
    expect(mounting.getByText("unsigned")).toBeTruthy();
  } finally {
    finish?.();
    cleanup();
    Reflect.deleteProperty(navigator, "locks");
  }
});

it("keeps an explicit login in memory when the browser cannot coordinate persistent credentials", async () => {
  const sdk = persistentSDK();
  mock.disk.set("identity", "prior");
  mock.disk.set("delegation", "prior");
  const view = privateView();
  await view.findByText("ready");
  expect(view.getByText("unsigned")).toBeTruthy();
  fireEvent.click(view.getByText("login"));
  await waitFor(() => expect(sdk.saves).toHaveLength(1));
  await act(async () => sdk.saves[0]("fresh"));
  await view.findByText("signed");
  expect(mock.disk.get("delegation")).toBe("prior");
  fireEvent.click(view.getByText("logout"));
  await view.findByText("ready");
  expect(mock.disk.has("identity")).toBe(false);
  expect(mock.disk.has("delegation")).toBe(false);
});
