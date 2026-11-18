import { describe, expect, it, vi } from "vitest";
import { IDL } from "@icp-sdk/core/candid";
import { idlFactory } from "@kinic/vault-candid";
import { Principal } from "@icp-sdk/core/principal";
import { importKey } from "@kinic/vault-crypto";
import { contextInput } from "@kinic/vault-crypto/context";
import { hash } from "@kinic/vault-crypto/documents";
import type { Header, VaultActor, Action, Revision } from "../src/contracts.ts";
vi.mock("@kinic/vault-crypto/context", async (load) => {
  const actual =
    await load<typeof import("@kinic/vault-crypto/context")>();
  return {
    ...actual,
    verifiedRoot: async () => importKey(new Uint8Array(32).fill(8)),
  };
});
import { VaultClient } from "../src/api.ts";
const owner = Principal.fromText("rrkah-fqaaa-aaaaa-aaaaq-cai");
const id = new Uint8Array(16).fill(1);
const header = (): Header => ({
  id: new Uint8Array(id),
  nonce: new Uint8Array(32).fill(2),
  public_key: new Uint8Array(96).fill(3),
  state: { Active: null },
  key_name: "test_key_1",
  sequence: 0n,
});
function setup(loseResponse = true) {
  let h = header();
  let begin: any;
  let chunk: Uint8Array;
  let lost = loseResponse;
  const calls: any[] = [];
  const actor = {
    list_vaults: vi.fn(async () => ({ Ok: [h] })),
    create_vault: vi.fn(async (req: any) => ({ Ok: h })),
    get_vault_header: vi.fn(async () => ({ Ok: h })),
    derive_vault_key: vi.fn(async () => ({
      Ok: { input: [], public_key: [], encrypted_key: [] },
    })),
    mutate: vi.fn(async (m: any) => {
      calls.push(structuredClone(m));
      const a: Action = m.action;
      if ("SaveInline" in a) {
        begin = a.SaveInline.request;
        chunk = new Uint8Array(a.SaveInline.bytes);
        if (lost) {
          lost = false;
          throw Error("network");
        }
      }
      if ("BeginRevision" in a) {
        begin = a.BeginRevision;
        return {
          Ok: { Upload: { id: begin.operation, expires: 0n, revision: 1n } },
        };
      }
      if ("PutChunk" in a) {
        chunk = new Uint8Array(a.PutChunk.bytes);
        if (lost) {
          lost = false;
          throw Error("network");
        }
        return { Ok: { Done: null } };
      }
      if ("CommitRevision" in a || "SaveInline" in a)
        return {
          Ok: {
            Revision: {
              vault: id,
              object: begin.object,
              revision: 1n,
              sequence: 1n,
              plain_size: begin.plain_size,
              deleted: false,
              manifest: begin.manifest,
              chunk_hashes: begin.chunk_hashes,
            },
          },
        };
      if ("CancelUpload" in a) return { Ok: { Progress: true } };
      return { Ok: { Done: null } };
    }),
    list_objects: vi.fn(async () => ({ Ok: { entries: [], next: [] } })),
    list_history: vi.fn(async () => ({ Ok: { entries: [], next: [] } })),
    get_chunk: vi.fn(async () => ({ Ok: chunk })),
    get_manifest: vi.fn(async () => ({ Err: { NotFound: null } })),
    get_upload_status: vi.fn(async () => ({ Ok: { Absent: null } })),
  } as unknown as VaultActor;
  const client = new VaultClient({
    actor,
    identity: { getPrincipal: () => owner } as any,
    canister: owner.toText(),
    local: true,
  });
  return {
    client,
    actor,
    calls,
    change: (next: Header) => {
      h = next;
    },
  };
}
describe("II-only Vault client", () => {
  it("keeps the exact creation operation on lost reply", async () => {
    const { client, actor } = setup();
    let first: any;
    vi.mocked(actor.create_vault).mockImplementationOnce(async (request) => {
      first = structuredClone(request);
      throw Error("network");
    });
    await expect(client.create()).rejects.toThrow("network");
    await client.create();
    expect(actor.create_vault).toHaveBeenLastCalledWith(first);
  });
  it("retries identical ciphertext and operation after a lost inline reply, then reads it", async () => {
    const { client, calls } = setup();
    await client.open(header());
    await expect(
      client.save(
        { kind: "note", title: "title" },
        new TextEncoder().encode("hello"),
      ),
    ).rejects.toThrow("network");
    expect(client.hasPendingSave).toBe(true);
    const revision = await client.resumeSave();
    expect(calls[0]).toEqual(calls[1]);
    const read = await client.read(revision);
    expect(new TextDecoder().decode(read.plaintext)).toBe("hello");
  });
  it("locks on context or pinned key change, including empty vault", async () => {
    const { client, change } = setup();
    const h = header();
    await client.open(h);
    h.nonce[0] = 9;
    const altered = header();
    altered.nonce[0] = 9;
    change(altered);
    await expect(client.items()).rejects.toThrow("TargetChanged");
    expect(client.session.root).toBeUndefined();
  });
  it("rejects changed operation while unknown reply awaits exact retry", async () => {
    const { client } = setup();
    await client.open(header());
    await expect(
      client.save({ kind: "note", title: "x" }, new Uint8Array([1])),
    ).rejects.toThrow("network");
    await expect(client.mutate({ Collect: null })).rejects.toThrow(
      "ResolvePendingMutation",
    );
  });
  it("fences a late key reply after lock", async () => {
    const { client, actor } = setup();
    let resolve!: (value: any) => void;
    vi.mocked(actor.derive_vault_key).mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const pending = client.open(header());
    await vi.waitFor(() => expect(resolve).toBeDefined());
    client.session.lock();
    resolve({ Ok: { input: [], public_key: [], encrypted_key: [] } });
    await expect(pending).rejects.toThrow("Locked");
    expect(client.session.root).toBeUndefined();
  });
});
it("retries the same cleanup batch after a lost reply and uses a fresh ID for the next batch", async () => {
  const { client, actor } = setup();
  const calls: any[] = [];
  let n = 0;
  vi.mocked(actor.mutate).mockImplementation(async (m) => {
    calls.push(structuredClone(m));
    n++;
    if (n === 1) throw Error("lost");
    return { Ok: { Progress: n === 3 } };
  });
  const upload = new Uint8Array(16).fill(6);
  await expect(client.cancelUpload(id, upload)).rejects.toThrow("lost");
  await client.cancelUpload(id, upload);
  expect(calls[0]).toEqual(calls[1]);
  expect(calls[2].operation).not.toEqual(calls[1].operation);
  expect(calls[2].action).toEqual(calls[1].action);
});
it("clears the root, encrypted job and pending operation on lock", async () => {
  const { client } = setup();
  await client.open(header());
  await expect(
    client.save({ kind: "note", title: "x" }, new Uint8Array([1])),
  ).rejects.toThrow("network");
  client.session.lock();
  expect(client.session.root).toBeUndefined();
  expect(client.hasPendingSave).toBe(false);
  await expect(client.retryMutation()).rejects.toThrow("NoPendingMutation");
});
it("keeps the operation and transport public key after a lost key response", async () => {
  const { client, actor } = setup();
  let first: unknown;
  vi.mocked(actor.derive_vault_key).mockImplementationOnce(async (request) => {
    first = structuredClone(request);
    throw Error("lost");
  });
  await expect(client.open(header())).rejects.toThrow("lost");
  await client.open(header());
  expect(actor.derive_vault_key).toHaveBeenLastCalledWith(first);
});
it("replays a lost commit using the same operation and encrypted body", async () => {
  const { client, actor, calls } = setup();
  const original = vi.mocked(actor.mutate).getMockImplementation()!;
  let lostCommit = true;
  vi.mocked(actor.mutate).mockImplementation(async (m) => {
    const result = await original(m);
    if ("CommitRevision" in m.action && lostCommit) {
      lostCommit = false;
      throw Error("commit lost");
    }
    return result;
  });
  await client.open(header());
  await expect(
    client.save({ kind: "attachment", title: "test" }, new Uint8Array(256 * 1024 + 1)),
  ).rejects.toThrow("network");
  await expect(client.resumeSave()).rejects.toThrow("commit lost");
  await client.resumeSave();
  const commits = calls.filter((x) => "CommitRevision" in x.action);
  expect(commits).toHaveLength(2);
  expect(commits[0]).toEqual(commits[1]);
});
it("rejects anonymous identities", () => {
  expect(
    () =>
      new VaultClient({
        actor: {} as VaultActor,
        identity: { getPrincipal: () => Principal.anonymous() } as any,
        canister: owner.toText(),
        local: true,
      }),
  ).toThrow("Unauthorized");
});
it("clears an idle root and fences its existing ticket", async () => {
  const { client } = setup();
  await client.open(header());
  const ticket = client.session.capture();
  client.session.expire(client.session.lastActivity + 300000);
  expect(client.session.root).toBeUndefined();
  expect(() => client.session.check(ticket)).toThrow("Locked");
});
it("uses current revision in permanent purge and refuses another vault", async () => {
  const { client, calls } = setup();
  await client.open(header());
  const revision = {
    vault: id,
    object: new Uint8Array(16).fill(7),
    revision: 4n,
    sequence: 4n,
    plain_size: 0n,
    deleted: false,
    manifest: new Uint8Array(),
    chunk_hashes: [],
  };
  await client.purgeObject(revision);
  expect(calls.at(-1).action).toEqual({
    PurgeObject: { vault: id, object: revision.object, expected_revision: 4n },
  });
  await expect(
    client.purgeObject({ ...revision, vault: new Uint8Array(16).fill(8) }),
  ).rejects.toThrow("TargetChanged");
});
it("reports no collect work as a normal outcome", async () => {
  const { client, actor } = setup();
  vi.mocked(actor.mutate).mockResolvedValueOnce({ Err: { NotFound: null } });
  await expect(client.collect()).resolves.toBeUndefined();
});
it("prevents a second save while the first is preparing", async () => {
  const { client, actor } = setup();
  await client.open(header());
  let resolve!: (value: any) => void;
  vi.mocked(actor.get_vault_header).mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const first = client.save({ kind: "attachment", title: "a" }, new Uint8Array(256 * 1024 + 1));
  await vi.waitFor(() => expect(resolve).toBeDefined());
  await expect(
    client.save({ kind: "note", title: "b" }, new Uint8Array([2])),
  ).rejects.toThrow("SavePending");
  client.session.lock();
  resolve({ Ok: header() });
  await expect(first).rejects.toThrow("Locked");
});
it("does not permit use of a destroyed client", async () => {
  const { client } = setup();
  client.destroy();
  await expect(client.listVaults()).rejects.toThrow("NotSignedIn");
  await expect(client.create()).rejects.toThrow("NotSignedIn");
});
it("clears a failed rootless key attempt when creating and opening another vault", async () => {
  const { client, actor, change } = setup();
  vi.mocked(actor.derive_vault_key).mockRejectedValueOnce(Error("key lost"));
  await expect(client.open(header())).rejects.toThrow("key lost");
  vi.mocked(actor.create_vault).mockImplementationOnce(async (request) => {
    const h = { ...header(), id: new Uint8Array(16).fill(8) };
    change(h);
    return { Ok: h };
  });
  const created = await client.create();
  await expect(client.open(created)).resolves.toBeUndefined();
  expect(client.session.root).toBeDefined();
});
it("fences an outstanding open when creation selects a different vault", async () => {
  const { client, actor, change } = setup();
  let resolve!: (value: any) => void;
  vi.mocked(actor.derive_vault_key).mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const old = client.open(header());
  await vi.waitFor(() => expect(resolve).toBeDefined());
  vi.mocked(actor.create_vault).mockImplementationOnce(async (request) => {
    const h = { ...header(), id: new Uint8Array(16).fill(8) };
    change(h);
    return { Ok: h };
  });
  const created = await client.create();
  resolve({ Ok: { input: [], public_key: [], encrypted_key: [] } });
  await expect(old).rejects.toThrow("Locked");
  await expect(client.open(created)).resolves.toBeUndefined();
  expect(client.header?.id).toEqual(created.id);
});
it.each(["deleteObject", "purgeObject"] as const)(
  "fences %s if locked between context resolution and dispatch",
  async (method) => {
    const { client, actor } = setup();
    await client.open(header());
    const revision = {
      vault: id,
      object: new Uint8Array(16).fill(7),
      revision: 4n,
      sequence: 4n,
      plain_size: 0n,
      deleted: false,
      manifest: new Uint8Array(),
      chunk_hashes: [],
    };
    const checked = (client as any).checkedContext.bind(client);
    vi.spyOn(client as any, "checkedContext").mockImplementation(async () => {
      const context = await checked();
      queueMicrotask(() => client.session.lock());
      return context;
    });
    const pending = client[method](revision);
    await expect(pending).rejects.toThrow("Locked");
    expect(actor.mutate).not.toHaveBeenCalled();
  },
);
it("retries the same creation after switching away from its unresolved attempt", async () => {
  const { client, actor, change } = setup();
  let first: any;
  vi.mocked(actor.create_vault).mockImplementationOnce(async (r) => {
    first = structuredClone(r);
    throw Error("lost");
  });
  await expect(client.create()).rejects.toThrow("lost");
  await client.open(header());
  vi.mocked(actor.create_vault).mockImplementationOnce(async (r) => {
    const h = { ...header(), id: new Uint8Array(16).fill(8) };
    change(h);
    return { Ok: h };
  });
  const created = await client.create();
  expect(actor.create_vault).toHaveBeenLastCalledWith(first);
  expect(client.session.root).toBeUndefined();
  await expect(client.open(created)).resolves.toBeUndefined();
});
it.each(["items", "read", "history", "quota"] as const)(
  "fences %s before its first read when context validation becomes stale",
  async (method) => {
    const { client, actor } = setup();
    await client.open(header());
    const a = actor as any;
    a.list_objects = vi.fn();
    a.get_chunk = vi.fn();
    a.list_history = vi.fn();
    a.get_quota = vi.fn();
    const checked = (client as any).checkedContext.bind(client);
    vi.spyOn(client as any, "checkedContext").mockImplementation(async () => {
      const c = await checked();
      queueMicrotask(() => client.session.lock());
      return c;
    });
    const revision = {
      vault: id,
      object: new Uint8Array(16),
      revision: 1n,
      sequence: 1n,
      plain_size: 0n,
      deleted: false,
      manifest: new Uint8Array(),
      chunk_hashes: [new Uint8Array(32)],
    };
    const promise =
      method === "read" || method === "history"
        ? client[method](revision)
        : client[method]();
    await expect(promise).rejects.toThrow("Locked");
    expect(a.list_objects).not.toHaveBeenCalled();
    expect(a.get_chunk).not.toHaveBeenCalled();
    expect(a.list_history).not.toHaveBeenCalled();
    expect(a.get_quota).not.toHaveBeenCalled();
  },
);

