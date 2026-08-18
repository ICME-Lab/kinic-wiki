// Where: extensions/wiki-clipper/src/offscreen.js
// What: DOM-backed authenticated source write worker for the MV3 extension.
// Why: Internet Identity AuthClient requires a window-like context, not the service worker.
import { authSnapshot as defaultAuthSnapshot, resetAuthClient as defaultResetAuthClient } from "./auth-client.js";
import { normalizedHttpUrl } from "./source-capture-request.js";
import {
  createVfsActor as defaultCreateVfsActor,
  getCyclesBillingConfigOrNull,
  normalizeWritableDatabases,
  requireDatabaseWriteCyclesAvailable,
  searchNodesWithActor
} from "./vfs-actor.js";
import { buildRecallFallbackQuery, buildRecallSearchQuery, isAllowedRecallPath, normalizeRecallQuery, rankRecallHits, RECALL_CONTEXT_MAX_CHARS, titleFromPath } from "./recall.js";

const SOURCE_RUN_TRIGGER_URL = "https://wiki.kinic.xyz/api/source/run";

let authSnapshotFactory = defaultAuthSnapshot;
let resetAuthClientFactory = defaultResetAuthClient;
let vfsActorFactory = defaultCreateVfsActor;
let fetchFactory = (...args) => fetch(...args);

if (globalThis.chrome?.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.target !== "offscreen") return false;
    const task = handleOffscreenMessage(message);
    if (!task) return false;
    task.then(
      (result) => sendResponse({ ok: true, result }),
      (error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) })
    );
    return true;
  });
}

export function handleOffscreenMessage(message) {
  return message?.type === "save-evidence-source"
    ? saveEvidenceSource(message.evidenceSource, message.config)
    : message?.type === "run-source-capture-task"
      ? acceptSourceCaptureTask(message)
      : message?.type === "trigger-source-generation"
        ? triggerSourceGeneration(message.config, message.sourcePath, message.sourceEtag, message.sessionNonce)
        : message?.type === "web-source-exists"
          ? webSourceExists(message.sourcePath, message.expectedUrl, message.config)
          : message?.type === "auth-status"
            ? authStatus()
            : message?.type === "list-writable-databases"
              ? listWritableDatabases(message.config)
              : message?.type === "recall-search"
              ? searchRecall(message.query, message.conversationUrl, message.config)
              : message?.type === "recall-fetch"
                  ? fetchRecall(message.path, message.config, { charOffset: message.charOffset })
                  : message?.type === "reset-auth-client"
                    ? resetOffscreenAuthState()
                    : null;
}

export async function acceptSourceCaptureTask(message) {
  const task = validateSourceCaptureTask(message);
  void runSourceCaptureTask(task);
  return { accepted: true, taskId: task.taskId };
}

