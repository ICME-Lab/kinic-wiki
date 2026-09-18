// Where: workers/wiki-generator/src/nns-jobs.ts
// What: Wiki-backed discovery cursor, proposal workflow leases, checkpoints, and status queries.
// Why: NNS review state belongs beside its evidence in the Wiki; Queue delivery remains at-least-once.
import { renderFrontmatter } from "./frontmatter.js";
import { parseCapturedInput, parseGeneratedArtifact, type NnsCapturedInput, type NnsGeneratedArtifact, type NnsIndexEntry } from "./nns-review.js";
import type { NnsProposalReviewQueueMessage, NnsVoteStatus, WikiNode } from "./types.js";
import { ensureParentFolders, NodeMutationError, type VfsClient } from "./vfs.js";

const LEASE_MS = 5 * 60 * 1000;
const INDEX_REENQUEUE_MS = 15 * 60 * 1000;
const CURSOR_PATH = "/Knowledge/nns/system/discovery-state.md";
const WORKFLOW_PREFIX = "/Knowledge/nns/system/workflows";
const VOTE_PREFIX = "/Knowledge/nns/system/votes";
const MAX_WORKFLOW_BYTES = 1024 * 1024;

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
  decision_outcome: "ADOPT" | "REJECT" | "HOLD" | null;
  decision_id: string | null;
  policy_hash: string | null;
  reevaluation_requested: boolean;
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
  decisionCounts: Partial<Record<"ADOPT" | "REJECT" | "HOLD", number>>;
  voteCounts: Partial<Record<NnsVoteStatus, number>>;
  invalidWorkflowCount: number;
  invalidVoteCount: number;
  reevaluationPendingCount: number;
};

export function nnsWorkflowPath(proposalId: number | string): string {
  return `${WORKFLOW_PREFIX}/${proposalId}.md`;
}

export async function loadNnsCursor(vfs: VfsClient, databaseId: string): Promise<NnsAuditCursor | null> {
  const node = await vfs.readNode(databaseId, CURSOR_PATH);
  return node ? parseStateNode<NnsAuditCursor>(node, "kinic.nns_discovery_state") : null;
}

export async function initializeNnsCursor(vfs: VfsClient, databaseId: string, latestProposalId: number, now = new Date()): Promise<NnsAuditCursor> {
  const existing = await loadNnsCursor(vfs, databaseId);
  if (existing) return existing;
  const nowIso = now.toISOString();
  const cursor: NnsAuditCursor = {
    database_id: databaseId, initial_proposal_id: latestProposalId, latest_proposal_id: latestProposalId,
    initialized_at: nowIso, updated_at: nowIso
  };
  try {
    await writeStateNode(vfs, databaseId, CURSOR_PATH, "kinic.nns_discovery_state", cursor, null);
  } catch (error) {
    if (!(error instanceof NodeMutationError) || error.code !== "etag_conflict") throw error;
  }
  return (await loadNnsCursor(vfs, databaseId)) ?? cursor;
}

export async function persistDiscoveredProposals(
  vfs: VfsClient,
  cursor: NnsAuditCursor,
  proposalIds: number[],
  latestObservedProposalId: number,
  now = new Date()
): Promise<void> {
  const nowIso = now.toISOString();
  const uniqueIds = [...new Set(proposalIds)]
    .filter((proposalId) => Number.isSafeInteger(proposalId) && proposalId > cursor.initial_proposal_id)
    .sort((left, right) => left - right);
  for (const proposalId of uniqueIds) {
    const path = nnsWorkflowPath(proposalId);
    if (await vfs.readNode(cursor.database_id, path)) continue;
    try { await writeJob(vfs, emptyJob(cursor.database_id, proposalId, nowIso), null); }
    catch (error) {
      if (!(error instanceof NodeMutationError) || error.code !== "etag_conflict") throw error;
    }
  }
  const node = await vfs.readNode(cursor.database_id, CURSOR_PATH);
  if (!node) throw new Error("NNS Wiki discovery cursor is missing");
  const current = parseStateNode<NnsAuditCursor>(node, "kinic.nns_discovery_state");
  await writeStateNode(vfs, cursor.database_id, CURSOR_PATH, "kinic.nns_discovery_state", {
    ...current,
    latest_proposal_id: Math.max(current.latest_proposal_id, latestObservedProposalId),
    updated_at: nowIso
  }, node.etag);
}

