import type { Identity } from "@icp-sdk/core/agent";
import {
  TransportSecretKey,
  randomBytes,
} from "../../vault-crypto/src/index.ts";
import {
  copyVaultContext,
  verifiedRoot,
  type VaultContext,
} from "../../vault-crypto/src/context.ts";
import {
  encryptDocumentV3,
  decryptDocumentV3,
  readManifestV3,
  b64,
  type Metadata,
} from "../../vault-crypto/src/documents-v3.ts";
import type {
  Action,
  BeginRevision,
  Header,
  Mutation,
  MutationResult,
  Revision,
  VaultActor,
} from "./contracts.ts";
import { Session, equal } from "./session.ts";
export const bytes = (x: Uint8Array | number[]) => new Uint8Array(x);
export function ok<T>(r: { Ok: T } | { Err: unknown }): T {
  if ("Ok" in r) return r.Ok;
  throw Error(
    r.Err && typeof r.Err === "object"
      ? Object.keys(r.Err)[0]
      : "RequestFailed",
  );
}
export type Item = {
  revision: Revision;
  metadata: Metadata;
  searchText?: string;
};
type Save = {
  request: BeginRevision;
  chunks: Uint8Array[];
  phase: number;
  operation: Uint8Array;
  ticket: number;
  revision?: Revision;
};
export class VaultClient {
  readonly session = new Session();
  readonly actor: VaultActor;
  readonly identity: Identity;
  readonly canister: string;
  private local: boolean;
  private live = true;
  header?: Header;
  private pinnedPublicKey?: Uint8Array;
  private creating?: { vault: Uint8Array; operation: Uint8Array };
  private keyAttempt?: {
    vault: Uint8Array;
    operation: Uint8Array;
    transport: TransportSecretKey;
  };
  private pending?: Mutation;
  private saveJob?: Save;
  private cleanupJob?: {
    kind: "cancel" | "delete";
    vault: Uint8Array;
    upload?: Uint8Array;
    job: Uint8Array;
    operation: Uint8Array;
  };
  private flight?: object;
  private preparing?: object;
  private mutationFlight?: object;
  constructor(options: {
    actor: VaultActor;
    identity: Identity;
    canister: string;
    local: boolean;
  }) {
    if (options.identity.getPrincipal().isAnonymous())
      throw Error("Unauthorized");
    this.actor = options.actor;
    this.identity = options.identity;
    this.canister = options.canister;
    this.local = options.local;
    this.session.addLockCleanup(() => {
      this.keyAttempt = undefined;
      this.pinnedPublicKey = undefined;
      this.pending = undefined;
      this.cleanupJob = undefined;
      this.saveJob?.chunks.forEach((x) => x.fill(0));
      this.saveJob = undefined;
      this.flight = undefined;
      this.preparing = undefined;
      this.mutationFlight = undefined;
    });
  }
  destroy() {
    if (!this.live) return;
    this.live = false;
    this.session.lock();
    this.header = undefined;
    this.creating = undefined;
  }
  private checkLive() {
    if (!this.live) throw Error("NotSignedIn");
  }
  private context(h: Header): VaultContext {
    return copyVaultContext({
      canister: this.canister,
      owner: this.identity.getPrincipal().toText(),
      vault: bytes(h.id),
      nonce: bytes(h.nonce),
      key_name: h.key_name,
    });
  }
  async listVaults() {
    this.checkLive();
    const t = this.session.capture();
    const list = ok(await this.actor.list_vaults());
    this.session.check(t);
    return list;
  }
  async create() {
    this.checkLive();
    if (
      !this.creating ||
      (this.header && !equal(bytes(this.header.id), this.creating.vault))
    ) {
      this.session.lock();
      this.header = undefined;
    }
    const t = this.session.capture();
    const attempt = (this.creating ??= {
      vault: randomBytes(16),
      operation: randomBytes(16),
    });
    const h = ok(await this.actor.create_vault(attempt));
    this.session.check(t);
    if (!equal(bytes(h.id), attempt.vault)) throw Error("TargetChanged");
    this.header = structuredClone(h);
    this.creating = undefined;
    return structuredClone(h);
  }
  async open(header: Header) {
    this.checkLive();
    if (!this.header || !equal(bytes(this.header.id), bytes(header.id))) {
      this.session.lock();
      this.header = structuredClone(header);
    }
    const t = this.session.capture();
    const readHeader = async () => {
      const reply = await this.actor.get_vault_header(header.id);
      // An old response must never invalidate a newer selected context.
      this.session.check(t);
      if (
        "Err" in reply &&
        ("NotFound" in reply.Err || "Conflict" in reply.Err)
      ) {
        this.session.lock();
        throw Error("TargetChanged");
      }
      return structuredClone(ok(reply));
    };
    const h = await readHeader();
    this.session.check(t);
    if (!equal(bytes(h.id), bytes(header.id)) || !("Active" in h.state)) {
      this.session.lock();
      throw Error("TargetChanged");
    }
    let context: VaultContext;
    try {
      context = this.context(h);
    } catch {
      this.session.lock();
      throw Error("TargetChanged");
    }
    if (this.session.root) {
      this.session.requireContext(context);
      if (
        !this.pinnedPublicKey ||
        !equal(this.pinnedPublicKey, bytes(h.public_key))
      ) {
        this.session.lock();
        throw Error("TargetChanged");
      }
      this.header = h;
      return;
    }
    const attempt = (this.keyAttempt ??= {
      vault: bytes(h.id),
      operation: randomBytes(16),
      transport: TransportSecretKey.random(),
    });
    if (!equal(attempt.vault, bytes(h.id))) throw Error("TargetChanged");
    const reply = ok(
      await this.actor.derive_vault_key({
        vault: attempt.vault,
        operation: attempt.operation,
        transport: attempt.transport.publicKeyBytes(),
      }),
    );
    this.session.check(t);
    const root = await verifiedRoot(
      context,
      bytes(h.public_key),
      {
        input: bytes(reply.input),
        public_key: bytes(reply.public_key),
        encrypted_key: bytes(reply.encrypted_key),
      },
      attempt.transport,
      this.local,
    );
    this.session.check(t);
    const current = await readHeader();
    this.session.check(t);
    try {
      if (
        !("Active" in current.state) ||
        !equal(bytes(current.public_key), bytes(h.public_key)) ||
        !equalContext(context, this.context(current))
      )
        throw Error("TargetChanged");
    } catch {
      this.session.lock();
      throw Error("TargetChanged");
    }
    this.session.bindRoot(root, context);
    this.pinnedPublicKey = bytes(h.public_key);
    this.header = structuredClone(current);
    this.keyAttempt = undefined;
  }
  async refreshHeader() {
    this.checkLive();
    const t = this.session.capture();
    if (!this.header) throw Error("Locked");
    const response = await this.actor.get_vault_header(this.header.id);
    this.session.check(t);
    if (
      "Err" in response &&
      ("NotFound" in response.Err || "Conflict" in response.Err)
    ) {
      this.session.lock();
      throw Error("TargetChanged");
    }
    const h = ok(response);
    if (!("Active" in h.state)) {
      this.session.lock();
      throw Error("TargetChanged");
    }
    let context: VaultContext;
    try {
      context = this.context(h);
    } catch {
      this.session.lock();
      throw Error("TargetChanged");
    }
    this.session.requireContext(context);
    if (
      !this.pinnedPublicKey ||
      !equal(this.pinnedPublicKey, bytes(h.public_key))
    ) {
      this.session.lock();
      throw Error("TargetChanged");
    }
    this.header = structuredClone(h);
    return structuredClone(h);
  }
  private async checkedContext() {
    const t = this.session.capture();
    const h = await this.refreshHeader();
    this.session.check(t);
    return this.session.requireContext(this.context(h));
  }
  async mutate(
    action: Action,
    operation: Uint8Array = randomBytes(16),
  ): Promise<MutationResult> {
    this.checkLive();
    const proposed = structuredClone({ action, operation });
    if (this.pending && stable(this.pending) !== stable(proposed))
      throw Error("ResolvePendingMutation");
    if (this.mutationFlight) throw Error("MutationInProgress");
    const mutation = (this.pending ??= proposed);
    const t = this.session.capture();
    const flight = {};
    this.mutationFlight = flight;
    try {
      const result = await this.actor.mutate(mutation);
      this.session.check(t);
      this.pending = undefined;
      return ok(result);
    } finally {
      if (this.mutationFlight === flight) this.mutationFlight = undefined;
    }
  }
  async retryMutation() {
    if (!this.pending) throw Error("NoPendingMutation");
    return this.mutate(this.pending.action, bytes(this.pending.operation));
  }
  get hasPendingSave() {
    return !!this.saveJob;
  }
  async save(
    metadata: Metadata,
    plaintext: Uint8Array,
    item?: Item,
    progress: (n: number) => void = () => {},
  ) {
    if (this.saveJob || this.preparing) throw Error("SavePending");
    if (this.pending) throw Error("ResolvePendingMutation");
    const preparing = {};
    this.preparing = preparing;
    const detach = this.session.addLockCleanup(() => plaintext.fill(0));
    try {
      const t = this.session.capture();
      const context = await this.checkedContext();
      this.session.check(t);
      const object = item ? bytes(item.revision.object) : randomBytes(16),
        expected = item?.revision.revision ?? 0n;
      const doc = await encryptDocumentV3(
        this.session.root!,
        context,
        object,
        expected + 1n,
        metadata,
        plaintext,
      );
      this.session.check(t);
      const request = {
        vault: bytes(context.vault),
        object,
        expected_revision: expected,
        operation: randomBytes(16),
        plain_size: BigInt(plaintext.length),
        manifest: doc.manifest,
        chunk_hashes: doc.hashes,
      };
      this.saveJob = {
        request,
        chunks: doc.chunks,
        phase: -1,
        operation: randomBytes(16),
        ticket: t,
      };
    } finally {
      detach();
      if (this.preparing === preparing) this.preparing = undefined;
    }
    return this.resumeSave(progress);
  }
  async resumeSave(progress: (n: number) => void = () => {}) {
    const j = this.saveJob;
    if (!j) throw Error("NoPendingSave");
    if (this.flight) throw Error("SaveInProgress");
    const flight = {};
    this.flight = flight;
    try {
      await this.checkedContext();
      this.session.check(j.ticket);
      while (j.phase <= j.chunks.length) {
        const action: Action =
          j.phase === -1
            ? { BeginRevision: j.request }
            : j.phase < j.chunks.length
              ? {
                  PutChunk: {
                    upload: j.request.operation,
                    index: j.phase,
                    bytes: j.chunks[j.phase],
                  },
                }
              : { CommitRevision: { upload: j.request.operation } };
        const r = await this.mutate(action, j.operation);
        this.session.check(j.ticket);
        if (
          (j.phase === -1 && !("Upload" in r)) ||
          (j.phase >= 0 && j.phase < j.chunks.length && !("Done" in r)) ||
          (j.phase === j.chunks.length && !("Revision" in r))
        )
          throw Error("InvalidReceipt");
        if (
          "Upload" in r &&
          !equal(bytes(r.Upload.id), bytes(j.request.operation))
        )
          throw Error("InvalidReceipt");
        if ("Revision" in r) {
          if (
            !equal(bytes(r.Revision.vault), bytes(j.request.vault)) ||
            !equal(bytes(r.Revision.object), bytes(j.request.object)) ||
            r.Revision.revision !== j.request.expected_revision + 1n
          )
            throw Error("InvalidReceipt");
          j.revision = r.Revision;
        }
        j.phase++;
        j.operation = randomBytes(16);
        progress(
          Math.round(
            (Math.min(j.chunks.length, Math.max(0, j.phase)) /
              j.chunks.length) *
              100,
          ),
        );
      }
      const revision = j.revision;
      if (!revision) throw Error("InvalidReceipt");
      this.saveJob = undefined;
      return revision;
    } finally {
      if (this.flight === flight) this.flight = undefined;
    }
  }
  async items() {
    const t = this.session.capture();
    const c = await this.checkedContext();
    this.session.check(t);
    const items: Item[] = [];
    let after = new Uint8Array();
    do {
      const page = ok(await this.actor.list_objects(c.vault, after));
      this.session.check(t);
      for (const r of page.entries) {
        let source = r;
        if (r.deleted) {
          const history = ok(
            await this.actor.list_history(
              r.vault,
              r.object,
              18446744073709551615n,
            ),
          );
          this.session.check(t);
          const previous = history.entries.find((x) => !x.deleted);
          if (!previous) {
            items.push({
              revision: r,
              metadata: { kind: "note", title: "Deleted document" },
            });
            continue;
          }
          source = previous;
        }
        const parsed = await readManifestV3(
          this.session.root!,
          c,
          bytes(source.object),
          source.revision,
          bytes(source.manifest),
        );
        this.session.check(t);
        let searchText = parsed.metadata.title;
        if (parsed.metadata.kind === "note" && !r.deleted) {
          const doc = await this.read(r);
          try {
            this.session.check(t);
            searchText += " " + new TextDecoder().decode(doc.plaintext);
          } finally {
            doc.plaintext.fill(0);
          }
        }
        items.push({ revision: r, metadata: parsed.metadata, searchText });
      }
      after = page.next[0] ? bytes(page.next[0]) : new Uint8Array();
    } while (after.length);
    return items;
  }
  async read(r: Revision) {
    const t = this.session.capture();
    const c = await this.checkedContext();
    this.session.check(t);
    if (!equal(c.vault, bytes(r.vault))) throw Error("TargetChanged");
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < r.chunk_hashes.length; i++) {
      chunks.push(
        bytes(ok(await this.actor.get_chunk(r.vault, r.object, r.revision, i))),
      );
      this.session.check(t);
    }
    const doc = await decryptDocumentV3(
      this.session.root!,
      c,
      bytes(r.object),
      r.revision,
      bytes(r.manifest),
      chunks,
      r.chunk_hashes.map(bytes),
    );
    try {
      this.session.check(t);
      return doc;
    } catch (e) {
      doc.plaintext.fill(0);
      throw e;
    }
  }
  async deleteObject(r: Revision) {
    if (this.saveJob || this.preparing) throw Error("SavePending");
    const t = this.session.capture();
    const c = await this.checkedContext();
    this.session.check(t);
    if (!equal(c.vault, bytes(r.vault))) throw Error("TargetChanged");
    return this.mutate({
      DeleteObject: {
        vault: r.vault,
        object: r.object,
        expected_revision: r.revision,
      },
    });
  }
  async purgeObject(r: Revision) {
    if (this.saveJob || this.preparing) throw Error("SavePending");
    const t = this.session.capture();
    const c = await this.checkedContext();
    this.session.check(t);
    if (!equal(c.vault, bytes(r.vault))) throw Error("TargetChanged");
    return this.mutate({
      PurgeObject: {
        vault: r.vault,
        object: r.object,
        expected_revision: r.revision,
      },
    });
  }
  async history(r: Revision, before = 18446744073709551615n) {
    const t = this.session.capture();
    const c = await this.checkedContext();
    this.session.check(t);
    if (!equal(c.vault, bytes(r.vault))) throw Error("TargetChanged");
    const page = ok(await this.actor.list_history(r.vault, r.object, before));
    this.session.check(t);
    return page;
  }
  async quota() {
    const t = this.session.capture();
    const c = await this.checkedContext();
    this.session.check(t);
    const result = ok(await this.actor.get_quota(c.vault));
    this.session.check(t);
    return result;
  }
  async pendingUploads(after = new Uint8Array()) {
    this.checkLive();
    const t = this.session.capture();
    const result = ok(await this.actor.list_pending_uploads(after));
    this.session.check(t);
    return result;
  }
  async uploadStatus(upload: Uint8Array) {
    this.checkLive();
    const t = this.session.capture();
    const result = ok(await this.actor.get_upload_status(upload));
    this.session.check(t);
    return result;
  }
  async cancelSave() {
    const j = this.saveJob;
    if (!j) throw Error("NoPendingSave");
    if (this.flight) throw Error("SaveInProgress");
    const t = this.session.capture();
    if (this.pending) {
      await this.retryMutation();
      this.session.check(t);
    }
    const status = await this.uploadStatus(bytes(j.request.operation));
    this.session.check(t);
    if ("Pending" in status) {
      if (!equal(bytes(status.Pending.request.vault), bytes(j.request.vault)))
        throw Error("TargetChanged");
      await this.cancelUpload(
        bytes(j.request.vault),
        bytes(j.request.operation),
        status.Pending.cancel_job[0]
          ? bytes(status.Pending.cancel_job[0])
          : undefined,
      );
    }
    this.session.check(t);
    j.chunks.forEach((x) => x.fill(0));
    this.saveJob = undefined;
    this.cleanupJob = undefined;
    return status;
  }
  async cancelUpload(vault: Uint8Array, upload: Uint8Array, job?: Uint8Array) {
    this.checkLive();
    const j = (this.cleanupJob ??= {
      kind: "cancel",
      vault: bytes(vault),
      upload: bytes(upload),
      job: job ? bytes(job) : randomBytes(16),
      operation: randomBytes(16),
    });
    if (
      j.kind !== "cancel" ||
      !equal(j.vault, vault) ||
      !j.upload ||
      !equal(j.upload, upload) ||
      (job && !equal(j.job, job))
    )
      throw Error("ResolvePendingMutation");
    try {
      await this.cleanup(j);
    } catch (error) {
      if (!this.pending && this.cleanupJob === j) this.cleanupJob = undefined;
      throw error;
    }
  }
  async deleteVault(vault: Uint8Array) {
    this.checkLive();
    const t = this.session.capture();
    const j = (this.cleanupJob ??= {
      kind: "delete",
      vault: bytes(vault),
      job: randomBytes(16),
      operation: randomBytes(16),
    });
    if (j.kind !== "delete" || !equal(j.vault, vault))
      throw Error("ResolvePendingMutation");
    try {
      await this.cleanup(j);
    } catch (error) {
      if (!this.pending && this.cleanupJob === j) this.cleanupJob = undefined;
      throw error;
    }
    this.session.check(t);
    if (this.header && equal(bytes(this.header.id), vault)) {
      this.session.lock();
      this.header = undefined;
    }
  }
  private async cleanup(j: NonNullable<VaultClient["cleanupJob"]>) {
    const t = this.session.capture();
    for (;;) {
      const action: Action =
        j.kind === "cancel"
          ? { CancelUpload: { vault: j.vault, upload: j.upload!, job: j.job } }
          : { DeleteVault: { vault: j.vault } };
      const r = await this.mutate(action, j.operation);
      this.session.check(t);
      if (!("Progress" in r)) throw Error("InvalidReceipt");
      if (r.Progress) {
        this.cleanupJob = undefined;
        return;
      }
      j.operation = randomBytes(16);
    }
  }
  async collect() {
    try {
      return await this.mutate({ Collect: null });
    } catch (e) {
      if (e instanceof Error && e.message === "NotFound") return undefined;
      throw e;
    }
  }
}
function equalContext(a: VaultContext, b: VaultContext) {
  return (
    a.canister === b.canister &&
    a.owner === b.owner &&
    a.key_name === b.key_name &&
    equal(a.vault, b.vault) &&
    equal(a.nonce, b.nonce)
  );
}
function stable(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    typeof v === "bigint" ? `${v}n` : v instanceof Uint8Array ? b64(v) : v,
  );
}
