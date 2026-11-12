import { expect, it, vi } from "vitest";
import { Ed25519KeyIdentity } from "@icp-sdk/core/identity";
import { Principal } from "@icp-sdk/core/principal";
import { IDL } from "@icp-sdk/core/candid";
import { VaultClient } from "../src/api";
import { mutationIDL } from "../src/signed";
import type { Mutation } from "../src/mutation-contracts";
import type { Generation, Header, VaultActor } from "../src/contracts";
import {
  importKey,
  generationAAD,
  sealV2,
  deriveKey,
  recoveryVerifier,
} from "../../vault-crypto/src/index";
import { b64 } from "../../vault-crypto/src/documents";
import { openArchive } from "../../vault-backup/src/index";
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
const cg = {
  ...generation,
  version: 2 as const,
  owner: generation.owner.toText(),
  canister: canister.toText(),
  vault: new Uint8Array(generation.vault),
  nonce: new Uint8Array(generation.nonce),
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
        expires: 9999999999n,
        registration: false,
        credential_ids: [new Uint8Array([9])],
      },
    })),
    finish_grant: vi.fn(async () => ({
      Ok: {
        id: new Uint8Array(32),
        expires: 9999999999n,
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
it("signs ordinary v2 content with a target-bound Normal grant and exact network retry", async () => {
  const f = fixture();
  f.client.session.bindRoot(await importKey(new Uint8Array(32)), f.client.header!.generation[0]!);
  await f.client.authorize({ Normal: null }, [generation]);
  f.actor.mutate.mockRejectedValueOnce(Error("transport"));
  await f.client.save(
    { kind: "note", title: "private" },
    new Uint8Array([1]),
    undefined,
    () => {},
  );
  expect(f.actor.mutate.mock.calls[0]).toEqual(f.actor.mutate.mock.calls[1]);
  expect(f.operations.map((m) => Object.keys(m.operation)[0])).toEqual([
    "BeginRevision",
    "PutChunk",
    "CommitRevision",
  ]);
  const first = f.operations[0].operation;
  if (!("BeginRevision" in first)) throw Error("missing");
  expect(
    JSON.parse(
      new TextDecoder().decode(new Uint8Array(first.BeginRevision.manifest)),
    ).version,
  ).toBe(2);
  expect(f.operations.map((m) => m.counter)).toEqual([0n, 1n, 2n]);
});
it("ordinary passkey removal uses Credentials authority and preserves the VRK", async () => {
  const f = fixture(),
    raw = new Uint8Array(32).fill(7);
  f.client.session.raw = raw;
  f.client.session.bindRoot(await importKey(raw), f.client.header!.generation[0]!, raw);
  await f.client.removeCredential(new Uint8Array([8]));
  expect(f.actor.begin_grant.mock.calls[0]?.[0]).toMatchObject({
    purpose: { Credentials: null },
    generations: [],
  });
  expect(f.operations[0].operation).toEqual({
    RemoveCredential: { credential: new Uint8Array([8]) },
  });
  expect(f.client.session.raw).toBe(raw);
  expect(raw[0]).toBe(7);
});
it("exports live v2 root envelopes at revision zero even at a nonzero generation epoch", async () => {
  const f = fixture(),
    raw = new Uint8Array(32).fill(7),
    secret = new Uint8Array(32).fill(8),
    root = await importKey(raw);
  const h: Header = {
    ...header,
    normal: [
      await sealV2(
        root,
        raw,
        generationAAD(cg, new Uint8Array(16), 0n, "normal"),
      ),
    ],
    recovery: [
      await sealV2(
        await deriveKey(secret, "recovery"),
        raw,
        generationAAD(cg, new Uint8Array(16), 0n, "recovery"),
      ),
    ],
    recovery_verifier: await recoveryVerifier(secret),
  };
  f.actor.get_vault_header.mockResolvedValue({ Ok: h });
  Object.assign(f.actor, {
    get_active_export_for_vault: async () => ({ Ok: [] }),
    begin_export: async () => ({
      Ok: {
        id: new Uint8Array(16),
        vault: h.id,
        header: h,
        record_count: 0n,
        chunk_count: 0n,
        plain_bytes: 0n,
      },
    }),
    export_index: async () => ({ Ok: { entries: [], next: [] } }),
  });
  const backup = await f.client.backupWithRecovery(h, b64(secret));
  const opened = await openArchive(backup.data, secret);
  expect(opened.rootRaw).toEqual(raw);
  expect(opened.header).toMatchObject({ version: 2, envelope_revision: "0" });
  opened.rootRaw.fill(0);
  expect(f.actor.begin_grant).not.toHaveBeenCalled();
  expect(f.actor.mutate).not.toHaveBeenCalled();
});
it.each([false, true])(
  "cancels exact Pending creation with or without allocated generation (%s), without a key call",
  async (allocated) => {
    const f = fixture(),
      entry = {
        vault: generation.vault,
        attempt: new Uint8Array(16).fill(6),
        namespace: [new Uint8Array(32).fill(4)],
        state: { Pending: null },
        cleaning: false,
        expires: 99n,
      } as import("../src/contracts").UnfinishedVault;
    const begin_cleanup = vi.fn(async (_r: unknown) => ({
      Ok: {
        bytes: new Uint8Array(32),
        expires: 9999999999n,
        registration: false,
        credential_ids: [new Uint8Array([9])],
      },
    }));
    Object.assign(f.actor, {
      cleanup_status: async () => ({ Ok: [] }),
      begin_cleanup,
      finish_cleanup: async () => ({
        Ok: {
          id: new Uint8Array(32),
          expires: 9999999999n,
          next_counter: 0n,
          generations: [],
          purpose: {
            CancelCreation: {
              job: new Uint8Array(16),
              target: {
                namespace: entry.namespace[0],
                vault: entry.vault,
                attempt: entry.attempt,
              },
            },
          },
        },
      }),
    });
    f.actor.mutate.mockImplementation(async (payload) => {
      const m = IDL.decode([mutationIDL], payload)[0] as unknown as Mutation;
      f.operations.push(m);
      return {
        Ok: {
          Cleanup: { job: new Uint8Array(16), cursor: 1n, complete: true },
        },
      } as never;
    });
    f.client.header = { ...header, generation: allocated ? [generation] : [] };
    await f.client.cancelSetup(entry);
    expect(begin_cleanup.mock.calls[0]?.[0]).toMatchObject({
      generations: [],
      purpose: {
        CancelCreation: {
          target: {
            namespace: entry.namespace[0],
            vault: entry.vault,
            attempt: entry.attempt,
          },
        },
      },
    });
    expect(f.operations.map((m) => Object.keys(m.operation)[0])).toEqual([
      "Cleanup",
    ]);
    expect(f.operations[0].operation).toMatchObject({
      Cleanup: {
        cursor: 0n,
        action: { CancelSetup: { attempt: entry.attempt } },
      },
    });
  },
);
it("fences a late ordinary mutation response after lock and destroys the signer", async () => {
  const f = fixture();
  await f.client.authorize({ Normal: null }, [generation]);
  let resolve!: (r: unknown) => void;
  f.actor.mutate.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }) as never,
  );
  const pending = f.client.deleteObject({
    vault: generation.vault,
    object: new Uint8Array(16),
    revision: 1n,
  } as never);
  await vi.waitFor(() => expect(f.actor.mutate).toHaveBeenCalled());
  f.client.session.lock();
  resolve({ Ok: { Unit: null } });
  await expect(pending).rejects.toThrow("Locked");
  await expect(f.client.retryMutation()).rejects.toThrow("FreshProofRequired");
});
it("resumes bounded authenticated full cleanup using its existing job and cursor", async () => {
  const f = fixture(),
    job = new Uint8Array(16).fill(5),
    begin_cleanup = vi.fn(async (_r: unknown) => ({
      Ok: {
        bytes: new Uint8Array(32),
        expires: 9999999999n,
        registration: false,
        credential_ids: [new Uint8Array([9])],
      },
    }));
  Object.assign(f.actor, {
    cleanup_status: async () => ({
      Ok: [{ job, cursor: 7n, complete: false }],
    }),
    begin_cleanup,
    finish_cleanup: async () => ({
      Ok: {
        id: new Uint8Array(32),
        expires: 9999999999n,
        next_counter: 0n,
        generations: [generation],
        purpose: { Cleanup: { job } },
      },
    }),
  });
  f.actor.mutate.mockImplementation(async (payload) => {
    const m = IDL.decode([mutationIDL], payload)[0] as unknown as Mutation;
    f.operations.push(m);
    return { Ok: { Cleanup: { job, cursor: 8n, complete: true } } } as never;
  });
  await f.client.cleanup(header, true);
  expect(begin_cleanup.mock.calls[0][0]).toMatchObject({
    purpose: { Cleanup: { job } },
    generations: [generation],
  });
  expect(f.operations[0].operation).toEqual({
    Cleanup: { job, cursor: 7n, action: { Purge: null } },
  });
  expect(f.actor.begin_grant).not.toHaveBeenCalled();
  expect(f.client.session.raw).toBeUndefined();
});
it("cancels never-registered bootstrap only by exact Pending attempt, without a signed grant", async () => {
  const f = fixture(),
    cancel_vault_setup = vi.fn(async () => ({ Ok: null }));
  f.actor.list_credentials.mockResolvedValue({ Ok: [] });
  Object.assign(f.actor, { cancel_vault_setup });
  const entry = {
    vault: generation.vault,
    attempt: new Uint8Array(16).fill(6),
    namespace: [],
    state: { Pending: null },
    cleaning: false,
    expires: 99n,
  } as import("../src/contracts").UnfinishedVault;
  await f.client.cancelSetup(entry);
  expect(cancel_vault_setup).toHaveBeenCalledWith(entry.vault, entry.attempt);
  expect(f.actor.mutate).not.toHaveBeenCalled();
});
it("never substitutes a pending signed request for a different new mutation", async () => {
  const f = fixture();
  await f.client.authorize({ Normal: null }, [generation]);
  f.actor.mutate.mockRejectedValue(Error("transport"));
  const r = {
    vault: generation.vault,
    object: new Uint8Array(16),
    revision: 1n,
  } as never;
  await expect(f.client.deleteObject(r)).rejects.toThrow("transport");
  expect(f.actor.mutate).toHaveBeenCalledTimes(3);
  await expect(f.client.purgeObject(r)).rejects.toThrow(
    "ResolvePendingMutation",
  );
  expect(f.actor.mutate).toHaveBeenCalledTimes(3);
});
it.each(["note", "credential", "attachment"] as const)(
  "round-trips %s data through signed encrypted revisions and local reads",
  async (kind) => {
    const f = fixture();
    f.client.session.bindRoot(await importKey(new Uint8Array(32).fill(6)), f.client.header!.generation[0]!);
    await f.client.authorize({ Normal: null }, [generation]);
    const plaintext = new TextEncoder().encode(
      kind === "credential"
        ? '{"username":"synthetic-user","password":"private-synthetic-password"}'
        : "private-synthetic-document-bytes",
    );
    const metadata = { kind, title: "private-synthetic-title" };
    await f.client.save(metadata, plaintext, undefined, () => {});
    const begin = f.operations[0].operation;
    if (!("BeginRevision" in begin)) throw Error("MissingRevision");
    const request = begin.BeginRevision;
    const revision = {
      vault: request.vault,
      object: request.object,
      revision: 1n,
      sequence: 1n,
      plain_size: request.plain_size,
      manifest: request.manifest,
      chunk_hashes: request.chunk_hashes,
      deleted: false,
    };
    const chunks = f.operations.flatMap((m) =>
      "PutChunk" in m.operation ? [m.operation.PutChunk.data] : [],
    );
    Object.assign(f.actor, {
      get_chunk: async (_v: unknown, _o: unknown, _r: unknown, i: number) => ({
        Ok: chunks[i],
      }),
      list_objects: async () => ({ Ok: { entries: [revision], next: [] } }),
    });
    const opened = await f.client.read(revision);
    expect(opened.metadata).toEqual(metadata);
    expect(opened.plaintext).toEqual(plaintext);
    opened.plaintext.fill(0);
    const items = await f.client.items();
    expect(items[0].metadata.title).toBe("private-synthetic-title");
    if (kind === "note")
      expect(items[0].searchText).toContain("private-synthetic-document-bytes");
    for (const [payload] of f.actor.mutate.mock.calls)
      expect(new TextDecoder().decode(payload)).not.toContain(
        "private-synthetic",
      );
  },
);
it("wipes an in-flight plaintext upload buffer immediately on lock", async () => {
  const f = fixture();
  f.client.session.bindRoot(await importKey(new Uint8Array(32)), f.client.header!.generation[0]!);
  await f.client.authorize({ Normal: null }, [generation]);
  let resolve!: (value: unknown) => void;
  f.actor.mutate.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }) as never,
  );
  const plaintext = new Uint8Array([9, 8, 7]),
    pending = f.client.save(
      { kind: "attachment", title: "Synthetic" },
      plaintext,
      undefined,
      () => {},
    );
  await vi.waitFor(() => expect(f.actor.mutate).toHaveBeenCalled());
  f.client.session.lock();
  expect([...plaintext]).toEqual([0, 0, 0]);
  resolve({
    Ok: { Upload: { id: new Uint8Array(16), revision: 1n, expires: 99n } },
  });
  await expect(pending).rejects.toThrow("Locked");
});
it("can authorize with the remaining passkey after ordinarily removing the selected passkey", async () => {
  const f = fixture();
  f.client.session.bindRoot(await importKey(new Uint8Array(32)), f.client.header!.generation[0]!);
  f.client.selectCredential(new Uint8Array([9]));
  await f.client.removeCredential(new Uint8Array([9]));
  f.actor.list_credentials.mockResolvedValue({
    Ok: [{ id: new Uint8Array([8]) }],
  });
  await f.client.authorize({ Normal: null }, [generation]);
  expect(f.actor.begin_grant.mock.calls.at(-1)?.[0]).toMatchObject({
    credential: new Uint8Array([8]),
  });
});
it("completes multiple cleanup batches under one fresh grant and advances the exact cursor", async () => {
  const f = fixture(),
    job = new Uint8Array(16).fill(5),
    begin_cleanup = vi.fn(async (_r: unknown) => ({
      Ok: {
        bytes: new Uint8Array(32),
        expires: 9999999999n,
        registration: false,
        credential_ids: [new Uint8Array([9])],
      },
    }));
  Object.assign(f.actor, {
    cleanup_status: async () => ({
      Ok: [{ job, cursor: 7n, complete: false }],
    }),
    begin_cleanup,
    finish_cleanup: async () => ({
      Ok: {
        id: new Uint8Array(32),
        expires: 9999999999n,
        next_counter: 0n,
        generations: [generation],
        purpose: { Cleanup: { job } },
      },
    }),
  });
  f.actor.mutate.mockImplementation(async (payload) => {
    const m = IDL.decode([mutationIDL], payload)[0] as unknown as Mutation;
    f.operations.push(m);
    return {
      Ok: {
        Cleanup: {
          job,
          cursor: BigInt(7 + f.operations.length),
          complete: f.operations.length === 2,
        },
      },
    } as never;
  });
  const result = await f.client.cleanup(header, true);
  expect(result.complete).toBe(true);
  expect(begin_cleanup).toHaveBeenCalledTimes(1);
  expect(
    f.operations.map((m) =>
      "Cleanup" in m.operation ? m.operation.Cleanup.cursor : undefined,
    ),
  ).toEqual([7n, 8n]);
});
it("stops cleanup on lock, drops late progress and resumes the stored cursor under fresh proof", async () => {
  const f = fixture(),
    job = new Uint8Array(16).fill(5);
  let cursor = 7n;
  const begin_cleanup = vi.fn(async (_r: unknown) => ({
    Ok: {
      bytes: new Uint8Array(32),
      expires: 9999999999n,
      registration: false,
      credential_ids: [new Uint8Array([9])],
    },
  }));
  Object.assign(f.actor, {
    cleanup_status: async () => ({ Ok: [{ job, cursor, complete: false }] }),
    begin_cleanup,
    finish_cleanup: async () => ({
      Ok: {
        id: new Uint8Array(32),
        expires: 9999999999n,
        next_counter: 0n,
        generations: [generation],
        purpose: { Cleanup: { job } },
      },
    }),
  });
  let resolve!: (x: unknown) => void;
  f.actor.mutate.mockImplementation(async (payload) => {
    const m = IDL.decode([mutationIDL], payload)[0] as unknown as Mutation;
    f.operations.push(m);
    cursor++;
    if (f.operations.length === 2)
      return new Promise((r) => {
        resolve = r;
      }) as never;
    return {
      Ok: { Cleanup: { job, cursor, complete: f.operations.length === 3 } },
    } as never;
  });
  const progress = vi.fn(),
    pending = f.client.cleanup(header, true, progress);
  await vi.waitFor(() => expect(f.actor.mutate).toHaveBeenCalledTimes(2));
  f.client.session.lock();
  resolve({ Ok: { Cleanup: { job, cursor: 9n, complete: false } } });
  await expect(pending).rejects.toThrow("Locked");
  expect(progress).toHaveBeenCalledTimes(1);
  const resumed = await f.client.cleanup(header, true);
  expect(resumed.complete).toBe(true);
  expect(begin_cleanup).toHaveBeenCalledTimes(2);
  expect(
    f.operations.map((m) =>
      "Cleanup" in m.operation ? m.operation.Cleanup.cursor : undefined,
    ),
  ).toEqual([7n, 8n, 9n]);
});
