// Where: extensions/wiki-clipper/src/web-source.js
// What: Build canonical evidence source nodes from active-page DOM text snapshots.
// Why: Web page capture should save source evidence before queueing generation.
import { normalizedHttpUrl } from "./source-capture-request.js";

const MAX_WEB_SOURCE_CHARS = 300_000;

export async function buildWebEvidenceSource(snapshot, now = new Date()) {
  const finalUrl = normalizedHttpUrl(snapshot?.url);
  const sourceId = await webSourceId(finalUrl);
  const text = String(snapshot?.text || "").trim();
  if (!text) {
    throw new Error("page text is empty");
  }
  const sourceText = limitSourceText(text, MAX_WEB_SOURCE_CHARS);
  const title = webSourceTitle(snapshot?.title, finalUrl);
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

export async function webSourcePathForUrl(value) {
  const finalUrl = normalizedHttpUrl(value);
  return webSourcePathFromId(await webSourceId(finalUrl));
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
    const lines = String(value)
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => !ignoredLines.has(line));
    return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
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

async function webSourceId(finalUrl) {
  return `web-${(await sha256Hex(finalUrl)).slice(0, 16)}`;
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
