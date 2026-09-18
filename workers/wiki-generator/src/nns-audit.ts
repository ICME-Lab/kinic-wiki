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
  NnsProposalValidationError,
  NnsReviewValidationError,
  isOpenAtCapture,
  nnsReviewMessages,
  parseNnsReviewResponse,
  parseProposalDetailResponse,
  proposalEvidenceBundleNode,
  proposalEvidenceSourceNode,
  proposalReviewNode,
  proposalSourceNode,
  renderNnsIndex,
  reviewDepthForAction,
  type NnsArtifactNode,
  type NnsCapturedInput,
  type NnsEvidenceAttempt,
  type NnsGeneratedArtifact,
  type NnsProposalSnapshot,
  type NnsReviewDraft
} from "./nns-review.js";
import { DeepSeekRequestError, DeepSeekResponseError, requestDeepSeekDraft } from "./openai.js";
import { parseFrontmatter } from "./frontmatter.js";
import { actionDefinition } from "./nns-actions.js";
import { buildDecisionRecord, decisionHistoryNode, decisionNode, governanceNode } from "./nns-decision.js";
import { createNnsGovernanceClient, dashboardMatchesGovernance, NNS_PROPOSAL_STATUS_OPEN, type NnsGovernanceClient } from "./nns-governance.js";
import { aggregateJevDecision, requestJevDecision, type NnsJevAnswer, type NnsJevDecision } from "./nns-jev.js";
import {
  DEFAULT_NNS_AUTOVOTE_POLICY,
  NNS_AUTOVOTE_POLICY_PATH,
  actionPolicy,
  loadNnsPolicyNode,
  parseNnsAutovotePolicy,
  sha256Hex,
  type LoadedNnsPolicy
} from "./nns-policy.js";
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
  config?: NnsWorkerConfig;
  vfs?: VfsClient;
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
  governance?: NnsGovernanceClient;
  requestJev?: (
    state: Record<string, unknown>,
    policy: LoadedNnsPolicy["policy"],
    apiKey: string
  ) => Promise<{ answer: NnsJevAnswer; model: string; durationMs: number }>;
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
  const config = context.config ?? loadNnsWorkerConfig(env);
  const vfs = context.vfs ?? (await createVfsClient(config, env.KINIC_NNS_WORKER_IDENTITY_PEM));
  let cursor = await loadNnsCursor(vfs, auditConfig.databaseId);
  if (!cursor) {
    const latestProposalId = parseLatestProposalId(await fetchJson(`${auditConfig.apiBaseUrl}/latest-proposal-id`));
    cursor = await initializeNnsCursor(vfs, auditConfig.databaseId, latestProposalId, now);
    return {
      enabled: true,
      initialized: true,
      initialProposalId: cursor.initial_proposal_id,
      discovered: 0,
      enqueued: 0,
      resetFailed: 0
    };
  }

  const resetFailed = options.retryFailed ? await resetFailedNnsJobs(vfs, auditConfig.databaseId, now) : 0;
  const discovery = await discoverProposalIds(fetchJson, auditConfig.apiBaseUrl, cursor.initial_proposal_id, cursor.latest_proposal_id);
  await persistDiscoveredProposals(vfs, cursor, discovery.proposalIds, discovery.latestObservedProposalId, now);
  const enqueued = await enqueueDiscoveredJobs(env, vfs, auditConfig.databaseId, now);
  return {
    enabled: true,
    initialized: false,
    discovered: discovery.proposalIds.length,
    enqueued,
    resetFailed
  };
}

export async function getNnsAuditStatus(env: NnsRuntimeEnv): Promise<
  { enabled: false } | ({ enabled: true; policy: { hash: string; mode: "shadow" | "live"; policyEnabled: boolean; valid: boolean } | null } & NnsAuditStatus)
