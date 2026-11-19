import {
  IdbStorage,
  KEY_STORAGE_DELEGATION,
  KEY_STORAGE_KEY,
  type AuthClientStorage,
} from "@icp-sdk/auth/client";

// The pinned SDK also removes its legacy initialization vector on logout.
const sdkKeys: readonly string[] = [
  KEY_STORAGE_KEY,
  KEY_STORAGE_DELEGATION,
  "iv",
];
type Credential = Parameters<AuthClientStorage["set"]>[1];

// The SDK writes a delegation and then its signing key before calling onSuccess.
// Keep those writes private to this SDK instance until the provider accepts the
// attempt. The shared store retains the SDK's normal record format and names.
export class VaultAuthStorage implements AuthClientStorage {
  private readonly shared = new IdbStorage();
  private readonly credentials = new Map<string, Credential | null>();
  private readonly changes = new Map<string, Credential | null>();

  constructor(private readonly restore: boolean) {}

  async get(key: string) {
    if (!this.credentials.has(key)) {
      const value = this.restore
        ? await this.shared.get<Credential>(key)
        : null;
      this.credentials.set(key, value);
    }
    return this.credentials.get(key) ?? null;
  }

  async set(key: string, value: Credential) {
    this.credentials.set(key, value);
    this.changes.set(key, value);
  }

  async remove(key: string) {
    this.credentials.set(key, null);
    this.changes.set(key, null);
  }

  async publish() {
    // Called inside the partition credential lock. Preserve SDK startup writes
    // (including legacy migration and expiry cleanup) as well as login writes.
    const changes = [...this.changes];
    if (changes.some(([key]) => !sdkKeys.includes(key)))
      throw Error("Unsupported SDK credential record");
    this.changes.clear();
    try {
      for (const [key, value] of changes) {
        if (value === null) await this.shared.remove(key);
        else await this.shared.set(key, value);
      }
    } catch (error) {
      // A partial key/delegation pair must never become a restorable login.
      await this.clearShared();
      throw error;
    }
  }

  async clearShared() {
    await Promise.all(sdkKeys.map((key) => this.shared.remove(key)));
  }
}
