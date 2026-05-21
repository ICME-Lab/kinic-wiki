// Where: extensions/wiki-clipper/src/service-worker.js
// What: MV3 background workflow for canister persistence.
// Why: Content scripts fetch ChatGPT data while the worker owns canister writes.
import { buildRawSource } from "./raw-source.js";
import {
  DEFAULT_CANISTER_ID,
  DEFAULT_IC_HOST,
  URL_INGEST_STATUS_KEY,
  normalizedHttpUrl
} from "./url-ingest-request.js";

const DEFAULT_CONFIG = {
  canisterId: DEFAULT_CANISTER_ID,
  databaseId: "",
  host: DEFAULT_IC_HOST
};
const ALLOWED_CHATGPT_ORIGINS = new Set(["https://chatgpt.com", "https://chat.openai.com"]);
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
    await deps.ensureOffscreen();
    const response = await deps.sendOffscreen({
      target: "offscreen",
      type: "queue-url-ingest",
      tab: { url, title: tab?.title || "" },
      config
    });
    if (!response?.ok) {
      const error = response?.error || "URL ingest failed";
      await deps.writeStatus(errorStatus(error, url));
      await deps.setBadge("ERR", "#b42318");
      if (error === "UNAUTHENTICATED") {
        await deps.openSettings();
      }
      return { ok: false, error };
    }
    const status = successStatus(response.result);
    await deps.writeStatus(status);
    if (response.result?.triggered === false) {
      await deps.setBadge("ERR", "#b42318");
      return { ok: false, result: response.result, error: response.result.triggerError || "worker trigger failed" };
    }
    await deps.setBadge("OK", "#137333");
    return { ok: true, result: response.result };
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
    if (error instanceof Error && error.message === "UNAUTHENTICATED") {
      await openSettingsOnce();
    }
    throw error;
  }
  if (!result?.ok) {
    const message = result?.error || "raw source save failed";
    if (message === "UNAUTHENTICATED") {
      await openSettingsOnce();
    }
    throw new Error(message);
  }
  await saveConfig(config);
  return {
    path: result.result.path,
    sourceId: result.result.sourceId,
    created: result.result.created,
    etag: result.result.etag
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

function successStatus(result) {
  const triggered = result?.triggered !== false;
  return {
    status: triggered ? "ok" : "error",
    url: result?.url || "",
    title: result?.title || "",
    requestPath: result?.requestPath || "",
    message: triggered
      ? "URL ingest queued and started."
      : `Queued, trigger failed: ${result?.triggerError || "worker trigger failed"}`,
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
    releaseUrlIngest
  };
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
  if (!isAllowedChatGptUrl(sender?.tab?.url)) {
    throw new Error("save-source sender must be a ChatGPT tab");
  }
  if (!isAllowedChatGptUrl(capture?.url)) {
    throw new Error("capture url must be a ChatGPT conversation");
  }
  if (!isConversationUrl(capture.url)) {
    throw new Error("capture url must use /c/<id>");
  }
  if (capture.provider !== "chatgpt") {
    throw new Error("capture provider must be chatgpt");
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

function isAllowedChatGptUrl(value) {
  try {
    return ALLOWED_CHATGPT_ORIGINS.has(new URL(value).origin);
  } catch {
    return false;
  }
}

function isConversationUrl(value) {
  try {
    return /^\/c\/[^/]+\/?$/.test(new URL(value).pathname);
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
