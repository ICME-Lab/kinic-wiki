// Where: extensions/vault-autofill/popup/popup.ts
// What: Interactive popup UI for Kinic Vault Chrome extension (auth, autofill, live TOTP, CRUD, generator, settings).
// Why: Run Internet Identity login directly from user click activation and keep secrets out of persistent storage.
import {
  matchesDomain,
  normalizeDomain,
  parseTagsInput
} from "@kinic/vault-crypto/credential";
import {
  estimatePassphraseStrength,
  estimatePasswordStrength,
  generatePassphrase,
  generatePassword
} from "@kinic/vault-crypto/password";
import {
  formatTotpCode,
  generateTotp,
  parseTotpInput
} from "@kinic/vault-crypto/totp";
import { logoutInternetIdentity } from "../src/vault/auth-client.ts";
import { isWebOriginFillable } from "../src/vault/form-detector.ts";
import { RUNTIME_CONFIG } from "../src/vault/runtime-config.ts";
import { AUTOFILL_ORIGINS } from "../src/vault/autofill-registration.ts";
import {
  DEFAULT_EXTENSION_SETTINGS,
  type DecryptedItemView,
  type ItemCategoryFilter,
  type VaultEngineState,
  type VaultExtensionSettings,
  type VaultItemSummary
} from "../src/vault/types.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
declare const chrome: any;
/* eslint-enable @typescript-eslint/no-explicit-any */

type PopupTab = "vault" | "generator" | "settings";

let state: VaultEngineState | null = null;
let settings: VaultExtensionSettings = { ...DEFAULT_EXTENSION_SETTINGS };
let activeTabUrl = "";
let activeTabTitle = "";
let currentTab: PopupTab = "vault";
let currentFilter: ItemCategoryFilter = "all";
let searchQuery = "";
let detailItem: DecryptedItemView | null = null;
let editingItem: DecryptedItemView | null = null;
let detailPasswordVisible = false;
let totpTimer: number | null = null;
let toastTimer: number | null = null;
let deleteConfirmTimer: number | null = null;
let deleteConfirmArmed = false;
let listRequestSeq = 0;
let generatorMode: "password" | "passphrase" = "password";

const el = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
};

async function sendSw<T>(message: Record<string, unknown>): Promise<T> {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) {
    throw new Error(response?.error || "Request failed.");
  }
  return response.result as T;
}

function showToast(message: string): void {
  const toast = el("toast");
  toast.textContent = message;
  toast.hidden = false;
  if (toastTimer !== null) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toast.hidden = true;
  }, 2200);
}

async function copyText(text: string, label: string): Promise<void> {
  await navigator.clipboard.writeText(text);
  showToast(`${label} copied`);
}

function stopTotpTimer(): void {
  if (totpTimer !== null) {
    window.clearInterval(totpTimer);
    totpTimer = null;
  }
}

function setRootView(mode: "loading" | "signed-out" | "locked" | "unlocked"): void {
  el("view-loading").hidden = mode !== "loading";
  el("view-signed-out").hidden = mode !== "signed-out";
  el("view-locked").hidden = mode !== "locked";
  el("view-unlocked").hidden = mode !== "unlocked";
  const lockBtn = document.getElementById("btn-lock");
  if (lockBtn) lockBtn.hidden = mode !== "unlocked";
}

function resetDeleteConfirmation(): void {
  deleteConfirmArmed = false;
  if (deleteConfirmTimer !== null) {
    window.clearTimeout(deleteConfirmTimer);
    deleteConfirmTimer = null;
  }
  const btn = document.getElementById("btn-detail-delete");
  if (btn) btn.textContent = "Delete";
}

function setVaultSubScreen(screen: "list" | "detail" | "editor"): void {
  el("vault-list-screen").hidden = screen !== "list";
  el("vault-detail-screen").hidden = screen !== "detail";
  el("vault-editor-screen").hidden = screen !== "editor";
  if (screen !== "detail") {
    stopTotpTimer();
    resetDeleteConfirmation();
  }
}

function switchMainTab(tab: PopupTab): void {
  currentTab = tab;
  el("panel-vault").hidden = tab !== "vault";
  el("panel-generator").hidden = tab !== "generator";
  el("panel-settings").hidden = tab !== "settings";
  for (const btn of document.querySelectorAll<HTMLButtonElement>(".tab-btn")) {
    btn.classList.toggle("active", btn.dataset.tab === tab);
  }
  if (tab !== "vault") {
    stopTotpTimer();
  }
  if (tab === "generator") {
    refreshGenerator();
  }
}

