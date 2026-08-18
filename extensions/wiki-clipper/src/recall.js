// Where: extensions/wiki-clipper/src/recall.js
// What: Pure Recall query normalization, ranking, and context formatting.
// Why: Search policy must be testable without a browser or canister.
import { fnv1aHex } from "@kinic/source-contracts";

export const RECALL_QUERY_MAX_CHARS = 2_000;
export const RECALL_RESULT_LIMIT = 3;
export const RECALL_SEARCH_TOP_K = 5;
export const RECALL_MIN_SCORE = -1_000;
export const RECALL_QUERY_MAX_TERMS = 4;
export const RECALL_QUERY_FOCUS_CHARS = 200;
export const RECALL_CONTEXT_MAX_CHARS = 3_000;

const RECALL_ALLOWED_REASONS = new Set([
  "content_fts",
  "content_substring",
  "title_fts",
  "path_substring"
]);

const ENGLISH_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "if", "then", "else", "of", "to", "in",
  "on", "at", "for", "with", "about", "from", "by", "as", "is", "are", "was",
  "were", "be", "been", "have", "has", "had", "do", "does", "did", "will",
  "would", "can", "could", "should", "this", "that", "these", "those", "it",
  "its", "i", "you", "we", "they", "he", "she", "me", "my", "your", "our",
  "their", "what", "which", "who", "whom", "how", "when", "where", "why",
  "please", "help", "tell", "want", "need", "make", "use", "using", "get",
  "not", "more", "most", "some", "any", "into", "than"
]);

const JAPANESE_STOPWORDS = new Set([
  "こと", "もの", "とき", "よう", "ため", "これ", "それ", "あれ", "ここ", "そこ",
  "自分", "私", "方法", "中身", "何か", "なんか", "どう", "どの", "なぜ", "いつ",
  "ですか", "ます", "です", "したい", "やりたい", "できる", "ください", "下さい",
  "なる", "なるか", "思う", "思います", "教えて", "教え"
]);

export function normalizeRecallQuery(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, RECALL_QUERY_MAX_CHARS);
}

// Distill a raw conversational draft into a concise, distinctive keyword query.
// The canister search is lexical, so searching with the whole draft (stopwords,
// filler, multi-topic phrasing) matches many unrelated nodes. Focusing on a few
// strong terms from the most recent part of the message improves precision.
export function buildRecallSearchQuery(value) {
  const literal = normalizeRecallQuery(value);
  if (!literal) return null;
  const terms = extractRecallQueryTerms(literal);
  if (terms.length === 0) return null;
  return normalizeRecallQuery(terms.join(" ")) || null;
}

function extractRecallQueryTerms(text) {
  const focus = text.length > RECALL_QUERY_FOCUS_CHARS ? text.slice(-RECALL_QUERY_FOCUS_CHARS) : text;
  const tokens = [...focus.matchAll(/[A-Za-z0-9][A-Za-z0-9_-]*|[\p{Script=Han}]{2,}|[\p{Script=Katakana}ー]{2,}/gu)]
    .map((match) => match[0]);
  const seen = new Set();
  const terms = [];
  // Collect from the end so the most recent part of the draft (usually the
  // actual question) is prioritized within the term cap.
  for (let index = tokens.length - 1; index >= 0 && terms.length < RECALL_QUERY_MAX_TERMS; index -= 1) {
    const term = selectRecallTerm(tokens[index], seen);
    if (term) terms.push(term);
  }
  return terms;
}

function selectRecallTerm(token, seen) {
  if (/^[A-Za-z]/.test(token)) {
    const lower = token.toLowerCase();
    if (ENGLISH_STOPWORDS.has(lower)) return null;
    if (token.length < 3 && !/[0-9]/.test(token)) return null;
    if (seen.has(`e:${lower}`)) return null;
    seen.add(`e:${lower}`);
    return token;
  }
  if (/^[\p{Script=Han}]/u.test(token)) {
    const seg = token.length > 6 ? token.slice(0, 6) : token;
    if (JAPANESE_STOPWORDS.has(seg)) return null;
    if (seen.has(`c:${seg}`)) return null;
    seen.add(`c:${seg}`);
    return seg;
  }
  if (/^[\p{Script=Katakana}]/u.test(token)) {
    if (seen.has(`k:${token}`)) return null;
    seen.add(`k:${token}`);
    return token;
  }
  return null;
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
  if (Object.prototype.hasOwnProperty.call(changes, "recallUrl")) {
    next.recallUrl = String(changes.recallUrl?.newValue || "").trim();
  }
  if (Object.prototype.hasOwnProperty.call(changes, "recallToken")) {
    next.recallToken = String(changes.recallToken?.newValue || "").trim();
  }
  return next;
}

