"use client";

import type { Identity } from "@icp-sdk/core/agent";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { hrefForPath } from "@/lib/paths";
import { searchRequestKey } from "@/lib/request-keys";
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
  readIdentity,
  prefix = "/Wiki",
  emptyMessage = "Use the header search.",
  eyebrow = "Search",
  title = "Wiki search"
}: {
  canisterId: string;
  databaseId: string;
  query: string;
  initialKind: SearchKind;
  readIdentity: Identity | null;
  prefix?: string | null;
  emptyMessage?: string;
  eyebrow?: string;
  title?: string;
}) {
  const latestRequest = useRef(0);
  const lastRequestedKey = useRef<string | null>(null);
  const urlQuery = query.trim();
  const readPrincipal = readIdentity?.getPrincipal().toText() ?? null;
  const urlSearchKey = `${searchRequestKey(canisterId, databaseId, initialKind, urlQuery, readPrincipal)}\n${prefix ?? ""}`;
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

  const startSearch = useCallback((searchText: string, searchKind: SearchKind, requestKey: string, syncState: boolean) => {
    lastRequestedKey.current = requestKey;
    const requestId = latestRequest.current + 1;
    latestRequest.current = requestId;
    const request = searchKind === "path" ? searchNodePaths : searchNodes;
    if (syncState) {
      setSearchState({ key: requestKey, results: [], error: null, hint: null, loading: true, hasSearched: true });
    }
    request(canisterId, databaseId, searchText, 20, prefix, readIdentity ?? undefined)
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
  }, [canisterId, databaseId, prefix, readIdentity]);

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
        {!urlQuery && !error ? <p className="rounded-xl border border-line bg-paper p-4 text-sm text-muted">{emptyMessage}</p> : null}
        {error ? <ErrorBox message={error} hint={isCurrentSearchState ? searchState.hint : null} /> : null}
        {loading ? <p className="rounded-xl border border-line bg-paper p-4 text-sm text-muted">Searching wiki...</p> : null}
        {!loading && hasSearched && !error && results.length === 0 ? (
          <p className="rounded-xl border border-line bg-paper p-4 text-sm text-muted">No results.</p>
        ) : null}
        <div className="space-y-2">
          {results.map((hit) => {
            const excerpt = resultExcerpt(hit);
            return (
              <Link
                key={`${hit.path}-${hit.score}`}
                href={hrefForPath(canisterId, databaseId, hit.path)}
                className="block rounded-xl border border-line bg-white p-3 text-sm no-underline hover:border-accent"
              >
                <div className="truncate font-mono text-xs text-accent">{hit.path}</div>
                {excerpt ? <p className="mt-2 text-xs text-ink">{excerpt}</p> : null}
              </Link>
            );
          })}
        </div>
      </div>
    </div>
  );
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
