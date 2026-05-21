// Where: workers/wiki-generator/src/processing.ts
// What: Manual and queued generation workflows.
// Why: HTTP and Queue triggers share generation rules but have different side effects.
import { loadConfig } from "./config.js";
import { enqueueSourceJob, loadJob, markCompleted, markFailed, markProcessing, shouldSkipJob } from "./jobs.js";
import { generateDraft, validateDraftSources } from "./openai.js";
import { ensureTargetCanBeWritten, renderDraftMarkdown, slugForDraft } from "./render.js";
import { validateCanonicalSourcePath } from "./source-path.js";
import { markIngestRequestCompleted, markIngestRequestFailed, triggerUrlIngestRequest } from "./url-ingest.js";
import { createVfsClient, ensureParentFolders, type VfsClient } from "./vfs.js";
import type { ManualRunInput, QueueMessage, SearchNodeHit, SourceQueueMessage, WikiNode, WorkerConfig } from "./types.js";
import type { RuntimeEnv } from "./env.js";

export async function runManual(env: RuntimeEnv, input: ManualRunInput): Promise<Response> {
  const config = loadConfig(env);
  validateCanonicalSourcePath(input.sourcePath, config.sourcePrefix);
  const vfs = await createVfsClient(config, env.KINIC_WIKI_WORKER_IDENTITY_PEM);
  const source = await readRequiredSource(vfs, input.databaseId, input.sourcePath);

  if (!input.dryRun) {
    const enqueued = await enqueueSourceJob(env, {
      kind: "source",
      databaseId: input.databaseId,
      sourcePath: input.sourcePath,
      sourceEtag: source.etag
    });
    return jsonResponse({ queued: enqueued, sourcePath: input.sourcePath, sourceEtag: source.etag }, 202);
  }

  const generated = await generateFromSource(env, vfs, config, input.databaseId, source);
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

async function processSourceQueueMessage(env: RuntimeEnv, message: SourceQueueMessage): Promise<void> {
  const config = loadConfig(env);
  validateCanonicalSourcePath(message.sourcePath, config.sourcePrefix);
  const job = await loadJob(env.DB, message.databaseId, message.sourcePath);
  if (shouldSkipJob(job, message.sourceEtag)) {
    return;
  }
  const vfs = await createVfsClient(config, env.KINIC_WIKI_WORKER_IDENTITY_PEM);
  const source = await readRequiredSource(vfs, message.databaseId, message.sourcePath);
  if (source.etag !== message.sourceEtag) {
    return;
  }
  await markProcessing(env.DB, message);
  try {
    const generated = await generateFromSource(env, vfs, config, message.databaseId, source);
    await writeGeneratedDraft(vfs, message.databaseId, generated.targetPath, generated.content, source.path);
    await markCompleted(env.DB, message, generated.targetPath);
    if (message.requestPath) {
      await markIngestRequestCompleted(vfs, message.databaseId, message.requestPath, source.path, generated.targetPath);
    }
    await bestEffortAppendWorkerLog(vfs, message.databaseId, config.targetRoot, generated.targetPath, source.path);
  } catch (error) {
    const messageText = errorMessage(error);
    await markFailed(env.DB, message, messageText);
    if (message.requestPath) {
      await markIngestRequestFailed(vfs, message.databaseId, message.requestPath, messageText);
    }
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
  if (!isObject(value)) return "body must include databaseId and sourcePath";
  const databaseId = value.databaseId;
  const sourcePath = value.sourcePath;
  const dryRun = value.dryRun;
  if (typeof databaseId !== "string" || databaseId.length === 0) return "databaseId is required";
  if (typeof sourcePath !== "string" || sourcePath.length === 0) return "sourcePath is required";
  if (dryRun !== undefined && typeof dryRun !== "boolean") return "dryRun must be a boolean";
  return { databaseId, sourcePath, dryRun: dryRun ?? false };
}

export function parseQueueMessage(value: unknown): QueueMessage | null {
  if (!isObject(value)) return null;
  if (value.kind === "source") {
    if (typeof value.databaseId !== "string") return null;
    if (typeof value.sourcePath !== "string") return null;
    if (typeof value.sourceEtag !== "string") return null;
    if ("requestPath" in value && value.requestPath !== undefined && typeof value.requestPath !== "string") return null;
    return {
      kind: "source",
      databaseId: value.databaseId,
      sourcePath: value.sourcePath,
      sourceEtag: value.sourceEtag,
      requestPath: typeof value.requestPath === "string" ? value.requestPath : undefined
    };
  }
  if (value.kind === "url_ingest") {
    if (typeof value.canisterId !== "string") return null;
    if (typeof value.databaseId !== "string") return null;
    if (typeof value.requestPath !== "string") return null;
    return {
      kind: "url_ingest",
      canisterId: value.canisterId,
      databaseId: value.databaseId,
      requestPath: value.requestPath
    };
  }
  return null;
}

async function generateFromSource(env: RuntimeEnv, vfs: VfsClient, config: WorkerConfig, databaseId: string, source: WikiNode): Promise<GeneratedDraft> {
  const contextHits = await loadContext(vfs, databaseId, source, config);
  const draft = await generateDraft(source, contextHits, config, env.DEEPSEEK_API_KEY);
  validateDraftSources(draft, source.path);
  const targetPath = `${config.targetRoot}/${slugForDraft(draft)}.md`;
  return {
    targetPath,
    content: renderDraftMarkdown(draft, source, contextHits),
    contextHits
  };
}

async function loadContext(vfs: VfsClient, databaseId: string, source: WikiNode, config: WorkerConfig): Promise<SearchNodeHit[]> {
  const query = contextQuery(source.content, source.path);
  if (!query) return [];
  return vfs.searchNodes(databaseId, query, config.maxContextHits, config.contextPrefix);
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

async function writeGeneratedDraft(vfs: VfsClient, databaseId: string, targetPath: string, content: string, sourcePath: string): Promise<void> {
  const existing = await vfs.readNode(databaseId, targetPath);
  ensureTargetCanBeWritten(existing?.content ?? null, targetPath, sourcePath);
  await ensureParentFolders(vfs, databaseId, targetPath);
  await vfs.writeNode({
    databaseId,
    path: targetPath,
    kind: "file",
    content,
    metadataJson: JSON.stringify({ generated_by: "wiki-generator", source_path: sourcePath, state: "Draft" }),
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
      const value = trimmed.slice(prefix.length).trim().replace(/^"|"$/g, "");
      return value || null;
    }
  }
  return null;
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

type GeneratedDraft = {
  targetPath: string;
  content: string;
  contextHits: SearchNodeHit[];
};
