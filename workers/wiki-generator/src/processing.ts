// Where: workers/wiki-generator/src/processing.ts
// What: Manual and queued generation workflows.
// Why: HTTP and Queue triggers share generation rules but have different side effects.
import { isSourceCaptureRequestPath } from "@kinic/source-contracts";
import { loadConfig } from "./config.js";
import { checkpointGenerated, checkpointGeneratedTarget, claimSourceJob, enqueueSourceJob, loadJob, markCompleted, markFailed, releaseForRetry, shouldSkipJob, type GeneratedArtifact } from "./jobs.js";
import {
  databaseLinkPreviewImageKey,
  generateDatabaseLinkPreviewImage,
  LINK_PREVIEW_CACHE_CONTROL,
  LINK_PREVIEW_CONTENT_TYPE
} from "./link-preview.js";
import { DeepSeekRequestError, DeepSeekResponseError, DraftValidationError, generateDraft, validateDraftSources } from "./openai.js";
import { parseOutputLanguage } from "./output-language.js";
import { ensureTargetCanBeWritten, renderGeneratedMarkdown, slugForGeneratedPage } from "./render.js";
import { sourceIdFromPath, validateSourceRootPath } from "./source-path.js";
import { markSourceCaptureRequestCompleted, markSourceCaptureRequestFailed, triggerSourceCaptureRequest } from "./source-capture.js";
import { createAnonymousVfsClient, createVfsClient, ensureParentFolders, type VfsClient } from "./vfs.js";
import type { LinkPreviewQueueMessage, ManualRunInput, OutputLanguage, PublicDatabaseSummary, QueueMessage, SearchNodeHit, SourceQueueMessage, WikiDraft, WikiNode, WorkerConfig } from "./types.js";
import type { RuntimeEnv } from "./env.js";
import type { QueueDisposition, QueueExecution } from "./queue-types.js";

export type { QueueDisposition, QueueExecution } from "./queue-types.js";

export type ManualRunContext = {
  vfs: VfsClient;
};

export type QueueMessageEnvelope =
  | { kind: "valid"; message: QueueMessage }
  | { kind: "invalid"; reason: string };

type QueueProcessContext = {
  config?: WorkerConfig;
  vfs?: VfsClient;
  publicVfs?: Pick<VfsClient, "listPublicDatabases">;
  renderLinkPreviewImage?: (database: PublicDatabaseSummary) => Promise<Response>;
};

type ExternalCostGateInput = {
  databaseId: string;
  sourcePath?: string;
  sourceEtag?: string;
  requestPath?: string;
  sessionNonce?: string;
};

export async function runManual(env: RuntimeEnv, input: ManualRunInput, context?: ManualRunContext): Promise<Response> {
  const config = loadConfig(env);
  validateSourceRootPath(input.sourcePath, config.sourcePrefix);
  const vfs = context?.vfs ?? (await createVfsClient(config, env.KINIC_WIKI_WORKER_IDENTITY_PEM));
  const source = await readRequiredSource(vfs, input.databaseId, input.sourcePath);
  if (source.etag !== input.sourceEtag) {
    return jsonResponse({ error: "source etag mismatch", sourcePath: input.sourcePath }, 409);
  }

  if (!input.dryRun) {
    const enqueued = await enqueueSourceJob(env, {
      kind: "source",
      databaseId: input.databaseId,
      sourcePath: input.sourcePath,
      sourceEtag: input.sourceEtag,
      sessionNonce: input.sessionNonce
    });
    return jsonResponse({ queued: enqueued, sourcePath: input.sourcePath, sourceEtag: input.sourceEtag }, 202);
  }

  const generated = await generateFromSource(env, vfs, config, input.databaseId, source, () =>
    ensureExternalCostAllowed(vfs, {
      databaseId: input.databaseId,
      sourcePath: input.sourcePath,
      sourceEtag: input.sourceEtag,
      sessionNonce: input.sessionNonce
    })
  );
  return jsonResponse(
    {
      dryRun: true,
      wrote: false,
      sourcePath: input.sourcePath,
      targetPath: generated.targetPath,
      contextPaths: generated.contextHits.map((hit) => hit.path),
      content: generated.content
    },
    200
  );
}

