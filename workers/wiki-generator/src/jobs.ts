// Where: workers/wiki-generator/src/jobs.ts
// What: D1 job/cursor state and Queue enqueue helpers.
// Why: Generation must be idempotent across explicit triggers and retries.
import type { SourceJob, SourceQueueMessage } from "./types.js";
import type { RuntimeEnv } from "./env.js";

export async function loadCursor(db: D1Database, databaseId: string, prefix: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT snapshot_revision FROM worker_cursors WHERE database_id = ?1 AND prefix = ?2")
    .bind(databaseId, prefix)
    .first<{ snapshot_revision: string }>();
  return row?.snapshot_revision ?? null;
}

export async function saveCursor(db: D1Database, databaseId: string, prefix: string, snapshotRevision: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO worker_cursors (database_id, prefix, snapshot_revision, updated_at)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(database_id, prefix)
       DO UPDATE SET snapshot_revision = excluded.snapshot_revision,
                     updated_at = excluded.updated_at`
    )
    .bind(databaseId, prefix, snapshotRevision, new Date().toISOString())
    .run();
}

export async function loadJob(db: D1Database, databaseId: string, sourcePath: string): Promise<SourceJob | null> {
  const row = await db
    .prepare(
      `SELECT database_id, source_path, source_etag, status, target_path,
              attempts, last_error, updated_at
       FROM source_jobs
       WHERE database_id = ?1 AND source_path = ?2`
    )
    .bind(databaseId, sourcePath)
    .first<SourceJob>();
  return row ?? null;
}

export function shouldSkipJob(job: SourceJob | null, sourceEtag: string): boolean {
  return job?.source_etag === sourceEtag && job.status === "completed";
}

export async function enqueueSourceJob(env: RuntimeEnv, message: SourceQueueMessage): Promise<boolean> {
  const job = await loadJob(env.DB, message.databaseId, message.sourcePath);
  if (shouldSkipJob(job, message.sourceEtag)) {
    return false;
  }
  await upsertQueuedJob(env.DB, message);
  await env.WIKI_GENERATION_QUEUE.send(message);
  return true;
}

export async function markProcessing(db: D1Database, message: SourceQueueMessage): Promise<void> {
  await db
    .prepare(
      `UPDATE source_jobs
       SET status = 'processing',
           attempts = attempts + 1,
           last_error = NULL,
           updated_at = ?1
       WHERE database_id = ?2 AND source_path = ?3`
    )
    .bind(new Date().toISOString(), message.databaseId, message.sourcePath)
    .run();
}

export async function markCompleted(db: D1Database, message: SourceQueueMessage, targetPath: string): Promise<void> {
  await db
    .prepare(
      `UPDATE source_jobs
       SET status = 'completed',
           source_etag = ?1,
           target_path = ?2,
           last_error = NULL,
           updated_at = ?3
       WHERE database_id = ?4 AND source_path = ?5`
    )
    .bind(message.sourceEtag, targetPath, new Date().toISOString(), message.databaseId, message.sourcePath)
    .run();
}

export async function markFailed(db: D1Database, message: SourceQueueMessage, error: string): Promise<void> {
  await db
    .prepare(
      `UPDATE source_jobs
       SET status = 'failed',
           source_etag = ?1,
           last_error = ?2,
           updated_at = ?3
       WHERE database_id = ?4 AND source_path = ?5`
    )
    .bind(message.sourceEtag, error.slice(0, 4000), new Date().toISOString(), message.databaseId, message.sourcePath)
    .run();
}

async function upsertQueuedJob(db: D1Database, message: SourceQueueMessage): Promise<void> {
  await db
    .prepare(
      `INSERT INTO source_jobs
       (database_id, source_path, source_etag, status, target_path, attempts, last_error, updated_at)
       VALUES (?1, ?2, ?3, 'queued', NULL, 0, NULL, ?4)
       ON CONFLICT(database_id, source_path)
       DO UPDATE SET source_etag = excluded.source_etag,
                     status = 'queued',
                     last_error = NULL,
                     updated_at = excluded.updated_at`
    )
    .bind(message.databaseId, message.sourcePath, message.sourceEtag, new Date().toISOString())
    .run();
}
