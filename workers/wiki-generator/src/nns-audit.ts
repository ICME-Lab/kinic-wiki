// Where: workers/wiki-generator/src/nns-audit.ts
// What: Scheduled NNS discovery, proposal review Queue processing, and VFS publication.
// Why: New proposals need durable discovery and create-only evidence/review writes without collecting voting data.
import {
  checkpointNnsArtifact,
  checkpointNnsCapturedInput,
  claimNnsJob,
  completeNnsJob,
  failNnsJob,
  initializeNnsCursor,
  listCompletedNnsIndexEntries,
  listEnqueueableNnsProposalIds,
  loadNnsJob,
  loadNnsAuditStatus,
  loadNnsCursor,
  markNnsIndexSynced,
  markNnsJobQueued,
  persistDiscoveredProposals,
  releaseNnsJobForRetry,
  resetFailedNnsJobs,
  type NnsAuditStatus
} from "./nns-jobs.js";
import {
  DEFAULT_NNS_REVIEW_POLICY,
  NnsProposalValidationError,
  NnsReviewValidationError,
  isOpenAtCapture,
  nnsReviewMessages,
  parseNnsReviewResponse,
  parseProposalDetailResponse,
  proposalReferenceNode,
  proposalReviewNode,
  proposalSourceNode,
  renderNnsIndex,
  reviewDepthForAction,
  type NnsArtifactNode,
  type NnsCapturedInput,
  type NnsGeneratedArtifact,
  type NnsProposalSnapshot,
  type NnsReviewDraft
} from "./nns-review.js";
import { DeepSeekRequestError, DeepSeekResponseError, requestDeepSeekDraft } from "./openai.js";
import type { QueueDisposition, QueueExecution } from "./queue-types.js";
import { fetchUrlSource, type FetchedUrlSource } from "./url-fetch.js";
import { createVfsClient, ensureParentFolders, NodeMutationError, type VfsClient } from "./vfs.js";
import { loadNnsWorkerConfig, type NnsRuntimeEnv } from "./nns-env.js";
import type { NnsProposalReviewQueueMessage, NnsWorkerConfig } from "./types.js";

const DEFAULT_NNS_API_BASE_URL = "https://ic-api.internetcomputer.org/api/v3";
const DISCOVERY_PAGE_SIZE = 100;
const DISCOVERY_OVERLAP = 100;
const MAX_DISCOVERY_PAGES = 100;
const MAX_API_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_CHECKPOINT_BYTES = 1024 * 1024;
const API_TIMEOUT_MS = 30_000;
const INDEX_PATH = "/Knowledge/nns/index.md";
const POLICY_PATH = "/Knowledge/nns/review-policy.md";
const NNS_USER_AGENT = "kinic-nns-proposal-review/1.0";

type NnsAuditConfig = {
  databaseId: string;
  apiBaseUrl: string;
};

export type NnsAuditPollResult = {
  enabled: boolean;
  initialized: boolean;
  initialProposalId?: number;
  discovered: number;
  enqueued: number;
  resetFailed: number;
};

type NnsAuditPollContext = {
  fetchJson?: (url: string) => Promise<unknown>;
  now?: () => Date;
};

type NnsQueueContext = {
  config?: NnsWorkerConfig;
  vfs?: VfsClient;
  fetchJson?: (url: string) => Promise<unknown>;
  fetchReference?: (url: string, maxBytes: number) => Promise<FetchedUrlSource>;
  requestReview?: (
    messages: { role: "system" | "user"; content: string }[],
    config: NnsWorkerConfig,
    apiKey: string
  ) => Promise<unknown>;
  now?: () => Date;
};

export function loadNnsAuditConfig(env: NnsRuntimeEnv): NnsAuditConfig | null {
  const databaseId = env.KINIC_NNS_AUDIT_DATABASE_ID?.trim();
  if (!databaseId) return null;
  if (databaseId.length > 128) throw new Error("KINIC_NNS_AUDIT_DATABASE_ID is too long");
  const baseUrl = new URL(env.KINIC_NNS_API_BASE_URL?.trim() || DEFAULT_NNS_API_BASE_URL);
  if (baseUrl.protocol !== "https:") throw new Error("KINIC_NNS_API_BASE_URL must use https");
  baseUrl.pathname = baseUrl.pathname.replace(/\/+$/, "");
  baseUrl.search = "";
  baseUrl.hash = "";
  return { databaseId, apiBaseUrl: baseUrl.toString().replace(/\/$/, "") };
}