export async function processQueueMessage(
  env: RuntimeEnv,
  message: QueueMessage,
  context?: QueueProcessContext,
  execution: QueueExecution = { leaseOwner: "direct", attempts: 1 }
): Promise<QueueDisposition> {
  if (message.kind === "link_preview") {
    await processLinkPreviewQueueMessage(env, message, context);
    return { kind: "ack" };
  }
  if (message.kind === "source_capture") {
    await triggerSourceCaptureRequest(env, message, completeTriggerContext(context));
    return { kind: "ack" };
  }
  return processSourceQueueMessage(env, message, execution, context);
}

export async function processQueueMessageEnvelope(
  env: RuntimeEnv,
  envelope: QueueMessageEnvelope,
  context?: QueueProcessContext,
  execution?: QueueExecution
): Promise<QueueDisposition> {
  if (envelope.kind === "valid") {
    return processQueueMessage(env, envelope.message, context, execution);
  }
  console.warn(JSON.stringify({ event: "wiki_generation_invalid_message", reason: envelope.reason }));
  return { kind: "ack" };
}

export async function processSourceQueueMessageForTest(
  env: RuntimeEnv,
  message: SourceQueueMessage,
  context: { config: WorkerConfig; vfs: VfsClient },
  execution: QueueExecution = { leaseOwner: "test-owner", attempts: 1 }
): Promise<QueueDisposition> {
  return processSourceQueueMessage(env, message, execution, context);
}

async function processSourceQueueMessage(
  env: RuntimeEnv,
  message: SourceQueueMessage,
  execution: QueueExecution,
  context?: QueueProcessContext
): Promise<QueueDisposition> {
  const config = context?.config ?? loadConfig(env);
  validateSourceRootPath(message.sourcePath, config.sourcePrefix);
  const vfs = context?.vfs ?? (await createVfsClient(config, env.KINIC_WIKI_WORKER_IDENTITY_PEM));
  const claim = await claimSourceJob(env.DB, message, execution.leaseOwner);
  if (claim.kind === "superseded") {
    if (!claim.job) {
      return retryDisposition("source_job_missing", "source generation job is missing", execution.attempts);
    }
    await handleSupersededSourceMessage(vfs, message, claim.job);
    return { kind: "ack" };
  }
  if (claim.kind === "busy") {
    return {
      kind: "reschedule",
      delaySeconds: claim.retryAfterSeconds,
      code: "source_job_busy",
      message: "source generation is already leased"
    };
  }
  if (claim.kind === "failed") {
    if (message.requestPath) {
      await markSourceCaptureRequestFailed(vfs, message.databaseId, message.requestPath, claim.error);
    }
    if (execution.attempts >= 5) {
      return { kind: "dead_letter", code: "source_job_failed", message: claim.error };
    }
    return { kind: "ack" };
  }
  if (claim.kind === "completed") {
    if (message.requestPath) {
      await markSourceCaptureRequestCompleted(vfs, message.databaseId, message.requestPath, message.sourcePath, claim.targetPath);
    }
    return { kind: "ack" };
  }

  let artifact: GeneratedArtifact;
  if (claim.kind === "resume") {
    artifact = claim.artifact;
  } else {
    let source: WikiNode;
    try {
      source = await readRequiredSource(vfs, message.databaseId, message.sourcePath);
      if (source.etag !== message.sourceEtag) {
        const latestJob = await loadJob(env.DB, message.databaseId, message.sourcePath);
        if (await handleSupersededSourceMessage(vfs, message, latestJob)) return { kind: "ack" };
        throw new SourceValidationError(`source etag mismatch: ${message.sourcePath}`);
      }
      const generated = await generateFromSource(
        env,
        vfs,
        config,
        message.databaseId,
        source,
        () =>
          ensureExternalCostAllowed(vfs, {
            databaseId: message.databaseId,
            sourcePath: message.sourcePath,
            sourceEtag: message.sourceEtag,
            requestPath: message.requestPath,
            sessionNonce: message.sessionNonce,
          }),
        message.outputLanguage
      );
      const content = generated.content;
      if (new TextEncoder().encode(content).byteLength > 256 * 1024) {
        throw new GeneratedArtifactError("generated Markdown exceeded 256 KiB");
      }
      artifact = {
        targetPath: generated.targetPath,
        expectedTargetEtag: undefined,
        content,
        contextPaths: generated.contextHits.map((hit) => hit.path),
        llmDurationMs: generated.llmDurationMs
      };
      await checkpointGenerated(env.DB, message, execution.leaseOwner, artifact);
    } catch (error) {
      if (isPermanentGenerationError(error)) {
        await markQueueFailed(env, vfs, message, execution.leaseOwner, errorMessage(error));
        return { kind: "ack" };
      }
      if (execution.attempts >= 5) {
        await markQueueFailed(env, vfs, message, execution.leaseOwner, errorMessage(error));
        return { kind: "dead_letter", code: errorCode(error), message: errorMessage(error) };
      }
      await releaseForRetry(env.DB, message, execution.leaseOwner, errorMessage(error));
      const providerError = error instanceof DeepSeekRequestError ? error : null;
      return retryDisposition(
        providerError?.code ?? "source_generation_transient",
        errorMessage(error),
        execution.attempts,
        deepSeekRetryDelaySeconds(providerError, execution.attempts)
      );
    }
  }

  if (artifact.expectedTargetEtag === undefined) {
    try {
      artifact =
        claim.kind === "resume"
          ? await recoverGeneratedTargetSnapshot(env.DB, vfs, message, execution.leaseOwner, artifact)
          : await captureGeneratedTargetSnapshot(env.DB, vfs, message, execution.leaseOwner, artifact);
    } catch (error) {
      return handleSourceCommitError(env, vfs, message, execution, error);
    }
  }

  try {
    await writeGeneratedPage(vfs, message.databaseId, artifact, message.sourcePath);
  } catch (error) {
    return handleSourceCommitError(env, vfs, message, execution, error);
  }

  try {
    await markCompleted(env.DB, message, execution.leaseOwner, artifact.targetPath);
  } catch (error) {
    let job;
    try {
      job = await loadJob(env.DB, message.databaseId, message.sourcePath);
    } catch {
      return {
        kind: "reschedule",
        delaySeconds: 30,
        code: "source_completion_unknown",
        message: errorMessage(error)
      };
    }
    if (job?.source_etag !== message.sourceEtag || job.status !== "completed" || job.target_path !== artifact.targetPath) {
      return handleSourceCommitError(env, vfs, message, execution, error);
    }
  }

  if (message.requestPath) {
    try {
      await markSourceCaptureRequestCompleted(vfs, message.databaseId, message.requestPath, message.sourcePath, artifact.targetPath);
    } catch (error) {
      if (execution.attempts >= 5) {
        return {
          kind: "reschedule",
          delaySeconds: 30,
          code: "source_request_completion_transient",
          message: errorMessage(error)
        };
      }
      return retryDisposition("source_request_completion_transient", errorMessage(error), execution.attempts);
    }
  }
  await bestEffortAppendWorkerLog(vfs, message.databaseId, config.targetRoot, artifact.targetPath, message.sourcePath);
  return { kind: "ack" };
}

