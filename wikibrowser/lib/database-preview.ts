// Where: wikibrowser/lib/database-preview.ts
// What: Shared database link-preview metadata helpers.
// Why: Keep server-rendered page and image generation independent from canister latency.

export type DatabasePreview = {
  databaseId: string;
  databaseName: string;
  publicReadable: boolean;
};

export async function loadDatabasePreview(_canisterId: string, databaseId: string): Promise<DatabasePreview> {
  const normalizedId = databaseId.trim() || "unknown database";
  return unknownDatabasePreview(normalizedId);
}

export function databasePreviewTitle(databaseName: string): string {
  return `Kinic Wiki: ${databaseName}`;
}

export function databasePreviewDescription(preview: DatabasePreview): string {
  const subject = preview.publicReadable ? preview.databaseName : preview.databaseId;
  return `Browse, search, and query the ${subject} wiki database.`;
}

function unknownDatabasePreview(databaseId: string): DatabasePreview {
  return {
    databaseId,
    databaseName: databaseId,
    publicReadable: false
  };
}
