// Where: workers/wiki-generator/src/source-capture.ts
// What: source capture request parsing, source persistence, and request state writes.
// Why: Browser-submitted URLs should become evidence sources before wiki page generation.
import { enqueueSourceJob, loadJob } from "./jobs.js";
import { loadConfig } from "./config.js";
import { parseFrontmatter, renderFrontmatter } from "./frontmatter.js";
import { fetchUrlSource, type FetchedUrlSource } from "./url-fetch.js";
import { validateSourceRootPath } from "./source-path.js";
import type { RuntimeEnv } from "./env.js";
import type { SourceCaptureRequest, SourceCaptureTriggerInput, WikiNode, WorkerConfig, WriteNodeAck } from "./types.js";
import { createVfsClient, ensureParentFolders, type VfsClient } from "./vfs.js";

const SOURCE_CAPTURE_REQUEST_PREFIX = "/Sources/source-capture-requests";
const FETCHING_STALE_MS = 15 * 60 * 1000;
const MAX_SOURCE_STEM_BYTES = 128;
const SOURCE_STEM_ENCODER = new TextEncoder();

export type SourceCaptureTriggerContext = {
  config: WorkerConfig;
  vfs: VfsClient;
};

export class SourceCaptureTriggerError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "SourceCaptureTriggerError";
    this.status = status;
  }
}

export function parseSourceCaptureTriggerInput(value: unknown): SourceCaptureTriggerInput | string {
  if (!isObject(value)) return "body must include canisterId, databaseId, requestPath, and sessionNonce";
  const canisterId = value.canisterId;
  const databaseId = value.databaseId;
  const requestPath = value.requestPath;
  const sessionNonce = value.sessionNonce;
  if (typeof canisterId !== "string" || canisterId.length === 0) return "canisterId is required";
  if (typeof databaseId !== "string" || databaseId.length === 0) return "databaseId is required";
  if (typeof requestPath !== "string" || requestPath.length === 0) return "requestPath is required";
  if (typeof sessionNonce !== "string" || sessionNonce.length === 0) return "sessionNonce is required";
  if (sessionNonce.length > 128) return "sessionNonce is too long";
  if (!isSourceCaptureRequestPath(requestPath)) return `invalid source capture request path: ${requestPath}`;
  return { canisterId, databaseId, requestPath, sessionNonce };
}

export function validateSourceCaptureTriggerInput(env: RuntimeEnv, input: SourceCaptureTriggerInput): WorkerConfig {
  const config = loadConfig(env);
  if (input.canisterId !== config.canisterId) {
    throw new SourceCaptureTriggerError("canisterId does not match worker canister config", 400);
  }
  validateSourceCaptureRequestPath(input.requestPath);
  return config;
}

export async function prepareSourceCaptureTrigger(env: RuntimeEnv, input: SourceCaptureTriggerInput): Promise<SourceCaptureTriggerContext> {
  const config = validateSourceCaptureTriggerInput(env, input);
  const vfs = await createVfsClient(config, env.KINIC_WIKI_WORKER_IDENTITY_PEM);
  return { config, vfs };
}

export async function triggerSourceCaptureRequest(env: RuntimeEnv, input: SourceCaptureTriggerInput, context?: SourceCaptureTriggerContext): Promise<void> {
  const triggerContext = context ?? (await prepareSourceCaptureTrigger(env, input));
  const { config, vfs } = triggerContext;
  const node = await vfs.readNode(input.databaseId, input.requestPath);
  if (!node) throw new Error(`source capture request not found: ${input.requestPath}`);
  const request = parseSourceCaptureRequest(node);
  if (!request) throw new Error(`invalid source capture request: ${input.requestPath}`);
  if (!shouldProcessSourceCaptureRequest(request)) return;
  await processSourceCaptureRequest(env, vfs, config, input.databaseId, request, input.sessionNonce);
}

export function parseSourceCaptureRequest(node: WikiNode): SourceCaptureRequest | null {
  if (node.kind !== "file") return null;
  const document = parseFrontmatter(node.content);
  if (!document) return null;
  if (document.fields.kind !== "kinic.source_capture_request") return null;
  if (document.fields.schema_version !== "1") return null;
  const status = sourceCaptureStatus(document.fields.status);
  const url = document.fields.url;
  if (!status || !url) return null;
  return {
    path: node.path,
    etag: node.etag,
    status,
    url,
    requestedBy: document.fields.requested_by ?? "",
    requestedAt: document.fields.requested_at ?? "",
    claimedAt: document.fields.claimed_at ?? null,
    sourcePath: document.fields.source_path,
    targetPath: document.fields.target_path,
    finishedAt: document.fields.finished_at ?? null,
    error: document.fields.error,
    metadataJson: node.metadataJson
  };
}

