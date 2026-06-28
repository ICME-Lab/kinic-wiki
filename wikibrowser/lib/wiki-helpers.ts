import type { ChildNode } from "@/lib/types";

export type ViewMode = "preview" | "raw" | "edit";
export type ModeTab = "explorer" | "query" | "source-capture";
export type ReadIdentityMode = "anonymous" | "user";
export const STORE_ROOT_PATHS = ["/Knowledge", "/Memory", "/Skills", "/Sessions", "/Sources"] as const;
export type StoreRootPath = (typeof STORE_ROOT_PATHS)[number];
const RESERVED_SOURCE_PROVIDERS = new Set(["raw", "sessions", "skill-runs", "source-capture-requests", "ingest-requests"]);
const MAX_SOURCE_STEM_BYTES = 128;
const SOURCE_STEM_ENCODER = new TextEncoder();

export type LoadState<T> = {
  data: T | null;
  error: string | null;
  hint?: string | null;
  loading: boolean;
};
export type PathLoadState<T> = LoadState<T> & { path: string };

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly hint: string | null = null, readonly code: string | null = null) {
    super(message);
    this.name = "ApiError";
  }
}

export function rootChild(path: StoreRootPath): ChildNode {
  return {
    path,
    name: path.slice(1),
    kind: "folder",
    updatedAt: null,
    etag: null,
    sizeBytes: null,
    isVirtual: true,
    hasChildren: true
  };
}

export function canExpandChildNode(node: ChildNode): boolean {
  return node.kind === "directory" || node.kind === "folder" || node.hasChildren;
}

export function parseModeTab(value: string | null): ModeTab {
  if (value === "query") return "query";
  if (value === "source-capture" || value === "explorer") return value;
  return "explorer";
}

export function readIdentityMode(
  hasReadIdentity: boolean,
  hasDatabaseRole: boolean,
  memberRolesLoaded: boolean,
  publicReadable: boolean
): ReadIdentityMode {
  if (!hasReadIdentity) return "anonymous";
  if (hasDatabaseRole) return "user";
  if (publicReadable) return "anonymous";
  return memberRolesLoaded ? "anonymous" : "user";
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    const serialized = JSON.stringify(error, (_key, value) => (typeof value === "bigint" ? value.toString() : value));
    return serialized ?? "Unexpected error";
  } catch {
    return "Unexpected error";
  }
}

export function errorHint(error: unknown): string | null {
  return error instanceof ApiError ? error.hint : null;
}

export function isNotFoundError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

export function loadingState<T>(path: string): PathLoadState<T> {
  return { path, data: null, error: null, loading: true };
}

export function inferNoteRole(path: string): string {
  const name = path.split("/").at(-1) ?? "";
  if (name === "facts.md") return "facts";
  if (name === "events.md") return "events";
  if (name === "plans.md") return "plans";
  if (name === "preferences.md") return "preferences";
  if (name === "summary.md") return "summary";
  if (name === "open_questions.md") return "open_questions";
  if (name === "index.md") return "index";
  if (name === "overview.md") return "overview";
  if (name === "log.md") return "log";
  if (name === "schema.md") return "schema";
  if (name === "provenance.md") return "provenance";
  if (path.includes("/topics/") && path.endsWith(".md")) return "topics";
  if (isKnowledgeSourcePath(path)) return "evidence_source";
  if (path.endsWith(".md")) return "markdown_note";
  return "directory";
}

export function isKnowledgeSourcePath(path: string): boolean {
  const prefix = "/Sources/";
  if (!path.startsWith(prefix)) return false;
  const parts = path.slice(prefix.length).split("/");
  if (parts.length !== 2) return false;
  const [provider, fileName] = parts;
  return isSafeProviderSegment(provider) && !RESERVED_SOURCE_PROVIDERS.has(provider) && isSafeMarkdownFile(fileName);
}

function isSafeProviderSegment(value: string | undefined): value is string {
  return /^[a-z0-9]{1,32}$/.test(value ?? "");
}

function isSafeMarkdownFile(value: string | undefined): boolean {
  const fileName = value ?? "";
  if (!fileName.endsWith(".md")) return false;
  return isSafeSourceStem(fileName.slice(0, -".md".length));
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

export function extractMarkdownLinks(content: string): string[] {
  const links = new Set<string>();
  const inlinePattern = /\[[^\]]+\]\(([^)]+)\)/g;
  const wikiPattern = /\[\[([^\]]+)\]\]/g;
  for (const match of content.matchAll(inlinePattern)) {
    links.add(match[1] ?? "");
  }
  for (const match of content.matchAll(wikiPattern)) {
    links.add(match[1] ?? "");
  }
  return [...links].filter(Boolean).slice(0, 20);
}
