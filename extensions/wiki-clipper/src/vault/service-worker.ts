// Where: extensions/vault-autofill/src/service-worker.ts
// What: MV3 background service worker coordinating the offscreen VaultEngine, popup UI, and content autofill.
// Why: Enforce sender/origin verification, badge updates, auto-lock alarms, and ephemeral save-login prompts.
import { matchesDomain, normalizeDomain } from "@kinic/vault-crypto/credential";
import {
  AUTOFILL_SCRIPT_FILE,
  syncAutofillRegistration,
  type AutofillChromeApi
} from "./autofill-registration.ts";
import { isWebOriginFillable } from "./form-detector.ts";
import {
  DEFAULT_EXTENSION_SETTINGS,
  type DecryptedItemView,
  type PendingSavePrompt,
  type VaultEngineState,
  type VaultExtensionSettings,
  type VaultItemSummary
} from "./types.ts";

const SETTINGS_STORAGE_KEY = "kinic-vault-settings-v1";
const PENDING_SAVES_SESSION_KEY = "kinic-vault-pending-saves-v1";
const AUTO_LOCK_ALARM = "kinic-vault-auto-lock";
const PENDING_SAVE_TTL_MS = 60 * 1000;
const MIN_AUTO_LOCK_MINUTES = 5;
const MAX_AUTO_LOCK_MINUTES = 30;
const BADGE_COLOR = "#ff2686";
const VAULT_SW_MESSAGE_TYPES = new Set([
  "get-inline-matches",
  "fill-inline-item",
  "login-submitted",
  "check-pending-save-banner",
  "save-banner-confirm",
  "save-banner-dismiss",
  "get-state",
  "list-vaults",
  "create-vault",
  "unlock-vault",
  "refresh-items",
  "lock-vault",
  "auth-signed-in",
  "auth-signed-out",
  "list-items",
  "read-item",
  "save-credential",
  "delete-item",
  "fill-active-tab",
  "fill-generated-password",
  "load-settings",
  "save-settings"
]);

type SenderLike = {
  id?: string;
  url?: string;
  frameId?: number;
  tab?: {
    id?: number;
    url?: string;
    title?: string;
  };
};

type OffscreenBridge = (message: Record<string, unknown>) => Promise<{
  ok: boolean;
  result?: unknown;
  error?: string;
}>;

type ServiceWorkerStorage = {
  getLocal: (key: string) => Promise<Record<string, unknown>>;
  setLocal: (items: Record<string, unknown>) => Promise<void>;
  getSession: (key: string) => Promise<Record<string, unknown>>;
  setSession: (items: Record<string, unknown>) => Promise<void>;
};

type ServiceWorkerDeps = {
  offscreenBridge: OffscreenBridge;
  hasExistingOffscreen: () => Promise<boolean>;
  storage: ServiceWorkerStorage;
  extensionId: () => string;
  setBadge: (tabId: number | undefined, text: string) => Promise<void>;
  sendToTab: (tabId: number, message: Record<string, unknown>) => Promise<unknown>;
  queryActiveTab: () => Promise<{ id?: number; url?: string; title?: string } | null>;
  scheduleAutoLock: (minutes: number) => Promise<void>;
  clearAutoLock: () => Promise<void>;
  now: () => number;
};

/* eslint-disable @typescript-eslint/no-explicit-any */
declare const chrome: any;
/* eslint-enable @typescript-eslint/no-explicit-any */

let ensureOffscreenInFlight: Promise<void> | null = null;

