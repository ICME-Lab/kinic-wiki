import { afterEach, expect, it, vi } from "vitest";
import { Ed25519KeyIdentity } from "@icp-sdk/core/identity";
import { Principal } from "@icp-sdk/core/principal";
import { IDL } from "@icp-sdk/core/candid";
import { VaultClient } from "../src/api";
import { mutationIDL } from "../src/signed";
import type { Mutation } from "../src/mutation-contracts";
import type { Generation, Header, VaultActor } from "../src/contracts";
import { importKey } from "../../vault-crypto/src/index";
import { assertCredential } from "../src/webauthn";
afterEach(() => vi.restoreAllMocks());
vi.mock("../src/webauthn", () => ({
  assertCredential: vi.fn(async () => "proof"),
  register: vi.fn(async () => "registration"),
}));
const owner = Ed25519KeyIdentity.generate(),
  canister = Principal.fromText("rrkah-fqaaa-aaaaa-aaaaq-cai");
const generation: Generation = {
  version: 2,
  owner: owner.getPrincipal(),
  canister,
  vault: new Uint8Array(16).fill(2),
  epoch: 8n,
  nonce: new Uint8Array(32).fill(3),
  key_name: "test_key_1",
};
const header: Header = {
  generation: [generation],
  id: generation.vault,
  epoch: 8n,
  sequence: 1n,
  key_name: "test_key_1",
  state: { Active: null },
  normal: [],
  recovery: [],
  recovery_verifier: [],
  published_slot: [],
  backup_sequence: [],
  backup_at: [],
};
function fixture() {
  const operations: Mutation[] = [];
  const actor = {
    list_credentials: vi.fn(async () => ({
      Ok: [{ id: new Uint8Array([9]) }],
    })),
    begin_grant: vi.fn(async (_request: unknown) => ({
      Ok: {
        bytes: new Uint8Array(32),
        expires: BigInt(Math.floor(Date.now() / 1000) + 300),
        registration: false,
        credential_ids: [new Uint8Array([9])],
      },
    })),
    finish_grant: vi.fn(async () => ({
      Ok: {
        id: new Uint8Array(32),
        expires: BigInt(Math.floor(Date.now() / 1000) + 300),
        next_counter: 0n,
        generations: [generation],
        purpose: { Normal: null },
      },
    })),
    mutate: vi.fn(async (payload: Uint8Array) => {
      const m = IDL.decode([mutationIDL], payload)[0] as unknown as Mutation;
      operations.push(m);
      return {
        Ok:
          "CommitRevision" in m.operation
            ? { Revision: { revision: 1n } }
            : "BeginRevision" in m.operation
              ? {
                  Upload: { id: new Uint8Array(16), expires: 1n, revision: 1n },
                }
              : { Unit: null },
      };
    }),
    get_vault_header: vi.fn(async () => ({ Ok: header })),
  };
  const client = new VaultClient({
    actor: actor as unknown as VaultActor,
    identity: owner,
    canister: canister.toText(),
    local: true,
    rpId: "vault.localhost",
  });
  client.header = header;
  return { client, actor, operations };
}

