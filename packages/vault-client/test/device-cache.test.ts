import { expect, it, vi } from "vitest";
import { Principal } from "@icp-sdk/core/principal";
import { importKey } from "@kinic/vault-crypto";
vi.mock("@kinic/vault-crypto/context", async (load) => ({
  ...await load<typeof import("@kinic/vault-crypto/context")>(),
  validateRootHeader: () => {},
  verifiedRoot: async () => importKey(new Uint8Array(32).fill(8)),
}));
import { VaultClient } from "../src/api.ts";
import type { DeviceKeys } from "../src/device-keys.ts";
import type { Header, VaultActor } from "../src/contracts.ts";
const principal = Principal.fromText("rrkah-fqaaa-aaaaa-aaaaq-cai");
const h: Header = { name: [], id: new Uint8Array(16).fill(1), nonce: new Uint8Array(32).fill(2), public_key: new Uint8Array(96).fill(3), key_name: "test_key_1", sequence: 0n, state: { Active: null } };
function fixture() {
  let epoch = 0;
  const keys = new Map<string, CryptoKey>();
  const store: DeviceKeys = {
    epoch: async () => epoch,
    get: async (binding) => keys.get(binding),
    put: async (binding, key, expected) => { if (epoch !== expected) return false; keys.set(binding, key); return true; },
    forget: async () => { epoch++; keys.clear(); },
    remove: async (binding) => { keys.delete(binding); },
    subscribe: () => () => {},
  };
  const actor = { get_vault_header: vi.fn(async () => ({ Ok: structuredClone(h) })), derive_vault_key: vi.fn(async () => ({ Ok: { input: [], public_key: [], encrypted_key: [] } })) } as unknown as VaultActor;
  const create = () => new VaultClient({actor, identity: { getPrincipal: () => principal } as any, canister: principal.toText(), local: true, deviceKeys: store});
  return { create, actor, keys, store };
}
it("reuses verified device keys across close and new authenticated clients", async () => {
  const f = fixture(), a = f.create();
  await a.open(h);
  expect(a.deviceKeyStatus).toBe("saved");
  a.session.lock();
  await a.open(h);
  const b = f.create();
  await b.open(h);
  expect(f.actor.derive_vault_key).toHaveBeenCalledTimes(1);
  expect(b.session.root?.extractable).toBe(false);
});
it("does not reuse a cache entry after the header binding changes", async () => {
  const f = fixture(), a = f.create();
  await a.open(h);
  a.session.lock();
  vi.mocked(f.actor.get_vault_header).mockResolvedValue({ Ok: { ...h, nonce: new Uint8Array(32).fill(9) } });
  await a.open(h);
  expect(f.actor.derive_vault_key).toHaveBeenCalledTimes(2);
});
it("forgetting stored keys locks the session and prevents reuse", async () => {
  const f = fixture(), a = f.create();
  await a.open(h);
  await a.forgetDeviceKeys();
  expect(a.session.root).toBeUndefined();
  expect(f.keys.size).toBe(0);
  await a.open(h);
  expect(f.actor.derive_vault_key).toHaveBeenCalledTimes(2);
});
it("does not install a cached key after its device epoch was forgotten", async () => {
  const f=fixture(), a=f.create();
  await a.open(h);
  const b=f.create();
  const original=f.store.get;
  f.store.get=async (...args) => { const key=await original(...args); await f.store.forget(); return key; };
  await expect(b.open(h)).rejects.toThrow("Locked");
  expect(b.session.root).toBeUndefined();
});
it("does not restore a key when forget happened during the initial header read",async()=>{
  const f=fixture(),a=f.create();
  const original=f.actor.get_vault_header;
  vi.mocked(f.actor.get_vault_header).mockImplementationOnce(async(...args)=>{
    await f.store.forget();
    return original(...args);
  });
  await expect(a.open(h)).rejects.toThrow("Locked");
  expect(f.keys.size).toBe(0);
});
it("discards the stored handle when the server reports the Vault is deleting",async()=>{
  const f=fixture(),a=f.create();
  await a.open(h);a.session.lock();
  vi.mocked(f.actor.get_vault_header).mockResolvedValue({Ok:{...h,state:{Deleting:null}}});
  await expect(a.open(h)).rejects.toThrow("TargetChanged");
  expect(f.keys.size).toBe(0);
});
it("can reuse a saved key while forbidding a new paid derivation",async()=>{
  const f=fixture(),a=f.create();
  await a.open(h);a.session.lock();
  await a.open(h,{allowDerive:false});
  expect(f.actor.derive_vault_key).toHaveBeenCalledTimes(1);
  await a.forgetDeviceKeys();
  await expect(a.open(h,{allowDerive:false})).rejects.toThrow("KeyFundingRequired");
  expect(f.actor.derive_vault_key).toHaveBeenCalledTimes(1);
});
it("authorizes a new derivation once while preserving exact lost-response retries",async()=>{
  const f=fixture(),a=f.create();
  const authorize=vi.fn(async()=>{});
  vi.mocked(f.actor.derive_vault_key).mockRejectedValueOnce(Error("LostResponse"));
  await expect(a.open(h,{beforeDerive:authorize})).rejects.toThrow("LostResponse");
  await a.open(h,{beforeDerive:authorize});
  expect(authorize).toHaveBeenCalledTimes(1);
  expect(vi.mocked(f.actor.derive_vault_key).mock.calls[0][0]).toEqual(vi.mocked(f.actor.derive_vault_key).mock.calls[1][0]);
});