export async function runNnsAuditPoll(
  env: NnsRuntimeEnv,
  options: { retryFailed?: boolean } = {},
  context: NnsAuditPollContext = {}
): Promise<NnsAuditPollResult> {
  const auditConfig = loadNnsAuditConfig(env);
  if (!auditConfig) return { enabled: false, initialized: false, discovered: 0, enqueued: 0, resetFailed: 0 };
  const fetchJson = context.fetchJson ?? fetchApiJson;
  const now = context.now?.() ?? new Date();
  let cursor = await loadNnsCursor(env.DB, auditConfig.databaseId);
  if (!cursor) {
    const latestProposalId = parseLatestProposalId(await fetchJson(`${auditConfig.apiBaseUrl}/latest-proposal-id`));
    cursor = await initializeNnsCursor(env.DB, auditConfig.databaseId, latestProposalId, now);
    return {
      enabled: true,
      initialized: true,
      initialProposalId: cursor.initial_proposal_id,
      discovered: 0,
      enqueued: 0,
      resetFailed: 0
    };
  }

  const resetFailed = options.retryFailed ? await resetFailedNnsJobs(env.DB, auditConfig.databaseId, now) : 0;
  const discovery = await discoverProposalIds(fetchJson, auditConfig.apiBaseUrl, cursor.initial_proposal_id, cursor.latest_proposal_id);
  await persistDiscoveredProposals(env.DB, cursor, discovery.proposalIds, discovery.latestObservedProposalId, now);
  const enqueued = await enqueueDiscoveredJobs(env, auditConfig.databaseId, now);
  return {
    enabled: true,
    initialized: false,
    discovered: discovery.proposalIds.length,
    enqueued,
    resetFailed
  };
}

export async function getNnsAuditStatus(env: NnsRuntimeEnv): Promise<{ enabled: false } | ({ enabled: true } & NnsAuditStatus)> {
  const auditConfig = loadNnsAuditConfig(env);
  if (!auditConfig) return { enabled: false };
  return { enabled: true, ...(await loadNnsAuditStatus(env.DB, auditConfig.databaseId)) };
}