describe("open authoritative invalidation", () => {
  it.each(["NotFound", "Conflict"] as const)(
    "closes an existing same-Vault root on initial %s",
    async (kind) => {
      const { client, actor } = setup();
      await client.open(header());
      vi.mocked(actor.get_vault_header).mockResolvedValueOnce({
        Err: { [kind]: null },
      } as never);
      await expect(client.open(header())).rejects.toThrow("TargetChanged");
      expect(client.session.root).toBeUndefined();
    },
  );
  it.each(["nonce", "public_key", "state", "invalid_nonce", "gone"])(
    "invalidates the post-key attempt on %s",
    async (field) => {
      const { client, actor } = setup();
      const changed = header();
      if (field === "nonce") changed.nonce = new Uint8Array(32).fill(9);
      if (field === "public_key")
        changed.public_key = new Uint8Array(96).fill(9);
      if (field === "state") changed.state = { Deleting: null };
      if (field === "invalid_nonce") changed.nonce = new Uint8Array(1);
      vi.mocked(actor.get_vault_header)
        .mockResolvedValueOnce({ Ok: header() })
        .mockResolvedValueOnce(
          field === "gone" ? { Err: { NotFound: null } } : { Ok: changed },
        );
      const ticket = client.session.capture();
      await expect(client.open(header())).rejects.toThrow("TargetChanged");
      expect(client.session.capture()).toBeGreaterThan(ticket + 1);
      const attempt = vi.mocked(actor.derive_vault_key).mock.calls[0][0];
      await client.open(header());
      expect(
        vi.mocked(actor.derive_vault_key).mock.calls[1][0].operation,
      ).not.toEqual(attempt.operation);
    },
  );
  it("does not let an old NotFound response close a newer selection", async () => {
    const { client, actor } = setup();
    let reply!: (value: { Err: { NotFound: null } }) => void;
    vi.mocked(actor.get_vault_header).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          reply = resolve;
        }),
    );
    const old = client.open(header());
    const other = { ...header(), id: new Uint8Array(16).fill(7) };
    vi.mocked(actor.get_vault_header).mockResolvedValue({ Ok: other });
    await client.open(other);
    const root = client.session.root;
    reply({ Err: { NotFound: null } });
    await expect(old).rejects.toThrow("Locked");
    expect(client.session.root).toBe(root);
  });
});

