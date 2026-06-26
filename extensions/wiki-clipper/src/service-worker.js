// Where: extensions/wiki-clipper/src/service-worker.js
// What: MV3 background workflow for canister persistence.
// Why: Content scripts fetch AI conversation data while the worker owns canister writes.
import { buildEvidenceSource } from "./evidence-source.js";
import {
  DEFAULT_CANISTER_ID,
  DEFAULT_IC_HOST,
  URL_INGEST_STATUS_KEY,
  normalizedHttpUrl
} from "./url-ingest-request.js";
import { buildWebEvidenceSource, collectWebPageSnapshot, webSourcePathForUrl } from "./web-source.js";

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
const MAX_EVIDENCE_SOURCE_CHARS = 1_500_000;
const SETTINGS_OPEN_THROTTLE_MS = 2_000;
const SETTINGS_MENU_ID = "kinic-wiki-clipper-settings";
const CREATE_WIKI_MENU_ID = "kinic-wiki-clipper-create-wiki";
const SAVE_EVIDENCE_MENU_ID = "kinic-wiki-clipper-save-evidence";
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
    refreshCurrentTabBadge().catch((error) => {
      console.warn("failed to refresh active tab badge", error);
    });
  });
}

if (globalThis.chrome?.tabs?.onActivated) {
  chrome.tabs.onActivated.addListener((activeInfo) => {
    refreshTabBadgeById(activeInfo?.tabId).catch((error) => {
      console.warn("failed to refresh activated tab badge", error);
    });
  });
}

if (globalThis.chrome?.tabs?.onUpdated) {
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (!changeInfo?.url) return;
    refreshTabBadge(Number.isInteger(tab?.id) ? tab : { ...tab, id: tabId, url: changeInfo.url }).catch((error) => {
      console.warn("failed to refresh updated tab badge", error);
    });
  });
}