function renderVaultSelectors(): void {
  const vaults = state?.vaults ?? [];
  const selectedId =
    state?.activeVaultIdHex ||
    settings.selectedVaultIdHex ||
    vaults[0]?.idHex ||
    "";

  const populate = (select: HTMLSelectElement) => {
    select.innerHTML = "";
    for (const v of vaults) {
      const opt = document.createElement("option");
      opt.value = v.idHex;
      opt.textContent = v.isOwned ? v.name : `${v.name} (${v.role})`;
      opt.selected = v.idHex === selectedId;
      select.appendChild(opt);
    }
  };

  populate(el<HTMLSelectElement>("locked-vault-select"));
  populate(el<HTMLSelectElement>("settings-vault-select"));

  el("locked-vault-picker").hidden = vaults.length <= 1;
  el("btn-unlock").hidden = vaults.length === 0;
  el("btn-create-first-vault").hidden = vaults.length > 0;
}

// Website access is an optional permission; the autofill script runs only after it is granted.
let websiteAccess = false;
const AUTOFILL_PERMISSIONS = { origins: [...AUTOFILL_ORIGINS] };

async function refreshWebsiteAccess(): Promise<void> {
  try {
    websiteAccess = await chrome.permissions.contains({ origins: ["https://*/*"] });
  } catch {
    websiteAccess = false;
  }
}

function renderWebsiteAccess(): void {
  el("settings-autofill-status").textContent = websiteAccess ? "On" : "Off";
  el("settings-autofill-hint").hidden = websiteAccess;
  el("btn-settings-autofill").textContent = websiteAccess
    ? "Turn off website access"
    : "Allow website access";
  el<HTMLInputElement>("settings-inline").disabled = !websiteAccess;
  el<HTMLInputElement>("settings-save-banner").disabled = !websiteAccess;
}

function renderSettingsControls(): void {
  el<HTMLSelectElement>("settings-autolock").value = String(
    settings.autoLockMinutes
  );
  el<HTMLInputElement>("settings-inline").checked = settings.inlineTriggerEnabled;
  el<HTMLInputElement>("settings-save-banner").checked =
    settings.saveBannerEnabled;
  renderWebsiteAccess();
  renderVaultSelectors();
}

function createItemCard(
  item: VaultItemSummary,
  suggested: boolean
): HTMLElement {
  const card = document.createElement("div");
  card.className = suggested ? "item-card suggested" : "item-card";

  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.textContent = (item.title.trim()[0] || "K").toUpperCase();

  const meta = document.createElement("div");
  meta.className = "item-meta";

  const titleRow = document.createElement("div");
  titleRow.className = "item-title-row";
  const titleEl = document.createElement("span");
  titleEl.className = "item-title";
  titleEl.textContent = item.title;
  titleRow.appendChild(titleEl);

  if (item.favorite) {
    const star = document.createElement("span");
    star.textContent = "★";
    star.style.color = "#f59e0b";
    titleRow.appendChild(star);
  }
  if (item.hasTotp) {
    const badge = document.createElement("span");
    badge.className = "mini-badge";
    badge.textContent = "2FA";
    titleRow.appendChild(badge);
  }

  const sub = document.createElement("div");
  sub.className = "item-sub";
  sub.textContent =
    item.username ||
    item.domains[0] ||
    (item.kind === "note" ? "Secure note" : "Item");

  meta.append(titleRow, sub);

  const actions = document.createElement("div");
  actions.className = "item-actions";

  if (item.kind === "credential") {
    if (suggested && isWebOriginFillable(activeTabUrl)) {
      const fillBtn = document.createElement("button");
      fillBtn.className = "chip-btn primary";
      fillBtn.type = "button";
      fillBtn.textContent = "Fill";
      fillBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        void handleFillItem(item.objectIdHex);
      });
      actions.appendChild(fillBtn);
    }

    if (item.hasTotp) {
      const totpBtn = document.createElement("button");
      totpBtn.className = "chip-btn";
      totpBtn.type = "button";
      totpBtn.textContent = "2FA";
      totpBtn.title = "Copy 2FA code";
      totpBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        void handleQuickCopyTotp(item.objectIdHex);
      });
      actions.appendChild(totpBtn);
    }

    const pwBtn = document.createElement("button");
    pwBtn.className = "chip-btn";
    pwBtn.type = "button";
    pwBtn.textContent = "Pass";
    pwBtn.title = "Copy password";
    pwBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      void handleQuickCopyPassword(item.objectIdHex);
    });
    actions.appendChild(pwBtn);
  }

  card.append(avatar, meta, actions);
  card.addEventListener("click", () => {
    void openDetail(item.objectIdHex);
  });
  return card;
}

