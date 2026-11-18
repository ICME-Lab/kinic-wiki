"use client";

import type { Identity } from "@icp-sdk/core/agent";
import { useEffect, useMemo, useState } from "react";
import { toast } from "@/components/ui/toast";
import type { WikiNode } from "@/lib/types";
import { errorMessage } from "@/lib/wiki-helpers";
import { writeNodeAuthenticated } from "@/lib/vfs-client";
import { MarkdownEditor, type EditorSaveState } from "@/components/markdown-editor";
import { VaultPickerButton } from "@/components/vault-picker-button";

type EditStateChange = {
  dirty: boolean;
  saveState: EditorSaveState;
};

type StoredEditorState = {
  documentKey: string;
  baseEtag: string;
  baseContent: string;
  draft: string;
  saveState: EditorSaveState;
  saveError: string | null;
  saveWarning: string | null;
};

export function MarkdownEditDocument({
  canisterId,
  databaseId,
  node,
  isLargeContent,
  contentBytes,
  writeIdentity,
  onNodeSaved,
  onEditStateChange
}: {
  canisterId: string;
  databaseId: string;
  node: WikiNode;
  isLargeContent: boolean;
  contentBytes: number;
  writeIdentity: Identity;
  onNodeSaved: () => Promise<WikiNode>;
  onEditStateChange?: (state: EditStateChange) => void;
}) {
  const documentKey = JSON.stringify([canisterId, databaseId, node.path]);
  const currentKey = JSON.stringify([documentKey, node.etag]);
  const [storedEditor, setStoredEditor] = useState<StoredEditorState>(() => newStoredEditorState(documentKey, node.etag, node.content));
  const editor = shouldUseStoredEditor(storedEditor, documentKey, node.etag) ? storedEditor : newStoredEditorState(documentKey, node.etag, node.content);
  const dirty = editor.draft !== editor.baseContent;
  const visibleSaveState: EditorSaveState = editor.saveState === "saving" || editor.saveState === "saved" || editor.saveState === "error" ? editor.saveState : dirty ? "dirty" : "idle";

  useEffect(() => {
    if (editor.saveState !== "saved") return;
    const timeout = window.setTimeout(() => setStoredEditor((current) => ({ ...current, saveState: "idle" })), 1800);
    return () => window.clearTimeout(timeout);
  }, [editor.saveState]);

  useEffect(() => {
    onEditStateChange?.({ dirty, saveState: visibleSaveState });
  }, [dirty, onEditStateChange, visibleSaveState]);

  useSaveShortcut(() => {
    if (dirty && editor.saveState !== "saving") {
      void save();
    }
  });

  const lineCount = useMemo(() => countLines(editor.draft), [editor.draft]);
  const draftBytes = useMemo(() => new TextEncoder().encode(editor.draft).length, [editor.draft]);

  function updateDraft(change: (draft: string) => string) {
    setStoredEditor((stored) => {
      const current = shouldUseStoredEditor(stored, documentKey, node.etag) ? stored : editor;
      if (current.saveState === "saving") return stored;
      return {
        ...current,
        draft: change(current.draft),
        saveState: current.saveState === "saved" || current.saveState === "error" ? "idle" : current.saveState,
        saveError: current.saveState === "error" ? null : current.saveError,
        saveWarning: null
      };
    });
  }

  async function save() {
    setStoredEditor({ ...editor, saveState: "saving", saveError: null, saveWarning: null });
    try {
      const result = await writeNodeAuthenticated(canisterId, writeIdentity, {
        databaseId,
        path: node.path,
        kind: node.kind,
        content: editor.draft,
        metadataJson: node.metadataJson,
        expectedEtag: editor.baseEtag
      });
      const savedEditor = newSavedEditorState(documentKey, result.node.etag, editor.draft);
      setStoredEditor(savedEditor);
      let savedNode: WikiNode;
      try {
        savedNode = await onNodeSaved();
      } catch (refreshError) {
        const warning = `Saved, but refresh failed: ${errorMessage(refreshError)}`;
        toast.error(warning);
        setStoredEditor({
          ...savedEditor,
          saveWarning: warning
        });
        return;
      }
      setStoredEditor(newSavedEditorState(JSON.stringify([canisterId, databaseId, savedNode.path]), savedNode.etag, savedNode.content));
      toast.success("Saved");
    } catch (cause) {
      const message = errorMessage(cause);
      toast.error(message);
      setStoredEditor({ ...editor, saveState: "error", saveError: message, saveWarning: null });
    }
  }

  return (
    <article className="flex h-full min-h-0 flex-col">
      {isLargeContent ? (
        <div className="border-b border-yellow-200 bg-yellow-50 px-4 py-3 text-sm text-yellow-900">
          Large file: editing {contentBytes.toLocaleString()} bytes. Save is manual.
        </div>
      ) : null}
      <MarkdownEditor
        byteCount={draftBytes}
        content={editor.draft}
        disabled={editor.saveState === "saving"}
        error={editor.saveError}
        lineCount={lineCount}
        saveState={visibleSaveState}
        warning={editor.saveWarning}
        toolbarActions={(
          <VaultPickerButton
            key={currentKey}
            disabled={editor.saveState === "saving"}
            onInsert={(reference) => updateDraft((draft) => {
              const gap = !draft || draft.endsWith("\n\n") ? "" : draft.endsWith("\n") ? "\n" : "\n\n";
              return `${draft}${gap}${reference}\n`;
            })}
          />
        )}
        onChange={(nextContent) => updateDraft(() => nextContent)}
        onRevert={() => {
          setStoredEditor({ ...editor, draft: editor.baseContent, saveState: "idle", saveError: null, saveWarning: null });
        }}
        onSave={() => void save()}
      />
    </article>
  );
}

function useSaveShortcut(onSave: () => void) {
  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s") return;
      event.preventDefault();
      onSave();
    }
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [onSave]);
}

function countLines(content: string): number {
  if (!content) return 1;
  return content.split("\n").length;
}

function newStoredEditorState(documentKey: string, etag: string, content: string): StoredEditorState {
  return {
    documentKey,
    baseEtag: etag,
    baseContent: content,
    draft: content,
    saveState: "idle",
    saveError: null,
    saveWarning: null
  };
}

function shouldUseStoredEditor(editor: StoredEditorState, documentKey: string, etag: string): boolean {
  if (editor.documentKey !== documentKey) return false;
  if (editor.baseEtag === etag) return true;
  if (editor.draft !== editor.baseContent) return true;
  return editor.saveState === "saved" || editor.saveState === "saving" || editor.saveState === "error" || editor.saveWarning !== null;
}

function newSavedEditorState(documentKey: string, etag: string, content: string): StoredEditorState {
  return { ...newStoredEditorState(documentKey, etag, content), saveState: "saved" };
}
