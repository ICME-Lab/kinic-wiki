// Where: extensions/wiki-clipper/src/claude-response.js
// What: Read Claude sidebar/API data and convert it into raw-source captures.
// Why: Claude does not expose a public history export API, so export uses the signed-in claude.ai session.

const CLAUDE_API_ORIGIN = "https://claude.ai/api";
const ORG_ID_PATTERN = /^[a-f0-9-]{36}$/i;

export async function fetchClaudeConversationTargets(limit, doc = document, loc = location) {
  const targets = collectClaudeConversationTargets(limit, doc, loc);
  if (targets.length >= limit) return targets;
  const container = findClaudeHistoryScrollContainer(doc);
  if (!container) return targets;
  let stableRounds = 0;
  let previousCount = targets.length;
  for (let round = 0; round < 8 && targets.length < limit; round += 1) {
    container.scrollTop = container.scrollHeight;
    await new Promise((resolve) => setTimeout(resolve, 250));
    const nextTargets = collectClaudeConversationTargets(limit, doc, loc);
    targets.splice(0, targets.length, ...nextTargets);
    if (targets.length === previousCount) stableRounds += 1;
    else stableRounds = 0;
    previousCount = targets.length;
    if (stableRounds >= 2) break;
  }
  return targets;
}

export function collectClaudeConversationTargets(limit, doc = document, loc = location) {
  const targets = [];
  const seen = new Set();
  const current = currentClaudeConversationTarget(loc, doc);
  if (current) {
    targets.push(current);
    seen.add(current.id);
  }
  const anchors = doc.querySelectorAll('a[href*="/chat/"]');
  for (const anchor of Array.from(anchors)) {
    const id = claudeConversationIdFromUrl(anchor.getAttribute("href") || anchor.href || "", loc);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    targets.push({
      id,
      title: titleFromAnchor(anchor),
      url: new URL(`/chat/${id}`, loc.origin).toString()
    });
    if (targets.length >= limit) break;
  }
  return targets.slice(0, limit);
}

export async function fetchClaudeConversationCapture(target, fetchImpl = fetch) {
  try {
    const organizationId = target.organizationId || resolveClaudeOrganizationId();
    if (!organizationId) {
      throw new Error("Claude organization id was not found. Reload Claude and try again.");
    }
    const url = `${CLAUDE_API_ORIGIN}/organizations/${organizationId}/chat_conversations/${encodeURIComponent(
      target.id
    )}?tree=True&rendering_mode=messages&render_all_tools=true&consistency=strong`;
    const response = await fetchImpl(url, {
      method: "GET",
      credentials: "include",
      headers: { Accept: "application/json" }
    });
    if (!response.ok) {
      throw new Error(`Claude API failed: ${response.status}`);
    }
    const payload = await response.json();
    const capture = captureFromClaudeResponse(payload, target.url, target.title);
    capture.captureMethod = "claude private api";
    if (capture.messages.length === 0) {
      return { ok: false, target, error: "no conversation messages found" };
    }
    return { ok: true, target, capture };
  } catch (error) {
    return { ok: false, target, error: error instanceof Error ? error.message : String(error) };
  }
}

export function captureFromClaudeResponse(payload, url, fallbackTitle = "Untitled conversation", capturedAt = new Date().toISOString()) {
  return {
    provider: "claude",
    conversationTitle: titleFromPayload(payload, fallbackTitle),
    url,
    capturedAt,
    messages: messagesFromClaudePayload(payload)
  };
}

export function messagesFromClaudePayload(payload) {
  const messages = [];
  for (const item of claudeMessages(payload)) {
    const role = normalizeClaudeRole(item?.sender ?? item?.role ?? item?.author?.role);
    if (!role) continue;
    const content = claudeMessageContent(item);
    if (!content) continue;
    messages.push({ role, content });
  }
  return messages;
}

export function resolveClaudeOrganizationId(performanceObject = globalThis.performance, storage = globalThis.localStorage) {
  const resourceId = organizationIdFromPerformance(performanceObject);
  if (resourceId) return resourceId;
  return organizationIdFromStorage(storage);
}

