// Where: extensions/wiki-clipper/src/raw-source.js
// What: Convert captured conversations into canonical raw source nodes.
// Why: The canister expects source evidence under /Sources/raw/<id>/<id>.md.
export function buildRawSource(capture, now = new Date()) {
  if (!capture.messages || capture.messages.length === 0) {
    throw new Error("no conversation messages found");
  }
  const sourceId = sourceIdForCapture(capture, now);
  const path = `/Sources/raw/${sourceId}/${sourceId}.md`;
  const metadata = {
    provider: capture.provider,
    source_url: capture.url,
    conversation_id: conversationIdFromUrl(capture.url),
    conversation_title: capture.conversationTitle,
    captured_at: capture.capturedAt,
    message_count: capture.messages.length,
    source_id: sourceId
  };
  return {
    path,
    sourceId,
    content: rawMarkdown(capture),
    metadataJson: JSON.stringify(metadata)
  };
}

function sourceIdForCapture(capture, now) {
  const provider = slug(capture.provider || "conversation");
  const conversationId = conversationIdFromUrl(capture.url);
  if (capture.provider === "chatgpt" && conversationId) {
    return `${provider}-${slug(conversationId)}`;
  }
  const title = slug(capture.conversationTitle || "untitled");
  const date = now.toISOString().slice(0, 10).replace(/-/g, "");
  const fingerprint = hashText(`${capture.url}\n${capture.conversationTitle}`);
  return `${provider}-${date}-${title}-${fingerprint}`.slice(0, 96);
}

function conversationIdFromUrl(value) {
  try {
    const url = new URL(value);
    const match = url.pathname.match(/^\/c\/([^/]+)/);
    return match?.[1] || "";
  } catch {
    return "";
  }
}

function rawMarkdown(capture) {
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
    "",
    "## Chat",
    ""
  ];
  capture.messages.forEach((message, index) => {
    lines.push(`### Turn ${String(index + 1).padStart(4, "0")}`);
    lines.push("");
    lines.push(`- role: ${message.role}`);
    lines.push("");
    lines.push(message.content.trim());
    lines.push("");
  });
  return `${lines.join("\n").trimEnd()}\n`;
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

function hashText(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
