import type { Identity } from "@icp-sdk/core/agent";
import { TransportSecretKey, randomBytes } from "@kinic/vault-crypto";
import {
  copyVaultContext,
  contextInput,
  verifiedRoot,
  type VaultContext,
} from "@kinic/vault-crypto/context";
import {
  encryptDocumentV3,
  decryptDocumentV3,
  readManifestV3,
  b64,
  hash,
  type Metadata,
} from "@kinic/vault-crypto/documents";
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
};
type Save = {
  request: BeginRevision;
  chunks: Uint8Array[];
  phase: number;
  operation: Uint8Array;
  ticket: number;
  revision?: Revision;
  contextHash?: Uint8Array;
  uncertain?: boolean;
};
type RequestState =
  { kind: "idle" } | { kind: "sending" | "ambiguous"; mutation: Mutation };
type SaveState =
  | { kind: "idle" }
  | { kind: "preparing" }
  | { kind: "ready" | "sending" | "cancelling"; job: Save };
type CleanupJob = {
  vault: Uint8Array;
  operation: Uint8Array;
} & (
  { kind: "cancel"; upload: Uint8Array; job: Uint8Array } | { kind: "delete" }
);

export class VaultClient {
  readonly session = new Session();
  readonly actor: VaultActor;
  readonly identity: Identity;
  readonly canister: string;
  private local: boolean;
  private searchReads = new Set<Promise<void>>();
  private live = true;
  header?: Header;
  private pinnedPublicKey?: Uint8Array;
  private creating?: { operation: Uint8Array };
  private keyAttempt?: {
    vault: Uint8Array;
    operation: Uint8Array;
    transport: TransportSecretKey;
  };
  private request: RequestState = { kind: "idle" };
  private saveState: SaveState = { kind: "idle" };
  private cleanupState: { kind: "idle" } | CleanupJob = { kind: "idle" };
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
      this.request = { kind: "idle" };
      this.cleanupState = { kind: "idle" };
      this.pendingSave?.chunks.forEach((x) => x.fill(0));
      this.saveState = { kind: "idle" };
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
  async reconcilePurchase(operation: Uint8Array) {
    this.checkLive();
    const ticket = this.session.capture();
    const owner = this.identity.getPrincipal().toText();
    const request = new Uint8Array(operation);
    const result = await this.actor.reconcile_purchase(request);
    this.session.check(ticket);
    this.checkLive();
    if (owner !== this.identity.getPrincipal().toText())
      throw Error("TargetChanged");
    const progress = ok(result);
    if (
      progress.payment.wallet.toText() !== owner ||
      !equal(bytes(progress.payment.request.operation), request)
    )
      throw Error("InvalidReceipt");
    return progress;
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
    if (!this.creating || this.header) {
      this.session.lock();
      this.header = undefined;
    }
    const t = this.session.capture();
    const attempt = (this.creating ??= {
      operation: randomBytes(16),
    });
    const h = ok(
      await this.actor.create_vault({ operation: bytes(attempt.operation) }),
    );
    this.session.check(t);
    if (bytes(h.id).length !== 16) throw Error("TargetChanged");
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
  private cachedContext() {
    this.checkLive();
    this.session.check(this.session.capture());
    if (!this.header) throw Error("Locked");
    if (
      !("Active" in this.header.state) ||
      !this.pinnedPublicKey ||
      !equal(this.pinnedPublicKey, bytes(this.header.public_key))
    ) {
      this.session.lock();
      throw Error("TargetChanged");
    }
    let context: VaultContext;
    try {
      context = this.context(this.header);
    } catch {
      this.session.lock();
      throw Error("TargetChanged");
    }
    return this.session.requireContext(context);
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
    const previous = this.request;
    if (
      previous.kind !== "idle" &&
      stable(previous.mutation) !== stable(proposed)
    )
      throw Error("ResolvePendingMutation");
    if (previous.kind === "sending") throw Error("MutationInProgress");
    const mutation = previous.kind === "idle" ? proposed : previous.mutation;
    const t = this.session.capture();
    const sending: RequestState = { kind: "sending", mutation };
    this.request = sending;
    try {
      const result = await this.actor.mutate(mutation);
      this.session.check(t);
      this.request = { kind: "idle" };
      return ok(result);
    } finally {
      // A transport failure preserves the exact request; a delivered Err clears it.
      // An older callback must never replace a newer session's request.
      if (this.request === sending)
        this.request = { kind: "ambiguous", mutation };
    }
  }
  async retryMutation() {
    if (this.request.kind === "idle") throw Error("NoPendingMutation");
    const { mutation } = this.request;
    return this.mutate(mutation.action, bytes(mutation.operation));
  }
  private get pendingSave() {
    return "job" in this.saveState ? this.saveState.job : undefined;
  }
  get hasPendingSave() {
    return !!this.pendingSave;
  }
  async save(
    metadata: Metadata,
    plaintext: Uint8Array,
    item?: Item,
    progress: (n: number) => void = () => {},
  ) {
    if (this.saveState.kind !== "idle") throw Error("SavePending");
    if (this.request.kind !== "idle") throw Error("ResolvePendingMutation");
    const preparing: SaveState = { kind: "preparing" };
    this.saveState = preparing;
    const detach = this.session.addLockCleanup(() => plaintext.fill(0));
    try {
      const t = this.session.capture();
      const inline = plaintext.length <= 256 * 1024;
      const context = inline ? this.cachedContext() : await this.checkedContext();
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
      const contextHash = inline ? await hash(contextInput(context)) : undefined;
      this.session.check(t);
      this.saveState = {
        kind: "ready",
        job: {
          request,
          chunks: doc.chunks,
          phase: inline ? doc.chunks.length : -1,
          contextHash,
          operation: randomBytes(16),
          ticket: t,
        },
      };
    } finally {
      detach();
      if (this.saveState === preparing) this.saveState = { kind: "idle" };
    }
    return this.resumeSave(progress);
  }
  async resumeSave(progress: (n: number) => void = () => {}) {
    const j = this.pendingSave;
    if (!j) throw Error("NoPendingSave");
    if (this.saveState.kind !== "ready") throw Error("SaveInProgress");
    const sending: SaveState = { kind: "sending", job: j };
    this.saveState = sending;
    try {
      if (j.contextHash) this.cachedContext();
      else await this.checkedContext();
      this.session.check(j.ticket);
      while (j.phase <= j.chunks.length) {
        const action: Action =
          j.contextHash
            ? {
                SaveInline: {
                  request: j.request,
                  bytes: j.chunks[0],
                  context_hash: j.contextHash,
                },
              }
            : j.phase === -1
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
        const wasAmbiguous = j.uncertain || this.request.kind === "ambiguous";
        let r: MutationResult;
        try {
          r = await this.mutate(action, j.operation);
        } catch (error) {
          // A retry's rejection cannot establish the historical outcome of a
          // request whose earlier response was lost, even after receipt GC.
          const unresolvedReceipt = !!wasAmbiguous;
          j.uncertain ||=
            this.request.kind === "ambiguous" || unresolvedReceipt;
          if (j.contextHash && unresolvedReceipt) {
            try {
              const ownedRequest = this.ownedInlineRequest(j);
              const revision = await this.reconciledInline(j);
              this.session.check(j.ticket);
              if (this.request === ownedRequest) this.request = { kind: "idle" };
              this.saveState = { kind: "idle" };
              progress(100);
              return revision;
            } catch {
              this.session.check(j.ticket);
            }
          }
          if (
            j.contextHash &&
            this.request.kind === "idle" &&
            this.saveState === sending &&
            !unresolvedReceipt
          ) {
            j.chunks.forEach((chunk) => chunk.fill(0));
            this.saveState = { kind: "idle" };
          }
          throw error;
        }
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
      this.saveState = { kind: "idle" };
      return revision;
    } finally {
      if (this.saveState === sending)
        this.saveState = { kind: "ready", job: j };
    }
  }
  private ownedInlineRequest(j: Save): RequestState | undefined {
    const request = this.request;
    if (request.kind === "sending") return undefined;
    if (request.kind === "idle") return request;
    const expected = {
      action: {
        SaveInline: {
          request: j.request,
          bytes: j.chunks[0],
          context_hash: j.contextHash,
        },
      },
      operation: j.operation,
    };
    return stable(request.mutation) === stable(expected) ? request : undefined;
  }
  // Authenticated immutable revision lookup remains usable after both kinds
  // of receipt are collected. Match the full encrypted payload, not just IDs.
  private async reconciledInline(j: Save): Promise<Revision> {
    const response = await this.actor.get_manifest(
      j.request.vault,
      j.request.object,
      j.request.expected_revision + 1n,
    );
    this.session.check(j.ticket);
    const r = ok(response);
    if (
      r.deleted ||
      r.sequence <= 0n ||
      !equal(bytes(r.vault), bytes(j.request.vault)) ||
      !equal(bytes(r.object), bytes(j.request.object)) ||
      r.revision !== j.request.expected_revision + 1n ||
      r.plain_size !== j.request.plain_size ||
      !equal(bytes(r.manifest), bytes(j.request.manifest)) ||
      r.chunk_hashes.length !== j.request.chunk_hashes.length ||
      r.chunk_hashes.some(
        (h, i) => !equal(bytes(h), bytes(j.request.chunk_hashes[i])),
      )
    )
      throw Error("InvalidReceipt");
    return r;
  }
  async items() {
    const t = this.session.capture();
    const c = await this.checkedContext();
    this.session.check(t);
    const root = this.session.root!;
    const items: Item[] = [];
    let after = new Uint8Array();
    do {
      this.checkReadContext(c, root, t);
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
        this.checkReadContext(c, root, t);
        const parsed = await readManifestV3(
          root,
          c,
          bytes(source.object),
          source.revision,
          bytes(source.manifest),
        );
        this.session.check(t);
        items.push({ revision: r, metadata: parsed.metadata });
      }
      after = page.next[0] ? bytes(page.next[0]) : new Uint8Array();
    } while (after.length);
    return items;
  }
  // Explicit note-only search. Results contain metadata/revisions, never body text.
  // Shared slots also bound requests left in flight by a cancelled search.
  async searchNotes(
    items: readonly Item[],
    query: string,
    options: {
      signal?: AbortSignal;
      onProgress?: (progress: { completed: number; total: number }) => void;
    } = {},
  ): Promise<Item[]> {
    const ticket = this.session.capture();
    this.cachedContext();
    const controller = new AbortController();
    const sessionSignal = this.session.signal;
    const stop = () => controller.abort();
    options.signal?.addEventListener("abort", stop, { once: true });
    sessionSignal.addEventListener("abort", stop, { once: true });
    if (options.signal?.aborted || sessionSignal.aborted) stop();
    const check = () => {
      this.session.check(ticket);
      if (controller.signal.aborted) throw Error("SearchCancelled");
    };
    let rejectAbort!: (cause: Error) => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
    });
    const onAbort = () => {
      rejectAbort(
        Error(this.session.capture() !== ticket ? "Locked" : "SearchCancelled"),
      );
    };
    controller.signal.addEventListener("abort", onAbort, { once: true });
    const notes = items.filter(
      (item) => item.metadata.kind === "note" && !item.revision.deleted,
    );
    const needle = query.trim().toLocaleLowerCase();
    const matches = new Set<Item>();
    let next = 0,
      completed = 0;
    const worker = async () => {
      while (next < notes.length && needle) {
        check();
        while (this.searchReads.size >= 2) {
          await Promise.race([...this.searchReads, aborted]);
          check();
        }
        const item = notes[next++];
        if (!item) return;
        const pending = this.read(item.revision, { signal: controller.signal });
        const slot = pending.then(
          () => {},
          () => {},
        );
        this.searchReads.add(slot);
        void slot.then(() => this.searchReads.delete(slot));
        const doc = await pending;
        try {
          check();
          if (
            new TextDecoder()
              .decode(doc.plaintext)
              .toLocaleLowerCase()
              .includes(needle)
          )
            matches.add(item);
        } finally {
          doc.plaintext.fill(0);
        }
        check();
        options.onProgress?.({ completed: ++completed, total: notes.length });
      }
    };
    try {
      check();
      options.onProgress?.({ completed: 0, total: needle ? notes.length : 0 });
      await Promise.race([Promise.all([worker(), worker()]), aborted]);
      check();
      return notes.filter((item) => matches.has(item));
    } finally {
      options.signal?.removeEventListener("abort", stop);
      sessionSignal.removeEventListener("abort", stop);
      controller.signal.removeEventListener("abort", onAbort);
      controller.abort();
      matches.clear();
    }
  }
  private checkReadContext(c: VaultContext, root: CryptoKey, t: number) {
    this.session.check(t);
    this.checkLive();
    this.session.requireContext(c);
    if (this.session.root !== root) throw Error("TargetChanged");
  }
  async read(r: Revision, options: { signal?: AbortSignal } = {}) {
    const t = this.session.capture();
    const check = () => {
      this.session.check(t);
      if (options.signal?.aborted) throw Error("SearchCancelled");
    };
    check();
    const c = await this.checkedContext();
    const root = this.session.root!;
    check();
    this.checkReadContext(c, root, t);
    if (!equal(c.vault, bytes(r.vault))) throw Error("TargetChanged");
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < r.chunk_hashes.length; i++) {
      this.checkReadContext(c, root, t);
      const reply = await this.actor.get_chunk(
        r.vault,
        r.object,
        r.revision,
        i,
      );
      this.checkReadContext(c, root, t);
      chunks.push(bytes(ok(reply)));
      check();
    }
    this.checkReadContext(c, root, t);
    const doc = await decryptDocumentV3(
      root,
      c,
      bytes(r.object),
      r.revision,
      bytes(r.manifest),
      chunks,
      r.chunk_hashes.map(bytes),
    );
    try {
      this.checkReadContext(c, root, t);
      check();
      return doc;
    } catch (e) {
      doc.plaintext.fill(0);
      throw e;
    }
  }
  async deleteObject(r: Revision) {
    if (this.saveState.kind !== "idle") throw Error("SavePending");
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
    if (this.saveState.kind !== "idle") throw Error("SavePending");
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
    const j = this.pendingSave;
    if (!j) throw Error("NoPendingSave");
    if (this.saveState.kind !== "ready") throw Error("SaveInProgress");
    const cancelling: SaveState = { kind: "cancelling", job: j };
    this.saveState = cancelling;
    const cleanup = this.cleanupState;
    try {
      const t = this.session.capture();
      if (j.contextHash && (j.uncertain || this.request.kind === "ambiguous")) {
        const ownedRequest = this.ownedInlineRequest(j);
        const revision = await this.reconciledInline(j);
        this.session.check(t);
        if (this.request === ownedRequest) this.request = { kind: "idle" };
        j.chunks.forEach((chunk) => chunk.fill(0));
        this.saveState = { kind: "idle" };
        return {
          Committed: {
            vault: revision.vault,
            object: revision.object,
            revision: revision.revision,
            sequence: revision.sequence,
          },
        };
      }
      if (this.request.kind !== "idle") {
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
      if (this.saveState === cancelling) this.saveState = { kind: "idle" };
      // Replaying a lost final CancelUpload can report a terminal status without
      // re-entering cleanup(). Release that job, never another resource's retry.
      if (
        this.cleanupState === cleanup &&
        cleanup.kind === "cancel" &&
        equal(cleanup.vault, bytes(j.request.vault)) &&
        equal(cleanup.upload, bytes(j.request.operation))
      )
        this.cleanupState = { kind: "idle" };
      return status;
    } finally {
      if (this.saveState === cancelling)
        this.saveState = { kind: "ready", job: j };
    }
  }
  async cancelUpload(vault: Uint8Array, upload: Uint8Array, job?: Uint8Array) {
    this.checkLive();
    if (this.cleanupState.kind === "idle")
      this.cleanupState = {
        kind: "cancel",
        vault: bytes(vault),
        upload: bytes(upload),
        job: job ? bytes(job) : randomBytes(16),
        operation: randomBytes(16),
      };
    const j = this.cleanupState;
    if (
      j.kind !== "cancel" ||
      !equal(j.vault, vault) ||
      !equal(j.upload, upload) ||
      (job && !equal(j.job, job))
    )
      throw Error("ResolvePendingMutation");
    try {
      await this.cleanup(j);
    } catch (error) {
      if (this.request.kind === "idle" && this.cleanupState === j)
        this.cleanupState = { kind: "idle" };
      throw error;
    }
  }
  async deleteVault(vault: Uint8Array) {
    this.checkLive();
    const t = this.session.capture();
    if (this.cleanupState.kind === "idle")
      this.cleanupState = {
        kind: "delete",
        vault: bytes(vault),
        operation: randomBytes(16),
      };
    const j = this.cleanupState;
    if (j.kind !== "delete" || !equal(j.vault, vault))
      throw Error("ResolvePendingMutation");
    try {
      await this.cleanup(j);
    } catch (error) {
      if (this.request.kind === "idle" && this.cleanupState === j)
        this.cleanupState = { kind: "idle" };
      throw error;
    }
    this.session.check(t);
    if (this.header && equal(bytes(this.header.id), vault)) {
      this.session.lock();
      this.header = undefined;
    }
  }
  private async cleanup(j: CleanupJob) {
    const t = this.session.capture();
    for (;;) {
      const action: Action =
        j.kind === "cancel"
          ? { CancelUpload: { vault: j.vault, upload: j.upload, job: j.job } }
          : { DeleteVault: { vault: j.vault } };
      const r = await this.mutate(action, j.operation);
      this.session.check(t);
      if (!("Progress" in r)) throw Error("InvalidReceipt");
      if (r.Progress) {
        this.cleanupState = { kind: "idle" };
        return;
      }
      j.operation = randomBytes(16);
    }
  }
  async collect() {
    try {
      return await this.mutate(
        { Collect: null },
        this.request.kind !== "idle" &&
          "Collect" in this.request.mutation.action
          ? bytes(this.request.mutation.operation)
          : undefined,
      );
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
