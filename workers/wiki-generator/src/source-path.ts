// Where: workers/wiki-generator/src/source-path.ts
// What: Canonical evidence source path validation.
// Why: The worker must mirror canister source path rules before queueing work.
const RESERVED_SOURCE_PROVIDERS = new Set(["raw", "sessions", "skill-runs", "source-capture-requests"]);

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
  const stem = fileName.endsWith(".md") ? fileName.slice(0, -".md".length) : fileName;
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.md$/.test(fileName) && !stem.includes("..");
}
