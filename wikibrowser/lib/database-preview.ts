// Where: wikibrowser/lib/database-preview.ts
// What: Shared database link-preview metadata helpers.
// Why: Keep server-rendered page and image generation independent from canister latency.

export type DatabasePreview = {
  databaseId: string;
  databaseTitle: string;
  description: string;
  publicReadable: boolean;
};

export async function loadDatabasePreview(canisterId: string, databaseId: string): Promise<DatabasePreview> {
  const normalizedId = databaseId.trim() || "unknown database";
  if (canisterId) {
    try {
      const { listDatabasesPublic } = await import("@/lib/vfs-client");
      const database = (await listDatabasesPublic(canisterId)).find((item) => item.databaseId === normalizedId) ?? null;
      if (database) {
        return {
          databaseId: normalizedId,
          databaseTitle: database.metadata.name,
          description: database.metadata.description,
          publicReadable: true
        };
      }
    } catch {
      return unknownDatabasePreview(normalizedId);
    }
  }
  return unknownDatabasePreview(normalizedId);
}

export function databasePreviewTitle(databaseTitle: string): string {
  return `Kinic Wiki: ${databaseTitle}`;
}

export function databasePreviewDescription(preview: DatabasePreview): string {
  if (preview.publicReadable && preview.description.trim()) return preview.description;
  const subject = preview.publicReadable ? preview.databaseTitle : preview.databaseId;
  return `Browse, search, and query the ${subject} wiki database.`;
}

function unknownDatabasePreview(databaseId: string): DatabasePreview {
  return {
    databaseId,
    databaseTitle: databaseId,
    description: "",
    publicReadable: false
  };
}
