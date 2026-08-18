// Where: extensions/wiki-clipper/src/chatgpt-recall.js
// What: ChatGPT-specific composer detection and safe context insertion.
// Why: Provider DOM changes should not leak into the generic Recall state.

import { isChatGptOrigin, normalizeRecallQuery } from "./recall.js";

export function isChatGptLocation(locationLike = globalThis.location) {
  return isChatGptOrigin(locationLike?.href || locationLike?.toString?.() || "");
}

export function findChatGptComposer(documentRef = globalThis.document) {
  if (!documentRef) return null;
  const candidates = [...documentRef.querySelectorAll("textarea, [contenteditable='true']")].filter(isVisible);
  const focused = candidates.find((candidate) => candidate === documentRef.activeElement || candidate.contains?.(documentRef.activeElement));
  return focused || candidates.find((candidate) => candidate.getAttribute("aria-label")?.toLowerCase().includes("message")) || candidates[0] || null;
}

export function readChatGptComposer(documentRef = globalThis.document) {
  const composer = findChatGptComposer(documentRef);
  if (!composer) return "";
  return normalizeRecallQuery("value" in composer ? composer.value : composer.textContent);
}

export function insertChatGptContext(context, documentRef = globalThis.document) {
  const composer = findChatGptComposer(documentRef);
  if (!composer) return false;
  const text = String(context || "").trim();
  if (!text) return false;
  composer.focus?.();
  if ("value" in composer) {
    const prefix = composer.value.trim() ? `${composer.value.trim()}\n\n` : "";
    const nextValue = `${prefix}${text}`;
    const cursor = nextValue.length;
    composer.value = nextValue;
    composer.setSelectionRange?.(cursor, cursor);
    composer.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }
  const selection = documentRef.getSelection?.();
  const range = documentRef.createRange?.();
  if (selection && range) {
    range.selectNodeContents(composer);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }
  // Rich editors (ChatGPT's ProseMirror composer) translate a paste into their
  // own document model, matching the "pasted long text" state in the input box.
  // execCommand text insertion only edits the DOM and leaves the editor state stale.
  // When paste is available, trust the editor to apply it; never fall back to
  // direct textContent writes that would leave the editor model stale.
  if (supportsPaste(documentRef, composer)) return pasteChatGptText(documentRef, composer, text);
  composer.textContent = composer.textContent?.trim() ? `${composer.textContent.trim()}\n\n${text}` : text;
  composer.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
}

function supportsPaste(documentRef, composer) {
  const win = composer?.ownerDocument?.defaultView || documentRef?.defaultView || globalThis;
  return Boolean(win?.DataTransfer && win?.ClipboardEvent);
}

function pasteChatGptText(documentRef, composer, text) {
  try {
    const win = composer?.ownerDocument?.defaultView || documentRef?.defaultView || globalThis;
    const dataTransfer = new win.DataTransfer();
    dataTransfer.setData("text/plain", text);
    const before = composer.textContent || "";
    const pasteEvent = new win.ClipboardEvent("paste", {
      clipboardData: dataTransfer,
      bubbles: true,
      cancelable: true
    });
    composer.dispatchEvent(pasteEvent);
    return (composer.textContent || "").length > before.length;
  } catch {
    return false;
  }
}

export function installChatGptRecallListeners({ documentRef = globalThis.document, locationLike = globalThis.location, onSubmit }) {
  if (!documentRef || !isChatGptLocation(locationLike) || typeof onSubmit !== "function") return () => {};
  let timer = null;
  let lastScheduled = "";
  let lastScheduledAt = 0;

  const schedule = () => {
    const query = readChatGptComposer(documentRef);
    if (!query) return;
    const now = Date.now();
    if (query === lastScheduled && now - lastScheduledAt < 800) return;
    lastScheduled = query;
    lastScheduledAt = now;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      onSubmit(query);
    }, 300);
  };

  const onSubmitEvent = () => schedule();
  const onKeyDown = (event) => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter" && !event.shiftKey && isComposerTarget(event.target)) schedule();
  };
  const onClick = (event) => {
    if (isSendButton(event.target)) schedule();
  };
  documentRef.addEventListener("submit", onSubmitEvent, true);
  documentRef.addEventListener("keydown", onKeyDown, true);
  documentRef.addEventListener("click", onClick, true);
  return () => {
    if (timer) clearTimeout(timer);
    documentRef.removeEventListener("submit", onSubmitEvent, true);
    documentRef.removeEventListener("keydown", onKeyDown, true);
    documentRef.removeEventListener("click", onClick, true);
  };
}

