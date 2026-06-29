import { databaseRouteBase } from "./share-links";
import type { SearchLimit, SearchPreviewMode, SearchScope } from "./search-options";

const INTERNAL_STORE_ROOT_PATHS = ["/Knowledge", "/Memory", "/Skills", "/Sessions", "/Sources", "/Wiki"] as const;

export function pathFromSegments(segments: string[]): string {
  if (segments.length === 0) {
    return "/Knowledge";
  }
  return `/${segments.join("/")}`;
}

export function parseWikiRoute(pathname: string): { databaseId: string | null; nodePath: string } {
  const segments = pathname.split("/").filter(Boolean);
  if (segments[0] !== "db" || !segments[1]) {
    return { databaseId: null, nodePath: "/Knowledge" };
  }
  const path = segments
    .slice(2)
    .filter(Boolean)
    .map(decodePathSegment)
    .join("/");
  return {
    databaseId: decodePathSegment(segments[1]),
    nodePath: path ? `/${path}` : "/Knowledge",
  };
}

export function hrefForPath(
  canisterId: string,
  databaseId: string,
  path: string,
  view?: string,
  tab?: string,
  searchQuery?: string,
  searchKind?: string
): string {
  void canisterId;
  const normalized = path.startsWith("/") ? path.slice(1) : path;
  const suffix = normalized
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
  const params = new URLSearchParams();
  if (view === "raw" || view === "edit") {
    params.set("view", view);
  }
  if (tab) {
    params.set("tab", tab);
  }
  if (searchQuery) {
    params.set("q", searchQuery);
  }
  if (searchKind) {
    params.set("kind", searchKind);
  }
  const queryString = params.size > 0 ? `?${params.toString()}` : "";
  return `${databaseRouteBase(databaseId)}/${suffix}${queryString}`;
}

export type SearchHrefOptions = {
  scope?: SearchScope;
  prefix?: string;
  limit?: SearchLimit;
  preview?: SearchPreviewMode;
};

export function hrefForSearch(canisterId: string, databaseId: string, searchQuery: string, searchKind: string, options: SearchHrefOptions = {}): string {
  void canisterId;
  const params = new URLSearchParams();
  if (searchQuery) {
    params.set("q", searchQuery);
  }
  if (searchKind) {
    params.set("kind", searchKind);
  }
  if (options.scope) {
    params.set("scope", options.scope);
  }
  if (options.scope === "custom" && options.prefix) {
    params.set("prefix", options.prefix);
  }
  if (options.limit) {
    params.set("limit", String(options.limit));
  }
  if (options.preview) {
    params.set("preview", options.preview);
  }
  const queryString = params.size > 0 ? `?${params.toString()}` : "";
  return `${databaseRouteBase(databaseId)}/search${queryString}`;
}

export function hrefForGraph(canisterId: string, databaseId: string, centerPath?: string | null, depth?: number): string {
  void canisterId;
  const params = new URLSearchParams();
  if (centerPath) {
    params.set("center", centerPath);
  }
  if (depth && depth !== 1) {
    params.set("depth", String(depth));
  }
  const queryString = params.size > 0 ? `?${params.toString()}` : "";
  return `${databaseRouteBase(databaseId)}/graph${queryString}`;
}

export function hrefForHelp(canisterId: string, databaseId: string): string {
  void canisterId;
  const params = new URLSearchParams();
  const queryString = params.size > 0 ? `?${params.toString()}` : "";
  return `${databaseRouteBase(databaseId)}/help${queryString}`;
}

export function hrefForDatabaseSwitch(
  canisterId: string,
  databaseId: string,
  state: {
    isHelpPage?: boolean;
    isSearchPage: boolean;
    isGraphPage: boolean;
    query: string;
    searchKind: string;
    searchOptions?: SearchHrefOptions;
    graphDepth: number;
  }
): string {
  if (state.isHelpPage) {
    return hrefForHelp(canisterId, databaseId);
  }
  if (state.isSearchPage) {
    return hrefForSearch(canisterId, databaseId, state.query, state.searchKind, state.searchOptions);
  }
  if (state.isGraphPage) {
    return hrefForGraph(canisterId, databaseId, "/Knowledge", state.graphDepth);
  }
  return hrefForPath(canisterId, databaseId, "/Knowledge");
}

export function hrefForMarkdownLink(canisterId: string, databaseId: string, currentPath: string, href: string | undefined): string | null {
  if (!href) {
    return null;
  }
  const trimmed = href.trim();
  if (!trimmed || isExternalHref(trimmed) || trimmed.startsWith("#")) {
    return null;
  }
  const target = splitMarkdownHref(trimmed);
  const targetPath = decodeMarkdownHrefPath(target.path);
  if (isInternalWikiPath(targetPath)) {
    return appendMarkdownSuffix(hrefForPath(canisterId, databaseId, targetPath), target);
  }
  if (targetPath.startsWith("/")) {
    return null;
  }
  return appendMarkdownSuffix(hrefForPath(canisterId, databaseId, resolveRelativeWikiPath(currentPath, targetPath)), target);
}

export function parentPath(path: string): string | null {
  if (path === "/") {
    return null;
  }
  const index = path.lastIndexOf("/");
  if (index <= 0) {
    return "/";
  }
  return path.slice(0, index);
}

function resolveRelativeWikiPath(currentPath: string, href: string): string {
  const base = parentPath(currentPath) ?? "/Knowledge";
  const parts = [...base.split("/"), ...href.split("/")].filter(Boolean);
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === ".") {
      continue;
    }
    if (part === "..") {
      resolved.pop();
      continue;
    }
    resolved.push(part);
  }
  return `/${resolved.join("/")}`;
}

function isExternalHref(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//");
}

function isInternalWikiPath(path: string): boolean {
  return INTERNAL_STORE_ROOT_PATHS.some((root) => path === root || path.startsWith(`${root}/`));
}

function appendMarkdownSuffix(baseHref: string, target: MarkdownHrefTarget): string {
  const params = new URLSearchParams(target.query);
  const queryString = params.size > 0 ? `?${params.toString()}` : "";
  return `${baseHref.split("?")[0]}${queryString}${target.hash}`;
}

function decodeMarkdownHrefPath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function splitMarkdownHref(href: string): MarkdownHrefTarget {
  const hashIndex = href.indexOf("#");
  const pathAndQuery = hashIndex === -1 ? href : href.slice(0, hashIndex);
  const hash = hashIndex === -1 ? "" : href.slice(hashIndex);
  const queryIndex = pathAndQuery.indexOf("?");
  if (queryIndex === -1) {
    return { path: pathAndQuery, query: "", hash };
  }
  return {
    path: pathAndQuery.slice(0, queryIndex),
    query: pathAndQuery.slice(queryIndex + 1),
    hash
  };
}

type MarkdownHrefTarget = {
  path: string;
  query: string;
  hash: string;
};
