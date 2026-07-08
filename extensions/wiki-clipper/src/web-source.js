// Where: extensions/wiki-clipper/src/web-source.js
// What: Build canonical evidence source nodes from active-page DOM text snapshots.
// Why: Web page capture should save source evidence before queueing generation.
import { sourceStemFromTitleHash } from "./source-filename.js";
import { normalizedHttpUrl } from "./source-capture-request.js";

const MAX_WEB_SOURCE_CHARS = 300_000;

export async function buildWebEvidenceSource(snapshot, now = new Date()) {
  const finalUrl = normalizedHttpUrl(snapshot?.url);
  const text = String(snapshot?.text || "").trim();
  if (!text) {
    throw new Error("page text is empty");
  }
  const sourceText = limitSourceText(text, MAX_WEB_SOURCE_CHARS);
  const title = webSourceTitle(snapshot?.title, finalUrl);
  const sourceId = await webSourceId(finalUrl, title);
  const capturedAt = now.toISOString();
  const content = [
    "---",
    "kind: kinic.evidence_web_source",
    "schema_version: 1",
    `url: ${JSON.stringify(finalUrl)}`,
    `final_url: ${JSON.stringify(finalUrl)}`,
    `title: ${JSON.stringify(title)}`,
    `captured_at: ${JSON.stringify(capturedAt)}`,
    "capture_method: browser_dom",
    `text_chars: ${text.length}`,
    `truncated: ${sourceText.truncated}`,
    `original_chars: ${sourceText.originalChars}`,
    `saved_chars: ${sourceText.savedChars}`,
    "---",
    "",
    `# ${title}`,
    "",
    `Source URL: ${finalUrl}`,
    "",
    sourceText.text,
    ""
  ].join("\n");
  return {
    path: webSourcePathFromId(sourceId),
    sourceId,
    content,
    metadataJson: JSON.stringify({
      source_type: "url",
      url: finalUrl,
      final_url: finalUrl,
      title,
      captured_at: capturedAt,
      capture_method: "browser_dom",
      text_chars: text.length,
      truncated: sourceText.truncated,
      original_chars: sourceText.originalChars,
      saved_chars: sourceText.savedChars
    })
  };
}

export async function webSourcePathForUrl(value, title = "") {
  const finalUrl = normalizedHttpUrl(value);
  return webSourcePathFromId(await webSourceId(finalUrl, webSourceTitle(title, finalUrl)));
}

export function collectWebPageSnapshot() {
  const maxSnapshotChars = 320_000;

  function normalizeExtractedText(value) {
    const ignoredLines = new Set([
      "Article",
      "Go back",
      "Read article",
      "Save your progress",
      "Sign in",
      "Stay organized with collections",
      "Save and categorize content based on your preferences.",
      "Was this helpful?",
      "check_circle",
      "keyboard_arrow_down",
      "keyboard_arrow_up",
      "subject"
    ]);
    const lines = [];
    let fence = null;
    for (const line of String(value)
      .replace(/\r\n?/g, "\n")
      .replace(/\u00a0/g, " ")
      .split("\n")) {
      const openingFence = fence ? null : openingFenceForLine(line);
      const normalized = normalizeExtractedLine(line, ignoredLines, fence !== null || openingFence !== null);
      if (normalized === null) continue;
      const closingFence = fence ? closingFenceForLine(normalized) : null;
      if (fence && closingFence?.marker === fence.marker && closingFence.length >= fence.length) {
        fence = null;
      } else if (!fence && openingFence) {
        fence = openingFence;
      }
      lines.push(normalized);
    }
    return collapseBlankLines(lines).join("\n").trim();
  }

  const excludedSelector = [
    "script",
    "style",
    "noscript",
    "nav",
    "header",
    "footer",
    "aside",
    "form",
    "dialog",
    "[role='navigation']",
    "[role='banner']",
    "[role='contentinfo']",
    "[aria-modal='true']",
    "[class*='banner' i]",
    "[class*='cookie' i]",
    "[class*='feedback' i]",
    "[class*='newsletter' i]",
    "[id*='cookie' i]",
    "[id*='feedback' i]",
    "[id*='newsletter' i]"
  ].join(",");
  const breakAfterSelector = [
    "address",
    "article",
    "blockquote",
    "br",
    "dd",
    "div",
    "dl",
    "dt",
    "figcaption",
    "figure",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "li",
    "main",
    "ol",
    "p",
    "pre",
    "section",
    "table",
    "td",
    "th",
    "tr",
    "ul"
  ].join(",");

  function appendChunk(parts, state, value) {
    if (state.done || !value) return;
    const remaining = maxSnapshotChars - state.length;
    if (remaining <= 0) {
      state.done = true;
      return;
    }
    const chunk = String(value).slice(0, remaining);
    parts.push(chunk);
    state.length += chunk.length;
    state.done = state.length >= maxSnapshotChars;
  }

  function isElementNode(node) {
    return node?.nodeType === 1 || typeof node?.matches === "function" || typeof node?.textContent === "string";
  }

  function isTextNode(node) {
    return node?.nodeType === 3;
  }

  function textFromNode(node, parts, state) {
    if (!node || state.done) return;
    if (isTextNode(node)) {
      appendChunk(parts, state, node.nodeValue || "");
      return;
    }
    if (!isElementNode(node)) return;
    if (typeof node.matches === "function" && node.matches(excludedSelector)) return;
    if (typeof node.matches === "function" && node.matches("pre")) {
      appendChunk(parts, state, markdownCodeBlock(node.textContent || ""));
      return;
    }
    const children = node.childNodes ? Array.from(node.childNodes) : [];
    if (!children.length) {
      appendChunk(parts, state, node.textContent || "");
    } else {
      for (const child of children) {
        textFromNode(child, parts, state);
        if (state.done) break;
      }
    }
    if (!state.done && typeof node.matches === "function" && node.matches(breakAfterSelector)) {
      appendChunk(parts, state, "\n\n");
    }
  }

  function textFrom(element) {
    const parts = [];
    const state = { length: 0, done: false };
    textFromNode(element, parts, state);
    return normalizeExtractedText(parts.join(""));
  }
  const candidates = [...document.querySelectorAll("article,main,[role='main']")];
  let text = candidates.map(textFrom).sort((left, right) => right.length - left.length)[0] || "";
  if (!text && document.body) {
    text = textFrom(document.body);
  }
  return {
    url: location.href,
    title: document.title || "",
    text
  };
}

