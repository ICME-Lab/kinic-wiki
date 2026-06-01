// Where: extensions/wiki-clipper/src/service-worker.js
// What: MV3 background workflow for canister persistence.
// Why: Content scripts fetch AI conversation data while the worker owns canister writes.
import { buildRawSource } from "./raw-source.js";
import {
  DEFAULT_CANISTER_ID,
  DEFAULT_IC_HOST,
  URL_INGEST_STATUS_KEY,
  normalizedHttpUrl
} from "./url-ingest-request.js";
import { buildWebRawSource, collectWebPageSnapshot } from "./web-source.js";

const DEFAULT_CONFIG = {
  canisterId: DEFAULT_CANISTER_ID,
  databaseId: "",
  host: DEFAULT_IC_HOST
};
const PROVIDERS = {
  chatgpt: {
    label: "ChatGPT",
    origins: new Set(["https://chatgpt.com", "https://chat.openai.com"]),
    pathPattern: /^\/c\/[^/]+\/?$/,
    pathHint: "/c/<id>"
  },
  claude: {
    label: "Claude",
    origins: new Set(["https://claude.ai"]),
    pathPattern: /^\/chat\/[^/]+\/?$/,
    pathHint: "/chat/<id>"
  }
};
const ALLOWED_MESSAGE_ROLES = new Set(["user", "assistant", "system"]);
const MAX_MESSAGE_COUNT = 500;
const MAX_MESSAGE_CONTENT_CHARS = 200_000;
const MAX_RAW_SOURCE_CHARS = 1_500_000;
const SETTINGS_OPEN_THROTTLE_MS = 2_000;
const SETTINGS_MENU_ID = "kinic-wiki-clipper-settings";
const URL_INGEST_IN_FLIGHT_KEY = "kinic-url-ingest-in-flight-v1";
const URL_INGEST_IN_FLIGHT_TTL_MS = 2 * 60 * 1000;
let offscreenBridge = defaultOffscreenBridge;
let lastSettingsOpenedAt = 0;
const activeUrlIngests = new Set();

if (globalThis.chrome?.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.target === "offscreen") return false;
    handleMessage(message, sender).then(sendResponse, (error) => {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
    });
    return true;
  });
}

if (globalThis.chrome?.action?.onClicked) {
  chrome.action.onClicked.addListener((tab) => {
    handleActionClick(tab).catch((error) => {
      writeLatestUrlIngestStatus(errorStatus(error instanceof Error ? error.message : String(error)));
      setActionBadge("ERR", "#b42318");
    });
  });
}

if (globalThis.chrome?.runtime?.onInstalled) {
  chrome.runtime.onInstalled.addListener(() => {
    createSettingsContextMenu().catch((error) => {
      console.warn("failed to create settings context menu", error);
    });
  });
}

if (globalThis.chrome?.contextMenus?.onClicked) {
  chrome.contextMenus.onClicked.addListener((info) => {
    if (info?.menuItemId === SETTINGS_MENU_ID) {
      chrome.runtime.openOptionsPage();
    }
  });
  createSettingsContextMenu().catch((error) => {
    console.warn("failed to create settings context menu", error);
  });
}

export async function handleMessage(message, sender) {
  if (message?.type === "save-source") {
    return { ok: true, result: await saveSource(message.capture, message.config, sender) };
  }
  if (message?.type === "load-config") {
    return { ok: true, config: await loadConfig() };
  }
  if (message?.type === "save-config") {
    await saveConfig(message.config);
    return { ok: true };
  }
  if (message?.type === "auth-status") {
    return { ok: true, result: await authStatus() };
  }
  if (message?.type === "list-writable-databases") {
    return { ok: true, result: await listWritableDatabases() };
  }
  if (message?.type === "open-settings") {
    await openSettingsOnce();
    return { ok: true };
  }
  if (message?.type === "latest-url-ingest-status") {
    return { ok: true, value: await readLatestUrlIngestStatus() };
  }
  if (message?.type === "export-state-get") {
    return { ok: true, value: await readSessionValue(message.key) };
  }
  if (message?.type === "export-state-set") {
    await writeSessionValue(message.key, message.value);
    return { ok: true };
  }
  if (message?.type === "export-state-remove") {
    await removeSessionValue(message.key);
    return { ok: true };
  }
  return { ok: false, error: `unknown message type: ${describeMessageType(message)}` };
}

