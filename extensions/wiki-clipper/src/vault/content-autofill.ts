// Where: extensions/vault-autofill/src/content-autofill.ts
// What: Content script handling login autofill, inline Shadow DOM credential picker, and save-login banner.
// Why: Keep web page DOM isolated from Vault secrets while delivering a 1Password-grade browser experience.
import {
  extractSubmittedCredentials,
  isLikelyLoginSubmitTrigger,
  isPasswordInput,
  isUsernameInput,
  isWebOriginFillable
} from "./form-detector.ts";
import { fillGeneratedPassword, fillLoginFields } from "./form-filler.ts";
import type { VaultItemSummary } from "./types.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
declare const chrome: any;
/* eslint-enable @typescript-eslint/no-explicit-any */

type SaveBannerPromptView = {
  id: string;
  mode: "create" | "update";
  domain: string;
  title: string;
  username: string;
};

const PICKER_HOST_ID = "kinic-vault-inline-picker-host";
const BANNER_HOST_ID = "kinic-vault-save-banner-host";

let activePickerHost: HTMLDivElement | null = null;
let activeBannerHost: HTMLDivElement | null = null;
let lastCaptureKey = "";
let lastCaptureAt = 0;

function sendRuntimeMessage<T>(message: Record<string, unknown>): Promise<T | null> {
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(
        message,
        (response?: { ok?: boolean; result?: T }) => {
          if (chrome.runtime?.lastError || !response?.ok) {
            resolve(null);
            return;
          }
          resolve(response.result ?? null);
        }
      );
    } catch {
      resolve(null);
    }
  });
}

function removeInlinePicker(): void {
  if (activePickerHost) {
    activePickerHost.remove();
    activePickerHost = null;
  }
}

function removeSaveBanner(): void {
  if (activeBannerHost) {
    activeBannerHost.remove();
    activeBannerHost = null;
  }
}

function showInlinePicker(
  anchor: HTMLInputElement,
  matches: VaultItemSummary[]
): void {
  removeInlinePicker();
  if (matches.length === 0) return;

  const rect = anchor.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return;

  const host = document.createElement("div");
  host.id = PICKER_HOST_ID;
  host.style.position = "fixed";
  host.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 300))}px`;
  host.style.top = `${Math.min(rect.bottom + 6, window.innerHeight - 220)}px`;
  host.style.zIndex = "2147483647";

  const shadow = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    .card {
      width: 288px;
      background: #141720;
      color: #f8fafc;
      border: 1px solid rgba(129, 140, 248, 0.35);
      border-radius: 12px;
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35);
      overflow: hidden;
    }
    .hdr {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 12px;
      background: rgba(79, 70, 229, 0.22);
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.02em;
      color: #c7d2fe;
    }
    .close {
      background: transparent;
      border: none;
      color: #94a3b8;
      cursor: pointer;
      font-size: 14px;
      line-height: 1;
      padding: 2px 4px;
    }
    .list { max-height: 210px; overflow-y: auto; padding: 4px; }
    .row {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      width: 100%;
      background: transparent;
      border: none;
      border-radius: 8px;
      padding: 8px 10px;
      text-align: left;
      cursor: pointer;
      color: inherit;
    }
    .row:hover, .row:focus { background: rgba(99, 102, 241, 0.24); outline: none; }
    .title { font-size: 13px; font-weight: 600; color: #f8fafc; max-width: 256px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sub { font-size: 11px; color: #94a3b8; max-width: 256px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: 2px; }
  `;

  const card = document.createElement("div");
  card.className = "card";

  const hdr = document.createElement("div");
  hdr.className = "hdr";
  const label = document.createElement("span");
  label.textContent = "Kinic Vault";
  const closeBtn = document.createElement("button");
  closeBtn.className = "close";
  closeBtn.type = "button";
  closeBtn.textContent = "×";
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.addEventListener("mousedown", (e) => {
    e.preventDefault();
    removeInlinePicker();
  });
  hdr.append(label, closeBtn);

  const list = document.createElement("div");
  list.className = "list";

  for (const item of matches.slice(0, 8)) {
    const btn = document.createElement("button");
    btn.className = "row";
    btn.type = "button";

    const titleEl = document.createElement("span");
    titleEl.className = "title";
    titleEl.textContent = item.title;

    const subEl = document.createElement("span");
    subEl.className = "sub";
    subEl.textContent = item.username || item.domains[0] || "Login";

    btn.append(titleEl, subEl);
    btn.addEventListener("mousedown", (event) => {
      event.preventDefault();
      void (async () => {
        const creds = await sendRuntimeMessage<{
          username: string;
          password: string;
          totp: string;
        }>({
          type: "fill-inline-item",
          objectIdHex: item.objectIdHex
        });
        if (creds) {
          fillLoginFields(document, creds);
        }
        removeInlinePicker();
      })();
    });
    list.appendChild(btn);
  }

  card.append(hdr, list);
  shadow.append(style, card);
  document.documentElement.appendChild(host);
  activePickerHost = host;
}

