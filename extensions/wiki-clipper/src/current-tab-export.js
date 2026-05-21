// Where: extensions/wiki-clipper/src/current-tab-export.js
// What: Export recent ChatGPT conversations through ChatGPT backend APIs.
// Why: Direct API export avoids visible tab navigation.
import { captureFromChatGptResponse } from "./chatgpt-response.js";

const STATE_KEY = "kinic-current-tab-export-v1";
const STATE_VERSION = 1;
const STATE_TTL_MS = 30 * 60 * 1000;
const EXPORT_CONCURRENCY = 2;
const CONVERSATION_LIST_PAGE_SIZE = 28;
export const EXPORT_LOGIN_REQUIRED_MESSAGE = "Login with Internet Identity before exporting.";

export function createExportState({ limit, config, originalUrl, startedAt = new Date().toISOString() }) {
  const startedAtMs = Date.parse(startedAt);
  const expiresAt = new Date((Number.isFinite(startedAtMs) ? startedAtMs : Date.now()) + STATE_TTL_MS).toISOString();
  return {
    version: STATE_VERSION,
    limit,
    targets: [],
    config,
    originalUrl,
    startedAt,
    expiresAt,
    phase: "fetching",
    status: "exporting",
    error: "",
    progress: { total: limit, done: 0, ok: 0, failed: 0 },
    logs: []
  };
}

export async function readExportState(storage = exportStateStorage()) {
  try {
    if (!storage) return null;
    const raw = await storage.getItem(STATE_KEY);
    const state = raw ? JSON.parse(raw) : null;
    if (!isValidState(state)) {
      if (raw) await storage.removeItem(STATE_KEY);
      return null;
    }
    return state;
  } catch {
    await storage?.removeItem?.(STATE_KEY);
    return null;
  }
}

export async function writeExportState(state, storage = exportStateStorage()) {
  if (!storage) return;
  await storage.setItem(STATE_KEY, JSON.stringify(state));
}

export async function clearExportState(storage = exportStateStorage()) {
  if (!storage) return;
  await storage.removeItem(STATE_KEY);
}

export async function startCurrentTabExport(options) {
  await ensureAuthenticatedForExport(options.callbacks?.send);
  const state = createExportState(options);
  await writeExportState(state);
  await processDirectExport(options.callbacks);
}

export async function resumeCurrentTabExport(callbacks) {
  const state = await readExportState();
  if (!state) return;
  hydrate(callbacks, state);
  if (state.status !== "exporting") {
    await clearExportState();
    return;
  }
  const next = { ...state, status: "cancelled", error: "Previous export was interrupted." };
  await writeExportState(next);
  hydrate(callbacks, next);
  await clearExportState();
}

export async function cancelCurrentTabExport(callbacks) {
  const state = await readExportState();
  if (!state) return;
  const next = { ...state, status: "cancelled" };
  await writeExportState(next);
  hydrate(callbacks, next);
}

async function processDirectExport(callbacks) {
  let state = await readExportState();
  if (!state || state.status !== "exporting") return;
  hydrate(callbacks, state);
  try {
    const targets = await fetchRecentConversationTargets(state.limit);
    state = {
      ...((await readExportState()) || state),
      targets,
      phase: "exporting",
      progress: { total: targets.length, done: 0, ok: 0, failed: 0 }
    };
    await writeExportState(state);
    hydrate(callbacks, state);
    if (state.status === "cancelled") {
      await clearExportState();
      return;
    }
    if (!targets.length) {
      throw new Error("No recent ChatGPT conversations found.");
    }
    let latest = await processExportTargets(targets, state, callbacks);
    const storedState = await readExportState();
    if (storedState?.status === "cancelled") {
      hydrate(callbacks, storedState);
      await clearExportState();
      return;
    }
    state = latest;
    state = { ...state, status: state.progress.failed ? "partial" : "done" };
    await writeExportState(state);
    hydrate(callbacks, state);
    await clearExportState();
  } catch (error) {
    const failed = {
      ...((await readExportState()) || state),
      status: "error",
      error: error instanceof Error ? error.message : String(error)
    };
    await writeExportState(failed);
    hydrate(callbacks, failed);
    await clearExportState();
  }
}

async function ensureAuthenticatedForExport(send) {
  if (typeof send !== "function") {
    throw new Error("extension auth status is unavailable");
  }
  const response = await send({ type: "auth-status" });
  if (!response?.result?.isAuthenticated) {
    throw new Error(EXPORT_LOGIN_REQUIRED_MESSAGE);
  }
}

