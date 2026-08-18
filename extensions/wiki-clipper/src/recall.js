// Where: extensions/wiki-clipper/src/recall.js
// What: Pure Recall query normalization, ranking, and context formatting.
// Why: Search policy must be testable without a browser or canister.
import { fnv1aHex } from "@kinic/source-contracts";

export const RECALL_QUERY_MAX_CHARS = 2_000;
export const RECALL_RESULT_LIMIT = 3;
export const RECALL_SEARCH_TOP_K = 5;

export function normalizeRecallQuery(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, RECALL_QUERY_MAX_CHARS);
}

export function buildRecallFallbackQuery(question) {
  const literal = normalizeRecallQuery(question);
  if (!literal) return null;

  const asciiIdentifiers = [...literal.matchAll(/[A-Za-z][A-Za-z0-9_-]*/g)]
    .map((match) => ({ text: match[0], index: match.index ?? 0 }))
    .filter(({ text }) => text.length >= 3 && (/[0-9_-]/.test(text) || /^[A-Z]{3,}$/.test(text)));
  const kanjiTerms = [...literal.matchAll(/[\p{Script=Han}]{3,}/gu)]
    .map((match) => ({ text: match[0], index: match.index ?? 0 }));
  const katakanaTerms = [...literal.matchAll(/[\p{Script=Katakana}ー]{3,}/gu)]
    .map((match) => ({ text: match[0], index: match.index ?? 0 }));
  const japaneseTerm = kanjiTerms[0] || katakanaTerms[0];
  const selected = japaneseTerm
    ? [asciiIdentifiers[0], japaneseTerm].filter(Boolean).sort((left, right) => left.index - right.index)
    : asciiIdentifiers.slice(0, 2);
  const fallback = normalizeRecallQuery(selected.map(({ text }) => text).join(" "));
  if (!fallback || equivalentRecallQueryKey(fallback) === equivalentRecallQueryKey(literal)) return null;
  return fallback;
}

export function isChatGptOrigin(value) {
  try {
    const origin = new URL(String(value || "")).origin;
    return origin === "https://chatgpt.com" || origin === "https://chat.openai.com";
  } catch {
    return false;
  }
}

export function isRecallSender(sender) {
  return isChatGptOrigin(sender?.tab?.url || sender?.url || "");
}

export function isAllowedRecallPath(value) {
  const path = String(value || "");
  return /^\/(?:Knowledge|Sources)(?:\/|$)/.test(path)
    && !path.split("/").includes("..")
    && !path.includes("\\")
    && !/[\u0000-\u001f]/.test(path);
}

export function applyRecallStorageChanges(config, changes, areaName) {
  if (areaName !== "sync" || !changes || typeof changes !== "object") return config;
  const next = { ...config };
  if (Object.prototype.hasOwnProperty.call(changes, "databaseId")) {
    next.databaseId = String(changes.databaseId?.newValue || "").trim();
  }
  if (Object.prototype.hasOwnProperty.call(changes, "recallEnabled")) {
    next.recallEnabled = changes.recallEnabled?.newValue === true || changes.recallEnabled?.newValue === "true";
  }
  return next;
}

export function rankRecallHits(hits, { currentConversationUrl = "" } = {}) {
  const currentConversationId = conversationIdFromUrl(currentConversationUrl);
  const candidates = new Map();
  for (const hit of Array.isArray(hits) ? hits : []) {
    const path = String(hit?.path || "");
    if (!path || pathLooksLikeCurrentConversation(path, currentConversationId)) continue;
    const reasons = Array.isArray(hit?.match_reasons) ? hit.match_reasons.map(String) : [];
    if (!reasons.some((reason) => reason === "content_fts" || reason === "title_fts")) continue;
    if (!candidates.has(path)) candidates.set(path, normalizeRecallHit(hit));
  }
  return [...candidates.values()]
    .sort((left, right) => {
      const leftKnowledge = left.path.startsWith("/Knowledge/") ? 0 : 1;
      const rightKnowledge = right.path.startsWith("/Knowledge/") ? 0 : 1;
      return leftKnowledge - rightKnowledge || left.score - right.score || left.path.localeCompare(right.path);
    })
    .slice(0, RECALL_RESULT_LIMIT);
}

export function normalizeRecallHit(hit) {
  const path = String(hit?.path || "");
  const preview = candidOpt(hit?.preview);
  const excerpt = candidOpt(preview?.excerpt);
  const snippet = candidOpt(hit?.snippet);
  return {
    path,
    kind: variantKey(hit?.kind) || "File",
    title: titleFromPath(path),
    snippet: String(excerpt || snippet || "").trim(),
    updatedAt: null,
    sourceUrl: null,
    score: Number.isFinite(Number(hit?.score)) ? Number(hit.score) : Number.POSITIVE_INFINITY,
    matchReasons: Array.isArray(hit?.match_reasons) ? hit.match_reasons.map(String) : []
  };
}

export function formatRecallContext(result, excerpt) {
  const title = String(result?.title || "Kinic memory").trim() || "Kinic memory";
  const path = String(result?.path || "").trim();
  const source = String(result?.sourceUrl || path).trim();
  const text = String(excerpt || result?.snippet || "").trim().slice(0, 4_000);
  return [
    "[Kinic memory]",
    `Title: ${title}`,
    `Source: ${source}`,
    "",
    text,
    "[/Kinic memory]"
  ].join("\n");
}

export function titleFromPath(path) {
  const basename = String(path || "").split("/").pop() || "Kinic memory";
  return basename.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim() || "Kinic memory";
}

function variantKey(value) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") return Object.keys(value)[0] || "";
  return "";
}

function candidOpt(value) {
  return Array.isArray(value) ? value[0] : value;
}

function equivalentRecallQueryKey(value) {
  return normalizeRecallQuery(value)
    .toLocaleLowerCase("en-US")
    .split(" ")
    .filter(Boolean)
    .sort()
    .join(" ");
}

function conversationIdFromUrl(value) {
  try {
    const match = new URL(String(value || "")).pathname.match(/^\/(?:c|chat|(?:u\/\d+\/)?app)\/([^/]+)/);
    return match?.[1] || "";
  } catch {
    return "";
  }
}

function pathLooksLikeCurrentConversation(path, conversationId) {
  if (!conversationId) return false;
  const currentHash = fnv1aHex(`chatgpt:${conversationId}`);
  return path.startsWith("/Sources/chatgpt/") && path.endsWith(`-${currentHash}.md`);
}