async function processLinkPreviewQueueMessage(env: RuntimeEnv, message: LinkPreviewQueueMessage, context?: QueueProcessContext): Promise<void> {
  const config = context?.config ?? loadConfig(env);
  if (message.canisterId !== config.canisterId) {
    console.warn("link_preview canisterId mismatch", message.canisterId);
    return;
  }
  const publicVfs = context?.publicVfs ?? (await createAnonymousVfsClient(config));
  const databases = await publicVfs.listPublicDatabases();
  const database = databases.find((candidate) => candidate.databaseId === message.databaseId);
  if (!database || database.status !== "active") return;
  const render = context?.renderLinkPreviewImage ?? generateDatabaseLinkPreviewImage;
  const response = await render(database);
  await env.LINK_PREVIEW_IMAGES.put(databaseLinkPreviewImageKey(database.databaseId), await response.arrayBuffer(), {
    httpMetadata: {
      contentType: LINK_PREVIEW_CONTENT_TYPE,
      cacheControl: LINK_PREVIEW_CACHE_CONTROL
    },
    customMetadata: {
      databaseId: database.databaseId,
      generatedAt: new Date().toISOString(),
      trigger: "queue-miss"
    }
  });
}

function completeTriggerContext(context: QueueProcessContext | undefined): { config: WorkerConfig; vfs: VfsClient } | undefined {
  if (!context?.config || !context.vfs) return undefined;
  return { config: context.config, vfs: context.vfs };
}

