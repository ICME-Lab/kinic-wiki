import { expect, it } from "vitest";
import { Principal } from "@icp-sdk/core/principal";
import { VaultClient } from "../src/api";
import { importKey } from "../../vault-crypto/src/index";
import type { Generation, Header, VaultActor } from "../src/contracts";
const generation: Generation = {
  version: 2, canister: Principal.fromText("rrkah-fqaaa-aaaaa-aaaaq-cai"),
  owner: Principal.fromText("ryjl3-tyaaa-aaaaa-aaaba-cai"),
  vault: new Uint8Array(16).fill(1), epoch: 1n, nonce: new Uint8Array(32).fill(2), key_name: "test_key_1",
};
const header = (): Header => ({ id: generation.vault.slice(), generation: [{...generation, nonce: generation.nonce.slice()}], epoch:1n, sequence:1n, key_name:"test_key_1", state:{Active:null}, normal:[], recovery:[], recovery_verifier:[], published_slot:[], backup_at:[], backup_sequence:[] });
async function fixture() {
  let current = header();
  const client = new VaultClient();
  Object.assign(client, {actorValue: {
    get_vault_header: async () => ({Ok:current}),
    list_objects: async () => ({Ok:{entries:[],next:[]}}),
  } as unknown as VaultActor});
  client.header = header();
  const raw = new Uint8Array(32).fill(7), root = await importKey(raw);
  // Real unlock installs this key; this test isolates the post-unlock generation boundary.
  client.session.bindRoot(root, client.header!.generation[0]!, raw);
  return { client, raw, root, rotate: () => {current = {...header(), epoch:2n, generation:[{...generation,epoch:2n,nonce:new Uint8Array(32).fill(9)}]};}, current:()=>current };
}
it("locks an empty unlocked Vault when the authoritative generation rotates", async () => {
  const f = await fixture();
  f.rotate();
  await expect(f.client.items()).rejects.toThrow();
  expect(f.client.session.root).toBeUndefined();
  expect(f.raw.every(x=>x===0)).toBe(true);
});
it("header refresh cannot relabel an unlocked root as a new generation", async () => {
  const f = await fixture(); f.rotate();
  expect(()=>{ f.client.header=f.current(); }).toThrow();
  expect(f.client.session.root).toBeUndefined();
});
it("same-generation sequence and backup updates preserve the unlocked root", async () => {
  const f = await fixture();
  f.client.header={...header(),sequence:2n,backup_sequence:[2n]};
  expect(f.client.session.root).toBe(f.root);
});
it("freezing or removing an unlocked header destroys the root", async () => {
  const f = await fixture();
  expect(()=>{ f.client.header={...header(),state:{Purging:null}}; }).toThrow();
  expect(f.client.session.root).toBeUndefined();
});
it("copies the key binding so mutating the supplied header cannot change it", async () => {
  const f = await fixture();
  f.client.header!.generation[0]!.nonce[0] = 99;
  expect(()=>f.client.session.requireGeneration(f.client.header!.generation[0])).toThrow("TargetChanged");
  expect(f.client.session.root).toBeUndefined();
});
it("a late backup confirmation for another generation locks instead of relabelling the key", async () => {
  const f = await fixture(); f.rotate();
  Object.assign(f.client, {actorValue:{finish_export:async()=>({Ok:f.current()})}});
  await expect(f.client.confirmBackup(new Uint8Array(16),true)).rejects.toThrow("TargetChanged");
  expect(f.client.session.root).toBeUndefined();
});
it("authoritative disappearance locks and wipes the unlocked session", async () => {
  const f = await fixture();
  Object.assign(f.client,{actorValue:{get_vault_header:async()=>({Err:{NotFound:null}})}});
  await expect(f.client.items()).rejects.toThrow("NotFound");
  expect(f.client.session.root).toBeUndefined();
  expect(f.raw.every(x=>x===0)).toBe(true);
});
