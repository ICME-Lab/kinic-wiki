// Where: extensions/wiki-clipper/src/offscreen.js
// What: DOM-backed authenticated URL/source ingest worker for the MV3 extension.
// Why: Internet Identity AuthClient requires a window-like context, not the service worker.
import { authSnapshot as defaultAuthSnapshot } from "./auth-client.js";
import { buildUrlIngestRequest } from "./url-ingest-request.js";
import {
  createVfsActor as defaultCreateVfsActor,
  getBillingConfigOrNull,
  normalizeWritableDatabases,
  requireDatabaseBillable
} from "./vfs-actor.js";

const URL_INGEST_TRIGGER_URL = "https://wiki.kinic.xyz/api/url-ingest/trigger";
const SOURCE_RUN_TRIGGER_URL = "https://wiki.kinic.xyz/api/source/run";
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
          : message?.type === "trigger-source-generation"
            ? triggerSourceGeneration(message.config, message.sourcePath, message.sourceEtag, message.sessionNonce)
            : message?.type === "auth-status"
              ? authStatus()
              : message?.type === "list-writable-databases"
                ? listWritableDatabases(message.config)
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
  await requireDatabaseBillable(actor, config.databaseId);
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
  await requireDatabaseBillable(actor, config.databaseId);
  const existing = await actor.read_node(config.databaseId, rawSource.path);
  if ("Err" in existing) throw new Error(existing.Err);
  const expected = existing.Ok[0]?.etag ? [existing.Ok[0].etag] : [];
  await ensureParentFolders(actor, config.databaseId, rawSource.path);
  const sessionNonce = crypto.randomUUID();
  const result = await actor.write_source_for_generation({
    database_id: config.databaseId,
    path: rawSource.path,
    content: rawSource.content,
    metadata_json: rawSource.metadataJson,
    expected_etag: expected,
    session_nonce: sessionNonce
  });
  if ("Err" in result) throw new Error(result.Err);
  return {
    path: rawSource.path,
    sourceId: rawSource.sourceId || "",
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

export async function listWritableDatabases(config) {
  if (!config?.canisterId) throw new Error("canister id is required");
  const snapshot = await authenticatedSnapshot();
  const actor = await vfsActorFactory({ ...config, identity: snapshot.identity });
  const [result, billingConfig] = await Promise.all([
    actor.list_databases(),
    getBillingConfigOrNull(actor)
  ]);
  if ("Err" in result) throw new Error(result.Err);
  return normalizeWritableDatabases(result.Ok, billingConfig);
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
  return ensureSession(triggerSessionCache, (request) => actor.authorize_url_ingest_trigger_session(request), databaseId, principal);
}

async function ensureSession(cache, authorize, databaseId, principal) {
  const key = `${databaseId}:${principal}`;
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expiresAtMs - now > TRIGGER_SESSION_REFRESH_MS) {
    return cached.sessionNonce;
  }
  if (cached?.promise) {
    return cached.promise;
  }
  const sessionNonce = crypto.randomUUID();
  const promise = authorize({
    database_id: databaseId,
    session_nonce: sessionNonce
  })
    .then((result) => {
      if ("Err" in result) throw new Error(result.Err);
      cache.set(key, {
        sessionNonce,
        expiresAtMs: now + TRIGGER_SESSION_TTL_MS
      });
      return sessionNonce;
    })
    .catch((error) => {
      cache.delete(key);
      throw error;
    });
  cache.set(key, {
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