export async function processNnsQueueMessage(
  env: NnsRuntimeEnv,
  message: NnsProposalReviewQueueMessage,
  execution: QueueExecution,
  context: NnsQueueContext = {}
): Promise<QueueDisposition> {
  const auditConfig = loadNnsAuditConfig(env);
  if (!auditConfig) {
    return { kind: "reschedule", delaySeconds: 300, code: "nns_audit_disabled", message: "NNS audit database is not configured" };
  }
  if (message.databaseId !== auditConfig.databaseId) {
    return { kind: "dead_letter", code: "nns_database_mismatch", message: "NNS queue database does not match Worker configuration" };
  }
  const config = context.config ?? loadNnsWorkerConfig(env);
  const vfs = context.vfs ?? (await createVfsClient(config, env.KINIC_NNS_WORKER_IDENTITY_PEM));
  const claim = await claimNnsJob(env.DB, message, execution.leaseOwner);
  if (claim.kind === "missing") return retryDisposition("nns_job_missing", "NNS proposal job is missing", execution.attempts);
  if (claim.kind === "busy") {
    return { kind: "reschedule", delaySeconds: claim.retryAfterSeconds, code: "nns_job_busy", message: "NNS proposal job is already leased" };
  }
  if (claim.kind === "failed") return { kind: "ack" };
  if (claim.kind === "completed") return updateIndexDisposition(env, vfs, message, execution.attempts);

  let artifact: NnsGeneratedArtifact;
  if (claim.kind === "resume") {
    artifact = claim.artifact;
  } else {
    try {
      artifact = await generateNnsArtifact(env, message, auditConfig, config, vfs, context, claim.capturedInput, execution.leaseOwner);
      if (serializedBytes(artifact) > MAX_CHECKPOINT_BYTES) throw new NnsProposalValidationError("generated NNS checkpoint exceeded 1 MiB");
      await checkpointNnsArtifact(env.DB, message, execution.leaseOwner, artifact);
    } catch (error) {
      if (isPermanentNnsError(error) || execution.attempts >= 5) {
        await failNnsJob(env.DB, message, execution.leaseOwner, safeErrorMessage(error));
        return { kind: "dead_letter", code: nnsErrorCode(error), message: safeErrorMessage(error) };
      }
      await releaseNnsJobForRetry(env.DB, message, execution.leaseOwner, safeErrorMessage(error));
      const providerError = error instanceof DeepSeekRequestError ? error : null;
      return retryDisposition(
        providerError?.code ?? nnsErrorCode(error),
        safeErrorMessage(error),
        execution.attempts,
        providerError?.retryAfterSeconds
      );
    }
  }

  try {
    await publishArtifact(vfs, message.databaseId, artifact);
  } catch (error) {
    const conflict = error instanceof NnsCreateOnlyConflictError;
    if (conflict || execution.attempts >= 5) {
      await failNnsJob(env.DB, message, execution.leaseOwner, safeErrorMessage(error));
      return { kind: "dead_letter", code: conflict ? "nns_create_only_conflict" : "nns_commit_transient", message: safeErrorMessage(error) };
    }
    await releaseNnsJobForRetry(env.DB, message, execution.leaseOwner, safeErrorMessage(error));
    return retryDisposition("nns_commit_transient", safeErrorMessage(error), execution.attempts);
  }

  try {
    await completeNnsJob(env.DB, message, execution.leaseOwner);
  } catch (error) {
    let current;
    try {
      current = await loadNnsJob(env.DB, message.databaseId, message.proposalId);
    } catch {
      return {
        kind: "reschedule",
        delaySeconds: 30,
        code: "nns_completion_unknown",
        message: "NNS completion state could not be confirmed"
      };
    }
    if (current?.status !== "completed") {
      if (execution.attempts >= 5) {
        await failNnsJob(env.DB, message, execution.leaseOwner, safeErrorMessage(error));
        return { kind: "dead_letter", code: "nns_completion_transient", message: safeErrorMessage(error) };
      }
      await releaseNnsJobForRetry(env.DB, message, execution.leaseOwner, safeErrorMessage(error));
      return retryDisposition("nns_completion_transient", safeErrorMessage(error), execution.attempts);
    }
  }

  return updateIndexDisposition(env, vfs, message, execution.attempts);
}

export async function processNnsQueueMessageForTest(
  env: NnsRuntimeEnv,
  message: NnsProposalReviewQueueMessage,
  context: NnsQueueContext,
  execution: QueueExecution = { leaseOwner: "nns-test-owner", attempts: 1 }
): Promise<QueueDisposition> {
  return processNnsQueueMessage(env, message, execution, context);
}

async function discoverProposalIds(
  fetchJson: (url: string) => Promise<unknown>,
  apiBaseUrl: string,
  initialProposalId: number,
  latestProposalId: number
): Promise<{ proposalIds: number[]; latestObservedProposalId: number }> {
  const scanFloor = Math.max(initialProposalId, latestProposalId - DISCOVERY_OVERLAP);
  const proposalIds = new Set<number>();
  let latestObservedProposalId = latestProposalId;
  let previousProposalId = Number.POSITIVE_INFINITY;
  for (let page = 0; page < MAX_DISCOVERY_PAGES; page += 1) {
    const offset = page * DISCOVERY_PAGE_SIZE;
    const ids = parseProposalList(await fetchJson(`${apiBaseUrl}/proposals?limit=${DISCOVERY_PAGE_SIZE}&offset=${offset}`));
    for (const proposalId of ids) {
      if (proposalId > previousProposalId) {
        throw new NnsApiError("nns_api_invalid_order", "proposal list is not ordered newest first", true);
      }
      previousProposalId = proposalId;
      if (proposalId > initialProposalId) proposalIds.add(proposalId);
      latestObservedProposalId = Math.max(latestObservedProposalId, proposalId);
    }
    if (ids.length < DISCOVERY_PAGE_SIZE || Math.min(...ids) <= scanFloor) {
      return { proposalIds: [...proposalIds].sort((left, right) => left - right), latestObservedProposalId };
    }
  }
  throw new NnsApiError("nns_discovery_limit", "NNS proposal discovery exceeded 100 pages", true);
}

