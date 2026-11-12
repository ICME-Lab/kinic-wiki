/** RAM-only encrypted job. A lock destroys it; no plaintext, File or root is retained. */
import type {
  BeginRevision,
  Generation,
  MutationResult,
  Revision,
  VaultActor,
} from "./contracts";
import { Session } from "./session";
import { OrdinaryAuthority } from "./ordinary";
import { authorityContext } from "./signed";
import { ok } from "./api";
type Job = {
  request: BeginRevision;
  chunks: Uint8Array[];
  generation: Generation;
  ticket: number;
  phase: "begin" | "chunks" | "commit" | "refresh";
  next: number;
  reconcile: boolean;
  cancelling: boolean;
  revision?: Revision;
};
export class SaveWorkflow {
  private job?: Job;
  private flight?: object;
  constructor(
    private session: Session,
    private actor: () => VaultActor,
    private authority: () => OrdinaryAuthority,
    private refresh: () => Promise<unknown>,
  ) {
    session.addLockCleanup(() => this.clear());
  }
  get pending() {
    return !!this.job;
  }
  get upload() {
    return this.job && new Uint8Array(this.job.request.operation);
  }
  get cancelling() {
    return this.job?.cancelling ?? false;
  }
  clear() {
    this.job?.chunks.forEach((c) => c.fill(0));
    if (this.job?.request.manifest instanceof Uint8Array)
      this.job.request.manifest.fill(0);
    this.job = undefined;
    this.flight = undefined;
    // A late coroutine is fenced by its captured session ticket and cannot clear a new flight.
  }
  start(request: BeginRevision, chunks: Uint8Array[], generation: Generation) {
    if (this.job || this.flight) throw Error("SavePending");
    this.job = {
      request,
      chunks,
      generation: this.session.requireGeneration(generation),
      ticket: this.session.capture(),
      phase: "begin",
      next: 0,
      reconcile: false,
      cancelling: false,
    };
  }
  private check(j: Job) {
    this.session.check(j.ticket);
    this.session.requireGeneration(j.generation);
    if (this.job !== j) throw Error("Locked");
  }
  private advance(j: Job, r: MutationResult) {
    if (j.phase === "begin") {
      if (!("Upload" in r)) throw Error("MissingUpload");
      j.phase = "chunks";
    } else if (j.phase === "chunks") {
      if (!("Unit" in r)) throw Error("MissingChunkReceipt");
      j.next++;
    } else if (j.phase === "commit") {
      if (!("Revision" in r)) throw Error("MissingRevision");
      j.revision = r.Revision;
      j.phase = "refresh";
    }
  }
  async resolvePending() {
    const j = this.job;
    if (!j) throw Error("NoPendingSave");
    this.check(j);
    if (this.authority().hasPending) {
      try {
        const result = await this.authority().retry();
        this.check(j);
        if (!j.cancelling) this.advance(j, result);
      } catch (error) {
        this.check(j);
        if (this.authority().hasPending) throw error;
        // A definitive rejection permits authoritative reconciliation, never blind re-signing.
      }
    }
  }
  markCancelling() {
    if (this.job) {
      this.job.cancelling = true;
      this.job.reconcile = true;
    }
  }
  private async reconcile(j: Job) {
    const status = ok(
      await this.actor().get_upload_status(j.request.operation),
    );
    this.check(j);
    if ("Pending" in status) {
      const p = status.Pending;
      if (authorityContext(p.request) !== authorityContext(j.request))
        throw Error("UploadConflict");
      if (p.cancel_job.length) {
        j.cancelling = true;
        throw Error("UploadCancelling");
      }
      j.cancelling = false;
      const have = new Set(p.received);
      j.next = 0;
      while (have.has(j.next)) j.next++;
      if (
        j.next > j.chunks.length ||
        p.received.some((i) => i >= j.chunks.length)
      )
        throw Error("InvalidUploadStatus");
      j.phase = j.next === j.chunks.length ? "commit" : "chunks";
    } else if ("Committed" in status) {
      const c = status.Committed;
      if (
        authorityContext(c.vault) !== authorityContext(j.request.vault) ||
        authorityContext(c.object) !== authorityContext(j.request.object) ||
        c.revision !== j.request.expected_revision + 1n
      )
        throw Error("UploadConflict");
      // The receipt outlives readable history. Match ordinary commit's compact result.
      j.revision = {
        vault: new Uint8Array(c.vault),
        object: new Uint8Array(c.object),
        revision: c.revision,
        sequence: c.sequence,
        plain_size: j.request.plain_size,
        deleted: false,
        manifest: new Uint8Array(),
        chunk_hashes: [],
      };
      j.phase = "refresh";
    } else if ("Absent" in status) {
      j.phase = "begin";
      j.next = 0;
    } else
      throw Error("Cancelled" in status ? "UploadCancelled" : "UploadExpired");
  }
  async resume(progress: (n: number) => void = () => {}): Promise<Revision> {
    const j = this.job;
    if (!j) throw Error("NoPendingSave");
    if (this.flight) throw Error("SaveInProgress");
    const flight = {};
    this.flight = flight;
    try {
      this.check(j);
      await this.resolvePending();
      await this.refresh();
      this.check(j);
      if (j.reconcile && j.phase !== "refresh") await this.reconcile(j);
      j.reconcile = false;
      for (;;) {
        this.check(j);
        if (
          j.phase !== "refresh" &&
          !this.authority().canReuseNormal(j.generation)
        ) {
          await this.reconcile(j);
          this.check(j);
        }
        if (j.phase === "chunks" && j.next === j.chunks.length)
          j.phase = "commit";
        if (j.phase === "refresh") {
          await this.refresh();
          this.check(j);
          if (!j.revision) throw Error("MissingRevision");
          const revision = j.revision;
          this.clear();
          return revision;
        }
        const op =
          j.phase === "begin"
            ? { BeginRevision: j.request }
            : j.phase === "chunks"
              ? {
                  PutChunk: {
                    vault: j.request.vault,
                    upload: j.request.operation,
                    index: j.next,
                    data: j.chunks[j.next],
                  },
                }
              : {
                  CommitRevision: {
                    vault: j.request.vault,
                    upload: j.request.operation,
                  },
                };
        const result = await this.authority().normalSend(op, j.generation);
        this.check(j);
        this.advance(j, result);
        progress(Math.round((j.next / j.chunks.length) * 100));
      }
    } catch (error) {
      if (this.job === j) j.reconcile = true;
      throw error;
    } finally {
      if (this.flight === flight) this.flight = undefined;
    }
  }
}