export function shouldProcessSourceCaptureRequest(request: SourceCaptureRequest): boolean {
  return request.status === "queued" || request.status === "source_written" || (request.status === "fetching" && isStaleFetching(request, new Date()));
}

export async function processSourceCaptureRequest(
  env: RuntimeEnv,
  vfs: VfsClient,
  config: WorkerConfig,
  databaseId: string,
  request: SourceCaptureRequest,
  sessionNonce: string
): Promise<void> {
  let current: SourceCaptureRequest | null = request;
  try {
    current = await claimSourceCaptureRequest(vfs, databaseId, request);
    if (!current) return;
    if (!sessionNonce) {
      await bestEffortWriteRequestState(vfs, databaseId, current, { status: "failed", targetPath: null, error: "sessionNonce is required" });
      return;
    }
    let sourceAck: WriteNodeAck | null = null;
    if (current.status === "fetching") {
      try {
        await vfs.checkSourceCaptureTriggerSession(databaseId, current.path, sessionNonce);
      } catch (error) {
        await bestEffortWriteLatestRequestState(vfs, databaseId, current.path, { status: "failed", targetPath: null, error: errorMessage(error) });
        return;
      }
      const fetched = await fetchUrlSource(current.url, config.maxFetchedBytes);
      const sourcePath = await sourcePathForUrl(config.sourcePrefix, fetched.finalUrl, fetched.title ?? fetched.finalUrl);
      sourceAck = await writeFetchedSource(vfs, databaseId, sourcePath, fetched, config.maxSourceChars);
      current = await writeRequestState(vfs, databaseId, current, { status: "source_written", sourcePath: sourceAck.path, error: null });
    }
    if (!current.sourcePath) throw new Error("source_path is missing after source write");
    validateSourcePath(config.sourcePrefix, current.sourcePath);
    sourceAck = sourceAck ?? (await requireSourceAck(vfs, databaseId, current.sourcePath));
    let queued: boolean;
    try {
      queued = await enqueueSourceJob(env, {
        kind: "source",
        databaseId,
        sourcePath: sourceAck.path,
        sourceEtag: sourceAck.etag,
        requestPath: current.path,
        sessionNonce
      });
    } catch (error) {
      await writeRequestState(vfs, databaseId, current, {
        status: "failed",
        targetPath: null,
        error: `source job enqueue failed: ${errorMessage(error)}`
      });
      return;
    }
    if (!queued) {
      const job = await loadJob(env.DB, databaseId, sourceAck.path);
      if (job?.status === "completed") {
        await writeRequestState(vfs, databaseId, current, { status: "completed", targetPath: job.target_path, error: null });
        return;
      }
    }
    await writeRequestState(vfs, databaseId, current, { status: "generating", error: null });
  } catch (error) {
    if (isEtagMismatch(error)) {
      await reprocessLatestIfRecoverable(env, vfs, config, databaseId, request.path, sessionNonce);
      return;
    }
    await writeLatestRequestState(vfs, databaseId, (current ?? request).path, { status: "failed", targetPath: null, error: errorMessage(error) });
  }
}

export async function markSourceCaptureRequestCompleted(vfs: VfsClient, databaseId: string, requestPath: string, sourcePath: string, targetPath: string): Promise<void> {
  const node = await vfs.readNode(databaseId, requestPath);
  if (!node) return;
  const request = parseSourceCaptureRequest(node);
  if (!request) return;
  await writeRequestState(vfs, databaseId, request, { status: "completed", sourcePath, targetPath, error: null });
}

export async function markSourceCaptureRequestFailed(vfs: VfsClient, databaseId: string, requestPath: string, error: string): Promise<void> {
  const node = await vfs.readNode(databaseId, requestPath);
  if (!node) return;
  const request = parseSourceCaptureRequest(node);
  if (!request) return;
  await writeRequestState(vfs, databaseId, request, { status: "failed", targetPath: null, error });
}