async function unlocked() {
  const f = fixture();
  f.client.session.bindRoot(await importKey(new Uint8Array(32)), f.client.header!.generation[0]!);
  await f.client.authorize({ Normal: null }, [generation]);
  return f;
}
const save = (f: ReturnType<typeof fixture>) => f.client.save(
  { kind: "note", title: "unsaved draft" }, new Uint8Array([1, 2, 3]), undefined, () => {},
);
function expire(f: ReturnType<typeof fixture>) {
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 301000);
  f.client.session.lastActivity = Date.now();
}
it("active editing past expiry obtains fresh UV and saves without locking or losing the draft", async () => {
  const f = await unlocked(), root = f.client.session.root, ticket = f.client.session.capture();
  expire(f);
  await expect(save(f)).resolves.toEqual({ revision: 1n });
  expect(f.actor.begin_grant).toHaveBeenCalledTimes(2);
  expect(f.operations[0].counter).toBe(0n);
  expect((f.actor.begin_grant.mock.calls[1][0] as { public_key: Uint8Array }).public_key).not.toEqual((f.actor.begin_grant.mock.calls[0][0] as { public_key: Uint8Array }).public_key);
  expect(f.client.session.root).toBe(root);
  expect(f.client.session.capture()).toBe(ticket);
  f.client.session.lock();
});
it.each(["NotAllowedError", "InvalidProof"])("failed/cancelled renewal (%s) preserves the draft and can be retried", async (error) => {
  const f = await unlocked(), root = f.client.session.root;
  expire(f);
  vi.mocked(assertCredential).mockRejectedValueOnce(Error(error));
  await expect(save(f)).rejects.toThrow(error);
  expect(f.actor.mutate).not.toHaveBeenCalled();
  expect(f.client.session.root).toBe(root);
  await expect(save(f)).resolves.toEqual({ revision: 1n });
  f.client.session.lock();
});
it("known rejection obtains fresh authority on the next explicit Save without replaying the rejected save", async () => {
  const f = await unlocked();
  f.actor.mutate.mockResolvedValueOnce({ Err: { Unauthorized: null } } as never);
  await expect(save(f)).rejects.toThrow("Unauthorized");
  expect(f.actor.begin_grant).toHaveBeenCalledTimes(1);
  await expect(save(f)).resolves.toEqual({ revision: 1n });
  expect(f.actor.begin_grant).toHaveBeenCalledTimes(2);
  f.client.session.lock();
});
it("generation changed before renewal rejects stale encrypted draft writes", async () => {
  const f = await unlocked(), root = f.client.session.root;
  expire(f);
  f.actor.get_vault_header.mockResolvedValue({ Ok: { ...header, generation: [{ ...generation, nonce: new Uint8Array(32).fill(7) }] } });
  await expect(save(f)).rejects.toThrow("TargetChanged");
  expect(f.actor.mutate).not.toHaveBeenCalled();
  expect(f.client.session.root).toBeUndefined();
  f.client.session.lock();
});
it("generation changed during UV cannot publish or reuse the old generation", async () => {
  const f = await unlocked();
  expire(f);
  vi.mocked(assertCredential).mockImplementationOnce(async () => {
    f.actor.get_vault_header.mockResolvedValue({ Ok: { ...header, generation: [{ ...generation, key_name: "key_1" }] } });
    return "proof";
  });
  await expect(save(f)).rejects.toThrow("TargetChanged");
  await expect(save(f)).rejects.toThrow("Locked");
  expect(f.actor.begin_grant).toHaveBeenCalledTimes(2);
  expect(f.actor.mutate).not.toHaveBeenCalled();
  f.client.session.lock();
});
it("lock during renewal wipes the session and fences late proof", async () => {
  const f = await unlocked();
  expire(f);
  vi.mocked(assertCredential).mockImplementationOnce(async () => { f.client.session.lock(); return "proof"; });
  await expect(save(f)).rejects.toThrow("Locked");
  expect(f.actor.finish_grant).toHaveBeenCalledTimes(1);
  expect(f.actor.mutate).not.toHaveBeenCalled();
  expect(f.client.session.root).toBeUndefined();
});
it("unknown request survives expiry byte-for-byte and never obtains replacement authority", async () => {
  const f = await unlocked();
  const calls: Uint8Array[] = [];
  f.actor.mutate.mockImplementation(async (payload) => { calls.push(payload.slice()); throw Error("network"); });
  await expect(save(f)).rejects.toThrow("network");
  expire(f);
  await expect(save(f)).rejects.toThrow("ResolvePendingMutation");
  expect(f.actor.begin_grant).toHaveBeenCalledTimes(1);
  expect(calls).toHaveLength(3);
  expect(calls.every(p => Buffer.from(p).equals(Buffer.from(calls[0])))).toBe(true);
  f.actor.mutate.mockResolvedValue({ Ok: { Unit: null } });
  await f.client.retryMutation();
  expect(f.actor.mutate.mock.calls.at(-1)![0]).toEqual(calls[0]);
  f.client.session.lock();
});
it("grant-cap Busy preserves the active draft and does not send", async () => {
  const f = await unlocked(), root = f.client.session.root;
  expire(f);
  f.actor.begin_grant.mockResolvedValueOnce({ Err: { Busy: null } } as never);
  await expect(save(f)).rejects.toThrow("Busy");
  expect(f.client.session.root).toBe(root);
  expect(f.actor.mutate).not.toHaveBeenCalled();
  f.client.session.lock();
});