async function ensureOffscreenDocument(): Promise<void> {
  if (ensureOffscreenInFlight) return ensureOffscreenInFlight;
  ensureOffscreenInFlight = (async () => {
    const url = chrome.runtime.getURL("offscreen/offscreen.html");
    if (typeof chrome.runtime.getContexts === "function") {
      const contexts = await chrome.runtime.getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT"],
        documentUrls: [url]
      });
      if (contexts.length > 0) return;
    }
    try {
      await chrome.offscreen.createDocument({
        url: "offscreen/offscreen.html",
        reasons: [chrome.offscreen.Reason.DOM_PARSER],
        justification:
          "Run Kinic Vault Internet Identity AuthClient and IndexedDB key storage in a DOM context."
      });
    } catch (error) {
      // Handle race where another call already created the offscreen document.
      if (!String(error).includes("Only a single offscreen document")) {
        throw error;
      }
    }
  })().finally(() => {
    ensureOffscreenInFlight = null;
  });
  return ensureOffscreenInFlight;
}

async function defaultHasExistingOffscreen(): Promise<boolean> {
  if (typeof chrome === "undefined" || typeof chrome.runtime?.getContexts !== "function") {
    return false;
  }
  const url = chrome.runtime.getURL("offscreen/offscreen.html");
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [url]
  });
  return contexts.length > 0;
}

async function defaultOffscreenBridge(message: Record<string, unknown>) {
  await ensureOffscreenDocument();
  return chrome.runtime.sendMessage({
    ...message,
    target: "vault-offscreen"
  });
}

function createDefaultDeps(): ServiceWorkerDeps {
  return {
    offscreenBridge: defaultOffscreenBridge,
    hasExistingOffscreen: defaultHasExistingOffscreen,
    storage: {
      getLocal: (key) => chrome.storage.local.get(key),
      setLocal: (items) => chrome.storage.local.set(items),
      getSession: (key) => chrome.storage.session.get(key),
      setSession: (items) => chrome.storage.session.set(items)
    },
    extensionId: () => chrome.runtime.id,
    setBadge: async (tabId, text) => {
      if (typeof chrome === "undefined" || !chrome.action) return;
      const details = typeof tabId === "number" ? { tabId, text } : { text };
      await chrome.action.setBadgeText(details);
      if (text) {
        await chrome.action.setBadgeBackgroundColor(
          typeof tabId === "number"
            ? { tabId, color: BADGE_COLOR }
            : { color: BADGE_COLOR }
        );
      }
    },
    sendToTab: async (tabId, message) => {
      try {
        return await chrome.tabs.sendMessage(tabId, message, { frameId: 0 });
      } catch (error) {
        // Without website access the autofill script is not registered. A popup action grants
        // activeTab for this tab, so inject the script into the top frame once and retry.
        if (!String(error).includes("Receiving end does not exist")) throw error;
        await chrome.scripting.executeScript({
          target: { tabId, frameIds: [0] },
          files: [AUTOFILL_SCRIPT_FILE]
        });
        return chrome.tabs.sendMessage(tabId, message, { frameId: 0 });
      }
    },
    queryActiveTab: async () => {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      return tabs?.[0] ?? null;
    },
    scheduleAutoLock: async (minutes) => {
      if (typeof chrome === "undefined" || !chrome.alarms) return;
      await chrome.alarms.clear(AUTO_LOCK_ALARM);
      if (minutes > 0) {
        chrome.alarms.create(AUTO_LOCK_ALARM, { delayInMinutes: minutes });
      }
    },
    clearAutoLock: async () => {
      if (typeof chrome === "undefined" || !chrome.alarms) return;
      await chrome.alarms.clear(AUTO_LOCK_ALARM);
    },
    now: () => Date.now()
  };
}

let deps: ServiceWorkerDeps = createDefaultDeps();

export function setServiceWorkerDepsForTest(overrides: Partial<ServiceWorkerDeps>): void {
  deps = { ...createDefaultDeps(), ...overrides };
}

function isTrustedExtensionSender(sender: SenderLike | undefined): boolean {
  const extId = deps.extensionId();
  if (!sender?.id || sender.id !== extId) return false;
  if (!sender.tab) return true;
  const senderUrl = sender.url ?? sender.tab.url ?? "";
  return senderUrl.startsWith(`chrome-extension://${extId}/`);
}

