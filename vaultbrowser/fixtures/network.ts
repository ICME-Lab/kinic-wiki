// In-memory network fixture. Production routes never import this module.
import type {
  Header,
  Revision,
  BeginRevision,
  Mutation,
  MutationResult,
  PendingUploadSummary,
  VaultActor,
} from "@kinic/vault-client/contracts";
export const fixtureHeader = (value = 1): Header => ({
  id: new Uint8Array(16).fill(value),
  nonce: new Uint8Array(32).fill(value),
  public_key: new Uint8Array(96).fill(3),
  state: { Active: null },
  key_name: "test_key_1",
  sequence: 0n,
});
const key = (value: Uint8Array | number[]) => Array.from(value).join(",");
type NetworkMethods = {
  [K in keyof VaultActor]?: (
    ...args: Parameters<VaultActor[K]>
  ) => ReturnType<VaultActor[K]>;
};
export function fixtureNetwork() {
  const headers = [fixtureHeader(), fixtureHeader(2)];
  const revisions: Revision[] = [];
  const chunks = new Map<string, Uint8Array[]>();
  const uploads = new Map<string, BeginRevision>();
  const receipts = new Map<string, MutationResult>();
  const calls: Mutation[] = [];
  const creation: unknown[] = [];
  let balance = 50_000_000_000n;
  let lostPhase = "";
  let keyFailure = false;
  let createFailure = false;
  const result = (value: MutationResult) => ({ Ok: value });
  const actor = {
    get_config: async () => ({
      Ok: [{ minimum_cycles: 100_000_000_000n, key_name: "test_key_1" }],
    }),
    account_balance: async () => ({ Ok: balance }),
    global_capacity: async () => ({
      Ok: {
        used: 16777216n,
        limit: 209715200n,
        accounting_reserved: 16777216n,
        overcommitted: false,
        overage: 0n,
        legacy_excess: 0n,
      },
    }),
    list_payments: async () => ({ Ok: [] }),
    list_vaults: async () => ({ Ok: structuredClone(headers) }),
    create_vault: async (
      request: Parameters<VaultActor["create_vault"]>[0],
    ) => {
      creation.push(structuredClone(request));
      let h = headers.find((x) => key(x.id) === key(request.vault));
      if (!h) {
        h = { ...fixtureHeader(3), id: request.vault };
        headers.push(h);
      }
      if (createFailure) {
        createFailure = false;
        throw Error("network");
      }
      return { Ok: structuredClone(h) };
    },
    get_vault_header: async (vault: Uint8Array | number[]) => {
      const h = headers.find((x) => key(x.id) === key(vault));
      return h ? { Ok: structuredClone(h) } : { Err: { NotFound: null } };
    },
    derive_vault_key: async () => {
      if (keyFailure) throw Error("KeyService");
      return { Ok: { input: [], public_key: [], encrypted_key: [] } };
    },
    get_quota: async () => ({
      Ok: { current: 0n, charged: 100n, reserved: 0n, limit: 104857600n },
    }),
    list_pending_uploads: async () => ({
      Ok: {
        entries: Array.from(uploads.values()).map(
          (r): PendingUploadSummary => ({
            vault: r.vault,
            upload: r.operation,
            cancel_job: [],
            expires: 0n,
          }),
        ),
        next: [],
      },
    }),
    get_upload_status: async (upload: Uint8Array | number[]) => {
      const request = uploads.get(key(upload));
      return {
        Ok: request
          ? { Pending: { request, cancel_job: [], received: [], expires: 0n } }
          : { Absent: null },
      };
    },
    list_objects: async (vault: Uint8Array | number[]) => {
      const latest = new Map<string, Revision>();
      for (const r of revisions)
        if (key(r.vault) === key(vault)) latest.set(key(r.object), r);
      return {
        Ok: { entries: structuredClone([...latest.values()]), next: [] },
      };
    },
    list_history: async (
      vault: Uint8Array | number[],
      object: Uint8Array | number[],
      before: bigint,
    ) => ({
      Ok: {
        entries: structuredClone(
          revisions
            .filter(
              (r) =>
                key(r.vault) === key(vault) &&
                key(r.object) === key(object) &&
                r.revision < before,
            )
            .reverse(),
        ),
        next: [],
      },
    }),
    get_chunk: async (
      vault: Uint8Array | number[],
      object: Uint8Array | number[],
      revision: bigint,
      index: number,
    ) => ({
      Ok: chunks.get(`${key(vault)}:${key(object)}:${revision}`)![index],
    }),
    mutate: async (m: Mutation) => {
      calls.push(structuredClone(m));
      const receipt = receipts.get(key(m.operation));
      if (receipt) return result(receipt);
      const a = m.action;
      let value: MutationResult = { Done: null };
      if ("BeginRevision" in a) {
        const r = a.BeginRevision;
        const latest = revisions
          .filter(
            (x) =>
              key(x.vault) === key(r.vault) && key(x.object) === key(r.object),
          )
          .at(-1);
        if ((latest?.revision ?? 0n) !== r.expected_revision)
          return { Err: { Conflict: null } };
        uploads.set(key(r.operation), r);
        chunks.set(key(r.operation), []);
        value = {
          Upload: {
            id: r.operation,
            revision: r.expected_revision + 1n,
            expires: 0n,
          },
        };
      }
      if ("PutChunk" in a)
        chunks.get(key(a.PutChunk.upload))![a.PutChunk.index] = new Uint8Array(
          a.PutChunk.bytes,
        );
      if ("CommitRevision" in a) {
        const r = uploads.get(key(a.CommitRevision.upload))!;
        const revision: Revision = {
          vault: r.vault,
          object: r.object,
          revision: r.expected_revision + 1n,
          sequence: 1n,
          plain_size: r.plain_size,
          manifest: r.manifest,
          chunk_hashes: r.chunk_hashes,
          deleted: false,
        };
        revisions.push(revision);
        chunks.set(
          `${key(r.vault)}:${key(r.object)}:${revision.revision}`,
          chunks.get(key(r.operation))!,
        );
        uploads.delete(key(r.operation));
        value = { Revision: revision };
      }
      if ("DeleteObject" in a) {
        const previous = revisions
          .filter(
            (r) =>
              key(r.vault) === key(a.DeleteObject.vault) &&
              key(r.object) === key(a.DeleteObject.object),
          )
          .at(-1)!;
        if (previous.revision !== a.DeleteObject.expected_revision)
          return { Err: { Conflict: null } };
        const next = {
          ...previous,
          revision: previous.revision + 1n,
          deleted: true,
        };
        revisions.push(next);
        value = { Revision: next };
      }
      if ("PurgeObject" in a) {
        for (let i = revisions.length - 1; i >= 0; i--)
          if (
            key(revisions[i].vault) === key(a.PurgeObject.vault) &&
            key(revisions[i].object) === key(a.PurgeObject.object)
          )
            revisions.splice(i, 1);
      }
      if ("CancelUpload" in a) {
        uploads.delete(key(a.CancelUpload.upload));
        value = { Progress: true };
      }
      if ("DeleteVault" in a) {
        const i = headers.findIndex(
          (h) => key(h.id) === key(a.DeleteVault.vault),
        );
        if (i >= 0) headers.splice(i, 1);
        value = { Progress: true };
      }
      receipts.set(key(m.operation), structuredClone(value));
      if (lostPhase && lostPhase in a) {
        lostPhase = "";
        throw Error("network");
      }
      return result(value);
    },
  } satisfies NetworkMethods;
  return {
    actor: actor as unknown as VaultActor,
    headers,
    revisions,
    calls,
    creation,
    uploads,
    setBalance: (n: bigint) => {
      balance = n;
    },
    lose: (phase: string) => {
      lostPhase = phase;
    },
    failKey: (fail: boolean) => {
      keyFailure = fail;
    },
    loseCreate: () => {
      createFailure = true;
    },
  };
}
