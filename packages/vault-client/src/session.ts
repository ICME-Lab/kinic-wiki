import { Principal } from "@icp-sdk/core/principal";
import type { Generation } from "./contracts";
import { authorityContext } from "./signed";
import type { TransportSecretKey } from "../../vault-crypto/src/index.ts";
export class Session {
  private lockCleanups = new Set<() => void>();
  addLockCleanup(cleanup: () => void) {
    this.lockCleanups.add(cleanup);
    return () => this.lockCleanups.delete(cleanup);
  }
  private controller = new AbortController();
  get signal() {
    return this.controller.signal;
  }
  transport?: TransportSecretKey;
  signer?: { destroy(): void };
  generation = 0;
  root?: CryptoKey;
  raw?: Uint8Array;
  private keyBinding?: Generation;
  bindRoot(root: CryptoKey, generation: Generation, raw?: Uint8Array) {
    this.keyBinding = this.copyGeneration(generation);
    this.root = root;
    if (this.raw && this.raw !== raw) this.raw.fill(0);
    this.raw = raw;
  }
  private copyGeneration(g: Generation): Generation {
    return {
      ...g,
      canister: Principal.fromUint8Array(
        new Uint8Array(g.canister.toUint8Array()),
      ),
      owner: Principal.fromUint8Array(new Uint8Array(g.owner.toUint8Array())),
      vault: new Uint8Array(g.vault),
      nonce: new Uint8Array(g.nonce),
    };
  }
  get keyGeneration() {
    return this.keyBinding && this.copyGeneration(this.keyBinding);
  }
  requireGeneration(g: Generation | undefined) {
    if (
      !this.root ||
      !g ||
      !this.keyBinding ||
      authorityContext(g) !== authorityContext(this.keyBinding)
    ) {
      this.lock();
      throw Error("TargetChanged");
    }
    return this.copyGeneration(this.keyBinding);
  }
  lastActivity = Date.now();
  hiddenAt?: number;
  urls = new Set<string>();
  onLock = () => {};
  capture() {
    return this.generation;
  }
  check(g: number) {
    if (g !== this.generation) throw Error("Locked");
    this.expire();
    if (g !== this.generation) throw Error("Locked");
  }
  lock() {
    this.generation++;
    for (const cleanup of this.lockCleanups) {
      try {
        cleanup();
      } catch {
        /* A detached view cannot prevent other private state from being cleared. */
      }
    }
    this.controller.abort();
    this.controller = new AbortController();
    this.lastActivity = Date.now();
    this.hiddenAt = this.hiddenAt === undefined ? undefined : Date.now();
    this.raw?.fill(0);
    this.raw = undefined;
    this.root = undefined;
    this.keyBinding = undefined;
    this.transport = undefined;
    this.signer?.destroy();
    this.signer = undefined;
    for (const u of this.urls) URL.revokeObjectURL(u);
    this.urls.clear();
    this.onLock();
  }
  expire(now = Date.now()) {
    if (
      now - this.lastActivity >= 300000 ||
      (this.hiddenAt !== undefined && now - this.hiddenAt >= 60000)
    )
      this.lock();
  }
  activity() {
    this.expire();
    this.lastActivity = Date.now();
  }
  visible(hidden: boolean) {
    this.expire();
    this.hiddenAt = hidden ? (this.hiddenAt ?? Date.now()) : undefined;
  }
  download(data: Uint8Array, name: string) {
    const u = URL.createObjectURL(new Blob([new Uint8Array(data).buffer]));
    this.urls.add(u);
    const a = document.createElement("a");
    a.href = u;
    a.download = name;
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(u);
      this.urls.delete(u);
    }, 30000);
  }
}
