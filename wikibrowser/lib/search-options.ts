// Where: wikibrowser search URL and request controls.
// What: shared parsing and defaults for header/search page options.
// Why: search URLs should stay stable while invalid query params fall back safely.

export type SearchScope = "wiki" | "sources" | "root" | "custom";
export type SearchLimit = 10 | 20 | 50 | 100;
export type SearchPreviewMode = "default" | "none" | "light" | "content-start";

export type SearchOptions = {
  scope: SearchScope;
  prefix: string;
  limit: SearchLimit;
  preview: SearchPreviewMode;
};

export const DEFAULT_SEARCH_OPTIONS: SearchOptions = {
  scope: "wiki",
  prefix: "/Wiki",
  limit: 20,
  preview: "default"
};

export function parseSearchOptions(params: { get(name: string): string | null }): SearchOptions {
  const scope = parseSearchScope(params.get("scope"));
  const prefix = prefixForSearchScope(scope, params.get("prefix"));
  return {
    scope,
    prefix,
    limit: parseSearchLimit(params.get("limit")),
    preview: parseSearchPreview(params.get("preview"))
  };
}

export function parseSearchScope(value: string | null): SearchScope {
  if (value === "sources" || value === "root" || value === "custom") return value;
  return "wiki";
}

export function parseSearchLimit(value: string | null): SearchLimit {
  if (value === "10" || value === "50" || value === "100") return Number(value) as SearchLimit;
  return 20;
}

export function parseSearchPreview(value: string | null): SearchPreviewMode {
  if (value === "none" || value === "light" || value === "content-start") return value;
  return "default";
}

export function prefixForSearchScope(scope: SearchScope, customPrefix: string | null): string {
  if (scope === "sources") return "/Sources";
  if (scope === "root") return "/";
  if (scope === "custom") return normalizeSearchPrefix(customPrefix) ?? DEFAULT_SEARCH_OPTIONS.prefix;
  return DEFAULT_SEARCH_OPTIONS.prefix;
}

export function normalizeSearchPrefix(value: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return null;
  const prefixed = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return prefixed.replace(/\/{2,}/g, "/");
}
