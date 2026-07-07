// Where: workers/wiki-generator/src/url-fetch.ts
// What: Bounded URL fetching and simple text extraction for wiki ingest.
// Why: Browser-side CORS should not block source capture, and worker memory must stay bounded.
export type FetchedUrlSource = {
  url: string;
  finalUrl: string;
  title: string | null;
  contentType: string;
  text: string;
  fetchedTruncated: boolean;
  fetchedBytes: number;
  maxFetchedBytes: number;
};

const ACCEPTED_CONTENT_TYPES = ["text/html", "text/plain", "text/markdown", "text/x-markdown"];
const MAX_REDIRECTS = 5;

export async function fetchUrlSource(urlText: string, maxBytes: number): Promise<FetchedUrlSource> {
  const firstUrl = parseAllowedUrl(urlText);
  const { response, finalUrl } = await fetchAllowedUrl(firstUrl);
  if (!response.ok) {
    throw new Error(`URL fetch failed with ${response.status}`);
  }
  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!ACCEPTED_CONTENT_TYPES.includes(contentType)) {
    throw new Error(`unsupported content-type: ${contentType || "unknown"}`);
  }
  const raw = await readTextLimited(response, maxBytes);
  const extracted = contentType === "text/html" ? extractHtmlText(raw.text) : { title: firstMarkdownTitle(raw.text), text: raw.text };
  return {
    url: firstUrl.toString(),
    finalUrl: finalUrl.toString(),
    title: extracted.title,
    contentType,
    text: normalizeWhitespace(extracted.text),
    fetchedTruncated: raw.truncated,
    fetchedBytes: raw.bytes,
    maxFetchedBytes: maxBytes
  };
}

export function parseAllowedUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("url is invalid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("url must use http or https");
  }
  if (isBlockedHostname(url.hostname)) {
    throw new Error("url hostname is not allowed");
  }
  url.hash = "";
  return url;
}

async function fetchAllowedUrl(firstUrl: URL): Promise<{ response: Response; finalUrl: URL }> {
  let currentUrl = firstUrl;
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const response = await fetch(currentUrl.toString(), {
      redirect: "manual",
      headers: {
        accept: "text/html,text/plain,text/markdown;q=0.9,*/*;q=0.1",
        "user-agent": "kinic-wiki-generator/1.0"
      }
    });
    if (!isRedirectStatus(response.status)) {
      return { response, finalUrl: currentUrl };
    }
    if (redirectCount === MAX_REDIRECTS) {
      throw new Error("too many redirects");
    }
    const location = response.headers.get("location");
    if (!location) {
      throw new Error("redirect missing location");
    }
    currentUrl = parseAllowedUrl(new URL(location, currentUrl.toString()).toString());
  }
  throw new Error("too many redirects");
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function readTextLimited(response: Response, maxBytes: number): Promise<{ text: string; truncated: boolean; bytes: number }> {
  if (!response.body) return { text: "", truncated: false, bytes: 0 };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    if (!result.value) continue;
    const remaining = maxBytes - total;
    if (remaining <= 0) {
      truncated = true;
      await reader.cancel();
      break;
    }
    if (result.value.byteLength > remaining) {
      chunks.push(result.value.slice(0, remaining));
      total = maxBytes;
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(result.value);
    total += result.value.byteLength;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(bytes), truncated, bytes: total };
}

function extractHtmlText(html: string): { title: string | null; text: string } {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? null;
  const preBlocks: string[] = [];
  const body = stripRawTextElements(html)
    .replace(/<head\b[\s\S]*?<\/head>/gi, " ")
    .replace(/<(nav|footer|header|aside)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_match, code: string) => {
      const placeholder = `KINIC_PRE_BLOCK_${preBlocks.length}_`;
      preBlocks.push(markdownCodeBlock(htmlTextContent(code)));
      return `\n\n${placeholder}\n\n`;
    })
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|p|div|section|article|h[1-6]|li)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  const text = restorePreBlocks(decodeEntities(body), preBlocks);
  return {
    title: title ? decodeEntities(normalizeWhitespace(title)) : null,
    text
  };
}

function stripRawTextElements(html: string): string {
  return html
    .replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(script|style|noscript)\b[\s\S]*$/gi, " ");
}

function firstMarkdownTitle(text: string): string | null {
  const line = text.split("\n").find((item) => item.startsWith("# "));
  return line ? line.slice(2).trim() : null;
}

function normalizeWhitespace(value: string): string {
  const lines: string[] = [];
  let fenceLength = 0;
  for (const line of value
    .replace(/\r\n?/g, "\n")
    .split("\n")) {
    const normalized = fenceLength > 0 || fenceLineLength(line) >= 3 ? line.trimEnd() : line.trim().replace(/[ \t]+/g, " ");
    const nextFenceLength = fenceLineLength(normalized);
    if (fenceLength > 0 && nextFenceLength >= fenceLength) {
      fenceLength = 0;
    } else if (fenceLength === 0 && nextFenceLength >= 3) {
      fenceLength = nextFenceLength;
    }
    lines.push(normalized);
  }
  return collapseBlankLines(lines).join("\n").trim();
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function htmlTextContent(value: string): string {
  return decodeEntities(value.replace(/<br\b[^>]*>/gi, "\n").replace(/<[^>]+>/g, ""));
}

function restorePreBlocks(value: string, preBlocks: string[]): string {
  return preBlocks.reduce((text, block, index) => text.replaceAll(`KINIC_PRE_BLOCK_${index}_`, block), value);
}

function markdownCodeBlock(value: string): string {
  const code = value.replace(/\r\n?/g, "\n").replace(/^\n+|\n+$/g, "");
  if (!code) return "";
  const longestBacktickRun = Math.max(0, ...[...code.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(Math.max(3, longestBacktickRun + 1));
  return `${fence}\n${code}\n${fence}`;
}

function collapseBlankLines(lines: string[]): string[] {
  const output: string[] = [];
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

function fenceLineLength(line: string): number {
  const match = /^(`{3,})$/.exec(line.trim());
  return match ? match[1].length : 0;
}

function isBlockedHostname(hostname: string): boolean {
  // DNS resolution is not inspected here. This Worker assumes public Cloudflare
  // fetch egress; move to an allowlist or DNS-result IP checks for a stricter
  // security boundary.
  const normalized = hostname.toLowerCase();
  if (normalized.startsWith("[") || normalized.includes(":")) return true;
  if (normalized === "localhost" || normalized.endsWith(".localhost") || normalized.endsWith(".local")) return true;
  const ipv4 = parseIpv4(normalized);
  return ipv4 ? isBlockedIpv4(ipv4) : false;
}

function parseIpv4(hostname: string): [number, number, number, number] | null {
  const ipv4 = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!ipv4) return null;
  const octets = [Number(ipv4[1]), Number(ipv4[2]), Number(ipv4[3]), Number(ipv4[4])];
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null;
  return [octets[0], octets[1], octets[2], octets[3]];
}

function isBlockedIpv4([first, second, third]: [number, number, number, number]): boolean {
  if (first === 0 || first === 10 || first === 127) return true;
  if (first === 100 && second >= 64 && second <= 127) return true;
  if (first === 169 && second === 254) return true;
  if (first === 172 && second >= 16 && second <= 31) return true;
  if (first === 192 && second === 0) return true;
  if (first === 192 && second === 168) return true;
  if (first === 192 && second === 0 && third === 2) return true;
  if (first === 198 && (second === 18 || second === 19)) return true;
  if (first === 198 && second === 51 && third === 100) return true;
  if (first === 203 && second === 0 && third === 113) return true;
  if (first >= 224) return true;
  return false;
}