it("retries only a pending Collect and gives each delivered batch a fresh ID", async () => {
  const { client, actor } = setup();
  vi.mocked(actor.mutate).mockRejectedValueOnce(Error("LostResponse"));
  await expect(client.collect()).rejects.toThrow("LostResponse");
  const first = vi.mocked(actor.mutate).mock.calls[0][0];
  await client.collect();
  expect(actor.mutate).toHaveBeenLastCalledWith(first);
  await client.collect();
  expect(vi.mocked(actor.mutate).mock.calls[2][0].operation).not.toEqual(
    first.operation,
  );
  vi.mocked(actor.mutate).mockRejectedValueOnce(Error("LostResponse"));
  await expect(client.mutate({ DeleteVault: { vault: id } })).rejects.toThrow(
    "LostResponse",
  );
  const count = vi.mocked(actor.mutate).mock.calls.length;
  await expect(client.collect()).rejects.toThrow("ResolvePendingMutation");
  expect(actor.mutate).toHaveBeenCalledTimes(count);
  client.session.lock();
  await client.collect();
  expect(actor.mutate).toHaveBeenCalledTimes(count + 1);
});

it.each(["lock", "switch", "destroy"])(
  "fences a late Collect on %s without clearing a newer pending retry",
  async (action) => {
    const { client, actor, change } = setup();
    let resolve!: (reply: Awaited<ReturnType<VaultActor["mutate"]>>) => void;
    vi.mocked(actor.mutate).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const late = client.collect();
    if (action === "destroy") client.destroy();
    else if (action === "switch") {
      const next = { ...header(), id: new Uint8Array(16).fill(2) };
      change(next);
      await client.open(next);
    } else client.session.lock();
    if (action !== "destroy") {
      vi.mocked(actor.mutate).mockRejectedValueOnce(Error("LostResponse"));
      await expect(client.collect()).rejects.toThrow("LostResponse");
    }
    resolve({ Ok: { Collected: 1n } });
    await expect(late).rejects.toThrow("Locked");
    if (action === "destroy") {
      await expect(client.collect()).rejects.toThrow("NotSignedIn");
      expect(actor.mutate).toHaveBeenCalledOnce();
    } else {
      await client.collect();
      const calls = vi.mocked(actor.mutate).mock.calls;
      expect(calls[1][0].operation).not.toEqual(calls[0][0].operation);
      expect(calls[2][0]).toEqual(calls[1][0]);
    }
  },
);

type MutationReply = Awaited<ReturnType<VaultActor["mutate"]>>;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

it("rejects concurrent mutation dispatch and keeps a newer flight after old finally", async () => {
  const { client, actor } = setup();
  const oldReply = deferred<MutationReply>();
  vi.mocked(actor.mutate).mockReturnValueOnce(oldReply.promise);
  const old = client.collect();
  await expect(client.collect()).rejects.toThrow("MutationInProgress");
  await expect(client.mutate({ DeleteVault: { vault: id } })).rejects.toThrow(
    "ResolvePendingMutation",
  );
  expect(actor.mutate).toHaveBeenCalledOnce();
  client.session.lock();
  const newReply = deferred<MutationReply>();
  vi.mocked(actor.mutate).mockReturnValueOnce(newReply.promise);
  const current = client.collect();
  oldReply.resolve({ Ok: { Collected: 1n } });
  await expect(old).rejects.toThrow("Locked");
  await expect(client.collect()).rejects.toThrow("MutationInProgress");
  expect(actor.mutate).toHaveBeenCalledTimes(2);
  newReply.resolve({ Ok: { Collected: 2n } });
  await expect(current).resolves.toEqual({ Collected: 2n });
  await expect(client.retryMutation()).rejects.toThrow("NoPendingMutation");
});

it("clears delivered mutation errors and permits a different next request", async () => {
  const { client, actor } = setup();
  vi.mocked(actor.mutate).mockResolvedValueOnce({ Err: { Conflict: null } });
  await expect(client.mutate({ DeleteVault: { vault: id } })).rejects.toThrow(
    "Conflict",
  );
  await expect(client.retryMutation()).rejects.toThrow("NoPendingMutation");
  await expect(client.collect()).resolves.toEqual({ Done: null });
});

it("does not let old save preparation release a newer preparation", async () => {
  const { client, actor } = setup();
  await client.open(header());
  type HeaderReply = Awaited<ReturnType<VaultActor["get_vault_header"]>>;
  const oldHeader = deferred<HeaderReply>();
  vi.mocked(actor.get_vault_header).mockReturnValueOnce(oldHeader.promise);
  const old = client.save({ kind: "attachment", title: "old" }, new Uint8Array(256 * 1024 + 1));
  client.session.lock();
  await client.open(header());
  const newHeader = deferred<HeaderReply>();
  vi.mocked(actor.get_vault_header).mockReturnValueOnce(newHeader.promise);
  const current = client.save(
    { kind: "attachment", title: "new" },
    new Uint8Array(256 * 1024 + 1).fill(2),
  );
  oldHeader.resolve({ Ok: header() });
  await expect(old).rejects.toThrow("Locked");
  await expect(
    client.save({ kind: "note", title: "third" }, new Uint8Array([3])),
  ).rejects.toThrow("SavePending");
  newHeader.resolve({ Ok: header() });
  await expect(current).rejects.toThrow("network");
  expect(client.hasPendingSave).toBe(true);
  const revision = await client.resumeSave();
  const doc = await client.read(revision);
  expect(doc.metadata.title).toBe("new");
  expect(doc.plaintext).toEqual(new Uint8Array(256 * 1024 + 1).fill(2));
});

it("does not let an old save flight release or replace a newer encrypted job", async () => {
  const { client, actor } = setup();
  await client.open(header());
  const original = vi.mocked(actor.mutate).getMockImplementation()!;
  const oldReply = deferred<MutationReply>();
  vi.mocked(actor.mutate).mockReturnValueOnce(oldReply.promise);
  const old = client.save({ kind: "note", title: "old" }, new Uint8Array([1]));
  await vi.waitFor(() => expect(actor.mutate).toHaveBeenCalledOnce());
  client.session.lock();
  await client.open(header());
  const newReply = deferred<MutationReply>();
  vi.mocked(actor.mutate).mockReturnValueOnce(newReply.promise);
  const current = client.save(
    { kind: "note", title: "new" },
    new Uint8Array([2]),
  );
  await vi.waitFor(() => expect(actor.mutate).toHaveBeenCalledTimes(2));
  oldReply.resolve({ Ok: { Done: null } });
  await expect(old).rejects.toThrow("Locked");
  await expect(client.resumeSave()).rejects.toThrow("SaveInProgress");
  await expect(client.cancelSave()).rejects.toThrow("SaveInProgress");
  await expect(
    client.save({ kind: "note", title: "third" }, new Uint8Array([3])),
  ).rejects.toThrow("SavePending");
  await expect(original(vi.mocked(actor.mutate).mock.calls[1][0])).rejects.toThrow("network");
  newReply.reject(Error("network"));
  await expect(current).rejects.toThrow("network");
  const revision = await client.resumeSave();
  const doc = await client.read(revision);
  expect(doc.metadata.title).toBe("new");
  expect(doc.plaintext).toEqual(new Uint8Array([2]));
});

it("retries delete progress exactly and clears delivered cleanup errors", async () => {
  const { client, actor } = setup();
  vi.mocked(actor.mutate)
    .mockRejectedValueOnce(Error("lost"))
    .mockResolvedValueOnce({ Ok: { Progress: false } })
    .mockResolvedValueOnce({ Ok: { Progress: true } });
  await expect(client.deleteVault(id)).rejects.toThrow("lost");
  await expect(client.cancelUpload(id, new Uint8Array(16))).rejects.toThrow(
    "ResolvePendingMutation",
  );
  await client.deleteVault(id);
  const calls = vi.mocked(actor.mutate).mock.calls;
  expect(calls[0][0]).toEqual(calls[1][0]);
  expect(calls[1][0].action).toEqual(calls[2][0].action);
  expect(calls[1][0].operation).not.toEqual(calls[2][0].operation);
  vi.mocked(actor.mutate).mockResolvedValueOnce({ Err: { NotFound: null } });
  await expect(client.deleteVault(id)).rejects.toThrow("NotFound");
  await expect(
    client.cancelUpload(id, new Uint8Array(16)),
  ).resolves.toBeUndefined();
});

