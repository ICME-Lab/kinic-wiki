import type { NodeHistoryEntry, NodeVersion, NodeVersionSummary } from "@/lib/types";

const DIFF_BYTES_MAX = 1024 * 1024;
const DIFF_LINES_MAX = 20_000;

export function historyVersions(entries: NodeHistoryEntry[]) {
  const versions = new Map<string, NodeVersionSummary>();
  for (const entry of entries) {
    for (const version of [entry.afterVersion, entry.beforeVersion]) {
      if (version) versions.set(version.versionId.toString(), version);
    }
  }
  return [...versions.values()].sort((a, b) => Number(b.versionId - a.versionId));
}

export function versionCacheKey(canisterId: string, databaseId: string, pageId: bigint, versionId: bigint) {
  return `${canisterId}\u0000${databaseId}\u0000${pageId.toString()}\u0000${versionId.toString()}`;
}

export function entryVersion(entry: NodeHistoryEntry) {
  return entry.afterVersion ?? entry.beforeVersion;
}

export function formatTime(value: string) {
  return new Date(Number(value)).toLocaleString();
}

export function VersionSelect({ label, value, summaries, onChange }: { label: string; value: bigint | null; summaries: NodeVersionSummary[]; onChange: (value: bigint) => void }) {
  return (
    <label className="grid gap-1 text-xs font-semibold text-muted">
      {label}
      <select className="h-10 min-w-56 rounded-xl border border-line bg-white px-3 font-mono text-xs text-ink" value={value?.toString() ?? ""} onChange={(event) => onChange(BigInt(event.target.value))}>
        {summaries.map((summary) => <option key={summary.versionId.toString()} value={summary.versionId.toString()}>v{summary.versionId.toString()} · {summary.path}</option>)}
      </select>
    </label>
  );
}

export function VersionDiff({ left, right }: { left: NodeVersion | null; right: NodeVersion | null }) {
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

export function HistoryMessage({ title, message }: { title: string; message: string }) {
  return <section className="m-6 rounded-2xl border border-line bg-paper p-5"><h3 className="font-semibold text-ink">{title}</h3><p className="mt-2 text-sm text-muted">{message}</p></section>;
}
