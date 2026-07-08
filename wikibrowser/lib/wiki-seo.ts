// Where: shared WikiBrowser SEO helpers.
// What: Derive stable titles, descriptions, and crawler-safe excerpts from VFS nodes.
// Why: Route metadata and server-rendered crawler content must not duplicate parsing rules.

import { splitMarkdownFrontmatter } from "@/lib/markdown-frontmatter";
import type { ChildNode, DatabaseSummary, WikiNode } from "@/lib/types";

const DEFAULT_DESCRIPTION = "Browse, search, and query this Kinic Wiki database.";
const MAX_TITLE_LENGTH = 72;
const MAX_DESCRIPTION_LENGTH = 160;
const MAX_BODY_CHARS = 8000;

export type WikiSeoRoute = {
  indexable: boolean;
  nodePath: string;
};

export type WikiSeoNodeSummary = {
  title: string;
  description: string;
  markdown: string;
};

export function wikiSeoRouteFromSegments(segments: string[] | undefined): WikiSeoRoute {
  const path = segments && segments.length > 0 ? `/${segments.join("/")}` : "/Knowledge";
  return {
    indexable: !isBrowserOnlyPath(path),
    nodePath: path
  };
}

export function wikiSeoTitle(databaseTitle: string, nodePath: string, node: WikiNode | null): string {
  const nodeTitle = node ? titleFromNodeOrFallbackPath(node, nodePath) : titleFromPath(nodePath);
  return truncateText(`${nodeTitle} - ${databaseTitle}`, MAX_TITLE_LENGTH);
}

export function wikiSeoDescription(database: DatabaseSummary | null, node: WikiNode | null, children: ChildNode[]): string {
  if (node) {
    const nodeDescription = descriptionFromNode(node);
    if (nodeDescription) return nodeDescription;
  }
  if (children.length > 0) {
    return truncateText(`Browse ${children.slice(0, 6).map((child) => child.name).join(", ")} in this Kinic Wiki folder.`, MAX_DESCRIPTION_LENGTH);
  }
  const databaseDescription = database?.metadata.description.trim() ?? "";
  return truncateText(databaseDescription || DEFAULT_DESCRIPTION, MAX_DESCRIPTION_LENGTH);
}

export function wikiSeoNodeSummary(database: DatabaseSummary | null, nodePath: string, node: WikiNode | null, children: ChildNode[]): WikiSeoNodeSummary {
  const databaseTitle = database?.metadata.name.trim() || "Kinic Wiki";
  const markdown = node ? markdownBody(node.content) : "";
  return {
    title: wikiSeoTitle(databaseTitle, nodePath, node),
    description: wikiSeoDescription(database, node, children),
    markdown
  };
}

export function titleFromNode(node: WikiNode): string {
  return titleFromNodeOrFallbackPath(node, node.path);
}

function titleFromNodeOrFallbackPath(node: WikiNode, fallbackPath: string): string {
  const frontmatter = splitMarkdownFrontmatter(node.content);
  const frontmatterTitle = frontmatterValue(frontmatter?.fields ?? [], ["metadata.title", "title", "name"]);
  if (frontmatterTitle) return truncateText(frontmatterTitle, MAX_TITLE_LENGTH);
  const metadataTitle = metadataJsonValue(node.metadataJson, ["metadata.title", "title", "name"]);
  if (metadataTitle) return truncateText(metadataTitle, MAX_TITLE_LENGTH);
  const markdownTitle = firstMarkdownHeading(frontmatter ? frontmatter.body : node.content);
  if (markdownTitle) return truncateText(markdownTitle, MAX_TITLE_LENGTH);
  return titleFromPath(fallbackPath);
}

export function titleFromPath(path: string): string {
  const cleanPath = path.replace(/\/+$/, "") || "/Knowledge";
  const parts = cleanPath.split("/").filter(Boolean);
  const last = parts[parts.length - 1] ?? "Knowledge";
  const withoutExtension = last.replace(/\.(md|mdx|txt)$/i, "");
  return truncateText(decodeReadablePathPart(withoutExtension) || "Knowledge", MAX_TITLE_LENGTH);
}

export function descriptionFromNode(node: WikiNode): string {
  const frontmatter = splitMarkdownFrontmatter(node.content);
  const frontmatterDescription = frontmatterValue(frontmatter?.fields ?? [], ["description", "summary", "metadata.description", "metadata.summary"]);
  if (frontmatterDescription) return truncateText(frontmatterDescription, MAX_DESCRIPTION_LENGTH);
  const metadataDescription = metadataJsonValue(node.metadataJson, ["description", "summary", "metadata.description", "metadata.summary"]);
  if (metadataDescription) return truncateText(metadataDescription, MAX_DESCRIPTION_LENGTH);
  return plainTextExcerpt(frontmatter ? frontmatter.body : node.content, MAX_DESCRIPTION_LENGTH);
}

export function markdownBody(content: string): string {
  const frontmatter = splitMarkdownFrontmatter(content);
  return (frontmatter ? frontmatter.body : content).slice(0, MAX_BODY_CHARS);
}

export function plainTextExcerpt(markdown: string, maxLength = MAX_DESCRIPTION_LENGTH): string {
  const text = markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/[*_~#>-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return truncateText(text || DEFAULT_DESCRIPTION, maxLength);
}

function isBrowserOnlyPath(path: string): boolean {
  return path === "/search" || path === "/graph" || path === "/help";
}

function firstMarkdownHeading(markdown: string): string | null {
  for (const line of markdown.split("\n")) {
    const match = line.match(/^#\s+(.+)$/);
    if (match?.[1]) return match[1].trim();
  }
  return null;
}

function frontmatterValue(fields: { key: string; value: string }[], keys: string[]): string | null {
  for (const key of keys) {
    const value = fields.find((field) => field.key === key)?.value.trim();
    if (value) return value;
  }
  return null;
}

function metadataJsonValue(metadataJson: string, keys: string[]): string | null {
  const metadata = parseMetadataJson(metadataJson);
  if (!metadata) return null;
  for (const key of keys) {
    const value = valueAtDottedKey(metadata, key);
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function parseMetadataJson(metadataJson: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(metadataJson);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function valueAtDottedKey(record: Record<string, unknown>, dottedKey: string): unknown {
  let current: unknown = record;
  for (const part of dottedKey.split(".")) {
    if (!isRecord(current)) return null;
    current = current[part];
  }
  return current;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeReadablePathPart(value: string): string {
  try {
    return decodeURIComponent(value).replace(/[-_]+/g, " ").trim();
  } catch {
    return value.replace(/[-_]+/g, " ").trim();
  }
}

function truncateText(value: string, maxLength: number): string {
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}
