export function pathFromSegments(segments: string[]): string {
  if (segments.length === 0) {
    return "/Wiki";
  }
  return `/${segments.join("/")}`;
}

export function hrefForPath(
  canisterId: string,
  databaseId: string,
  path: string,
  view?: string,
  tab?: string,
  searchQuery?: string,
  searchKind?: string,
  readMode?: string | null
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
  if (readMode === "anonymous") {
    params.set("read", "anonymous");
  }
  const queryString = params.size > 0 ? `?${params.toString()}` : "";
  return `/${encodeURIComponent(databaseId)}/${suffix}${queryString}`;
}

export function hrefForSearch(canisterId: string, databaseId: string, searchQuery: string, searchKind: string, readMode?: string | null): string {
  void canisterId;
  const params = new URLSearchParams();
  if (searchQuery) {
    params.set("q", searchQuery);
  }
  if (searchKind) {
    params.set("kind", searchKind);
  }
  if (readMode === "anonymous") {
    params.set("read", "anonymous");
  }
  const queryString = params.size > 0 ? `?${params.toString()}` : "";
  return `/${encodeURIComponent(databaseId)}/search${queryString}`;
}

export function hrefForGraph(canisterId: string, databaseId: string, centerPath?: string | null, depth?: number, readMode?: string | null): string {
  void canisterId;
  const params = new URLSearchParams();
  if (centerPath) {
    params.set("center", centerPath);
  }
  if (depth && depth !== 1) {
    params.set("depth", String(depth));
  }
  if (readMode === "anonymous") {
    params.set("read", "anonymous");
  }
  const queryString = params.size > 0 ? `?${params.toString()}` : "";
  return `/${encodeURIComponent(databaseId)}/graph${queryString}`;
}

export function hrefForDatabaseSwitch(
  canisterId: string,
  databaseId: string,
  state: {
    isSearchPage: boolean;
    isGraphPage: boolean;
    query: string;
    searchKind: string;
    graphDepth: number;
    readMode?: string | null;
  }
): string {
  if (state.isSearchPage) {
    return hrefForSearch(canisterId, databaseId, state.query, state.searchKind, state.readMode);
  }
  if (state.isGraphPage) {
    return hrefForGraph(canisterId, databaseId, "/Wiki", state.graphDepth, state.readMode);
  }
  return hrefForPath(canisterId, databaseId, "/Wiki", undefined, undefined, undefined, undefined, state.readMode);
}

export function hrefForMarkdownLink(canisterId: string, databaseId: string, currentPath: string, href: string | undefined, readMode?: string | null): string | null {
  if (!href) {
    return null;
  }
  const trimmed = href.trim();
  if (!trimmed || isExternalHref(trimmed) || trimmed.startsWith("#")) {
    return null;
  }
  const target = splitMarkdownHref(trimmed);
  if (trimmed.startsWith("/Wiki") || trimmed.startsWith("/Sources")) {
    return appendMarkdownSuffix(hrefForPath(canisterId, databaseId, target.path, undefined, undefined, undefined, undefined, readMode), target, readMode);
  }
  if (trimmed.startsWith("/")) {
    return null;
  }
  return appendMarkdownSuffix(hrefForPath(canisterId, databaseId, resolveRelativeWikiPath(currentPath, target.path), undefined, undefined, undefined, undefined, readMode), target, readMode);
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
  const base = parentPath(currentPath) ?? "/Wiki";
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

function appendMarkdownSuffix(baseHref: string, target: MarkdownHrefTarget, readMode?: string | null): string {
  const params = new URLSearchParams(target.query);
  if (readMode === "anonymous") {
    params.set("read", "anonymous");
  }
  const queryString = params.size > 0 ? `?${params.toString()}` : "";
  return `${baseHref.split("?")[0]}${queryString}${target.hash}`;
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
