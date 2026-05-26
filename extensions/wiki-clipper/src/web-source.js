// Where: extensions/wiki-clipper/src/web-source.js
// What: Build canonical raw source nodes from active-page DOM text snapshots.
// Why: Web page capture should save source evidence before queueing generation.
import { normalizedHttpUrl } from "./url-ingest-request.js";

export async function buildWebRawSource(snapshot, now = new Date()) {
  const finalUrl = normalizedHttpUrl(snapshot?.url);
  const sourceId = await webSourceId(finalUrl);
  const text = String(snapshot?.text || "").trim();
  if (!text) {
    throw new Error("page text is empty");
  }
  const title = String(snapshot?.title || new URL(finalUrl).hostname).trim() || finalUrl;
  const capturedAt = now.toISOString();
  const content = [
    "---",
    "kind: kinic.raw_web_source",
    "schema_version: 1",
    `url: ${JSON.stringify(finalUrl)}`,
    `final_url: ${JSON.stringify(finalUrl)}`,
    `title: ${JSON.stringify(title)}`,
    `captured_at: ${JSON.stringify(capturedAt)}`,
    "capture_method: browser_dom",
    `text_chars: ${text.length}`,
    "---",
    "",
    `# ${title}`,
    "",
    `Source URL: ${finalUrl}`,
    "",
    text,
    ""
  ].join("\n");
  return {
    path: `/Sources/raw/web/${sourceId.slice("web-".length)}.md`,
    sourceId,
    content,
    metadataJson: JSON.stringify({
      source_type: "url",
      url: finalUrl,
      final_url: finalUrl,
      title,
      captured_at: capturedAt,
      capture_method: "browser_dom",
      text_chars: text.length
    })
  };
}

export function collectWebPageSnapshot() {
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
      .split(/\n+/)
      .map((line) => line.trim())
      .filter((line) => line && !ignoredLines.has(line));
    return lines.join("\n").trim();
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
  function textFrom(element) {
    const clone = element.cloneNode(true);
    clone.querySelectorAll(excludedSelector).forEach((node) => node.remove());
    clone.querySelectorAll(breakAfterSelector).forEach((node) => node.append("\n"));
    return normalizeExtractedText(clone.textContent || "");
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

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