async function refreshItemList(): Promise<void> {
  const seq = ++listRequestSeq;
  const result = await sendSw<{
    matches: VaultItemSummary[];
    items: VaultItemSummary[];
    domain: string | null;
  }>({
    type: "list-items",
    url: activeTabUrl,
    query: searchQuery,
    filter: currentFilter
  });
  if (seq !== listRequestSeq) return;

  const showMatches =
    !searchQuery.trim() &&
    (currentFilter === "all" || currentFilter === "logins") &&
    result.matches.length > 0 &&
    Boolean(result.domain);

  el("matches-section").hidden = !showMatches;
  const matchesList = el("matches-list");
  matchesList.innerHTML = "";
  if (showMatches && result.domain) {
    el("matches-domain").textContent = result.domain;
    for (const item of result.matches) {
      matchesList.appendChild(createItemCard(item, true));
    }
  }

  const itemsList = el("items-list");
  itemsList.innerHTML = "";
  el("items-count").textContent = String(result.items.length);
  el("items-empty").hidden = result.items.length > 0;
  for (const item of result.items) {
    itemsList.appendChild(createItemCard(item, false));
  }
}

async function handleFillItem(
  objectIdHex: string,
  confirmedOrigin?: string
): Promise<void> {
  try {
    const result = await sendSw<{
      filled: boolean;
      totp: { code: string } | null;
    }>({
      type: "fill-active-tab",
      objectIdHex,
      confirmedOrigin
    });
    if (result.totp?.code) {
      await navigator.clipboard.writeText(result.totp.code).catch(() => {});
      showToast("Login filled • 2FA code copied");
    } else {
      showToast("Login filled");
    }
    window.setTimeout(() => window.close(), 650);
  } catch (error) {
    showToast(error instanceof Error ? error.message : "Autofill failed");
  }
}

async function handleQuickCopyPassword(objectIdHex: string): Promise<void> {
  try {
    const item = await sendSw<DecryptedItemView>({
      type: "read-item",
      objectIdHex
    });
    if (!item.password) {
      showToast("No password stored");
      return;
    }
    await copyText(item.password, "Password");
  } catch (error) {
    showToast(error instanceof Error ? error.message : "Could not read item");
  }
}

async function handleQuickCopyTotp(objectIdHex: string): Promise<void> {
  try {
    const item = await sendSw<DecryptedItemView>({
      type: "read-item",
      objectIdHex
    });
    if (!item.totp?.code) {
      showToast("No 2FA code available");
      return;
    }
    await copyText(item.totp.code, "2FA code");
  } catch (error) {
    showToast(error instanceof Error ? error.message : "Could not read 2FA code");
  }
}

async function openDetail(objectIdHex: string): Promise<void> {
  try {
    detailItem = await sendSw<DecryptedItemView>({
      type: "read-item",
      objectIdHex
    });
    detailPasswordVisible = false;
    renderDetail();
    setVaultSubScreen("detail");
  } catch (error) {
    showToast(error instanceof Error ? error.message : "Failed to open item");
  }
}