it("reconciliation uses the exact operation once and fences locked replies", async () => {
  const { client, actor } = setup();
  let resolve!: (value: any) => void;
  actor.reconcile_purchase = vi.fn(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  ) as any;
  const pending = client.reconcilePurchase(id);
  expect(actor.reconcile_purchase).toHaveBeenCalledWith(id);
  client.session.lock();
  resolve({ Ok: { scanned: 1n } });
  await expect(pending).rejects.toThrow("Locked");
  expect(actor.reconcile_purchase).toHaveBeenCalledTimes(1);
});
it("reconciliation propagates backend errors without retries", async () => {
  const { client, actor } = setup();
  actor.reconcile_purchase = vi.fn(async () => ({
    Err: { NotFound: null },
  })) as any;
  await expect(client.reconcilePurchase(id)).rejects.toThrow("NotFound");
  expect(actor.reconcile_purchase).toHaveBeenCalledTimes(1);
});

it("reconciliation rejects a receipt for a different saved operation", async () => {
  const { client, actor } = setup();
  actor.reconcile_purchase = vi.fn(async () => ({
    Ok: {
      payment: {
        wallet: owner,
        request: { operation: new Uint8Array(16).fill(9) },
      },
      scanned: 1n,
      next: 1n,
      end: 1n,
      can_continue: false,
    },
  })) as any;
  await expect(client.reconcilePurchase(id)).rejects.toThrow("InvalidReceipt");
});


it("excludes another cancellation and resume while cancellation owns the saved job", async () => {
  const { client, actor } = setup();
  await client.open(header());
  await expect(client.save({ kind: "attachment", title: "old" }, new Uint8Array(256*1024+1))).rejects.toThrow("network");
  type Status = Awaited<ReturnType<VaultActor["get_upload_status"]>>;
  const status = deferred<Status>();
  vi.mocked(actor.get_upload_status).mockReturnValue(status.promise);
  const cancelling = client.cancelSave();
  await vi.waitFor(() => expect(actor.get_upload_status).toHaveBeenCalledOnce());
  const second = expect(client.cancelSave()).rejects.toThrow("SaveInProgress");
  const resumed = expect(client.resumeSave()).rejects.toThrow("SaveInProgress");
  const saved = expect(client.save({ kind: "note", title: "new" }, new Uint8Array([2]))).rejects.toThrow("SavePending");
  status.resolve({ Ok: { Absent: null } });
  await Promise.all([cancelling, second, resumed, saved]);
  expect(client.hasPendingSave).toBe(false);
  const revision = await client.save({ kind: "note", title: "new" }, new Uint8Array([2]));
  const doc = await client.read(revision);
  expect(doc.metadata.title).toBe("new");
});

it("retains the encrypted save when cancellation status is unavailable", async () => {
  const { client, actor } = setup();
  await client.open(header());
  await expect(client.save({ kind: "attachment", title: "keep" }, new Uint8Array(256*1024+1))).rejects.toThrow("network");
  vi.mocked(actor.get_upload_status).mockRejectedValue(Error("status unavailable"));
  await expect(client.cancelSave()).rejects.toThrow("status unavailable");
  expect(client.hasPendingSave).toBe(true);
  const revision = await client.resumeSave();
  const doc = await client.read(revision);
  expect(doc.metadata.title).toBe("keep");
});

it("fences an old cancellation after lock without replacing a new pending save", async () => {
  const { client, actor } = setup();
  await client.open(header());
  await expect(client.save({ kind: "attachment", title: "old" }, new Uint8Array(256*1024+1))).rejects.toThrow("network");
  type Status = Awaited<ReturnType<VaultActor["get_upload_status"]>>;
  const status = deferred<Status>();
  vi.mocked(actor.get_upload_status).mockReturnValue(status.promise);
  const cancelling = client.cancelSave();
  await vi.waitFor(() => expect(actor.get_upload_status).toHaveBeenCalledOnce());
  client.session.lock();
  await client.open(header());
  vi.mocked(actor.mutate).mockRejectedValueOnce(Error("new lost"));
  await expect(client.save({ kind: "note", title: "new" }, new Uint8Array([2]))).rejects.toThrow("new lost");
  status.resolve({ Ok: { Absent: null } });
  await expect(cancelling).rejects.toThrow("Locked");
  const revision = await client.resumeSave();
  const doc = await client.read(revision);
  expect(doc.metadata.title).toBe("new");
});


it("releases only the completed cancellation job after a lost final reply", async () => {
  const { client, actor, calls } = setup();
  await client.open(header());
  await expect(client.save({ kind: "attachment", title: "old" }, new Uint8Array(256*1024+1))).rejects.toThrow("network");
  const request = calls[0].action.BeginRevision;
  vi.mocked(actor.get_upload_status)
    .mockResolvedValueOnce({ Ok: { Pending: { request, cancel_job: [] } } } as never)
    .mockResolvedValue({ Ok: { Cancelled: null } });
  const original = vi.mocked(actor.mutate).getMockImplementation()!;
  let lost = false;
  vi.mocked(actor.mutate).mockImplementation(async (mutation) => {
    if ("CancelUpload" in mutation.action && !lost) {
      lost = true;
      throw Error("final cancellation lost");
    }
    return original(mutation);
  });
  await expect(client.cancelSave()).rejects.toThrow("final cancellation lost");
  await client.cancelSave();
  expect(client.hasPendingSave).toBe(false);
  await expect(client.cancelUpload(id, new Uint8Array(16).fill(9))).resolves.toBeUndefined();
});

