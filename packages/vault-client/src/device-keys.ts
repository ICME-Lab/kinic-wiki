/** Browser-local, non-extractable root handles. No II delegation or raw key bytes. */
export interface DeviceKeys {
  epoch(): Promise<number>;
  get(binding: string, epoch: number): Promise<CryptoKey | undefined>;
  put(binding: string, key: CryptoKey, epoch: number): Promise<boolean>;
  forget(): Promise<void>;
  remove(binding: string): Promise<void>;
  subscribe(listener: () => void): () => void;
}
type Entry = { id: string; scope: string; epoch?: number; key?: CryptoKey };
const DB_NAME = "kinic-vault-device-keys-v1";
export class BrowserDeviceKeys implements DeviceKeys {
  private readonly listeners = new Set<() => void>();
  private readonly channel?: BroadcastChannel;
  private poll?: number;
  constructor(private readonly scope: string) {
    if (typeof window !== "undefined" && typeof BroadcastChannel !== "undefined") {
      try {
        this.channel = new BroadcastChannel(DB_NAME);
        this.channel.onmessage = (event) => {
          if (event.data === this.scope) this.listeners.forEach((f) => f());
        };
      } catch { /* Restricted browsers use the epoch poll below. */ }
    }
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    if (!this.channel && typeof window !== "undefined" && this.poll === undefined) {
      let seen: number | undefined;
      const check = async () => {
        try {
          const current = await this.epoch();
          if (seen !== undefined && seen !== current) this.listeners.forEach((f) => f());
          seen = current;
        } catch { /* No persistent key exists when IndexedDB is unavailable. */ }
      };
      void check();
      this.poll = window.setInterval(() => void check(), 1000);
    }
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) {
        this.channel?.close();
        if (this.poll !== undefined) window.clearInterval(this.poll);
        this.poll = undefined;
      }
    };
  }
  private async database(): Promise<IDBDatabase> {
    if (typeof indexedDB === "undefined") throw Error("DeviceStorageUnavailable");
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("entries", { keyPath: "id" }).createIndex("scope", "scope");
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(Error("DeviceStorageBlocked"));
    });
  }
  private async transaction<T>(write: boolean, run: (store: IDBObjectStore, done: (value: T) => void) => void): Promise<T> {
    const db = await this.database();
    try {
      return await new Promise<T>((resolve, reject) => {
        const tx = db.transaction("entries", write ? "readwrite" : "readonly");
        let value: T;
        tx.oncomplete = () => resolve(value!);
        tx.onabort = () => reject(tx.error ?? Error("DeviceStorageAborted"));
        tx.onerror = () => reject(tx.error ?? Error("DeviceStorageFailed"));
        try { run(tx.objectStore("entries"), (v) => { value = v; }); }
        catch (cause) { tx.abort(); reject(cause); }
      });
    } finally { db.close(); }
  }
  private epochId() { return `epoch:${this.scope}`; }
  private keyId(binding: string) { return `key:${this.scope}:${binding}`; }
  async epoch() {
    return this.transaction<number>(false, (store, done) => {
      const r = store.get(this.epochId());
      r.onsuccess = () => done((r.result as Entry | undefined)?.epoch ?? 0);
    });
  }
  async get(binding: string, epoch: number) {
    return this.transaction<CryptoKey | undefined>(false, (store, done) => {
      const e = store.get(this.epochId());
      e.onsuccess = () => {
        if ((e.result?.epoch ?? 0) !== epoch) { done(undefined); return; }
        const r = store.get(this.keyId(binding));
        r.onsuccess = () => {
          const key = (r.result as Entry | undefined)?.key;
          done(key && key.type === "secret" && !key.extractable && key.algorithm.name === "AES-GCM" && (key.algorithm as AesKeyAlgorithm).length === 256
            && key.usages.includes("encrypt") && key.usages.includes("decrypt") ? key : undefined);
        };
      };
    });
  }
  async put(binding: string, key: CryptoKey, epoch: number) {
    if (key.extractable || key.algorithm.name !== "AES-GCM") throw Error("InvalidDeviceKey");
    return this.transaction<boolean>(true, (store, done) => {
      const r = store.get(this.epochId());
      r.onsuccess = () => {
        if ((r.result?.epoch ?? 0) !== epoch) { done(false); return; }
        store.put({ id: this.keyId(binding), scope: this.scope, key } satisfies Entry);
        done(true);
      };
    });
  }
  async remove(binding: string) {
    await this.transaction<void>(true, (store, done) => {
      store.delete(this.keyId(binding));
      done();
    });
  }
  async forget() {
    await this.transaction<void>(true, (store, done) => {
      const r = store.get(this.epochId());
      r.onsuccess = () => {
        const epoch = (r.result?.epoch ?? 0) + 1;
        const cursor = store.index("scope").openKeyCursor(IDBKeyRange.only(this.scope));
        cursor.onsuccess = () => {
          if (cursor.result) { store.delete(cursor.result.primaryKey); cursor.result.continue(); }
          else { store.put({ id: this.epochId(), scope: this.scope, epoch } satisfies Entry); done(); }
        };
      };
    });
    this.listeners.forEach((f) => f());
    this.channel?.postMessage(this.scope);
  }
}