function renderDetail(): void {
  stopTotpTimer();
  resetDeleteConfirmation();
  const item = detailItem;
  if (!item) return;

  const canWrite = Boolean(state?.activeVaultCanWrite);
  el("btn-detail-edit").hidden = !canWrite || item.summary.kind !== "credential";
  el("btn-detail-delete").hidden = !canWrite;

  const container = el("detail-content");
  container.innerHTML = "";

  const headerCard = document.createElement("div");
  headerCard.className = "detail-card";

  const hdr = document.createElement("div");
  hdr.className = "detail-header";
  const av = document.createElement("div");
  av.className = "avatar";
  av.textContent = (item.label[0] || "K").toUpperCase();
  const titleWrap = document.createElement("div");
  const title = document.createElement("div");
  title.className = "detail-title";
  title.textContent = item.label || item.summary.title;
  const sub = document.createElement("div");
  sub.className = "item-sub";
  sub.textContent = item.urls[0] || item.summary.domains[0] || item.summary.kind;
  titleWrap.append(title, sub);
  hdr.append(av, titleWrap);
  headerCard.appendChild(hdr);

  if (item.summary.kind === "credential" && isWebOriginFillable(activeTabUrl)) {
    const activeDomain = normalizeDomain(activeTabUrl);
    const sameSite = matchesDomain([item.url, ...item.urls], activeTabUrl);
    const targetOrigin = new URL(activeTabUrl).origin;
    const fillBtn = document.createElement("button");
    fillBtn.className = sameSite ? "btn primary full" : "btn secondary full";
    fillBtn.type = "button";
    let crossDomainArmed = false;
    fillBtn.textContent = sameSite
      ? "Fill on this page"
      : `Fill on different site (${activeDomain ?? "current tab"})…`;
    fillBtn.addEventListener("click", () => {
      if (!sameSite && !crossDomainArmed) {
        crossDomainArmed = true;
        fillBtn.className = "btn danger full";
        fillBtn.textContent = `Confirm: fill into ${activeDomain ?? "this site"}`;
        return;
      }
      void handleFillItem(item.summary.objectIdHex, sameSite ? undefined : targetOrigin);
    });
    headerCard.appendChild(fillBtn);
  }
  container.appendChild(headerCard);

  const fieldsCard = document.createElement("div");
  fieldsCard.className = "detail-card";

  const addField = (
    labelText: string,
    valueText: string,
    actions: HTMLElement[] = [],
    mono = false
  ) => {
    const field = document.createElement("div");
    field.className = "detail-field";
    const lbl = document.createElement("span");
    lbl.className = "detail-field-label";
    lbl.textContent = labelText;
    const row = document.createElement("div");
    row.className = "detail-field-row";
    const val = document.createElement("span");
    val.className = mono ? "detail-value mono" : "detail-value";
    val.textContent = valueText;
    row.appendChild(val);
    if (actions.length > 0) {
      const actWrap = document.createElement("div");
      actWrap.className = "item-actions";
      actWrap.append(...actions);
      row.appendChild(actWrap);
    }
    field.append(lbl, row);
    fieldsCard.appendChild(field);
  };

  if (item.username) {
    const copyBtn = document.createElement("button");
    copyBtn.className = "chip-btn";
    copyBtn.type = "button";
    copyBtn.textContent = "Copy";
    copyBtn.addEventListener("click", () => void copyText(item.username, "Username"));
    addField("Username", item.username, [copyBtn]);
  }

  if (item.password) {
    const toggleBtn = document.createElement("button");
    toggleBtn.className = "chip-btn";
    toggleBtn.type = "button";
    toggleBtn.textContent = detailPasswordVisible ? "Hide" : "Show";
    toggleBtn.addEventListener("click", () => {
      detailPasswordVisible = !detailPasswordVisible;
      renderDetail();
    });
    const copyBtn = document.createElement("button");
    copyBtn.className = "chip-btn";
    copyBtn.type = "button";
    copyBtn.textContent = "Copy";
    copyBtn.addEventListener("click", () => void copyText(item.password, "Password"));
    addField(
      "Password",
      detailPasswordVisible ? item.password : "•".repeat(Math.min(16, Math.max(8, item.password.length))),
      [toggleBtn, copyBtn],
      detailPasswordVisible
    );
  }

  if (item.totpSecret) {
    const field = document.createElement("div");
    field.className = "detail-field";
    const lbl = document.createElement("span");
    lbl.className = "detail-field-label";
    lbl.textContent = "One-Time Password (2FA)";
    const row = document.createElement("div");
    row.className = "detail-field-row";
    const codeWrap = document.createElement("div");
    const codeEl = document.createElement("div");
    codeEl.className = "totp-code mono";
    const metaEl = document.createElement("div");
    metaEl.className = "totp-meta";
    codeWrap.append(codeEl, metaEl);

    let latestCode = item.totp?.code ?? "";
    const copyBtn = document.createElement("button");
    copyBtn.className = "chip-btn primary";
    copyBtn.type = "button";
    copyBtn.textContent = "Copy";
    copyBtn.addEventListener("click", () => {
      if (latestCode) void copyText(latestCode, "2FA code");
    });
    row.append(codeWrap, copyBtn);
    field.append(lbl, row);
    fieldsCard.appendChild(field);

    const updateTotp = async () => {
      try {
        const res = await generateTotp(item.totpSecret, Date.now());
        latestCode = res.code;
        codeEl.textContent = formatTotpCode(res.code);
        metaEl.textContent = `Refreshes in ${res.remainingSeconds}s`;
      } catch {
        codeEl.textContent = "Invalid secret";
        metaEl.textContent = "";
      }
    };
    void updateTotp();
    totpTimer = window.setInterval(() => void updateTotp(), 1000);
  }

  if (item.urls.length > 0) {
    addField("Websites", item.urls.join("\n"));
  }
  if (item.tags.length > 0) {
    addField("Tags", item.tags.join(", "));
  }
  if (item.notes) {
    addField("Notes", item.notes);
  }
  for (const custom of item.customFields) {
    const copyBtn = document.createElement("button");
    copyBtn.className = "chip-btn";
    copyBtn.type = "button";
    copyBtn.textContent = "Copy";
    copyBtn.addEventListener("click", () =>
      void copyText(custom.value, custom.label || "Field")
    );
    addField(
      custom.label || "Field",
      custom.hidden ? "••••••••" : custom.value,
      [copyBtn]
    );
  }

  container.appendChild(fieldsCard);
}