async function handleSupersededSourceMessage(vfs: VfsClient, message: SourceQueueMessage, job: Awaited<ReturnType<typeof loadJob>>): Promise<boolean> {
  if (!job || job.source_etag === message.sourceEtag) return false;
  if (job.status === "queued" || job.status === "processing" || job.status === "generated") return true;
  if (job.status !== "completed") return false;
  if (message.requestPath && job.target_path) {
    await markSourceCaptureRequestCompleted(vfs, message.databaseId, message.requestPath, message.sourcePath, job.target_path);
  }
  return true;
}

class ExternalCostGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExternalCostGateError";
  }
}

async function ensureExternalCostAllowed(vfs: VfsClient, input: ExternalCostGateInput): Promise<void> {
  try {
    if (input.requestPath && !input.sessionNonce) {
      throw new Error("sessionNonce is required for request-bound source generation");
    }
    if (input.requestPath && input.sessionNonce) {
      await vfs.checkSourceCaptureTriggerSession(input.databaseId, input.requestPath, input.sessionNonce);
      return;
    }
    if (input.sessionNonce && input.sourcePath && input.sourceEtag) {
      await vfs.checkSourceRunSession(input.databaseId, input.sourcePath, input.sourceEtag, input.sessionNonce);
      return;
    }
    await vfs.checkDatabaseWriteCycles(input.databaseId);
  } catch (error) {
    throw new ExternalCostGateError(errorMessage(error));
  }
}

async function markQueueFailed(env: RuntimeEnv, vfs: VfsClient, message: SourceQueueMessage, owner: string, messageText: string): Promise<void> {
  await markFailed(env.DB, message, owner, messageText);
  if (message.requestPath) {
    await markSourceCaptureRequestFailed(vfs, message.databaseId, message.requestPath, messageText);
  }
}

export async function bestEffortAppendWorkerLog(vfs: VfsClient, databaseId: string, targetRoot: string, targetPath: string, sourcePath: string): Promise<boolean> {
  try {
    await appendWorkerLog(vfs, databaseId, targetRoot, targetPath, sourcePath);
    return true;
  } catch (error) {
    console.warn("failed to append wiki-generator log", errorMessage(error));
    return false;
  }
}

export function parseManualRunInput(value: unknown): ManualRunInput | string {
  if (!isObject(value)) return "body must include databaseId, sourcePath, and sourceEtag";
  const databaseId = value.databaseId;
  const sourcePath = value.sourcePath;
  const sourceEtag = value.sourceEtag;
  const sessionNonce = value.sessionNonce;
  const dryRun = value.dryRun;
  if (typeof databaseId !== "string" || databaseId.length === 0) return "databaseId is required";
  if (typeof sourcePath !== "string" || sourcePath.length === 0) return "sourcePath is required";
  if (typeof sourceEtag !== "string" || sourceEtag.length === 0) return "sourceEtag is required";
  if (sessionNonce !== undefined && (typeof sessionNonce !== "string" || sessionNonce.length === 0)) {
    return "sessionNonce must be a non-empty string";
  }
  if (typeof sessionNonce === "string" && sessionNonce.length > 128) return "sessionNonce is too long";
  if (dryRun !== undefined && typeof dryRun !== "boolean") return "dryRun must be a boolean";
  return {
    databaseId,
    sourcePath,
    sourceEtag,
    sessionNonce: typeof sessionNonce === "string" ? sessionNonce : undefined,
    dryRun: dryRun ?? false
  };
}