async function writeFetchedSource(
  vfs: VfsClient,
  databaseId: string,
  basePath: string,
  fetched: FetchedUrlSource,
  maxSourceChars: number
): Promise<WriteNodeAck> {
  const capturedAt = new Date().toISOString();
  const title = fetched.title ?? fetched.finalUrl;
  const sourceText = limitSourceText(fetched.text, maxSourceChars);
  const content = renderFrontmatter(
    {
      kind: "kinic.evidence_web_source",
      schema_version: "1",
      url: fetched.url,
      final_url: fetched.finalUrl,
      title,
      content_type: fetched.contentType,
      captured_at: capturedAt,
      truncated: sourceText.truncated,
      original_chars: sourceText.originalChars,
      saved_chars: sourceText.savedChars,
      fetched_truncated: fetched.fetchedTruncated,
      fetched_bytes: fetched.fetchedBytes,
      max_fetched_bytes: fetched.maxFetchedBytes
    },
    [`# ${title}`, "", `Source URL: ${fetched.finalUrl}`, "", sourceText.text].join("\n")
  );
  const metadataJson = JSON.stringify({
    source_type: "url",
    url: fetched.url,
    final_url: fetched.finalUrl,
    truncated: sourceText.truncated,
    original_chars: sourceText.originalChars,
    saved_chars: sourceText.savedChars,
    fetched_truncated: fetched.fetchedTruncated,
    fetched_bytes: fetched.fetchedBytes,
    max_fetched_bytes: fetched.maxFetchedBytes
  });
  for (let attempt = 1; attempt <= 100; attempt += 1) {
    const path = sourcePathVariant(basePath, attempt);
    const existing = await vfs.readNode(databaseId, path);
    if (existing) continue;
    await ensureParentFolders(vfs, databaseId, path);
    try {
      const ack = await vfs.writeNode({
        databaseId,
        path,
        kind: "source",
        content,
        metadataJson,
        expectedEtag: null
      });
      if (ack.kind !== "source") throw new Error(`write_node returned non-source kind: ${ack.path}`);
      return ack;
    } catch (error) {
      if (isEtagMismatch(error)) continue;
      throw error;
    }
  }
  throw new Error(`source path collision limit exceeded: ${basePath}`);
}

function limitSourceText(text: string, maxChars: number): { text: string; truncated: boolean; originalChars: number; savedChars: number } {
  const originalChars = text.length;
  if (originalChars <= maxChars) {
    return { text, truncated: false, originalChars, savedChars: originalChars };
  }
  const limited = text.slice(0, maxChars).trimEnd();
  return { text: limited, truncated: true, originalChars, savedChars: limited.length };
}

async function writeRequestState(
  vfs: VfsClient,
  databaseId: string,
  request: SourceCaptureRequest,
  updates: {
    status: SourceCaptureRequest["status"];
    claimedAt?: string | null;
    sourcePath?: string | null;
    targetPath?: string | null;
    finishedAt?: string | null;
    error?: string | null;
  }
): Promise<SourceCaptureRequest> {
  const finishedAt =
    updates.finishedAt !== undefined
      ? updates.finishedAt
      : isTerminalStatus(updates.status)
        ? (request.finishedAt ?? new Date().toISOString())
        : request.finishedAt;
  const fields = {
    kind: "kinic.source_capture_request",
    schema_version: "1",
    status: updates.status,
    url: request.url,
    requested_by: request.requestedBy,
    requested_at: request.requestedAt,
    claimed_at: updates.claimedAt !== undefined ? updates.claimedAt : updates.status === "fetching" ? new Date().toISOString() : request.claimedAt,
    source_path: updates.sourcePath === undefined ? request.sourcePath : updates.sourcePath,
    target_path: updates.targetPath === undefined ? request.targetPath : updates.targetPath,
    finished_at: finishedAt,
    error: updates.error === undefined ? request.error : updates.error
  };
  await ensureParentFolders(vfs, databaseId, request.path);
  const ack = await vfs.writeNode({
    databaseId,
    path: request.path,
    kind: "file",
    content: renderFrontmatter(fields, "# Source Capture Request\n"),
    metadataJson: requestMetadataJson(request, fields),
    expectedEtag: request.etag
  });
  if (ack.kind !== "file") throw new Error(`write_node returned non-file kind: ${ack.path}`);
  return {
    path: request.path,
    etag: ack.etag,
    status: updates.status,
    url: request.url,
    requestedBy: request.requestedBy,
    requestedAt: request.requestedAt,
    claimedAt: fields.claimed_at,
    sourcePath: fields.source_path,
    targetPath: fields.target_path,
    finishedAt: fields.finished_at,
    error: fields.error,
    metadataJson: requestMetadataJson(request, fields)
  };
}