export async function listEnqueueableNnsProposalIds(vfs: VfsClient, databaseId: string, limit = 100, now = new Date()): Promise<number[]> {
  const jobs = (await listJobs(vfs, databaseId)).valid;
  const retryBefore = now.getTime() - INDEX_REENQUEUE_MS;
  return jobs
    .filter(({ job }) => !job.lease_owner && (
      job.status === "discovered" || job.status === "generated"
      || (job.status === "completed" && (job.index_pending === 1 || job.review_status === "explanation_pending")
        && (!job.index_enqueued_at || Date.parse(job.index_enqueued_at) <= retryBefore))
    ))
    .map(({ job }) => job.proposal_id)
    .sort((a, b) => a - b)
    .slice(0, limit);
}

export async function markNnsJobQueued(vfs: VfsClient, databaseId: string, proposalId: number, now = new Date()): Promise<boolean> {
  const loaded = await loadJobNode(vfs, databaseId, proposalId);
  if (!loaded || loaded.job.lease_owner) return false;
  const job = loaded.job;
  const retryBefore = now.getTime() - INDEX_REENQUEUE_MS;
  const eligible = job.status === "discovered" || job.status === "generated"
    || (job.status === "completed" && (job.index_pending === 1 || job.review_status === "explanation_pending")
      && (!job.index_enqueued_at || Date.parse(job.index_enqueued_at) <= retryBefore));
  if (!eligible) return false;
  await writeJob(vfs, {
    ...job,
    status: job.status === "completed" ? "completed" : "queued",
    index_enqueued_at: job.status === "completed" ? now.toISOString() : job.index_enqueued_at,
    updated_at: now.toISOString()
  }, loaded.node.etag);
  return true;
}

export async function loadNnsJob(vfs: VfsClient, databaseId: string, proposalId: number): Promise<NnsProposalJob | null> {
  return (await loadJobNode(vfs, databaseId, proposalId))?.job ?? null;
}

export async function claimNnsJob(vfs: VfsClient, message: NnsProposalReviewQueueMessage, owner: string, now = new Date()): Promise<NnsJobClaim> {
  const loaded = await loadJobNode(vfs, message.databaseId, message.proposalId);
  if (!loaded) return { kind: "missing" };
  const current = loaded.job;
  const reevaluation = message.reason === "policy_changed"
    && current.status === "completed"
    && current.decision_id === message.previousDecisionId;
  if (current.status === "completed" && current.review_status !== "explanation_pending" && !reevaluation) return { kind: "completed" };
  if (current.status === "failed") return { kind: "failed", error: current.last_error ?? "NNS proposal review failed" };
  if (current.lease_owner && current.lease_owner !== owner && (!current.lease_expires_at || Date.parse(current.lease_expires_at) > now.getTime())) {
    return { kind: "busy", retryAfterSeconds: leaseRetryDelay(current.lease_expires_at, now) };
  }
  const resumable = current.generated_artifact !== null && !reevaluation;
  const claimed: NnsProposalJob = {
    ...current,
    status: resumable ? "generated" : "processing",
    generated_artifact: reevaluation ? null : current.generated_artifact,
    reevaluation_requested: reevaluation,
    attempts: current.attempts + 1,
    last_error: null,
    lease_owner: owner,
    lease_expires_at: new Date(now.getTime() + LEASE_MS).toISOString(),
    updated_at: now.toISOString()
  };
  try { await writeJob(vfs, claimed, loaded.node.etag); }
  catch (error) {
    if (error instanceof NodeMutationError && error.code === "etag_conflict") return { kind: "busy", retryAfterSeconds: 15 };
    throw error;
  }
  if (!resumable) return { kind: "generate", capturedInput: claimed.captured_input ? parseCapturedInput(claimed.captured_input) : null };
  try { return { kind: "resume", artifact: parseGeneratedArtifact(claimed.generated_artifact!) }; }
  catch { return { kind: "failed", error: "generated Wiki checkpoint is invalid" }; }
}

export async function checkpointNnsCapturedInput(vfs: VfsClient, message: NnsProposalReviewQueueMessage, owner: string, capturedInput: NnsCapturedInput, now = new Date()): Promise<void> {
  await updateOwnedJob(vfs, message, owner, (job) => ({ ...job, captured_input: JSON.stringify(capturedInput), updated_at: now.toISOString() }));
}

