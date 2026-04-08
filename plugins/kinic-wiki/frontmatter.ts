// Where: plugins/kinic-wiki/frontmatter.ts
// What: Minimal frontmatter parsing and serialization for tracked mirror notes.
// Why: The plugin stores remote path and etag in note metadata without extra dependencies.
import { MirrorFrontmatter, NodeKind } from "./types";

export function parseMirrorFrontmatter(content: string): MirrorFrontmatter | null {
  if (!content.startsWith("---\n")) {
    return null;
  }
  const end = content.indexOf("\n---\n", 4);
  if (end === -1) {
    return null;
  }
  const lines = content.slice(4, end).split("\n");
  const values = new Map<string, string>();
  for (const line of lines) {
    const separator = line.indexOf(":");
    if (separator <= 0) {
      continue;
    }
    values.set(line.slice(0, separator).trim(), stripQuotes(line.slice(separator + 1).trim()));
  }
  const kind = parseNodeKind(values.get("kind"));
  const updatedAt = Number(values.get("updated_at"));
  if (
    kind === null
    || values.get("mirror") !== "true"
    || !values.has("path")
    || !values.has("etag")
    || !Number.isFinite(updatedAt)
  ) {
    return null;
  }
  return {
    path: values.get("path") ?? "",
    kind,
    etag: values.get("etag") ?? "",
    updated_at: updatedAt,
    mirror: true
  };
}

export function stripManagedFrontmatter(content: string): string {
  if (!content.startsWith("---\n")) {
    return content;
  }
  const end = content.indexOf("\n---\n", 4);
  return end === -1 ? content : content.slice(end + 5);
}

export function serializeMirrorFile(frontmatter: MirrorFrontmatter, body: string): string {
  return [
    "---",
    `path: ${frontmatter.path}`,
    `kind: ${frontmatter.kind}`,
    `etag: ${frontmatter.etag}`,
    `updated_at: ${frontmatter.updated_at}`,
    "mirror: true",
    "---",
    "",
    body.replace(/^\s+/, "")
  ].join("\n");
}

function stripQuotes(value: string): string {
  return value.replace(/^"(.*)"$/, "$1");
}

function parseNodeKind(value: string | undefined): NodeKind | null {
  if (value === "file" || value === "source") {
    return value;
  }
  return null;
}