async function claimSourceCaptureRequest(vfs: VfsClient, databaseId: string, request: SourceCaptureRequest): Promise<SourceCaptureRequest | null> {
  if (request.status === "source_written") return request;
  if (request.status === "fetching" && isStaleFetching(request, new Date())) {
    return writeRequestState(vfs, databaseId, request, { status: "fetching", error: null, claimedAt: new Date().toISOString() });
  }
  if (request.status !== "queued") return null;
  try {
    return await writeRequestState(vfs, databaseId, request, { status: "fetching", error: null, claimedAt: new Date().toISOString() });
  } catch (error) {
    if (!isEtagMismatch(error)) throw error;
    const latest = await readSourceCaptureRequest(vfs, databaseId, request.path);
    if (!latest || !shouldProcessSourceCaptureRequest(latest)) return null;
    if (latest.status === "queued") {
      return writeRequestState(vfs, databaseId, latest, { status: "fetching", error: null, claimedAt: new Date().toISOString() });
    }
    if (latest.status === "fetching" && isStaleFetching(latest, new Date())) {
      return writeRequestState(vfs, databaseId, latest, { status: "fetching", error: null, claimedAt: new Date().toISOString() });
    }
    return latest;
  }
}

async function reprocessLatestIfRecoverable(
  env: RuntimeEnv,
  vfs: VfsClient,
  config: WorkerConfig,
  databaseId: string,
  requestPath: string,
  sessionNonce: string
): Promise<void> {
  const latest = await readSourceCaptureRequest(vfs, databaseId, requestPath);
  if (!latest || latest.status !== "source_written") return;
  await processSourceCaptureRequest(env, vfs, config, databaseId, latest, sessionNonce);
}

async function writeLatestRequestState(
  vfs: VfsClient,
  databaseId: string,
  requestPath: string,
  updates: { status: SourceCaptureRequest["status"]; claimedAt?: string | null; sourcePath?: string | null; targetPath?: string | null; finishedAt?: string | null; error?: string | null }
): Promise<SourceCaptureRequest | null> {
  const latest = await readSourceCaptureRequest(vfs, databaseId, requestPath);
  if (!latest || latest.status === "generating" || isTerminalStatus(latest.status)) return null;
  try {
    return await writeRequestState(vfs, databaseId, latest, updates);
  } catch (error) {
    if (isEtagMismatch(error)) return null;
    throw error;
  }
}

async function bestEffortWriteLatestRequestState(
  vfs: VfsClient,
  databaseId: string,
  requestPath: string,
  updates: { status: SourceCaptureRequest["status"]; claimedAt?: string | null; sourcePath?: string | null; targetPath?: string | null; finishedAt?: string | null; error?: string | null }
): Promise<void> {
  try {
    await writeLatestRequestState(vfs, databaseId, requestPath, updates);
  } catch (error) {
    console.warn("failed to record source capture non-retry failure", errorMessage(error));
  }
}

async function bestEffortWriteRequestState(
  vfs: VfsClient,
  databaseId: string,
  request: SourceCaptureRequest,
  updates: { status: SourceCaptureRequest["status"]; claimedAt?: string | null; sourcePath?: string | null; targetPath?: string | null; finishedAt?: string | null; error?: string | null }
): Promise<void> {
  try {
    await writeRequestState(vfs, databaseId, request, updates);
  } catch (error) {
    if (isEtagMismatch(error)) {
      await bestEffortWriteLatestRequestState(vfs, databaseId, request.path, updates);
      return;
    }
    console.warn("failed to record source capture non-retry failure", errorMessage(error));
  }
}

async function readSourceCaptureRequest(vfs: VfsClient, databaseId: string, requestPath: string): Promise<SourceCaptureRequest | null> {
  const node = await vfs.readNode(databaseId, requestPath);
  return node ? parseSourceCaptureRequest(node) : null;
}

async function requireSourceAck(vfs: VfsClient, databaseId: string, path: string): Promise<WriteNodeAck> {
  const source = await vfs.readNode(databaseId, path);
  if (!source) throw new Error(`source node not found: ${path}`);
  if (source.kind !== "source") throw new Error(`node is not a source: ${path}`);
  return { path: source.path, kind: source.kind, etag: source.etag };
}

async function sourcePathForUrl(sourcePrefix: string, finalUrl: string, title: string): Promise<string> {
  const hash = (await sha256Hex(finalUrl)).slice(0, 8);
  return `${sourcePrefix}/web/${sourceStemFromTitleHash(title, hash, hostnameForUrl(finalUrl))}.md`;
}

