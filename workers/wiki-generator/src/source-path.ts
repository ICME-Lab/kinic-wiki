// Where: workers/wiki-generator/src/source-path.ts
// What: Canonical evidence source path validation.
// Why: The worker must mirror canister source path rules before queueing work.
const RESERVED_SOURCE_PROVIDERS = new Set(["raw", "sessions", "skill-runs", "source-capture-requests", "ingest-requests"]);
const MAX_SOURCE_STEM_BYTES = 128;
const SOURCE_STEM_ENCODER = new TextEncoder();

export function validateCanonicalSourcePath(path: string, prefix: string): void {
  const boundary = `${prefix}/`;
  if (!path.startsWith(boundary)) {
    throw new Error(`sourcePath must be under ${prefix}`);
  }
  const parts = path.slice(boundary.length).split("/");
  if (
    parts.length !== 2 ||
    !isSafeProviderSegment(parts[0]) ||
    RESERVED_SOURCE_PROVIDERS.has(parts[0] ?? "") ||
    !isSafeMarkdownFile(parts[1])
  ) {
    throw new Error(`sourcePath must use ${prefix}/<provider>/<id>.md`);
  }
}

export function sourceIdFromPath(path: string, prefix: string): string {
  validateCanonicalSourcePath(path, prefix);
  const [provider, fileName] = path.slice(`${prefix}/`.length).split("/");
  return `${provider}-${fileName?.slice(0, -".md".length)}`;
}

function isSafeProviderSegment(value: string | undefined): boolean {
  return /^[a-z0-9]{1,32}$/.test(value ?? "");
}

function isSafeMarkdownFile(value: string | undefined): boolean {
  const fileName = value ?? "";
  if (!fileName.endsWith(".md")) return false;
  const stem = fileName.slice(0, -".md".length);
  return isSafeSourceStem(stem);
}

function isSafeSourceStem(value: string): boolean {
  const chars = [...value];
  if (chars.length === 0 || SOURCE_STEM_ENCODER.encode(value).length > MAX_SOURCE_STEM_BYTES || value.includes("..")) return false;
  const [first, ...rest] = chars;
  return isUnicodeAlphanumeric(first ?? "") && rest.every(isSourceStemChar);
}

function isSourceStemChar(value: string): boolean {
  return isUnicodeAlphanumeric(value) || value === "." || value === "_" || value === "-";
}

function isUnicodeAlphanumeric(value: string): boolean {
  return /^[\p{L}\p{N}]$/u.test(value);
}
