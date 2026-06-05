"use client";

import { AlertTriangle } from "lucide-react";
import { hrefForPath } from "@/lib/paths";
import { collectLintHints } from "@/lib/lint-hints";
import type { WikiNode } from "@/lib/types";

export function LintPanel({ path, node, canisterId, databaseId }: { path: string; node: WikiNode | null; canisterId: string; databaseId: string }) {
  if (!node) {
    return <p className="min-h-0 flex-1 p-4 text-sm text-muted">Select a markdown node to inspect lightweight hints.</p>;
  }
  const hints = collectLintHints(path, node.content);
  return (
    <div className="min-h-0 flex-1 space-y-2 overflow-auto p-3">
      {hints.length === 0 ? (
        <div className="rounded-xl border border-green-200 bg-green-50 p-3 text-sm text-green-800">
          No lightweight warnings for this note.
        </div>
      ) : null}
      {hints.map((hint) => (
        <div key={`${hint.title}-${hint.line}`} className="rounded-xl border border-yellow-200 bg-yellow-50 p-3 text-sm">
          <div className="flex items-center gap-2 text-yellow-800">
            <AlertTriangle size={14} />
            <span className="font-semibold">{hint.title}</span>
            <span className="rounded-full bg-yellow-200 px-2 py-0.5 font-mono text-[10px] uppercase">
              {hint.severity}
            </span>
          </div>
          <p className="mt-2 text-xs text-yellow-900">{hint.detail}</p>
          {hint.preview ? <p className="mt-2 rounded bg-white/70 p-2 font-mono text-[11px] text-yellow-950">{hint.preview}</p> : null}
          {hint.line ? <p className="mt-2 font-mono text-[11px] text-yellow-700">line {hint.line}</p> : null}
          <a className="mt-2 inline-block text-xs text-accent" href={hrefForPath(canisterId, databaseId, path, "raw", "lint")}>
            Open raw view
          </a>
        </div>
      ))}
    </div>
  );
}