export async function checkpointNnsArtifact(vfs: VfsClient, message: NnsProposalReviewQueueMessage, owner: string, artifact: NnsGeneratedArtifact, now = new Date()): Promise<void> {
  const nodeRef = (node: NnsGeneratedArtifact["source"]) => ({ ...node, content: "", metadataJson: "" });
  const compactArtifact: NnsGeneratedArtifact = {
    ...artifact,
    source: nodeRef(artifact.source),
    governance: nodeRef(artifact.governance),
    reference: artifact.reference ? nodeRef(artifact.reference) : null,
    evidenceSources: (artifact.evidenceSources ?? []).map(nodeRef),
    evidence: artifact.evidence ? nodeRef(artifact.evidence) : null,
    decision: nodeRef(artifact.decision),
    review: nodeRef(artifact.review),
    explanationSnapshot: null,
    explanationMessages: null
  };
  await updateOwnedJob(vfs, message, owner, (job) => ({
    ...job,
    status: "generated",
    captured_input: null,
    generated_artifact: JSON.stringify(compactArtifact),
    captured_at: artifact.capturedAt,
    action: artifact.action,
    topic: artifact.topic,
    status_at_capture: artifact.statusAtCapture,
    review_depth: artifact.reviewDepth,
    review_status: artifact.reviewStatus,
    recommendation: artifact.recommendation,
    source_path: artifact.source.path,
    reference_path: artifact.reference?.path ?? null,
    review_path: artifact.review.path,
    model: artifact.model,
    llm_duration_ms: artifact.llmDurationMs,
    decision_outcome: artifact.decisionRecord.outcome,
    decision_id: artifact.decisionRecord.decisionId,
    policy_hash: artifact.decisionRecord.policyHash,
    updated_at: now.toISOString()
  }));
}

export async function releaseNnsJobForRetry(vfs: VfsClient, message: NnsProposalReviewQueueMessage, owner: string, error: string, now = new Date()): Promise<void> {
  await updateOwnedJob(vfs, message, owner, (job) => ({
    ...job, status: job.generated_artifact ? "generated" : "queued", lease_owner: null, lease_expires_at: null,
    last_error: sanitizeError(error), updated_at: now.toISOString()
  }));
}

export async function failNnsJob(vfs: VfsClient, message: NnsProposalReviewQueueMessage, owner: string, error: string, now = new Date()): Promise<void> {
  await updateOwnedJob(vfs, message, owner, (job) => ({
    ...job, status: "failed", lease_owner: null, lease_expires_at: null,
    last_error: sanitizeError(error), updated_at: now.toISOString()
  }));
}

export async function recordTerminalNnsDeliveryFailure(vfs: VfsClient, message: NnsProposalReviewQueueMessage, owner: string, error: string, now = new Date()): Promise<NnsTerminalFailureResult> {
  const loaded = await loadJobNode(vfs, message.databaseId, message.proposalId);
  if (!loaded) return "missing";
  if (loaded.job.status === "failed") return "already_failed";
  if (loaded.job.status === "completed") return "completed";
  if (loaded.job.lease_owner && loaded.job.lease_owner !== owner && loaded.job.lease_expires_at && Date.parse(loaded.job.lease_expires_at) > now.getTime()) return "busy";
  await writeJob(vfs, {
    ...loaded.job, status: "failed", lease_owner: null, lease_expires_at: null,
    last_error: sanitizeError(error), updated_at: now.toISOString()
  }, loaded.node.etag);
  return "failed";
}

export async function completeNnsJob(vfs: VfsClient, message: NnsProposalReviewQueueMessage, owner: string, now = new Date()): Promise<void> {
  await updateOwnedJob(vfs, message, owner, (job) => ({
    ...job,
    status: "completed",
    captured_input: null,
    generated_artifact: job.review_status === "explanation_pending" ? job.generated_artifact : null,
    last_error: null,
    lease_owner: null,
    lease_expires_at: null,
    index_pending: 1,
    index_enqueued_at: now.toISOString(),
    reevaluation_requested: false,
    updated_at: now.toISOString()
  }));
}