function openEditor(existing: DecryptedItemView | null): void {
  editingItem = existing;
  el("editor-heading").textContent = existing ? "Edit Login" : "New Login";
  el("editor-error").hidden = true;

  const currentDomain = normalizeDomain(activeTabUrl);
  el<HTMLInputElement>("ed-title").value =
    existing?.label ?? (activeTabTitle && activeTabTitle.length <= 48 ? activeTabTitle : currentDomain ?? "");
  el<HTMLInputElement>("ed-username").value = existing?.username ?? "";
  const pwInput = el<HTMLInputElement>("ed-password");
  pwInput.value = existing?.password ?? "";
  pwInput.type = "password";
  el("btn-ed-toggle-pw").textContent = "Show";
  el<HTMLInputElement>("ed-url").value =
    existing?.url ?? (isWebOriginFillable(activeTabUrl) ? activeTabUrl : "");
  el<HTMLInputElement>("ed-totp").value = existing?.totpSecret ?? "";
  el<HTMLInputElement>("ed-tags").value = existing?.tags.join(", ") ?? "";
  el<HTMLTextAreaElement>("ed-notes").value = existing?.notes ?? "";
  el<HTMLInputElement>("ed-favorite").checked = Boolean(existing?.favorite);

  setVaultSubScreen("editor");
}

async function handleSaveEditor(): Promise<void> {
  const saveBtn = el<HTMLButtonElement>("btn-editor-save");
  const errorEl = el("editor-error");
  errorEl.hidden = true;
  saveBtn.disabled = true;

  try {
    const totpRaw = el<HTMLInputElement>("ed-totp").value.trim();
    if (totpRaw) {
      try {
        parseTotpInput(totpRaw);
      } catch {
        throw new Error(
          "Invalid 2FA secret. Enter a valid Base32 key or otpauth://totp/... URI."
        );
      }
    }
    const urlValue = el<HTMLInputElement>("ed-url").value.trim();
    const extraUrls = editingItem?.urls.filter((u) => u !== urlValue) ?? [];
    const saved = await sendSw<VaultItemSummary>({
      type: "save-credential",
      input: {
        objectIdHex: editingItem?.summary.objectIdHex,
        title: el<HTMLInputElement>("ed-title").value,
        username: el<HTMLInputElement>("ed-username").value,
        password: el<HTMLInputElement>("ed-password").value,
        url: urlValue,
        urls: urlValue ? [urlValue, ...extraUrls] : extraUrls,
        totp: totpRaw,
        notes: el<HTMLTextAreaElement>("ed-notes").value,
        customFields: editingItem?.customFields ?? [],
        favorite: el<HTMLInputElement>("ed-favorite").checked,
        tags: parseTagsInput(el<HTMLInputElement>("ed-tags").value)
      }
    });
    showToast(editingItem ? "Login updated" : "Login saved");
    await refreshItemList();
    await openDetail(saved.objectIdHex);
  } catch (error) {
    errorEl.textContent =
      error instanceof Error ? error.message : "Could not save login.";
    errorEl.hidden = false;
  } finally {
    saveBtn.disabled = false;
  }
}

function refreshGenerator(): void {
  const out = el("gen-output");
  const bar = el("gen-strength-bar");
  const lbl = el("gen-strength-label");

  let value = "";
  let strength: { level: string; entropyBits: number };

  if (generatorMode === "password") {
    const length = Number(el<HTMLInputElement>("gen-length").value);
    el("gen-len-val").textContent = String(length);
    value = generatePassword({
      length,
      uppercase: el<HTMLInputElement>("gen-upper").checked,
      lowercase: el<HTMLInputElement>("gen-lower").checked,
      digits: el<HTMLInputElement>("gen-digits").checked,
      symbols: el<HTMLInputElement>("gen-symbols").checked,
      excludeAmbiguous: el<HTMLInputElement>("gen-ambiguous").checked
    });
    strength = estimatePasswordStrength(value);
  } else {
    const words = Number(el<HTMLInputElement>("gen-words").value);
    el("gen-words-val").textContent = String(words);
    const opts = {
      words,
      separator: el<HTMLSelectElement>("gen-separator").value,
      capitalize: el<HTMLInputElement>("gen-cap").checked,
      includeNumber: el<HTMLInputElement>("gen-num").checked
    };
    value = generatePassphrase(opts);
    strength = estimatePassphraseStrength(opts);
  }

  out.textContent = value;
  const pct =
    strength.level === "weak"
      ? 25
      : strength.level === "fair"
        ? 50
        : strength.level === "strong"
          ? 78
          : 100;
  const color =
    strength.level === "weak"
      ? "var(--danger)"
      : strength.level === "fair"
        ? "var(--warn)"
        : "var(--success)";
  bar.style.width = `${pct}%`;
  bar.style.background = color;
  const readable =
    strength.level === "very-strong"
      ? "Very strong"
      : strength.level[0].toUpperCase() + strength.level.slice(1);
  lbl.textContent = `${readable} (${Math.round(strength.entropyBits)} bits)`;
  el<HTMLButtonElement>("btn-gen-fill").disabled = !isWebOriginFillable(activeTabUrl);
}

