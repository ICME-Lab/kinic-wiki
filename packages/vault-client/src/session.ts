import {
  contextInput,
  copyVaultContext,
  type VaultContext,
} from "@kinic/vault-crypto/context";
export const VAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

export class Session {
  private cleanups = new Set<() => void>();
  private binding?: VaultContext;
  private controller = new AbortController();
  generation = 0;
  root?: CryptoKey;
  lastActivity = Date.now();
  urls = new Set<string>();
  onLock = () => {};
  get signal() {
    return this.controller.signal;
  }
  addLockCleanup(f: () => void) {
    this.cleanups.add(f);
    return () => this.cleanups.delete(f);
  }
  capture() {
    return this.generation;
  }
  check(g: number) {
    this.expire();
    if (g !== this.generation) throw Error("Locked");
  }
  bindRoot(root: CryptoKey, context: VaultContext) {
    this.binding = copyVaultContext(context);
    this.root = root;
  }
  requireContext(context: VaultContext) {
    if (
      !this.root ||
      !this.binding ||
      !equal(contextInput(this.binding), contextInput(context))
    ) {
      this.lock();
      throw Error("TargetChanged");
    }
    return copyVaultContext(this.binding);
  }
  lock() {
    this.generation++;
    this.controller.abort();
    this.controller = new AbortController();
    for (const f of this.cleanups) {
      try {
        f();
      } catch {
        /* continue cleanup */
      }
    }
    this.binding = undefined;
    this.root = undefined;
    for (const url of this.urls) URL.revokeObjectURL(url);
    this.urls.clear();
    this.lastActivity = Date.now();
    this.onLock();
  }
  expire(now = Date.now()) {
    if (now - this.lastActivity >= VAULT_IDLE_TIMEOUT_MS) this.lock();
  }
  activity() {
    this.expire();
    this.lastActivity = Date.now();
  }
  visible(_hidden: boolean) {
    // Recheck on tab return, including when background timers were throttled.
    this.expire();
  }
  download(data: Uint8Array, name: string) {
    const url = URL.createObjectURL(new Blob([new Uint8Array(data).buffer]));
    this.urls.add(url);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      this.urls.delete(url);
    }, 30000);
  }
}
export function equal(a: Uint8Array, b: Uint8Array) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
