// In-memory network fixture. Production routes never import this module.
import type {
  Header,
  Revision,
  BeginRevision,
  Mutation,
  MutationResult,
  PendingUploadSummary,
  VaultActor,
  AccessRole,
  VaultAccess,
  VaultMember,
} from "@kinic/vault-client/contracts";
import { Principal } from "@icp-sdk/core/principal";
import { hash } from "@kinic/vault-crypto/documents";
export const fixtureHeader = (value = 1): Header => ({
  id: new Uint8Array(16).fill(value),
  nonce: new Uint8Array(32).fill(value),
  public_key: new Uint8Array(96).fill(3),
  state: { Active: null },
  key_name: "test_key_1",
  sequence: 0n,
  name: [],
});
const key = (value: Uint8Array | number[]) => Array.from(value).join(",");
type NetworkMethods = {
  [K in keyof VaultActor]?: (
    ...args: Parameters<VaultActor[K]>
  ) => ReturnType<VaultActor[K]>;
};
export function fixtureNetwork(
  owner = Principal.selfAuthenticating(new Uint8Array([1])),
  sharedOwner = Principal.selfAuthenticating(new Uint8Array([2])),
) {
  const roles = new Map<string, AccessRole | null>();
  const membership = new Map<string, VaultMember[]>();
  const headers = [fixtureHeader(), fixtureHeader(2)];
  const revisions: Revision[] = [];
  const chunks = new Map<string, Uint8Array[]>();
  const uploads = new Map<string, BeginRevision>();
  const receipts = new Map<string, MutationResult>();
  const calls: Mutation[] = [];
  const creation: unknown[] = [];
  const created = new Map<string, Header>();
  let serial = 2n;
  let balance = 50_000_000_000n;
  let firstKeyFree = false;
  let lostPhase = "";
  let keyFailure = false;
  let createFailure = false;
  const result = (value: MutationResult) => ({ Ok: value });
  const actor = {
    get_config: async () => ({
      Ok: [{ minimum_cycles: 100_000_000_000n, key_name: "test_key_1" }],
    }),
    account_balance: async () => ({ Ok: balance }),
    initialize_vault_account: async () => ({ Ok: { balance, grant_cycles: 0n } }),
    vault_key_cost: async () => ({ Ok: { fee: 26_153_846_153n, owner_fee: firstKeyFree ? 0n : 26_153_846_153n, first_key_free: firstKeyFree } }),
    global_capacity: async () => ({
      Ok: {
        used: 19922944n,
        limit: 209715200n,
        accounting_reserved: 19922944n,
        overcommitted: false,
        overage: 0n,
      },
    }),
    list_payments: async () => ({ Ok: [] }),
    list_vaults: async () => ({ Ok: structuredClone(headers.filter((header) => !roles.has(key(header.id)))) }),
    create_vault: async (
      request: Parameters<VaultActor["create_vault"]>[0],
    ) => {
      creation.push(structuredClone(request));
      let h = created.get(key(request.operation));
      if (!h) {
        const assigned = new Uint8Array(16);
        new DataView(assigned.buffer).setBigUint64(8, ++serial);
        h = { ...fixtureHeader(3), id: assigned };
        created.set(key(request.operation), h);
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
      firstKeyFree = false;
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
    get_manifest: async (vault, object, revision) => {
      const found = revisions
        .filter(
          (r) =>
            key(r.vault) === key(vault) &&
            key(r.object) === key(object) &&
            (revision === 0n || r.revision === revision),
        )
        .at(-1);
      return found
        ? { Ok: structuredClone(found) }
        : { Err: { NotFound: null } };
    },
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
      if ("RenameVault" in a) {
        const request = a.RenameVault;
        const header = headers.find(h => key(h.id) === key(request.vault));
        if (!header) return { Err: { NotFound: null } };
        if (header.sequence !== request.expected_sequence) return { Err: { Conflict: null } };
        if (!request.name.trim() || Array.from(request.name.trim()).length > 64) return { Err: { InvalidInput: null } };
        header.name = [request.name.trim()];
        header.sequence++;
      }
      if ("SaveInline" in a) {
        const { request: r, bytes: ciphertext, context_hash } = a.SaveInline;
        const h = headers.find((h) => key(h.id) === key(r.vault));
        if (!h || !("Active" in h.state)) return { Err: { NotFound: null } };
        if (
          r.plain_size > 262144n ||
          r.plain_size < 0n ||
          ciphertext.length !== Number(r.plain_size) + 16 ||
          r.chunk_hashes.length !== 1 ||
          context_hash.length !== 32 ||
          key(await hash(new Uint8Array(ciphertext))) !== key(r.chunk_hashes[0])
        )
          return { Err: { InvalidInput: null } };
        const latest = revisions
          .filter(
            (x) =>
              key(x.vault) === key(r.vault) && key(x.object) === key(r.object),
          )
          .at(-1);
        if ((latest?.revision ?? 0n) !== r.expected_revision)
          return { Err: { Conflict: null } };
        const revision: Revision = {
          vault: r.vault,
          object: r.object,
          revision: r.expected_revision + 1n,
          sequence: ++h.sequence,
          plain_size: r.plain_size,
          manifest: r.manifest,
          chunk_hashes: r.chunk_hashes,
          deleted: false,
        };
        revisions.push(structuredClone(revision));
        chunks.set(`${key(r.vault)}:${key(r.object)}:${revision.revision}`, [
          new Uint8Array(ciphertext),
        ]);
        value = { Revision: revision };
      }
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
  const access = (vault: Header["id"]): VaultAccess | undefined => {
    const h = headers.find((h) => key(h.id) === key(vault));
    const role = roles.get(key(vault));
    if (!h || role === null || (role && !("Active" in h.state))) return;
    return {
      header: structuredClone(h),
      owner: role ? sharedOwner : owner,
      role: role ?? { Owner: null },
    };
  };
  const denied = { Err: { Unauthorized: null } } as const;
  const shared = {
    get_vault_access: async (vault) => {
      const a = access(vault);
      return a && "Active" in a.header.state ? { Ok: a } : denied;
    },
    list_accessible_vaults: async (after) => {
      const entries = headers
        .map((h) => access(h.id))
        .filter((a) => a !== undefined);
      const offset = after.length
        ? entries.findIndex((a) => key(a.header.id) === key(after)) + 1
        : 0;
      const page = entries.slice(offset, offset + 20);
      return {
        Ok: {
          entries: page,
          next: offset + 20 < entries.length ? [page.at(-1)!.header.id] : [],
        },
      };
    },
    list_vault_members: async (vault) => {
      const a = access(vault);
      return a && "Owner" in a.role
        ? { Ok: membership.get(key(vault)) ?? [] }
        : denied;
    },
    set_vault_member: async (vault, principal, role) => {
      const a = access(vault);
      if (!a || !("Owner" in a.role) || "Owner" in role) return denied;
      const members = (membership.get(key(vault)) ?? []).filter(
        (m) => m.principal.toText() !== principal.toText(),
      );
      membership.set(key(vault), [...members, { principal, role }]);
      return { Ok: null };
    },
    remove_vault_member: async (vault, principal) => {
      const a = access(vault);
      if (!a || !("Owner" in a.role)) return denied;
      membership.set(
        key(vault),
        (membership.get(key(vault)) ?? []).filter(
          (m) => m.principal.toText() !== principal.toText(),
        ),
      );
      return { Ok: null };
    },
    shared_derive_vault_key: (request) =>
      access(request.vault)
        ? actor.derive_vault_key()
        : Promise.resolve(denied),
    shared_list_objects: (vault) =>
      access(vault) ? actor.list_objects(vault) : Promise.resolve(denied),
    shared_get_manifest: (vault, object, revision) =>
      access(vault)
        ? actor.get_manifest(vault, object, revision)
        : Promise.resolve(denied),
    shared_get_chunk: (vault, object, revision, index) =>
      access(vault)
        ? actor.get_chunk(vault, object, revision, index)
        : Promise.resolve(denied),
    shared_list_history: (vault, object, before) =>
      access(vault)
        ? actor.list_history(vault, object, before)
        : Promise.resolve(denied),
    shared_get_quota: (vault) =>
      access(vault) ? actor.get_quota() : Promise.resolve(denied),
    shared_get_upload_status: async (vault, upload) => {
      if (!access(vault)) return denied;
      const status = await actor.get_upload_status(upload);
      if (
        "Pending" in status.Ok &&
        key(status.Ok.Pending!.request.vault) !== key(vault)
      )
        return denied;
      return status;
    },
    shared_list_pending_uploads: async (vault) => {
      if (!access(vault)) return denied;
      const { Ok } = await actor.list_pending_uploads();
      return {
        Ok: {
          ...Ok,
          entries: Ok.entries.filter(
            (entry) => key(entry.vault) === key(vault),
          ),
        },
      };
    },
    shared_mutate: async (vault, mutation) => {
      const a = access(vault);
      if (!a || "Viewer" in a.role) return denied;
      const action = mutation.action;
      const target =
        "SaveInline" in action
          ? action.SaveInline.request.vault
          : "BeginRevision" in action
            ? action.BeginRevision.vault
            : "PutChunk" in action
              ? uploads.get(key(action.PutChunk.upload))?.vault
              : "CommitRevision" in action
                ? uploads.get(key(action.CommitRevision.upload))?.vault
                : "CancelUpload" in action
                  ? action.CancelUpload.vault
                  : "DeleteObject" in action
                    ? action.DeleteObject.vault
                    : undefined;
      return target && key(target) === key(vault)
        ? actor.mutate(mutation)
        : denied;
    },
  } satisfies NetworkMethods;
  return {
    actor: { ...actor, ...shared } as unknown as VaultActor,
    sharedOwner,
    setRole: (vault: Header["id"], role: AccessRole | null) => {
      roles.set(key(vault), role);
    },
    headers,
    revisions,
    calls,
    creation,
    uploads,
    setFirstKeyFree: (value: boolean) => { firstKeyFree = value; },
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
