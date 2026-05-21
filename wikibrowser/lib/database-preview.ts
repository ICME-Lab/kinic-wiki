// Where: wikibrowser/lib/database-preview.ts
// What: Shared database link-preview metadata helpers.
// Why: Keep page metadata and generated social images aligned for database URLs.

import type { DatabaseSummary } from "@/lib/types";
import { listDatabasesPublic } from "@/lib/vfs-client";

const DATABASE_PREVIEW_LOOKUP_TIMEOUT_MS = 1_500;

export type DatabasePreview = {
  databaseId: string;
  databaseName: string;
  publicReadable: boolean;
};

export async function loadDatabasePreview(canisterId: string, databaseId: string): Promise<DatabasePreview> {
  const normalizedId = databaseId.trim() || "unknown database";
  if (!canisterId) return unknownDatabasePreview(normalizedId);
  try {
    const databases = await withTimeout(listDatabasesPublic(canisterId), DATABASE_PREVIEW_LOOKUP_TIMEOUT_MS);
    const database = databases.find((item) => item.databaseId === normalizedId) ?? null;
    return database ? publicDatabasePreview(database) : unknownDatabasePreview(normalizedId);
  } catch {
    return unknownDatabasePreview(normalizedId);
  }
}

export function databasePreviewTitle(databaseName: string): string {
  return `Kinic Wiki: ${databaseName}`;
}

export function databasePreviewDescription(preview: DatabasePreview): string {
  const subject = preview.publicReadable ? preview.databaseName : preview.databaseId;
  return `Browse, search, and query the ${subject} wiki database.`;
}

function publicDatabasePreview(database: DatabaseSummary): DatabasePreview {
  return {
    databaseId: database.databaseId,
    databaseName: database.name,
    publicReadable: true
  };
}

function unknownDatabasePreview(databaseId: string): DatabasePreview {
  return {
    databaseId,
    databaseName: databaseId,
    publicReadable: false
  };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("database preview lookup timed out")), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}