export async function handleActionClick(tab, deps = defaultActionDeps()) {
  let inFlightKey = null;
  let reservedInFlight = false;
  try {
    const url = normalizedHttpUrl(tab?.url);
    await deps.setBadge("...", "#444444");
    const config = await deps.loadConfig();
    if (!config.databaseId) {
      await deps.writeStatus(setupRequiredStatus(url));
      await deps.setBadge("SET", "#5f6368");
      await deps.openSettings();
      return { ok: false, error: "config required" };
    }
    inFlightKey = urlIngestInFlightKey(config.databaseId, url);
    reservedInFlight = await deps.reserveUrlIngest(inFlightKey);
    if (!reservedInFlight) {
      const status = busyStatus(url);
      await deps.writeStatus(status);
      await deps.setBadge("BUSY", "#5f6368");
      return { ok: false, error: status.message };
    }
    const rawSource = await deps.captureTabSource(tab, url);
    await deps.ensureOffscreen();
    const saveResponse = await deps.sendOffscreen({
      target: "offscreen",
      type: "save-raw-source",
      rawSource,
      config
    });
    if (!saveResponse?.ok) {
      const error = saveResponse?.error || "source save failed";
      await deps.writeStatus(errorStatus(error, url));
      await deps.setBadge("ERR", "#b42318");
      if (shouldOpenSettingsForError(error)) {
        await deps.openSettings();
      }
      return { ok: false, error };
    }
    const triggerResponse = await deps.sendOffscreen({
      target: "offscreen",
      type: "trigger-source-generation",
      sourcePath: saveResponse.result.path,
      sourceEtag: saveResponse.result.etag,
      sessionNonce: saveResponse.result.sourceRunSessionNonce,
      config
    });
    const result = {
      url,
      title: tab?.title || "",
      sourcePath: saveResponse.result.path,
      sourceEtag: saveResponse.result.etag,
      sourceCreated: saveResponse.result.created,
      generationQueued: Boolean(triggerResponse?.ok && triggerResponse.result?.triggered !== false),
      generationError: triggerResponse?.ok ? triggerResponse.result?.triggerError || null : triggerResponse?.error || "generation queue failed"
    };
    const status = sourceCaptureStatus(result);
    await deps.writeStatus(status);
    if (!result.generationQueued) {
      await deps.setBadge("SRC", "#5f6368");
      return { ok: true, result };
    }
    await deps.setBadge("OK", "#137333");
    return { ok: true, result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await deps.writeStatus(errorStatus(message, tab?.url || ""));
    await deps.setBadge("ERR", "#b42318");
    return { ok: false, error: message };
  } finally {
    if (reservedInFlight && inFlightKey) {
      await deps.releaseUrlIngest(inFlightKey);
    }
  }
}

async function saveSource(capture, overrideConfig, sender) {
  validateSaveSource(capture, sender);
  const config = withFixedRuntimeConfig({ ...(await loadConfig()), ...(overrideConfig || {}) });
  if (!config.canisterId) {
    throw new Error("canister id is required");
  }
  if (!config.databaseId) {
    throw new Error("database id is required");
  }
  const raw = buildRawSource(capture);
  let result;
  try {
    result = await offscreenBridge({
      target: "offscreen",
      type: "save-raw-source",
      rawSource: raw,
      config
    });
  } catch (error) {
    if (error instanceof Error && shouldOpenSettingsForError(error.message)) {
      await openSettingsOnce();
    }
    throw error;
  }
  if (!result?.ok) {
    const message = result?.error || "raw source save failed";
    if (shouldOpenSettingsForError(message)) {
      await openSettingsOnce();
    }
    throw new Error(message);
  }
  let triggerResponse;
  try {
    triggerResponse = await offscreenBridge({
      target: "offscreen",
      type: "trigger-source-generation",
      sourcePath: result.result.path,
      sourceEtag: result.result.etag,
      sessionNonce: result.result.sourceRunSessionNonce,
      config
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "UNAUTHENTICATED") {
      await openSettingsOnce();
    }
    triggerResponse = { ok: false, error: message };
  }
  const generationQueued = Boolean(triggerResponse?.ok && triggerResponse.result?.triggered !== false);
  return {
    path: result.result.path,
    sourceId: result.result.sourceId,
    created: result.result.created,
    etag: result.result.etag,
    generationQueued,
    generationError: generationQueued
      ? null
      : triggerResponse?.ok
        ? triggerResponse.result?.triggerError || "generation queue failed"
        : triggerResponse?.error || "generation queue failed"
  };
}

export function setOffscreenBridgeForTest(bridge) {
  offscreenBridge = bridge || defaultOffscreenBridge;
}

export function resetSettingsOpenThrottleForTest() {
  lastSettingsOpenedAt = 0;
}

async function defaultOffscreenBridge(message) {
  await ensureOffscreen();
  return chrome.runtime.sendMessage(message);
}

async function authStatus() {
  const response = await offscreenBridge({ target: "offscreen", type: "auth-status" });
  if (!response?.ok) {
    throw new Error(response?.error || "auth status failed");
  }
  const result = {
    isAuthenticated: Boolean(response.result?.isAuthenticated),
    principal: response.result?.principal || null
  };
  if (!result.isAuthenticated) {
    await openSettingsOnce();
  }
  return result;
}

async function listWritableDatabases() {
  const response = await offscreenBridge({
    target: "offscreen",
    type: "list-writable-databases",
    config: withFixedRuntimeConfig(await loadConfig())
  });
  if (!response?.ok) {
    if (response?.error === "UNAUTHENTICATED") {
      await openSettingsOnce();
    }
    throw new Error(response?.error || "database list failed");
  }
  return response.result || [];
}

async function readSessionValue(key) {
  requireSessionKey(key);
  const values = await chrome.storage.session.get(key);
  return values?.[key] ?? null;
}

async function writeSessionValue(key, value) {
  requireSessionKey(key);
  const current = await readSessionValue(key);
  if (stateStatus(current) === "cancelled" && stateStatus(value) !== "cancelled") {
    return;
  }
  await chrome.storage.session.set({ [key]: String(value || "") });
}

async function removeSessionValue(key) {
  requireSessionKey(key);
  await chrome.storage.session.remove(key);
}

async function readLatestUrlIngestStatus() {
  const values = await chrome.storage.session.get(URL_INGEST_STATUS_KEY);
  return values?.[URL_INGEST_STATUS_KEY] ?? null;
}

async function writeLatestUrlIngestStatus(status) {
  if (!globalThis.chrome?.storage?.session) return;
  await chrome.storage.session.set({ [URL_INGEST_STATUS_KEY]: JSON.stringify(status) });
}

function sourceCaptureStatus(result) {
  const queued = result?.generationQueued === true;
  return {
    status: queued ? "ok" : "source_saved",
    url: result?.url || "",
    title: result?.title || "",
    sourcePath: result?.sourcePath || "",
    message: queued
      ? "Source saved. Generation queued."
      : `Source saved. Generation queue failed: ${result?.generationError || "worker trigger failed"}`,
    updatedAt: new Date().toISOString()
  };
}

function errorStatus(message, url = "") {
  return {
    status: "error",
    url,
    message,
    updatedAt: new Date().toISOString()
  };
}

function shouldOpenSettingsForError(message) {
  return message === "UNAUTHENTICATED" || /credits|balance/i.test(String(message || ""));
}

function setupRequiredStatus(url = "") {
  return {
    status: "setup_required",
    url,
    message: "Login and select a writable database.",
    updatedAt: new Date().toISOString()
  };
}

function busyStatus(url = "") {
  return {
    status: "busy",
    url,
    message: "URL ingest is already running for this page.",
    updatedAt: new Date().toISOString()
  };
}

function defaultActionDeps() {
  return {
    loadConfig,
    ensureOffscreen,
    sendOffscreen: (message) => chrome.runtime.sendMessage(message),
    writeStatus: writeLatestUrlIngestStatus,
    setBadge: setActionBadge,
    openSettings: openSettingsOnce,
    reserveUrlIngest,
    releaseUrlIngest,
    captureTabSource
  };
}

async function captureTabSource(tab, url) {
  if (!tab?.id) {
    throw new Error("active tab id is required");
  }
  if (!globalThis.chrome?.scripting?.executeScript) {
    throw new Error("page capture is unavailable");
  }
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: collectWebPageSnapshot
  });
  const snapshot = results?.[0]?.result;
  return buildWebRawSource({ ...snapshot, url });
}