export function parseQueueMessage(value: unknown): QueueMessage | null {
  if (!isObject(value)) return null;
  if (value.kind === "source") {
    if (!nonEmptyString(value.databaseId)) return null;
    if (!nonEmptyString(value.sourcePath)) return null;
    if (!nonEmptyString(value.sourceEtag)) return null;
    if ("requestPath" in value && value.requestPath !== undefined && !nonEmptyString(value.requestPath)) return null;
    if (typeof value.requestPath === "string" && !isSourceCaptureRequestPath(value.requestPath)) return null;
    if ("sessionNonce" in value && value.sessionNonce !== undefined && !nonEmptyString(value.sessionNonce)) return null;
    const outputLanguage = value.outputLanguage == null ? undefined : parseOutputLanguage(value.outputLanguage);
    if (outputLanguage === null) return null;
    return {
      kind: "source",
      databaseId: value.databaseId,
      sourcePath: value.sourcePath,
      sourceEtag: value.sourceEtag,
      requestPath: typeof value.requestPath === "string" ? value.requestPath : undefined,
      sessionNonce: typeof value.sessionNonce === "string" ? value.sessionNonce : undefined,
      outputLanguage
    };
  }
  if (value.kind === "source_capture") {
    if (!nonEmptyString(value.canisterId)) return null;
    if (!nonEmptyString(value.databaseId)) return null;
    if (!nonEmptyString(value.requestPath)) return null;
    if (!isSourceCaptureRequestPath(value.requestPath)) return null;
    if (!nonEmptyString(value.sessionNonce)) return null;
    return {
      kind: "source_capture",
      canisterId: value.canisterId,
      databaseId: value.databaseId,
      requestPath: value.requestPath,
      sessionNonce: value.sessionNonce
    };
  }
  if (value.kind === "link_preview") {
    if (!nonEmptyString(value.canisterId)) return null;
    if (!nonEmptyString(value.databaseId) || value.databaseId.length > 128) return null;
    if (!nonEmptyString(value.requestedAt) || Number.isNaN(Date.parse(value.requestedAt))) return null;
    return {
      kind: "link_preview",
      canisterId: value.canisterId,
      databaseId: value.databaseId,
      requestedAt: value.requestedAt
    };
  }
  return null;
}

export function parseQueueMessageEnvelope(value: unknown): QueueMessageEnvelope {
  const message = parseQueueMessage(value);
  if (message) return { kind: "valid", message };
  if (isObject(value) && value.kind === "source_capture") {
    if (!nonEmptyString(value.canisterId)) return { kind: "invalid", reason: "source_capture canisterId is missing" };
    if (!nonEmptyString(value.databaseId)) return { kind: "invalid", reason: "source_capture databaseId is missing" };
    if (!nonEmptyString(value.requestPath)) return { kind: "invalid", reason: "source_capture requestPath is missing" };
    if (!isSourceCaptureRequestPath(value.requestPath)) return { kind: "invalid", reason: "source_capture requestPath is invalid" };
    if (!nonEmptyString(value.sessionNonce)) return { kind: "invalid", reason: "source_capture sessionNonce is missing" };
  }
  if (isObject(value) && value.kind === "link_preview") {
    if (!nonEmptyString(value.canisterId)) return { kind: "invalid", reason: "link_preview canisterId is missing" };
    if (!nonEmptyString(value.databaseId)) return { kind: "invalid", reason: "link_preview databaseId is missing" };
    if (typeof value.databaseId === "string" && value.databaseId.length > 128) return { kind: "invalid", reason: "link_preview databaseId is too long" };
    if (!nonEmptyString(value.requestedAt)) return { kind: "invalid", reason: "link_preview requestedAt is missing" };
    if (Number.isNaN(Date.parse(value.requestedAt))) return { kind: "invalid", reason: "link_preview requestedAt is invalid" };
  }
  if (isObject(value) && value.kind === "url_ingest") {
    return { kind: "invalid", reason: "legacy url_ingest queue message is unsupported" };
  }
  return { kind: "invalid", reason: "queue message shape is invalid" };
}

async function generateFromSource(
  env: RuntimeEnv,
  vfs: VfsClient,
  config: WorkerConfig,
  databaseId: string,
  source: WikiNode,
  beforeDeepSeek?: () => Promise<void>,
  outputLanguage?: OutputLanguage
): Promise<GeneratedPage> {
  const contextHits = await loadContext(vfs, databaseId, source, config);
  await beforeDeepSeek?.();
  const llmStartedAt = Date.now();
  const draft: WikiDraft = await generateDraft(source, contextHits, config, env.DEEPSEEK_API_KEY, outputLanguage);
  const llmDurationMs = Date.now() - llmStartedAt;
  validateDraftSources(draft, source.path);
  const targetPath = `${config.targetRoot}/${slugForGeneratedPage(draft, sourceIdFromPath(source.path, config.sourcePrefix))}.md`;
  return {
    targetPath,
    content: renderGeneratedMarkdown(draft, source, contextHits),
    contextHits,
    llmDurationMs
  };
}