import { encryptDocumentV3 } from "@kinic/vault-crypto/documents";
import type { Item } from "../src/api.ts";
async function largeSearchFixture(count = 5) {
  const s = setup();
  await s.client.open(header());
  const items: Item[] = [];
  const ciphertext = new Map<number, Uint8Array[]>();
  for (let i = 0; i < count; i++) {
    const kind =
      count === 5 && i === 2
        ? "credential"
        : count === 5 && i === 3
          ? "attachment"
          : "note";
    const object = new Uint8Array(16).fill(i + 1);
    const metadata = { kind, title: `title ${i}` } as Item["metadata"];
    const doc = await encryptDocumentV3(
      s.client.session.root!,
      {
        canister: owner.toText(),
        owner: owner.toText(),
        vault: id,
        nonce: new Uint8Array(32).fill(2),
        key_name: "test_key_1",
      },
      object,
      1n,
      metadata,
      new TextEncoder().encode(i === 1 ? "other" : "SeCrEt body"),
    );
    items.push({
      metadata,
      revision: {
        vault: id,
        object,
        revision: 1n,
        sequence: BigInt(i),
        plain_size: 11n,
        deleted: count === 5 && i === 4,
        manifest: doc.manifest,
        chunk_hashes: doc.hashes,
      },
    });
    ciphertext.set(i + 1, doc.chunks);
  }
  s.actor.list_objects = vi.fn(async () => ({
    Ok: { entries: items.map((x) => x.revision), next: [] },
  })) as unknown as VaultActor["list_objects"];
  s.actor.list_history = vi.fn(async () => ({
    Ok: { entries: [{ ...items.at(-1)!.revision, deleted: false }], next: [] },
  })) as unknown as VaultActor["list_history"];
  vi.mocked(s.actor.get_chunk).mockImplementation(
    async (_vault, object, _revision, index) => ({
      Ok: ciphertext.get(new Uint8Array(object)[0])![index],
    }),
  );
  vi.mocked(s.actor.get_vault_header).mockClear();
  return { ...s, items };
}
it("lists 100 note metadata without reading any content", async () => {
  const { client, actor } = await largeSearchFixture(100);
  const items = await client.items();
  expect(items).toHaveLength(100);
  expect(items[99].metadata.title).toBe("title 99");
  expect(actor.get_chunk).not.toHaveBeenCalled();
  expect(items.some((x) => "searchText" in x)).toBe(false);
  expect(actor.get_vault_header).toHaveBeenCalledOnce();
});
it("accepts a server-assigned creation ID and sends only an operation", async () => {
  const { client, actor } = setup();
  vi.mocked(actor.create_vault).mockResolvedValue({ Ok: header() });
  await expect(client.create()).resolves.toEqual(header());
  expect(Object.keys(vi.mocked(actor.create_vault).mock.calls[0][0])).toEqual([
    "operation",
  ]);
});
it.each([0, 256 * 1024])(
  "saves %i bytes with one update and no pre-save queries after unlock",
  async (size) => {
    const { client, actor, calls } = setup(false);
    await client.open(header());
    vi.mocked(actor.get_vault_header).mockClear();
    vi.mocked(actor.derive_vault_key).mockClear();
    const plain = new Uint8Array(size).fill(11);
    const revision = await client.save(
      { kind: "note", title: "inline" },
      plain,
    );
    expect(actor.mutate).toHaveBeenCalledTimes(1);
    expect(actor.get_vault_header).not.toHaveBeenCalled();
    expect(actor.derive_vault_key).not.toHaveBeenCalled();
    const request = calls[0].action.SaveInline;
    expect(request).toBeDefined();
    expect(request.context_hash).toEqual(
      await hash(
        contextInput({
          canister: owner.toText(),
          owner: owner.toText(),
          vault: id,
          nonce: new Uint8Array(32).fill(2),
          key_name: "test_key_1",
        }),
      ),
    );
    expect(request.bytes.length).toBe(size + 16);
    expect(request.request.chunk_hashes).toHaveLength(1);
    expect(client.hasPendingSave).toBe(false);
    const doc = await client.read(revision);
    expect(doc.plaintext).toEqual(plain);
  },
);
it("retains the byte-identical inline mutation after a committed response is lost", async () => {
  const { client, actor, calls } = setup(false);
  const execute = vi.mocked(actor.mutate).getMockImplementation()!;
  let lose = true;
  vi.mocked(actor.mutate).mockImplementation(async (mutation) => {
    const committed = await execute(mutation);
    if (lose) {
      lose = false;
      throw Error("network");
    }
    return committed;
  });
  await client.open(header());
  vi.mocked(actor.get_vault_header).mockClear();
  await expect(
    client.save({ kind: "note", title: "retry" }, new Uint8Array([1, 2, 3])),
  ).rejects.toThrow("network");
  expect(calls[0].action.SaveInline).toBeDefined();
  await expect(
    client.save({ kind: "note", title: "changed" }, new Uint8Array([9])),
  ).rejects.toThrow("SavePending");
  const revision = await client.resumeSave();
  expect(calls).toHaveLength(2);
  expect(calls[0]).toEqual(calls[1]);
  const mutationType = idlFactory({ IDL })._fields.find(
    ([name]) => name === "mutate",
  )![1].argTypes;
  expect(new Uint8Array(IDL.encode(mutationType, [calls[0]]))).toEqual(
    new Uint8Array(IDL.encode(mutationType, [calls[1]])),
  );
  expect(actor.get_vault_header).not.toHaveBeenCalled();
  expect((await client.read(revision)).plaintext).toEqual(
    new Uint8Array([1, 2, 3]),
  );
});
it("keeps attachments above the inline boundary on the chunked flow", async () => {
  const { client, calls } = setup(false);
  await client.open(header());
  await client.save(
    { kind: "attachment", title: "large" },
    new Uint8Array(256 * 1024 + 1),
  );
  expect(calls.map((c) => Object.keys(c.action)[0])).toEqual([
    "BeginRevision",
    "PutChunk",
    "CommitRevision",
  ]);
});
it.each(["nonce", "invalid_nonce", "key_name", "public_key", "vault"])(
  "rejects locally changed cached %s before inline save",
  async (field) => {
    const { client, actor } = setup(false);
    await client.open(header());
    if (field === "nonce") client.header!.nonce = new Uint8Array(32).fill(9);
    if (field === "invalid_nonce") client.header!.nonce = new Uint8Array(1);
    if (field === "key_name") client.header!.key_name = "other";
    if (field === "public_key")
      client.header!.public_key = new Uint8Array(96).fill(9);
    if (field === "vault") client.header!.id = new Uint8Array(16).fill(9);
    await expect(
      client.save({ kind: "note", title: "changed" }, new Uint8Array([1])),
    ).rejects.toThrow("TargetChanged");
    expect(actor.mutate).not.toHaveBeenCalled();
    expect(client.session.root).toBeUndefined();
  },
);
it.each(["Conflict", "InvalidInput", "QuotaExceeded", "NotFound"])(
  "releases an inline job after delivered %s without cancelling a nonexistent upload",
  async (kind) => {
    const { client, actor } = setup(false);
    await client.open(header());
    vi.mocked(actor.mutate).mockResolvedValueOnce({
      Err: { [kind]: null },
    } as never);
    await expect(
      client.save({ kind: "note", title: "rejected" }, new Uint8Array([1])),
    ).rejects.toThrow(kind);
    expect(client.hasPendingSave).toBe(false);
    expect(actor.get_upload_status).not.toHaveBeenCalled();
    await expect(client.retryMutation()).rejects.toThrow("NoPendingMutation");
    await expect(
      client.save({ kind: "note", title: "corrected" }, new Uint8Array([2])),
    ).resolves.toBeDefined();
  },
);

it("reopens a server-changed immutable context after inline rejection", async () => {
  const { client, actor, change } = setup(false);
  await client.open(header());
  const changed = header();
  changed.nonce = new Uint8Array(32).fill(9);
  change(changed);
  vi.mocked(actor.mutate).mockResolvedValueOnce({
    Err: { InvalidInput: null },
  });
  await expect(
    client.save({ kind: "note", title: "old context" }, new Uint8Array([1])),
  ).rejects.toThrow("InvalidInput");
  expect(client.hasPendingSave).toBe(false);
  await expect(client.refreshHeader()).rejects.toThrow("TargetChanged");
  expect(client.session.root).toBeUndefined();
  await client.open(changed);
  await expect(
    client.save({ kind: "note", title: "new context" }, new Uint8Array([2])),
  ).resolves.toBeDefined();
});
it.each(["Expired", "Storage"])(
  "keeps reconciliation ciphertext on %s after an uncertain inline commit",
  async (kind) => {
    const { client, actor } = setup();
    await client.open(header());
    await expect(
      client.save({ kind: "note", title: "unknown" }, new Uint8Array([1])),
    ).rejects.toThrow("network");
    vi.mocked(actor.mutate).mockResolvedValue({
      Err: { [kind]: null },
    } as never);
    await expect(client.resumeSave()).rejects.toThrow(kind);
    expect(client.hasPendingSave).toBe(true);
    await expect(client.resumeSave()).rejects.toThrow(kind);
    expect(client.hasPendingSave).toBe(true);
  },
);
it.each(["Conflict", "QuotaExceeded", "InvalidInput", "Unauthorized"])(
  "retains a previously ambiguous inline payload across repeated delivered %s",
  async (kind) => {
    const { client, actor } = setup();
    await client.open(header());
    await expect(
      client.save(
        { kind: "note", title: "committed?" },
        new Uint8Array([1, 2, 3]),
      ),
    ).rejects.toThrow("network");
    const original = structuredClone(vi.mocked(actor.mutate).mock.calls[0][0]);
    vi.mocked(actor.mutate).mockResolvedValue({
      Err: { [kind]: null },
    } as never);
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(client.resumeSave()).rejects.toThrow(kind);
      expect(client.hasPendingSave).toBe(true);
      expect(vi.mocked(actor.mutate).mock.lastCall![0]).toEqual(original);
    }
    await expect(client.cancelSave()).rejects.toThrow();
    expect(client.hasPendingSave).toBe(true);
  },
);