async function createSettingsContextMenu() {
  if (!globalThis.chrome?.contextMenus) return;
  if (typeof chrome.contextMenus.remove === "function") {
    await chrome.contextMenus.remove(SETTINGS_MENU_ID).catch(() => {});
  }
  chrome.contextMenus.create({
    id: SETTINGS_MENU_ID,
    title: "Settings",
    contexts: ["action"]
  });
}

export function createSettingsContextMenuForTest() {
  return createSettingsContextMenu();
}

export function handleContextMenuClickForTest(info) {
  if (info?.menuItemId === SETTINGS_MENU_ID) {
    chrome.runtime.openOptionsPage();
  }
}

export function resetUrlIngestInFlightForTest() {
  activeUrlIngests.clear();
}

async function ensureOffscreen() {
  const url = chrome.runtime.getURL("offscreen/offscreen.html");
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [url]
  });
  if (contexts.length > 0) return;
  await chrome.offscreen.createDocument({
    url: "offscreen/offscreen.html",
    reasons: [chrome.offscreen.Reason.DOM_PARSER],
    justification: "Run Internet Identity and authenticated VFS calls in a DOM context."
  });
}

export function validateSaveSource(capture, sender) {
  const senderProvider = providerForUrl(sender?.tab?.url);
  if (!senderProvider) {
    throw new Error("save-source sender must be a supported AI conversation tab");
  }
  const captureProvider = providerForUrl(capture?.url);
  if (!captureProvider) {
    throw new Error("capture url must be a supported AI conversation");
  }
  if (senderProvider !== captureProvider) {
    throw new Error("capture provider must match sender origin");
  }
  if (capture.provider !== captureProvider) {
    throw new Error("capture provider must match sender origin");
  }
  const rule = PROVIDERS[captureProvider];
  if (!isConversationUrl(capture.url, rule)) {
    throw new Error(`capture url must use ${rule.pathHint}`);
  }
  if (typeof capture.conversationTitle !== "string") {
    throw new Error("capture conversationTitle must be a string");
  }
  if (!isIsoDateTime(capture.capturedAt)) {
    throw new Error("capture capturedAt must be an ISO timestamp");
  }
  if (!Array.isArray(capture.messages) || capture.messages.length === 0) {
    throw new Error("capture messages must be a non-empty array");
  }
  if (capture.messages.length > MAX_MESSAGE_COUNT) {
    throw new Error(`capture messages must not exceed ${MAX_MESSAGE_COUNT}`);
  }
  for (const message of capture.messages) {
    if (typeof message?.role !== "string" || typeof message?.content !== "string") {
      throw new Error("capture messages must contain string role and content");
    }
    if (!ALLOWED_MESSAGE_ROLES.has(message.role)) {
      throw new Error("capture message role must be user, assistant, or system");
    }
    if (message.content.length > MAX_MESSAGE_CONTENT_CHARS) {
      throw new Error(`capture message content must not exceed ${MAX_MESSAGE_CONTENT_CHARS} characters`);
    }
  }
  if (estimatedRawSourceSize(capture) > MAX_RAW_SOURCE_CHARS) {
    throw new Error(`capture raw source must not exceed ${MAX_RAW_SOURCE_CHARS} characters`);
  }
}

