import type { ChildNode } from "@/lib/types";

export type ViewMode = "preview" | "raw" | "edit";
export type ModeTab = "explorer" | "query" | "ingest" | "clipper";
export type ReadIdentityMode = "anonymous" | "user";
export const STORE_ROOT_PATHS = ["/Knowledge", "/Memory", "/Skills", "/Sessions", "/Sources"] as const;
export type StoreRootPath = (typeof STORE_ROOT_PATHS)[number];

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
  if (value === "ingest" || value === "clipper" || value === "explorer") return value;
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
  if (path === "/Sources/evidence" || path.startsWith("/Sources/evidence/")) return "evidence_source";
  if (path.endsWith(".md")) return "markdown_note";
  return "directory";
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