async function loadContext(vfs: VfsClient, databaseId: string, source: WikiNode, config: WorkerConfig): Promise<SearchNodeHit[]> {
  const query = contextQuery(source.content, source.path);
  if (!query) return [];
  const hits = await vfs.searchNodes(databaseId, query, config.maxContextHits, config.contextPrefix);
  return rankContextHits(hits, config.sourcePrefix);
}

export function rankContextHits(hits: SearchNodeHit[], sourcePrefix = "/Sources"): SearchNodeHit[] {
  const primary: SearchNodeHit[] = [];
  const sources: SearchNodeHit[] = [];
  for (const hit of hits) {
    if (hit.path === sourcePrefix || hit.path.startsWith(`${sourcePrefix}/`)) {
      sources.push(hit);
    } else {
      primary.push(hit);
    }
  }
  return [...primary, ...sources];
}

async function readRequiredSource(vfs: VfsClient, databaseId: string, sourcePath: string): Promise<WikiNode> {
  const source = await vfs.readNode(databaseId, sourcePath);
  if (!source) {
    throw new SourceValidationError(`source node not found: ${sourcePath}`);
  }
  if (source.kind !== "source") {
    throw new SourceValidationError(`node is not a source: ${sourcePath}`);
  }
  return source;
}

async function writeGeneratedPage(
  vfs: VfsClient,
  databaseId: string,
  artifact: GeneratedArtifact,
  sourcePath: string
): Promise<void> {
  const existing = await vfs.readNode(databaseId, artifact.targetPath);
  if (existing?.kind === "file" && existing.content === artifact.content) return;
  if (artifact.expectedTargetEtag === undefined) {
    throw new GeneratedCheckpointConflictError(`checkpoint target changed before snapshot: ${artifact.targetPath}`);
  }
  if ((existing?.etag ?? null) !== artifact.expectedTargetEtag) {
    throw new GeneratedCheckpointConflictError(`checkpoint target changed before commit: ${artifact.targetPath}`);
  }
  ensureTargetCanBeWritten(existing?.content ?? null, artifact.targetPath, sourcePath);
  await ensureParentFolders(vfs, databaseId, artifact.targetPath);
  await vfs.writeNode({
    databaseId,
    path: artifact.targetPath,
    kind: "file",
    content: artifact.content,
    metadataJson: JSON.stringify({ generated_by: "wiki-generator", source_path: sourcePath }),
    expectedEtag: artifact.expectedTargetEtag
  });
}

async function captureGeneratedTargetSnapshot(
  db: D1Database,
  vfs: VfsClient,
  message: SourceQueueMessage,
  owner: string,
  artifact: GeneratedArtifact
): Promise<GeneratedArtifact> {
  const existing = await vfs.readNode(message.databaseId, artifact.targetPath);
  try {
    ensureTargetCanBeWritten(existing?.content ?? null, artifact.targetPath, message.sourcePath);
  } catch (error) {
    throw new GeneratedCheckpointConflictError(errorMessage(error));
  }
  const expectedTargetEtag = existing?.etag ?? null;
  await checkpointGeneratedTarget(db, message, owner, expectedTargetEtag);
  return { ...artifact, expectedTargetEtag };
}

async function recoverGeneratedTargetSnapshot(
  db: D1Database,
  vfs: VfsClient,
  message: SourceQueueMessage,
  owner: string,
  artifact: GeneratedArtifact
): Promise<GeneratedArtifact> {
  const existing = await vfs.readNode(message.databaseId, artifact.targetPath);
  if (existing?.kind === "file" && existing.content === artifact.content) return artifact;
  if (existing) {
    throw new GeneratedCheckpointConflictError(`checkpoint target changed before snapshot: ${artifact.targetPath}`);
  }
  await checkpointGeneratedTarget(db, message, owner, null);
  return { ...artifact, expectedTargetEtag: null };
}

async function handleSourceCommitError(
  env: RuntimeEnv,
  vfs: VfsClient,
  message: SourceQueueMessage,
  execution: QueueExecution,
  error: unknown
): Promise<QueueDisposition> {
  if (error instanceof GeneratedCheckpointConflictError) {
    await releaseForRetry(env.DB, message, execution.leaseOwner, errorMessage(error));
    if (message.requestPath) {
      await markSourceCaptureRequestFailed(vfs, message.databaseId, message.requestPath, errorMessage(error));
    }
    return { kind: "dead_letter", code: "source_checkpoint_conflict", message: errorMessage(error) };
  }
  if (execution.attempts >= 5) {
    await releaseForRetry(env.DB, message, execution.leaseOwner, errorMessage(error));
    if (message.requestPath) {
      await markSourceCaptureRequestFailed(vfs, message.databaseId, message.requestPath, errorMessage(error));
    }
    return { kind: "dead_letter", code: "source_commit_transient", message: errorMessage(error) };
  }
  await releaseForRetry(env.DB, message, execution.leaseOwner, errorMessage(error));
  return retryDisposition("source_commit_transient", errorMessage(error), execution.attempts);
}