function providerForUrl(value) {
  try {
    const origin = new URL(value).origin;
    for (const [provider, rule] of Object.entries(PROVIDERS)) {
      if (rule.origins.has(origin)) return provider;
    }
    return "";
  } catch {
    return "";
  }
}

function isConversationUrl(value, rule) {
  try {
    return rule.pathPattern.test(new URL(value).pathname);
  } catch {
    return false;
  }
}

function isIsoDateTime(value) {
  if (typeof value !== "string" || !value.includes("T")) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp);
}

function estimatedRawSourceSize(capture) {
  return (
    String(capture.provider || "").length +
    String(capture.url || "").length +
    String(capture.capturedAt || "").length +
    String(capture.conversationTitle || "").length +
    capture.messages.reduce((total, message) => total + message.role.length + message.content.length + 64, 256)
  );
}

async function loadConfig() {
  const stored = await chrome.storage.sync.get(DEFAULT_CONFIG);
  return {
    canisterId: DEFAULT_CONFIG.canisterId,
    databaseId: String(stored.databaseId || DEFAULT_CONFIG.databaseId),
    host: DEFAULT_CONFIG.host
  };
}

async function saveConfig(config) {
  const databaseId = String(config?.databaseId || "").trim();
  if (databaseId) {
    await chrome.storage.sync.set({ databaseId });
    await chrome.storage.sync.remove?.(["canisterId", "host", "generatorUrl"]);
    return;
  }
  await chrome.storage.sync.remove?.(["databaseId", "canisterId", "host", "generatorUrl"]);
}