function committedInline(actor: VaultActor): Revision {
  const action = vi.mocked(actor.mutate).mock.calls[0][0].action;
  if (!("SaveInline" in action)) throw Error("Expected inline mutation");
  const r = action.SaveInline.request;
  return structuredClone({
    vault: r.vault,
    object: r.object,
    revision: r.expected_revision + 1n,
    sequence: 1n,
    plain_size: r.plain_size,
    manifest: r.manifest,
    chunk_hashes: r.chunk_hashes,
    deleted: false,
  });
}
it.each(["resume", "cancel"])(
  "reconciles the full encrypted revision via %s after receipt collection",
  async (method) => {
    const { client, actor } = setup();
    await client.open(header());
    await expect(
      client.save(
        { kind: "note", title: "committed" },
        new Uint8Array([1, 2, 3]),
      ),
    ).rejects.toThrow("network");
    const committed = committedInline(actor);
    vi.mocked(actor.mutate).mockResolvedValue({ Err: { Conflict: null } });
    vi.mocked(actor.get_manifest).mockResolvedValue({ Ok: committed });
    if (method === "resume")
      expect(await client.resumeSave()).toEqual(committed);
    else
      expect(await client.cancelSave()).toEqual({
        Committed: {
          vault: committed.vault,
          object: committed.object,
          revision: committed.revision,
          sequence: committed.sequence,
        },
      });
    expect(actor.get_manifest).toHaveBeenLastCalledWith(
      committed.vault,
      committed.object,
      1n,
    );
    expect(client.hasPendingSave).toBe(false);
    await expect(client.retryMutation()).rejects.toThrow("NoPendingMutation");
    expect((await client.read(committed)).plaintext).toEqual(
      new Uint8Array([1, 2, 3]),
    );
  },
);
it("resolves the retained mutation when another response is lost but the encrypted revision proves commit", async () => {
  const { client, actor } = setup();
  await client.open(header());
  await expect(
    client.save({ kind: "note", title: "committed" }, new Uint8Array([1])),
  ).rejects.toThrow("network");
  const committed = committedInline(actor);
  vi.mocked(actor.mutate).mockRejectedValue(Error("network again"));
  vi.mocked(actor.get_manifest).mockResolvedValue({ Ok: committed });
  await expect(client.resumeSave()).resolves.toEqual(committed);
  expect(client.hasPendingSave).toBe(false);
  await expect(client.retryMutation()).rejects.toThrow("NoPendingMutation");
});
it.each([
  "vault",
  "object",
  "revision",
  "plain_size",
  "manifest",
  "hash",
  "deleted",
  "sequence",
])(
  "rejects mismatched %s as evidence for an uncertain inline commit",
  async (field) => {
    const { client, actor } = setup();
    await client.open(header());
    await expect(
      client.save({ kind: "note", title: "uncertain" }, new Uint8Array([1])),
    ).rejects.toThrow("network");
    const r = committedInline(actor);
    if (field === "vault") r.vault = new Uint8Array(16).fill(9);
    if (field === "object") r.object = new Uint8Array(16).fill(9);
    if (field === "revision") r.revision++;
    if (field === "plain_size") r.plain_size++;
    if (field === "manifest") r.manifest = new Uint8Array([9]);
    if (field === "hash") r.chunk_hashes = [new Uint8Array(32).fill(9)];
    if (field === "deleted") r.deleted = true;
    if (field === "sequence") r.sequence = 0n;
    vi.mocked(actor.mutate).mockResolvedValue({ Err: { Conflict: null } });
    vi.mocked(actor.get_manifest).mockResolvedValue({ Ok: r });
    await expect(client.resumeSave()).rejects.toThrow("Conflict");
    expect(client.hasPendingSave).toBe(true);
    await expect(client.cancelSave()).rejects.toThrow("InvalidReceipt");
    expect(client.hasPendingSave).toBe(true);
  },
);
it("fences late inline reconciliation after lock while retaining the new session's save", async () => {
  const { client, actor } = setup();
  await client.open(header());
  await expect(
    client.save({ kind: "note", title: "old" }, new Uint8Array([1])),
  ).rejects.toThrow("network");
  const committed = committedInline(actor);
  const proof = deferred<Awaited<ReturnType<VaultActor["get_manifest"]>>>();
  vi.mocked(actor.mutate).mockResolvedValueOnce({ Err: { Conflict: null } });
  vi.mocked(actor.get_manifest).mockReturnValueOnce(proof.promise);
  const old = client.resumeSave();
  await vi.waitFor(() => expect(actor.get_manifest).toHaveBeenCalledOnce());
  client.session.lock();
  await client.open(header());
  vi.mocked(actor.mutate).mockRejectedValueOnce(Error("new lost"));
  await expect(
    client.save({ kind: "note", title: "new" }, new Uint8Array([2])),
  ).rejects.toThrow("new lost");
  proof.resolve({ Ok: committed });
  await expect(old).rejects.toThrow("Locked");
  expect(client.hasPendingSave).toBe(true);
  const r = await client.resumeSave();
  expect((await client.read(r)).metadata.title).toBe("new");
});
it.each(["resume", "cancel"])(
  "preserves an unrelated cancellation flight when %s proof resolves in the same session",
  async (method) => {
    const { client, actor } = setup();
    await client.open(header());
    await expect(
      client.save({ kind: "note", title: "saved" }, new Uint8Array([1])),
    ).rejects.toThrow("network");
    const committed = committedInline(actor);
    vi.mocked(actor.mutate).mockResolvedValueOnce({ Err: { Conflict: null } });
    if (method === "cancel")
      await expect(client.resumeSave()).rejects.toThrow("Conflict");
    vi.mocked(actor.get_manifest).mockClear();
    const proof = deferred<Awaited<ReturnType<VaultActor["get_manifest"]>>>();
    vi.mocked(actor.get_manifest).mockReturnValueOnce(proof.promise);
    const reconciliation =
      method === "resume" ? client.resumeSave() : client.cancelSave();
    await vi.waitFor(() => expect(actor.get_manifest).toHaveBeenCalledOnce());
    const reply = deferred<MutationReply>();
    vi.mocked(actor.mutate).mockReturnValueOnce(reply.promise);
    const upload = new Uint8Array(16).fill(12);
    const cancellation = client.cancelUpload(id, upload);
    const cancellationFailure =
      expect(cancellation).rejects.toThrow("other reply lost");
    const original = structuredClone(vi.mocked(actor.mutate).mock.lastCall![0]);
    proof.resolve({ Ok: committed });
    await reconciliation;
    reply.reject(Error("other reply lost"));
    await cancellationFailure;
    await expect(client.collect()).rejects.toThrow("ResolvePendingMutation");
    vi.mocked(actor.mutate).mockResolvedValueOnce({ Ok: { Progress: true } });
    await client.cancelUpload(id, upload);
    expect(vi.mocked(actor.mutate).mock.lastCall![0]).toEqual(original);
  },
);
it("does not claim an unrelated request already sending before cancellation proof begins", async () => {
  const { client, actor } = setup();
  await client.open(header());
  await expect(
    client.save({ kind: "note", title: "saved" }, new Uint8Array([1])),
  ).rejects.toThrow("network");
  const committed = committedInline(actor);
  vi.mocked(actor.mutate).mockResolvedValueOnce({ Err: { Conflict: null } });
  await expect(client.resumeSave()).rejects.toThrow("Conflict");
  const reply = deferred<MutationReply>();
  vi.mocked(actor.mutate).mockReturnValueOnce(reply.promise);
  const collecting = client.collect();
  const lost = expect(collecting).rejects.toThrow("collect lost");
  const original = structuredClone(vi.mocked(actor.mutate).mock.lastCall![0]);
  const proof = deferred<Awaited<ReturnType<VaultActor["get_manifest"]>>>();
  vi.mocked(actor.get_manifest).mockReturnValueOnce(proof.promise);
  const cancelling = client.cancelSave();
  proof.resolve({ Ok: committed });
  await cancelling;
  reply.reject(Error("collect lost"));
  await lost;
  vi.mocked(actor.mutate).mockResolvedValueOnce({ Ok: { Collected: 1n } });
  await expect(client.retryMutation()).resolves.toEqual({ Collected: 1n });
  expect(vi.mocked(actor.mutate).mock.lastCall![0]).toEqual(original);
});
it.each(["resume", "cancel"])(
  "retains an active retry of the same inline operation when %s proof resolves",
  async (method) => {
    const { client, actor } = setup();
    await client.open(header());
    await expect(
      client.save({ kind: "note", title: "saved" }, new Uint8Array([1])),
    ).rejects.toThrow("network");
    const committed = committedInline(actor);
    const proof = deferred<Awaited<ReturnType<VaultActor["get_manifest"]>>>();
    vi.mocked(actor.get_manifest).mockReturnValueOnce(proof.promise);
    const activeReply = deferred<MutationReply>();
    let active!: ReturnType<VaultClient["retryMutation"]>;
    let reconciliation: Promise<unknown>;
    if (method === "resume") {
      const failedReply = deferred<MutationReply>();
      vi.mocked(actor.mutate)
        .mockReturnValueOnce(failedReply.promise)
        .mockReturnValueOnce(activeReply.promise);
      reconciliation = client.resumeSave();
      // Attach after mutate's await: its finally first restores ambiguous, this
      // reaction starts the same-op flight, then resumeSave captures proof state.
      void failedReply.promise.catch(() => {
        active = client.retryMutation();
      });
      failedReply.reject(Error("retry reply lost"));
    } else {
      vi.mocked(actor.mutate).mockReturnValueOnce(activeReply.promise);
      active = client.retryMutation();
      reconciliation = client.cancelSave();
    }
    await vi.waitFor(() => expect(actor.get_manifest).toHaveBeenCalledOnce());
    expect(active).toBeDefined();
    proof.resolve({ Ok: committed });
    await reconciliation;
    await expect(client.collect()).rejects.toThrow("ResolvePendingMutation");
    activeReply.resolve({ Ok: { Revision: committed } });
    await expect(active).resolves.toEqual({ Revision: committed });
    const collectReply = deferred<MutationReply>();
    vi.mocked(actor.mutate).mockReturnValueOnce(collectReply.promise);
    const collecting = client.collect();
    const lost = expect(collecting).rejects.toThrow("later collect lost");
    const original = structuredClone(vi.mocked(actor.mutate).mock.lastCall![0]);
    collectReply.reject(Error("later collect lost"));
    await lost;
    vi.mocked(actor.mutate).mockResolvedValueOnce({ Ok: { Collected: 1n } });
    await client.retryMutation();
    expect(vi.mocked(actor.mutate).mock.lastCall![0]).toEqual(original);
  },
);