export async function processExportTargets(targets, state, callbacks, concurrency = EXPORT_CONCURRENCY) {
  let latest = (await readExportState()) || state;
  let updateQueue = Promise.resolve();
  function enqueueStateUpdate(fn) {
    updateQueue = updateQueue.then(fn, fn);
    return updateQueue;
  }
  async function recordEvent(event) {
    return enqueueStateUpdate(async () => {
      const stored = await readExportState();
      if (stored?.status === "cancelled") {
        latest = stored;
        return;
      }
      latest = stored || latest;
      latest = advanceState(latest, event);
      await writeExportState(latest);
      const afterWrite = await readExportState();
      if (afterWrite?.status === "cancelled") {
        latest = afterWrite;
        return;
      }
      hydrate(callbacks, latest);
    });
  }
  await mapWithConcurrency(targets, concurrency, async (target) => {
    if (await exportIsCancelled()) return null;
    const event = await exportTarget(target, latest.config, callbacks.send);
    if (await exportIsCancelled()) return null;
    await recordEvent(event);
    return event;
  });
  return latest;
}

export async function exportTarget(target, config, send, fetchImpl = fetch) {
  const result = await fetchConversationCapture(target, fetchImpl);
  return saveCaptureResult(result, config, send);
}

export async function fetchRecentConversationTargets(limit, fetchImpl = fetch, loc = location) {
  const targets = [];
  const seen = new Set();
  const currentTarget = currentConversationTarget(loc);
  if (currentTarget) {
    targets.push(currentTarget);
    seen.add(currentTarget.id);
  }
  let offset = 0;
  while (targets.length < limit) {
    const pageLimit = Math.min(CONVERSATION_LIST_PAGE_SIZE, limit - targets.length);
    const payload = await fetchJson(`/backend-api/conversations?offset=${offset}&limit=${pageLimit}&order=updated`, fetchImpl);
    const items = Array.isArray(payload?.items) ? payload.items : Array.isArray(payload) ? payload : [];
    if (!items.length && offset === 0 && targets.length === 0) {
      throw new Error(`No recent ChatGPT conversations found. ${conversationListSummary(payload)}`);
    }
    if (!items.length) break;
    for (const item of items) {
      const id = conversationIdFromListItem(item);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      targets.push({
        id,
        title: titleFromListItem(item),
        url: new URL(`/c/${id}`, loc.origin).toString()
      });
      if (targets.length >= limit) break;
    }
    offset += items.length;
    if (payload?.has_more === false) break;
  }
  return targets;
}

export async function fetchConversationCapture(target, fetchImpl = fetch) {
  try {
    const payload = await fetchJson(`/backend-api/conversation/${encodeURIComponent(target.id)}`, fetchImpl);
    const capture = captureFromChatGptResponse(payload, target.url);
    capture.captureMethod = "direct api";
    if (!payload?.mapping || !payload?.current_node || capture.messages.length === 0) {
      return { ok: false, target, error: "no conversation messages found" };
    }
    return { ok: true, target, capture };
  } catch (error) {
    return { ok: false, target, error: error instanceof Error ? error.message : String(error) };
  }
}

