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
    mutate: vi.fn(async (payload: Uint8Array, _signature?: Uint8Array) => {
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
    get_upload_status: vi.fn(async () => ({ Ok: { Absent: null } })),
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
  f.client.session.bindRoot(
    await importKey(new Uint8Array(32)),
    f.client.header!.generation[0]!,
  );
  await f.client.authorize({ Normal: null }, [generation]);
  return f;
}
const save = (f: ReturnType<typeof fixture>) =>
  f.client.save(
    { kind: "note", title: "unsaved draft" },
    new Uint8Array([1, 2, 3]),
    undefined,
    () => {},
  );
function expire(f: ReturnType<typeof fixture>) {
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 301000);
  f.client.session.lastActivity = Date.now();
}
it("active editing past expiry obtains fresh UV and saves without locking or losing the draft", async () => {
  const f = await unlocked(),
    root = f.client.session.root,
    ticket = f.client.session.capture();
  expire(f);
  await expect(save(f)).resolves.toEqual({ revision: 1n });
  expect(f.actor.begin_grant).toHaveBeenCalledTimes(2);
  expect(f.operations[0].counter).toBe(0n);
  expect(
    (f.actor.begin_grant.mock.calls[1][0] as { public_key: Uint8Array })
      .public_key,
  ).not.toEqual(
    (f.actor.begin_grant.mock.calls[0][0] as { public_key: Uint8Array })
      .public_key,
  );
  expect(f.client.session.root).toBe(root);
  expect(f.client.session.capture()).toBe(ticket);
  f.client.session.lock();
});
it.each(["NotAllowedError", "InvalidProof"])(
  "failed/cancelled renewal (%s) preserves the draft and can be retried",
  async (error) => {
    const f = await unlocked(),
      root = f.client.session.root;
    expire(f);
    vi.mocked(assertCredential).mockRejectedValueOnce(Error(error));
    await expect(save(f)).rejects.toThrow(error);
    expect(f.actor.mutate).not.toHaveBeenCalled();
    expect(f.client.session.root).toBe(root);
    await expect(f.client.resumeSave()).resolves.toEqual({ revision: 1n });
    f.client.session.lock();
  },
);
it("known rejection resumes the same encrypted save with fresh authority", async () => {
  const f = await unlocked();
  f.actor.mutate.mockResolvedValueOnce({
    Err: { Unauthorized: null },
  } as never);
  await expect(save(f)).rejects.toThrow("Unauthorized");
  expect(f.actor.begin_grant).toHaveBeenCalledTimes(1);
  await expect(f.client.resumeSave()).resolves.toEqual({ revision: 1n });
  expect(f.actor.begin_grant).toHaveBeenCalledTimes(2);
  f.client.session.lock();
});
it("generation changed before renewal rejects stale encrypted draft writes", async () => {
  const f = await unlocked(),
    root = f.client.session.root;
  expire(f);
  f.actor.get_vault_header.mockResolvedValue({
    Ok: {
      ...header,
      generation: [{ ...generation, nonce: new Uint8Array(32).fill(7) }],
    },
  });
  await expect(save(f)).rejects.toThrow("TargetChanged");
  expect(f.actor.mutate).not.toHaveBeenCalled();
  expect(f.client.session.root).toBeUndefined();
  f.client.session.lock();
});
it("generation changed during UV cannot publish or reuse the old generation", async () => {
  const f = await unlocked();
  expire(f);
  vi.mocked(assertCredential).mockImplementationOnce(async () => {
    f.actor.get_vault_header.mockResolvedValue({
      Ok: { ...header, generation: [{ ...generation, key_name: "key_1" }] },
    });
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
  vi.mocked(assertCredential).mockImplementationOnce(async () => {
    f.client.session.lock();
    return "proof";
  });
  await expect(save(f)).rejects.toThrow("Locked");
  expect(f.actor.finish_grant).toHaveBeenCalledTimes(1);
  expect(f.actor.mutate).not.toHaveBeenCalled();
  expect(f.client.session.root).toBeUndefined();
});
it("unknown request survives expiry byte-for-byte and never obtains replacement authority", async () => {
  const f = await unlocked();
  const original = f.actor.mutate.getMockImplementation()!;
  const calls: Uint8Array[] = [];
  f.actor.mutate.mockImplementation(async (payload) => {
    calls.push(payload.slice());
    throw Error("network");
  });
  await expect(save(f)).rejects.toThrow("network");
  expire(f);
  await expect(save(f)).rejects.toThrow("SavePending");
  expect(f.actor.begin_grant).toHaveBeenCalledTimes(1);
  expect(calls).toHaveLength(3);
  expect(calls.every((p) => Buffer.from(p).equals(Buffer.from(calls[0])))).toBe(
    true,
  );
  f.actor.mutate.mockImplementation(original);
  await f.client.retryMutation();
  expect(f.actor.mutate.mock.calls[3][0]).toEqual(calls[0]);
  expect(f.operations.some((m) => "CommitRevision" in m.operation)).toBe(true);
  f.client.session.lock();
});
it("grant-cap Busy preserves the active draft and does not send", async () => {
  const f = await unlocked(),
    root = f.client.session.root;
  expire(f);
  f.actor.begin_grant.mockResolvedValueOnce({ Err: { Busy: null } } as never);
  await expect(save(f)).rejects.toThrow("Busy");
  expect(f.client.session.root).toBe(root);
  expect(f.actor.mutate).not.toHaveBeenCalled();
  f.client.session.lock();
});

it("absent normal authority requests fresh UV for the exact current generation", async () => {
  const f = fixture();
  f.client.session.bindRoot(
    await importKey(new Uint8Array(32)),
    f.client.header!.generation[0]!,
  );
  await expect(save(f)).resolves.toEqual({ revision: 1n });
  expect(f.actor.begin_grant).toHaveBeenCalledTimes(1);
  expect(f.actor.begin_grant.mock.calls[0][0]).toMatchObject({
    purpose: { Normal: null },
    generations: [generation],
  });
  f.client.session.lock();
});

it("a late renewal proof after lock cannot block or replace a newly authorized session", async () => {
  const f = await unlocked();
  expire(f);
  let release!: (proof: string) => void;
  vi.mocked(assertCredential).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const oldSave = save(f);
  const rejected = expect(oldSave).rejects.toThrow("Locked");
  await vi.waitFor(() => expect(release).toBeDefined());
  f.client.session.lock();
  f.client.header = header;
  f.client.session.bindRoot(
    await importKey(new Uint8Array(32)),
    f.client.header!.generation[0]!,
  );
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
  f.actor.get_vault_header
    .mockResolvedValueOnce({ Ok: header })
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
  const oldSave = save(f);
  const rejected = expect(oldSave).rejects.toThrow("Locked");
  await vi.waitFor(() => expect(release).toBeDefined());
  f.client.session.lock();
  f.client.header = header;
  f.client.session.bindRoot(
    await importKey(new Uint8Array(32)),
    f.client.header!.generation[0]!,
  );
  await f.client.authorize({ Normal: null }, [generation]);
  release({ Ok: header });
  await rejected;
  await expect(save(f)).resolves.toEqual({ revision: 1n });
  expect(f.actor.begin_grant).toHaveBeenCalledTimes(2);
  f.client.session.lock();
});
it("after remote rotation the old session locks and re-unlocked writes require the new root", async () => {
  const f = await unlocked(),
    oldRoot = f.client.session.root!;
  const next = { ...generation, epoch: 9n, nonce: new Uint8Array(32).fill(11) },
    h = { ...header, epoch: 9n, generation: [next] as [Generation] };
  f.actor.get_vault_header.mockResolvedValue({ Ok: h });
  Object.assign(f.actor, {
    list_objects: async () => ({ Ok: { entries: [], next: [] } }),
  });
  await expect(f.client.items()).rejects.toThrow("TargetChanged");
  expect(f.client.session.root).toBeUndefined();
  f.client.header = h;
  const root = await importKey(new Uint8Array(32).fill(19));
  f.client.session.bindRoot(root, next);
  f.actor.finish_grant.mockImplementation(async () => ({
    Ok: {
      id: new Uint8Array(32),
      expires: BigInt(Math.floor(Date.now() / 1000) + 300),
      next_counter: 0n,
      generations: [next],
      purpose: { Normal: null },
    },
  }));
  await save(f);
  const begin = f.operations.find(
    (m) => "BeginRevision" in m.operation,
  )!.operation;
  if (!("BeginRevision" in begin)) throw Error("missing begin");
  const put = f.operations.find((m) => "PutChunk" in m.operation)!.operation;
  if (!("PutChunk" in put)) throw Error("missing chunk");
  const { decryptDocument } = await import("../../vault-crypto/src/documents");
  const { cryptoGeneration } = await import("../src/ordinary");
  const r = begin.BeginRevision,
    chunks = [new Uint8Array(put.PutChunk.data)];
  const decode = (key: CryptoKey) =>
    decryptDocument(
      key,
      new Uint8Array(r.vault),
      new Uint8Array(r.object),
      1n,
      new Uint8Array(r.manifest),
      chunks,
      r.chunk_hashes.map((x) => new Uint8Array(x)),
      cryptoGeneration(next),
    );
  const doc = await decode(root);
  expect(doc.plaintext).toEqual(new Uint8Array([1, 2, 3]));
  doc.plaintext.fill(0);
  await expect(decode(oldRoot)).rejects.toThrow();
  f.client.session.lock();
});
it("retry after a lost chunk reply completes the encrypted save instead of replaying only one RPC", async () => {
  const f = await unlocked();
  const original = f.actor.mutate.getMockImplementation()!;
  const seen: Uint8Array[] = [];
  f.actor.mutate.mockImplementation(async (payload) => {
    const m = IDL.decode([mutationIDL], payload)[0] as unknown as Mutation;
    if ("PutChunk" in m.operation) {
      seen.push(payload.slice());
      throw Error("offline");
    }
    return original(payload);
  });
  await expect(save(f)).rejects.toThrow("offline");
  expect(seen).toHaveLength(3);
  const begin = f.operations[0].operation;
  if (!("BeginRevision" in begin)) throw Error("missing begin");
  Object.assign(f.actor, {
    get_upload_status: async () => ({
      Ok: {
        Pending: {
          request: begin.BeginRevision,
          received: [0],
          cancel_job: [],
          expires: 1000n,
        },
      },
    }),
  });
  f.actor.mutate.mockImplementation(original);
  await f.client.retryMutation();
  expect(f.operations.map((m) => Object.keys(m.operation)[0])).toEqual([
    "BeginRevision",
    "PutChunk",
    "CommitRevision",
  ]);
  expect(f.actor.mutate.mock.calls.at(-2)![0]).toEqual(seen[0]);
  f.client.session.lock();
});

function durableUploadFixture() {
  const f = fixture();
  let request:
    | Extract<
        Mutation["operation"],
        { BeginRevision: unknown }
      >["BeginRevision"]
    | undefined;
  const chunks = new Map<number, Uint8Array>();
  let revision: import("../src/contracts").Revision | undefined,
    commits = 0;
  const execute = async (payload: Uint8Array) => {
    const m = IDL.decode([mutationIDL], payload)[0] as unknown as Mutation;
    f.operations.push(m);
    const op = m.operation;
    if ("BeginRevision" in op) {
      if (request) expect(op.BeginRevision).toEqual(request);
      request = op.BeginRevision;
      return {
        Ok: {
          Upload: { id: request.operation, revision: 1n, expires: 86401n },
        },
      };
    }
    if ("PutChunk" in op) {
      chunks.set(op.PutChunk.index, new Uint8Array(op.PutChunk.data));
      return { Ok: { Unit: null } };
    }
    if ("CommitRevision" in op) {
      if (!request) throw Error("no upload");
      if (!revision) {
        commits++;
        revision = { ...request, revision: 1n, sequence: 2n, deleted: false };
      }
      return { Ok: { Revision: revision } };
    }
    return { Ok: { Unit: null } };
  };
  f.actor.mutate.mockImplementation(execute as never);
  f.actor.get_upload_status.mockImplementation(
    async () =>
      ({
        Ok: revision
          ? {
              Committed: {
                vault: revision.vault,
                object: revision.object,
                revision: 1n,
                sequence: 2n,
              },
            }
          : request
            ? {
                Pending: {
                  request,
                  received: [...chunks.keys()],
                  cancel_job: [],
                  expires: 86401n,
                },
              }
            : { Absent: null },
      }) as never,
  );
  Object.assign(f.actor, { get_manifest: async () => ({ Ok: revision }) });
  return {
    ...f,
    execute,
    commits: () => commits,
    request: () => request,
    chunks,
  };
}
it.each(["BeginRevision", "PutChunk", "CommitRevision"])(
  "resumes the same ciphertext exactly once after all replies to %s are lost",
  async (phase) => {
    const f = durableUploadFixture();
    f.client.session.bindRoot(await importKey(new Uint8Array(32)), generation);
    await f.client.authorize({ Normal: null }, [generation]);
    const lost: { payload: Uint8Array; signature: Uint8Array }[] = [];
    f.actor.mutate.mockImplementation(async (payload, signature) => {
      const reply = await f.execute(payload);
      const m = IDL.decode([mutationIDL], payload)[0] as unknown as Mutation;
      if (phase in m.operation && lost.length < 3) {
        lost.push({
          payload: payload.slice(),
          signature: new Uint8Array(signature!),
        });
        throw Error("lost reply");
      }
      return reply as never;
    });
    const plain = new Uint8Array(1048577).fill(21);
    await expect(
      f.client.save(
        { kind: "attachment", title: "two chunks" },
        plain,
        undefined,
        () => {},
      ),
    ).rejects.toThrow("lost reply");
    const request = f.request()!;
    expect(f.client.hasPendingSave).toBe(true);
    expect(lost).toHaveLength(3);
    expect(lost[1]).toEqual(lost[0]);
    expect(lost[2]).toEqual(lost[0]);
    await expect(
      f.client.save(
        { kind: "note", title: "another" },
        new Uint8Array([1]),
        undefined,
        () => {},
      ),
    ).rejects.toThrow("SavePending");
    const result = await f.client.resumeSave();
    expect(result.revision).toBe(1n);
    expect(f.commits()).toBe(1);
    expect(f.client.hasPendingSave).toBe(false);
    expect(f.request()).toEqual(request);
    expect(f.chunks.size).toBe(2);
    const { decryptDocument } = await import(
      "../../vault-crypto/src/documents"
    );
    const { cryptoGeneration } = await import("../src/ordinary");
    const doc = await decryptDocument(
      f.client.session.root!,
      new Uint8Array(request.vault),
      new Uint8Array(request.object),
      1n,
      new Uint8Array(request.manifest),
      [f.chunks.get(0)!, f.chunks.get(1)!],
      request.chunk_hashes.map((x) => new Uint8Array(x)),
      cryptoGeneration(generation),
    );
    expect(doc.plaintext).toEqual(plain);
    doc.plaintext.fill(0);
    f.client.session.lock();
  },
);
it("renews expired authority between chunks without changing the encrypted upload", async () => {
  const f = durableUploadFixture();
  f.client.session.bindRoot(await importKey(new Uint8Array(32)), generation);
  await f.client.authorize({ Normal: null }, [generation]);
  let advanced = false;
  f.actor.mutate.mockImplementation(async (payload) => {
    const reply = await f.execute(payload);
    const m = IDL.decode([mutationIDL], payload)[0] as unknown as Mutation;
    if ("PutChunk" in m.operation && !advanced) {
      advanced = true;
      expire(f);
    }
    return reply as never;
  });
  await f.client.save(
    { kind: "attachment", title: "expiry" },
    new Uint8Array(1048577),
    undefined,
    () => {},
  );
  expect(f.commits()).toBe(1);
  expect(f.actor.begin_grant).toHaveBeenCalledTimes(2);
  expect(f.client.session.root).toBeDefined();
  f.client.session.lock();
});
it("lock discards a paused encrypted save job and prevents resume", async () => {
  const f = await unlocked();
  f.actor.mutate.mockRejectedValue(Error("offline"));
  await expect(save(f)).rejects.toThrow("offline");
  expect(f.client.hasPendingSave).toBe(true);
  f.client.session.lock();
  expect(f.client.hasPendingSave).toBe(false);
  await expect(f.client.resumeSave()).rejects.toThrow("NoPendingSave");
});
it("cancelled UV between chunks pauses the job and a later resume keeps the original upload", async () => {
  const f = durableUploadFixture();
  const root = await importKey(new Uint8Array(32));
  f.client.session.bindRoot(root, generation);
  await f.client.authorize({ Normal: null }, [generation]);
  let advanced = false;
  f.actor.mutate.mockImplementation(async (payload) => {
    const reply = await f.execute(payload);
    if (
      !advanced &&
      "PutChunk" in
        (IDL.decode([mutationIDL], payload)[0] as unknown as Mutation).operation
    ) {
      advanced = true;
      expire(f);
      vi.mocked(assertCredential).mockRejectedValueOnce(
        Error("NotAllowedError"),
      );
    }
    return reply as never;
  });
  await expect(
    f.client.save(
      { kind: "attachment", title: "cancel UV" },
      new Uint8Array(1048577),
      undefined,
      () => {},
    ),
  ).rejects.toThrow("NotAllowedError");
  const operation = f.request()!.operation;
  expect(f.client.session.root).toBe(root);
  expect(f.client.hasPendingSave).toBe(true);
  await f.client.resumeSave();
  expect(f.commits()).toBe(1);
  expect(f.request()!.operation).toEqual(operation);
  f.client.session.lock();
});
it("a late old save response cannot block a new save after locking and unlocking", async () => {
  const f = await unlocked();
  let release!: (x: never) => void;
  f.actor.mutate.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const pending = save(f),
    rejected = expect(pending).rejects.toThrow("Locked");
  await vi.waitFor(() => expect(release).toBeDefined());
  f.client.session.lock();
  f.client.header = header;
  f.client.session.bindRoot(
    await importKey(new Uint8Array(32).fill(5)),
    generation,
  );
  await f.client.authorize({ Normal: null }, [generation]);
  await expect(save(f)).resolves.toEqual({ revision: 1n });
  release({
    Ok: { Upload: { id: new Uint8Array(16), revision: 1n, expires: 1000n } },
  } as never);
  await rejected;
  expect(f.client.hasPendingSave).toBe(false);
  f.client.session.lock();
});
it("cancels a paused save through fresh signed cleanup, then drops the session job", async () => {
  const f = durableUploadFixture();
  f.client.session.bindRoot(await importKey(new Uint8Array(32)), generation);
  await f.client.authorize({ Normal: null }, [generation]);
  let cleanupPurpose: unknown,
    cancelled = false;
  Object.assign(f.actor, {
    cleanup_status: async () => ({ Ok: [] }),
    begin_cleanup: async (r: { purpose: unknown }) => {
      cleanupPurpose = r.purpose;
      return {
        Ok: {
          bytes: new Uint8Array(32),
          expires: 1000n,
          registration: false,
          credential_ids: [new Uint8Array([9])],
        },
      };
    },
    finish_cleanup: async () => ({
      Ok: {
        id: new Uint8Array(32).fill(4),
        expires: BigInt(Math.floor(Date.now() / 1000) + 300),
        next_counter: 0n,
        generations: [generation],
        purpose: cleanupPurpose,
      },
    }),
  });
  const status = f.actor.get_upload_status.getMockImplementation()!;
  f.actor.get_upload_status.mockImplementation(async () =>
    cancelled ? ({ Ok: { Cancelled: null } } as never) : status(),
  );
  f.actor.mutate.mockImplementation(async (payload) => {
    const m = IDL.decode([mutationIDL], payload)[0] as unknown as Mutation;
    if ("Cleanup" in m.operation) {
      expect(m.operation.Cleanup.action).toMatchObject({
        CancelUpload: { upload: f.request()!.operation },
      });
      cancelled = true;
      return {
        Ok: {
          Cleanup: { job: m.operation.Cleanup.job, cursor: 1n, complete: true },
        },
      } as never;
    }
    const result = await f.execute(payload);
    if ("PutChunk" in m.operation) throw Error("offline");
    return result as never;
  });
  await expect(
    f.client.save(
      { kind: "note", title: "cancel" },
      new Uint8Array([1]),
      undefined,
      () => {},
    ),
  ).rejects.toThrow("offline");
  // Exact pending chunk must first be reconciled; its retry now gets a definite result.
  f.actor.mutate.mockImplementation(async (payload) => {
    const m = IDL.decode([mutationIDL], payload)[0] as unknown as Mutation;
    if ("Cleanup" in m.operation) {
      cancelled = true;
      return {
        Ok: {
          Cleanup: { job: m.operation.Cleanup.job, cursor: 1n, complete: true },
        },
      } as never;
    }
    return (await f.execute(payload)) as never;
  });
  await expect(f.client.cancelSave()).resolves.toEqual({ Cancelled: null });
  expect(cleanupPurpose).toHaveProperty("Cleanup");
  expect(f.client.hasPendingSave).toBe(false);
  expect(f.commits()).toBe(0);
  f.client.session.lock();
});
