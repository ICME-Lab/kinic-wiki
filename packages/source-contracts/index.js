const MAX_SOURCE_STEM_BYTES = 128;
const SOURCE_CAPTURE_REQUEST_PREFIX = "/Sources/source-capture-requests/";
const UTF8_ENCODER = new TextEncoder();

export function sourceStemFromTitleHash(title, hash8, fallback = "source") {
  const hash = safeHash8(hash8);
  const slug = slugTitle(title, fallback);
  return truncateStem(`${slug}-${hash}`, hash);
}

export function slugTitle(value, fallback = "source") {
  const source = String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .trim();
  let output = "";
  let lastWasDash = false;
  for (const char of source) {
    if (isSourceStemChar(char)) {
      output += char;
      lastWasDash = false;
    } else if (!lastWasDash) {
      output += "-";
      lastWasDash = true;
    }
  }
  const normalized = output
    .replace(/\.{2,}/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "");
  if (normalized && isUnicodeAlphanumeric([...normalized][0])) return normalized;
  return slugTitle(fallback && fallback !== value ? fallback : "source", "source");
}

export function fnv1a32(value) {
  const text = String(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function fnv1aHex(value) {
  return fnv1a32(value).toString(16).padStart(8, "0");
}

export function fnv1aBase36(value) {
  return fnv1a32(value).toString(36).padStart(7, "0");
}

export async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", UTF8_ENCODER.encode(String(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function hostnameForUrl(value, fallback = "web-source") {
  try {
    return new URL(value).hostname || fallback;
  } catch {
    return fallback;
  }
}

export function isSafeSourceCaptureRequestId(value) {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 128 &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) &&
    !value.includes("..") &&
    !value.includes("/") &&
    !value.includes("\\")
  );
}

export function sourceCaptureRequestId(timeMs, suffix) {
  const trimmedSuffix = String(suffix).trim();
  if (!isSafeSourceCaptureRequestId(trimmedSuffix) || trimmedSuffix.length > 96) {
    throw new Error("source capture request id is invalid.");
  }
  const requestId = `${timeMs}-${trimmedSuffix}`;
  if (!isSafeSourceCaptureRequestId(requestId)) {
    throw new Error("source capture request id is invalid.");
  }
  return requestId;
}

export function sourceCaptureRequestPath(requestId) {
  if (!isSafeSourceCaptureRequestId(requestId)) {
    throw new Error("source capture request id is invalid.");
  }
  return `${SOURCE_CAPTURE_REQUEST_PREFIX}${requestId}.md`;
}

export function isSourceCaptureRequestPath(path) {
  if (typeof path !== "string" || !path.startsWith(SOURCE_CAPTURE_REQUEST_PREFIX)) return false;
  const filename = path.slice(SOURCE_CAPTURE_REQUEST_PREFIX.length);
  if (!filename.endsWith(".md")) return false;
  return isSafeSourceCaptureRequestId(filename.slice(0, -3));
}

function truncateStem(stem, hash) {
  if (utf8ByteLength(stem) <= MAX_SOURCE_STEM_BYTES) return stem;
  const suffix = `-${hash}`;
  const maxPrefixBytes = MAX_SOURCE_STEM_BYTES - utf8ByteLength(suffix);
  let prefix = "";
  for (const char of stem.slice(0, -suffix.length)) {
    if (utf8ByteLength(`${prefix}${char}`) > maxPrefixBytes) break;
    prefix += char;
  }
  const trimmed = prefix.replace(/[._-]+$/g, "") || "source";
  return `${trimmed}${suffix}`;
}

function safeHash8(value) {
  const hash = String(value || "").toLowerCase();
  return /^[a-f0-9]{8}$/.test(hash) ? hash : fnv1aHex(hash).slice(0, 8);
}

function utf8ByteLength(value) {
  return UTF8_ENCODER.encode(value).length;
}

function isSourceStemChar(value) {
  return isUnicodeAlphanumeric(value) || value === "." || value === "_" || value === "-";
}

function isUnicodeAlphanumeric(value) {
  return /^[\p{L}\p{N}]$/u.test(value);
}