function sourcePathVariant(basePath: string, attempt: number): string {
  if (attempt === 1) return basePath;
  if (basePath.endsWith(".md")) return `${basePath.slice(0, -".md".length)}-${attempt}.md`;
  return `${basePath}-${attempt}`;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sourceStemFromTitleHash(title: string, hash: string, fallback: string): string {
  const slug = slugTitle(title, fallback);
  return truncateStem(`${slug}-${hash}`, hash);
}

function slugTitle(value: string, fallback: string): string {
  const source = String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .trim();
  let output = "";
  let lastWasDash = false;
  for (const char of source) {
    if (isSourceStemChar(char)) {
      output += char;
      lastWasDash = false;
    } else if (!lastWasDash) {
      output += "-";
      lastWasDash = true;
    }
  }
  const normalized = output
    .replace(/\.{2,}/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "");
  if (normalized && isUnicodeAlphanumeric([...normalized][0] ?? "")) return normalized;
  return fallback === value ? "source" : slugTitle(fallback, "source");
}

function truncateStem(stem: string, hash: string): string {
  if (SOURCE_STEM_ENCODER.encode(stem).length <= MAX_SOURCE_STEM_BYTES) return stem;
  const suffix = `-${hash}`;
  const maxPrefixBytes = MAX_SOURCE_STEM_BYTES - SOURCE_STEM_ENCODER.encode(suffix).length;
  let prefix = "";
  for (const char of stem.slice(0, -suffix.length)) {
    if (SOURCE_STEM_ENCODER.encode(`${prefix}${char}`).length > maxPrefixBytes) break;
    prefix += char;
  }
  const trimmed = prefix.replace(/[._-]+$/g, "") || "source";
  return `${trimmed}${suffix}`;
}

function hostnameForUrl(finalUrl: string): string {
  try {
    return new URL(finalUrl).hostname || "web-source";
  } catch {
    return "web-source";
  }
}

function isSourceStemChar(value: string): boolean {
  return isUnicodeAlphanumeric(value) || value === "." || value === "_" || value === "-";
}

function isUnicodeAlphanumeric(value: string): boolean {
  return /^[\p{L}\p{N}]$/u.test(value);
}

function sourceCaptureStatus(value: string | null | undefined): SourceCaptureRequest["status"] | null {
  if (value === "queued" || value === "fetching" || value === "source_written" || value === "generating" || value === "completed" || value === "failed") {
    return value;
  }
  return null;
}

function isTerminalStatus(status: SourceCaptureRequest["status"]): boolean {
  return status === "completed" || status === "failed";
}

function isStaleFetching(request: SourceCaptureRequest, now: Date): boolean {
  if (request.status !== "fetching" || !request.claimedAt) return false;
  const claimedAtMs = Date.parse(request.claimedAt);
  return Number.isFinite(claimedAtMs) && now.getTime() - claimedAtMs > FETCHING_STALE_MS;
}

function requestMetadataJson(request: SourceCaptureRequest, fields: Record<string, string | null>): string {
  const metadata = parseJsonRecord(request.metadataJson);
  metadata.request_type = "source_capture";
  metadata.url = request.url;
  metadata.status = fields.status;
  metadata.source_path = fields.source_path;
  metadata.target_path = fields.target_path;
  return JSON.stringify(metadata);
}

function parseJsonRecord(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    if (isObject(parsed) && !Array.isArray(parsed)) {
      return { ...parsed };
    }
  } catch {
    return {};
  }
  return {};
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 4000) : String(error).slice(0, 4000);
}

function isEtagMismatch(error: unknown): boolean {
  return error instanceof Error && error.message.includes("expected_etag does not match current etag");
}

function validateSourceCaptureRequestPath(path: string): void {
  if (!isSourceCaptureRequestPath(path)) {
    throw new SourceCaptureTriggerError(`invalid source capture request path: ${path}`, 400);
  }
}

function isSourceCaptureRequestPath(path: string): boolean {
  if (!path.startsWith(`${SOURCE_CAPTURE_REQUEST_PREFIX}/`)) return false;
  const name = path.slice(SOURCE_CAPTURE_REQUEST_PREFIX.length + 1);
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.md$/.test(name) && !name.includes("..");
}

function validateSourcePath(sourcePrefix: string, path: string): void {
  validateSourceRootPath(path, sourcePrefix);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
