"use client";

import type { Identity } from "@icp-sdk/core/agent";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { displayPathForFolderIndex } from "@/lib/folder-index";
import { hrefForPath, hrefForSearch } from "@/lib/paths";
import { searchRequestKey } from "@/lib/request-keys";
import { DEFAULT_SEARCH_OPTIONS, normalizeSearchPrefix, prefixForSearchScope, type SearchLimit, type SearchOptions, type SearchPreviewMode, type SearchScope } from "@/lib/search-options";
import type { SearchNodeHit } from "@/lib/types";
import { searchNodePaths, searchNodes } from "@/lib/vfs-client";
import { errorHint, errorMessage } from "@/lib/wiki-helpers";
import { ErrorBox } from "@/components/panel";

export type SearchKind = "path" | "full";
type SearchState = {
  key: string | null;
  results: SearchNodeHit[];
  error: string | null;
  hint: string | null;
  loading: boolean;
  hasSearched: boolean;
};

export function SearchPanel({
  canisterId,
  databaseId,
  query,
  initialKind,
  searchOptions = DEFAULT_SEARCH_OPTIONS,
  readIdentity,
  emptyMessage = "Use the header search.",
  eyebrow = "Search",
  title = "Wiki search"
}: {
  canisterId: string;
  databaseId: string;
  query: string;
  initialKind: SearchKind;
  searchOptions?: SearchOptions;
  readIdentity: Identity | null;
  emptyMessage?: string;
  eyebrow?: string;
  title?: string;
}) {
  const router = useRouter();
  const latestRequest = useRef(0);
  const lastRequestedKey = useRef<string | null>(null);
  const urlQuery = query.trim();
  const readPrincipal = readIdentity?.getPrincipal().toText() ?? null;
  const urlSearchKey = `${searchRequestKey(canisterId, databaseId, initialKind, urlQuery, readPrincipal)}\n${searchOptions.prefix}\n${searchOptions.limit}\n${searchOptions.preview}`;
  const customPrefixSeed = searchOptions.scope === "custom" ? searchOptions.prefix : "";
  const [customPrefixDraftState, setCustomPrefixDraftState] = useState({ seed: customPrefixSeed, value: customPrefixSeed });
  const [searchState, setSearchState] = useState<SearchState>({
    key: null,
    results: [],
    error: null,
    hint: null,
    loading: false,
    hasSearched: false
  });
  const isCurrentSearchState = searchState.key === urlSearchKey;
  const results = isCurrentSearchState ? searchState.results : [];
  const error = isCurrentSearchState ? searchState.error : null;
  const loading = (isCurrentSearchState && searchState.loading) || (Boolean(urlQuery) && !isCurrentSearchState);
  const hasSearched = isCurrentSearchState ? searchState.hasSearched : Boolean(urlQuery);
  const customPrefixDraft = customPrefixDraftState.seed === customPrefixSeed ? customPrefixDraftState.value : customPrefixSeed;
  const setCustomPrefixDraft = useCallback((value: string) => {
    setCustomPrefixDraftState({ seed: customPrefixSeed, value });
  }, [customPrefixSeed]);

  const startSearch = useCallback((searchText: string, searchKind: SearchKind, requestKey: string, syncState: boolean) => {
    lastRequestedKey.current = requestKey;
    const requestId = latestRequest.current + 1;
    latestRequest.current = requestId;
    const request = searchKind === "path" ? searchNodePaths : searchNodes;
    if (syncState) {
      setSearchState({ key: requestKey, results: [], error: null, hint: null, loading: true, hasSearched: true });
    }
    request(canisterId, databaseId, searchText, searchOptions.limit, searchOptions.prefix, searchOptions.preview, readIdentity ?? undefined)
      .then((data) => {
        if (latestRequest.current === requestId) {
          setSearchState({ key: requestKey, results: data, error: null, hint: null, loading: false, hasSearched: true });
        }
      })
      .catch((searchError: Error) => {
        if (latestRequest.current === requestId) {
          setSearchState({
            key: requestKey,
            results: [],
            error: errorMessage(searchError),
            hint: errorHint(searchError),
            loading: false,
            hasSearched: true
          });
        }
      });
  }, [canisterId, databaseId, readIdentity, searchOptions.limit, searchOptions.prefix, searchOptions.preview]);

  const replaceSearchOptions = useCallback((next: Partial<SearchOptions>) => {
    const scope = next.scope ?? searchOptions.scope;
    const prefix = next.prefix ?? (scope === searchOptions.scope ? searchOptions.prefix : prefixForSearchScope(scope, null));
    const normalizedPrefix = scope === "custom" ? normalizeSearchPrefix(prefix) ?? DEFAULT_SEARCH_OPTIONS.prefix : prefixForSearchScope(scope, null);
    router.replace(
      hrefForSearch(canisterId, databaseId, urlQuery, initialKind, {
        scope,
        prefix: normalizedPrefix,
        limit: next.limit ?? searchOptions.limit,
        preview: next.preview ?? searchOptions.preview
      })
    );
  }, [canisterId, databaseId, initialKind, router, searchOptions.limit, searchOptions.prefix, searchOptions.preview, searchOptions.scope, urlQuery]);

  useEffect(() => {
    if (!urlQuery) {
      latestRequest.current += 1;
      lastRequestedKey.current = null;
      return;
    }
    if (lastRequestedKey.current === urlSearchKey) return;
    startSearch(urlQuery, initialKind, urlSearchKey, false);
  }, [initialKind, startSearch, urlQuery, urlSearchKey]);

  return (
    <div className="min-h-0 flex-1 overflow-auto p-5">
      <div className="mx-auto flex max-w-4xl flex-col gap-3">
        <div className="border-b border-line pb-4">
          <p className="font-mono text-xs uppercase tracking-[0.18em] text-muted">{eyebrow}</p>
          <h2 className="mt-1 text-2xl font-semibold tracking-[-0.04em]">{title}</h2>
        </div>
        <SearchControls
          customPrefixDraft={customPrefixDraft}
          limit={searchOptions.limit}
          preview={searchOptions.preview}
          scope={searchOptions.scope}
          onCustomPrefixChange={setCustomPrefixDraft}
          onCustomPrefixCommit={() => replaceSearchOptions({ scope: "custom", prefix: customPrefixDraft })}
          onLimitChange={(limit) => replaceSearchOptions({ limit })}
          onPreviewChange={(preview) => replaceSearchOptions({ preview })}
          onScopeChange={(scope) => replaceSearchOptions({ scope })}
        />
        {!urlQuery && !error ? <p className="rounded-xl border border-line bg-paper p-4 text-sm text-muted">{emptyMessage}</p> : null}
        {error ? <ErrorBox message={error} hint={isCurrentSearchState ? searchState.hint : null} /> : null}
        {loading ? <p className="rounded-xl border border-line bg-paper p-4 text-sm text-muted">Searching wiki...</p> : null}
        {!loading && hasSearched && !error && results.length === 0 ? (
          <p className="rounded-xl border border-line bg-paper p-4 text-sm text-muted">No results.</p>
        ) : null}
        <div className="space-y-2">
          {results.map((hit) => {
            const excerpt = resultExcerpt(hit);
            const displayPath = displayPathForFolderIndex(hit.path);
            return (
              <Link
                key={`${hit.path}-${hit.score}`}
                href={hrefForPath(canisterId, databaseId, displayPath)}
                className="block rounded-xl border border-line bg-white p-3 text-sm no-underline hover:border-accent"
              >
                <div className="truncate font-mono text-xs text-accent">{displayPath}</div>
                {excerpt ? <p className="mt-2 text-xs text-ink">{excerpt}</p> : null}
              </Link>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function SearchControls({
  customPrefixDraft,
  limit,
  preview,
  scope,
  onCustomPrefixChange,
  onCustomPrefixCommit,
  onLimitChange,
  onPreviewChange,
  onScopeChange
}: {
  customPrefixDraft: string;
  limit: SearchLimit;
  preview: SearchPreviewMode;
  scope: SearchScope;
  onCustomPrefixChange: (value: string) => void;
  onCustomPrefixCommit: () => void;
  onLimitChange: (value: SearchLimit) => void;
  onPreviewChange: (value: SearchPreviewMode) => void;
  onScopeChange: (value: SearchScope) => void;
}) {
  return (
    <div className="grid gap-3 rounded-xl border border-line bg-paper p-3 text-sm md:grid-cols-[1.1fr_0.8fr_1fr]">
      <label className="grid gap-1">
        <span className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">Scope</span>
        <select className="h-10 rounded-lg border border-line bg-white px-3 text-sm text-ink outline-none focus:border-accent" value={scope} onChange={(event) => onScopeChange(parseScopeInput(event.target.value))}>
          <option value="wiki">/Wiki</option>
          <option value="sources">/Sources</option>
          <option value="root">/</option>
          <option value="custom">Custom prefix</option>
        </select>
      </label>
      <label className="grid gap-1">
        <span className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">Top K</span>
        <select className="h-10 rounded-lg border border-line bg-white px-3 text-sm text-ink outline-none focus:border-accent" value={String(limit)} onChange={(event) => onLimitChange(parseLimitInput(event.target.value))}>
          <option value="10">10</option>
          <option value="20">20</option>
          <option value="50">50</option>
          <option value="100">100</option>
        </select>
      </label>
      <label className="grid gap-1">
        <span className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">Preview</span>
        <select className="h-10 rounded-lg border border-line bg-white px-3 text-sm text-ink outline-none focus:border-accent" value={preview} onChange={(event) => onPreviewChange(parsePreviewInput(event.target.value))}>
          <option value="default">Default</option>
          <option value="none">None</option>
          <option value="light">Light</option>
          <option value="content-start">Content start</option>
        </select>
      </label>
      {scope === "custom" ? (
        <label className="grid gap-1 md:col-span-3">
          <span className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">Custom prefix</span>
          <input
            className="h-10 rounded-lg border border-line bg-white px-3 font-mono text-sm text-ink outline-none focus:border-accent"
            placeholder="/Wiki/project"
            value={customPrefixDraft}
            onBlur={onCustomPrefixCommit}
            onChange={(event) => onCustomPrefixChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                onCustomPrefixCommit();
              }
            }}
          />
        </label>
      ) : null}
    </div>
  );
}

function parseScopeInput(value: string): SearchScope {
  if (value === "sources" || value === "root" || value === "custom") return value;
  return "wiki";
}

function parseLimitInput(value: string): SearchLimit {
  if (value === "10" || value === "50" || value === "100") return Number(value) as SearchLimit;
  return 20;
}

function parsePreviewInput(value: string): SearchPreviewMode {
  if (value === "none" || value === "light" || value === "content-start") return value;
  return "default";
}

function resultExcerpt(hit: SearchNodeHit): string | null {
  if (hit.preview?.excerpt) {
    return hit.preview.excerpt;
  }
  if (hit.snippet && hit.snippet !== hit.path) {
    return hit.snippet;
  }
  return null;
}