async function enqueueDiscoveredJobs(env: NnsRuntimeEnv, databaseId: string, now: Date): Promise<number> {
  let enqueued = 0;
  for (;;) {
    const proposalIds = await listEnqueueableNnsProposalIds(env.DB, databaseId, 100, now);
    if (proposalIds.length === 0) return enqueued;
    for (const proposalId of proposalIds) {
      await env.NNS_PROPOSAL_REVIEW_QUEUE.send({ kind: "nns_proposal_review", databaseId, proposalId });
      await markNnsJobQueued(env.DB, databaseId, proposalId, now);
      enqueued += 1;
    }
    if (proposalIds.length < 100) return enqueued;
  }
}

async function generateNnsArtifact(
  env: NnsRuntimeEnv,
  message: NnsProposalReviewQueueMessage,
  auditConfig: NnsAuditConfig,
  config: NnsWorkerConfig,
  vfs: VfsClient,
  context: NnsQueueContext,
  existingCapture: NnsCapturedInput | null,
  leaseOwner: string
): Promise<NnsGeneratedArtifact> {
  try {
    await vfs.checkDatabaseWriteCycles(message.databaseId);
  } catch {
    throw new NnsCostGateError("NNS audit database is not writable");
  }
  let capturedInput = existingCapture;
  if (!capturedInput) {
    const capturedAt = (context.now?.() ?? new Date()).toISOString();
    const apiUrl = `${auditConfig.apiBaseUrl}/proposals/${message.proposalId}`;
    const fetchJson = context.fetchJson ?? fetchApiJson;
    const snapshot = parseProposalDetailResponse(await fetchJson(apiUrl), message.proposalId, apiUrl, capturedAt, config.maxSourceChars);
    capturedInput = {
      schemaVersion: 1,
      snapshot,
      referenceStatus: snapshot.proposalUrl ? "pending" : "unavailable",
      reference: null
    };
    assertCheckpointSize(capturedInput, "captured NNS input");
    await checkpointNnsCapturedInput(env.DB, message, leaseOwner, capturedInput);
  }
  if (capturedInput.snapshot.proposalId !== message.proposalId) {
    throw new NnsProposalValidationError("captured NNS proposal id does not match queued proposal id");
  }
  if (capturedInput.referenceStatus === "pending") {
    const fetched = await fetchProposalReference(
      capturedInput.snapshot,
      config,
      context.fetchReference ?? ((url, maxBytes) => fetchUrlSource(url, maxBytes, NNS_USER_AGENT))
    );
    capturedInput = fetched
      ? fitCapturedReference(capturedInput.snapshot, fetched, Math.max(config.maxSourceChars, config.maxRawChars))
      : { ...capturedInput, referenceStatus: "unavailable", reference: null };
    assertCheckpointSize(capturedInput, "captured NNS input");
    await checkpointNnsCapturedInput(env.DB, message, leaseOwner, capturedInput);
  }
  const snapshot = capturedInput.snapshot;
  const fetchedReference = capturedInput.referenceStatus === "captured" ? capturedInput.reference : null;
  const source = proposalSourceNode(snapshot);
  const reference = fetchedReference ? proposalReferenceNode(snapshot, fetchedReference, config.maxSourceChars) : null;
  const policy = await ensureNnsReviewPolicy(vfs, message.databaseId);

  let draft: NnsReviewDraft | null = null;
  let llmDurationMs: number | null = null;
  if (isOpenAtCapture(snapshot.statusAtCapture)) {
    const startedAt = Date.now();
    const response = await (context.requestReview ?? requestDeepSeekDraft)(
      nnsReviewMessages(snapshot, policy, fetchedReference, config.maxRawChars),
      config,
      env.DEEPSEEK_API_KEY
    );
    llmDurationMs = Date.now() - startedAt;
    draft = parseNnsReviewResponse(response, snapshot.truncated);
    if (snapshot.proposalUrl && !fetchedReference && draft.recommendation !== "NEEDS_CLARIFICATION") {
      draft = {
        ...draft,
        recommendation: "NEEDS_CLARIFICATION",
        rationale: `The proposal's own reference URL could not be captured, so the Worker requires clarification. ${draft.rationale}`
      };
    }
  }
  const review = proposalReviewNode(snapshot, draft, config.model, reference?.path ?? null);
  return {
    schemaVersion: 1,
    proposalId: snapshot.proposalId,
    capturedAt: snapshot.capturedAt,
    action: snapshot.action,
    topic: snapshot.topic,
    statusAtCapture: snapshot.statusAtCapture,
    reviewDepth: reviewDepthForAction(snapshot.action),
    reviewStatus: draft ? "ai_generated" : "skipped_not_open",
    recommendation: draft?.recommendation ?? "NOT_APPLICABLE",
    model: draft ? config.model : "none",
    llmDurationMs,
    source,
    reference,
    review
  };
}