function requireTopFrameWebSender(sender: SenderLike | undefined): {
  tabId: number;
  url: string;
  title: string;
} {
  if (!sender || sender.id !== deps.extensionId()) {
    throw new Error("UNAUTHORIZED_SENDER");
  }
  if (sender.frameId !== undefined && sender.frameId !== 0) {
    throw new Error("TOP_FRAME_REQUIRED");
  }
  const tabId = sender.tab?.id;
  const url = sender.tab?.url;
  if (typeof tabId !== "number" || typeof url !== "string" || !isWebOriginFillable(url)) {
    throw new Error("UNSUPPORTED_PAGE_ORIGIN");
  }
  return {
    tabId,
    url,
    title: typeof sender.tab?.title === "string" ? sender.tab.title : ""
  };
}

async function callOffscreen<T>(message: Record<string, unknown>): Promise<T> {
  const response = await deps.offscreenBridge(message);
  if (!response?.ok) {
    throw new Error(response?.error || "Vault engine request failed.");
  }
  return response.result as T;
}

async function callOffscreenIfRunning<T>(
  message: Record<string, unknown>
): Promise<T | null> {
  if (!(await deps.hasExistingOffscreen())) {
    return null;
  }
  return callOffscreen<T>(message);
}

function isSamePromptDomain(url: string, promptDomain: string): boolean {
  const currentDomain = normalizeDomain(url);
  if (!currentDomain || !promptDomain) return false;
  return (
    currentDomain === promptDomain ||
    currentDomain.endsWith(`.${promptDomain}`) ||
    promptDomain.endsWith(`.${currentDomain}`)
  );
}

export async function loadSettings(): Promise<VaultExtensionSettings> {
  const data = await deps.storage.getLocal(SETTINGS_STORAGE_KEY);
  const stored = (data?.[SETTINGS_STORAGE_KEY] ?? {}) as Partial<VaultExtensionSettings>;
  const autoLockMinutes =
    typeof stored.autoLockMinutes === "number" &&
    Number.isFinite(stored.autoLockMinutes) &&
    stored.autoLockMinutes >= MIN_AUTO_LOCK_MINUTES &&
    stored.autoLockMinutes <= MAX_AUTO_LOCK_MINUTES
      ? Math.round(stored.autoLockMinutes)
      : DEFAULT_EXTENSION_SETTINGS.autoLockMinutes;
  return {
    selectedVaultIdHex:
      typeof stored.selectedVaultIdHex === "string"
        ? stored.selectedVaultIdHex
        : DEFAULT_EXTENSION_SETTINGS.selectedVaultIdHex,
    autoLockMinutes,
    inlineTriggerEnabled:
      typeof stored.inlineTriggerEnabled === "boolean"
        ? stored.inlineTriggerEnabled
        : DEFAULT_EXTENSION_SETTINGS.inlineTriggerEnabled,
    saveBannerEnabled:
      typeof stored.saveBannerEnabled === "boolean"
        ? stored.saveBannerEnabled
        : DEFAULT_EXTENSION_SETTINGS.saveBannerEnabled
  };
}

export async function saveSettings(
  patch: Partial<VaultExtensionSettings>
): Promise<VaultExtensionSettings> {
  const current = await loadSettings();
  const next: VaultExtensionSettings = {
    selectedVaultIdHex:
      typeof patch.selectedVaultIdHex === "string"
        ? patch.selectedVaultIdHex
        : current.selectedVaultIdHex,
    autoLockMinutes:
      typeof patch.autoLockMinutes === "number" &&
      Number.isFinite(patch.autoLockMinutes) &&
      patch.autoLockMinutes >= MIN_AUTO_LOCK_MINUTES &&
      patch.autoLockMinutes <= MAX_AUTO_LOCK_MINUTES
        ? Math.round(patch.autoLockMinutes)
        : current.autoLockMinutes,
    inlineTriggerEnabled:
      typeof patch.inlineTriggerEnabled === "boolean"
        ? patch.inlineTriggerEnabled
        : current.inlineTriggerEnabled,
    saveBannerEnabled:
      typeof patch.saveBannerEnabled === "boolean"
        ? patch.saveBannerEnabled
        : current.saveBannerEnabled
  };
  await deps.storage.setLocal({ [SETTINGS_STORAGE_KEY]: next });
  return next;
}

