import { describe, expect, it, vi } from "vitest";
import { Actor, HttpAgent } from "@icp-sdk/core/agent";
import { IDL } from "@icp-sdk/core/candid";
import { Principal } from "@icp-sdk/core/principal";
import { createWalletSessionManager } from "../src/wallet-session";
import { createIdentityTransport } from "../src/transports/identity";
import * as certified from "../src/transports/certified-reply";
import type { ApproveArgs, OisySigner, PlugWallet } from "../src/wallet-types";

export const owner = Principal.fromUint8Array(Uint8Array.of(2)).toText();
const other = Principal.fromUint8Array(Uint8Array.of(3)).toText();
const canisterId = "aaaaa-aa";
const scopes = [{ canisterId, methods: ["write", "read", "icrc2_approve"] }];
const service: IDL.InterfaceFactory = ({ IDL }) => IDL.Service({
  write: IDL.Func([IDL.Text], [IDL.Text], []), read: IDL.Func([], [IDL.Text], ["query"]),
});
const call = { canisterId, method: "write", mode: "update" as const, arg: IDL.encode([IDL.Text], ["input"]), interfaceFactory: service };
const config = { origin: "https://app.example", host: "https://icp0.io", signerUrl: "https://wallet.example/sign", scopes };
const approval: ApproveArgs = { spender: { owner: Principal.fromText(owner), subaccount: [] }, from_subaccount: [], amount: 1n,
  expected_allowance: [0n], fee: [10n], created_at_time: [123n], memo: [Uint8Array.of(9)], expires_at: [999n] };