function fitCapturedReference(snapshot: NnsProposalSnapshot, fetched: FetchedUrlSource, maxChars: number): NnsCapturedInput {
  let reference: FetchedUrlSource = {
    ...fetched,
    text: fetched.text.slice(0, maxChars),
    fetchedTruncated: fetched.fetchedTruncated || fetched.text.length > maxChars
  };
  const emptyReferenceBytes = serializedBytes({
    schemaVersion: 1,
    snapshot,
    referenceStatus: "captured",
    reference: { ...reference, text: "", fetchedTruncated: true }
  });
  if (emptyReferenceBytes > MAX_CHECKPOINT_BYTES) throw new NnsProposalValidationError("captured NNS input exceeded 1 MiB");
  for (;;) {
    const capturedInput: NnsCapturedInput = { schemaVersion: 1, snapshot, referenceStatus: "captured", reference };
    const bytes = serializedBytes(capturedInput);
    if (bytes <= MAX_CHECKPOINT_BYTES) return capturedInput;
    if (reference.text.length === 0) throw new NnsProposalValidationError("captured NNS input exceeded 1 MiB");
    const encodedTextBytes = Math.max(1, bytes - emptyReferenceBytes);
    const averageBytesPerChar = encodedTextBytes / reference.text.length;
    const removeChars = Math.max(1, Math.ceil((bytes - MAX_CHECKPOINT_BYTES) / averageBytesPerChar));
    reference = {
      ...reference,
      text: reference.text.slice(0, Math.max(0, reference.text.length - removeChars)),
      fetchedTruncated: true
    };
  }
}

function assertCheckpointSize(value: unknown, label: string): void {
  if (serializedBytes(value) > MAX_CHECKPOINT_BYTES) throw new NnsProposalValidationError(`${label} exceeded 1 MiB`);
}

function serializedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

async function fetchProposalReference(
  snapshot: NnsProposalSnapshot,
  config: NnsWorkerConfig,
  fetchReference: (url: string, maxBytes: number) => Promise<FetchedUrlSource>
): Promise<FetchedUrlSource | null> {
  if (!snapshot.proposalUrl) return null;
  try {
    return await fetchReference(snapshot.proposalUrl, config.maxFetchedBytes);
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "nns_reference_fetch_unavailable",
        proposalId: snapshot.proposalId,
        code: referenceErrorCode(error)
      })
    );
    return null;
  }
}

