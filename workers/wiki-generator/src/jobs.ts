// Where: workers/wiki-generator/src/jobs.ts
// What: D1 job/cursor state, execution leases, checkpoints, and Queue enqueue helpers.
// Why: At-least-once delivery and concurrent consumers must not buy duplicate generations.
import type { SourceJob, SourceQueueMessage } from "./types.js";
import type { RuntimeEnv } from "./env.js";

const LEASE_MS = 5 * 60 * 1000;
const SOURCE_JOB_COLUMNS = `database_id, source_path, source_etag, status, target_path,
  attempts, last_error, lease_owner, lease_expires_at, generated_target_path,
  generated_content, generated_context_paths, llm_duration_ms, updated_at`;

export type GeneratedArtifact = {
  targetPath: string;
  content: string;
  contextPaths: string[];
  llmDurationMs: number;
};

export type SourceJobClaim =
  | { kind: "generate" }
  | { kind: "resume"; artifact: GeneratedArtifact }
  | { kind: "completed"; targetPath: string }
  | { kind: "failed"; error: string }
  | { kind: "busy"; retryAfterSeconds: number }
  | { kind: "superseded"; job: SourceJob | null };

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
  return (
    (await db
      .prepare(`SELECT ${SOURCE_JOB_COLUMNS} FROM source_jobs WHERE database_id = ?1 AND source_path = ?2`)
      .bind(databaseId, sourcePath)
      .first<SourceJob>()) ?? null
  );
}

export function shouldSkipJob(job: SourceJob | null, sourceEtag: string): boolean {
  return job?.source_etag === sourceEtag && job.status === "completed";
}

export async function enqueueSourceJob(env: RuntimeEnv, message: SourceQueueMessage): Promise<boolean> {
  const job = await loadJob(env.DB, message.databaseId, message.sourcePath);
  if (shouldSkipJob(job, message.sourceEtag)) return false;
  await upsertQueuedJob(env.DB, message);
  await env.WIKI_GENERATION_QUEUE.send(message);
  return true;
}

export async function claimSourceJob(
  db: D1Database,
  message: SourceQueueMessage,
  owner: string,
  now = new Date()
): Promise<SourceJobClaim> {
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + LEASE_MS).toISOString();
  const claimed = await db
    .prepare(
      `UPDATE source_jobs
       SET status = CASE WHEN status = 'generated' THEN 'generated' ELSE 'processing' END,
           lease_owner = ?4,
           lease_expires_at = ?5,
           attempts = attempts + 1,
           last_error = NULL,
           updated_at = ?6
       WHERE database_id = ?1
         AND source_path = ?2
         AND source_etag = ?3
         AND status IN ('queued', 'processing', 'generated')
         AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ?6)
       RETURNING ${SOURCE_JOB_COLUMNS}`
    )
    .bind(message.databaseId, message.sourcePath, message.sourceEtag, owner, expiresAt, nowIso)
    .first<SourceJob>();
  if (claimed) {
    if (claimed.status !== "generated") return { kind: "generate" };
    try {
      return { kind: "resume", artifact: artifactFromJob(claimed) };
    } catch {
      const messageText = "generated source job checkpoint is invalid";
      await markFailed(db, message, owner, messageText, now);
      return { kind: "failed", error: messageText };
    }
  }

  const current = await loadJob(db, message.databaseId, message.sourcePath);
  if (!current || current.source_etag !== message.sourceEtag) return { kind: "superseded", job: current };
  if (current.status === "completed" && current.target_path) return { kind: "completed", targetPath: current.target_path };
  if (current.status === "failed") return { kind: "failed", error: current.last_error ?? "source generation failed" };
  return { kind: "busy", retryAfterSeconds: leaseRetryDelay(current.lease_expires_at, now) };
}

export async function checkpointGenerated(
  db: D1Database,
  message: SourceQueueMessage,
  owner: string,
  artifact: GeneratedArtifact,
  now = new Date()
): Promise<void> {
  const updated = await db
    .prepare(
      `UPDATE source_jobs
       SET status = 'generated',
           generated_target_path = ?4,
           generated_content = ?5,
           generated_context_paths = ?6,
           llm_duration_ms = ?7,
           updated_at = ?8
       WHERE database_id = ?1 AND source_path = ?2 AND source_etag = ?3
         AND status = 'processing' AND lease_owner = ?9
       RETURNING database_id`
    )
    .bind(
      message.databaseId,
      message.sourcePath,
      message.sourceEtag,
      artifact.targetPath,
      artifact.content,
      JSON.stringify(artifact.contextPaths),
      artifact.llmDurationMs,
      now.toISOString(),
      owner
    )
    .first<{ database_id: string }>();
  if (!updated) throw new Error("source generation checkpoint lease was lost");
}