async function runSourceCaptureTask(task) {
  try {
    const saveResult = await saveEvidenceSource(task.evidenceSource, task.config);
    const triggerResult = task.queueGeneration
      ? await triggerSourceGeneration(task.config, saveResult.path, saveResult.etag, saveResult.sourceRunSessionNonce)
      : null;
    const generationQueued = task.queueGeneration ? Boolean(triggerResult?.triggered !== false) : false;
    await notifySourceCaptureTaskResult({
      type: "source-capture-task-result",
      taskId: task.taskId,
      inFlightKey: task.inFlightKey,
      tabId: task.tabId,
      ok: true,
      result: {
        url: task.url,
        title: task.title,
        sourcePath: saveResult.path,
        sourceEtag: saveResult.etag,
        sourceExists: task.sourceAlreadyExists,
        sourceCreated: saveResult.created,
        generationQueued,
        generationSkipped: !task.queueGeneration,
        generationError: generationQueued ? null : triggerResult?.triggerError || "generation queue failed"
      },
      databaseId: task.config.databaseId
    });
  } catch (error) {
    await notifySourceCaptureTaskResult({
      type: "source-capture-task-result",
      taskId: task.taskId,
      inFlightKey: task.inFlightKey,
      tabId: task.tabId,
      ok: false,
      url: task.url,
      databaseId: task.config.databaseId,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

async function notifySourceCaptureTaskResult(message) {
  if (!globalThis.chrome?.runtime?.sendMessage) return;
  await chrome.runtime.sendMessage(message);
}

export async function saveEvidenceSource(evidenceSource, config) {
  if (!evidenceSource?.path) throw new Error("evidence source path is required");
  if (typeof evidenceSource.content !== "string") throw new Error("evidence source content is required");
  if (typeof evidenceSource.metadataJson !== "string") throw new Error("evidence source metadata is required");
  if (!config?.canisterId) throw new Error("canister id is required");
  if (!config?.databaseId) throw new Error("database id is required");
  const snapshot = await authenticatedSnapshot();
  const actor = await vfsActorFactory({ ...config, identity: snapshot.identity });
  await requireDatabaseWriteCyclesAvailable(actor, config.databaseId);
  const existing = await actor.read_node(config.databaseId, evidenceSource.path);
  if ("Err" in existing) throw new Error(existing.Err);
  const existingNode = existing.Ok[0] || null;
  const expectedWebSourceUrl = webSourceUrlFromMetadata(evidenceSource.metadataJson);
  if (existingNode && expectedWebSourceUrl) {
    requireMatchingWebSourceUrl(existingNode, expectedWebSourceUrl);
  }
  const expected = existingNode?.etag ? [existingNode.etag] : [];
  await ensureParentFolders(actor, config.databaseId, evidenceSource.path);
  const sessionNonce = crypto.randomUUID();
  const result = await actor.write_source_for_generation({
    database_id: config.databaseId,
    path: evidenceSource.path,
    content: evidenceSource.content,
    metadata_json: evidenceSource.metadataJson,
    expected_etag: expected,
    session_nonce: sessionNonce
  });
  if ("Err" in result) throw new Error(result.Err.message);
  return {
    path: evidenceSource.path,
    sourceId: evidenceSource.sourceId || "",
    created: result.Ok.write.created,
    principal: snapshot.principal,
    etag: result.Ok.write.node.etag,
    sourceRunSessionNonce: result.Ok.session_nonce
  };
}

export async function triggerSourceGeneration(config, sourcePath, sourceEtag, sessionNonce) {
  if (!config?.canisterId) throw new Error("canister id is required");
  if (!config?.databaseId) throw new Error("database id is required");
  if (typeof sourcePath !== "string" || !sourcePath) throw new Error("source path is required");
  if (typeof sourceEtag !== "string" || !sourceEtag) throw new Error("source etag is required");
  if (typeof sessionNonce !== "string" || !sessionNonce) throw new Error("source run session nonce is required");
  const trigger = await triggerSourceRun(config.canisterId, config.databaseId, sourcePath, sourceEtag, sessionNonce);
  return {
    sourcePath,
    sourceEtag,
    triggered: trigger.ok,
    triggerError: trigger.error
  };
}

function validateSourceCaptureTask(message) {
  if (typeof message?.taskId !== "string" || !message.taskId) throw new Error("source capture task id is required");
  if (typeof message.inFlightKey !== "string" || !message.inFlightKey) throw new Error("source capture in-flight key is required");
  if (typeof message.url !== "string" || !message.url) throw new Error("source capture url is required");
  if (!message.config?.canisterId) throw new Error("canister id is required");
  if (!message.config?.databaseId) throw new Error("database id is required");
  if (!message.evidenceSource?.path) throw new Error("evidence source path is required");
  return {
    taskId: message.taskId,
    inFlightKey: message.inFlightKey,
    tabId: Number.isInteger(message.tabId) ? message.tabId : undefined,
    url: message.url,
    title: typeof message.title === "string" ? message.title : "",
    evidenceSource: message.evidenceSource,
    config: message.config,
    queueGeneration: message.queueGeneration !== false,
    sourceAlreadyExists: message.sourceAlreadyExists === true
  };
}

export async function webSourceExists(sourcePath, expectedUrl, config) {
  if (typeof sourcePath !== "string" || !sourcePath) throw new Error("source path is required");
  const normalizedExpectedUrl = normalizedHttpUrl(expectedUrl);
  if (!config?.canisterId) throw new Error("canister id is required");
  if (!config?.databaseId) throw new Error("database id is required");
  const snapshot = await authenticatedSnapshot();
  const actor = await vfsActorFactory({ ...config, identity: snapshot.identity });
  const result = await actor.read_node(config.databaseId, sourcePath);
  if ("Err" in result) throw new Error(result.Err);
  const node = result.Ok[0] || null;
  if (node) {
    requireMatchingWebSourceUrl(node, normalizedExpectedUrl);
  }
  return {
    exists: Boolean(node),
    path: sourcePath,
    etag: node?.etag || null
  };
}

function requireMatchingWebSourceUrl(node, expectedUrl) {
  let metadata;
  try {
    metadata = JSON.parse(node.metadata_json);
  } catch {
    throw new Error("WEB_SOURCE_PATH_CONFLICT");
  }
  const storedUrl = metadata?.final_url || metadata?.url;
  if (typeof storedUrl !== "string") {
    throw new Error("WEB_SOURCE_PATH_CONFLICT");
  }
  let normalizedStoredUrl;
  try {
    normalizedStoredUrl = normalizedHttpUrl(storedUrl);
  } catch {
    throw new Error("WEB_SOURCE_PATH_CONFLICT");
  }
  if (normalizedStoredUrl !== expectedUrl) {
    throw new Error("WEB_SOURCE_PATH_CONFLICT");
  }
}

function webSourceUrlFromMetadata(metadataJson) {
  let metadata;
  try {
    metadata = JSON.parse(metadataJson);
  } catch {
    return null;
  }
  if (metadata?.source_type !== "url") return null;
  return normalizedHttpUrl(metadata.final_url || metadata.url);
}

async function ensureParentFolders(actor, databaseId, path) {
  const segments = path.split("/").filter(Boolean);
  let current = "";
  for (const segment of segments.slice(0, -1)) {
    current = `${current}/${segment}`;
    const result = await actor.mkdir_node({ database_id: databaseId, path: current });
    if ("Err" in result) throw new Error(result.Err.message);
  }
}

export async function authStatus() {
  const snapshot = await authSnapshotFactory();
  return {
    isAuthenticated: Boolean(snapshot.isAuthenticated),
    principal: snapshot.principal || null
  };
}

export async function listWritableDatabases(config) {
  if (!config?.canisterId) throw new Error("canister id is required");
  const snapshot = await authenticatedSnapshot();
  const actor = await vfsActorFactory({ ...config, identity: snapshot.identity });
  const [result, cyclesConfig] = await Promise.all([
    actor.list_databases(),
    getCyclesBillingConfigOrNull(actor)
  ]);
  if ("Err" in result) throw new Error(result.Err);
  return normalizeWritableDatabases(result.Ok, cyclesConfig);
}

export async function searchRecall(query, conversationUrl, config) {
  if (!config?.canisterId) throw new Error("canister id is required");
  if (!config?.databaseId) throw new Error("database id is required");
  const rawQuery = normalizeRecallQuery(query);
  if (!rawQuery) return [];
  const literalQuery = buildRecallSearchQuery(rawQuery) ?? rawQuery;

  if (config.recallUrl && config.recallToken) {
    const generatorResults = await searchRecallViaGenerator(rawQuery, literalQuery, conversationUrl, config);
    if (generatorResults) return generatorResults;
  }

  const snapshot = await authenticatedSnapshot();
  const actor = await vfsActorFactory({ ...config, identity: snapshot.identity });
  const literalHits = await searchRecallHits(actor, config.databaseId, literalQuery);
  const literalResults = rankRecallHits(literalHits, { currentConversationUrl: conversationUrl });
  if (literalResults.length >= 3) return normalizeRecallResults(literalResults, config.databaseId);

  const fallbackQuery = buildRecallFallbackQuery(rawQuery);
  if (!fallbackQuery) return normalizeRecallResults(literalResults, config.databaseId);

  const fallbackHits = await searchRecallHits(actor, config.databaseId, fallbackQuery);
  const results = rankRecallHits([...literalHits, ...fallbackHits], { currentConversationUrl: conversationUrl });
  return normalizeRecallResults(results, config.databaseId);
}

async function searchRecallViaGenerator(rawQuery, distilledQuery, conversationUrl, config) {
  try {
    const baseUrl = config.recallUrl.endsWith("/") ? config.recallUrl : `${config.recallUrl}/`;
    const response = await fetchFactory(`${baseUrl}recall-search`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.recallToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        draft: rawQuery,
        distilledQuery,
        canisterId: config.canisterId,
        databaseId: config.databaseId,
        conversationUrl
      })
    });
    if (!response.ok) return null;
    const body = await response.json();
    if (!body || !Array.isArray(body.results)) return null;
    return normalizeGeneratorRecallResults(body.results, config.databaseId);
  } catch {
    return null;
  }
}

function normalizeGeneratorRecallResults(results, databaseId) {
  return results
    .filter((result) => result && typeof result.path === "string")
    .map((result) => ({
      path: result.path,
      kind: result.kind,
      title: titleFromPath(result.path),
      snippet: String(result.previewExcerpt ?? result.snippet ?? "").trim(),
      sourceUrl: sourceUrlForPath(databaseId, result.path)
    }));
}

async function searchRecallHits(actor, databaseId, query) {
  const searches = await Promise.allSettled([
    searchNodesWithActor(actor, databaseId, query, "/Knowledge", 5),
    searchNodesWithActor(actor, databaseId, query, "/Sources", 5)
  ]);
  return searches.flatMap((result) => result.status === "fulfilled" ? result.value : []);
}

function normalizeRecallResults(results, databaseId) {
  return results.map((result) => ({
    ...result,
    title: result.title || titleFromPath(result.path),
    sourceUrl: sourceUrlForPath(databaseId, result.path)
  }));
}

export async function fetchRecall(path, config, options = {}) {
  if (!config?.canisterId) throw new Error("canister id is required");
  if (!config?.databaseId) throw new Error("database id is required");
  if (!isAllowedRecallPath(path)) throw new Error("recall path is invalid");
  const snapshot = await authenticatedSnapshot();
  const actor = await vfsActorFactory({ ...config, identity: snapshot.identity });
  const result = await actor.read_node(config.databaseId, path);
  if ("Err" in result) throw new Error(result.Err);
  const node = result.Ok[0];
  if (!node) throw new Error("recall node not found");
  const content = String(node.content || "");
  const charOffset = Number.isInteger(options?.charOffset) ? Number(options.charOffset) : null;
  return {
    path,
    content: recallContextWindow(content, charOffset),
    metadataJson: String(node.metadata_json || ""),
    sourceUrl: sourceUrlForPath(config.databaseId, path)
  };
}

function recallContextWindow(content, charOffset) {
  if (content.length <= RECALL_CONTEXT_MAX_CHARS) return content;
  const start = recallContextStartIndex(content, charOffset);
  return content.slice(start, start + RECALL_CONTEXT_MAX_CHARS);
}

function recallContextStartIndex(content, charOffset) {
  if (!Number.isInteger(charOffset) || charOffset <= 0) return 0;
  const half = Math.floor(RECALL_CONTEXT_MAX_CHARS / 2);
  const center = recallCharOffsetToIndex(content, charOffset);
  return Math.max(0, Math.min(center - half, content.length - RECALL_CONTEXT_MAX_CHARS));
}

function recallCharOffsetToIndex(content, charOffset) {
  let index = 0;
  let count = 0;
  for (const ch of content) {
    if (count >= charOffset) break;
    count += 1;
    index += ch.length;
  }
  return index;
}

export function setOffscreenDepsForTest(deps = {}) {
  authSnapshotFactory = deps.authSnapshot || defaultAuthSnapshot;
  resetAuthClientFactory = deps.resetAuthClient || defaultResetAuthClient;
  vfsActorFactory = deps.createVfsActor || defaultCreateVfsActor;
  fetchFactory = deps.fetch || ((...args) => fetch(...args));
}

export async function resetOffscreenAuthState() {
  await resetAuthClientFactory();
  return { reset: true };
}

async function authenticatedSnapshot() {
  let snapshot = await authSnapshotFactory();
  if (!snapshot.isAuthenticated || !snapshot.identity || !snapshot.principal) {
    await resetAuthClientFactory();
    snapshot = await authSnapshotFactory();
  }
  if (!snapshot.isAuthenticated || !snapshot.identity || !snapshot.principal) {
    throw new Error("UNAUTHENTICATED");
  }
  return snapshot;
}

function sourceUrlForPath(databaseId, path) {
  const suffix = String(path || "")
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
  return `https://wiki.kinic.xyz/db/${encodeURIComponent(databaseId)}/${suffix}`;
}

async function triggerSourceRun(canisterId, databaseId, sourcePath, sourceEtag, sessionNonce) {
  try {
    const response = await fetchFactory(SOURCE_RUN_TRIGGER_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ canisterId, databaseId, sourcePath, sourceEtag, sessionNonce })
    });
    if (!response.ok) {
      return { ok: false, error: `worker trigger failed: HTTP ${response.status}` };
    }
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "worker trigger failed" };
  }
}