function showSaveBanner(prompt: SaveBannerPromptView): void {
  removeSaveBanner();

  const host = document.createElement("div");
  host.id = BANNER_HOST_ID;
  host.style.position = "fixed";
  host.style.top = "16px";
  host.style.right = "16px";
  host.style.zIndex = "2147483647";

  const shadow = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    .banner {
      width: 320px;
      background: #141720;
      color: #f8fafc;
      border: 1px solid rgba(129, 140, 248, 0.4);
      border-radius: 14px;
      box-shadow: 0 16px 40px rgba(0, 0, 0, 0.42);
      padding: 14px;
    }
    .head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
    .badge { font-size: 11px; font-weight: 700; color: #a5b4fc; text-transform: uppercase; letter-spacing: 0.04em; }
    .heading { font-size: 14px; font-weight: 700; color: #ffffff; margin: 2px 0 0; }
    .close { background: transparent; border: none; color: #94a3b8; cursor: pointer; font-size: 16px; line-height: 1; }
    .field { display: flex; flex-direction: column; gap: 4px; margin-bottom: 8px; }
    .field label { font-size: 11px; color: #94a3b8; font-weight: 600; }
    .field input {
      background: #1e2230;
      border: 1px solid rgba(148, 163, 184, 0.25);
      border-radius: 8px;
      color: #f8fafc;
      font-size: 13px;
      padding: 7px 9px;
      outline: none;
    }
    .field input:focus { border-color: #6366f1; }
    .actions { display: flex; gap: 8px; margin-top: 12px; }
    .btn {
      flex: 1;
      border-radius: 9px;
      border: none;
      padding: 9px 12px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
    }
    .primary { background: #4f46e5; color: #ffffff; }
    .primary:hover { background: #4338ca; }
    .primary:disabled { opacity: 0.6; cursor: default; }
    .secondary { background: #1e2230; color: #cbd5e1; border: 1px solid rgba(148, 163, 184, 0.2); }
    .secondary:hover { background: #262c3f; }
    .status { font-size: 12px; color: #a5b4fc; margin-top: 8px; min-height: 16px; }
  `;

  const banner = document.createElement("div");
  banner.className = "banner";

  const head = document.createElement("div");
  head.className = "head";
  const headText = document.createElement("div");
  const badge = document.createElement("div");
  badge.className = "badge";
  badge.textContent = "Kinic Vault";
  const heading = document.createElement("div");
  heading.className = "heading";
  heading.textContent =
    prompt.mode === "update"
      ? `Update password for ${prompt.domain}?`
      : `Save login for ${prompt.domain}?`;
  headText.append(badge, heading);

  const closeBtn = document.createElement("button");
  closeBtn.className = "close";
  closeBtn.type = "button";
  closeBtn.textContent = "×";
  closeBtn.setAttribute("aria-label", "Dismiss");
  head.append(headText, closeBtn);

  const titleField = document.createElement("div");
  titleField.className = "field";
  const titleLabel = document.createElement("label");
  titleLabel.textContent = "Title";
  const titleInput = document.createElement("input");
  titleInput.type = "text";
  titleInput.value = prompt.title;
  titleField.append(titleLabel, titleInput);

  const userField = document.createElement("div");
  userField.className = "field";
  const userLabel = document.createElement("label");
  userLabel.textContent = "Username";
  const userInput = document.createElement("input");
  userInput.type = "text";
  userInput.value = prompt.username;
  userField.append(userLabel, userInput);

  const statusEl = document.createElement("div");
  statusEl.className = "status";

  const actions = document.createElement("div");
  actions.className = "actions";
  const dismissBtn = document.createElement("button");
  dismissBtn.className = "btn secondary";
  dismissBtn.type = "button";
  dismissBtn.textContent = "Not now";

  const saveBtn = document.createElement("button");
  saveBtn.className = "btn primary";
  saveBtn.type = "button";
  saveBtn.textContent = prompt.mode === "update" ? "Update" : "Save";
  actions.append(dismissBtn, saveBtn);

  const dismiss = () => {
    void sendRuntimeMessage({ type: "save-banner-dismiss" });
    removeSaveBanner();
  };
  closeBtn.addEventListener("click", dismiss);
  dismissBtn.addEventListener("click", dismiss);

  saveBtn.addEventListener("click", () => {
    saveBtn.disabled = true;
    statusEl.textContent = "Encrypting and saving…";
    void (async () => {
      const saved = await sendRuntimeMessage({
        type: "save-banner-confirm",
        promptId: prompt.id,
        title: titleInput.value,
        username: userInput.value
      });
      if (saved) {
        statusEl.textContent =
          prompt.mode === "update" ? "Password updated in Vault." : "Saved to Kinic Vault.";
        window.setTimeout(() => removeSaveBanner(), 1100);
      } else {
        saveBtn.disabled = false;
        statusEl.textContent = "Could not save right now. Open Kinic Vault to unlock.";
      }
    })();
  });

  banner.append(head, titleField, userField, actions, statusEl);
  shadow.append(style, banner);
  document.documentElement.appendChild(host);
  activeBannerHost = host;
}

function captureAndReportLogin(
  scope: ParentNode,
  preferredPasswordInput?: HTMLInputElement | null
): void {
  const creds = extractSubmittedCredentials(scope, preferredPasswordInput);
  if (!creds) return;
  const now = Date.now();
  const key = `${creds.username}\u0000${creds.password.length}`;
  if (key === lastCaptureKey && now - lastCaptureAt < 1500) {
    return;
  }
  lastCaptureKey = key;
  lastCaptureAt = now;

  void (async () => {
    const result = await sendRuntimeMessage<{ prompt: SaveBannerPromptView | null }>({
      type: "login-submitted",
      username: creds.username,
      password: creds.password,
      pageTitle: document.title
    });
    if (result?.prompt) {
      showSaveBanner(result.prompt);
    }
  })();
}

export function handleContentFillMessage(
  message: Record<string, unknown>,
  doc: Document = document,
  win: { top: unknown; location: { origin: string; href: string } } = window
): { ok: boolean; error?: string; result?: unknown } | null {
  if (message?.type !== "fill-credentials" && message?.type !== "fill-generated-password") {
    return null;
  }
  if (win.top !== win) {
    return { ok: false, error: "ORIGIN_MISMATCH" };
  }
  if (
    typeof message.expectedOrigin !== "string" ||
    !message.expectedOrigin ||
    win.location.origin !== message.expectedOrigin ||
    !isWebOriginFillable(win.location.href)
  ) {
    return { ok: false, error: "ORIGIN_MISMATCH" };
  }
  if (message.type === "fill-credentials") {
    const result = fillLoginFields(doc, {
      username: typeof message.username === "string" ? message.username : undefined,
      password: typeof message.password === "string" ? message.password : undefined,
      totp: typeof message.totp === "string" ? message.totp : undefined
    });
    removeInlinePicker();
    return { ok: true, result };
  }
  const result = fillGeneratedPassword(
    doc,
    typeof message.password === "string" ? message.password : ""
  );
  return { ok: true, result };
}

function initContentAutofill(): void {
  if (!isWebOriginFillable(window.location.href)) return;

  // Listen for direct fill actions initiated from the popup.
  if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener(
      (
        message: Record<string, unknown>,
        _sender: unknown,
        sendResponse: (response: unknown) => void
      ) => {
        const handled = handleContentFillMessage(message);
        if (handled) {
          sendResponse(handled);
        }
        return false;
      }
    );
  }

  // Inline autofill picker on focus of login/password fields.
  document.addEventListener(
    "focusin",
    (event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement)) {
        removeInlinePicker();
        return;
      }
      if (!isPasswordInput(target) && !isUsernameInput(target)) {
        removeInlinePicker();
        return;
      }
      void (async () => {
        const result = await sendRuntimeMessage<{
          enabled: boolean;
          unlocked: boolean;
          matches: VaultItemSummary[];
        }>({ type: "get-inline-matches" });
        if (
          document.activeElement === target &&
          result?.enabled &&
          result.unlocked &&
          result.matches.length > 0
        ) {
          showInlinePicker(target, result.matches);
        }
      })();
    },
    true
  );

  document.addEventListener(
    "mousedown",
    (event) => {
      if (
        activePickerHost &&
        event.target instanceof Node &&
        !activePickerHost.contains(event.target)
      ) {
        removeInlinePicker();
      }
    },
    true
  );

  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Escape") {
        removeInlinePicker();
        return;
      }
      if (
        event.key === "Enter" &&
        event.target instanceof HTMLInputElement &&
        isPasswordInput(event.target)
      ) {
        const scope = event.target.form ?? document;
        captureAndReportLogin(scope, event.target);
      }
    },
    true
  );

  // Capture standard and SPA form submissions.
  document.addEventListener(
    "submit",
    (event) => {
      if (event.target instanceof HTMLFormElement) {
        captureAndReportLogin(event.target);
      }
    },
    true
  );

  // Capture SPA button clicks when login forms omit <form> or use custom click handlers.
  document.addEventListener(
    "click",
    (event) => {
      if (
        event.target instanceof Node &&
        ((activePickerHost && activePickerHost.contains(event.target)) ||
          (activeBannerHost && activeBannerHost.contains(event.target)))
      ) {
        return;
      }
      const el =
        event.target instanceof Element
          ? event.target.closest("button, input[type='submit'], [role='button']")
          : null;
      if (!el) return;
      const form = el.closest("form");
      if (!isLikelyLoginSubmitTrigger(el, form)) return;
      if (form) {
        captureAndReportLogin(form);
      } else {
        const pwInputs = Array.from(document.querySelectorAll("input[type='password']"))
          .filter((node): node is HTMLInputElement => node instanceof HTMLInputElement)
          .filter((input) => input.value.length > 0);
        if (pwInputs.length > 0) {
          captureAndReportLogin(document, pwInputs[0]);
        }
      }
    },
    true
  );

  // Check if a login was submitted immediately before a redirect to this page.
  void (async () => {
    const result = await sendRuntimeMessage<{ prompt: SaveBannerPromptView | null }>({
      type: "check-pending-save-banner"
    });
    if (result?.prompt) {
      showSaveBanner(result.prompt);
    }
  })();
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  initContentAutofill();
}
