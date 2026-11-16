import { describe, expect, it, vi } from "vitest";
import { Principal } from "@icp-sdk/core/principal";
import { importKey } from "@kinic/vault-crypto";
import type { Header, VaultActor, Action } from "../src/contracts.ts";
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
function setup() {
  let h = header();
  let begin: any;
  let chunk: Uint8Array;
  let lost = true;
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
      if ("CommitRevision" in a)
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
    get_chunk: vi.fn(async () => ({ Ok: chunk })),
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
  it("retries identical ciphertext and operation after a lost chunk reply, then reads it", async () => {
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
    expect(calls[1]).toEqual(calls[2]);
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
    client.save({ kind: "note", title: "test" }, new Uint8Array([1])),
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
  const first = client.save({ kind: "note", title: "a" }, new Uint8Array([1]));
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
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
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
  const old = client.save({ kind: "note", title: "old" }, new Uint8Array([1]));
  client.session.lock();
  await client.open(header());
  const newHeader = deferred<HeaderReply>();
  vi.mocked(actor.get_vault_header).mockReturnValueOnce(newHeader.promise);
  const current = client.save(
    { kind: "note", title: "new" },
    new Uint8Array([2]),
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
  expect(doc.plaintext).toEqual(new Uint8Array([2]));
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
  newReply.resolve(await original(vi.mocked(actor.mutate).mock.calls[1][0]));
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
  await expect(client.save({ kind: "note", title: "old" }, new Uint8Array([1]))).rejects.toThrow("network");
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
  await expect(client.save({ kind: "note", title: "keep" }, new Uint8Array([1]))).rejects.toThrow("network");
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
  await expect(client.save({ kind: "note", title: "old" }, new Uint8Array([1]))).rejects.toThrow("network");
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
  await expect(client.save({ kind: "note", title: "old" }, new Uint8Array([1]))).rejects.toThrow("network");
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
async function searchFixture(count = 5) {
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
  const { client, actor } = await searchFixture(100);
  const items = await client.items();
  expect(items).toHaveLength(100);
  expect(items[99].metadata.title).toBe("title 99");
  expect(actor.get_chunk).not.toHaveBeenCalled();
  expect(items.some((x) => "searchText" in x)).toBe(false);
  expect(actor.get_vault_header).toHaveBeenCalledOnce();
});
it("searches sequential note bodies using one shared checked header and copied matching IDs", async () => {
  const { client, actor, items } = await searchFixture();
  const results = await client.searchNotes(items, "SECRET");
  expect(results).toEqual([new Uint8Array(16).fill(1)]);
  expect(results[0]).not.toBe(items[0].revision.object);
  expect(actor.get_vault_header).toHaveBeenCalledOnce();
  expect(
    vi.mocked(actor.get_chunk).mock.calls.map((x) => new Uint8Array(x[1])[0]),
  ).toEqual([1, 2]);
});
it("does no content reads for an empty search query", async () => {
  const { client, actor, items } = await searchFixture();
  await expect(client.searchNotes(items, "")).resolves.toEqual([]);
  expect(actor.get_chunk).not.toHaveBeenCalled();
});
it.each(["lock", "switch", "destroy"] as const)(
  "rejects a search after %s during a header request",
  async (event) => {
    const { client, actor, items } = await searchFixture();
    const reply =
      deferred<Awaited<ReturnType<VaultActor["get_vault_header"]>>>();
    vi.mocked(actor.get_vault_header).mockReturnValueOnce(reply.promise);
    const pending = client.searchNotes(items, "secret");
    const rejected = expect(pending).rejects.toThrow("Locked");
    if (event === "lock") client.session.lock();
    if (event === "destroy") client.destroy();
    if (event === "switch")
      await client
        .open({ ...header(), id: new Uint8Array(16).fill(8) })
        .catch(() => {});
    reply.resolve({ Ok: header() });
    await rejected;
    expect(actor.get_chunk).not.toHaveBeenCalled();
  },
);
it.each(["lock", "switch", "destroy"] as const)(
  "rejects a search after %s during a body request",
  async (event) => {
    const { client, actor, items } = await searchFixture();
    const original = vi.mocked(actor.get_chunk).getMockImplementation()!;
    const reply = deferred<Awaited<ReturnType<VaultActor["get_chunk"]>>>();
    vi.mocked(actor.get_chunk).mockReturnValueOnce(reply.promise);
    const pending = client.searchNotes(items, "secret");
    const rejected = expect(pending).rejects.toThrow("Locked");
    await vi.waitFor(() => expect(actor.get_chunk).toHaveBeenCalledOnce());
    if (event === "lock") client.session.lock();
    if (event === "destroy") client.destroy();
    if (event === "switch")
      await client
        .open({ ...header(), id: new Uint8Array(16).fill(8) })
        .catch(() => {});
    reply.resolve(await original(id, items[0].revision.object, 1n, 0));
    await rejected;
    expect(actor.get_chunk).toHaveBeenCalledOnce();
  },
);
it("fences search dispatch if context resolution becomes stale", async () => {
  const { client, actor, items } = await searchFixture();
  const checked = (client as any).checkedContext.bind(client);
  vi.spyOn(client as any, "checkedContext").mockImplementation(async () => {
    const c = await checked();
    queueMicrotask(() => client.session.lock());
    return c;
  });
  await expect(client.searchNotes(items, "secret")).rejects.toThrow("Locked");
  expect(actor.get_chunk).not.toHaveBeenCalled();
});
it("standalone reads refresh and reject a changed header before content dispatch", async () => {
  const { client, actor, items, change } = await searchFixture();
  change({ ...header(), nonce: new Uint8Array(32).fill(8) });
  await expect(client.read(items[0].revision)).rejects.toThrow("TargetChanged");
  expect(actor.get_vault_header).toHaveBeenCalledOnce();
  expect(actor.get_chunk).not.toHaveBeenCalled();
});
it("accepts a server-assigned creation ID and sends only an operation", async () => {
  const { client, actor } = setup();
  vi.mocked(actor.create_vault).mockResolvedValue({ Ok: header() });
  await expect(client.create()).resolves.toEqual(header());
  expect(Object.keys(vi.mocked(actor.create_vault).mock.calls[0][0])).toEqual([
    "operation",
  ]);
});
it("waits for each note before dispatching the next body", async () => {
  const { client, actor, items } = await searchFixture();
  const original = vi.mocked(actor.get_chunk).getMockImplementation()!;
  const reply = deferred<Awaited<ReturnType<VaultActor["get_chunk"]>>>();
  vi.mocked(actor.get_chunk).mockReturnValueOnce(reply.promise);
  const pending = client.searchNotes(items, "secret");
  await vi.waitFor(() => expect(actor.get_chunk).toHaveBeenCalledOnce());
  expect(actor.get_chunk).toHaveBeenCalledOnce();
  reply.resolve(await original(id, items[0].revision.object, 1n, 0));
  await expect(pending).resolves.toEqual([new Uint8Array(16).fill(1)]);
  expect(actor.get_chunk).toHaveBeenCalledTimes(2);
});
it.each(["lock", "switch", "destroy"] as const)(
  "wipes a decrypted search document when %s occurs before search receives it",
  async (event) => {
    const { client, items } = await searchFixture();
    const original = (client as any).readWithContext.bind(client);
    let plaintext!: Uint8Array;
    vi.spyOn(client as any, "readWithContext").mockImplementation(
      async (...args) => {
        const doc = await original(...args);
        plaintext = doc.plaintext;
        queueMicrotask(() => {
          if (event === "lock") client.session.lock();
          if (event === "destroy") client.destroy();
          if (event === "switch")
            void client
              .open({ ...header(), id: new Uint8Array(16).fill(8) })
              .catch(() => {});
        });
        return doc;
      },
    );
    await expect(client.searchNotes(items, "secret")).rejects.toThrow("Locked");
    expect(plaintext.length).toBeGreaterThan(0);
    expect(plaintext.every((x) => x === 0)).toBe(true);
  },
);