export async function markNnsIndexSynced(vfs: VfsClient, databaseId: string, proposalId: number, now = new Date()): Promise<void> {
  const loaded = await loadJobNode(vfs, databaseId, proposalId);
  if (!loaded || loaded.job.status !== "completed") return;
  await writeJob(vfs, { ...loaded.job, index_pending: 0, index_enqueued_at: null, updated_at: now.toISOString() }, loaded.node.etag);
}

export async function resetFailedNnsJobs(vfs: VfsClient, databaseId: string, now = new Date()): Promise<number> {
  let count = 0;
  for (const loaded of (await listJobs(vfs, databaseId)).valid) {
    if (loaded.job.status !== "failed") continue;
    await writeJob(vfs, {
      ...loaded.job,
      status: loaded.job.generated_artifact ? "generated" : "discovered",
      attempts: 0, last_error: null, lease_owner: null, lease_expires_at: null, updated_at: now.toISOString()
    }, loaded.node.etag);
    count += 1;
  }
  return count;
}

export async function listCompletedNnsIndexEntries(vfs: VfsClient, databaseId: string): Promise<NnsIndexEntry[]> {
  return (await listJobs(vfs, databaseId)).valid
    .map(({ job }) => job)
    .filter((job) => job.status === "completed" && job.action && job.topic && job.status_at_capture && job.review_depth && job.review_status && job.recommendation && job.review_path)
    .sort((a, b) => b.proposal_id - a.proposal_id)
    .map((job) => ({
      proposalId: job.proposal_id,
      action: job.action!, topic: job.topic!, statusAtCapture: job.status_at_capture!,
      reviewDepth: job.review_depth!, reviewStatus: job.review_status!,
      recommendation: job.recommendation!, reviewPath: job.review_path!
    }));
}

export async function loadNnsAuditStatus(vfs: VfsClient, databaseId: string): Promise<NnsAuditStatus> {
  const listedJobs = await listJobs(vfs, databaseId);
  const jobs = listedJobs.valid.map(({ job }) => job);
  const counts: NnsAuditStatus["counts"] = {};
  const decisionCounts: NnsAuditStatus["decisionCounts"] = {};
  let latestCompletedProposalId: number | null = null;
  for (const job of jobs) {
    counts[job.status] = (counts[job.status] ?? 0) + 1;
    if (job.decision_outcome) decisionCounts[job.decision_outcome] = (decisionCounts[job.decision_outcome] ?? 0) + 1;
    if (job.status === "completed") latestCompletedProposalId = Math.max(latestCompletedProposalId ?? 0, job.proposal_id);
  }
  const voteCounts: NnsAuditStatus["voteCounts"] = {};
  let invalidVoteCount = 0;
  for (const node of await exportNodes(vfs, databaseId, VOTE_PREFIX)) {
    if (!node.path.endsWith(".md")) continue;
    try {
      const value = parseStateNode<Record<string, unknown>>(node, "kinic.nns_vote_state");
      const status = value.status as NnsVoteStatus;
      if (!VOTE_STATUSES.has(status) || typeof value.publicationPending !== "boolean") throw new Error("invalid vote state");
      voteCounts[status] = (voteCounts[status] ?? 0) + 1;
    } catch { invalidVoteCount += 1; }
  }
  return {
    cursor: await loadNnsCursor(vfs, databaseId), counts, latestCompletedProposalId, decisionCounts, voteCounts,
    invalidWorkflowCount: listedJobs.invalidCount, invalidVoteCount,
    reevaluationPendingCount: jobs.filter((job) => job.reevaluation_requested).length
  };
}

const VOTE_STATUSES = new Set<NnsVoteStatus>([
  "planned", "simulating", "submitting", "accepted", "confirmed",
  "unknown", "held", "conflict", "expired", "failed"
]);

async function updateOwnedJob(
  vfs: VfsClient,
  message: NnsProposalReviewQueueMessage,
  owner: string,
  update: (job: NnsProposalJob) => NnsProposalJob
): Promise<void> {
  const loaded = await loadJobNode(vfs, message.databaseId, message.proposalId);
  if (!loaded || loaded.job.lease_owner !== owner) throw new Error("NNS Wiki workflow lease was lost");
  await writeJob(vfs, update(loaded.job), loaded.node.etag);
}

async function loadJobNode(vfs: VfsClient, databaseId: string, proposalId: number): Promise<{ node: WikiNode; job: NnsProposalJob } | null> {
  const node = await vfs.readNode(databaseId, nnsWorkflowPath(proposalId));
  return node ? { node, job: parseJobNode(node) } : null;
}