const historyRegistrations = new WeakMap();

function registerHistoryWrap(historyRef, notify) {
  if (!historyRef || typeof notify !== "function") return () => {};
  let registration = historyRegistrations.get(historyRef);
  if (!registration) {
    const pushOriginal = typeof historyRef.pushState === "function" ? historyRef.pushState : null;
    const replaceOriginal = typeof historyRef.replaceState === "function" ? historyRef.replaceState : null;
    const notifiers = new Set();
    const callNotifiers = () => {
      for (const fn of notifiers) fn();
    };
    if (pushOriginal) {
      historyRef.pushState = function (...args) {
        const result = pushOriginal.apply(this, args);
        callNotifiers();
        return result;
      };
    }
    if (replaceOriginal) {
      historyRef.replaceState = function (...args) {
        const result = replaceOriginal.apply(this, args);
        callNotifiers();
        return result;
      };
    }
    registration = { pushOriginal, replaceOriginal, notifiers };
    historyRegistrations.set(historyRef, registration);
  }
  registration.notifiers.add(notify);
  return () => {
    registration.notifiers.delete(notify);
    if (registration.notifiers.size === 0) {
      if (registration.pushOriginal) historyRef.pushState = registration.pushOriginal;
      if (registration.replaceOriginal) historyRef.replaceState = registration.replaceOriginal;
      historyRegistrations.delete(historyRef);
    }
  };
}

export function installChatGptNavigationListener({ windowRef = globalThis, locationLike, documentRef, MutationObserverRef = globalThis.MutationObserver, onNavigate }) {
  const currentLocation = locationLike || windowRef?.location;
  if (!windowRef || !currentLocation || !isChatGptOrigin(currentLocation.href || "") || typeof onNavigate !== "function") return () => {};
  let currentUrl = String(currentLocation.href || "");
  const historyRef = windowRef.history;
  const notify = () => {
    const nextUrl = String(currentLocation.href || "");
    if (nextUrl === currentUrl) return;
    currentUrl = nextUrl;
    onNavigate(nextUrl);
  };
  const observer = documentRef?.documentElement && MutationObserverRef
    ? new MutationObserverRef(() => notify())
    : null;
  observer?.observe?.(documentRef.documentElement, { childList: true, subtree: true });
  const unregisterHistory = registerHistoryWrap(historyRef, notify);
  windowRef.addEventListener?.("popstate", notify);
  windowRef.addEventListener?.("hashchange", notify);
  return () => {
    windowRef.removeEventListener?.("popstate", notify);
    windowRef.removeEventListener?.("hashchange", notify);
    observer?.disconnect?.();
    unregisterHistory();
  };
}

function isComposerTarget(target) {
  return Boolean(target?.matches?.("textarea, [contenteditable='true']") || target?.closest?.("textarea, [contenteditable='true']"));
}

function isSendButton(target) {
  const button = target?.closest?.("button");
  if (!button) return false;
  const label = `${button.getAttribute("aria-label") || ""} ${button.getAttribute("data-testid") || ""}`.toLowerCase();
  return label.includes("send") && !label.includes("voice");
}

function isVisible(element) {
  if (!element || element.disabled) return false;
  const style = element.ownerDocument?.defaultView?.getComputedStyle?.(element);
  return style?.display !== "none" && style?.visibility !== "hidden";
}
