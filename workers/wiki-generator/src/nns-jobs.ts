// Where: workers/wiki-generator/src/nns-jobs.ts
// What: D1 discovery cursor, NNS proposal job leases, generation checkpoints, and status queries.
// Why: Cron discovery and Queue delivery are at-least-once and must not lose proposals or repeat paid reviews.
import { parseCapturedInput, parseGeneratedArtifact, type NnsCapturedInput, type NnsGeneratedArtifact, type NnsIndexEntry } from "./nns-review.js";
import type { NnsProposalReviewQueueMessage } from "./types.js";

const LEASE_MS = 5 * 60 * 1000;
const INDEX_REENQUEUE_MS = 15 * 60 * 1000;
const JOB_COLUMNS = `database_id, proposal_id, status, attempts, last_error, lease_owner,
  lease_expires_at, captured_input, generated_artifact, captured_at, action, topic,
  status_at_capture, review_depth, review_status, recommendation, source_path,
  reference_path, review_path, model, llm_duration_ms, index_pending,
  index_enqueued_at, updated_at`;

export type NnsAuditCursor = {
  database_id: string;
  initial_proposal_id: number;
  latest_proposal_id: number;
  initialized_at: string;
  updated_at: string;
};

export type NnsProposalJobStatus = "discovered" | "queued" | "processing" | "generated" | "completed" | "failed";

export type NnsProposalJob = {
  database_id: string;
  proposal_id: number;
  status: NnsProposalJobStatus;
  attempts: number;
  last_error: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  captured_input: string | null;
  generated_artifact: string | null;
  captured_at: string | null;
  action: string | null;
  topic: string | null;
  status_at_capture: string | null;
  review_depth: NnsIndexEntry["reviewDepth"] | null;
  review_status: NnsIndexEntry["reviewStatus"] | null;
  recommendation: NnsIndexEntry["recommendation"] | null;
  source_path: string | null;
  reference_path: string | null;
  review_path: string | null;
  model: string | null;
  llm_duration_ms: number | null;
  index_pending: number;
  index_enqueued_at: string | null;
  updated_at: string;
};

export type NnsTerminalFailureResult = "failed" | "already_failed" | "completed" | "busy" | "missing";

export type NnsJobClaim =
  | { kind: "generate"; capturedInput: NnsCapturedInput | null }
  | { kind: "resume"; artifact: NnsGeneratedArtifact }
  | { kind: "completed" }
  | { kind: "failed"; error: string }
  | { kind: "busy"; retryAfterSeconds: number }
  | { kind: "missing" };

export type NnsAuditStatus = {
  cursor: NnsAuditCursor | null;
  counts: Partial<Record<NnsProposalJobStatus, number>>;
  latestCompletedProposalId: number | null;
};

export async function loadNnsCursor(db: D1Database, databaseId: string): Promise<NnsAuditCursor | null> {
  return (
    (await db
      .prepare(
        `SELECT database_id, initial_proposal_id, latest_proposal_id, initialized_at, updated_at
         FROM nns_audit_cursors WHERE database_id = ?1`
      )
      .bind(databaseId)
      .first<NnsAuditCursor>()) ?? null
  );
}

export async function initializeNnsCursor(db: D1Database, databaseId: string, latestProposalId: number, now = new Date()): Promise<NnsAuditCursor> {
  const nowIso = now.toISOString();
  await db
    .prepare(
      `INSERT INTO nns_audit_cursors
       (database_id, initial_proposal_id, latest_proposal_id, initialized_at, updated_at)
       VALUES (?1, ?2, ?2, ?3, ?3)
       ON CONFLICT(database_id) DO NOTHING`
    )
    .bind(databaseId, latestProposalId, nowIso)
    .run();
  const cursor = await loadNnsCursor(db, databaseId);
  if (!cursor) throw new Error("NNS audit cursor initialization was not persisted");
  return cursor;
}

