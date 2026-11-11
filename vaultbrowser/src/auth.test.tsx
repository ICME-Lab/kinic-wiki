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
      <button onClick={s.login}>login</button>
      <button onClick={s.logout}>logout</button>
    </>
  );
}
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
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