async function ensureNnsReviewPolicy(vfs: VfsClient, databaseId: string): Promise<string> {
  const existing = await vfs.readNode(databaseId, POLICY_PATH);
  if (existing) {
    if (existing.kind !== "file") throw new NnsCreateOnlyConflictError(`review policy path is not a file: ${POLICY_PATH}`);
    return existing.content;
  }
  const node: NnsArtifactNode = {
    path: POLICY_PATH,
    kind: "file",
    content: DEFAULT_NNS_REVIEW_POLICY,
    metadataJson: JSON.stringify({ kind: "kinic.nns_review_policy", schema_version: 1 })
  };
  try {
    await writeCreateOnly(vfs, databaseId, node);
    return node.content;
  } catch (error) {
    if (!(error instanceof NnsCreateOnlyConflictError)) throw error;
    const latest = await vfs.readNode(databaseId, POLICY_PATH);
    if (!latest || latest.kind !== "file") throw error;
    return latest.content;
  }
}

async function publishArtifact(vfs: VfsClient, databaseId: string, artifact: NnsGeneratedArtifact): Promise<void> {
  await writeCreateOnly(vfs, databaseId, artifact.source);
  if (artifact.reference) await writeCreateOnly(vfs, databaseId, artifact.reference);
  await writeCreateOnly(vfs, databaseId, artifact.review);
}

async function writeCreateOnly(vfs: VfsClient, databaseId: string, node: NnsArtifactNode): Promise<void> {
  const existing = await vfs.readNode(databaseId, node.path);
  if (matchesArtifactNode(existing, node)) return;
  if (existing) throw new NnsCreateOnlyConflictError(`create-only path already has different content: ${node.path}`);
  await ensureParentFolders(vfs, databaseId, node.path);
  try {
    await vfs.writeNode({
      databaseId,
      path: node.path,
      kind: node.kind,
      content: node.content,
      metadataJson: node.metadataJson,
      expectedEtag: null
    });
  } catch (error) {
    if (!(error instanceof NodeMutationError) || error.code !== "etag_conflict") throw error;
    const latest = await vfs.readNode(databaseId, node.path);
    if (matchesArtifactNode(latest, node)) return;
    throw new NnsCreateOnlyConflictError(`create-only path changed during commit: ${node.path}`);
  }
}

async function updateNnsIndex(vfs: VfsClient, db: D1Database, databaseId: string): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const existing = await vfs.readNode(databaseId, INDEX_PATH);
    if (existing && existing.kind !== "file") throw new NnsCreateOnlyConflictError(`NNS index path is not a file: ${INDEX_PATH}`);
    const entries = await listCompletedNnsIndexEntries(db, databaseId);
    const content = renderNnsIndex(entries, new Date().toISOString());
    await ensureParentFolders(vfs, databaseId, INDEX_PATH);
    try {
      await vfs.writeNode({
        databaseId,
        path: INDEX_PATH,
        kind: "file",
        content,
        metadataJson: JSON.stringify({ generated_by: "nns-proposal-review-worker", kind: "kinic.nns_proposal_review_index", schema_version: 1 }),
        expectedEtag: existing?.etag ?? null
      });
      return;
    } catch (error) {
      if (!(error instanceof NodeMutationError) || error.code !== "etag_conflict" || attempt === 3) throw error;
    }
  }
}

async function updateIndexDisposition(
  env: NnsRuntimeEnv,
  vfs: VfsClient,
  message: NnsProposalReviewQueueMessage,
  attempts: number
): Promise<QueueDisposition> {
  try {
    await updateNnsIndex(vfs, env.DB, message.databaseId);
    await markNnsIndexSynced(env.DB, message.databaseId, message.proposalId);
    return { kind: "ack" };
  } catch (error) {
    if (attempts >= 5 || error instanceof NnsCreateOnlyConflictError) {
      return { kind: "dead_letter", code: "nns_index_update_failed", message: safeErrorMessage(error) };
    }
    return retryDisposition("nns_index_update_failed", safeErrorMessage(error), attempts);
  }
}