export function rankRecallHits(hits, { currentConversationUrl = "" } = {}) {
  const currentConversationId = conversationIdFromUrl(currentConversationUrl);
  const candidates = new Map();
  for (const hit of Array.isArray(hits) ? hits : []) {
    const path = String(hit?.path || "");
    if (!path || pathLooksLikeCurrentConversation(path, currentConversationId)) continue;
    const score = Number.isFinite(Number(hit?.score)) ? Number(hit.score) : Number.POSITIVE_INFINITY;
    if (score > RECALL_MIN_SCORE) continue;
    const reasons = Array.isArray(hit?.match_reasons) ? hit.match_reasons.map(String) : [];
    if (!reasons.some((reason) => RECALL_ALLOWED_REASONS.has(reason))) continue;
    const normalized = normalizeRecallHit(hit);
    const existing = candidates.get(path);
    if (!existing) {
      candidates.set(path, normalized);
      continue;
    }
    const merged = mergeRecallHit(existing, normalized);
    if (merged) candidates.set(path, merged);
  }
  return [...candidates.values()]
    .sort((left, right) => {
      const leftKnowledge = left.path.startsWith("/Knowledge/") ? 0 : 1;
      const rightKnowledge = right.path.startsWith("/Knowledge/") ? 0 : 1;
      return leftKnowledge - rightKnowledge || left.score - right.score || left.path.localeCompare(right.path);
    })
    .slice(0, RECALL_RESULT_LIMIT);
}

function mergeRecallHit(existing, incoming) {
  if (existing.kind && incoming.kind && existing.kind !== incoming.kind) return null;
  const preferred = preferredRecallHit(existing, incoming);
  return {
    ...preferred,
    score: Math.min(existing.score, incoming.score),
    matchReasons: [...new Set([...existing.matchReasons, ...incoming.matchReasons])]
  };
}

function preferredRecallHit(left, right) {
  const leftContent = left.previewField === "Content";
  const rightContent = right.previewField === "Content";
  if (leftContent !== rightContent) return leftContent ? left : right;
  if (Boolean(left.snippet) !== Boolean(right.snippet)) return left.snippet ? left : right;
  if (leftContent && rightContent && Number.isFinite(left.score) && Number.isFinite(right.score) && left.score !== right.score) {
    return left.score < right.score ? left : right;
  }
  if (leftContent && rightContent && Number.isInteger(left.charOffset) && Number.isInteger(right.charOffset)) {
    return left.charOffset <= right.charOffset ? left : right;
  }
  return left;
}

export function normalizeRecallHit(hit) {
  const path = String(hit?.path || "");
  const preview = candidOpt(hit?.preview);
  const excerpt = candidOpt(preview?.excerpt);
  const snippet = candidOpt(hit?.snippet);
  const previewField = variantKey(preview?.field);
  return {
    path,
    kind: variantKey(hit?.kind) || "File",
    title: titleFromPath(path),
    snippet: String(excerpt || snippet || "").trim(),
    updatedAt: null,
    sourceUrl: null,
    score: Number.isFinite(Number(hit?.score)) ? Number(hit.score) : Number.POSITIVE_INFINITY,
    matchReasons: Array.isArray(hit?.match_reasons) ? hit.match_reasons.map(String) : [],
    charOffset: previewField === "Content" && Number.isInteger(preview?.char_offset) ? Number(preview.char_offset) : null,
    previewField: previewField || null
  };
}

export function formatRecallContext(result, excerpt) {
  const title = String(result?.title || "Kinic memory").trim() || "Kinic memory";
  const path = String(result?.path || "").trim();
  const source = String(result?.sourceUrl || path).trim();
  const text = String(excerpt || result?.snippet || "").trim().slice(0, RECALL_CONTEXT_MAX_CHARS);
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
