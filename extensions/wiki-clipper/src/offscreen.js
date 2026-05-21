// Where: extensions/wiki-clipper/src/offscreen.js
// What: DOM-backed authenticated URL ingest worker for the MV3 extension.
// Why: Internet Identity AuthClient requires a window-like context, not the service worker.
import { authSnapshot as defaultAuthSnapshot } from "./auth-client.js";
import { buildUrlIngestRequest } from "./url-ingest-request.js";
import { createVfsActor as defaultCreateVfsActor } from "./vfs-actor.js";

const URL_INGEST_TRIGGER_URL = "https://wiki.kinic.xyz/api/url-ingest/trigger";
const TRIGGER_SESSION_TTL_MS = 30 * 60 * 1000;
const TRIGGER_SESSION_REFRESH_MS = 2 * 60 * 1000;

let authSnapshotFactory = defaultAuthSnapshot;
let vfsActorFactory = defaultCreateVfsActor;
let fetchFactory = (...args) => fetch(...args);
const triggerSessionCache = new Map();

if (globalThis.chrome?.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.target !== "offscreen") return false;
    const task =
      message?.type === "queue-url-ingest"
        ? queueUrlIngest(message.tab, message.config)
        : message?.type === "save-raw-source"
          ? saveRawSource(message.rawSource, message.config)
          : message?.type === "auth-status"
            ? authStatus()
            : null;
    if (!task) return false;
    task.then(
      (result) => sendResponse({ ok: true, result }),
      (error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) })
    );
    return true;
  });
}

export async function queueUrlIngest(tab, config) {
  if (!tab?.url) throw new Error("active tab URL is required");
  if (!config?.canisterId) throw new Error("canister id is required");
  if (!config?.databaseId) throw new Error("database id is required");
  const snapshot = await authenticatedSnapshot();
  const actor = await vfsActorFactory({ ...config, identity: snapshot.identity });
  const session = await ensureTriggerSession(actor, config.databaseId, snapshot.principal);
  const request = buildUrlIngestRequest({
    url: tab.url,
    requestedBy: snapshot.principal
  });
  await ensureParentFolders(actor, config.databaseId, request.writeRequest.path);
  const result = await actor.write_node({
    database_id: config.databaseId,
    path: request.writeRequest.path,
    kind: request.writeRequest.kind,
    content: request.writeRequest.content,
    metadata_json: request.writeRequest.metadataJson,
    expected_etag: request.writeRequest.expectedEtag
  });
  if ("Err" in result) throw new Error(result.Err);
  const trigger = await triggerUrlIngest(config.canisterId, config.databaseId, request.requestPath, session);
  return {
    requestPath: request.requestPath,
    url: tab.url,
    title: tab.title || "",
    principal: snapshot.principal,
    etag: result.Ok.node.etag,
    triggered: trigger.ok,
    triggerError: trigger.error
  };
}

export async function saveRawSource(rawSource, config) {
  if (!rawSource?.path) throw new Error("raw source path is required");
  if (typeof rawSource.content !== "string") throw new Error("raw source content is required");
  if (typeof rawSource.metadataJson !== "string") throw new Error("raw source metadata is required");
  if (!config?.canisterId) throw new Error("canister id is required");
  if (!config?.databaseId) throw new Error("database id is required");
  const snapshot = await authenticatedSnapshot();
  const actor = await vfsActorFactory({ ...config, identity: snapshot.identity });
  const existing = await actor.read_node(config.databaseId, rawSource.path);
  if ("Err" in existing) throw new Error(existing.Err);
  const expected = existing.Ok[0]?.etag ? [existing.Ok[0].etag] : [];
  await ensureParentFolders(actor, config.databaseId, rawSource.path);
  const result = await actor.write_node({
    database_id: config.databaseId,
    path: rawSource.path,
    kind: { Source: null },
    content: rawSource.content,
    metadata_json: rawSource.metadataJson,
    expected_etag: expected
  });
  if ("Err" in result) throw new Error(result.Err);
  return {
    path: rawSource.path,
    sourceId: rawSource.sourceId || "",
    created: result.Ok.created,
    principal: snapshot.principal,
    etag: result.Ok.node.etag
  };
}

async function ensureParentFolders(actor, databaseId, path) {
  const segments = path.split("/").filter(Boolean);
  let current = "";
  for (const segment of segments.slice(0, -1)) {
    current = `${current}/${segment}`;
    const result = await actor.mkdir_node({ database_id: databaseId, path: current });
    if ("Err" in result) throw new Error(result.Err);
  }
}

export async function authStatus() {
  const snapshot = await authSnapshotFactory();
  return {
    isAuthenticated: Boolean(snapshot.isAuthenticated),
    principal: snapshot.principal || null
  };
}

export function setOffscreenDepsForTest(deps = {}) {
  authSnapshotFactory = deps.authSnapshot || defaultAuthSnapshot;
  vfsActorFactory = deps.createVfsActor || defaultCreateVfsActor;
  fetchFactory = deps.fetch || ((...args) => fetch(...args));
  triggerSessionCache.clear();
}

async function authenticatedSnapshot() {
  const snapshot = await authSnapshotFactory();
  if (!snapshot.isAuthenticated || !snapshot.identity || !snapshot.principal) {
    throw new Error("UNAUTHENTICATED");
  }
  return snapshot;
}

async function ensureTriggerSession(actor, databaseId, principal) {
  const key = `${databaseId}:${principal}`;
  const now = Date.now();
  const cached = triggerSessionCache.get(key);
  if (cached && cached.expiresAtMs - now > TRIGGER_SESSION_REFRESH_MS) {
    return cached.sessionNonce;
  }
  if (cached?.promise) {
    return cached.promise;
  }
  const sessionNonce = crypto.randomUUID();
  const promise = actor
    .authorize_url_ingest_trigger_session({
      database_id: databaseId,
      session_nonce: sessionNonce
    })
    .then((result) => {
      if ("Err" in result) throw new Error(result.Err);
      triggerSessionCache.set(key, {
        sessionNonce,
        expiresAtMs: now + TRIGGER_SESSION_TTL_MS
      });
      return sessionNonce;
    })
    .catch((error) => {
      triggerSessionCache.delete(key);
      throw error;
    });
  triggerSessionCache.set(key, {
    sessionNonce,
    expiresAtMs: now,
    promise
  });
  return promise;
}

async function triggerUrlIngest(canisterId, databaseId, requestPath, sessionNonce) {
  try {
    const response = await fetchFactory(URL_INGEST_TRIGGER_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ canisterId, databaseId, requestPath, sessionNonce })
    });
    if (!response.ok) {
      return { ok: false, error: `worker trigger failed: HTTP ${response.status}` };
    }
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "worker trigger failed" };
  }
}