async function searchFixture() {
  const x = setup(false);
  await x.client.open(header());
  const payloads = new Map<string, Uint8Array>();
  const revisions: Revision[] = [];
  for (const [kind, title, body] of [
    ["note", "Alpha", "needle in body"],
    ["note", "Beta", "other text"],
    ["note", "Gamma", "NEEDLE again"],
    ["credential", "Login", "needle password"],
    ["attachment", "File", "needle file"],
  ] as const) {
    const revision = await x.client.save(
      { kind, title },
      new TextEncoder().encode(body),
    );
    revisions.push(revision);
    payloads.set(
      Array.from(revision.object).join(","),
      new Uint8Array(x.calls.at(-1).action.SaveInline.bytes),
    );
  }
  vi.mocked(x.actor.list_objects).mockResolvedValue({
    Ok: { entries: revisions, next: [] },
  });
  vi.mocked(x.actor.get_chunk).mockImplementation(async (_v, object) => ({
    Ok: payloads.get(Array.from(object).join(","))!,
  }));
  vi.mocked(x.actor.get_chunk).mockClear();
  return { ...x, revisions };
}
it("lists metadata without reading any live note bodies", async () => {
  const x = await searchFixture();
  const items = await x.client.items();
  expect(items.map((x) => x.metadata.title)).toEqual([
    "Alpha",
    "Beta",
    "Gamma",
    "Login",
    "File",
  ]);
  expect(x.actor.get_chunk).not.toHaveBeenCalled();
  expect(items.every((x) => !("searchText" in x))).toBe(true);
});
it("rejects a changed Vault context before fetching a note body", async () => {
  const x = await searchFixture();
  const items = await x.client.items();
  vi.mocked(x.actor.get_chunk).mockClear();
  x.change({ ...header(), nonce: new Uint8Array(32).fill(8) });
  await expect(x.client.searchNotes(items, "needle")).rejects.toThrow(
    "Locked",
  );
  expect(x.actor.get_chunk).not.toHaveBeenCalled();
});
it("explicitly searches note bodies with at most two reads and progress, without caching plaintext", async () => {
  const x = await searchFixture();
  const items = await x.client.items();
  let active = 0,
    maximum = 0;
  const original = vi.mocked(x.actor.get_chunk).getMockImplementation()!;
  const finishes: (() => void)[] = [];
  vi.mocked(x.actor.get_chunk).mockImplementation(
    (...args) =>
      new Promise((resolve) => {
        maximum = Math.max(maximum, ++active);
        finishes.push(() => {
          active--;
          void original(...args).then(resolve);
        });
      }),
  );
  const progress = vi.fn();
  const pending = x.client.searchNotes(items, "needle", {
    onProgress: progress,
  });
  await vi.waitFor(() => expect(finishes).toHaveLength(2));
  expect(active).toBe(2);
  finishes.shift()!();
  finishes.shift()!();
  await vi.waitFor(() => expect(finishes).toHaveLength(1));
  finishes.shift()!();
  const matches = await pending;
  expect(maximum).toBe(2);
  expect(matches.map((x) => x.metadata.title)).toEqual(["Alpha", "Gamma"]);
  expect(progress).toHaveBeenLastCalledWith({ completed: 3, total: 3 });
  expect(items.every((x) => !("searchText" in x))).toBe(true);
});
it.each(["cancel", "lock"])(
  "fences a late body search on %s and stops scheduling",
  async (mode) => {
    const x = await searchFixture();
    const items = await x.client.items();
    const finishes: (() => void)[] = [];
    const original = vi.mocked(x.actor.get_chunk).getMockImplementation()!;
    vi.mocked(x.actor.get_chunk).mockImplementation(
      (...args) =>
        new Promise((resolve) => {
          finishes.push(() => {
            void original(...args).then(resolve);
          });
        }),
    );
    vi.mocked(x.actor.get_chunk).mockClear();
    const controller = new AbortController(),
      progress = vi.fn();
    const pending = x.client.searchNotes(items, "needle", {
      signal: controller.signal,
      onProgress: progress,
    });
    const rejected = expect(pending).rejects.toThrow(
      mode === "lock" ? "Locked" : "SearchCancelled",
    );
    await vi.waitFor(() => expect(finishes).toHaveLength(2));
    if (mode === "lock") x.client.session.lock();
    else controller.abort();
    await rejected;
    const updates = progress.mock.calls.length;
    finishes.forEach((f) => f());
    await new Promise((r) => setTimeout(r, 20));
    expect(x.actor.get_chunk).toHaveBeenCalledTimes(2);
    expect(progress).toHaveBeenCalledTimes(updates);
  },
);

it("bounds overlapping cancelled searches to two in-flight reads across the client", async () => {
  const x = await searchFixture();
  const items = await x.client.items();
  const original = vi.mocked(x.actor.get_chunk).getMockImplementation()!;
  const finishes: (() => void)[] = [];
  vi.mocked(x.actor.get_chunk).mockImplementation(
    (...args) =>
      new Promise((resolve) => {
        finishes.push(() => {
          void original(...args).then(resolve);
        });
      }),
  );
  const controller = new AbortController();
  const first = x.client.searchNotes(items, "needle", {
    signal: controller.signal,
  });
  const rejected = expect(first).rejects.toThrow("SearchCancelled");
  await vi.waitFor(() => expect(finishes).toHaveLength(2));
  controller.abort();
  await rejected;
  const second = x.client.searchNotes(items, "needle");
  await Promise.resolve();
  expect(x.actor.get_chunk).toHaveBeenCalledTimes(2);
  finishes.shift()!();
  finishes.shift()!();
  await vi.waitFor(() => expect(finishes).toHaveLength(2));
  finishes.shift()!();
  finishes.shift()!();
  await vi.waitFor(() => expect(finishes).toHaveLength(1));
  finishes.shift()!();
  expect((await second).map((x) => x.metadata.title)).toEqual([
    "Alpha",
    "Gamma",
  ]);
  expect(x.actor.get_chunk).toHaveBeenCalledTimes(5);
});
it("wipes every decrypted search buffer and never reads credential or attachment bodies", async () => {
  const x = await searchFixture();
  const items = await x.client.items();
  const original = x.client.read.bind(x.client),
    buffers: Uint8Array[] = [];
  vi.spyOn(x.client, "read").mockImplementation(async (...args) => {
    const doc = await original(...args);
    buffers.push(doc.plaintext);
    return doc;
  });
  await x.client.searchNotes(items, "needle");
  expect(buffers).toHaveLength(3);
  expect(buffers.every((b) => b.every((v) => v === 0))).toBe(true);
  expect(x.actor.get_chunk).toHaveBeenCalledTimes(3);
});
it("reads only previous metadata for a deleted note list entry", async () => {
  const x = await searchFixture();
  const previous = x.revisions[0];
  const deleted = {
    ...previous,
    revision: 2n,
    manifest: [],
    chunk_hashes: [],
    deleted: true,
  };
  vi.mocked(x.actor.list_objects).mockResolvedValue({
    Ok: { entries: [deleted], next: [] },
  });
  vi.mocked(x.actor.list_history).mockResolvedValue({
    Ok: { entries: [deleted, previous], next: [] },
  });
  const items = await x.client.items();
  expect(items[0].metadata.title).toBe("Alpha");
  expect(items[0].revision.deleted).toBe(true);
  expect(await x.client.searchNotes(items, "needle")).toEqual([]);
  expect(x.actor.get_chunk).not.toHaveBeenCalled();
});

