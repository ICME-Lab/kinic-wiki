// @vitest-environment jsdom
import {
  render,
  screen,
  fireEvent,
  act,
  waitFor,
  cleanup,
} from "@testing-library/react";
import { afterEach, it, expect, vi } from "vitest";
const mock = vi.hoisted(() => ({
  create: vi.fn(),
  load: vi.fn(),
}));
vi.mock("@icp-sdk/auth/client", () => ({
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
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
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
  expect(options.idleOptions.idleTimeout).toBe(300000);
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
      expect(mock.load).not.toHaveBeenCalled();
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
    await screen.findByText("ready");
    fireEvent.click(screen.getByText("login"));
    await waitFor(() => expect(mock.load).toHaveBeenCalled());
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
    expect(screen.getByTestId("auth-principal").textContent).toBe("new");
    expect(screen.getByText("ready")).toBeTruthy();
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
