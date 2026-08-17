"use client";

import type { Identity } from "@icp-sdk/core/agent";
import { RotateCcw } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type { DatabaseRole, NodeHistoryEntry, NodeVersion, WikiNode } from "@/lib/types";
import { listNodeHistory, readNodeVersion, restoreNodeVersionAuthenticated } from "@/lib/vfs-client";
import { errorMessage } from "@/lib/wiki-helpers";
import { entryVersion, formatTime, historyVersions, HistoryMessage, VersionDiff, VersionSelect, versionCacheKey } from "@/components/node-history-parts";

export function NodeHistory({
  canisterId,
  databaseId,
  node,
  identity,
  databaseRole,
  onRestored
}: {
  canisterId: string;
  databaseId: string;
  node: WikiNode;
  identity: Identity | null;
  databaseRole: DatabaseRole | null;
  onRestored?: () => Promise<WikiNode>;
}) {
  const [entries, setEntries] = useState<NodeHistoryEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<bigint | null>(null);
  const [pageId, setPageId] = useState<bigint | null>(null);
  const [leftId, setLeftId] = useState<bigint | null>(null);
  const [rightId, setRightId] = useState<bigint | null>(null);
  const [versions, setVersions] = useState<Record<string, NodeVersion>>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(identity));
  const [loadedScopeKey, setLoadedScopeKey] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const principal = identity?.getPrincipal().toText() ?? "anonymous";
  const scopeKey = `${canisterId}\u0000${databaseId}\u0000${node.path}\u0000${node.etag}\u0000${principal}`;
  const activeScopeKey = useRef(scopeKey);
  activeScopeKey.current = scopeKey;

  useEffect(() => {
    setEntries([]);
    setNextCursor(null);
    setPageId(null);
    setLeftId(null);
    setRightId(null);
    setVersions({});
    setError(null);
    setRestoring(false);
    setLoadedScopeKey(null);
    if (!identity) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void listNodeHistory(canisterId, databaseId, { path: node.path }, identity)
      .then((page) => {
        if (cancelled) return;
        setPageId(page.pageId);
        setEntries(page.entries);
        setNextCursor(page.nextCursor);
        const ids = historyVersions(page.entries);
        setRightId(ids[0]?.versionId ?? null);
        setLeftId(ids[1]?.versionId ?? ids[0]?.versionId ?? null);
      })
      .catch((cause) => !cancelled && setError(errorMessage(cause)))
      .finally(() => {
        if (cancelled) return;
        setLoadedScopeKey(scopeKey);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [canisterId, databaseId, identity, node.path, node.etag, scopeKey]);

  const summaries = useMemo(() => historyVersions(entries), [entries]);
  useEffect(() => {
    if (!identity || pageId === null) return;
    for (const versionId of [leftId, rightId]) {
      if (versionId === null) continue;
      const cacheKey = versionCacheKey(canisterId, databaseId, pageId, versionId);
      if (versions[cacheKey]) continue;
      const requestScopeKey = scopeKey;
      void readNodeVersion(canisterId, databaseId, pageId, versionId, identity)
        .then((version) => {
          if (version && activeScopeKey.current === requestScopeKey) {
            setVersions((current) => ({ ...current, [cacheKey]: version }));
          }
        })
        .catch((cause) => {
          if (activeScopeKey.current === requestScopeKey) setError(errorMessage(cause));
        });
    }
  }, [canisterId, databaseId, identity, leftId, pageId, rightId, scopeKey, versions]);

  if (!identity) return <HistoryMessage title="Login required" message="Page history is available to database members." />;
  if (loading || loadedScopeKey !== scopeKey) return <HistoryMessage title="Loading history" message="Reading immutable page versions…" />;
  if (error) return <HistoryMessage title="History unavailable" message={error} />;
  if (entries.length === 0) return <HistoryMessage title="No recorded changes" message="This page has not changed since page history was enabled." />;

  const left = leftId === null || pageId === null ? null : versions[versionCacheKey(canisterId, databaseId, pageId, leftId)] ?? null;
  const right = rightId === null || pageId === null ? null : versions[versionCacheKey(canisterId, databaseId, pageId, rightId)] ?? null;
  const canRestore = databaseRole === "writer" || databaseRole === "owner";

  async function restoreSelected() {
    if (!identity || pageId === null || rightId === null) return;
    if (!window.confirm("Restore this version as a new current version?")) return;
    const requestScopeKey = scopeKey;
    setRestoring(true);
    try {
      await restoreNodeVersionAuthenticated(canisterId, databaseId, pageId, rightId, node.etag, identity);
      if (activeScopeKey.current !== requestScopeKey) return;
      await onRestored?.();
      toast.success("Version restored");
    } catch (cause) {
      if (activeScopeKey.current === requestScopeKey) toast.error(errorMessage(cause));
    } finally {
      if (activeScopeKey.current === requestScopeKey) setRestoring(false);
    }
  }

  return (
    <div className="grid h-full min-h-0 grid-cols-1 overflow-hidden lg:grid-cols-[300px_minmax(0,1fr)]">
      <aside className="overflow-auto border-b border-line bg-paper/70 p-4 lg:border-b-0 lg:border-r">
        <p className="font-mono text-xs uppercase tracking-[0.18em] text-muted">History rail</p>
        <div className="mt-4 space-y-1">
          {entries.map((entry) => (
            <button
              className={`relative w-full rounded-xl border px-3 py-3 text-left transition ${rightId === entryVersion(entry)?.versionId ? "border-action bg-white shadow-sm" : "border-transparent hover:border-line hover:bg-white"}`}
              key={entry.itemId.toString()}
              type="button"
              onClick={() => setRightId(entryVersion(entry)?.versionId ?? null)}
            >
              <span className="absolute -left-1 top-5 size-2 rounded-full bg-action" />
              <span className="block text-sm font-semibold capitalize text-ink">{entry.changeKind}</span>
              <span className="mt-1 block truncate font-mono text-[11px] text-muted">{entry.authorPrincipal}</span>
              <span
                aria-label={`Commit ${entry.commitOid}`}
                className="mt-1 block font-mono text-[10px] text-muted"
                title={entry.commitOid}
              >
                commit {entry.commitOid.slice(0, 8)}
              </span>
              <span className="mt-1 block text-xs text-muted">{formatTime(entry.changedAt)}</span>
            </button>
          ))}
          {nextCursor !== null ? (
            <button
              className="w-full rounded-xl border border-line bg-white px-3 py-2 text-sm font-semibold text-ink"
              type="button"
              onClick={() => {
                if (!identity || pageId === null) return;
                const requestScopeKey = scopeKey;
                void listNodeHistory(canisterId, databaseId, { pageId }, identity, nextCursor)
                  .then((page) => {
                    if (activeScopeKey.current !== requestScopeKey) return;
                    setEntries((current) => [...current, ...page.entries]);
                    setNextCursor(page.nextCursor);
                  })
                  .catch((cause) => {
                    if (activeScopeKey.current === requestScopeKey) setError(errorMessage(cause));
                  });
              }}
            >
              Load older changes
            </button>
          ) : null}
        </div>
      </aside>
      <section className="min-h-0 overflow-auto p-4 md:p-6">
        <div className="flex flex-wrap items-end gap-3">
          <VersionSelect label="From" value={leftId} summaries={summaries} onChange={setLeftId} />
          <VersionSelect label="To" value={rightId} summaries={summaries} onChange={setRightId} />
          <button
            className="ml-auto inline-flex h-10 items-center gap-2 rounded-xl bg-action px-4 text-sm font-bold text-white disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!canRestore || restoring || rightId === null}
            title={canRestore ? "Restore the selected version" : "Writer or owner access required"}
            type="button"
            onClick={() => void restoreSelected()}
          >
            <RotateCcw aria-hidden size={15} /> {restoring ? "Restoring…" : "Restore"}
          </button>
        </div>
        <div className="mt-5"><VersionDiff left={left} right={right} /></div>
      </section>
    </div>
  );
}
