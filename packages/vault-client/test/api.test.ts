import { describe, expect, it, vi } from "vitest";
import { Principal } from "@icp-sdk/core/principal";
import { importKey } from "../../vault-crypto/src/index.ts";
import type { Header, VaultActor, Action } from "../src/contracts.ts";
vi.mock("../../vault-crypto/src/context.ts", async (load) => {
  const actual =
    await load<typeof import("../../vault-crypto/src/context.ts")>();
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
    create_vault: vi.fn(async (req: any) => ({ Ok: { ...h, id: req.vault } })),
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
  it("keeps create IDs on lost reply", async () => {
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
    const h = { ...header(), id: new Uint8Array(request.vault) };
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
    const h = { ...header(), id: new Uint8Array(request.vault) };
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
    const h = { ...header(), id: new Uint8Array(r.vault) };
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
