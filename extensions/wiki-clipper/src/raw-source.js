// Where: extensions/wiki-clipper/src/raw-source.js
// What: Convert captured conversations into canonical raw source nodes.
// Why: Raw source evidence is grouped by provider under /Sources/raw/<provider>/<id>.md.
const MAX_CONVERSATION_SOURCE_CHARS = 300_000;

export function buildRawSource(capture, now = new Date()) {
  if (!capture.messages || capture.messages.length === 0) {
    throw new Error("no conversation messages found");
  }
  const provider = safeProvider(capture.provider || "conversation");
  const sourceId = sourceIdForCapture(capture, now, provider);
  const path = `/Sources/raw/${provider}/${sourceFileStemForCapture(capture, sourceId)}.md`;
  const metadata = {
    provider: capture.provider,
    source_url: capture.url,
    conversation_id: conversationIdFromUrl(capture.url),
    conversation_title: capture.conversationTitle,
    captured_at: capture.capturedAt,
    message_count: capture.messages.length,
    source_id: sourceId,
    truncated: false,
    original_chars: 0,
    saved_chars: 0
  };
  const sourceText = limitSourceText(conversationMarkdown(capture.messages), MAX_CONVERSATION_SOURCE_CHARS);
  metadata.truncated = sourceText.truncated;
  metadata.original_chars = sourceText.originalChars;
  metadata.saved_chars = sourceText.savedChars;
  return {
    path,
    sourceId,
    content: rawMarkdown(capture, sourceText),
    metadataJson: JSON.stringify(metadata)
  };
}

function sourceIdForCapture(capture, now, provider = safeProvider(capture.provider || "conversation")) {
  const conversationId = conversationIdFromUrl(capture.url);
  if ((capture.provider === "chatgpt" || capture.provider === "claude") && conversationId) {
    return `${provider}-${safeSourceStem(slug(conversationId))}`;
  }
  const title = slug(capture.conversationTitle || "untitled");
  const date = now.toISOString().slice(0, 10).replace(/-/g, "");
  const fingerprint = hashText(`${capture.url}\n${capture.conversationTitle}`);
  return `${provider}-${safeSourceStem(`${date}-${title}-${fingerprint}`)}`;
}

function sourceFileStemForCapture(capture, sourceId) {
  const conversationId = conversationIdFromUrl(capture.url);
  if ((capture.provider === "chatgpt" || capture.provider === "claude") && conversationId) {
    return safeSourceStem(slug(conversationId));
  }
  const provider = safeProvider(capture.provider || "conversation");
  return safeSourceStem(sourceId.startsWith(`${provider}-`) ? sourceId.slice(provider.length + 1) : sourceId);
}

function conversationIdFromUrl(value) {
  try {
    const url = new URL(value);
    const match = url.pathname.match(/^\/(?:c|chat)\/([^/]+)/);
    return match?.[1] || "";
  } catch {
    return "";
  }
}

function rawMarkdown(capture, sourceText) {
  const lines = [
    "# Raw Conversation Source",
    "",
    "## Metadata",
    "",
    `- provider: ${metadataValue(capture.provider)}`,
    `- source_url: ${metadataValue(capture.url)}`,
    `- captured_at: ${metadataValue(capture.capturedAt)}`,
    `- conversation_title: ${metadataValue(capture.conversationTitle)}`,
    `- message_count: ${capture.messages.length}`,
    `- truncated: ${sourceText.truncated}`,
    `- original_chars: ${sourceText.originalChars}`,
    `- saved_chars: ${sourceText.savedChars}`,
    "",
    "## Chat",
    "",
    sourceText.text
  ];
  return `${lines.join("\n").trimEnd()}\n`;
}

function conversationMarkdown(messages) {
  const lines = [];
  messages.forEach((message, index) => {
    lines.push(`### Turn ${String(index + 1).padStart(4, "0")}`);
    lines.push("");
    lines.push(`- role: ${message.role}`);
    lines.push("");
    lines.push(message.content.trim());
    lines.push("");
  });
  return `${lines.join("\n").trimEnd()}\n`;
}

function limitSourceText(text, maxChars) {
  const originalChars = text.length;
  if (originalChars <= maxChars) {
    return { text, truncated: false, originalChars, savedChars: originalChars };
  }
  const limited = text.slice(0, maxChars).trimEnd();
  return { text: limited, truncated: true, originalChars, savedChars: limited.length };
}

function metadataValue(value) {
  return JSON.stringify(String(value || ""));
}

function slug(value) {
  const normalized = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "untitled";
}

function safeProvider(value) {
  const normalized = String(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
  return /^[a-z][a-z0-9]{0,31}$/.test(normalized) ? normalized : "conversation";
}

function safeSourceStem(value) {
  const normalized = String(value)
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/\.{2,}/g, "-")
    .replace(/^-+|-+$/g, "") || "source";
  if (normalized.length <= 128) return normalized;
  return `${normalized.slice(0, 119)}-${hashText(normalized)}`;
}

function hashText(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
