// Where: extensions/wiki-clipper/src/evidence-source.js
// What: Convert captured conversations into canonical evidence source nodes.
// Why: Evidence source is grouped by provider under /Sources/<provider>/<id>.md.
import { hashText, sourceStemFromTitleHash } from "./source-filename.js";

const MAX_CONVERSATION_SOURCE_CHARS = 300_000;

export function buildEvidenceSource(capture, now = new Date()) {
  if (!capture.messages || capture.messages.length === 0) {
    throw new Error("no conversation messages found");
  }
  const provider = safeProvider(capture.provider || "conversation");
  const sourceId = sourceIdForCapture(capture, provider);
  const sourceStem = sourceId.slice(provider.length + 1);
  const path = `/Sources/${provider}/${sourceStem}.md`;
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

function sourceIdForCapture(capture, provider = safeProvider(capture.provider || "conversation")) {
  const identity = canonicalConversationIdentity(capture, provider);
  const fingerprint = hashText(identity);
  const stem = sourceStemFromTitleHash(capture.conversationTitle, fingerprint, provider);
  return `${provider}-${stem}`;
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

function canonicalConversationIdentity(capture, provider) {
  const conversationId = conversationIdFromUrl(capture.url);
  if (conversationId) return `${provider}:${conversationId}`;
  return `${provider}:${normalizedUrlWithoutHash(capture.url)}`;
}

function normalizedUrlWithoutHash(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.toString();
  } catch {
    return String(value || "");
  }
}

function rawMarkdown(capture, sourceText) {
  const lines = [
    "# Evidence Conversation Source",
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

function safeProvider(value) {
  const normalized = String(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
  return /^[a-z][a-z0-9]{0,31}$/.test(normalized) ? normalized : "conversation";
}
