"use client";

import type { Identity } from "@icp-sdk/core/agent";
import { useEffect, useRef, useState } from "react";
import { RotateCcw, X } from "lucide-react";
import type { DatabaseRole, DeletedNodeSummary } from "@/lib/types";
import { listDeletedNodes, restoreNodeVersionAuthenticated } from "@/lib/vfs-client";

export function DeletedNodesPanel({
  canisterId,
  databaseId,
  identity,
  databaseRole,
  onClose,
  onRestored
}: {
  canisterId: string;
  databaseId: string;
  identity: Identity | null;
  databaseRole: DatabaseRole | null;
  onClose: () => void;
  onRestored: (path: string) => void;
}) {
  const [nodes, setNodes] = useState<DeletedNodeSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<bigint | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(identity));
  const [loadedScopeKey, setLoadedScopeKey] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<bigint | null>(null);
  const principal = identity?.getPrincipal().toText() ?? "anonymous";
  const scopeKey = `${canisterId}\u0000${databaseId}\u0000${principal}`;
  const activeScopeKey = useRef(scopeKey);
  activeScopeKey.current = scopeKey;
  useEffect(() => {
    setNodes([]);
    setNextCursor(null);
    setError(null);
    setRestoring(null);
    setLoadedScopeKey(null);
    if (!identity) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void listDeletedNodes(canisterId, databaseId, identity)
      .then((page) => {
        if (cancelled) return;
        setNodes(page.nodes);
        setNextCursor(page.nextCursor);
      })
      .catch((cause) => !cancelled && setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => {
        if (cancelled) return;
        setLoadedScopeKey(scopeKey);
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [canisterId, databaseId, identity, scopeKey]);
  const canRestore = databaseRole === "writer" || databaseRole === "owner";
  const scopeReady = Boolean(identity) && loadedScopeKey === scopeKey;
  return (
    <div className="min-h-0 flex-1 overflow-auto p-3">
      <div className="flex items-center justify-between">
        <div><p className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted">Recovery</p><h3 className="text-sm font-semibold text-ink">Deleted pages</h3></div>
        <button className="rounded-lg p-2 text-muted hover:bg-white" type="button" onClick={onClose} aria-label="Close deleted pages"><X size={15} /></button>
      </div>
      {!identity ? <p className="mt-4 text-sm text-muted">Login as a database member to view deleted pages.</p> : null}
      {identity && (loading || !scopeReady) ? <p className="mt-4 text-sm text-muted">Loading deleted pages…</p> : null}
      {scopeReady && error ? <p className="mt-4 text-sm text-red-700">{error}</p> : null}
      {scopeReady && !loading && !error && nodes.length === 0 ? <p className="mt-4 text-sm text-muted">No deleted pages.</p> : null}
      <div className="mt-3 space-y-2">
        {scopeReady && !loading && !error ? nodes.map((node) => (
          <article className="rounded-xl border border-line bg-white p-3" key={node.pageId.toString()}>
            <p className="break-all font-mono text-xs font-semibold text-ink">{node.path}</p>
            <p className="mt-1 truncate font-mono text-[10px] text-muted">{node.deletedBy}</p>
            <p className="mt-1 text-xs text-muted">{new Date(Number(node.deletedAt)).toLocaleString()}</p>
            <button
              className="mt-3 inline-flex items-center gap-1 rounded-lg bg-action px-2.5 py-1.5 text-xs font-bold text-white disabled:opacity-50"
              disabled={!canRestore || restoring !== null}
              type="button"
              onClick={() => {
                if (!identity || !window.confirm(`Restore ${node.path}?`)) return;
                const requestScopeKey = scopeKey;
                setRestoring(node.pageId);
                void restoreNodeVersionAuthenticated(canisterId, databaseId, node.pageId, node.versionId, null, identity)
                  .then(() => {
                    if (activeScopeKey.current === requestScopeKey) onRestored(node.path);
                  })
                  .catch((cause) => {
                    if (activeScopeKey.current === requestScopeKey) {
                      setError(cause instanceof Error ? cause.message : String(cause));
                    }
                  })
                  .finally(() => {
                    if (activeScopeKey.current === requestScopeKey) setRestoring(null);
                  });
              }}
            >
              <RotateCcw size={13} /> {restoring === node.pageId ? "Restoring…" : "Restore"}
            </button>
          </article>
        )) : null}
        {scopeReady && nextCursor !== null && identity ? (
          <button
            className="w-full rounded-xl border border-line bg-white px-3 py-2 text-sm font-semibold text-ink"
            type="button"
            onClick={() => {
              const requestScopeKey = scopeKey;
              void listDeletedNodes(canisterId, databaseId, identity, nextCursor)
                .then((page) => {
                  if (activeScopeKey.current !== requestScopeKey) return;
                  setNodes((current) => [...current, ...page.nodes]);
                  setNextCursor(page.nextCursor);
                })
                .catch((cause) => {
                  if (activeScopeKey.current === requestScopeKey) {
                    setError(cause instanceof Error ? cause.message : String(cause));
                  }
                });
            }}
          >
            Load older deletions
          </button>
        ) : null}
      </div>
    </div>
  );
}