export async function persistDiscoveredProposals(
  db: D1Database,
  cursor: NnsAuditCursor,
  proposalIds: number[],
  latestObservedProposalId: number,
  now = new Date()
): Promise<void> {
  const nowIso = now.toISOString();
  const uniqueIds = [...new Set(proposalIds)]
    .filter((proposalId) => Number.isSafeInteger(proposalId) && proposalId > cursor.initial_proposal_id)
    .sort((left, right) => left - right);
  const statements = uniqueIds.map((proposalId) =>
    db
      .prepare(
        `INSERT INTO nns_proposal_jobs
         (database_id, proposal_id, status, attempts, last_error, lease_owner,
          lease_expires_at, captured_input, generated_artifact, captured_at, action, topic,
          status_at_capture, review_depth, review_status, recommendation, source_path,
          reference_path, review_path, model, llm_duration_ms, updated_at)
         VALUES (?1, ?2, 'discovered', 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
                 NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?3)
         ON CONFLICT(database_id, proposal_id) DO NOTHING`
      )
      .bind(cursor.database_id, proposalId, nowIso)
  );
  statements.push(
    db
      .prepare(
        `UPDATE nns_audit_cursors
         SET latest_proposal_id = MAX(latest_proposal_id, ?2), updated_at = ?3
         WHERE database_id = ?1`
      )
      .bind(cursor.database_id, latestObservedProposalId, nowIso)
  );
  await batchStatements(db, statements);
}

export async function listEnqueueableNnsProposalIds(
  db: D1Database,
  databaseId: string,
  limit = 100,
  now = new Date()
): Promise<number[]> {
  const indexRetryBefore = new Date(now.getTime() - INDEX_REENQUEUE_MS).toISOString();
  const statement = db
    .prepare(
      `SELECT proposal_id FROM nns_proposal_jobs
       WHERE database_id = ?1 AND lease_owner IS NULL
         AND (
           status IN ('discovered', 'generated')
           OR (status = 'completed' AND index_pending = 1
               AND (index_enqueued_at IS NULL OR index_enqueued_at <= ?3))
         )
       ORDER BY proposal_id ASC LIMIT ?2`
    )
    .bind(databaseId, limit, indexRetryBefore);
  const result = await allRows<{ proposal_id: number }>(statement);
  return result.results.map((row) => row.proposal_id);
}

export async function markNnsJobQueued(db: D1Database, databaseId: string, proposalId: number, now = new Date()): Promise<boolean> {
  const nowIso = now.toISOString();
  const indexRetryBefore = new Date(now.getTime() - INDEX_REENQUEUE_MS).toISOString();
  const updated = await db
    .prepare(
      `UPDATE nns_proposal_jobs
       SET status = CASE WHEN status = 'completed' THEN 'completed' ELSE 'queued' END,
           index_enqueued_at = CASE WHEN status = 'completed' THEN ?3 ELSE index_enqueued_at END,
           updated_at = ?3
       WHERE database_id = ?1 AND proposal_id = ?2
         AND lease_owner IS NULL
         AND (
           status IN ('discovered', 'generated')
           OR (status = 'completed' AND index_pending = 1
               AND (index_enqueued_at IS NULL OR index_enqueued_at <= ?4))
         )
       RETURNING proposal_id`
    )
    .bind(databaseId, proposalId, nowIso, indexRetryBefore)
    .first<{ proposal_id: number }>();
  return updated !== null;
}

export async function loadNnsJob(db: D1Database, databaseId: string, proposalId: number): Promise<NnsProposalJob | null> {
  return (
    (await db
      .prepare(`SELECT ${JOB_COLUMNS} FROM nns_proposal_jobs WHERE database_id = ?1 AND proposal_id = ?2`)
      .bind(databaseId, proposalId)
      .first<NnsProposalJob>()) ?? null
  );
}