> {
  const auditConfig = loadNnsAuditConfig(env);
  if (!auditConfig) return { enabled: false };
  let policy: { hash: string; mode: "shadow" | "live"; policyEnabled: boolean; valid: boolean } | null = null;
  const config = loadNnsWorkerConfig(env);
  const vfs = await createVfsClient(config, env.KINIC_NNS_WORKER_IDENTITY_PEM);
  const status = await loadNnsAuditStatus(vfs, auditConfig.databaseId);
  try {
    const loaded = await loadNnsPolicyNode(await vfs.readNode(auditConfig.databaseId, NNS_AUTOVOTE_POLICY_PATH));
    policy = { hash: loaded.hash, mode: loaded.policy.mode, policyEnabled: loaded.policy.enabled, valid: loaded.valid };
  } catch { /* Status remains available while policy storage is unavailable. */ }
  return { enabled: true, policy, ...status };
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
  const claim = await claimNnsJob(vfs, message, execution.leaseOwner);
  if (claim.kind === "missing") return retryDisposition("nns_job_missing", "NNS proposal job is missing", execution.attempts);
  if (claim.kind === "busy") {
    return { kind: "reschedule", delaySeconds: claim.retryAfterSeconds, code: "nns_job_busy", message: "NNS proposal job is already leased" };
  }
  if (claim.kind === "failed") return { kind: "ack" };
  if (claim.kind === "completed") return updateIndexDisposition(env, vfs, message, execution.attempts);

  let artifact: NnsGeneratedArtifact;
  if (claim.kind === "resume") {
    artifact = claim.artifact;
    if (artifact.reviewStatus === "explanation_pending") {
      try {
        artifact = await retryNnsExplanation(env, config, artifact, context, vfs, message.databaseId);
        await writeReview(vfs, message.databaseId, artifact.review, artifact.reviewStatus);
        await checkpointNnsArtifact(vfs, message, execution.leaseOwner, artifact);
      } catch (error) {
        await releaseNnsJobForRetry(vfs, message, execution.leaseOwner, safeErrorMessage(error));
        return retryDisposition("nns_explanation_retry", safeErrorMessage(error), execution.attempts);
      }
    }
  } else {
    try {
      artifact = await generateNnsArtifact(env, message, auditConfig, config, vfs, context, claim.capturedInput, execution.leaseOwner);
      await writeReview(vfs, message.databaseId, artifact.review, artifact.reviewStatus);
      await checkpointNnsArtifact(vfs, message, execution.leaseOwner, artifact);
    } catch (error) {
      if (isPermanentNnsError(error) || execution.attempts >= 5) {
        await failNnsJob(vfs, message, execution.leaseOwner, safeErrorMessage(error));
        return { kind: "dead_letter", code: nnsErrorCode(error), message: safeErrorMessage(error) };
      }
      await releaseNnsJobForRetry(vfs, message, execution.leaseOwner, safeErrorMessage(error));
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
    await publishDecisionArtifacts(vfs, message.databaseId, artifact.decisionRecord);
  } catch (error) {
    const conflict = error instanceof NnsCreateOnlyConflictError;
    if (conflict || execution.attempts >= 5) {
      await failNnsJob(vfs, message, execution.leaseOwner, safeErrorMessage(error));
      return { kind: "dead_letter", code: conflict ? "nns_create_only_conflict" : "nns_commit_transient", message: safeErrorMessage(error) };
    }
    await releaseNnsJobForRetry(vfs, message, execution.leaseOwner, safeErrorMessage(error));
    return retryDisposition("nns_commit_transient", safeErrorMessage(error), execution.attempts);
  }

  if (artifact.decisionRecord.autoVoteEligible && config.neuronId) {
    try {
      await env.NNS_VOTE_QUEUE.send({
        kind: "nns_vote_intent",
        databaseId: message.databaseId,
        proposalId: String(message.proposalId),
        neuronId: config.neuronId,
        action: artifact.action,
        vote: artifact.decisionRecord.outcome === "ADOPT" ? "YES" : "NO",
        decisionHash: artifact.decisionRecord.decisionId,
        policyHash: artifact.decisionRecord.policyHash,
        evidenceHash: artifact.decisionRecord.evidenceHash,
        decidedAt: artifact.decisionRecord.decidedAt
      });
    } catch (error) {
      await releaseNnsJobForRetry(vfs, message, execution.leaseOwner, safeErrorMessage(error));
      return retryDisposition("nns_vote_intent_enqueue_failed", "NNS vote intent could not be queued", execution.attempts);
    }
  }

  try {
    await completeNnsJob(vfs, message, execution.leaseOwner);
  } catch (error) {
    let current;
    try {
      current = await loadNnsJob(vfs, message.databaseId, message.proposalId);
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
        await failNnsJob(vfs, message, execution.leaseOwner, safeErrorMessage(error));
        return { kind: "dead_letter", code: "nns_completion_transient", message: safeErrorMessage(error) };
      }
      await releaseNnsJobForRetry(vfs, message, execution.leaseOwner, safeErrorMessage(error));
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

async function enqueueDiscoveredJobs(env: NnsRuntimeEnv, vfs: VfsClient, databaseId: string, now: Date): Promise<number> {
  let enqueued = 0;
  for (;;) {
    const proposalIds = await listEnqueueableNnsProposalIds(vfs, databaseId, 100, now);
    if (proposalIds.length === 0) return enqueued;
    for (const proposalId of proposalIds) {
      await env.NNS_PROPOSAL_REVIEW_QUEUE.send({ kind: "nns_proposal_review", databaseId, proposalId, reason: "discovery" });
      await markNnsJobQueued(vfs, databaseId, proposalId, now);
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
    const storedSource = await vfs.readNode(message.databaseId, `/Sources/nns/proposals/${message.proposalId}/proposal.md`);
    const snapshot = storedSource
      ? parseProposalArtifact(storedSource.content, message.proposalId)
      : await captureDashboardProposal(auditConfig, config, context, message.proposalId);
    const storedEvidence = await vfs.readNode(message.databaseId, `/Knowledge/nns/proposals/${message.proposalId}/evidence.md`);
    capturedInput = storedEvidence
      ? await capturedInputFromEvidence(vfs, message.databaseId, snapshot, storedEvidence.content)
      : {
          schemaVersion: 1,
          snapshot,
          referenceStatus: extractEvidenceUrls(snapshot).length > 0 ? "pending" : "unavailable",
          reference: null,
          evidenceUrls: extractEvidenceUrls(snapshot),
          evidenceSources: []
        };
    assertCheckpointSize(capturedInput, "captured NNS input");
    await checkpointNnsCapturedInput(vfs, message, leaseOwner, capturedInput);
  }
  if (capturedInput.snapshot.proposalId !== message.proposalId) {
    throw new NnsProposalValidationError("captured NNS proposal id does not match queued proposal id");
  }
  if (capturedInput.referenceStatus === "pending") {
    const fetched = await fetchProposalEvidence(
      capturedInput.snapshot,
      config,
      capturedInput.evidenceUrls ?? extractEvidenceUrls(capturedInput.snapshot),
      context.fetchReference ?? ((url, maxBytes) => fetchUrlSource(url, maxBytes, NNS_USER_AGENT))
    );
    const fitted = fitEvidenceSources(fetched.sources, Math.min(config.maxSourceChars, config.maxRawChars));
    capturedInput = fitted.length > 0
      ? {
          ...capturedInput,
          referenceStatus: "captured",
          reference: null,
          evidenceSources: fitted,
          evidenceFailures: fetched.failures
        }
      : {
          ...capturedInput, referenceStatus: "unavailable", reference: null, evidenceSources: [],
          evidenceFailures: fetched.failures
        };
    assertCheckpointSize(capturedInput, "captured NNS input");
    await checkpointNnsCapturedInput(vfs, message, leaseOwner, capturedInput);
  }
  const snapshot = capturedInput.snapshot;
  const legacyReference = capturedInput.referenceStatus === "captured" ? capturedInput.reference : null;
  const fetchedEvidence = capturedInput.evidenceSources?.length
    ? capturedInput.evidenceSources
    : legacyReference ? [legacyReference] : [];
  const fetchedReference = fetchedEvidence.length ? combineEvidence(fetchedEvidence) : null;
  const source = proposalSourceNode(snapshot);
  const evidenceSources = fetchedEvidence.map((item, index) => proposalEvidenceSourceNode(snapshot, item, index, config.maxSourceChars));
  const attempts = await evidenceAttempts(
    capturedInput.evidenceUrls ?? [], fetchedEvidence, evidenceSources, capturedInput.evidenceFailures ?? []
  );
  const evidence = proposalEvidenceBundleNode(snapshot, fetchedEvidence, evidenceSources, attempts);
  const governanceClient = context.governance ?? (await createNnsGovernanceClient(config.icHost));
  const existingGovernance = await vfs.readNode(message.databaseId, `/Sources/nns/proposals/${snapshot.proposalId}/governance.md`);
  const authoritativeProposal = existingGovernance
    ? parseGovernanceArtifact(existingGovernance.content, snapshot.proposalId)
    : isOpenAtCapture(snapshot.statusAtCapture) ? await governanceClient.getPendingProposal(BigInt(snapshot.proposalId)) : null;
  const governanceSnapshot = authoritativeProposal ? { ...authoritativeProposal, ballots: {}, capturedAt: snapshot.capturedAt } : null;
  const currentGovernance = message.reason === "policy_changed"
    ? await governanceClient.getProposal(BigInt(snapshot.proposalId))
    : governanceSnapshot;
  const governance = governanceNode(snapshot, governanceSnapshot);
  await writeCreateOnly(vfs, message.databaseId, source);
  await writeCreateOnly(vfs, message.databaseId, governance);
  for (const evidenceSource of evidenceSources) await writeCreateOnly(vfs, message.databaseId, evidenceSource);
  await writeCreateOnly(vfs, message.databaseId, evidence);
  const loadedPolicy = await ensureNnsAutovotePolicy(vfs, message.databaseId);
  const definition = actionDefinition(snapshot.action);
  const selectedPolicy = actionPolicy(loadedPolicy.policy, snapshot.action);
  const nowSeconds = Math.floor((context.now?.() ?? new Date()).getTime() / 1000);
  const deadline = currentGovernance?.deadlineTimestampSeconds ? Number(currentGovernance.deadlineTimestampSeconds) : Number.NaN;
  const availableEvidence = {
    proposal: !snapshot.truncated,
    governance: governanceSnapshot !== null,
    reference: attempts.length > 0 && attempts.every((item) => item.status === "captured")
  };
  const requiredEvidence = [...new Set([...(definition?.requiredEvidence ?? ["proposal", "governance"]), ...selectedPolicy.requiredEvidence])];
  const checks = {
    policyValid: loadedPolicy.valid,
    proposalOpen: isOpenAtCapture(snapshot.statusAtCapture) && currentGovernance?.status === NNS_PROPOSAL_STATUS_OPEN,
    beforeDeadline: Number.isFinite(deadline) && deadline > nowSeconds,
    dashboardMatchesGovernance: governanceSnapshot !== null && dashboardMatchesGovernance(snapshot, governanceSnapshot),
    actionKnown: definition !== null,
    requiredEvidenceComplete: requiredEvidence.every((kind) => availableEvidence[kind])
  };
  let jevDecision: NnsJevDecision;
  if (!selectedPolicy.evaluate || !isOpenAtCapture(snapshot.statusAtCapture)) {
    jevDecision = aggregateJevDecision(null, loadedPolicy.policy, checks);
    jevDecision.reasons = [selectedPolicy.evaluate ? "proposal_not_open" : "policy_evaluation_disabled"];
  } else {
    try {
      const jev = await (context.requestJev ?? requestJevDecision)(
        {
          policy: {
            version: loadedPolicy.policy.policyVersion,
            action: selectedPolicy,
            action_registry: definition
          },
          governance_proposal: governanceSnapshot,
          dashboard_snapshot: snapshot.rawRecord,
          reference_evidence: {
            manifest: attempts,
            sources: fetchedEvidence.map((item) => ({
              category: isForumUrl(item.finalUrl) ? "forum" : "reference",
              url: item.finalUrl,
              text: item.text.slice(0, config.maxRawChars),
              truncated: item.fetchedTruncated || item.text.length > config.maxRawChars
            }))
          }
        },
        loadedPolicy.policy,
        env.TYPESAFE_API_KEY
      );
      jevDecision = aggregateJevDecision(jev.answer, loadedPolicy.policy, checks, jev.model, jev.durationMs);
    } catch {
      jevDecision = aggregateJevDecision(null, loadedPolicy.policy, checks);
    }
  }
  const decisionRecord = await buildDecisionRecord({
    snapshot,
    governance: governanceSnapshot,
    reference: fetchedReference,
    references: fetchedEvidence,
    policy: loadedPolicy,
    decision: jevDecision,
    checks,
    decidedAt: (context.now?.() ?? new Date()).toISOString()
  });
  const preReview = proposalReviewNode(
    snapshot, null, config.model, evidence.path,
    isOpenAtCapture(snapshot.statusAtCapture) ? decisionRecord.outcome : null,
    decisionRecord.decisionId
  );
  await checkpointNnsArtifact(vfs, message, leaseOwner, {
    schemaVersion: 2, proposalId: snapshot.proposalId, capturedAt: snapshot.capturedAt,
    action: snapshot.action, topic: snapshot.topic, statusAtCapture: snapshot.statusAtCapture,
    reviewDepth: reviewDepthForAction(snapshot.action),
    reviewStatus: isOpenAtCapture(snapshot.statusAtCapture) ? "explanation_pending" : "skipped_not_open",
    recommendation: decisionRecord.outcome === "HOLD" ? "NEEDS_CLARIFICATION" : decisionRecord.outcome,
    model: "none", llmDurationMs: null, source, governance, reference: evidence,
    evidenceSources: [], evidence, decision: decisionNode(decisionRecord), decisionRecord,
    review: preReview, explanationSnapshot: null, explanationMessages: null
  });
  await publishDecisionArtifacts(vfs, message.databaseId, decisionRecord);

  let draft: NnsReviewDraft | null = null;
  let llmDurationMs: number | null = null;
  let explanationMessages: { role: "system" | "user"; content: string }[] | null = null;
  let explanationPending = false;
  if (isOpenAtCapture(snapshot.statusAtCapture)) {
    explanationMessages = nnsReviewMessages(snapshot, loadedPolicy.content, fetchedReference, config.maxRawChars, {
        outcome: decisionRecord.outcome,
        decisionId: decisionRecord.decisionId
      });
    const startedAt = Date.now();
    try {
      const response = await (context.requestReview ?? requestDeepSeekDraft)(explanationMessages, config, env.DEEPSEEK_API_KEY);
      llmDurationMs = Date.now() - startedAt;
      draft = bindDraftToDecision(parseNnsReviewResponse(response, snapshot.truncated), decisionRecord.outcome);
      explanationMessages = null;
    } catch {
      explanationPending = true;
    }
  }
  const review = proposalReviewNode(
    snapshot, draft, config.model, evidence.path,
    explanationPending ? decisionRecord.outcome : null, decisionRecord.decisionId
  );
  return {
    schemaVersion: 2,
    proposalId: snapshot.proposalId,
    capturedAt: snapshot.capturedAt,
    action: snapshot.action,
    topic: snapshot.topic,
    statusAtCapture: snapshot.statusAtCapture,
    reviewDepth: reviewDepthForAction(snapshot.action),
    reviewStatus: draft ? "ai_generated" : explanationPending ? "explanation_pending" : "skipped_not_open",
    recommendation: draft?.recommendation ?? "NOT_APPLICABLE",
    model: draft ? config.model : "none",
    llmDurationMs,
    source,
    governance,
    reference: evidence,
    evidenceSources: [],
    evidence,
    decision: decisionNode(decisionRecord),
    decisionRecord,
    review,
    explanationSnapshot: explanationPending ? snapshot : null,
    explanationMessages
  };
}

async function captureDashboardProposal(
  auditConfig: NnsAuditConfig, config: NnsWorkerConfig, context: NnsQueueContext, proposalIdValue: number
): Promise<NnsProposalSnapshot> {
  const capturedAt = (context.now?.() ?? new Date()).toISOString();
  const apiUrl = `${auditConfig.apiBaseUrl}/proposals/${proposalIdValue}`;
  return parseProposalDetailResponse(
    await (context.fetchJson ?? fetchApiJson)(apiUrl), proposalIdValue, apiUrl, capturedAt, config.maxSourceChars
  );
}

function parseProposalArtifact(content: string, proposalIdValue: number): NnsProposalSnapshot {
  const fields = parseFrontmatter(content)?.fields;
  const match = content.match(/## Sanitized Official API Record\n\n```json\n([\s\S]*?)\n```/);
  if (!fields || fields.proposal_id !== String(proposalIdValue) || !match) {
    throw new NnsProposalValidationError("stored Dashboard proposal snapshot is invalid");
  }
  const title = content.match(/^# NNS Proposal \d+: (.*)$/m)?.[1] ?? `NNS Proposal ${proposalIdValue}`;
  const summary = content.match(/## Summary\n\n([\s\S]*?)\n\n## Sanitized Official API Record/)?.[1] ?? "";
  return {
    proposalId: proposalIdValue, title, summary: summary === "No summary was provided." ? "" : summary,
    topic: fields.topic ?? "Unknown", proposalUrl: fields.proposal_url || null,
    action: fields.action ?? "Unknown", statusAtCapture: fields.status_at_capture ?? "Unknown",
    capturedAt: fields.captured_at ?? "", apiUrl: fields.api_url ?? "",
    rawRecord: JSON.parse(match[1]!) as Record<string, unknown>, truncated: fields.truncated === "true"
  };
}

async function capturedInputFromEvidence(
  vfs: VfsClient, databaseId: string, snapshot: NnsProposalSnapshot, content: string
): Promise<NnsCapturedInput> {
  const match = content.match(/```json\n([\s\S]*?)\n```/);
  if (!match) throw new NnsProposalValidationError("stored evidence manifest is invalid");
  const parsed = JSON.parse(match[1]!) as { attempts?: NnsEvidenceAttempt[] };
  if (!Array.isArray(parsed.attempts)) throw new NnsProposalValidationError("stored evidence attempts are invalid");
  const sources: FetchedUrlSource[] = [];
  const failures: { url: string; errorCode: string }[] = [];
  for (const attempt of parsed.attempts) {
    if (attempt.status === "unavailable") {
      failures.push({ url: attempt.requestedUrl, errorCode: attempt.errorCode ?? "reference_fetch_unavailable" });
      continue;
    }
    if (!attempt.sourcePath) throw new NnsProposalValidationError("stored evidence source path is missing");
    const node = await vfs.readNode(databaseId, attempt.sourcePath);
    if (!node) throw new NnsProposalValidationError("stored evidence source is missing");
    sources.push(parseEvidenceSourceArtifact(node.content, attempt));
  }
  return {
    schemaVersion: 1, snapshot,
    referenceStatus: sources.length ? "captured" : "unavailable", reference: null,
    evidenceUrls: parsed.attempts.map((attempt) => attempt.requestedUrl),
    evidenceSources: sources, evidenceFailures: failures
  };
}

function parseEvidenceSourceArtifact(content: string, attempt: NnsEvidenceAttempt): FetchedUrlSource {
  const fields = parseFrontmatter(content)?.fields;
  const text = content.match(/Category:[^\n]*\n\n([\s\S]*)$/)?.[1];
  if (!fields || text === undefined || fields.url !== attempt.requestedUrl) {
    throw new NnsProposalValidationError("stored evidence source is invalid");
  }
  const bytes = new TextEncoder().encode(text).byteLength;
  return {
    url: attempt.requestedUrl, finalUrl: fields.final_url ?? attempt.finalUrl ?? attempt.requestedUrl,
    title: fields.title ?? null, contentType: "text/markdown", text,
    fetchedTruncated: attempt.status === "truncated", fetchedBytes: bytes, maxFetchedBytes: bytes
  };
}

async function retryNnsExplanation(
  env: NnsRuntimeEnv,
  config: NnsWorkerConfig,
  artifact: NnsGeneratedArtifact,
  context: NnsQueueContext,
  vfs: VfsClient,
  databaseId: string
): Promise<NnsGeneratedArtifact> {
  let snapshot = artifact.explanationSnapshot;
  let messages = artifact.explanationMessages;
  if (!snapshot || !messages) {
    const proposalNode = await vfs.readNode(databaseId, artifact.source.path);
    const evidenceNode = artifact.evidence ? await vfs.readNode(databaseId, artifact.evidence.path) : null;
    const policyNode = await vfs.readNode(databaseId, NNS_AUTOVOTE_POLICY_PATH);
    if (!proposalNode || !evidenceNode || !policyNode) throw new NnsProposalValidationError("pending explanation sources are missing");
    snapshot = parseProposalArtifact(proposalNode.content, artifact.proposalId);
    const captured = await capturedInputFromEvidence(vfs, databaseId, snapshot, evidenceNode.content);
    const reference = captured.evidenceSources?.length ? combineEvidence(captured.evidenceSources) : null;
    messages = nnsReviewMessages(snapshot, policyNode.content, reference, config.maxRawChars, {
      outcome: artifact.decisionRecord.outcome, decisionId: artifact.decisionRecord.decisionId
    });
  }
  const startedAt = Date.now();
  const response = await (context.requestReview ?? requestDeepSeekDraft)(messages, config, env.DEEPSEEK_API_KEY);
  const draft = bindDraftToDecision(
    parseNnsReviewResponse(response, snapshot.truncated),
    artifact.decisionRecord.outcome
  );
  return {
    ...artifact,
    reviewStatus: "ai_generated",
    recommendation: draft.recommendation,
    model: config.model,
    llmDurationMs: Date.now() - startedAt,
    review: proposalReviewNode(
      snapshot, draft, config.model, artifact.reference?.path ?? null,
      null, artifact.decisionRecord.decisionId
    ),
    explanationSnapshot: null,
    explanationMessages: null
  };
}

function bindDraftToDecision(draft: NnsReviewDraft, outcome: "ADOPT" | "REJECT" | "HOLD"): NnsReviewDraft {
  return { ...draft, recommendation: outcome === "HOLD" ? "NEEDS_CLARIFICATION" : outcome };
}

function fitEvidenceSources(sources: FetchedUrlSource[], maxBytes: number): FetchedUrlSource[] {
  if (sources.length === 0) return [];
  const perSource = Math.max(1, Math.min(maxBytes, Math.floor(160_000 / sources.length)));
  return sources.map((source) => ({
    ...source,
    ...truncateUtf8Source(source.text, perSource),
    fetchedTruncated: source.fetchedTruncated || new TextEncoder().encode(source.text).byteLength > perSource
  }));
}

function combineEvidence(sources: FetchedUrlSource[]): FetchedUrlSource {
  const first = sources[0]!;
  return {
    ...first,
    title: `Evidence bundle (${sources.length} sources)`,
    text: sources.map((source, index) => [
      `## Evidence ${index + 1}: ${isForumUrl(source.finalUrl) ? "Forum" : "Reference"}`,
      `URL: ${source.finalUrl}`,
      source.text
    ].join("\n\n")).join("\n\n---\n\n"),
    fetchedTruncated: sources.some((source) => source.fetchedTruncated),
    fetchedBytes: sources.reduce((total, source) => total + source.fetchedBytes, 0),
    maxFetchedBytes: sources.reduce((total, source) => total + source.maxFetchedBytes, 0)
  };
}

function extractEvidenceUrls(snapshot: NnsProposalSnapshot): string[] {
  const found = new Set<string>();
  if (snapshot.proposalUrl) found.add(snapshot.proposalUrl);
  const text = `${snapshot.summary}\n${JSON.stringify(snapshot.rawRecord)}`;
  for (const match of text.matchAll(/https?:\/\/[^\s<>()\]"']+/g)) {
    const candidate = match[0].replace(/[.,;:!?]+$/, "");
    try {
      const url = new URL(candidate);
      if (url.protocol === "https:" || url.protocol === "http:") found.add(url.toString());
    } catch { /* Ignore malformed links in proposal prose. */ }
  }
  return [...found].sort((left, right) => Number(isForumUrl(right)) - Number(isForumUrl(left))).slice(0, 6);
}

function isForumUrl(value: string): boolean {
  try { return new URL(value).hostname.toLowerCase() === "forum.dfinity.org"; }
  catch { return false; }
}

function assertCheckpointSize(value: unknown, label: string): void {
  if (serializedBytes(value) > MAX_CHECKPOINT_BYTES) throw new NnsProposalValidationError(`${label} exceeded 1 MiB`);
}

function serializedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

async function fetchProposalEvidence(
  snapshot: NnsProposalSnapshot,
  config: NnsWorkerConfig,
  urls: string[],
  fetchReference: (url: string, maxBytes: number) => Promise<FetchedUrlSource>
): Promise<{ sources: FetchedUrlSource[]; failures: { url: string; errorCode: string }[] }> {
  const output: FetchedUrlSource[] = [];
  const failures: { url: string; errorCode: string }[] = [];
  for (const url of urls) {
    try {
      output.push(await fetchReference(url, config.maxFetchedBytes));
    } catch (error) {
      failures.push({ url, errorCode: referenceErrorCode(error) });
      console.warn(JSON.stringify({
        event: "nns_evidence_fetch_unavailable",
        proposalId: snapshot.proposalId,
        url,
        code: referenceErrorCode(error)
      }));
    }
  }
  return { sources: output, failures };
}

async function evidenceAttempts(
  urls: string[], sources: FetchedUrlSource[], nodes: NnsArtifactNode[], failures: { url: string; errorCode: string }[]
): Promise<NnsEvidenceAttempt[]> {
  return Promise.all(urls.map(async (url) => {
    const index = sources.findIndex((source) => source.url === url);
    if (index < 0) return {
      requestedUrl: url, status: "unavailable" as const, sourcePath: null, finalUrl: null,
      errorCode: failures.find((failure) => failure.url === url)?.errorCode ?? "reference_fetch_unavailable", contentHash: null
    };
    const source = sources[index]!;
    return {
      requestedUrl: url,
      status: source.fetchedTruncated ? "truncated" as const : "captured" as const,
      sourcePath: nodes[index]?.path ?? null,
      finalUrl: source.finalUrl,
      errorCode: null,
      contentHash: await sha256Hex(source.text)
    };
  }));
}

function truncateUtf8Source(value: string, maxBytes: number): { text: string } {
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= maxBytes) return { text: value };
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (encoder.encode(value.slice(0, middle)).byteLength <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return { text: value.slice(0, low).trimEnd() };
}

function parseGovernanceArtifact(content: string, proposalId: number): Awaited<ReturnType<NnsGovernanceClient["getPendingProposal"]>> {
  const match = content.match(/```json\n([\s\S]*?)\n```/);
  if (!match) {
    if (content.includes("not present in the authoritative pending-proposal response")) return null;
    throw new NnsProposalValidationError("stored Governance snapshot is invalid");
  }
  const value = JSON.parse(match[1]!) as { proposalId?: string };
  if (value.proposalId !== String(proposalId)) throw new NnsProposalValidationError("stored Governance proposal id is invalid");
  return value as NonNullable<Awaited<ReturnType<NnsGovernanceClient["getPendingProposal"]>>>;
}

async function ensureNnsAutovotePolicy(vfs: VfsClient, databaseId: string): Promise<LoadedNnsPolicy> {
  let node = await vfs.readNode(databaseId, NNS_AUTOVOTE_POLICY_PATH);
  if (!node) {
    const policyNode: NnsArtifactNode = {
      path: NNS_AUTOVOTE_POLICY_PATH,
      kind: "file",
      content: DEFAULT_NNS_AUTOVOTE_POLICY,
      metadataJson: JSON.stringify({ kind: "kinic.nns_autovote_policy", schema_version: 1 })
    };
    await writeCreateOnly(vfs, databaseId, policyNode);
    node = await vfs.readNode(databaseId, NNS_AUTOVOTE_POLICY_PATH);
  }
  try {
    return await loadNnsPolicyNode(node);
  } catch {
    if (!node) throw new NnsProposalValidationError("automatic-voting policy could not be created");
    const policy = parseNnsAutovotePolicy(DEFAULT_NNS_AUTOVOTE_POLICY);
    policy.enabled = false;
    policy.mode = "shadow";
    return { policy, etag: node.etag, hash: await sha256Hex(node.content), content: node.content, valid: false };
  }
}

async function publishDecisionArtifacts(vfs: VfsClient, databaseId: string, record: NnsGeneratedArtifact["decisionRecord"]): Promise<void> {
  await writeCreateOnly(vfs, databaseId, decisionHistoryNode(record));
  await writeCurrentDecision(vfs, databaseId, decisionNode(record));
}

async function writeCurrentDecision(vfs: VfsClient, databaseId: string, node: NnsArtifactNode): Promise<void> {
  const existing = await vfs.readNode(databaseId, node.path);
  if (matchesArtifactNode(existing, node)) return;
  if (existing && existing.kind !== "file") throw new NnsCreateOnlyConflictError(`decision path is not a file: ${node.path}`);
  await ensureParentFolders(vfs, databaseId, node.path);
  await vfs.writeNode({
    databaseId, path: node.path, kind: "file", content: node.content,
    metadataJson: node.metadataJson, expectedEtag: existing?.etag ?? null
  });
}

async function writeReview(vfs: VfsClient, databaseId: string, node: NnsArtifactNode, status: NnsGeneratedArtifact["reviewStatus"]): Promise<void> {
  const existing = await vfs.readNode(databaseId, node.path);
  if (matchesArtifactNode(existing, node)) return;
  if (!existing) return writeCreateOnly(vfs, databaseId, node);
  const existingStatus = parseFrontmatter(existing.content)?.fields.review_status;
  const existingDecisionId = parseFrontmatter(existing.content)?.fields.decision_id;
  const nextDecisionId = parseFrontmatter(node.content)?.fields.decision_id;
  const explanationCompletion = existingStatus === "explanation_pending" && status === "ai_generated"
    && existingDecisionId === nextDecisionId;
  const reevaluation = Boolean(existingDecisionId && nextDecisionId && existingDecisionId !== nextDecisionId);
  if (existing.kind !== "file" || (!explanationCompletion && !reevaluation)) {
    throw new NnsCreateOnlyConflictError(`review path already has different content: ${node.path}`);
  }
  await vfs.writeNode({
    databaseId, path: node.path, kind: node.kind, content: node.content,
    metadataJson: node.metadataJson, expectedEtag: existing.etag
  });
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

async function updateNnsIndex(vfs: VfsClient, databaseId: string): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const existing = await vfs.readNode(databaseId, INDEX_PATH);
    if (existing && existing.kind !== "file") throw new NnsCreateOnlyConflictError(`NNS index path is not a file: ${INDEX_PATH}`);
    const entries = await listCompletedNnsIndexEntries(vfs, databaseId);
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
    await updateNnsIndex(vfs, message.databaseId);
    await markNnsIndexSynced(vfs, message.databaseId, message.proposalId);
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