it("absent normal authority requests fresh UV for the exact current generation", async () => {
  const f = fixture();
  f.client.session.bindRoot(await importKey(new Uint8Array(32)), f.client.header!.generation[0]!);
  await expect(save(f)).resolves.toEqual({ revision: 1n });
  expect(f.actor.begin_grant).toHaveBeenCalledTimes(1);
  expect(f.actor.begin_grant.mock.calls[0][0]).toMatchObject({ purpose: { Normal: null }, generations: [generation] });
  f.client.session.lock();
});

it("a late renewal proof after lock cannot block or replace a newly authorized session", async () => {
  const f = await unlocked();
  expire(f);
  let release!: (proof: string) => void;
  vi.mocked(assertCredential).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const oldSave = save(f);
  const rejected = expect(oldSave).rejects.toThrow("Locked");
  await vi.waitFor(() => expect(release).toBeDefined());
  f.client.session.lock();
  f.client.header = header;
  f.client.session.bindRoot(await importKey(new Uint8Array(32)), f.client.header!.generation[0]!);
  await f.client.authorize({ Normal: null }, [generation]);
  release("late proof");
  await rejected;
  await expect(save(f)).resolves.toEqual({ revision: 1n });
  expect(f.actor.begin_grant).toHaveBeenCalledTimes(3);
  expect(f.actor.finish_grant).toHaveBeenCalledTimes(2);
  f.client.session.lock();
});
it("late header read after a lock cannot clear the new session signer", async () => {
  const f = await unlocked();
  expire(f);
  let release!: (value: { Ok: Header }) => void;
  f.actor.get_vault_header.mockResolvedValueOnce({ Ok: header }).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const oldSave = save(f);
  const rejected = expect(oldSave).rejects.toThrow("Locked");
  await vi.waitFor(() => expect(release).toBeDefined());
  f.client.session.lock();
  f.client.header = header;
  f.client.session.bindRoot(await importKey(new Uint8Array(32)), f.client.header!.generation[0]!);
  await f.client.authorize({ Normal: null }, [generation]);
  release({ Ok: header });
  await rejected;
  await expect(save(f)).resolves.toEqual({ revision: 1n });
  expect(f.actor.begin_grant).toHaveBeenCalledTimes(2);
  f.client.session.lock();
});
it("after remote rotation the old session locks and re-unlocked writes require the new root", async () => {
  const f=await unlocked(), oldRoot=f.client.session.root!;
  const next={...generation,epoch:9n,nonce:new Uint8Array(32).fill(11)}, h={...header,epoch:9n,generation:[next] as [Generation]};
  f.actor.get_vault_header.mockResolvedValue({Ok:h});
  Object.assign(f.actor,{list_objects:async()=>({Ok:{entries:[],next:[]}})});
  await expect(f.client.items()).rejects.toThrow("TargetChanged");
  expect(f.client.session.root).toBeUndefined();
  f.client.header=h;
  const root=await importKey(new Uint8Array(32).fill(19));
  f.client.session.bindRoot(root,next);
  f.actor.finish_grant.mockImplementation(async()=>({Ok:{id:new Uint8Array(32),expires:BigInt(Math.floor(Date.now()/1000)+300),next_counter:0n,generations:[next],purpose:{Normal:null}}}));
  await save(f);
  const begin=f.operations.find(m=>"BeginRevision" in m.operation)!.operation;
  if (!("BeginRevision" in begin)) throw Error("missing begin");
  const put=f.operations.find(m=>"PutChunk" in m.operation)!.operation;
  if (!("PutChunk" in put)) throw Error("missing chunk");
  const {decryptDocument}=await import("../../vault-crypto/src/documents");
  const {cryptoGeneration}=await import("../src/ordinary");
  const r=begin.BeginRevision, chunks=[new Uint8Array(put.PutChunk.data)];
  const decode=(key:CryptoKey)=>decryptDocument(key,new Uint8Array(r.vault),new Uint8Array(r.object),1n,new Uint8Array(r.manifest),chunks,r.chunk_hashes.map(x=>new Uint8Array(x)),cryptoGeneration(next));
  const doc=await decode(root);
  expect(doc.plaintext).toEqual(new Uint8Array([1,2,3]));
  doc.plaintext.fill(0);
  await expect(decode(oldRoot)).rejects.toThrow();
  f.client.session.lock();
});
