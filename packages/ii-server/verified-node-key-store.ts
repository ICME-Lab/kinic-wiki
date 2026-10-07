import type { HttpAgentOptions } from "@icp-sdk/core/agent";

type NodeKeyStore = NonNullable<HttpAgentOptions["subnetNodeKeyExpirableStore"]>;
type NodeKeys = NonNullable<Awaited<ReturnType<NodeKeyStore["get"]>>>;

// Only certificate-verified PUBLIC subnet keys live here. Identities, promises,
// actors and Wiki responses must remain request-local. Match the SDK's 5-minute
// TTL; signature verification failures invalidate this store through delete().
export class VerifiedNodeKeyStore implements NodeKeyStore {
  readonly expirationTime = 5 * 60_000;
  private readonly entries = new Map<string, { expires: number; value: NodeKeys }>();

  async get(key: string): Promise<NodeKeys | undefined> {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expires <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return structuredClone(entry.value);
  }

  async set(key: string, value: NodeKeys): Promise<void> {
    const now = Date.now();
    for (const [name, entry] of this.entries) {
      if (entry.expires <= now) this.entries.delete(name);
    }
    this.entries.delete(key);
    if (this.entries.size >= 16) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(key, { expires: now + this.expirationTime, value: structuredClone(value) });
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }
}

export const verifiedNodeKeys = new VerifiedNodeKeyStore();