async function appendWorkerLog(vfs: VfsClient, databaseId: string, targetRoot: string, targetPath: string, sourcePath: string): Promise<void> {
  const logPath = `${targetRoot}/log.md`;
  const current = await vfs.readNode(databaseId, logPath);
  const header = "# Conversation Worker Log\n\n";
  const entry = `- ${new Date().toISOString()} generated ${targetPath} from ${sourcePath}`;
  await ensureParentFolders(vfs, databaseId, logPath);
  await vfs.writeNode({
    databaseId,
    path: logPath,
    kind: "file",
    content: `${current?.content.trimEnd() ?? header.trimEnd()}\n${entry}\n`,
    metadataJson: "{}",
    expectedEtag: current?.etag ?? null
  });
}

function contextQuery(content: string, sourcePath: string): string {
  const title = metadataValue(content, "conversation_title") ?? headingTitle(content);
  if (title) return title;
  return sourcePath.split("/").at(-2) ?? "";
}

function metadataValue(content: string, key: string): string | null {
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    const prefix = `- ${key}:`;
    if (trimmed.startsWith(prefix)) {
      const value = cleanYamlScalar(trimmed.slice(prefix.length).trim());
      return value || null;
    }
  }
  return null;
}

function cleanYamlScalar(value: string): string {
  if (value.startsWith("\"") && value.endsWith("\"")) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === "string") return parsed;
      throw new Error("Invalid quoted YAML scalar.");
    } catch {
      throw new Error("Invalid quoted YAML scalar.");
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
  return value;
}

function headingTitle(content: string): string | null {
  const line = content.split("\n").find((item) => item.startsWith("# "));
  return line ? line.slice(2).trim() : null;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

type GeneratedPage = {
  targetPath: string;
  content: string;
  contextHits: SearchNodeHit[];
  llmDurationMs: number;
};

class SourceValidationError extends Error {}
class GeneratedArtifactError extends Error {}
class GeneratedCheckpointConflictError extends Error {}

function isPermanentGenerationError(error: unknown): boolean {
  return (
    error instanceof ExternalCostGateError ||
    error instanceof SourceValidationError ||
    error instanceof GeneratedArtifactError ||
    error instanceof DraftValidationError ||
    error instanceof DeepSeekResponseError ||
    (error instanceof DeepSeekRequestError && !error.retryable)
  );
}

function retryDisposition(code: string, message: string, attempts: number, retryAfterSeconds?: number): QueueDisposition {
  return {
    kind: "retry",
    delaySeconds: retryAfterSeconds ?? exponentialBackoff(attempts),
    code,
    message
  };
}

export function deepSeekRetryDelaySeconds(
  error: DeepSeekRequestError | null,
  attempts: number,
  randomUnit = secureRandomUnit()
): number | undefined {
  if (!error) return undefined;
  if (error.retryAfterSeconds !== undefined) return error.retryAfterSeconds;
  if (error.code !== "deepseek_http_503") return undefined;

  const ceiling = Math.min(300, 60 * 2 ** Math.max(0, attempts - 1));
  const floor = Math.ceil(ceiling / 2);
  const boundedRandom = Math.min(1, Math.max(0, randomUnit));
  return Math.min(ceiling, floor + Math.floor(boundedRandom * (ceiling - floor + 1)));
}

function errorCode(error: unknown): string {
  return error instanceof DeepSeekRequestError ? error.code : "source_generation_transient";
}

function exponentialBackoff(attempts: number): number {
  const ceiling = Math.min(300, 15 * 2 ** Math.max(0, attempts - 1));
  return Math.max(1, Math.floor(secureRandomUnit() * ceiling));
}

function secureRandomUnit(): number {
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  return random[0]! / 0xffffffff;
}
