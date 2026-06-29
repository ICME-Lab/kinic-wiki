// Where: extensions/wiki-clipper/src/source-filename.js
// What: Build canonical title+hash source filename stems.
// Why: Conversation and web source paths must share the same Unicode-safe rules.
const MAX_SOURCE_STEM_BYTES = 128;
const SOURCE_STEM_ENCODER = new TextEncoder();

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

export function hashText(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function truncateStem(stem, hash) {
  if (byteLength(stem) <= MAX_SOURCE_STEM_BYTES) return stem;
  const suffix = `-${hash}`;
  const maxPrefixBytes = MAX_SOURCE_STEM_BYTES - byteLength(suffix);
  let prefix = "";
  for (const char of stem.slice(0, -suffix.length)) {
    if (byteLength(`${prefix}${char}`) > maxPrefixBytes) break;
    prefix += char;
  }
  const trimmed = prefix.replace(/[._-]+$/g, "") || "source";
  return `${trimmed}${suffix}`;
}

function safeHash8(value) {
  const hash = String(value || "").toLowerCase();
  return /^[a-f0-9]{8}$/.test(hash) ? hash : hashText(hash).slice(0, 8);
}

function byteLength(value) {
  return SOURCE_STEM_ENCODER.encode(value).length;
}

function isSourceStemChar(value) {
  return isUnicodeAlphanumeric(value) || value === "." || value === "_" || value === "-";
}

function isUnicodeAlphanumeric(value) {
  return /^[\p{L}\p{N}]$/u.test(value);
}