async function readPendingSaves(): Promise<Record<string, PendingSavePrompt>> {
  const data = await deps.storage.getSession(PENDING_SAVES_SESSION_KEY);
  const raw = (data?.[PENDING_SAVES_SESSION_KEY] ?? {}) as Record<
    string,
    PendingSavePrompt
  >;
  const cutoff = deps.now() - PENDING_SAVE_TTL_MS;
  const active: Record<string, PendingSavePrompt> = {};
  for (const [key, prompt] of Object.entries(raw)) {
    if (prompt && prompt.createdAtMs >= cutoff) {
      active[key] = prompt;
    }
  }
  return active;
}

async function writePendingSaves(
  prompts: Record<string, PendingSavePrompt>
): Promise<void> {
  await deps.storage.setSession({ [PENDING_SAVES_SESSION_KEY]: prompts });
}

async function clearPendingSaveForTab(tabId: number): Promise<void> {
  const prompts = await readPendingSaves();
  if (String(tabId) in prompts) {
    delete prompts[String(tabId)];
    await writePendingSaves(prompts);
  }
}

async function clearAllPendingSaves(): Promise<void> {
  await writePendingSaves({});
}

export async function clearPendingSaveIfNavigatedAway(
  tabId: number,
  nextUrl?: string
): Promise<void> {
  const prompts = await readPendingSaves();
  const prompt = prompts[String(tabId)];
  if (!prompt) return;
  if (!nextUrl || !isSamePromptDomain(nextUrl, prompt.domain)) {
    delete prompts[String(tabId)];
    await writePendingSaves(prompts);
  }
}

export async function refreshTabBadge(tab?: {
  id?: number;
  url?: string;
} | null): Promise<void> {
  const target = tab ?? (await deps.queryActiveTab());
  if (!target?.id) return;
  if (!target.url || !isWebOriginFillable(target.url)) {
    await deps.setBadge(target.id, "");
    return;
  }
  try {
    const result = await callOffscreenIfRunning<{
      unlocked: boolean;
      matches: VaultItemSummary[];
    }>({
      type: "get-matches-for-url",
      url: target.url
    });
    const count = result?.unlocked ? result.matches.length : 0;
    await deps.setBadge(target.id, count > 0 ? String(Math.min(count, 99)) : "");
  } catch {
    await deps.setBadge(target.id, "");
  }
}

async function bumpAutoLockIfUnlocked(): Promise<void> {
  const settings = await loadSettings();
  await deps.scheduleAutoLock(settings.autoLockMinutes);
}

export async function handleAutoLockAlarm(): Promise<void> {
  await clearAllPendingSaves();
  try {
    await callOffscreenIfRunning({ type: "lock-vault" });
  } catch {
    // Offscreen document may already be closed.
  }
  const activeTab = await deps.queryActiveTab();
  if (activeTab?.id) {
    await deps.setBadge(activeTab.id, "");
  }
}