export async function markCompleted(db: D1Database, message: SourceQueueMessage, owner: string, targetPath: string, now = new Date()): Promise<void> {
  const updated = await db
    .prepare(
      `UPDATE source_jobs
       SET status = 'completed', target_path = ?4, last_error = NULL,
           lease_owner = NULL, lease_expires_at = NULL,
           generated_target_path = NULL, generated_content = NULL,
           generated_context_paths = NULL, updated_at = ?5
       WHERE database_id = ?1 AND source_path = ?2 AND source_etag = ?3
         AND status = 'generated' AND lease_owner = ?6
       RETURNING database_id`
    )
    .bind(message.databaseId, message.sourcePath, message.sourceEtag, targetPath, now.toISOString(), owner)
    .first<{ database_id: string }>();
  if (!updated) throw new Error("source generation completion lease was lost");
}

export async function releaseForRetry(
  db: D1Database,
  message: SourceQueueMessage,
  owner: string,
  error: string,
  now = new Date()
): Promise<void> {
  const updated = await db
    .prepare(
      `UPDATE source_jobs
       SET status = CASE WHEN status = 'generated' THEN 'generated' ELSE 'queued' END,
           lease_owner = NULL, lease_expires_at = NULL, last_error = ?4, updated_at = ?5
       WHERE database_id = ?1 AND source_path = ?2 AND source_etag = ?3
         AND status IN ('processing', 'generated') AND lease_owner = ?6
       RETURNING database_id`
    )
    .bind(message.databaseId, message.sourcePath, message.sourceEtag, sanitizeError(error), now.toISOString(), owner)
    .first<{ database_id: string }>();
  if (!updated) throw new Error("source generation retry lease was lost");
}

export async function markFailed(
  db: D1Database,
  message: SourceQueueMessage,
  owner: string,
  error: string,
  now = new Date()
): Promise<void> {
  const updated = await db
    .prepare(
      `UPDATE source_jobs
       SET status = 'failed', target_path = NULL, last_error = ?4,
           lease_owner = NULL, lease_expires_at = NULL,
           generated_target_path = NULL, generated_content = NULL,
           generated_context_paths = NULL, llm_duration_ms = NULL, updated_at = ?5
       WHERE database_id = ?1 AND source_path = ?2 AND source_etag = ?3
         AND status IN ('processing', 'generated') AND lease_owner = ?6
       RETURNING database_id`
    )
    .bind(message.databaseId, message.sourcePath, message.sourceEtag, sanitizeError(error), now.toISOString(), owner)
    .first<{ database_id: string }>();
  if (!updated) throw new Error("source generation failure lease was lost");
}

async function upsertQueuedJob(db: D1Database, message: SourceQueueMessage): Promise<void> {
  await db
    .prepare(
      `INSERT INTO source_jobs
       (database_id, source_path, source_etag, status, target_path, attempts, last_error,
        lease_owner, lease_expires_at, generated_target_path, generated_content,
        generated_context_paths, llm_duration_ms, updated_at)
       VALUES (?1, ?2, ?3, 'queued', NULL, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?4)
       ON CONFLICT(database_id, source_path)
       DO UPDATE SET source_etag = excluded.source_etag, status = 'queued', target_path = NULL,
                     attempts = 0, last_error = NULL, lease_owner = NULL, lease_expires_at = NULL,
                     generated_target_path = NULL, generated_content = NULL,
                     generated_context_paths = NULL, llm_duration_ms = NULL,
                     updated_at = excluded.updated_at
       WHERE source_jobs.source_etag <> excluded.source_etag OR source_jobs.status = 'failed'`
    )
    .bind(message.databaseId, message.sourcePath, message.sourceEtag, new Date().toISOString())
    .run();
}

function artifactFromJob(job: SourceJob): GeneratedArtifact {
  if (!job.generated_target_path || job.generated_content === null || job.llm_duration_ms === null) {
    throw new Error("generated source job is missing its checkpoint artifact");
  }
  let contextPaths: unknown;
  try {
    contextPaths = JSON.parse(job.generated_context_paths ?? "[]");
  } catch {
    throw new Error("generated source job context paths are invalid");
  }
  if (!Array.isArray(contextPaths) || !contextPaths.every((value) => typeof value === "string")) {
    throw new Error("generated source job context paths are invalid");
  }
  return {
    targetPath: job.generated_target_path,
    content: job.generated_content,
    contextPaths,
    llmDurationMs: job.llm_duration_ms
  };
}

function sanitizeError(error: string): string {
  return error.slice(0, 4000);
}

function leaseRetryDelay(leaseExpiresAt: string | null, now: Date): number {
  const expiresAtMs = leaseExpiresAt ? Date.parse(leaseExpiresAt) : Number.NaN;
  if (!Number.isFinite(expiresAtMs)) return 15;
  return Math.min(300, Math.max(1, Math.ceil((expiresAtMs - now.getTime()) / 1000) + 1));
}