if (globalThis.chrome?.contextMenus?.onClicked) {
  chrome.contextMenus.onClicked.addListener((info, tab) => {
    handleContextMenuClick(info, tab).catch((error) => {
      writeLatestUrlIngestStatus(errorStatus(error instanceof Error ? error.message : String(error), tab?.url || ""));
      setActionBadge("ERR", "#b42318");
    });
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
  if (message?.type === "auth-session-changed") {
    return { ok: true, reset: await resetExistingOffscreenAuthState() };
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

export async function handleActionClick(tab, deps = defaultActionDeps(), options = {}) {
  const queueGeneration = options.queueGeneration !== false;
  let inFlightKey = null;
  let reservedInFlight = false;
  const tabId = tab?.id;
  try {
    const url = normalizedHttpUrl(tab?.url);
    await deps.setBadge("...", "#444444", tabId);
    const config = await deps.loadConfig();
    if (!config.databaseId) {
      await deps.writeStatus(setupRequiredStatus(url));
      await deps.setBadge("SET", "#5f6368", tabId);
      await deps.openSettings();
      return { ok: false, error: "config required" };
    }
    const sourcePath = await webSourcePathForUrl(url);
    await deps.findWebSource(config, sourcePath);
    inFlightKey = urlIngestInFlightKey(config.databaseId, url);
    reservedInFlight = await deps.reserveUrlIngest(inFlightKey);
    if (!reservedInFlight) {
      const status = busyStatus(url);
      await deps.writeStatus(status);
      await deps.setBadge("BUSY", "#5f6368", tabId);
      return { ok: false, error: status.message };
    }
    const evidenceSource = await deps.captureTabSource(tab, url);
    await deps.ensureOffscreen();
    const saveResponse = await deps.sendOffscreen({
      target: "offscreen",
      type: "save-evidence-source",
      evidenceSource,
      config
    });
    if (!saveResponse?.ok) {
      const error = saveResponse?.error || "source save failed";
      await deps.writeStatus(errorStatus(error, url));
      await deps.setBadge("ERR", "#b42318", tabId);
      if (shouldOpenSettingsForError(error)) {
        await deps.openSettings();
      }
      return { ok: false, error };
    }
    const triggerResponse = queueGeneration
      ? await deps.sendOffscreen({
          target: "offscreen",
          type: "trigger-source-generation",
          sourcePath: saveResponse.result.path,
          sourceEtag: saveResponse.result.etag,
          sessionNonce: saveResponse.result.sourceRunSessionNonce,
          config
        })
      : null;
    const result = {
      url,
      title: tab?.title || "",
      sourcePath: saveResponse.result.path,
      sourceEtag: saveResponse.result.etag,
      sourceCreated: saveResponse.result.created,
      generationQueued: queueGeneration ? Boolean(triggerResponse?.ok && triggerResponse.result?.triggered !== false) : false,
      generationSkipped: !queueGeneration,
      generationError: triggerResponse?.ok ? triggerResponse.result?.triggerError || null : triggerResponse?.error || "generation queue failed"
    };
    const status = sourceCaptureStatus(result);
    await deps.writeStatus(status);
    if (result.generationSkipped) {
      await deps.setBadge("SRC", "#5f6368", tabId);
      return { ok: true, result };
    }
    if (!result.generationQueued) {
      await deps.setBadge("SRC", "#5f6368", tabId);
      return { ok: true, result };
    }
    await deps.setBadge("IN", "#137333", tabId);
    return { ok: true, result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await deps.writeStatus(errorStatus(message, tab?.url || ""));
    await deps.setBadge("ERR", "#b42318", tabId);
    if (shouldOpenSettingsForError(message)) {
      await deps.openSettings();
    }
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
  const raw = buildEvidenceSource(capture);
  let result;
  try {
    result = await offscreenBridge({
      target: "offscreen",
      type: "save-evidence-source",
      evidenceSource: raw,
      config
    });
  } catch (error) {
    if (error instanceof Error && shouldOpenSettingsForError(error.message)) {
      await openSettingsOnce();
    }
    throw error;
  }
  if (!result?.ok) {
    const message = result?.error || "evidence source save failed";
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

export async function refreshTabBadgeForTest(tab, deps = defaultActionDeps()) {
  return refreshTabBadge(tab, deps);
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
    throw new Error(response?.error || "database list failed");
  }
  return response.result || [];
}

async function resetExistingOffscreenAuthState() {
  if (!globalThis.chrome?.runtime?.getContexts) return false;
  const url = chrome.runtime.getURL("offscreen/offscreen.html");
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [url]
  });
  if (contexts.length === 0) return false;
  const response = await chrome.runtime.sendMessage({ target: "offscreen", type: "reset-auth-client" });
  if (!response?.ok) {
    throw new Error(response?.error || "auth reset failed");
  }
  return true;
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
  if (result?.generationSkipped === true) {
    return {
      status: "source_saved",
      url: result?.url || "",
      title: result?.title || "",
      sourcePath: result?.sourcePath || "",
      message: "Evidence source saved.",
      updatedAt: new Date().toISOString()
    };
  }
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
  return message === "UNAUTHENTICATED" || /cycles|balance/i.test(String(message || ""));
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
    captureTabSource,
    findWebSource
  };
}

async function findWebSource(config, sourcePath) {
  await ensureOffscreen();
  const response = await chrome.runtime.sendMessage({
    target: "offscreen",
    type: "web-source-exists",
    sourcePath,
    config
  });
  if (!response?.ok) {
    throw new Error(response?.error || "source lookup failed");
  }
  return {
    exists: Boolean(response.result?.exists),
    path: response.result?.path || sourcePath,
    etag: response.result?.etag || null
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
  return buildWebEvidenceSource({ ...snapshot, url });
}

async function refreshCurrentTabBadge() {
  if (!globalThis.chrome?.tabs?.query) return { ok: false, reason: "tabs unavailable" };
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) return { ok: false, reason: "active tab unavailable" };
  return refreshTabBadge(tab);
}

async function refreshTabBadgeById(tabId) {
  if (!Number.isInteger(tabId) || !globalThis.chrome?.tabs?.get) return { ok: false, reason: "tab unavailable" };
  const tab = await chrome.tabs.get(tabId);
  return refreshTabBadge(tab);
}

async function refreshTabBadge(tab, deps = defaultActionDeps()) {
  const tabId = tab?.id;
  if (!Number.isInteger(tabId)) return { ok: false, reason: "tab id unavailable" };
  let url;
  try {
    url = normalizedHttpUrl(tab?.url || tab?.pendingUrl || "");
  } catch {
    await deps.setBadge("", "#5f6368", tabId);
    return { ok: true, state: "clear", reason: "unsupported url" };
  }
  try {
    const config = await deps.loadConfig();
    if (!config.databaseId) {
      await deps.setBadge("", "#5f6368", tabId);
      return { ok: true, state: "clear", reason: "config required" };
    }
    const sourcePath = await webSourcePathForUrl(url);
    const existingSource = await deps.findWebSource(config, sourcePath);
    if (!existingSource.exists) {
      await deps.setBadge("", "#5f6368", tabId);
      return { ok: true, state: "clear", reason: "source missing", sourcePath };
    }
    await deps.setBadge("IN", "#137333", tabId);
    return { ok: true, state: "source_exists", sourcePath, etag: existingSource.etag };
  } catch (error) {
    await deps.setBadge("", "#5f6368", tabId);
    return { ok: false, state: "clear", reason: error instanceof Error ? error.message : String(error) };
  }
}

async function createSettingsContextMenu() {
  if (!globalThis.chrome?.contextMenus) return;
  if (typeof chrome.contextMenus.remove === "function") {
    await Promise.all([CREATE_WIKI_MENU_ID, SAVE_EVIDENCE_MENU_ID, SETTINGS_MENU_ID].map((id) => chrome.contextMenus.remove(id).catch(() => {})));
  }
  chrome.contextMenus.create({
    id: CREATE_WIKI_MENU_ID,
    title: "Create Kinic wiki page",
    contexts: ["action"]
  });
  chrome.contextMenus.create({
    id: SAVE_EVIDENCE_MENU_ID,
    title: "Save evidence",
    contexts: ["action"]
  });
  chrome.contextMenus.create({
    id: SETTINGS_MENU_ID,
    title: "Settings",
    contexts: ["action"]
  });
}

export function createSettingsContextMenuForTest() {
  return createSettingsContextMenu();
}

async function handleContextMenuClick(info, tab) {
  if (info?.menuItemId === SETTINGS_MENU_ID) {
    chrome.runtime.openOptionsPage();
    return;
  }
  if (info?.menuItemId === CREATE_WIKI_MENU_ID) {
    await handleActionClick(tab);
    return;
  }
  if (info?.menuItemId === SAVE_EVIDENCE_MENU_ID) {
    await handleActionClick(tab, defaultActionDeps(), { queueGeneration: false });
  }
}

export function handleContextMenuClickForTest(info, tab) {
  return handleContextMenuClick(info, tab);
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
  if (estimatedEvidenceSourceSize(capture) > MAX_EVIDENCE_SOURCE_CHARS) {
    throw new Error(`capture evidence source must not exceed ${MAX_EVIDENCE_SOURCE_CHARS} characters`);
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

function estimatedEvidenceSourceSize(capture) {
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

async function setActionBadge(text, color, tabId = undefined) {
  if (!globalThis.chrome?.action) return;
  const details = Number.isInteger(tabId) ? { tabId } : {};
  await chrome.action.setBadgeText({ ...details, text });
  await chrome.action.setBadgeBackgroundColor({ ...details, color });
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
