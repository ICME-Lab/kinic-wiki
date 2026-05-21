// Where: extensions/wiki-clipper/src/chatgpt-response.js
// What: Convert ChatGPT conversation API responses into raw-source captures.
// Why: Direct API export needs stable mapping/current_node conversion.

export function conversationIdFromUrl(value) {
  try {
    const url = new URL(value, location.href);
    const match = url.pathname.match(/^\/c\/([^/]+)/);
    return match?.[1] || "";
  } catch {
    return "";
  }
}

export function captureFromChatGptResponse(payload, url, capturedAt = new Date().toISOString()) {
  return {
    provider: "chatgpt",
    conversationTitle: titleFromPayload(payload),
    url,
    capturedAt,
    messages: messagesFromMapping(payload.mapping, payload.current_node)
  };
}

export function messagesFromMapping(mapping, currentNode) {
  const orderedIds = pathToCurrentNode(mapping, currentNode);
  const messages = [];
  for (const id of orderedIds) {
    const node = mapping[id];
    const message = node?.message;
    if (!message) continue;
    const role = normalizeRole(message.author?.role);
    const content = contentFromMessage(message);
    if (!content || (role !== "user" && content.length === 0)) continue;
    if ((role === "assistant" || role === "system") && content.length === 0) continue;
    messages.push({ role, content });
  }
  return messages;
}

function pathToCurrentNode(mapping, currentNode) {
  if (!mapping || typeof mapping !== "object") return [];
  if (currentNode && mapping[currentNode]) {
    const path = [];
    const seen = new Set();
    let next = currentNode;
    while (next && mapping[next] && !seen.has(next)) {
      seen.add(next);
      path.push(next);
      next = mapping[next].parent;
    }
    return path.reverse();
  }
  return Object.keys(mapping);
}

function titleFromPayload(payload) {
  const title = typeof payload.title === "string" ? payload.title.trim() : "";
  return title || "Untitled conversation";
}

function contentFromMessage(message) {
  const parts = message.content?.parts;
  if (Array.isArray(parts)) {
    return normalizeText(parts.filter((part) => typeof part === "string").join("\n"));
  }
  if (typeof message.content?.text === "string") {
    return normalizeText(message.content.text);
  }
  return "";
}

function normalizeRole(role) {
  if (role === "user" || role === "assistant" || role === "system") return role;
  return "assistant";
}

function normalizeText(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}
