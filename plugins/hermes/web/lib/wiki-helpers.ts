import type { ChildNode } from "@/lib/types";

export type ViewMode = "preview" | "raw" | "edit";
export type ModeTab = "explorer" | "query" | "ingest" | "sources";
export type ReadIdentityMode = "anonymous" | "user";

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

export function rootChild(path: "/Wiki" | "/Sources"): ChildNode {
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
  if (value === "ingest" || value === "sources" || value === "explorer") return value;
  return "explorer";
}

export function readIdentityMode(
  readMode: "anonymous" | null,
  hasReadIdentity: boolean,
  hasDatabaseRole: boolean,
  memberRolesLoaded: boolean,
  publicReadable: boolean
): ReadIdentityMode {
  if (readMode === "anonymous" || !hasReadIdentity) return "anonymous";
  if (hasDatabaseRole) return "user";
  if (publicReadable) return "anonymous";
  return memberRolesLoaded ? "anonymous" : "user";
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  if (name === "summary.md") return "summary";
  if (name === "open_questions.md") return "open_questions";
  if (path.startsWith("/Sources/raw")) return "raw_source";
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