async function listJobs(vfs: VfsClient, databaseId: string): Promise<{ valid: { node: WikiNode; job: NnsProposalJob }[]; invalidCount: number }> {
  const output: { node: WikiNode; job: NnsProposalJob }[] = [];
  let invalidCount = 0;
  for (const node of await exportNodes(vfs, databaseId, WORKFLOW_PREFIX)) {
    if (!node.path.endsWith(".md")) continue;
    try { output.push({ node, job: parseJobNode(node) }); }
    catch { invalidCount += 1; }
  }
  return { valid: output, invalidCount };
}

function parseJobNode(node: WikiNode): NnsProposalJob {
  const job = parseStateNode<NnsProposalJob>(node, "kinic.nns_proposal_workflow");
  if (typeof job.database_id !== "string" || !Number.isSafeInteger(job.proposal_id)
    || !JOB_STATUSES.has(job.status) || typeof job.attempts !== "number"
    || typeof job.reevaluation_requested !== "boolean") {
    throw new Error(`invalid Wiki workflow state at ${node.path}`);
  }
  return job;
}

const JOB_STATUSES = new Set<NnsProposalJobStatus>(["discovered", "queued", "processing", "generated", "completed", "failed"]);

async function exportNodes(vfs: VfsClient, databaseId: string, prefix: string): Promise<WikiNode[]> {
  const nodes: WikiNode[] = [];
  let cursor: string | null = null;
  let revision: string | null = null;
  do {
    const page = await vfs.exportSnapshot(databaseId, prefix, cursor, revision);
    revision = page.snapshotRevision;
    nodes.push(...page.nodes);
    cursor = page.nextCursor;
  } while (cursor);
  return nodes;
}

async function writeJob(vfs: VfsClient, job: NnsProposalJob, expectedEtag: string | null): Promise<void> {
  await writeStateNode(vfs, job.database_id, nnsWorkflowPath(job.proposal_id), "kinic.nns_proposal_workflow", job, expectedEtag);
}

async function writeStateNode<T extends object>(
  vfs: VfsClient,
  databaseId: string,
  path: string,
  kind: string,
  state: T,
  expectedEtag: string | null
): Promise<void> {
  await ensureParentFolders(vfs, databaseId, path);
  const record = state as Record<string, unknown>;
  const content = renderFrontmatter({
    kind,
    schema_version: 1,
    proposal_id: typeof record.proposal_id === "number" ? record.proposal_id : null,
    status: typeof record.status === "string" ? record.status : null,
    updated_at: typeof record.updated_at === "string" ? record.updated_at : null
  }, `# ${kind}\n\nThis node is the Wiki-backed machine state for the NNS automation workflow.\n\n\`\`\`json\n${JSON.stringify(state, null, 2)}\n\`\`\``);
  if (new TextEncoder().encode(content).byteLength > MAX_WORKFLOW_BYTES) throw new Error("NNS Wiki workflow exceeded 1 MiB");
  await vfs.writeNode({
    databaseId, path, kind: "file", content,
    metadataJson: JSON.stringify({ kind, schema_version: 1 }), expectedEtag
  });
}

function parseStateNode<T>(node: WikiNode, expectedKind: string): T {
  const kind = node.content.match(/^kind:\s*"?([^"\n]+)"?$/m)?.[1];
  if (kind !== expectedKind) throw new Error(`unexpected Wiki state kind at ${node.path}`);
  const match = node.content.match(/```json\n([\s\S]*?)\n```/);
  if (!match) throw new Error(`Wiki state payload is missing at ${node.path}`);
  return JSON.parse(match[1]!) as T;
}

function emptyJob(databaseId: string, proposalId: number, nowIso: string): NnsProposalJob {
  return {
    database_id: databaseId, proposal_id: proposalId, status: "discovered", attempts: 0,
    last_error: null, lease_owner: null, lease_expires_at: null, captured_input: null,
    generated_artifact: null, captured_at: null, action: null, topic: null,
    status_at_capture: null, review_depth: null, review_status: null, recommendation: null,
    source_path: null, reference_path: null, review_path: null, model: null,
    llm_duration_ms: null, index_pending: 0, index_enqueued_at: null,
    decision_outcome: null, decision_id: null, policy_hash: null,
    reevaluation_requested: false, updated_at: nowIso
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