function normalizeExtractedLine(line, ignoredLines, inFence) {
  if (inFence || openingFenceForLine(line)) return line.trimEnd();
  const normalized = line.trim().replace(/[ \t]{2,}/g, " ");
  if (ignoredLines.has(normalized)) return null;
  return normalized;
}

function openingFenceForLine(line) {
  const match = /^(`{3,}|~{3,})(.*)$/.exec(line.trim());
  if (match?.[1].startsWith("`") && match[2].includes("`")) return null;
  return match ? markdownFence(match[1]) : null;
}

function closingFenceForLine(line) {
  const match = /^(`{3,}|~{3,})[ \t]*$/.exec(line.trim());
  return match ? markdownFence(match[1]) : null;
}

function markdownFence(value) {
  return {
    marker: value.startsWith("`") ? "`" : "~",
    length: value.length
  };
}

function collapseBlankLines(lines) {
  const output = [];
  let previousBlank = true;
  for (const line of lines) {
    const blank = line.length === 0;
    if (blank && previousBlank) continue;
    output.push(line);
    previousBlank = blank;
  }
  while (output.length > 0 && output[output.length - 1] === "") {
    output.pop();
  }
  return output;
}

function markdownCodeBlock(value) {
  const code = String(value).replace(/\r\n?/g, "\n").replace(/^\n+|\n+$/g, "");
  if (!code) return "";
  const longestBacktickRun = Math.max(0, ...[...code.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(Math.max(3, longestBacktickRun + 1));
  return `\n\n${fence}\n${code}\n${fence}\n\n`;
}

async function webSourceId(finalUrl, title) {
  const hash = (await sha256Hex(finalUrl)).slice(0, 8);
  return `web-${sourceStemFromTitleHash(title, hash, hostnameForUrl(finalUrl))}`;
}

function webSourceTitle(value, finalUrl) {
  const title = String(value || "").trim();
  if (title) return title;
  try {
    return new URL(finalUrl).hostname || "web-source";
  } catch {
    return "web-source";
  }
}

function hostnameForUrl(finalUrl) {
  try {
    return new URL(finalUrl).hostname || "web-source";
  } catch {
    return "web-source";
  }
}

function webSourcePathFromId(sourceId) {
  return `/Sources/web/${sourceId.slice("web-".length)}.md`;
}

function limitSourceText(text, maxChars) {
  const originalChars = text.length;
  if (originalChars <= maxChars) {
    return { text, truncated: false, originalChars, savedChars: originalChars };
  }
  const limited = text.slice(0, maxChars).trimEnd();
  return { text: limited, truncated: true, originalChars, savedChars: limited.length };
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