export function claudeConversationIdFromUrl(value, loc = location) {
  try {
    const url = new URL(value, loc.origin);
    const match = url.pathname.match(/^\/chat\/([^/]+)\/?$/);
    return match ? decodeURIComponent(match[1]) : "";
  } catch {
    return "";
  }
}

function organizationIdFromPerformance(performanceObject) {
  try {
    const entries = performanceObject?.getEntriesByType?.("resource") || [];
    for (const entry of entries) {
      const match = String(entry?.name || "").match(/\/organizations\/([a-f0-9-]{36})\//i);
      if (match?.[1]) return match[1];
    }
  } catch {}
  return "";
}

function organizationIdFromStorage(storage) {
  try {
    for (const key of ["organization_uuid", "organizationUuid", "claude_organization_uuid"]) {
      const value = storage?.getItem?.(key);
      if (isOrganizationId(value)) return value.trim();
    }
    for (let index = 0; index < (storage?.length || 0); index += 1) {
      const key = storage.key(index);
      if (!key || !/org/i.test(key)) continue;
      const value = storage.getItem(key);
      const fromJson = organizationIdFromJson(value);
      if (fromJson) return fromJson;
      if (isOrganizationId(value)) return value.trim();
    }
    return organizationIdFromJson(storage?.getItem?.("ajs_user_traits"));
  } catch {
    return "";
  }
}

function organizationIdFromJson(value) {
  if (!value) return "";
  try {
    const parsed = JSON.parse(value);
    const id = parsed?.organization_uuid ?? parsed?.organizationUuid ?? parsed?.organization_id;
    return isOrganizationId(id) ? id.trim() : "";
  } catch {
    return "";
  }
}

function isOrganizationId(value) {
  return typeof value === "string" && ORG_ID_PATTERN.test(value.trim());
}

function findClaudeHistoryScrollContainer(doc) {
  const candidates = doc.querySelectorAll("nav, aside, [role='navigation'], [class*='sidebar'], [class*='overflow-y']");
  for (const candidate of Array.from(candidates)) {
    if (candidate.scrollHeight > candidate.clientHeight && candidate.querySelector?.('a[href*="/chat/"]')) {
      return candidate;
    }
  }
  return null;
}

function currentClaudeConversationTarget(loc, doc) {
  const id = claudeConversationIdFromUrl(loc.href || "", loc);
  if (!id) return null;
  return {
    id,
    title: doc?.title || "Current conversation",
    url: new URL(`/chat/${id}`, loc.origin).toString()
  };
}

function titleFromAnchor(anchor) {
  const text = anchor.textContent?.replace(/\s+/g, " ").trim() || "";
  const title = anchor.getAttribute?.("title")?.trim() || "";
  return text || title || "Untitled conversation";
}

function titleFromPayload(payload, fallbackTitle) {
  const chat = payload?.chat ?? payload;
  const title = chat?.name ?? chat?.title ?? payload?.name ?? payload?.title;
  return typeof title === "string" && title.trim() ? title.trim() : fallbackTitle;
}

function claudeMessages(payload) {
  const chat = payload?.chat ?? payload;
  const messages = chat?.chat_messages ?? payload?.chat_messages ?? chat?.message_tree?.nodes ?? [];
  return Array.isArray(messages) ? messages : [];
}

function normalizeClaudeRole(role) {
  const value = String(role || "").toLowerCase();
  if (value === "user" || value === "human") return "user";
  if (value === "assistant" || value === "model" || value === "claude") return "assistant";
  if (value === "system") return "system";
  return null;
}

function claudeMessageContent(message) {
  const parts = [];
  appendText(parts, message?.text);
  appendContent(parts, message?.content);
  appendContent(parts, message?.blocks);
  for (const attachment of Array.isArray(message?.attachments) ? message.attachments : []) {
    appendText(parts, attachment?.extracted_content);
  }
  return normalizeText(parts.join("\n\n"));
}

function appendContent(parts, content) {
  if (typeof content === "string") {
    appendText(parts, content);
    return;
  }
  if (!Array.isArray(content)) return;
  for (const item of content) {
    appendText(parts, item?.text);
    appendText(parts, item?.content);
  }
}

function appendText(parts, value) {
  if (typeof value === "string" && value.trim()) {
    parts.push(value.trim());
  }
}

function normalizeText(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
