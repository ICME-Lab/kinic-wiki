// Where: extensions/wiki-clipper/src/gemini-response.js
// What: Capture the current Gemini conversation from the rendered DOM.
// Why: Gemini's web conversation API is private and unstable, so current-chat capture stays in the page.
import { appendLimitedMessage } from "./conversation-limits.js";

const GEMINI_CONVERSATION_PATH = /^\/(?:u\/\d+\/)?app\/([^/]+)\/?$/;
const TURN_SELECTOR = "user-query, model-response";
const GEMINI_MAX_CAPTURE_CHARS = 200_000;

export function geminiConversationIdFromUrl(value, loc = globalThis.location) {
  try {
    const url = new URL(value, loc?.href || loc?.origin);
    return url.pathname.match(GEMINI_CONVERSATION_PATH)?.[1] || "";
  } catch {
    return "";
  }
}

export function currentGeminiConversationTarget(loc = globalThis.location) {
  const id = geminiConversationIdFromUrl(loc?.href || "", loc);
  if (!id) return null;
  return {
    id,
    title: "Current conversation",
    url: new URL(loc.href, loc.origin).toString()
  };
}

export function captureFromGeminiDom(doc = globalThis.document, url = globalThis.location?.href || "", capturedAt = new Date().toISOString()) {
  const messages = messagesFromGeminiDom(doc);
  return {
    provider: "gemini",
    conversationTitle: titleFromDocument(doc),
    url,
    capturedAt,
    messages
  };
}

export function messagesFromGeminiDom(doc = globalThis.document) {
  if (!doc?.querySelectorAll) return [];
  const messages = [];
  const state = { chars: 0, done: false };
  const turns = Array.from(doc.querySelectorAll(TURN_SELECTOR));
  if (turns.length > 0) {
    for (const element of turns) {
      if (state.done) break;
      const tagName = element.tagName?.toLowerCase();
      const role = tagName === "user-query" ? "user" : "assistant";
      const content = extractTurnText(element, role);
      appendLimitedMessage(messages, state, role, content, GEMINI_MAX_CAPTURE_CHARS);
    }
    return messages;
  }
  return messagesFromGeminiTurnContainers(doc, messages, state);
}

function messagesFromGeminiTurnContainers(doc, messages, state) {
  const containers = Array.from(doc.querySelectorAll(".conversation-turn, [data-message-id]"));
  for (const container of containers) {
    if (state.done) break;
    const user = container.querySelector?.("user-query, [data-message-author-role='user']");
    const model = container.querySelector?.("model-response, .model-response-container, [data-message-author-role='model']");
    if (user) pushMessage(messages, state, "user", extractTurnText(user, "user"));
    if (model) pushMessage(messages, state, "assistant", extractTurnText(model, "assistant"));
  }
  return messages;
}

function pushMessage(messages, state, role, content) {
  appendLimitedMessage(messages, state, role, content, GEMINI_MAX_CAPTURE_CHARS);
}

function extractTurnText(element, role) {
  const selector = role === "user"
    ? ".query-text, [data-message-content]"
    : ".model-response-text, .markdown, .markdown-main-panel, .response-content, message-content, [data-message-content]";
  const content = element.querySelector?.(selector);
  return normalizeText(content?.innerText || content?.textContent || element.innerText || element.textContent || "");
}

function normalizeText(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function titleFromDocument(doc) {
  const title = normalizeText(doc?.title || "");
  return title.replace(/\s*[|—-]\s*Gemini\s*$/i, "").trim() || "Gemini conversation";
}