export async function handleMessage(
  message: Record<string, unknown>,
  sender?: SenderLike
): Promise<{ ok: true; result: unknown }> {
  const type = String(message?.type ?? "");

  // --- Content script endpoints (strictly scoped to sender.tab.url & top frame) ---
  if (type === "get-inline-matches") {
    const tab = requireTopFrameWebSender(sender);
    const settings = await loadSettings();
    if (!settings.inlineTriggerEnabled) {
      return { ok: true, result: { enabled: false, unlocked: false, matches: [] } };
    }
    const result = await callOffscreenIfRunning<{
      unlocked: boolean;
      domain: string | null;
      matches: VaultItemSummary[];
    }>({
      type: "get-matches-for-url",
      url: tab.url
    });
    if (!result) {
      return {
        ok: true,
        result: {
          enabled: true,
          unlocked: false,
          domain: normalizeDomain(tab.url),
          matches: []
        }
      };
    }
    return {
      ok: true,
      result: {
        enabled: true,
        unlocked: result.unlocked,
        domain: result.domain,
        matches: result.matches
      }
    };
  }

  if (type === "fill-inline-item") {
    const tab = requireTopFrameWebSender(sender);
    const objectIdHex =
      typeof message.objectIdHex === "string" ? message.objectIdHex : "";
    if (!objectIdHex) throw new Error("Item identifier is required.");

    // Re-verify the requested credential actually matches sender.tab.url.
    const lookup = await callOffscreen<{
      unlocked: boolean;
      matches: VaultItemSummary[];
    }>({
      type: "get-matches-for-url",
      url: tab.url
    });
    if (
      !lookup.unlocked ||
      !lookup.matches.some((item) => item.objectIdHex === objectIdHex)
    ) {
      throw new Error("CREDENTIAL_DOMAIN_MISMATCH");
    }

    const decrypted = await callOffscreen<DecryptedItemView>({
      type: "read-item",
      objectIdHex
    });
    if (decrypted.summary.kind !== "credential" || !matchesDomain([decrypted.url, ...decrypted.urls], tab.url)) {
      throw new Error("CREDENTIAL_DOMAIN_MISMATCH");
    }
    await bumpAutoLockIfUnlocked();
    return {
      ok: true,
      result: {
        username: decrypted.username,
        password: decrypted.password,
        totp: decrypted.totp?.code ?? ""
      }
    };
  }

  if (type === "login-submitted") {
    const tab = requireTopFrameWebSender(sender);
    const settings = await loadSettings();
    if (!settings.saveBannerEnabled) {
      return { ok: true, result: { prompt: null } };
    }
    const username =
      typeof message.username === "string" ? message.username.trim() : "";
    const password =
      typeof message.password === "string" ? message.password : "";
    if (!password) {
      return { ok: true, result: { prompt: null } };
    }

    const evaluation = await callOffscreenIfRunning<
      | { action: "ignore" }
      | {
          action: "create" | "update";
          existingObjectIdHex?: string;
          domain: string;
          title: string;
        }
    >({
      type: "evaluate-submitted-login",
      url: tab.url,
      username,
      password,
      pageTitle:
        typeof message.pageTitle === "string" ? message.pageTitle : tab.title
    });

    if (!evaluation || evaluation.action === "ignore") {
      return { ok: true, result: { prompt: null } };
    }

    const prompt: PendingSavePrompt = {
      id: crypto.randomUUID(),
      tabId: tab.tabId,
      mode: evaluation.action,
      existingObjectIdHex: evaluation.existingObjectIdHex,
      domain: evaluation.domain,
      url: tab.url,
      title: evaluation.title,
      username,
      password,
      createdAtMs: deps.now()
    };
    const prompts = await readPendingSaves();
    prompts[String(tab.tabId)] = prompt;
    await writePendingSaves(prompts);

    return {
      ok: true,
      result: {
        prompt: {
          id: prompt.id,
          mode: prompt.mode,
          domain: prompt.domain,
          title: prompt.title,
          username: prompt.username
        }
      }
    };
  }

  if (type === "check-pending-save-banner") {
    const tab = requireTopFrameWebSender(sender);
    const prompts = await readPendingSaves();
    const prompt = prompts[String(tab.tabId)];
    if (!prompt) {
      return { ok: true, result: { prompt: null } };
    }
    if (!isSamePromptDomain(tab.url, prompt.domain)) {
      await clearPendingSaveForTab(tab.tabId);
      return { ok: true, result: { prompt: null } };
    }
    return {
      ok: true,
      result: {
        prompt: {
          id: prompt.id,
          mode: prompt.mode,
          domain: prompt.domain,
          title: prompt.title,
          username: prompt.username
        }
      }
    };
  }

  if (type === "save-banner-confirm") {
    const tab = requireTopFrameWebSender(sender);
    const promptId = typeof message.promptId === "string" ? message.promptId : "";
    const prompts = await readPendingSaves();
    const prompt = prompts[String(tab.tabId)];
    if (!prompt || prompt.id !== promptId) {
      throw new Error("SAVE_PROMPT_EXPIRED");
    }
    if (!isSamePromptDomain(tab.url, prompt.domain)) {
      await clearPendingSaveForTab(tab.tabId);
      throw new Error("SAVE_PROMPT_DOMAIN_MISMATCH");
    }

    const customTitle =
      typeof message.title === "string" && message.title.trim()
        ? message.title.trim()
        : prompt.title;
    const customUsername =
      typeof message.username === "string"
        ? message.username.trim()
        : prompt.username;

    let existingDetails: DecryptedItemView | null = null;
    if (prompt.mode === "update" && prompt.existingObjectIdHex) {
      existingDetails = await callOffscreen<DecryptedItemView>({
        type: "read-item",
        objectIdHex: prompt.existingObjectIdHex
      });
    }

    const saved = await callOffscreen<VaultItemSummary>({
      type: "save-credential",
      input: {
        objectIdHex: prompt.existingObjectIdHex,
        title: customTitle,
        username: customUsername,
        password: prompt.password,
        url: existingDetails?.url || prompt.url,
        urls: existingDetails?.urls?.length ? existingDetails.urls : [prompt.url],
        totp: existingDetails?.totpSecret ?? "",
        notes: existingDetails?.notes ?? "",
        customFields: existingDetails?.customFields ?? [],
        favorite: existingDetails?.favorite ?? false,
        tags: existingDetails?.tags ?? []
      }
    });
    await clearPendingSaveForTab(tab.tabId);
    await bumpAutoLockIfUnlocked();
    await refreshTabBadge({ id: tab.tabId, url: tab.url });
    return { ok: true, result: saved };
  }

  if (type === "save-banner-dismiss") {
    const tab = requireTopFrameWebSender(sender);
    await clearPendingSaveForTab(tab.tabId);
    return { ok: true, result: { dismissed: true } };
  }

  // --- Trusted extension UI endpoints (popup only) ---
  if (!isTrustedExtensionSender(sender)) {
    throw new Error("UNAUTHORIZED_SENDER");
  }

  switch (type) {
    case "get-state": {
      const state = await callOffscreen<VaultEngineState>({ type: "get-state" });
      return { ok: true, result: state };
    }
    case "list-vaults": {
      const vaults = await callOffscreen({ type: "list-vaults" });
      return { ok: true, result: vaults };
    }
    case "create-vault": {
      const created = await callOffscreen<{ idHex: string }>({ type: "create-vault" });
      await saveSettings({ selectedVaultIdHex: created.idHex });
      await bumpAutoLockIfUnlocked();
      await refreshTabBadge();
      return { ok: true, result: created };
    }
    case "unlock-vault": {
      const settings = await loadSettings();
      const requested =
        typeof message.vaultIdHex === "string" && message.vaultIdHex
          ? message.vaultIdHex
          : settings.selectedVaultIdHex || undefined;
      const state = await callOffscreen<VaultEngineState>({
        type: "unlock-vault",
        vaultIdHex: requested
      });
      if (state.activeVaultIdHex) {
        await saveSettings({ selectedVaultIdHex: state.activeVaultIdHex });
      }
      await bumpAutoLockIfUnlocked();
      await refreshTabBadge();
      return { ok: true, result: state };
    }
    case "refresh-items": {
      const items = await callOffscreen({ type: "refresh-items" });
      await bumpAutoLockIfUnlocked();
      await refreshTabBadge();
      return { ok: true, result: items };
    }
    case "lock-vault": {
      await clearAllPendingSaves();
      await deps.clearAutoLock();
      const state = await callOffscreen<VaultEngineState>({ type: "lock-vault" });
      const activeTab = await deps.queryActiveTab();
      if (activeTab?.id) {
        await deps.setBadge(activeTab.id, "");
      }
      return { ok: true, result: state };
    }
    case "auth-signed-in": {
      await clearAllPendingSaves();
      const result = await callOffscreen({ type: "reload-auth-session" });
      return { ok: true, result };
    }
    case "auth-signed-out": {
      await clearAllPendingSaves();
      await deps.clearAutoLock();
      const result = await callOffscreen({ type: "forget-and-reset" });
      const activeTab = await deps.queryActiveTab();
      if (activeTab?.id) {
        await deps.setBadge(activeTab.id, "");
      }
      return { ok: true, result };
    }
    case "list-items": {
      const result = await callOffscreen({
        type: "list-items",
        url: typeof message.url === "string" ? message.url : undefined,
        query: typeof message.query === "string" ? message.query : undefined,
        filter: message.filter
      });
      await bumpAutoLockIfUnlocked();
      return { ok: true, result };
    }
    case "read-item": {
      const result = await callOffscreen({
        type: "read-item",
        objectIdHex: message.objectIdHex
      });
      await bumpAutoLockIfUnlocked();
      return { ok: true, result };
    }
    case "save-credential": {
      const saved = await callOffscreen({
        type: "save-credential",
        input: message.input
      });
      await bumpAutoLockIfUnlocked();
      await refreshTabBadge();
      return { ok: true, result: saved };
    }
    case "delete-item": {
      const deleted = await callOffscreen({
        type: "delete-item",
        objectIdHex: message.objectIdHex
      });
      await bumpAutoLockIfUnlocked();
      await refreshTabBadge();
      return { ok: true, result: deleted };
    }
    case "fill-active-tab": {
      const tab = await deps.queryActiveTab();
      if (!tab?.id || !tab.url || !isWebOriginFillable(tab.url)) {
        throw new Error("This page does not support autofill.");
      }
      const decrypted = await callOffscreen<DecryptedItemView>({
        type: "read-item",
        objectIdHex: message.objectIdHex
      });
      const expectedOrigin = new URL(tab.url).origin;
      const allowCrossDomain = message.confirmedOrigin === expectedOrigin;
      if (
        decrypted.summary.kind !== "credential" ||
        (!allowCrossDomain && !matchesDomain([decrypted.url, ...decrypted.urls], tab.url))
      ) {
        throw new Error("CROSS_DOMAIN_CONFIRM_REQUIRED");
      }
      const response = (await deps.sendToTab(tab.id, {
        type: "fill-credentials",
        expectedOrigin,
        username: decrypted.username,
        password: decrypted.password,
        totp: decrypted.totp?.code ?? ""
      })) as
        | {
            ok?: boolean;
            error?: string;
            result?: {
              filledUsername?: boolean;
              filledPassword?: boolean;
              filledTotp?: boolean;
            };
          }
        | undefined;
      if (response?.error === "ORIGIN_MISMATCH") {
        throw new Error("Page origin changed before autofill completed. Try again.");
      }
      const filledAny = Boolean(
        response?.ok &&
          (response.result?.filledUsername ||
            response.result?.filledPassword ||
            response.result?.filledTotp)
      );
      if (!filledAny) {
        throw new Error("No login form found on this page.");
      }
      await bumpAutoLockIfUnlocked();
      return {
        ok: true,
        result: {
          filled: true,
          totp: decrypted.totp
        }
      };
    }
    case "fill-generated-password": {
      const tab = await deps.queryActiveTab();
      if (!tab?.id || !tab.url || !isWebOriginFillable(tab.url)) {
        throw new Error("This page does not support password fill.");
      }
      const password =
        typeof message.password === "string" ? message.password : "";
      if (!password) throw new Error("Password is required.");
      const expectedOrigin = new URL(tab.url).origin;
      const response = (await deps.sendToTab(tab.id, {
        type: "fill-generated-password",
        expectedOrigin,
        password
      })) as { ok?: boolean; error?: string; result?: { filledCount?: number } } | undefined;
      if (response?.error === "ORIGIN_MISMATCH") {
        throw new Error("Page origin changed before password fill completed. Try again.");
      }
      if (!response?.ok || !(response.result?.filledCount && response.result.filledCount > 0)) {
        throw new Error("No password field found on this page.");
      }
      return { ok: true, result: response.result };
    }
    case "load-settings": {
      return { ok: true, result: await loadSettings() };
    }
    case "save-settings": {
      const next = await saveSettings(
        (message.settings ?? {}) as Partial<VaultExtensionSettings>
      );
      const state = await callOffscreenIfRunning<VaultEngineState>({
        type: "get-state"
      });
      if (state?.isUnlocked) {
        await deps.scheduleAutoLock(next.autoLockMinutes);
      }
      return { ok: true, result: next };
    }
    default:
      throw new Error(`Unsupported service worker message: ${type}`);
  }
}