function signer() {
  const granted = ["icrc27_accounts", "icrc49_call_canister"].map(method => ({ scope: { method }, state: "granted" }));
  return { permissions: vi.fn(async () => granted), requestPermissions: vi.fn(async () => granted),
    accounts: vi.fn(async () => [{ owner }]), callCanister: vi.fn(async () => ({ certificate: "", contentMap: "" })), disconnect: vi.fn(async () => {}) };
}
function plugWallet() {
  return { requestConnect: vi.fn(async () => true), isConnected: vi.fn(async () => true),
    agent: { getPrincipal: vi.fn(async () => Principal.fromText(owner)) }, disconnect: vi.fn(async () => {}),
    createActor: vi.fn(async () => ({ write: vi.fn(async (a: string) => a), icrc2_approve: vi.fn(async () => ({ Ok: 42n })) })) };
}
describe("funding transports", () => {
  it("oisy_retains_live_handle_between_payments and authenticates replicated queries through the same signer", async () => {
    const wallet = signer();
    const openSigner = vi.fn(async () => wallet as OisySigner);
    const verification = vi.spyOn(certified, "certifiedReply").mockResolvedValue(Uint8Array.of(7));
    try {
      const manager = createWalletSessionManager({ ...config, transports: { openSigner } });
      const transport = await manager.connect("oisy", scopes);
      await transport.call(call);
      await transport.call({ ...call, method: "read", mode: "query", arg: IDL.encode([], []) });
      expect(openSigner).toHaveBeenCalledTimes(1);
      expect(wallet.disconnect).not.toHaveBeenCalled();
      expect(wallet.accounts).toHaveBeenCalledTimes(3);
      expect(wallet.requestPermissions).not.toHaveBeenCalled();
      expect(wallet.callCanister).toHaveBeenCalledTimes(2);
      expect(verification).toHaveBeenCalledTimes(2);
      expect(transport.silentCheck).toBe(false);
      await manager.disconnect();
      expect(wallet.disconnect).toHaveBeenCalledTimes(1);
    } finally { verification.mockRestore(); }
  });
  it("serializes signer requests and invalidates queued dispatch on owner change", async () => {
    const wallet = signer();
    const manager = createWalletSessionManager({ ...config, transports: { openSigner: async () => wallet as OisySigner } });
    const transport = await manager.connect("oisy", scopes);
    const token = manager.capture();
    let resolve!: (v: { owner: string }[]) => void;
    wallet.accounts.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const first = transport.call(call);
    const second = transport.call(call);
    await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
    expect(wallet.accounts).toHaveBeenCalledTimes(2);
    resolve([{ owner: other }]);
    await expect(first).rejects.toMatchObject({ code: "AccountChanged" });
    await expect(second).rejects.toBeDefined();
    expect(wallet.callCanister).not.toHaveBeenCalled();
    expect(manager.isCurrent(token)).toBe(false);
    expect(manager.getSnapshot().state).toBe("reconnect-required");
  });
  it("cancels an app-stale queued approval and a call invalidated during account revalidation", async () => {
    const wallet = signer();
    const manager = createWalletSessionManager({ ...config, transports: { openSigner: async () => wallet as OisySigner } });
    const transport = await manager.connect("oisy", scopes);
    let resolve!: (accounts: { owner: string }[]) => void;
    wallet.accounts.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    let ready = true;
    const first = transport.call({ ...call, isCurrent: () => ready });
    const second = transport.approve(canisterId, approval, { isCurrent: () => ready });
    await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
    ready = false;
    resolve([{ owner }]);
    const results = await Promise.allSettled([first, second]);
    expect(results.map(result => result.status)).toEqual(["rejected", "rejected"]);
    expect(wallet.callCanister).not.toHaveBeenCalled();
    expect(wallet.accounts).toHaveBeenCalledTimes(2);
    expect(manager.getSnapshot().state).toBe("connected");
  });
  it("uses Plug actors with the supplied interface, rejects mode or whitelist mismatches and asks on expanded scopes", async () => {
    const plug = plugWallet();
    const manager = createWalletSessionManager({ ...config, transports: { getPlug: () => plug } });
    const wallet = await manager.connect("plug", scopes);
    const answer = await wallet.call(call);
    expect(IDL.decode([IDL.Text], answer)).toEqual(["input"]);
    expect(plug.createActor).toHaveBeenCalledWith({ canisterId, interfaceFactory: service });
    await expect(wallet.call({ ...call, mode: "query" })).rejects.toBeDefined();
    await expect(wallet.call({ ...call, method: "other" })).rejects.toBeDefined();
    expect(plug.createActor).toHaveBeenCalledTimes(1);
    await manager.connect("plug", scopes);
    expect(plug.requestConnect).toHaveBeenCalledTimes(1);
    await manager.connect("plug", [...scopes, { canisterId: other, methods: ["read"] }]);
    expect(plug.requestConnect).toHaveBeenCalledTimes(2);
    expect(plug.requestConnect).toHaveBeenLastCalledWith(expect.objectContaining({ whitelist: [canisterId, other] }));
  });
  it("checks owner after Plug actor setup and before calling it", async () => {
    const plug = plugWallet();
    const actor = await plug.createActor();
    plug.createActor.mockImplementation(async () => {
      plug.agent.getPrincipal.mockResolvedValue(Principal.fromText(other));
      return actor;
    });
    const manager = createWalletSessionManager({ ...config, transports: { getPlug: () => plug } });
    const wallet = await manager.connect("plug", scopes);
    const token = manager.capture();
    await expect(wallet.call(call)).rejects.toMatchObject({ code: "AccountChanged" });
    expect(actor.write).not.toHaveBeenCalled();
    expect(manager.isCurrent(token)).toBe(false);
  });
  it.each([
    [{ Ok: 7n }, 7n], [{ Err: { Duplicate: { duplicate_of: 9n } } }, 9n],
    [{ Err: { InsufficientFunds: { balance: 0n } } }, "InsufficientFunds"],
    [{ Err: { AllowanceChanged: { current_allowance: 3n } } }, "AllowanceChanged"],
    [{ Err: { Expired: { ledger_time: 44n } } }, "Expired"],
  ] as const)("decodes a certified/actor ICRC approval reply", async (result, expected) => {
    const plug = plugWallet();
    const approve = vi.fn(async () => result);
    const stub: PlugWallet = { ...plug, createActor: async () => ({ icrc2_approve: approve }) };
    const wallet = await createWalletSessionManager({ ...config, transports: { getPlug: () => stub } }).connect("plug", scopes);
    const block = wallet.approve(canisterId, approval);
    if (typeof expected === "bigint") await expect(block).resolves.toBe(expected);
    else await expect(block).rejects.toMatchObject({ code: expected });
    expect(approve).toHaveBeenCalledWith(approval);
  });
  it("keeps ambiguous transport loss unresolved and refuses a nondefault approval account", async () => {
    const approve = vi.fn(async () => { throw new Error("response lost"); });
    const stub: PlugWallet = { ...plugWallet(), createActor: async () => ({ icrc2_approve: approve }) };
    const wallet = await createWalletSessionManager({ ...config, transports: { getPlug: () => stub } }).connect("plug", scopes);
    await expect(wallet.approve(canisterId, { ...approval, from_subaccount: [Uint8Array.of(1)] })).rejects.toMatchObject({ code: "UnsupportedAccount" });
    await expect(wallet.approve(canisterId, approval)).rejects.toThrow();
    expect(approve).toHaveBeenCalledTimes(1);
    const error = await wallet.approve(canisterId, approval).catch((error: unknown) => error);
    expect(error).not.toMatchObject({ code: "ApprovalRejected" });
  });
  it("does not mistake a thrown provider object for an authenticated approval result", async () => {
    const stub: PlugWallet = { ...plugWallet(), createActor: async () => { throw { ApprovalRejected: "timeout" }; } };
    const wallet = await createWalletSessionManager({ ...config, transports: { getPlug: () => stub } }).connect("plug", scopes);
    await expect(wallet.approve(canisterId, approval)).rejects.toMatchObject({ code: "Unknown" });
  });
  it("keeps a Plug actor failure uncertain even when it resembles a rejected connection prompt", async () => {
    const actor = { icrc2_approve: vi.fn(async () => { throw { code: 401, message: "The agent creation was rejected." }; }) };
    const plug: PlugWallet = { ...plugWallet(), createActor: async () => actor };
    const transport = await createWalletSessionManager({ ...config, transports: { getPlug: () => plug } }).connect("plug", scopes);
    await expect(transport.approve(canisterId, approval)).rejects.toMatchObject({ code: "Unknown" });
    expect(actor.icrc2_approve).toHaveBeenCalledTimes(1);
  });
  it("revalidates signer grants and requests only missing permission before approving", async () => {
    const wallet = signer();
    wallet.permissions.mockResolvedValue([{ scope: { method: "icrc27_accounts" }, state: "granted" }]);
    wallet.requestPermissions.mockResolvedValue([{ scope: { method: "icrc49_call_canister" }, state: "granted" }]);
    wallet.callCanister.mockRejectedValueOnce(Object.assign(new Error("cancelled"), { code: 3001 }))
      .mockRejectedValueOnce(Object.assign(new Error("response lost"), { code: 4000 }));
    const transport = await createWalletSessionManager({ ...config, transports: { openSigner: async () => wallet as OisySigner } }).connect("oisy", scopes);
    expect(wallet.requestPermissions).not.toHaveBeenCalled();
    await expect(transport.approve(canisterId, approval)).rejects.toMatchObject({ code: "ApprovalRejected" });
    expect(wallet.requestPermissions).toHaveBeenCalledWith({ params: { scopes: [{ method: "icrc49_call_canister" }] }, options: { timeoutInMilliseconds: 120000 } });
    await expect(transport.approve(canisterId, approval)).rejects.toMatchObject({ code: "Unknown" });
  });
  it.each(["http://0.0.0.0:4943", "http://[::1]:4943", "http://127.0.0.1:4943", "http://replica.localhost:4943"])("rejects a mainnet OISY signer before opening it for a local ledger %s", async host => {
    const openSigner = vi.fn(async () => signer() as OisySigner);
    const manager = createWalletSessionManager({ ...config, host, signerUrl: "https://oisy.com/sign", transports: { openSigner } });
    await expect(manager.connect("oisy", scopes)).rejects.toMatchObject({ reason: "unsupported-network" });
    expect(openSigner).not.toHaveBeenCalled();
  });
  it("accepts an explicitly local OISY fixture for a local replica", async () => {
    const openSigner = vi.fn(async () => signer() as OisySigner);
    const manager = createWalletSessionManager({ ...config, host: "http://127.0.0.1:4943", signerUrl: "http://signer.localhost:3001/sign", transports: { openSigner } });
    await manager.connect("oisy", scopes);
    expect(openSigner).toHaveBeenCalledTimes(1);
  });
  it.each([undefined, "https://icp0.io"])("requires a matching live Plug agent host for local updates (%s)", async observedHost => {
    const plug = plugWallet();
    const host = "http://127.0.0.1:4943";
    const agent = { ...plug.agent, host: host as string | undefined };
    const manager = createWalletSessionManager({ ...config, host, transports: { getPlug: () => ({ ...plug, agent }) } });
    const transport = await manager.connect("plug", scopes);
    agent.host = observedHost;
    await expect(transport.approve(canisterId, approval)).rejects.toMatchObject({ reason: "unsupported-network" });
    expect(plug.createActor).not.toHaveBeenCalled();
  });
  it("uses the exact supplied II identity for authenticated reads", async () => {
    const identity = { getPrincipal: () => Principal.fromText(owner), transformRequest: vi.fn() };
    const agent = vi.spyOn(HttpAgent, "createSync");
    const actor = vi.spyOn(Actor, "createActor").mockReturnValue({ read: async () => "balance" } as never);
    try {
      const transport = createIdentityTransport({ ...config, identity });
      expect(IDL.decode([IDL.Text], await transport.call({ ...call, method: "read", mode: "query", arg: IDL.encode([], []) }))).toEqual(["balance"]);
      expect(agent).toHaveBeenCalledWith(expect.objectContaining({ identity, host: config.host, retryTimes: 0 }));
      expect(transport.silentCheck).toBe(true);
    } finally { actor.mockRestore(); agent.mockRestore(); }
  });
});