async function saveCaptureResult(result, config, send) {
  if (await exportIsCancelled()) {
    return { ok: false, title: result.target.title, url: result.target.url, error: "export cancelled" };
  }
  if (!result.ok) {
    return { ok: false, title: result.target.title, url: result.target.url, error: result.error };
  }
  try {
    const response = await send({ type: "save-source", capture: result.capture, config });
    return {
      ok: true,
      title: result.capture.conversationTitle || result.target.title,
      provider: result.capture.provider,
      captureMethod: result.capture.captureMethod,
      path: response.result.path,
      created: response.result.created
    };
  } catch (error) {
    return {
      ok: false,
      title: result.target.title,
      url: result.target.url,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export function advanceState(state, event) {
  const progress = {
    ...state.progress,
    done: state.progress.done + 1,
    ok: state.progress.ok + (event.ok ? 1 : 0),
    failed: state.progress.failed + (event.ok ? 0 : 1)
  };
  return {
    ...state,
    progress,
    logs: [logFromEvent(event), ...state.logs].slice(0, 100)
  };
}

export function isValidState(state, now = new Date()) {
  if (!state || typeof state !== "object") return false;
  if (state.version !== STATE_VERSION) return false;
  if (typeof state.limit !== "number" || !Array.isArray(state.targets)) return false;
  if (!state.progress || typeof state.progress !== "object") return false;
  const expiresAtMs = Date.parse(state.expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now.getTime()) return false;
  if (!["exporting", "cancelled", "done", "partial", "error"].includes(state.status)) return false;
  return true;
}

export async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function run() {
    for (;;) {
      if (await exportIsCancelled()) return;
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => run());
  await Promise.all(workers);
  return results.filter(Boolean);
}

async function exportIsCancelled() {
  return (await readExportState())?.status === "cancelled";
}

export function exportStateStorage() {
  const runtime = globalThis.chrome?.runtime;
  if (typeof runtime?.sendMessage !== "function") return null;
  return {
    async getItem(key) {
      const response = await runtime.sendMessage({ type: "export-state-get", key });
      if (!response?.ok) throw new Error(response?.error || "failed to read export state");
      return response.value ?? null;
    },
    async setItem(key, value) {
      const response = await runtime.sendMessage({ type: "export-state-set", key, value });
      if (!response?.ok) throw new Error(response?.error || "failed to write export state");
    },
    async removeItem(key) {
      const response = await runtime.sendMessage({ type: "export-state-remove", key });
      if (!response?.ok) throw new Error(response?.error || "failed to remove export state");
    }
  };
}

async function fetchJson(url, fetchImpl) {
  const accessToken = await readChatGptAccessToken(fetchImpl);
  const response = await fetchImpl(url, {
    method: "GET",
    credentials: "include",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`
    }
  });
  if (!response.ok) {
    throw new Error(`ChatGPT API failed: ${response.status}`);
  }
  return response.json();
}

async function readChatGptAccessToken(fetchImpl) {
  const response = await fetchImpl("/api/auth/session", {
    method: "GET",
    credentials: "include",
    headers: { Accept: "application/json" }
  });
  if (!response.ok) {
    throw new Error(`ChatGPT session failed: ${response.status}`);
  }
  const session = await response.json();
  const accessToken = typeof session?.accessToken === "string" ? session.accessToken : "";
  if (!accessToken) {
    throw new Error("ChatGPT session does not include an access token. Sign in again and reload ChatGPT.");
  }
  return accessToken;
}

function conversationIdFromListItem(item) {
  if (typeof item?.id === "string") return item.id;
  if (typeof item?.conversation_id === "string") return item.conversation_id;
  return "";
}

function titleFromListItem(item) {
  const title = typeof item?.title === "string" ? item.title.trim() : "";
  return title || "Untitled conversation";
}

function currentConversationTarget(loc) {
  try {
    const url = new URL(loc.href || "", loc.origin);
    const id = conversationIdFromPath(url.pathname);
    if (!id) return null;
    return {
      id,
      title: "Current conversation",
      url: new URL(`/c/${id}`, loc.origin).toString()
    };
  } catch {
    return null;
  }
}

function conversationIdFromPath(pathname) {
  const match = /^\/c\/([^/]+)\/?$/.exec(pathname);
  return match ? decodeURIComponent(match[1]) : "";
}

function conversationListSummary(payload) {
  if (Array.isArray(payload)) return "ChatGPT API returned an empty array.";
  if (!payload || typeof payload !== "object") return `ChatGPT API returned ${typeof payload}.`;
  const total = typeof payload.total === "number" ? payload.total : "unknown";
  const offset = typeof payload.offset === "number" ? payload.offset : "unknown";
  const keys = Object.keys(payload).slice(0, 8).join(", ") || "none";
  return `ChatGPT API returned 0 items. total=${total}, offset=${offset}, keys=${keys}.`;
}

function hydrate(callbacks, state) {
  callbacks.onState?.(state);
}

function logFromEvent(event) {
  return {
    id: globalThis.crypto?.randomUUID?.() || `${event.title || event.url}-${Date.now()}`,
    kind: event.ok ? "success" : "error",
    provider: event.provider || "ChatGPT",
    time: "just now",
    message: event.ok
      ? `Memory: ${event.title || event.path} via ${event.captureMethod || "unknown"} (${event.created ? "Created" : "Updated"})`
      : `Failed: ${event.title || event.url} - ${event.error}`
  };
}