if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener(
    (
      message: Record<string, unknown>,
      sender: SenderLike,
      sendResponse: (response: unknown) => void
    ) => {
      if (message?.target === "offscreen" || message?.target === "vault-offscreen") return false;
      if (typeof message?.type !== "string" || !VAULT_SW_MESSAGE_TYPES.has(message.type)) return false;
      handleMessage(message, sender).then(sendResponse, (error) => {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        });
      });
      return true;
    }
  );
}

if (typeof chrome !== "undefined" && chrome.tabs?.onActivated) {
  chrome.tabs.onActivated.addListener(async (info: { tabId: number }) => {
    try {
      const tab = await chrome.tabs.get(info.tabId);
      await refreshTabBadge(tab);
    } catch {
      // Ignore closed tabs.
    }
  });
}

if (typeof chrome !== "undefined" && chrome.tabs?.onUpdated) {
  chrome.tabs.onUpdated.addListener(
    async (
      tabId: number,
      changeInfo: { status?: string; url?: string },
      tab: { id?: number; url?: string }
    ) => {
      if (changeInfo.url) {
        await clearPendingSaveIfNavigatedAway(tabId, changeInfo.url);
      }
      if (changeInfo.url || changeInfo.status === "complete") {
        await refreshTabBadge({ id: tabId, url: changeInfo.url ?? tab?.url });
      }
    }
  );
}

if (typeof chrome !== "undefined" && chrome.tabs?.onRemoved) {
  chrome.tabs.onRemoved.addListener((tabId: number) => {
    void clearPendingSaveForTab(tabId);
  });
}

if (typeof chrome !== "undefined" && chrome.alarms?.onAlarm) {
  chrome.alarms.onAlarm.addListener((alarm: { name?: string }) => {
    if (alarm?.name === AUTO_LOCK_ALARM) {
      void handleAutoLockAlarm();
    }
  });
}

if (typeof chrome !== "undefined" && chrome.permissions && chrome.scripting?.registerContentScripts) {
  const api = chrome as unknown as AutofillChromeApi;
  const sync = () => {
    syncAutofillRegistration(api).catch((error) => {
      console.warn("failed to sync Vault autofill registration", error);
    });
  };
  // Runs on every service worker start, which covers install, update and browser startup.
  sync();
  chrome.permissions.onAdded?.addListener(sync);
  chrome.permissions.onRemoved?.addListener(sync);
}
