// Where: shared WikiBrowser SEO helpers.
// What: Derive stable titles, descriptions, and crawler-safe excerpts from VFS nodes.
// Why: Route metadata and server-rendered crawler content must not duplicate parsing rules.

import { splitMarkdownFrontmatter } from "@/lib/markdown-frontmatter";
import type { ChildNode, DatabaseSummary, WikiNode } from "@/lib/types";

const DEFAULT_DESCRIPTION = "Browse, search, and query this Kinic Wiki database.";
const MAX_TITLE_LENGTH = 72;
const MAX_DESCRIPTION_LENGTH = 160;
const MAX_BODY_CHARS = 8000;
const MAX_SEO_INPUT_CHARS = 16_000;

export type WikiSeoRoute = {
  indexable: boolean;
  nodePath: string;
};

export type WikiSeoNodeSummary = {
  title: string;
  description: string;
  textExcerpt: string;
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

export function wikiSeoDescription(database: { metadata: Pick<DatabaseSummary["metadata"], "name" | "description"> } | null, node: Pick<WikiNode, "content" | "metadataJson"> | null, children: Pick<ChildNode, "name" | "path">[]): string {
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

export function wikiSeoNodeSummary(database: { metadata: Pick<DatabaseSummary["metadata"], "name" | "description"> } | null, nodePath: string, node: Pick<WikiNode, "content" | "metadataJson"> | null, children: Pick<ChildNode, "name" | "path">[], fallbackTitle = "Kinic Wiki"): WikiSeoNodeSummary {
  const databaseTitle = database?.metadata.name.trim() || fallbackTitle;
  if (!node) return {
    title: wikiSeoTitle(databaseTitle, nodePath, null),
    description: wikiSeoDescription(database, null, children),
    textExcerpt: ""
  };
  const parsed = parseSeoNode(node);
  return {
    title: truncateText(`${parsedTitle(parsed, nodePath)} - ${databaseTitle}`, MAX_TITLE_LENGTH),
    description: parsedDescription(parsed),
    textExcerpt: plainTextExcerpt(parsed.body, MAX_BODY_CHARS)
  };
}

type ParsedSeoNode = {
  fields: { key: string; value: string }[];
  metadata: Record<string, unknown> | null;
  body: string;
};

// Bound work before parsing; never copy or scan the complete document for SEO.
function parseSeoNode(node: Pick<WikiNode, "content" | "metadataJson">): ParsedSeoNode {
  const content = node.content.slice(0, MAX_SEO_INPUT_CHARS);
  const frontmatter = splitMarkdownFrontmatter(content);
  // An incomplete frontmatter block is metadata, not a body excerpt.
  const body = content.startsWith("---\n") && !frontmatter ? "" : (frontmatter?.body ?? content);
  return {
    fields: frontmatter?.fields ?? [],
    metadata: node.metadataJson.length <= MAX_SEO_INPUT_CHARS ? parseMetadataJson(node.metadataJson) : null,
    body: body.slice(0, MAX_BODY_CHARS)
  };
}

function parsedTitle(parsed: ParsedSeoNode, fallbackPath: string): string {
  return truncateText(
    frontmatterValue(parsed.fields, ["metadata.title", "title", "name"])
      ?? metadataValue(parsed.metadata, ["metadata.title", "title", "name"])
      ?? firstMarkdownHeading(parsed.body)
      ?? titleFromPath(fallbackPath),
    MAX_TITLE_LENGTH
  );
}

function parsedDescription(parsed: ParsedSeoNode): string {
  const description = frontmatterValue(parsed.fields, ["description", "summary", "metadata.description", "metadata.summary"])
    ?? metadataValue(parsed.metadata, ["description", "summary", "metadata.description", "metadata.summary"]);
  return description ? truncateText(description, MAX_DESCRIPTION_LENGTH) : plainTextExcerpt(parsed.body);
}

export function titleFromNode(node: WikiNode): string {
  return titleFromNodeOrFallbackPath(node, node.path);
}

function titleFromNodeOrFallbackPath(node: WikiNode, fallbackPath: string): string {
  return parsedTitle(parseSeoNode(node), fallbackPath);
}

export function titleFromPath(path: string): string {
  const cleanPath = path.replace(/\/+$/, "") || "/Knowledge";
  const parts = cleanPath.split("/").filter(Boolean);
  const last = parts[parts.length - 1] ?? "Knowledge";
  const withoutExtension = last.replace(/\.(md|mdx|txt)$/i, "");
  return truncateText(decodeReadablePathPart(withoutExtension) || "Knowledge", MAX_TITLE_LENGTH);
}

export function descriptionFromNode(node: Pick<WikiNode, "content" | "metadataJson">): string {
  return parsedDescription(parseSeoNode(node));
}

export function markdownBody(content: string): string {
  return parseSeoNode({ content, metadataJson: "{}" }).body;
}

export function plainTextExcerpt(markdown: string, maxLength = MAX_DESCRIPTION_LENGTH): string {
  const text = markdown.slice(0, MAX_BODY_CHARS)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/[*_~]+/g, "")
    .replace(/[#>-]+/g, " ")
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

function metadataValue(metadata: Record<string, unknown> | null, keys: string[]): string | null {
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