export async function claimNnsJob(
  db: D1Database,
  message: NnsProposalReviewQueueMessage,
  owner: string,
  now = new Date()
): Promise<NnsJobClaim> {
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + LEASE_MS).toISOString();
  const claimed = await db
    .prepare(
      `UPDATE nns_proposal_jobs
       SET status = CASE WHEN generated_artifact IS NOT NULL THEN 'generated' ELSE 'processing' END,
           lease_owner = ?3, lease_expires_at = ?4, attempts = attempts + 1,
           last_error = NULL, updated_at = ?5
       WHERE database_id = ?1 AND proposal_id = ?2
         AND status IN ('discovered', 'queued', 'processing', 'generated')
         AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ?5)
       RETURNING ${JOB_COLUMNS}`
    )
    .bind(message.databaseId, message.proposalId, owner, expiresAt, nowIso)
    .first<NnsProposalJob>();
  if (claimed) {
    if (claimed.status !== "generated") {
      return {
        kind: "generate",
        capturedInput: claimed.captured_input ? parseCapturedInput(claimed.captured_input) : null
      };
    }
    if (!claimed.generated_artifact) return { kind: "failed", error: "generated NNS job is missing its checkpoint artifact" };
    return { kind: "resume", artifact: parseGeneratedArtifact(claimed.generated_artifact) };
  }
  const current = await loadNnsJob(db, message.databaseId, message.proposalId);
  if (!current) return { kind: "missing" };
  if (current.status === "completed") return { kind: "completed" };
  if (current.status === "failed") return { kind: "failed", error: current.last_error ?? "NNS proposal review failed" };
  return { kind: "busy", retryAfterSeconds: leaseRetryDelay(current.lease_expires_at, now) };
}

export async function checkpointNnsCapturedInput(
  db: D1Database,
  message: NnsProposalReviewQueueMessage,
  owner: string,
  capturedInput: NnsCapturedInput,
  now = new Date()
): Promise<void> {
  const updated = await db
    .prepare(
      `UPDATE nns_proposal_jobs
       SET captured_input = ?3, updated_at = ?4
       WHERE database_id = ?1 AND proposal_id = ?2
         AND status = 'processing' AND lease_owner = ?5
       RETURNING proposal_id`
    )
    .bind(message.databaseId, message.proposalId, JSON.stringify(capturedInput), now.toISOString(), owner)
    .first<{ proposal_id: number }>();
  if (!updated) throw new Error("NNS input checkpoint lease was lost");
}

export async function checkpointNnsArtifact(
  db: D1Database,
  message: NnsProposalReviewQueueMessage,
  owner: string,
  artifact: NnsGeneratedArtifact,
  now = new Date()
): Promise<void> {
  const updated = await db
    .prepare(
      `UPDATE nns_proposal_jobs
       SET status = 'generated', captured_input = NULL, generated_artifact = ?3, captured_at = ?4,
           action = ?5, topic = ?6, status_at_capture = ?7, review_depth = ?8,
           review_status = ?9, recommendation = ?10, source_path = ?11,
           reference_path = ?12, review_path = ?13, model = ?14,
           llm_duration_ms = ?15, updated_at = ?16
       WHERE database_id = ?1 AND proposal_id = ?2
         AND status = 'processing' AND lease_owner = ?17
       RETURNING proposal_id`
    )
    .bind(
      message.databaseId,
      message.proposalId,
      JSON.stringify(artifact),
      artifact.capturedAt,
      artifact.action,
      artifact.topic,
      artifact.statusAtCapture,
      artifact.reviewDepth,
      artifact.reviewStatus,
      artifact.recommendation,
      artifact.source.path,
      artifact.reference?.path ?? null,
      artifact.review.path,
      artifact.model,
      artifact.llmDurationMs,
      now.toISOString(),
      owner
    )
    .first<{ proposal_id: number }>();
  if (!updated) throw new Error("NNS generation checkpoint lease was lost");
}

