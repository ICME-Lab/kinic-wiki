// Where: workers/wiki-generator/src/source-path.ts
// What: Source evidence path prefix checks and stable source id derivation.
// Why: The worker should keep sources under the configured store root without imposing a schema.

export function validateSourceRootPath(path: string, prefix: string): void {
  const boundary = `${prefix}/`;
  if (!path.startsWith(boundary)) {
    throw new Error(`sourcePath must be under ${prefix}`);
  }
  const relative = path.slice(boundary.length);
  if (relative.trim() === "") {
    throw new Error(`sourcePath must be a child of ${prefix}`);
  }
  const parts = relative.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error("sourcePath contains an unsafe path segment");
  }
}

export function sourceIdFromPath(path: string, prefix: string): string {
  validateSourceRootPath(path, prefix);
  const relative = path.slice(`${prefix}/`.length);
  const parts = relative.split("/");
  const fileName = parts.at(-1) ?? "source";
  const fileStem = fileName.replace(/\.md$/i, "") || "source";
  return `${fileStem}-${stablePathHash(relative)}`;
}

function stablePathHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).padStart(7, "0");
}
