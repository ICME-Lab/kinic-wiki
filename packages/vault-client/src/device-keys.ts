/** Browser-local, non-extractable root handles. No II delegation or raw key bytes. */
export interface DeviceKeys {
  epoch(): Promise<number>;
  get(binding: string, epoch: number): Promise<CryptoKey | undefined>;
  put(
    binding: string,
    key: CryptoKey,
    epoch: number,
    signal?: AbortSignal,
    writeId?: string,
  ): Promise<boolean>;
  forget(): Promise<void>;
  removeVault(vault: Uint8Array, epoch?: number): Promise<void>;
  rollback(binding: string, writeId: string): Promise<void>;
  subscribe(listener: () => void): () => void;
}
// The original v3 binding encodes five length-prefixed context fields. Looking
// up the third field lets a denied fresh view evict this Vault without knowing
// its owner or changing the stored record format.
export function bindingTargetsVault(
  binding: string,
  vault: Uint8Array,
): boolean {
  try {
    const [input, , version] = JSON.parse(binding);
    if (version !== "root/v3" || !Array.isArray(input)) return false;
    const encoded = Uint8Array.from(input);
    const lengths = new DataView(encoded.buffer);
    let offset = 0;
    for (let field = 0; field < 2; field++)
      offset += 4 + lengths.getUint32(offset);
    return (
      lengths.getUint32(offset) === vault.length &&
      vault.every((byte, index) => byte === encoded[offset + 4 + index])
    );
  } catch {
    return false;
  }
}
type Entry = {
  id: string;
  scope: string;
  epoch?: number;
  key?: CryptoKey;
  writeId?: string;
};
const DB_NAME = "kinic-vault-device-keys-v1";
export class BrowserDeviceKeys implements DeviceKeys {
  private readonly listeners = new Set<() => void>();
  private channel?: BroadcastChannel;
  private poll?: number;
  constructor(private readonly scope: string) {
    if (
      typeof window !== "undefined" &&
      typeof BroadcastChannel !== "undefined"
    ) {
      try {
        this.channel = new BroadcastChannel(DB_NAME);
        this.channel.onmessage = (event) => {
          if (event.data === this.scope) this.listeners.forEach((f) => f());
        };
      } catch {
        /* Restricted browsers use the epoch poll below. */
      }
    }
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    if (
      !this.channel &&
      typeof window !== "undefined" &&
      this.poll === undefined
    ) {
      let seen: number | undefined;
      const check = async () => {
        try {
          const current = await this.epoch();
          if (seen !== undefined && seen !== current)
            this.listeners.forEach((f) => f());
          seen = current;
        } catch {
          /* No persistent key exists when IndexedDB is unavailable. */
        }
      };
      void check();
      this.poll = window.setInterval(() => void check(), 1000);
    }
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) {
        this.channel?.close();
        this.channel = undefined;
        if (this.poll !== undefined) window.clearInterval(this.poll);
        this.poll = undefined;
      }
    };
  }
  private async database(): Promise<IDBDatabase> {
    if (typeof indexedDB === "undefined")
      throw Error("DeviceStorageUnavailable");
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        request.result
          .createObjectStore("entries", { keyPath: "id" })
          .createIndex("scope", "scope");
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(Error("DeviceStorageBlocked"));
    });
  }
  private async transaction<T>(
    write: boolean,
    run: (store: IDBObjectStore, done: (value: T) => void) => void,
    signal?: AbortSignal,
  ): Promise<T> {
    const db = await this.database();
    try {
      signal?.throwIfAborted();
      return await new Promise<T>((resolve, reject) => {
        const tx = db.transaction("entries", write ? "readwrite" : "readonly");
        let value: T;
        const abort = () => {
          try {
            tx.abort();
          } catch {
            /* Already committed. The caller checks the session again. */
          }
        };
        signal?.addEventListener("abort", abort, { once: true });
        tx.oncomplete = () => {
          signal?.removeEventListener("abort", abort);
          resolve(value!);
        };
        tx.onabort = () => {
          signal?.removeEventListener("abort", abort);
          reject(tx.error ?? Error("DeviceStorageAborted"));
        };
        tx.onerror = () => reject(tx.error ?? Error("DeviceStorageFailed"));
        try {
          run(tx.objectStore("entries"), (v) => {
            value = v;
          });
        } catch (cause) {
          tx.abort();
          reject(cause);
        }
      });
    } finally {
      db.close();
    }
  }
  private epochId() {
    return `epoch:${this.scope}`;
  }
  private keyId(binding: string) {
    return `key:${this.scope}:${binding}`;
  }
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
        if ((e.result?.epoch ?? 0) !== epoch) {
          done(undefined);
          return;
        }
        const r = store.get(this.keyId(binding));
        r.onsuccess = () => {
          const key = (r.result as Entry | undefined)?.key;
          done(
            key &&
              key.type === "secret" &&
              !key.extractable &&
              key.algorithm.name === "AES-GCM" &&
              (key.algorithm as AesKeyAlgorithm).length === 256 &&
              key.usages.includes("encrypt") &&
              key.usages.includes("decrypt")
              ? key
              : undefined,
          );
        };
      };
    });
  }
  async put(
    binding: string,
    key: CryptoKey,
    epoch: number,
    signal?: AbortSignal,
    writeId?: string,
  ) {
    if (key.extractable || key.algorithm.name !== "AES-GCM")
      throw Error("InvalidDeviceKey");
    return this.transaction<boolean>(
      true,
      (store, done) => {
        const r = store.get(this.epochId());
        r.onsuccess = () => {
          if ((r.result?.epoch ?? 0) !== epoch) {
            done(false);
            return;
          }
          store.put({
            id: this.keyId(binding),
            scope: this.scope,
            key,
            ...(writeId === undefined ? {} : { writeId }),
          } satisfies Entry);
          done(true);
        };
      },
      signal,
    );
  }
  async rollback(binding: string, writeId: string) {
    await this.transaction<void>(true, (store, done) => {
      const id = this.keyId(binding);
      const request = store.get(id);
      request.onsuccess = () => {
        if ((request.result as Entry | undefined)?.writeId === writeId)
          store.delete(id);
        done();
      };
    });
  }
  async removeVault(vault: Uint8Array, epoch?: number) {
    await this.transaction<void>(true, (store, done) => {
      const current = store.get(this.epochId());
      current.onsuccess = () => {
        if (epoch !== undefined && (current.result?.epoch ?? 0) !== epoch) {
          done();
          return;
        }
        const cursor = store
          .index("scope")
          .openKeyCursor(IDBKeyRange.only(this.scope));
        const prefix = this.keyId("");
        cursor.onsuccess = () => {
          const entry = cursor.result;
          if (!entry) {
            done();
            return;
          }
          const id = entry.primaryKey;
          if (
            typeof id === "string" &&
            id.startsWith(prefix) &&
            bindingTargetsVault(id.slice(prefix.length), vault)
          )
            store.delete(id);
          entry.continue();
        };
      };
    });
  }
  async forget() {
    await this.transaction<void>(true, (store, done) => {
      const r = store.get(this.epochId());
      r.onsuccess = () => {
        const epoch = (r.result?.epoch ?? 0) + 1;
        const cursor = store
          .index("scope")
          .openKeyCursor(IDBKeyRange.only(this.scope));
        cursor.onsuccess = () => {
          if (cursor.result) {
            store.delete(cursor.result.primaryKey);
            cursor.result.continue();
          } else {
            store.put({
              id: this.epochId(),
              scope: this.scope,
              epoch,
            } satisfies Entry);
            done();
          }
        };
      };
    });
    this.listeners.forEach((f) => f());
    if (this.channel) this.channel.postMessage(this.scope);
    else if (
      typeof window !== "undefined" &&
      typeof BroadcastChannel !== "undefined"
    ) {
      // Sign-out may dispose this view while the forget transaction commits.
      // The committed epoch must still reach the other open views.
      try {
        const channel = new BroadcastChannel(DB_NAME);
        channel.postMessage(this.scope);
        channel.close();
      } catch {
        /* Restricted contexts observe the epoch through polling. */
      }
    }
  }
}