function withFixedRuntimeConfig(config) {
  return {
    ...config,
    canisterId: DEFAULT_CONFIG.canisterId,
    host: DEFAULT_CONFIG.host
  };
}

async function setActionBadge(text, color) {
  if (!globalThis.chrome?.action) return;
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
}

async function openSettings() {
  await chrome.runtime.openOptionsPage();
}

async function openSettingsOnce(open = openSettings) {
  const now = Date.now();
  if (now - lastSettingsOpenedAt < SETTINGS_OPEN_THROTTLE_MS) return;
  lastSettingsOpenedAt = now;
  await open();
}

async function reserveUrlIngest(key) {
  if (activeUrlIngests.has(key)) return false;
  const current = await readInFlightRecord();
  const now = Date.now();
  if (current?.key === key && current.expiresAt > now) {
    return false;
  }
  await writeInFlightRecord({ key, expiresAt: now + URL_INGEST_IN_FLIGHT_TTL_MS });
  activeUrlIngests.add(key);
  return true;
}

async function releaseUrlIngest(key) {
  activeUrlIngests.delete(key);
  const current = await readInFlightRecord();
  if (current?.key === key) {
    await chrome.storage.session.remove(URL_INGEST_IN_FLIGHT_KEY);
  }
}

async function readInFlightRecord() {
  if (!globalThis.chrome?.storage?.session) return null;
  const values = await chrome.storage.session.get(URL_INGEST_IN_FLIGHT_KEY);
  const raw = values?.[URL_INGEST_IN_FLIGHT_KEY];
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed?.key !== "string" || typeof parsed?.expiresAt !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeInFlightRecord(record) {
  if (!globalThis.chrome?.storage?.session) return;
  await chrome.storage.session.set({ [URL_INGEST_IN_FLIGHT_KEY]: JSON.stringify(record) });
}

function urlIngestInFlightKey(databaseId, url) {
  return `${databaseId}:${url}`;
}

function requireSessionKey(key) {
  if (typeof key !== "string" || !key.startsWith("kinic-current-tab-export-")) {
    throw new Error("invalid export state key");
  }
}

function stateStatus(value) {
  try {
    return JSON.parse(value)?.status || "";
  } catch {
    return "";
  }
}

function describeMessageType(message) {
  if (!message || typeof message !== "object") return typeof message;
  return typeof message.type === "string" && message.type ? message.type : "missing";
}
