import { expect, it, vi } from "vitest";
import { Principal } from "@icp-sdk/core/principal";
import { encryptDocumentV3 } from "@kinic/vault-crypto/documents";
import { importKey } from "@kinic/vault-crypto";
vi.mock("@kinic/vault-crypto/context", async (load) => ({
  ...await load<typeof import("@kinic/vault-crypto/context")>(),
  validateRootHeader: () => {},
  verifiedRoot: async () => importKey(new Uint8Array(32).fill(8)),
}));
import { VaultClient } from "../src/api.ts";
import { BrowserDeviceKeys, bindingTargetsVault, type DeviceKeys } from "../src/device-keys.ts";
import type { Header, VaultActor } from "../src/contracts.ts";
const principal = Principal.fromText("rrkah-fqaaa-aaaaa-aaaaq-cai");
const h: Header = { name: [], id: new Uint8Array(16).fill(1), nonce: new Uint8Array(32).fill(2), public_key: new Uint8Array(96).fill(3), key_name: "test_key_1", sequence: 0n, state: { Active: null } };
function fixture() {
  let epoch = 0;
  const keys = new Map<string, CryptoKey>();
  const writes = new Map<string, string | undefined>();
  const store: DeviceKeys = {
    epoch: async () => epoch,
    get: async (binding) => keys.get(binding),
    put: async (binding, key, expected, _signal, writeId) => { if (epoch !== expected) return false; keys.set(binding, key); writes.set(binding,writeId); return true; },
    forget: async () => { epoch++; keys.clear(); writes.clear(); },
    removeVault: async (vault,expected) => { if (expected !== undefined && epoch !== expected) return; for (const id of keys.keys()) if (bindingTargetsVault(id, vault)) keys.delete(id); },
    rollback: async (binding,writeId) => { if (writes.get(binding) === writeId) { keys.delete(binding); writes.delete(binding); } },
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

const memberPrincipal = Principal.selfAuthenticating(new Uint8Array([42]));
function sharing() {
  const f = fixture();
  let grant: "Editor" | "Viewer" | undefined = "Editor";
  let owner = principal;
  const derive = vi.fn(async () => ({
    Ok: { input: [], public_key: [], encrypted_key: [] },
  }));
  const access = vi.fn(async (id: Uint8Array | number[]) =>
    grant
      ? { Ok: { owner, role: { [grant]: null }, header: { ...h, id } } }
      : { Err: { Unauthorized: null } },
  );
  Object.assign(f.actor, {
    get_vault_access: access,
    shared_derive_vault_key: derive,
    shared_mutate: vi.fn(async () => ({ Ok: { Done: null } })),
  });
  const member = () =>
    new VaultClient({
      actor: f.actor,
      identity: { getPrincipal: () => memberPrincipal } as any,
      canister: principal.toText(),
      local: true,
      deviceKeys: f.store,
    });
  return {
    ...f,
    member,
    derive,
    access,
    grant: (next: typeof grant) => {
      grant = next;
    },
    owner: (next: Principal) => {
      owner = next;
    },
  };
}
const vaultId = new Uint8Array(h.id);
it("opens a member's first key without using the member's funding balance", async () => {
  const f = sharing(),
    member = f.member();
  const authorize = vi.fn(async () => {
    throw Error("caller balance");
  });
  await member.openAccess(vaultId, {
    allowDerive: false,
    beforeDerive: authorize,
  });
  expect(authorize).not.toHaveBeenCalled();
  expect(f.derive).toHaveBeenCalledOnce();
  expect(f.actor.derive_vault_key).not.toHaveBeenCalled();
});
it("deletes a denied Vault's saved key before a fresh view reads the cache", async () => {
  const f = sharing(),
    first = f.member();
  await first.openAccess(vaultId);
  await first.openAccess(new Uint8Array(16).fill(7));
  first.destroy();
  const get = vi.spyOn(f.store, "get");
  f.grant(undefined);
  await expect(f.member().openAccess(vaultId)).rejects.toThrow("Unauthorized");
  expect(get).not.toHaveBeenCalled();
  expect(f.keys.size).toBe(1);
});
it("invalidates a warm handle when access is revoked during its lookup", async () => {
  const f = sharing(),
    member = f.member();
  await member.openAccess(vaultId);
  member.session.lock();
  const get = f.store.get;
  f.store.get = async (...args) => {
    const key = await get(...args);
    f.grant(undefined);
    return key;
  };
  await expect(member.openAccess(vaultId)).rejects.toThrow("Unauthorized");
  expect(member.session.root).toBeUndefined();
  expect(f.keys.size).toBe(0);
});
it("detects revocation during a cache write and discards the handle", async () => {
  const f = sharing(),
    member = f.member(),
    put = f.store.put;
  f.store.put = async (...args) => {
    const saved = await put(...args);
    f.grant(undefined);
    return saved;
  };
  await expect(member.openAccess(vaultId)).rejects.toThrow("Unauthorized");
  expect(member.session.root).toBeUndefined();
  expect(f.keys.size).toBe(0);
});
it("does not leave a late cache write after the client is destroyed", async () => {
  const f = sharing(),
    member = f.member(),
    put = f.store.put;
  f.store.put = async (...args) => {
    member.destroy();
    return put(...args);
  };
  await expect(member.openAccess(vaultId)).rejects.toThrow("Locked");
  expect(member.session.root).toBeUndefined();
  expect(f.keys.size).toBe(0);
});
it("applies a downgrade during warm lookup and preserves owner-only rename", async () => {
  const f = sharing(),
    member = f.member();
  await member.openAccess(vaultId);
  await expect(member.renameVault(h, "Renamed")).rejects.toThrow(
    "Unauthorized",
  );
  member.session.lock();
  const get = f.store.get;
  f.store.get = async (...args) => {
    const key = await get(...args);
    f.grant("Viewer");
    return key;
  };
  await member.openAccess(vaultId);
  expect(member.accessRole).toBe("Viewer");
  expect(f.derive).toHaveBeenCalledOnce();
  await expect(
    member.mutate({
      RenameVault: { vault: vaultId, name: "Renamed", expected_sequence: 0n },
    }),
  ).rejects.toThrow("Unauthorized");
  expect(f.actor.shared_mutate).not.toHaveBeenCalled();
});
it("binds a warm handle to the stored owner and fresh public key", async () => {
  const f = sharing(),
    member = f.member();
  await member.openAccess(vaultId);
  member.session.lock();
  f.owner(Principal.selfAuthenticating(new Uint8Array([23])));
  await member.openAccess(vaultId);
  expect(f.derive).toHaveBeenCalledTimes(2);
});

it("uses separate caller/canister stores with the same owner context for a shared key", async () => {
  const f = sharing();
  const owner = f.create(),
    member = f.member();
  const epoch = vi
    .spyOn(BrowserDeviceKeys.prototype, "epoch")
    .mockResolvedValue(0);
  const get = vi
    .spyOn(BrowserDeviceKeys.prototype, "get")
    .mockResolvedValue(undefined);
  const put = vi
    .spyOn(BrowserDeviceKeys.prototype, "put")
    .mockResolvedValue(true);
  try {
    for (const identity of [owner.identity, member.identity]) {
      const client = new VaultClient({
        actor: f.actor,
        identity,
        canister: principal.toText(),
        local: true,
      });
      if (identity === owner.identity) await client.open(h);
      else await client.openAccess(vaultId);
      client.destroy();
    }
    expect(put.mock.contexts[0]).toMatchObject({
      scope: principal.toText() + ":" + principal.toText(),
    });
    expect(put.mock.contexts[1]).toMatchObject({
      scope: principal.toText() + ":" + memberPrincipal.toText(),
    });
    expect(put.mock.calls[0][0]).toEqual(put.mock.calls[1][0]);
  } finally {
    epoch.mockRestore();
    get.mockRestore();
    put.mockRestore();
  }
});
it("does not publish a shared key when a sibling forgets during persistence", async () => {
  const f = sharing(),
    member = f.member(),
    put = f.store.put;
  f.store.put = async (...args) => {
    await f.store.forget();
    return put(...args);
  };
  await expect(member.openAccess(vaultId)).rejects.toThrow("Locked");
  expect(member.session.root).toBeUndefined();
  expect(f.keys.size).toBe(0);
});
it("keeps the current shared Vault open while managing another owned Vault", async () => {
  const f = sharing(),
    member = f.member();
  const target = new Uint8Array(16).fill(7);
  const list = vi.fn(async () => ({ Ok: [] }));
  const mutate = vi.fn(async () => ({ Ok: { Done: null } }));
  Object.assign(f.actor, { list_vault_members: list, mutate });
  await member.openAccess(vaultId);
  const root = member.session.root;
  await member.listMembers(target);
  expect(list).toHaveBeenCalledWith(target);
  await member.renameVault({ ...h, id: target }, "Mine");
  expect(mutate).toHaveBeenCalledWith(
    expect.objectContaining({
      action: {
        RenameVault: {
          vault: target,
          name: "Mine",
          expected_sequence: h.sequence,
        },
      },
    }),
  );
  expect(f.actor.shared_mutate).not.toHaveBeenCalled();
  expect(member.session.root).toBe(root);
});
it("keeps a hidden shared view through one minute and expires at thirty", async () => {
  const f = sharing(),
    member = f.member();
  await member.openAccess(vaultId);
  const clock = vi.spyOn(Date, "now");
  try {
    const start = member.session.lastActivity;
    member.session.visible(true);
    clock.mockReturnValue(start + 60_001);
    member.session.visible(false);
    expect(member.session.root).toBeDefined();
    clock.mockReturnValue(start + 1_800_000);
    member.session.visible(false);
    expect(member.session.root).toBeUndefined();
    expect(f.keys.size).toBe(1);
  } finally {
    clock.mockRestore();
  }
});
it("rejects a retained memory root when the forget broadcast has not arrived yet", async () => {
  const f = sharing(),
    member = f.member();
  await member.openAccess(vaultId);
  await f.store.forget();
  await expect(member.openAccess(vaultId)).rejects.toThrow("Locked");
  expect(member.session.root).toBeUndefined();
});
it("rechecks an owner cache miss before prompting for first-key funding", async () => {
  const f = fixture(),
    owner = f.create();
  const fund = vi.fn(async () => {});
  f.store.get = async () => {
    vi.mocked(f.actor.get_vault_header).mockResolvedValue({
      Err: { NotFound: null },
    });
    return undefined;
  };
  await expect(owner.open(h, { beforeDerive: fund })).rejects.toThrow(
    "TargetChanged",
  );
  expect(fund).not.toHaveBeenCalled();
});

it("blocks owner inline encryption and dispatch after a committed device forget", async () => {
  const f = fixture();
  const owner = f.create();
  const mutate = vi.fn(async () => {
    throw Error("UnexpectedDispatch");
  });
  Object.assign(f.actor, { mutate });
  await owner.open(h);
  await f.store.forget();
  await expect(
    owner.save({ kind: "note", title: "Private" }, new Uint8Array([3])),
  ).rejects.toThrow("Locked");
  expect(mutate).not.toHaveBeenCalled();
  expect(owner.session.root).toBeUndefined();
});

it("withholds plaintext after a sibling forgets during a shared chunk read", async () => {
  const f = sharing(),
    member = f.member();
  await member.openAccess(vaultId);
  const object = new Uint8Array(16).fill(9);
  const encrypted = await encryptDocumentV3(
    member.session.root!,
    {
      owner: principal.toText(),
      canister: principal.toText(),
      vault: vaultId,
      nonce: new Uint8Array(h.nonce),
      key_name: h.key_name,
    },
    object,
    1n,
    { kind: "note", title: "Private" },
    new Uint8Array([3]),
  );
  Object.assign(f.actor, {
    shared_get_chunk: async () => {
      await f.store.forget();
      return { Ok: encrypted.chunks[0] };
    },
  });
  await expect(
    member.read({
      vault: vaultId,
      object,
      revision: 1n,
      sequence: 1n,
      plain_size: 1n,
      manifest: encrypted.manifest,
      chunk_hashes: encrypted.hashes,
      deleted: false,
    }),
  ).rejects.toThrow("Locked");
  expect(member.session.root).toBeUndefined();
});

it.each(["items", "refreshHeader"] as const)(
  "retains a saved handle after %s on a closed client",
  async (method) => {
    const f = sharing(),
      member = f.member();
    await member.openAccess(vaultId);
    member.session.lock();
    f.access.mockClear();
    await expect(member[method]()).rejects.toThrow("Locked");
    expect(f.access).not.toHaveBeenCalled();
    expect(f.keys.size).toBe(1);
    await member.openAccess(vaultId);
    expect(f.derive).toHaveBeenCalledOnce();
  },
);

it.each([
  { forget: true, denied: false },
  { forget: false, denied: false },
  { forget: true, denied: true },
  { forget: false, denied: true },
])(
  "retains a newer cache write when an earlier response fails ($forget, $denied)",
  async ({ forget, denied }) => {
    const f = sharing(),
      first = f.member(),
      second = f.member();
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => {
      started = resolve;
    });
    let finish!: () => void;
    const finalResponse = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const put = f.store.put;
    f.store.put = async (...args) => {
      f.store.put = put;
      const stored = await put(...args);
      f.access.mockImplementationOnce(async () => {
        started();
        await finalResponse;
        if (denied) return { Err: { Unauthorized: null } };
        throw Error("LostReply");
      });
      return stored;
    };
    const firstOpen = first.openAccess(vaultId);
    await waiting;
    if (forget) await f.store.forget();
    else vi.spyOn(f.store, "get").mockResolvedValueOnce(undefined);
    await second.openAccess(vaultId);
    expect(second.deviceKeyStatus).toBe("saved");
    finish();
    await expect(firstOpen).rejects.toThrow();
    expect(f.keys.size).toBe(1);
    await f.member().openAccess(vaultId);
    expect(f.derive).toHaveBeenCalledTimes(2);
  },
);

it("fences a direct retry of an ambiguous document write after sibling forget", async () => {
  const f = fixture(),
    client = f.create();
  const mutate = vi.fn(async () => {
    throw Error("LostReply");
  });
  Object.assign(f.actor, { mutate });
  await client.open(h);
  await expect(
    client.save({ kind: "note", title: "Private" }, new Uint8Array([1])),
  ).rejects.toThrow("LostReply");
  await f.store.forget();
  await expect(client.retryMutation()).rejects.toThrow("Locked");
  expect(mutate).toHaveBeenCalledOnce();
  expect(client.session.root).toBeUndefined();
});
