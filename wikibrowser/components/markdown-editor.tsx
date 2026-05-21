"use client";

import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { EditorView } from "@codemirror/view";
import CodeMirror from "@uiw/react-codemirror";
import { Save, RotateCcw } from "lucide-react";
import { useMemo } from "react";

export type EditorSaveState = "idle" | "dirty" | "saving" | "saved" | "error";

export function MarkdownEditor({
  content,
  disabled,
  lineCount,
  byteCount,
  saveState,
  error,
  warning,
  onChange,
  onRevert,
  onSave
}: {
  content: string;
  disabled: boolean;
  lineCount: number;
  byteCount: number;
  saveState: EditorSaveState;
  error: string | null;
  warning: string | null;
  onChange: (content: string) => void;
  onRevert: () => void;
  onSave: () => void;
}) {
  const extensions = useMemo(() => [markdown({ base: markdownLanguage, codeLanguages: languages }), EditorView.lineWrapping], []);
  const busy = saveState === "saving";
  const canSave = (saveState === "dirty" || saveState === "error") && !disabled && !busy;
  const canRevert = (saveState === "dirty" || saveState === "error") && !disabled && !busy;
  return (
    <div className="flex h-full min-h-0 flex-col bg-white">
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-line bg-paper/95 px-4 py-3 backdrop-blur">
        <button
          aria-busy={busy}
          className="inline-flex items-center gap-1.5 rounded-2xl bg-action px-3 py-2 text-sm font-bold text-white hover:-translate-y-[3px] hover:bg-accent disabled:cursor-not-allowed disabled:translate-y-0 disabled:opacity-50"
          disabled={!canSave}
          type="button"
          onClick={onSave}
        >
          <Save size={15} />
          Save
        </button>
        <button
          className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink disabled:cursor-not-allowed disabled:opacity-50"
          disabled={!canRevert}
          type="button"
          onClick={onRevert}
        >
          <RotateCcw size={15} />
          Revert
        </button>
        <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${statusClassName(saveState)}`}>
          {statusLabel(saveState)}
        </span>
        <span className="ml-auto font-mono text-xs text-muted">
          {lineCount.toLocaleString()} lines / {byteCount.toLocaleString()} bytes
        </span>
        {warning ? <p className="basis-full text-sm text-yellow-800">{warning}</p> : null}
        {error ? <p className="basis-full text-sm text-red-700">{error}</p> : null}
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <CodeMirror
          basicSetup={{
            foldGutter: false,
            highlightActiveLine: true,
            highlightSelectionMatches: true,
            lineNumbers: true,
            searchKeymap: true
          }}
          className="h-full"
          editable={!disabled}
          extensions={extensions}
          height="100%"
          value={content}
          onChange={onChange}
        />
      </div>
    </div>
  );
}

function statusLabel(state: EditorSaveState): string {
  if (state === "dirty") return "Unsaved";
  if (state === "saving") return "Saving";
  if (state === "saved") return "Saved";
  if (state === "error") return "Save failed";
  return "Clean";
}

function statusClassName(state: EditorSaveState): string {
  if (state === "dirty") return "bg-yellow-100 text-yellow-900";
  if (state === "saving") return "bg-accentSoft text-accentText";
  if (state === "saved") return "bg-emerald-100 text-emerald-900";
  if (state === "error") return "bg-red-100 text-red-900";
  return "bg-white text-muted";
}
