import { expect, it, vi } from "vitest";
import { Principal } from "@icp-sdk/core/principal";
import { createWalletSessionManager } from "../src/wallet-session";
import type { OisySigner } from "../src/wallet-types";

const owner = Principal.fromUint8Array(Uint8Array.of(1)).toText();
const config = { origin: "https://wiki.example", host: "https://icp0.io", signerUrl: "https://sign.example" };
const identity = { getPrincipal: () => Principal.fromText(owner), transformRequest: vi.fn() };
function storage() {
  const data = new Map<string, string>();
  return { data, getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
}
function signer(accounts: { owner: string; subaccount?: string }[] = [{ owner }]) {
  return { permissions: vi.fn(async () => [{ scope: { method: "icrc27_accounts" }, state: "granted" }]),
    requestPermissions: vi.fn(async () => []), accounts: vi.fn(async () => accounts), disconnect: vi.fn(async () => {}), callCanister: vi.fn() } as unknown as OisySigner;
}
it("remembers only account and network across reload, never opens OISY during restore, and preserves recovery on disconnect", async () => {
  const local = storage();
  local.setItem("recovery", "marker");
  const wallet = signer();
  const openSigner = vi.fn(async () => wallet);
  const options = { ...config, storage: local, transports: { openSigner } };
  const manager = createWalletSessionManager(options);
  await manager.connect("oisy", []);
  expect([...local.data.values()].map(v => v.startsWith("{") ? Object.keys(JSON.parse(v)).sort() : v)).toContainEqual(["host", "origin", "owner", "provider", "version"]);
  await manager.destroy();
  const next = createWalletSessionManager(options);
  await next.restore();
  expect(next.getSnapshot()).toMatchObject({ state: "remembered", account: { provider: "oisy", owner }, transport: null });
  expect(openSigner).toHaveBeenCalledTimes(1);
  await next.disconnect();
  expect([...local.data]).toEqual([["recovery", "marker"]]);
});
it("migrates only verified-shape legacy metadata and rejects corrupt or foreign preferences", async () => {
  const legacy = storage();
  const local = storage();
  legacy.setItem("kinic-wiki.wallet-session", JSON.stringify({ provider: "oisy", principal: owner }));
  const options = { ...config, storage: local, legacyStorage: legacy };
  const manager = createWalletSessionManager(options);
  await manager.restore();
  expect(manager.getSnapshot().state).toBe("remembered");
  expect(legacy.data.size).toBe(0);
  const [key, value] = [...local.data][0];
  for (const invalid of ["corrupt", JSON.stringify({ ...JSON.parse(value), provider: ["oisy"] }), JSON.stringify({ ...JSON.parse(value), host: "https://other.example" })]) {
    local.setItem(key, invalid);
    const next = createWalletSessionManager(options);
    await next.restore();
    expect(next.getSnapshot().state).toBe("disconnected");
  }
});
it("restores Plug only after noninteractive connection and owner checks", async () => {
  const local = storage();
  const plug = { isConnected: vi.fn(async () => true), requestConnect: vi.fn(async () => true), agent: { getPrincipal: vi.fn(async () => Principal.fromText(owner)) }, createActor: vi.fn() };
  const options = { ...config, storage: local, transports: { getPlug: () => plug } };
  await createWalletSessionManager(options).connect("plug", []);
  const next = createWalletSessionManager(options);
  await next.restore();
  expect(next.getSnapshot().state).toBe("connected");
  expect(plug.isConnected).toHaveBeenCalled();
  expect(plug.requestConnect).toHaveBeenCalledTimes(1);
  plug.agent.getPrincipal.mockResolvedValue(Principal.fromText("aaaaa-aa"));
  const another = createWalletSessionManager(options);
  await another.restore();
  expect(another.getSnapshot()).toMatchObject({ state: "reconnect-required", account: { owner } });
  expect(plug.requestConnect).toHaveBeenCalledTimes(1);
});
it.each([
  ["empty-accounts", []], ["unsupported-account", [{ owner, subaccount: btoa("x".repeat(32)) }]],
] as const)("marks %s explicitly and releases signer", async (reason, accounts) => {
  const wallet = signer([...accounts]);
  const manager = createWalletSessionManager({ ...config, transports: { openSigner: async () => wallet } });
  await expect(manager.connect("oisy", [])).rejects.toBeDefined();
  expect(manager.getSnapshot()).toMatchObject({ state: "reconnect-required", reason });
  expect(wallet.disconnect).toHaveBeenCalledTimes(1);
});
it("handles missing extension, denied permission, popup failure and closure", async () => {
  const wallet = signer();
  vi.mocked(wallet.permissions).mockResolvedValue([]);
  const manager = createWalletSessionManager({ ...config, transports: { getPlug: () => undefined, openSigner: async () => wallet } });
  await expect(manager.connect("plug", [])).rejects.toBeDefined();
  expect(manager.getSnapshot().reason).toBe("extension-missing");
  await expect(manager.connect("oisy", [])).rejects.toBeDefined();
  expect(manager.getSnapshot().reason).toBe("permission-denied");
  let close!: () => void;
  const active = createWalletSessionManager({ ...config, transports: { openSigner: async options => { close = options.onDisconnect!; return signer(); } } });
  await active.connect("oisy", []);
  const token = active.capture();
  close();
  expect(active.isCurrent(token)).toBe(false);
  expect(active.getSnapshot().reason).toBe("disconnected");
  const blocked = createWalletSessionManager({ ...config, transports: { openSigner: async () => { throw new Error("Unable to open the signer window."); } } });
  await expect(blocked.connect("oisy", [])).rejects.toMatchObject({ code: "SignerBlocked", reason: "popup-blocked" });
  expect(blocked.getSnapshot().reason).toBe("popup-blocked");
});
it("binds and replaces II explicitly and invalidates in-flight work on sign-out", async () => {
  const wallet = signer();
  const manager = createWalletSessionManager({ ...config, identity, transports: { openSigner: async () => wallet } });
  expect(manager.getSnapshot().account).toEqual({ provider: "ii", owner });
  const old = manager.capture();
  const external = await manager.connect("oisy", []);
  expect(manager.isCurrent(old)).toBe(false);
  expect(external.account.provider).toBe("oisy");
  expect(manager.getIdentityTransport([])?.account.provider).toBe("ii");
  const token = manager.capture();
  manager.setIdentity(undefined);
  expect(manager.isCurrent(token)).toBe(false);
  expect(wallet.disconnect).toHaveBeenCalledTimes(1);
});

it("late II auth keeps the live external signer while invalidating old application work", async () => {
  const wallet = signer();
  const manager = createWalletSessionManager({ ...config, transports: { openSigner: async () => wallet } });
  const stale = await manager.connect("oisy", []);
  const token = manager.capture();
  manager.setIdentity(identity);
  expect(manager.isCurrent(token)).toBe(false);
  expect(manager.getSnapshot()).toMatchObject({ state: "connected", account: { provider: "oisy", owner } });
  expect(wallet.disconnect).not.toHaveBeenCalled();
  await expect(stale.revalidate()).rejects.toBeDefined();
  await manager.getSnapshot().transport!.revalidate();
  expect(manager.getIdentityTransport([])?.account.provider).toBe("ii");
});
it("late II auth preserves the remembered external account across reload", async () => {
  const local = storage();
  const options = { ...config, storage: local, transports: { openSigner: async () => signer() } };
  await createWalletSessionManager(options).connect("oisy", []);
  const next = createWalletSessionManager(options);
  await next.restore();
  next.setIdentity(identity);
  expect(next.getSnapshot()).toMatchObject({ state: "remembered", account: { provider: "oisy", owner } });
  expect(next.getIdentityTransport([])?.account.provider).toBe("ii");
});

it("explicit disconnect closes an open signer while initial account permission is pending", async () => {
  let finish!: (value: never[]) => void;
  const wallet = signer();
  vi.mocked(wallet.permissions).mockImplementation(() => new Promise(done => { finish = done; }));
  const manager = createWalletSessionManager({ ...config, transports: { openSigner: async () => wallet } });
  const opening = manager.connect("oisy", []);
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  await manager.disconnect();
  expect(wallet.disconnect).toHaveBeenCalledTimes(1);
  finish([]);
  await expect(opening).rejects.toBeDefined();
  expect(wallet.accounts).not.toHaveBeenCalled();
  expect(manager.getSnapshot().state).toBe("disconnected");
});
it("prevents a second named OISY popup while a discarded initial handshake still owns it", async () => {
  let finish!: (wallet: OisySigner) => void;
  const openSigner = vi.fn(() => new Promise<OisySigner>(done => { finish = done; }));
  const manager = createWalletSessionManager({ ...config, transports: { openSigner } });
  const first = manager.connect("oisy", []);
  await manager.disconnect();
  const second = manager.connect("oisy", []);
  expect(openSigner).toHaveBeenCalledTimes(1);
  await expect(second).rejects.toBeDefined();
  const stale = signer();
  finish(stale);
  await expect(first).rejects.toBeDefined();
  expect(stale.disconnect).toHaveBeenCalledTimes(1);
});
it("prefers the remembered default account when reconnect returns multiple eligible accounts", async () => {
  const local = storage();
  await createWalletSessionManager({ ...config, storage: local, transports: { openSigner: async () => signer() } }).connect("oisy", []);
  const alternatives = signer([{ owner: "aaaaa-aa" }, { owner }]);
  const next = createWalletSessionManager({ ...config, storage: local, transports: { openSigner: async () => alternatives } });
  await next.restore();
  expect((await next.connect("oisy", [])).account.owner).toBe(owner);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function delayedPlug() {
  const consent = deferred<boolean>();
  const released = deferred<void>();
  let connected = false;
  const plug = {
    requestConnect: vi.fn(async () => { connected = await consent.promise; return connected; }),
    isConnected: vi.fn(async () => connected),
    agent: { getPrincipal: vi.fn(async () => Principal.fromText(owner)) },
    disconnect: vi.fn(async () => { await released.promise; connected = false; }),
    createActor: vi.fn(),
  };
  return { plug, consent, released };
}
it.each(["disconnect", "sign-out"] as const)("revokes a late Plug grant after %s and holds the next connect until release", async action => {
  const { plug, consent, released } = delayedPlug();
  const manager = createWalletSessionManager({ ...config, identity, storage: storage(), transports: { getPlug: () => plug } });
  const opening = manager.connect("plug", []).catch(error => error);
  const disconnect = action === "disconnect" ? manager.disconnect() : manager.setIdentity(undefined);
  expect(manager.getSnapshot().state).toBe("disconnected");
  const duringConsent = manager.connect("plug", []).catch(error => error);
  expect(plug.requestConnect).toHaveBeenCalledTimes(1);
  expect(await duringConsent).toBeInstanceOf(Error);
  consent.resolve(true);
  await vi.waitFor(() => expect(plug.disconnect).toHaveBeenCalledTimes(1));
  await expect(manager.connect("plug", [])).rejects.toBeDefined();
  expect(plug.requestConnect).toHaveBeenCalledTimes(1);
  released.resolve();
  expect(await opening).toBeInstanceOf(Error);
  await disconnect;
  expect(await plug.isConnected()).toBe(false);
  expect(manager.getSnapshot().state).toBe("disconnected");
  const next = await manager.connect("plug", []);
  expect(next.account.owner).toBe(owner);
  expect(await plug.isConnected()).toBe(true);
  expect(plug.disconnect).toHaveBeenCalledTimes(1);
});
it("preserves Plug extension consent when a page suspends while its prompt is open", async () => {
  const { plug, consent } = delayedPlug();
  const manager = createWalletSessionManager({ ...config, transports: { getPlug: () => plug } });
  const opening = manager.connect("plug", []);
  manager.suspend();
  consent.resolve(true);
  await expect(opening).rejects.toBeDefined();
  expect(await plug.isConnected()).toBe(true);
  expect(plug.disconnect).not.toHaveBeenCalled();
  expect(manager.getSnapshot().transport).toBeNull();
});
it("keeps a new Plug connection from racing cleanup of the active extension session", async () => {
  const { plug, consent, released } = delayedPlug();
  consent.resolve(true);
  const manager = createWalletSessionManager({ ...config, transports: { getPlug: () => plug } });
  await manager.connect("plug", []);
  const cleanup = manager.disconnect();
  await expect(manager.connect("plug", [])).rejects.toBeDefined();
  expect(plug.requestConnect).toHaveBeenCalledTimes(1);
  released.resolve();
  await cleanup;
  await manager.connect("plug", []);
  expect(await plug.isConnected()).toBe(true);
});
it.each([
  [{ code: 401, message: "The agent creation was rejected." }, "permission-denied"],
  [new Error("The agent creation was rejected."), "permission-denied"],
  [{ code: 401, message: "Unauthorized call to provider executor" }, "connection-failed"],
  [new Error("Extension unavailable"), "connection-failed"],
] as const)("classifies Plug connection refusal separately from provider failures", async (error, reason) => {
  const { plug } = delayedPlug();
  plug.requestConnect.mockRejectedValue(error);
  const manager = createWalletSessionManager({ ...config, transports: { getPlug: () => plug } });
  await expect(manager.connect("plug", [])).rejects.toMatchObject({ reason });
  expect(manager.getSnapshot()).toMatchObject({ state: "reconnect-required", reason });
});
it("reports a failed Plug release to the explicit disconnect caller", async () => {
  const { plug, consent } = delayedPlug();
  plug.disconnect.mockRejectedValue(new Error("extension cleanup failed"));
  const manager = createWalletSessionManager({ ...config, transports: { getPlug: () => plug } });
  const opening = manager.connect("plug", []).catch(error => error);
  const closing = manager.disconnect();
  consent.resolve(true);
  await expect(closing).rejects.toBeDefined();
  expect(await opening).toBeInstanceOf(Error);
  expect(manager.getSnapshot().transport).toBeNull();
});
it("restores the prior verified Plug owner after a suspended scope-consent prompt settles", async () => {
  const local = storage();
  const { plug, consent } = delayedPlug();
  plug.requestConnect.mockResolvedValueOnce(true);
  plug.isConnected.mockResolvedValue(true);
  const manager = createWalletSessionManager({ ...config, storage: local, transports: { getPlug: () => plug } });
  await manager.connect("plug", []);
  const expansion = manager.connect("plug", [{ canisterId: "aaaaa-aa", methods: ["read"] }]).catch(error => error);
  manager.suspend();
  const restoring = manager.restore();
  consent.resolve(true);
  await expansion;
  await restoring;
  expect(manager.getSnapshot()).toMatchObject({ state: "connected", account: { provider: "plug", owner } });
  expect(plug.requestConnect).toHaveBeenCalledTimes(2);
  expect(plug.disconnect).not.toHaveBeenCalled();
});

it("normalizes extension getter failures and permits a later connect", async () => {
  const getPlug = vi.fn().mockImplementationOnce(() => { throw new Error("getter denied"); });
  const manager = createWalletSessionManager({ ...config, transports: { getPlug } });
  await expect(manager.connect("plug", [])).rejects.toMatchObject({ reason: "connection-failed" });
  expect(manager.getSnapshot()).toMatchObject({ state: "reconnect-required", reason: "connection-failed" });
  await expect(manager.connect("plug", [])).rejects.toMatchObject({ reason: "extension-missing" });
});