describe("shared Vault access", () => {
  const reader = Principal.selfAuthenticating(new Uint8Array([9]));
  function shared() {
    const { actor, calls } = setup(false);
    let role: "Editor" | "Viewer" | undefined = "Editor";
    const method = <K extends keyof VaultActor>(
      fn: (...args: Parameters<VaultActor[K]>) => ReturnType<VaultActor[K]>,
    ) => vi.fn(fn);
    Object.assign(actor, {
      get_vault_access: method<"get_vault_access">(async () =>
        role
          ? {
              Ok: {
                owner,
                role: role === "Editor" ? { Editor: null } : { Viewer: null },
                header: header(),
              },
            }
          : { Err: { Unauthorized: null } },
      ),
      shared_derive_vault_key: method<"shared_derive_vault_key">((request) =>
        actor.derive_vault_key(request),
      ),
      shared_get_chunk: method<"shared_get_chunk">((...args) =>
        actor.get_chunk(...args),
      ),
      shared_mutate: method<"shared_mutate">((_vault, mutation) =>
        actor.mutate(mutation),
      ),
      shared_get_upload_status: method<"shared_get_upload_status">(
        async () => ({ Ok: { Absent: null } }),
      ),
      shared_get_manifest: method<"shared_get_manifest">((...args) =>
        actor.get_manifest(...args),
      ),
    });
    const member = new VaultClient({
      actor,
      identity: { getPrincipal: () => reader } as any,
      canister: owner.toText(),
      local: true,
    });
    return {
      member,
      actor,
      calls,
      role: (next: typeof role) => {
        role = next;
      },
    };
  }

  it("uses the server-recorded owner to read owner ciphertext and binds every read to its Vault", async () => {
    const { actor, member, calls } = shared();
    const ownerClient = new VaultClient({
      actor,
      identity: { getPrincipal: () => owner } as any,
      canister: owner.toText(),
      local: true,
    });
    await ownerClient.open(header());
    const revision = await ownerClient.save(
      { kind: "note", title: "Owner note" },
      new Uint8Array([7]),
    );
    await member.openAccess(id);
    expect(member.accessRole).toBe("Editor");
    expect(actor.shared_derive_vault_key).toHaveBeenCalledOnce();
    expect((await member.read(revision)).plaintext).toEqual(
      new Uint8Array([7]),
    );
    expect(actor.shared_get_chunk).toHaveBeenCalledWith(
      id,
      revision.object,
      1n,
      0,
    );
    expect(calls).toHaveLength(1);
  });

  it("refreshes role with a cached root and rejects a later revoked open", async () => {
    const { actor, member, role } = shared();
    await member.openAccess(id);
    const root = member.session.root;
    role("Viewer");
    await member.refreshHeader();
    expect(member.accessRole).toBe("Viewer");
    expect(member.session.root).toBe(root);
    await expect(
      member.save({ kind: "note", title: "Stale editor" }, new Uint8Array([7])),
    ).rejects.toThrow("Unauthorized");
    expect(actor.shared_mutate).not.toHaveBeenCalled();
    role(undefined);
    await expect(member.openAccess(id)).rejects.toThrow("Unauthorized");
    expect(member.session.root).toBeUndefined();
  });

  it("discards a delayed shared key reply when access changes during derivation", async () => {
    const { member, actor, role } = shared();
    const key = deferred<Awaited<ReturnType<VaultActor["shared_derive_vault_key"]>>>();
    vi.mocked(actor.shared_derive_vault_key).mockReturnValueOnce(key.promise);
    const pending = member.openAccess(id);
    const denied = expect(pending).rejects.toThrow("Unauthorized");
    await vi.waitFor(() => expect(actor.shared_derive_vault_key).toHaveBeenCalledOnce());
    role(undefined);
    key.resolve({ Ok: { input: [], public_key: [], encrypted_key: [] } });
    await denied;
    expect(member.session.root).toBeUndefined();
    expect(member.accessRole).toBeUndefined();
  });

  it("uses shared operation handles for the entire interrupted upload cancel sequence", async () => {
    const { actor, member, calls } = shared();
    vi.mocked(actor.shared_mutate).mockRejectedValueOnce(Error("network"));
    await member.openAccess(id);
    await expect(
      member.save(
        { kind: "attachment", title: "Large file" },
        new Uint8Array(262145),
      ),
    ).rejects.toThrow("network");
    const begin = vi.mocked(actor.shared_mutate).mock.calls[0][1];
    if (!("BeginRevision" in begin.action)) throw Error("expected upload");
    const request = begin.action.BeginRevision;
    vi.mocked(actor.shared_get_upload_status).mockResolvedValueOnce({
      Ok: { Pending: { request, received: [], expires: 0n, cancel_job: [] } },
    });
    await member.cancelSave();
    expect(actor.shared_get_upload_status).toHaveBeenCalledWith(
      id,
      request.operation,
    );
    expect(actor.shared_mutate).toHaveBeenNthCalledWith(2, id, begin);
    const cancelled = calls.at(-1)?.action;
    expect(cancelled.CancelUpload.upload).toEqual(request.operation);
    expect(actor.get_upload_status).not.toHaveBeenCalled();
  });
});

describe("encrypted upload reconciliation targets", () => {
  it.each(["vault", "object", "revision"] as const)(
    "retains the encrypted save after a committed status with a different %s",
    async (field) => {
      const { client, actor, calls } = setup();
      await client.open(header());
      await expect(
        client.save(
          { kind: "attachment", title: "Pending" },
          new Uint8Array(262145),
        ),
      ).rejects.toThrow("network");
      const begin = calls[0].action.BeginRevision;
      const committed = {
        vault: begin.vault,
        object: begin.object,
        revision: 1n,
        sequence: 1n,
      };
      const mismatched = {
        ...committed,
        [field]: field === "revision" ? 2n : new Uint8Array(16).fill(99),
      };
      vi.mocked(actor.get_upload_status)
        .mockResolvedValueOnce({ Ok: { Committed: mismatched } })
        .mockResolvedValueOnce({ Ok: { Committed: committed } });
      await expect(client.cancelSave()).rejects.toThrow("InvalidReceipt");
      expect(client.hasPendingSave).toBe(true);
      await expect(client.cancelSave()).resolves.toEqual({
        Committed: committed,
      });
      expect(client.hasPendingSave).toBe(false);
    },
  );

  it.each(["object", "operation", "expected_revision", "manifest"] as const)(
    "does not cancel a pending upload with a different %s",
    async (field) => {
      const { client, actor, calls } = setup();
      await client.open(header());
      await expect(
        client.save(
          { kind: "attachment", title: "Pending" },
          new Uint8Array(262145),
        ),
      ).rejects.toThrow("network");
      const request = calls[0].action.BeginRevision;
      const mismatch = field === "expected_revision" ? 9n : [99];
      const decodedRequest = {
        ...request,
        vault: Array.from(request.vault),
        object: Array.from(request.object),
        operation: Array.from(request.operation),
        manifest: Array.from(request.manifest),
        chunk_hashes: request.chunk_hashes.map((hash: Uint8Array) =>
          Array.from(hash),
        ),
      };
      vi.mocked(actor.get_upload_status).mockResolvedValueOnce({
        Ok: {
          Pending: {
            request: { ...request, [field]: mismatch },
            received: [],
            expires: 0n,
            cancel_job: [],
          },
        },
      });
      await expect(client.cancelSave()).rejects.toThrow("InvalidReceipt");
      expect(client.hasPendingSave).toBe(true);
      expect(calls.some((m) => "CancelUpload" in m.action)).toBe(false);
      vi.mocked(actor.get_upload_status).mockResolvedValueOnce({
        Ok: {
          Pending: {
            request: decodedRequest,
            received: [],
            expires: 0n,
            cancel_job: [],
          },
        },
      });
      await expect(client.cancelSave()).resolves.toHaveProperty("Pending");
      expect(client.hasPendingSave).toBe(false);
    },
  );
});

describe("history response targets", () => {
  it.each(["vault", "object", "revision", "cursor"] as const)(
    "rejects a history page with a mismatched %s",
    async (field) => {
      const { client, actor } = setup(false);
      await client.open(header());
      const revision = await client.save(
        { kind: "note", title: "Original" },
        new Uint8Array([1]),
      );
      const entry = { ...revision };
      if (field === "vault" || field === "object")
        entry[field] = new Uint8Array(16).fill(99);
      if (field === "revision") entry.revision = 2n;
      vi.mocked(actor.list_history).mockResolvedValueOnce({
        Ok: { entries: [entry], next: field === "cursor" ? [2n] : [] },
      });
      await expect(client.history(revision, 2n)).rejects.toThrow(
        "InvalidReceipt",
      );
    },
  );

  it("does not use another document's decrypted metadata as a deleted document title", async () => {
    const x = setup(false);
    await x.client.open(header());
    const privateRevision = await x.client.save(
      { kind: "note", title: "Other private title" },
      new Uint8Array([1]),
    );
    const deleted = {
      ...privateRevision,
      object: new Uint8Array(16).fill(99),
      deleted: true,
      revision: 2n,
    };
    vi.mocked(x.actor.list_objects).mockResolvedValueOnce({
      Ok: { entries: [deleted], next: [] },
    });
    vi.mocked(x.actor.list_history).mockResolvedValueOnce({
      Ok: { entries: [privateRevision], next: [] },
    });
    await expect(x.client.items()).rejects.toThrow("InvalidReceipt");
  });
});