export async function releaseNnsJobForRetry(
  db: D1Database,
  message: NnsProposalReviewQueueMessage,
  owner: string,
  error: string,
  now = new Date()
): Promise<void> {
  const updated = await db
    .prepare(
      `UPDATE nns_proposal_jobs
       SET status = CASE WHEN generated_artifact IS NULL THEN 'queued' ELSE 'generated' END,
           lease_owner = NULL, lease_expires_at = NULL, last_error = ?3, updated_at = ?4
       WHERE database_id = ?1 AND proposal_id = ?2
         AND status IN ('processing', 'generated') AND lease_owner = ?5
       RETURNING proposal_id`
    )
    .bind(message.databaseId, message.proposalId, sanitizeError(error), now.toISOString(), owner)
    .first<{ proposal_id: number }>();
  if (!updated) throw new Error("NNS retry lease was lost");
}

export async function failNnsJob(
  db: D1Database,
  message: NnsProposalReviewQueueMessage,
  owner: string,
  error: string,
  now = new Date()
): Promise<void> {
  const updated = await db
    .prepare(
      `UPDATE nns_proposal_jobs
       SET status = 'failed', lease_owner = NULL, lease_expires_at = NULL,
           last_error = ?3, updated_at = ?4
       WHERE database_id = ?1 AND proposal_id = ?2
         AND status IN ('processing', 'generated') AND lease_owner = ?5
       RETURNING proposal_id`
    )
    .bind(message.databaseId, message.proposalId, sanitizeError(error), now.toISOString(), owner)
    .first<{ proposal_id: number }>();
  if (!updated) throw new Error("NNS failure lease was lost");
}

export async function recordTerminalNnsDeliveryFailure(
  db: D1Database,
  message: NnsProposalReviewQueueMessage,
  owner: string,
  error: string,
  now = new Date()
): Promise<NnsTerminalFailureResult> {
  const nowIso = now.toISOString();
  const updated = await db
    .prepare(
      `UPDATE nns_proposal_jobs
       SET status = 'failed', lease_owner = NULL, lease_expires_at = NULL,
           last_error = ?3, updated_at = ?4
       WHERE database_id = ?1 AND proposal_id = ?2
         AND status IN ('discovered', 'queued', 'processing', 'generated')
         AND (lease_owner IS NULL OR lease_owner = ?5 OR lease_expires_at IS NULL OR lease_expires_at <= ?4)
       RETURNING proposal_id`
    )
    .bind(message.databaseId, message.proposalId, sanitizeError(error), nowIso, owner)
    .first<{ proposal_id: number }>();
  if (updated) return "failed";
  const current = await loadNnsJob(db, message.databaseId, message.proposalId);
  if (!current) return "missing";
  if (current.status === "failed") return "already_failed";
  if (current.status === "completed") return "completed";
  return "busy";
}

export async function completeNnsJob(
  db: D1Database,
  message: NnsProposalReviewQueueMessage,
  owner: string,
  now = new Date()
): Promise<void> {
  const updated = await db
    .prepare(
      `UPDATE nns_proposal_jobs
       SET status = 'completed', captured_input = NULL, generated_artifact = NULL, last_error = NULL,
           lease_owner = NULL, lease_expires_at = NULL, index_pending = 1,
           index_enqueued_at = ?3, updated_at = ?3
       WHERE database_id = ?1 AND proposal_id = ?2
         AND status = 'generated' AND lease_owner = ?4
       RETURNING proposal_id`
    )
    .bind(message.databaseId, message.proposalId, now.toISOString(), owner)
    .first<{ proposal_id: number }>();
  if (!updated) throw new Error("NNS completion lease was lost");
}

export async function markNnsIndexSynced(
  db: D1Database,
  databaseId: string,
  proposalId: number,
  now = new Date()
): Promise<void> {
  await db
    .prepare(
      `UPDATE nns_proposal_jobs
       SET index_pending = 0, index_enqueued_at = NULL, updated_at = ?3
       WHERE database_id = ?1 AND proposal_id = ?2
         AND status = 'completed' AND index_pending = 1`
    )
    .bind(databaseId, proposalId, now.toISOString())
    .run();
}