async function fetchApiJson(url: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { accept: "application/json", "user-agent": NNS_USER_AGENT },
      redirect: "manual",
      signal: AbortSignal.timeout(API_TIMEOUT_MS)
    });
  } catch (error) {
    const timeout = error instanceof DOMException && error.name === "TimeoutError";
    throw new NnsApiError(timeout ? "nns_api_timeout" : "nns_api_network", timeout ? "NNS API request timed out" : "NNS API request failed", true);
  }
  if (!response.ok) {
    const retryable = response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500;
    throw new NnsApiError(`nns_api_http_${response.status}`, `NNS API request failed with ${response.status}`, retryable);
  }
  const text = await readBoundedText(response, MAX_API_RESPONSE_BYTES);
  try {
    return JSON.parse(text);
  } catch {
    throw new NnsApiError("nns_api_invalid_json", "NNS API response is not valid JSON", true);
  }
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared && Number(declared) > maxBytes) throw new NnsApiError("nns_api_response_too_large", "NNS API response exceeded 2 MiB", false);
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel("response too large");
      throw new NnsApiError("nns_api_response_too_large", "NNS API response exceeded 2 MiB", false);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function parseLatestProposalId(body: unknown): number {
  if (!isObject(body)) throw new NnsApiError("nns_api_invalid_latest", "latest proposal response must be an object", true);
  const id = proposalId(body.latest_proposal_id);
  if (!id) throw new NnsApiError("nns_api_invalid_latest", "latest proposal response has no valid id", true);
  return id;
}

function parseProposalList(body: unknown): number[] {
  if (!isObject(body) || !Array.isArray(body.data)) throw new NnsApiError("nns_api_invalid_list", "proposal list response has an invalid shape", true);
  const ids = body.data.map((entry) => (isObject(entry) ? proposalId(entry.proposal_id) : null));
  if (ids.some((id) => id === null)) throw new NnsApiError("nns_api_invalid_list", "proposal list contains an invalid id", true);
  return ids as number[];
}

function proposalId(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function matchesArtifactNode(existing: Awaited<ReturnType<VfsClient["readNode"]>>, node: NnsArtifactNode): boolean {
  return existing?.kind === node.kind && existing.content === node.content && existing.metadataJson === node.metadataJson;
}

function retryDisposition(code: string, message: string, attempts: number, explicitDelay?: number): QueueDisposition {
  return {
    kind: "retry",
    delaySeconds: explicitDelay ?? Math.min(300, 15 * 2 ** Math.max(0, attempts - 1)),
    code,
    message
  };
}

function isPermanentNnsError(error: unknown): boolean {
  return (
    error instanceof NnsCostGateError ||
    error instanceof NnsProposalValidationError ||
    error instanceof NnsReviewValidationError ||
    error instanceof DeepSeekResponseError ||
    (error instanceof DeepSeekRequestError && !error.retryable) ||
    (error instanceof NnsApiError && !error.retryable)
  );
}

function nnsErrorCode(error: unknown): string {
  if (error instanceof NnsApiError || error instanceof DeepSeekRequestError) return error.code;
  if (error instanceof NnsCostGateError) return "nns_cost_gate";
  if (error instanceof NnsProposalValidationError) return "nns_proposal_invalid";
  if (error instanceof NnsReviewValidationError || error instanceof DeepSeekResponseError) return "nns_review_invalid";
  return "nns_processing_transient";
}

function referenceErrorCode(error: unknown): string {
  const message = safeErrorMessage(error).toLowerCase();
  if (message.includes("hostname") || message.includes("protocol") || message.includes("invalid")) return "reference_url_rejected";
  if (message.includes("content-type")) return "reference_content_type_rejected";
  if (message.includes("redirect")) return "reference_redirect_rejected";
  return "reference_fetch_failed";
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof NnsProposalValidationError) return "NNS proposal data failed validation";
  if (error instanceof NnsReviewValidationError || error instanceof DeepSeekResponseError) return "AI review failed schema validation";
  if (error instanceof Error) return error.message.slice(0, 1000);
  return "NNS proposal processing failed";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

class NnsApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean
  ) {
    super(message);
    this.name = "NnsApiError";
  }
}

class NnsCostGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NnsCostGateError";
  }
}

class NnsCreateOnlyConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NnsCreateOnlyConflictError";
  }
}
