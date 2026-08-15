"use client";

import type { Identity } from "@icp-sdk/core/agent";
import { RotateCcw } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type { DatabaseRole, NodeHistoryEntry, NodeVersion, NodeVersionSummary, WikiNode } from "@/lib/types";
import { listNodeHistory, readNodeVersion, restoreNodeVersionAuthenticated } from "@/lib/vfs-client";
import { errorMessage } from "@/lib/wiki-helpers";

const DIFF_BYTES_MAX = 1024 * 1024;
const DIFF_LINES_MAX = 20_000;

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

function VersionSelect({ label, value, summaries, onChange }: { label: string; value: bigint | null; summaries: NodeVersionSummary[]; onChange: (value: bigint) => void }) {
  return (
    <label className="grid gap-1 text-xs font-semibold text-muted">
      {label}
      <select className="h-10 min-w-56 rounded-xl border border-line bg-white px-3 font-mono text-xs text-ink" value={value?.toString() ?? ""} onChange={(event) => onChange(BigInt(event.target.value))}>
        {summaries.map((summary) => <option key={summary.versionId.toString()} value={summary.versionId.toString()}>v{summary.versionId.toString()} · {summary.path}</option>)}
      </select>
    </label>
  );
}

function VersionDiff({ left, right }: { left: NodeVersion | null; right: NodeVersion | null }) {
  if (!left || !right) return <p className="text-sm text-muted">Loading selected versions…</p>;
  const leftLines = left.content.split("\n");
  const rightLines = right.content.split("\n");
  const bytes = new TextEncoder().encode(left.content).length + new TextEncoder().encode(right.content).length;
  if (bytes > DIFF_BYTES_MAX || leftLines.length + rightLines.length > DIFF_LINES_MAX) {
    return <HistoryMessage title="Diff too large" message="Select and inspect versions individually; browser diff is limited to 1 MiB and 20,000 combined lines." />;
  }
  const rows = alignedDiff(leftLines, rightLines);
  return (
    <div className="overflow-x-auto rounded-2xl border border-line bg-[#151826] font-mono text-xs leading-5 text-slate-200">
      {rows.map((row, index) => <div className={`grid min-w-[700px] grid-cols-[42px_24px_minmax(0,1fr)] px-2 ${row.kind === "add" ? "bg-emerald-950/60 text-emerald-100" : row.kind === "remove" ? "bg-rose-950/60 text-rose-100" : ""}`} key={`${index}-${row.kind}`}><span className="select-none text-right text-slate-500">{index + 1}</span><span className="select-none text-center">{row.kind === "add" ? "+" : row.kind === "remove" ? "−" : " "}</span><span className="whitespace-pre-wrap break-words">{row.line || " "}</span></div>)}
    </div>
  );
}

function alignedDiff(left: string[], right: string[]) {
  if (left.length * right.length > 2_000_000) {
    const length = Math.max(left.length, right.length);
    return Array.from({ length }, (_, index) => left[index] === right[index]
      ? { kind: "same" as const, line: left[index] ?? "" }
      : [{ kind: "remove" as const, line: left[index] ?? "" }, { kind: "add" as const, line: right[index] ?? "" }]).flat();
  }
  const table = Array.from({ length: left.length + 1 }, () => new Uint32Array(right.length + 1));
  for (let i = left.length - 1; i >= 0; i -= 1) for (let j = right.length - 1; j >= 0; j -= 1) table[i][j] = left[i] === right[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  const rows: Array<{ kind: "same" | "add" | "remove"; line: string }> = [];
  let i = 0; let j = 0;
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) { rows.push({ kind: "same", line: left[i] }); i += 1; j += 1; }
    else if (j < right.length && (i === left.length || table[i][j + 1] >= table[i + 1][j])) { rows.push({ kind: "add", line: right[j] }); j += 1; }
    else { rows.push({ kind: "remove", line: left[i] }); i += 1; }
  }
  return rows;
}

function historyVersions(entries: NodeHistoryEntry[]) {
  const versions = new Map<string, NodeVersionSummary>();
  for (const entry of entries) for (const version of [entry.afterVersion, entry.beforeVersion]) if (version) versions.set(version.versionId.toString(), version);
  return [...versions.values()].sort((a, b) => Number(b.versionId - a.versionId));
}

function versionCacheKey(canisterId: string, databaseId: string, pageId: bigint, versionId: bigint) {
  return `${canisterId}\u0000${databaseId}\u0000${pageId.toString()}\u0000${versionId.toString()}`;
}

function entryVersion(entry: NodeHistoryEntry) { return entry.afterVersion ?? entry.beforeVersion; }
function formatTime(value: string) { return new Date(Number(value)).toLocaleString(); }
function HistoryMessage({ title, message }: { title: string; message: string }) { return <section className="m-6 rounded-2xl border border-line bg-paper p-5"><h3 className="font-semibold text-ink">{title}</h3><p className="mt-2 text-sm text-muted">{message}</p></section>; }
