// Where: workers/wiki-generator/src/processing.ts
// What: Manual and queued generation workflows.
// Why: HTTP and Queue triggers share generation rules but have different side effects.
import { loadConfig } from "./config.js";
import { enqueueSourceJob, loadJob, markCompleted, markFailed, markProcessing, shouldSkipJob } from "./jobs.js";
import { generateDraft, validateDraftSources } from "./openai.js";
import { ensureTargetCanBeWritten, renderGeneratedMarkdown, slugForGeneratedPage } from "./render.js";
import { sourceIdFromPath, validateCanonicalSourcePath } from "./source-path.js";
import { markIngestRequestCompleted, markIngestRequestFailed, triggerUrlIngestRequest } from "./url-ingest.js";
import { createVfsClient, ensureParentFolders, type VfsClient } from "./vfs.js";
import type { ManualRunInput, QueueMessage, SearchNodeHit, SourceQueueMessage, WikiDraft, WikiNode, WorkerConfig } from "./types.js";
import type { RuntimeEnv } from "./env.js";

export type ManualRunContext = {
  vfs: VfsClient;
};

export type QueueMessageEnvelope =
  | { kind: "valid"; message: QueueMessage }
  | { kind: "legacy_url_ingest_missing_nonce"; canisterId: string; databaseId: string; requestPath: string }
  | { kind: "invalid"; reason: string };

type ExternalCostGateInput = {
  databaseId: string;
  sourcePath?: string;
  sourceEtag?: string;
  requestPath?: string;
  sessionNonce?: string;
};

export async function runManual(env: RuntimeEnv, input: ManualRunInput, context?: ManualRunContext): Promise<Response> {
  const config = loadConfig(env);
  validateCanonicalSourcePath(input.sourcePath, config.sourcePrefix);
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

export async function processQueueMessage(env: RuntimeEnv, message: QueueMessage): Promise<void> {
  if (message.kind === "url_ingest") {
    await triggerUrlIngestRequest(env, message);
    return;
  }
  await processSourceQueueMessage(env, message);
}

export async function processQueueMessageEnvelope(
  env: RuntimeEnv,
  envelope: QueueMessageEnvelope,
  context?: { config?: WorkerConfig; vfs?: VfsClient }
): Promise<void> {
  if (envelope.kind === "valid") {
    await processQueueMessage(env, envelope.message);
    return;
  }
  if (envelope.kind === "legacy_url_ingest_missing_nonce") {
    await failLegacyUrlIngestMessage(env, envelope, context);
    return;
  }
  console.warn("invalid wiki-generator queue message acked", envelope.reason);
}

export async function processSourceQueueMessageForTest(
  env: RuntimeEnv,
  message: SourceQueueMessage,
  context: { config: WorkerConfig; vfs: VfsClient }
): Promise<void> {
  await processSourceQueueMessage(env, message, context);
}

async function processSourceQueueMessage(env: RuntimeEnv, message: SourceQueueMessage, context?: { config: WorkerConfig; vfs: VfsClient }): Promise<void> {
  const config = context?.config ?? loadConfig(env);
  validateCanonicalSourcePath(message.sourcePath, config.sourcePrefix);
  const job = await loadJob(env.DB, message.databaseId, message.sourcePath);
  if (shouldSkipJob(job, message.sourceEtag)) {
    return;
  }
  const vfs = context?.vfs ?? (await createVfsClient(config, env.KINIC_WIKI_WORKER_IDENTITY_PEM));
  await markProcessing(env.DB, message);
  let source: WikiNode;
  try {
    source = await readRequiredSource(vfs, message.databaseId, message.sourcePath);
    if (source.etag !== message.sourceEtag) {
      throw new Error(`source etag mismatch: ${message.sourcePath}`);
    }
  } catch (error) {
    await markQueueFailed(env, vfs, message, errorMessage(error));
    return;
  }
  let deepSeekAttempted = false;
  try {
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
          sessionNonce: message.sessionNonce
        }),
      () => {
        deepSeekAttempted = true;
      }
    );
    await writeGeneratedPage(vfs, message.databaseId, generated.targetPath, generated.content, source.path);
    await markCompleted(env.DB, message, generated.targetPath);
    if (message.requestPath) {
      await markIngestRequestCompleted(vfs, message.databaseId, message.requestPath, source.path, generated.targetPath);
    }
    await bestEffortAppendWorkerLog(vfs, message.databaseId, config.targetRoot, generated.targetPath, source.path);
  } catch (error) {
    const messageText = errorMessage(error);
    if (error instanceof ExternalCostGateError) {
      await markQueueFailed(env, vfs, message, messageText);
      return;
    }
    if (deepSeekAttempted) {
      await bestEffortMarkQueueFailed(env, vfs, message, messageText);
      return;
    }
    await markQueueFailed(env, vfs, message, messageText);
  }
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
      await vfs.checkUrlIngestTriggerSession(input.databaseId, input.requestPath, input.sessionNonce);
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

async function markQueueFailed(env: RuntimeEnv, vfs: VfsClient, message: SourceQueueMessage, messageText: string): Promise<void> {
  await markFailed(env.DB, message, messageText);
  if (message.requestPath) {
    await markIngestRequestFailed(vfs, message.databaseId, message.requestPath, messageText);
  }
}