async function syncUiFromState(): Promise<void> {
  state = await sendSw<VaultEngineState>({ type: "get-state" });
  settings = await sendSw<VaultExtensionSettings>({ type: "load-settings" });

  const domain = normalizeDomain(activeTabUrl);
  el("site-subtitle").textContent = domain ?? "Encrypted passwords";

  if (!state.isAuthenticated) {
    setRootView("signed-out");
    return;
  }

  if (state.vaults.length === 0) {
    try {
      const vaults = await sendSw<VaultEngineState["vaults"]>({
        type: "list-vaults"
      });
      state = { ...state, vaults };
    } catch {
      // Surface unlock view cleanly even if vault listing is retried later.
    }
  }

  renderVaultSelectors();
  renderSettingsControls();

  if (!state.isUnlocked) {
    setRootView("locked");
    return;
  }

  el("btn-new-login").hidden = !state.activeVaultCanWrite;
  setRootView("unlocked");
  setVaultSubScreen("list");
  await refreshItemList();
}

function wireEvents(): void {
  document.getElementById("btn-open-web")?.addEventListener("click", () => {
    void chrome.tabs.create({ url: RUNTIME_CONFIG.vaultWebOrigin });
  });
  document.getElementById("btn-settings-open-web")?.addEventListener("click", () => {
    void chrome.tabs.create({ url: RUNTIME_CONFIG.vaultWebOrigin });
  });
  document.getElementById("btn-settings-lock")?.addEventListener("click", () => void handleLock());
  document.getElementById("btn-settings-sign-out")?.addEventListener("click", () => void handleSignOut());
  document.getElementById("btn-settings-sync")?.addEventListener("click", () => {
    void (async () => {
      try {
        await sendSw({ type: "refresh-items" });
        await refreshItemList();
        showToast("Vault synced");
      } catch (error) {
        showToast(error instanceof Error ? error.message : "Sync failed");
      }
    })();
  });

  // Unified Wiki / Vault mode switcher
  const switchMode = (mode: "wiki" | "vault") => {
    const wikiBtn = document.getElementById("mode-wiki");
    const vaultBtn = document.getElementById("mode-vault");
    const wikiPane = document.getElementById("workspace-wiki");
    const vaultPane = document.getElementById("workspace-vault");
    if (wikiBtn) {
      wikiBtn.classList.toggle("active", mode === "wiki");
      wikiBtn.setAttribute("aria-selected", String(mode === "wiki"));
    }
    if (vaultBtn) {
      vaultBtn.classList.toggle("active", mode === "vault");
      vaultBtn.setAttribute("aria-selected", String(mode === "vault"));
    }
    if (wikiPane) wikiPane.hidden = mode !== "wiki";
    if (vaultPane) vaultPane.hidden = mode !== "vault";
  };
  document.getElementById("mode-wiki")?.addEventListener("click", () => switchMode("wiki"));
  document.getElementById("mode-vault")?.addEventListener("click", () => switchMode("vault"));

  document.getElementById("btn-wiki-capture")?.addEventListener("click", () => {
    void (async () => {
      const badge = document.getElementById("wiki-status-badge");
      const statusEl = document.getElementById("wiki-latest-status");
      if (badge) badge.textContent = "Capturing…";
      try {
        const res = await chrome.runtime.sendMessage({ type: "wiki-capture-current-tab" });
        if (res?.ok) {
          if (badge) badge.textContent = "Saved";
          if (statusEl) statusEl.textContent = "Page capture started for current tab.";
          showToast("Wiki capture started");
        } else {
          if (badge) badge.textContent = "Error";
          if (statusEl) statusEl.textContent = res?.error || "Capture failed.";
        }
      } catch (error) {
        if (badge) badge.textContent = "Error";
        if (statusEl) statusEl.textContent = error instanceof Error ? error.message : "Capture failed.";
      }
    })();
  });
  document.getElementById("btn-wiki-open")?.addEventListener("click", () => {
    void chrome.tabs.create({ url: "https://wiki.kinic.xyz/dashboard" });
  });
  document.getElementById("btn-wiki-settings")?.addEventListener("click", () => {
    if (typeof chrome.runtime?.openOptionsPage === "function") {
      chrome.runtime.openOptionsPage();
    } else {
      void chrome.tabs.create({ url: chrome.runtime.getURL("popup/popup.html") });
    }
  });
  el("btn-settings-open-web").addEventListener("click", () => {
    void chrome.tabs.create({ url: RUNTIME_CONFIG.vaultWebOrigin });
  });

  el("btn-sign-in").addEventListener("click", () => {
    void chrome.tabs.create({ url: chrome.runtime.getURL("auth/vault-login.html") });
    window.close();
  });

  const handleSignOut = async () => {
    await sendSw({ type: "auth-signed-out" });
    await logoutInternetIdentity();
    detailItem = null;
    editingItem = null;
    await syncUiFromState();
    showToast("Signed out");
  };
  el("btn-locked-sign-out").addEventListener("click", () => void handleSignOut());
  el("btn-settings-sign-out").addEventListener("click", () => void handleSignOut());

  el("btn-unlock").addEventListener("click", () => {
    const btn = el<HTMLButtonElement>("btn-unlock");
    const err = el("locked-error");
    err.hidden = true;
    btn.disabled = true;
    btn.textContent = "Unlocking…";
    void (async () => {
      try {
        const selected = el<HTMLSelectElement>("locked-vault-select").value;
        await sendSw({
          type: "unlock-vault",
          vaultIdHex: selected || undefined
        });
        await syncUiFromState();
      } catch (error) {
        err.textContent =
          error instanceof Error ? error.message : "Could not unlock Vault.";
        err.hidden = false;
      } finally {
        btn.disabled = false;
        btn.textContent = "Unlock Vault";
      }
    })();
  });

  const handleCreateVault = async (trigger: HTMLButtonElement) => {
    trigger.disabled = true;
    try {
      await sendSw({ type: "create-vault" });
      await syncUiFromState();
      showToast("Vault created and unlocked");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Could not create Vault");
    } finally {
      trigger.disabled = false;
    }
  };
  el("btn-create-first-vault").addEventListener("click", (e) =>
    void handleCreateVault(e.currentTarget as HTMLButtonElement)
  );
  el("btn-create-vault").addEventListener("click", (e) =>
    void handleCreateVault(e.currentTarget as HTMLButtonElement)
  );

  const handleLock = async () => {
    await sendSw({ type: "lock-vault" });
    detailItem = null;
    editingItem = null;
    await syncUiFromState();
    showToast("Vault locked");
  };
  document.getElementById("btn-lock")?.addEventListener("click", () => void handleLock());
  el("btn-settings-lock").addEventListener("click", () => void handleLock());

  // Main bottom tabs
  for (const btn of document.querySelectorAll<HTMLButtonElement>(".tab-btn")) {
    btn.addEventListener("click", () => {
      switchMainTab((btn.dataset.tab as PopupTab) || "vault");
    });
  }

  // Search & category filters
  el<HTMLInputElement>("search-input").addEventListener("input", (event) => {
    searchQuery = (event.currentTarget as HTMLInputElement).value;
    void refreshItemList();
  });
  for (const pill of document.querySelectorAll<HTMLButtonElement>(".pill")) {
    pill.addEventListener("click", () => {
      currentFilter = (pill.dataset.filter as ItemCategoryFilter) || "all";
      for (const other of document.querySelectorAll<HTMLButtonElement>(".pill")) {
        other.classList.toggle("active", other === pill);
      }
      void refreshItemList();
    });
  }

  // Detail & editor navigation
  el("btn-new-login").addEventListener("click", () => openEditor(null));
  el("btn-detail-back").addEventListener("click", () => {
    detailItem = null;
    setVaultSubScreen("list");
  });
  el("btn-detail-edit").addEventListener("click", () => {
    if (detailItem) openEditor(detailItem);
  });
  el("btn-detail-delete").addEventListener("click", () => {
    if (!detailItem) return;
    if (!deleteConfirmArmed) {
      deleteConfirmArmed = true;
      el("btn-detail-delete").textContent = "Confirm delete";
      if (deleteConfirmTimer !== null) window.clearTimeout(deleteConfirmTimer);
      deleteConfirmTimer = window.setTimeout(() => resetDeleteConfirmation(), 4000);
      return;
    }
    resetDeleteConfirmation();
    const id = detailItem.summary.objectIdHex;
    void (async () => {
      try {
        await sendSw({ type: "delete-item", objectIdHex: id });
        detailItem = null;
        await refreshItemList();
        setVaultSubScreen("list");
        showToast("Item deleted");
      } catch (error) {
        showToast(error instanceof Error ? error.message : "Delete failed");
      }
    })();
  });

  el("btn-editor-cancel").addEventListener("click", () => {
    setVaultSubScreen(editingItem && detailItem ? "detail" : "list");
  });
  el("btn-editor-save").addEventListener("click", () => void handleSaveEditor());
  el("btn-ed-toggle-pw").addEventListener("click", () => {
    const pw = el<HTMLInputElement>("ed-password");
    const reveal = pw.type === "password";
    pw.type = reveal ? "text" : "password";
    el("btn-ed-toggle-pw").textContent = reveal ? "Hide" : "Show";
  });
  el("btn-ed-gen-pw").addEventListener("click", () => {
    const pw = el<HTMLInputElement>("ed-password");
    pw.value = generatePassword();
    pw.type = "text";
    el("btn-ed-toggle-pw").textContent = "Hide";
  });

  // Generator controls
  el("gen-mode-password").addEventListener("click", () => {
    generatorMode = "password";
    el("gen-mode-password").classList.add("active");
    el("gen-mode-passphrase").classList.remove("active");
    el("gen-password-options").hidden = false;
    el("gen-passphrase-options").hidden = true;
    refreshGenerator();
  });
  el("gen-mode-passphrase").addEventListener("click", () => {
    generatorMode = "passphrase";
    el("gen-mode-passphrase").classList.add("active");
    el("gen-mode-password").classList.remove("active");
    el("gen-password-options").hidden = true;
    el("gen-passphrase-options").hidden = false;
    refreshGenerator();
  });
  for (const id of [
    "gen-length",
    "gen-upper",
    "gen-lower",
    "gen-digits",
    "gen-symbols",
    "gen-ambiguous",
    "gen-words",
    "gen-separator",
    "gen-cap",
    "gen-num"
  ]) {
    el(id).addEventListener("input", refreshGenerator);
    el(id).addEventListener("change", refreshGenerator);
  }
  el("btn-gen-refresh").addEventListener("click", refreshGenerator);
  el("btn-gen-copy").addEventListener("click", () => {
    const value = el("gen-output").textContent ?? "";
    if (value) void copyText(value, "Generated password");
  });
  el("btn-gen-fill").addEventListener("click", () => {
    const password = el("gen-output").textContent ?? "";
    if (!password) return;
    void (async () => {
      try {
        await sendSw({ type: "fill-generated-password", password });
        showToast("Password filled on page");
        window.setTimeout(() => window.close(), 650);
      } catch (error) {
        showToast(error instanceof Error ? error.message : "Could not fill page");
      }
    })();
  });

  // Settings controls
  el<HTMLSelectElement>("settings-vault-select").addEventListener(
    "change",
    (event) => {
      const vaultIdHex = (event.currentTarget as HTMLSelectElement).value;
      void (async () => {
        try {
          await sendSw({ type: "unlock-vault", vaultIdHex });
          await syncUiFromState();
          switchMainTab("vault");
          showToast("Switched Vault");
        } catch (error) {
          showToast(error instanceof Error ? error.message : "Vault switch failed");
        }
      })();
    }
  );
  document.getElementById("btn-sync-now")?.addEventListener("click", () => {
    void (async () => {
      try {
        await sendSw({ type: "refresh-items" });
        await refreshItemList();
        showToast("Vault synced");
      } catch (error) {
        showToast(error instanceof Error ? error.message : "Sync failed");
      }
    })();
  });
  const saveCurrentSettings = async () => {
    const inlineEl = document.getElementById("settings-inline") as HTMLInputElement | null;
    const bannerEl = document.getElementById("settings-save-banner") as HTMLInputElement | null;
    settings = await sendSw<VaultExtensionSettings>({
      type: "save-settings",
      settings: {
        autoLockMinutes: Number(el<HTMLSelectElement>("settings-autolock").value),
        inlineTriggerEnabled: inlineEl ? inlineEl.checked : settings.inlineTriggerEnabled,
        saveBannerEnabled: bannerEl ? bannerEl.checked : settings.saveBannerEnabled
      }
    });
    showToast("Settings saved");
  };
  el("settings-autolock").addEventListener("change", () => void saveCurrentSettings());
  el("btn-settings-autofill").addEventListener("click", () => {
    // permissions.request must run directly in the click handler to keep the user gesture.
    const change = websiteAccess
      ? chrome.permissions.remove(AUTOFILL_PERMISSIONS)
      : chrome.permissions.request(AUTOFILL_PERMISSIONS);
    void change
      .then(async () => {
        // The service worker registers or removes the autofill script on permission changes.
        await refreshWebsiteAccess();
        renderWebsiteAccess();
        showToast(websiteAccess ? "Autofill on websites is on" : "Autofill on websites is off");
      })
      .catch((error: unknown) => {
        showToast(error instanceof Error ? error.message : "Could not change website access");
      });
  });
  document.getElementById("settings-inline")?.addEventListener("change", () => void saveCurrentSettings());
  document.getElementById("settings-save-banner")?.addEventListener("change", () => void saveCurrentSettings());
}

async function bootstrap(): Promise<void> {
  wireEvents();
  await refreshWebsiteAccess();
  setRootView("loading");
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTabUrl = tabs?.[0]?.url ?? "";
    activeTabTitle = tabs?.[0]?.title ?? "";
  } catch {
    activeTabUrl = "";
    activeTabTitle = "";
  }
  try {
    await syncUiFromState();
  } catch (error) {
    setRootView("signed-out");
    const err = el("signed-out-error");
    err.textContent =
      error instanceof Error ? error.message : "Could not initialize Kinic Vault.";
    err.hidden = false;
  }
}

void bootstrap();
