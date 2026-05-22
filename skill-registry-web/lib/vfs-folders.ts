import type { Identity } from "@icp-sdk/core/agent";
import { mkdirNodeAuthenticated } from "@/lib/vfs-client";

export async function ensureParentFoldersAuthenticated(canisterId: string, databaseId: string, identity: Identity, path: string): Promise<void> {
  const segments = path.split("/").filter(Boolean);
  let current = "";
  for (const segment of segments.slice(0, -1)) {
    current = `${current}/${segment}`;
    await mkdirNodeAuthenticated(canisterId, identity, { databaseId, path: current });
  }
}
