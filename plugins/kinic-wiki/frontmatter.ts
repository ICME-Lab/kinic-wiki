// Where: plugins/kinic-wiki/frontmatter.ts
// What: Minimal frontmatter parsing and serialization for mirror-managed notes.
// Why: The plugin needs stable metadata without adding a markdown parsing dependency.
import { MirrorFrontmatter, PluginPageType } from "./types";

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
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    values.set(key, stripQuotes(value));
  }
  const pageType = values.get("page_type");
  if (
    !isPageType(pageType)
    || values.get("mirror") !== "true"
    || !values.has("page_id")
    || !values.has("slug")
    || !values.has("revision_id")
    || !values.has("updated_at")
  ) {
    return null;
  }
  const updatedAt = Number(values.get("updated_at"));
  if (!Number.isFinite(updatedAt)) {
    return null;
  }
  return {
    page_id: values.get("page_id") ?? "",
    slug: values.get("slug") ?? "",
    page_type: pageType,
    revision_id: values.get("revision_id") ?? "",
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
  const cleanBody = body.replace(/^\s+/, "");
  return [
    "---",
    `page_id: ${frontmatter.page_id}`,
    `slug: ${frontmatter.slug}`,
    `page_type: ${frontmatter.page_type}`,
    `revision_id: ${frontmatter.revision_id}`,
    `updated_at: ${frontmatter.updated_at}`,
    "mirror: true",
    "---",
    "",
    cleanBody
  ].join("\n");
}

function stripQuotes(value: string): string {
  return value.replace(/^"(.*)"$/, "$1");
}

function isPageType(value: string | undefined): value is PluginPageType {
  return value !== undefined
    && ["entity", "concept", "overview", "comparison", "query_note", "source_summary"].includes(value);
}