async function bestEffortMarkQueueFailed(env: RuntimeEnv, vfs: VfsClient, message: SourceQueueMessage, messageText: string): Promise<void> {
  try {
    await markQueueFailed(env, vfs, message, messageText);
  } catch (error) {
    console.warn("failed to record source generation non-retry failure", errorMessage(error));
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
    if (typeof value.requestPath === "string" && !isIngestRequestPath(value.requestPath)) return null;
    if ("sessionNonce" in value && value.sessionNonce !== undefined && !nonEmptyString(value.sessionNonce)) return null;
    return {
      kind: "source",
      databaseId: value.databaseId,
      sourcePath: value.sourcePath,
      sourceEtag: value.sourceEtag,
      requestPath: typeof value.requestPath === "string" ? value.requestPath : undefined,
      sessionNonce: typeof value.sessionNonce === "string" ? value.sessionNonce : undefined
    };
  }
  if (value.kind === "url_ingest") {
    if (!nonEmptyString(value.canisterId)) return null;
    if (!nonEmptyString(value.databaseId)) return null;
    if (!nonEmptyString(value.requestPath)) return null;
    if (!isIngestRequestPath(value.requestPath)) return null;
    if (!nonEmptyString(value.sessionNonce)) return null;
    return {
      kind: "url_ingest",
      canisterId: value.canisterId,
      databaseId: value.databaseId,
      requestPath: value.requestPath,
      sessionNonce: value.sessionNonce
    };
  }
  return null;
}

export function parseQueueMessageEnvelope(value: unknown): QueueMessageEnvelope {
  const message = parseQueueMessage(value);
  if (message) return { kind: "valid", message };
  if (isObject(value) && value.kind === "url_ingest") {
    if (!nonEmptyString(value.canisterId)) return { kind: "invalid", reason: "url_ingest canisterId is missing" };
    if (!nonEmptyString(value.databaseId)) return { kind: "invalid", reason: "url_ingest databaseId is missing" };
    if (!nonEmptyString(value.requestPath)) return { kind: "invalid", reason: "url_ingest requestPath is missing" };
    if (!isIngestRequestPath(value.requestPath)) return { kind: "invalid", reason: "url_ingest requestPath is non-canonical" };
    if (!("sessionNonce" in value)) {
      return {
        kind: "legacy_url_ingest_missing_nonce",
        canisterId: value.canisterId,
        databaseId: value.databaseId,
        requestPath: value.requestPath
      };
    }
    if (!nonEmptyString(value.sessionNonce)) return { kind: "invalid", reason: "url_ingest sessionNonce is missing" };
  }
  return { kind: "invalid", reason: "queue message shape is invalid" };
}

async function failLegacyUrlIngestMessage(
  env: RuntimeEnv,
  message: { canisterId: string; databaseId: string; requestPath: string },
  context?: { config?: WorkerConfig; vfs?: VfsClient }
): Promise<void> {
  const config = context?.config ?? loadConfig(env);
  if (message.canisterId !== config.canisterId) {
    console.warn("legacy url_ingest queue message targets a different canister");
    return;
  }
  if (!isIngestRequestPath(message.requestPath)) {
    console.warn("legacy url_ingest queue message has a non-canonical request path");
    return;
  }
  const vfs = context?.vfs ?? (await createVfsClient(config, env.KINIC_WIKI_WORKER_IDENTITY_PEM));
  await markIngestRequestFailed(vfs, message.databaseId, message.requestPath, "sessionNonce is required for url_ingest queue message");
}

async function generateFromSource(
  env: RuntimeEnv,
  vfs: VfsClient,
  config: WorkerConfig,
  databaseId: string,
  source: WikiNode,
  beforeDeepSeek?: () => Promise<void>,
  afterDeepSeekAttempt?: () => void
): Promise<GeneratedPage> {
  const contextHits = await loadContext(vfs, databaseId, source, config);
  await beforeDeepSeek?.();
  let draft: WikiDraft;
  try {
    draft = await generateDraft(source, contextHits, config, env.DEEPSEEK_API_KEY);
  } finally {
    afterDeepSeekAttempt?.();
  }
  validateDraftSources(draft, source.path);
  const targetPath = `${config.targetRoot}/${slugForGeneratedPage(draft, sourceIdFromPath(source.path, config.sourcePrefix))}.md`;
  return {
    targetPath,
    content: renderGeneratedMarkdown(draft, source, contextHits),
    contextHits
  };
}

async function loadContext(vfs: VfsClient, databaseId: string, source: WikiNode, config: WorkerConfig): Promise<SearchNodeHit[]> {
  const query = contextQuery(source.content, source.path);
  if (!query) return [];
  const hits = await vfs.searchNodes(databaseId, query, config.maxContextHits, config.contextPrefix);
  return rankContextHits(hits);
}

export function rankContextHits(hits: SearchNodeHit[]): SearchNodeHit[] {
  const primary: SearchNodeHit[] = [];
  const sources: SearchNodeHit[] = [];
  for (const hit of hits) {
    if (hit.path === "/Sources" || hit.path.startsWith("/Sources/")) {
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
    throw new Error(`source node not found: ${sourcePath}`);
  }
  if (source.kind !== "source") {
    throw new Error(`node is not a source: ${sourcePath}`);
  }
  return source;
}

async function writeGeneratedPage(vfs: VfsClient, databaseId: string, targetPath: string, content: string, sourcePath: string): Promise<void> {
  const existing = await vfs.readNode(databaseId, targetPath);
  ensureTargetCanBeWritten(existing?.content ?? null, targetPath, sourcePath);
  await ensureParentFolders(vfs, databaseId, targetPath);
  await vfs.writeNode({
    databaseId,
    path: targetPath,
    kind: "file",
    content,
    metadataJson: JSON.stringify({ generated_by: "wiki-generator", source_path: sourcePath }),
    expectedEtag: existing?.etag ?? null
  });
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

function isIngestRequestPath(path: string): boolean {
  if (!path.startsWith("/Sources/ingest-requests/")) return false;
  const name = path.slice("/Sources/ingest-requests/".length);
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.md$/.test(name) && !name.includes("..");
}

type GeneratedPage = {
  targetPath: string;
  content: string;
  contextHits: SearchNodeHit[];
};
