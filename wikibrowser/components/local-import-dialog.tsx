"use client";

import { FileText, FolderTree, Loader2, X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { useModalDialog } from "@/components/use-modal-dialog";
import {
  buildLocalImportWrites,
  LOCAL_IMPORT_BYTE_LIMIT,
  LOCAL_IMPORT_PDF_TOTAL_BYTE_LIMIT,
  LOCAL_IMPORT_SOURCE_FILE_BYTE_LIMIT,
  LOCAL_IMPORT_SOURCE_TOTAL_BYTE_LIMIT,
  type LocalImportMode,
  type ReconciledLocalImport
} from "@/lib/local-import";

export type LocalImportDialogState =
  | { phase: "preparing"; mode: LocalImportMode; destinationDirectory: string }
  | { phase: "ready" | "writing"; plan: ReconciledLocalImport }
  | { phase: "error"; mode: LocalImportMode; destinationDirectory: string; message: string };

export function LocalImportDialog({
  state,
  onCancel,
  onImport
}: {
  state: LocalImportDialogState;
  onCancel: () => void;
  onImport: (replacements: Set<string>) => void;
}) {
  const busy = state.phase === "writing";
  const { dialogRef, handleCancel } = useModalDialog(onCancel, busy);
  const plan = state.phase === "ready" || state.phase === "writing" ? state.plan : null;
  const [replacements, setReplacements] = useState<Set<string>>(new Set());

  useEffect(() => setReplacements(new Set()), [plan?.mode, plan?.navigationPath]);

  const writes = useMemo(() => plan ? buildLocalImportWrites(plan, replacements) : [], [plan, replacements]);
  const conflictCount = plan?.entries.filter((entry) => entry.status === "conflict").length ?? 0;
  const blockedCount = plan?.entries.filter((entry) => entry.status === "blocked").length ?? 0;
  const newFolderCount = plan?.entries.filter((entry) => entry.kind === "folder" && entry.status === "new").length ?? 0;
  const excluded = plan?.excluded.filter((entry) => entry.category === "excluded") ?? [];
  const conversionFailures = plan?.excluded.filter((entry) => entry.category === "conversion-failed") ?? [];
  const destination = plan?.destinationDirectory ?? ("destinationDirectory" in state ? state.destinationDirectory : "");
  const mode = plan?.mode ?? ("mode" in state ? state.mode : "folder");
  const title = mode === "folder" ? "Import folder" : "Import files";
  const cannotImport = !plan || Boolean(plan.limitError) || writes.length === 0 || state.phase === "writing";

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="local-import-title"
      aria-modal="true"
      className="fixed inset-0 z-50 m-0 hidden h-full w-full max-h-none max-w-none items-center justify-center border-0 bg-ink/35 p-3 open:flex sm:p-6"
      onCancel={handleCancel}
    >
      <button aria-label="Close local import dialog" className="absolute inset-0" disabled={busy} tabIndex={-1} type="button" onClick={onCancel} />
      <section className="relative z-10 flex max-h-[min(90vh,760px)] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-line bg-paper shadow-2xl">
        <header className="flex items-start justify-between gap-4 border-b border-line px-4 py-4 sm:px-5">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted">Local {mode === "folder" ? "folder" : "files"} → Wiki</p>
            <h2 id="local-import-title" className="mt-1 text-lg font-semibold text-ink">{title}</h2>
            <p className="mt-1 break-all font-mono text-xs text-muted">Destination: {destination}</p>
          </div>
          <button className="rounded-xl p-2 text-muted hover:bg-accentSoft hover:text-accentText disabled:opacity-40" disabled={busy} type="button" onClick={onCancel} aria-label="Close local import dialog">
            <X size={16} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5">
          {state.phase === "preparing" ? (
            <div className="flex min-h-52 flex-col items-center justify-center text-center">
              <Loader2 className="animate-spin text-accent" size={28} />
              <p className="mt-4 text-sm font-medium text-ink">Reading local files</p>
              <p className="mt-1 max-w-sm text-xs leading-5 text-muted">PDF text is extracted on this device. Nothing is written until the preview is ready.</p>
            </div>
          ) : state.phase === "error" ? (
            <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
              <p className="font-semibold">{mode === "folder" ? "Folder" : "Files"} could not be prepared</p>
              <p className="mt-2 leading-6">{state.message}</p>
            </div>
          ) : plan ? (
            <>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Metric label="Markdown" value={plan.markdownCount} />
                <Metric label="PDF converted" value={plan.pdfCount} />
                <Metric label="New folders" value={newFolderCount} />
                <Metric label="Encoded write" value={formatBytes(plan.inputBytes)} />
              </div>

              {plan.limitError ? <Notice tone="error">{plan.limitError}</Notice> : null}
              {conflictCount > 0 ? <Notice tone="warning">{conflictCount} existing file{conflictCount === 1 ? "" : "s"} will be kept unless replacement is selected.</Notice> : null}
              {blockedCount > 0 ? <Notice tone="error">{blockedCount} path{blockedCount === 1 ? " is" : "s are"} blocked by an incompatible existing node.</Notice> : null}

              <section className="mt-4 overflow-hidden rounded-xl border border-line bg-white">
                <div className="flex items-center justify-between border-b border-line px-3 py-2">
                  <div className="flex items-center gap-2 text-xs font-semibold text-ink"><FolderTree size={14} /> Import ledger</div>
                  <span className="font-mono text-[10px] text-muted">{plan.selectionLabel}</span>
                </div>
                <div className="divide-y divide-line">
                  {plan.entries.map((entry) => (
                    <label key={entry.path} className={`flex gap-3 px-3 py-2.5 ${entry.status === "blocked" ? "bg-red-50/50" : ""}`}>
                      <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center text-muted">
                        {entry.kind === "folder" ? <FolderTree size={14} /> : <FileText size={14} />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block break-all font-mono text-[11px] text-ink">{entry.path}</span>
                        {entry.sourcePath ? <span className="mt-0.5 block break-all text-[10px] text-muted">from {entry.sourcePath}</span> : null}
                        {entry.reason ? <span className="mt-1 block text-[10px] text-red-700">{entry.reason}</span> : null}
                      </span>
                      {entry.status === "conflict" ? (
                        <span className="flex shrink-0 items-center gap-2 text-[11px] text-amber-800">
                          <input
                            type="checkbox"
                            checked={replacements.has(entry.path)}
                            disabled={state.phase === "writing"}
                            onChange={(event) => setReplacements((current) => toggledSet(current, entry.path, event.target.checked))}
                          />
                          Replace
                        </span>
                      ) : <StatusBadge status={entry.status} />}
                    </label>
                  ))}
                </div>
              </section>

              {excluded.length > 0 ? (
                <details className="mt-3 rounded-xl border border-line bg-white px-3 py-2 text-xs">
                  <summary className="cursor-pointer font-medium text-muted">Excluded ({excluded.length})</summary>
                  <ul className="mt-2 space-y-2">
                    {excluded.map((entry) => <li key={`${entry.sourcePath}:${entry.reason}`}><span className="break-all font-mono text-[10px] text-ink">{entry.sourcePath}</span><span className="block text-[10px] text-muted">{entry.reason}</span></li>)}
                  </ul>
                </details>
              ) : null}
              {conversionFailures.length > 0 ? (
                <details className="mt-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs">
                  <summary className="cursor-pointer font-medium text-red-800">Conversion failed ({conversionFailures.length})</summary>
                  <ul className="mt-2 space-y-2">
                    {conversionFailures.map((entry) => <li key={`${entry.sourcePath}:${entry.reason}`}><span className="break-all font-mono text-[10px] text-red-900">{entry.sourcePath}</span><span className="block text-[10px] text-red-700">{entry.reason}</span></li>)}
                  </ul>
                </details>
              ) : null}
            </>
          ) : null}
        </div>

        <footer className="flex flex-col-reverse gap-2 border-t border-line bg-white px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
          <p className="text-[11px] text-muted">
            {formatBytes(LOCAL_IMPORT_SOURCE_FILE_BYTE_LIMIT)} per file · {formatBytes(LOCAL_IMPORT_SOURCE_TOTAL_BYTE_LIMIT)} total · {formatBytes(LOCAL_IMPORT_PDF_TOTAL_BYTE_LIMIT)} PDF · {formatBytes(LOCAL_IMPORT_BYTE_LIMIT)} encoded · up to 100 nodes
          </p>
          <div className="flex justify-end gap-2">
            <button data-modal-initial-focus className={secondaryButtonClass} disabled={busy} type="button" onClick={onCancel}>Cancel</button>
            {plan ? (
              <button className={primaryButtonClass} disabled={cannotImport} type="button" onClick={() => onImport(replacements)}>
                {state.phase === "writing" ? <Loader2 className="animate-spin" size={14} /> : null}
                {state.phase === "writing" ? "Importing..." : `Import ${writes.length}`}
              </button>
            ) : null}
          </div>
        </footer>
      </section>
    </dialog>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return <div className="rounded-xl border border-line bg-white px-3 py-2"><div className="font-mono text-[10px] uppercase tracking-wide text-muted">{label}</div><div className="mt-1 text-base font-semibold text-ink">{value}</div></div>;
}

function Notice({ children, tone }: { children: ReactNode; tone: "warning" | "error" }) {
  return <p className={`mt-3 rounded-lg border px-3 py-2 text-xs ${tone === "error" ? "border-red-200 bg-red-50 text-red-800" : "border-amber-200 bg-amber-50 text-amber-900"}`}>{children}</p>;
}

function StatusBadge({ status }: { status: "new" | "merge" | "blocked" }) {
  const label = status === "new" ? "New" : status === "merge" ? "Merge" : "Blocked";
  return <span className={`h-fit shrink-0 rounded-full px-2 py-0.5 font-mono text-[9px] uppercase tracking-wide ${status === "new" ? "bg-emerald-50 text-emerald-700" : status === "merge" ? "bg-blue-50 text-blue-700" : "bg-red-100 text-red-700"}`}>{label}</span>;
}

function toggledSet(current: Set<string>, path: string, checked: boolean): Set<string> {
  const next = new Set(current);
  if (checked) next.add(path); else next.delete(path);
  return next;
}

function formatBytes(bytes: number): string {
  if (bytes < 1_000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(1)} KB`;
  return `${(bytes / 1_000_000).toFixed(2)} MB`;
}

const baseButtonClass = "inline-flex min-w-[92px] items-center justify-center gap-2 rounded-xl border px-3 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50";
const secondaryButtonClass = `${baseButtonClass} border-line bg-white text-ink hover:border-accent`;
const primaryButtonClass = `${baseButtonClass} border-action bg-action text-white hover:border-accent hover:bg-accent`;
