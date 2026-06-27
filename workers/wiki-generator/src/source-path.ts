// Where: workers/wiki-generator/src/source-path.ts
// What: Source evidence path prefix checks and stable source id derivation.
// Why: The worker should keep sources under the configured store root without imposing a schema.

export function validateSourceRootPath(path: string, prefix: string): void {
  const boundary = `${prefix}/`;
  if (!path.startsWith(boundary)) {
    throw new Error(`sourcePath must be under ${prefix}`);
  }
  if (path.slice(boundary.length).trim() === "") {
    throw new Error(`sourcePath must be a child of ${prefix}`);
  }
}

export function sourceIdFromPath(path: string, prefix: string): string {
  validateSourceRootPath(path, prefix);
  const parts = path.slice(`${prefix}/`.length).split("/").filter(Boolean);
  const fileName = parts.at(-1) ?? "source";
  const fileStem = fileName.replace(/\.md$/i, "");
  const provider = parts.at(-2);
  return provider ? `${provider}-${fileStem}` : fileStem;
}