export async function resetFailedNnsJobs(db: D1Database, databaseId: string, now = new Date()): Promise<number> {
  const result = (await db
    .prepare(
      `UPDATE nns_proposal_jobs
       SET status = CASE WHEN generated_artifact IS NULL THEN 'discovered' ELSE 'generated' END,
           attempts = 0, last_error = NULL, lease_owner = NULL, lease_expires_at = NULL,
           updated_at = ?2
       WHERE database_id = ?1 AND status = 'failed'`
    )
    .bind(databaseId, now.toISOString())
    .run()) as { meta?: { changes?: number } };
  return Number(result.meta?.changes ?? 0);
}

export async function listCompletedNnsIndexEntries(db: D1Database, databaseId: string): Promise<NnsIndexEntry[]> {
  const statement = db
    .prepare(
      `SELECT proposal_id, action, topic, status_at_capture, review_depth,
              review_status, recommendation, review_path
       FROM nns_proposal_jobs
       WHERE database_id = ?1 AND status = 'completed'
       ORDER BY proposal_id DESC`
    )
    .bind(databaseId);
  const result = await allRows<{
    proposal_id: number;
    action: string;
    topic: string;
    status_at_capture: string;
    review_depth: NnsIndexEntry["reviewDepth"];
    review_status: NnsIndexEntry["reviewStatus"];
    recommendation: NnsIndexEntry["recommendation"];
    review_path: string;
  }>(statement);
  return result.results.map((row) => ({
    proposalId: row.proposal_id,
    action: row.action,
    topic: row.topic,
    statusAtCapture: row.status_at_capture,
    reviewDepth: row.review_depth,
    reviewStatus: row.review_status,
    recommendation: row.recommendation,
    reviewPath: row.review_path
  }));
}

export async function loadNnsAuditStatus(db: D1Database, databaseId: string): Promise<NnsAuditStatus> {
  const countsStatement = db
    .prepare(`SELECT status, COUNT(*) AS count FROM nns_proposal_jobs WHERE database_id = ?1 GROUP BY status`)
    .bind(databaseId);
  const [cursor, countsResult, latest] = await Promise.all([
    loadNnsCursor(db, databaseId),
    allRows<{ status: NnsProposalJobStatus; count: number }>(countsStatement),
    db
      .prepare(`SELECT MAX(proposal_id) AS proposal_id FROM nns_proposal_jobs WHERE database_id = ?1 AND status = 'completed'`)
      .bind(databaseId)
      .first<{ proposal_id: number | null }>()
  ]);
  return {
    cursor,
    counts: Object.fromEntries(countsResult.results.map((row) => [row.status, Number(row.count)])),
    latestCompletedProposalId: latest?.proposal_id ?? null
  };
}

function sanitizeError(value: string): string {
  return value.slice(0, 1000);
}

function leaseRetryDelay(leaseExpiresAt: string | null, now: Date): number {
  const expiresAtMs = leaseExpiresAt ? Date.parse(leaseExpiresAt) : Number.NaN;
  if (!Number.isFinite(expiresAtMs)) return 15;
  return Math.min(300, Math.max(1, Math.ceil((expiresAtMs - now.getTime()) / 1000) + 1));
}

async function batchStatements(db: D1Database, statements: D1PreparedStatement[]): Promise<void> {
  const database = db as D1Database & { batch(items: D1PreparedStatement[]): Promise<unknown[]> };
  await database.batch(statements);
}

function allRows<T>(statement: D1PreparedStatement): Promise<{ results: T[] }> {
  return (statement as D1PreparedStatement & { all<Row>(): Promise<{ results: Row[] }> }).all<T>();
}
