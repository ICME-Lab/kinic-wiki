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
