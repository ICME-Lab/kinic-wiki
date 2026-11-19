"use client";

import type { Identity } from "@icp-sdk/core/agent";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
  baseEtag: string;
  baseContent: string;
  draft: string;
  saveState: EditorSaveState;
  saveError: string | null;
  saveWarning: string | null;
};

type MarkdownEditDocumentProps = {
  canisterId: string;
  databaseId: string;
  node: WikiNode;
  isLargeContent: boolean;
  contentBytes: number;
  writeIdentity: Identity;
  onNodeSaved: () => Promise<WikiNode>;
  onEditStateChange?: (state: EditStateChange) => void;
};

export function MarkdownEditDocument(props: MarkdownEditDocumentProps) {
  const documentKey = JSON.stringify([props.canisterId, props.databaseId, props.node.path]);
  return <DocumentEditor key={documentKey} {...props} />;
}

function DocumentEditor({
  canisterId,
  databaseId,
  node,
  isLargeContent,
  contentBytes,
  writeIdentity,
  onNodeSaved,
  onEditStateChange
}: MarkdownEditDocumentProps) {
  const [storedEditor, setStoredEditor] = useState<StoredEditorState>(() => newStoredEditorState(node.etag, node.content));
  const editor = shouldUseStoredEditor(storedEditor, node.etag) ? storedEditor : newStoredEditorState(node.etag, node.content);
  const saveScope = useRef<{ pending: boolean }>(undefined);

  useLayoutEffect(() => {
    saveScope.current = { pending: false };
    return () => { saveScope.current = undefined; };
  }, []);

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
      const current = shouldUseStoredEditor(stored, node.etag) ? stored : editor;
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
    const scope = saveScope.current;
    if (!scope || scope.pending) return;
    scope.pending = true;
    setStoredEditor({ ...editor, saveState: "saving", saveError: null, saveWarning: null });

    let savedEditor: StoredEditorState | undefined;
    try {
      const result = await writeNodeAuthenticated(canisterId, writeIdentity, {
        databaseId,
        path: node.path,
        kind: node.kind,
        content: editor.draft,
        metadataJson: node.metadataJson,
        expectedEtag: editor.baseEtag
      });
      savedEditor = newSavedEditorState(result.node.etag, editor.draft);

      // The refresh invalidates the saved article's cache even if the user navigated away.
      const savedNode = await onNodeSaved();
      if (saveScope.current !== scope) return;
      if (savedNode.path !== node.path) throw new Error("The refresh returned a different article.");
      setStoredEditor(newSavedEditorState(savedNode.etag, savedNode.content));
      toast.success("Saved");
    } catch (cause) {
      if (saveScope.current !== scope) return;
      const message = errorMessage(cause);
      if (savedEditor) {
        const warning = `Saved, but refresh failed: ${message}`;
        toast.error(warning);
        setStoredEditor({ ...savedEditor, saveWarning: warning });
      } else {
        toast.error(message);
        setStoredEditor({ ...editor, saveState: "error", saveError: message, saveWarning: null });
      }
    } finally {
      scope.pending = false;
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
            key={node.etag}
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

function newStoredEditorState(etag: string, content: string): StoredEditorState {
  return {
    baseEtag: etag,
    baseContent: content,
    draft: content,
    saveState: "idle",
    saveError: null,
    saveWarning: null
  };
}

function shouldUseStoredEditor(editor: StoredEditorState, etag: string): boolean {
  if (editor.baseEtag === etag) return true;
  if (editor.draft !== editor.baseContent) return true;
  return editor.saveState === "saved" || editor.saveState === "saving" || editor.saveState === "error" || editor.saveWarning !== null;
}

function newSavedEditorState(etag: string, content: string): StoredEditorState {
  return { ...newStoredEditorState(etag, content), saveState: "saved" };
}
