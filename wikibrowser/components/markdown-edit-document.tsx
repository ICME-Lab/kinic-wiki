"use client";

import type { Identity } from "@icp-sdk/core/agent";
import { useEffect, useMemo, useState } from "react";
import type { WikiNode } from "@/lib/types";
import { errorMessage } from "@/lib/wiki-helpers";
import { writeNodeAuthenticated } from "@/lib/vfs-client";
import { MarkdownEditor, type EditorSaveState } from "@/components/markdown-editor";

type EditStateChange = {
  dirty: boolean;
  saveState: EditorSaveState;
};

type StoredEditorState = {
  key: string;
  path: string;
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
  const currentKey = `${node.path}\n${node.etag}`;
  const [storedEditor, setStoredEditor] = useState<StoredEditorState>(() => newStoredEditorState(currentKey, node.path, node.etag, node.content));
  const editor = shouldUseStoredEditor(storedEditor, currentKey, node.path) ? storedEditor : newStoredEditorState(currentKey, node.path, node.etag, node.content);
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

  useUnsavedNavigationGuard(dirty);
  useSaveShortcut(() => {
    if (dirty && editor.saveState !== "saving") {
      void save();
    }
  });

  const lineCount = useMemo(() => countLines(editor.draft), [editor.draft]);
  const draftBytes = useMemo(() => new TextEncoder().encode(editor.draft).length, [editor.draft]);

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
      const savedEditor = newSavedEditorState(`${node.path}\n${result.node.etag}`, node.path, result.node.etag, editor.draft);
      setStoredEditor(savedEditor);
      let savedNode: WikiNode;
      try {
        savedNode = await onNodeSaved();
      } catch (refreshError) {
        setStoredEditor({
          ...savedEditor,
          saveWarning: `Saved, but refresh failed: ${errorMessage(refreshError)}`
        });
        return;
      }
      setStoredEditor(newSavedEditorState(`${savedNode.path}\n${savedNode.etag}`, savedNode.path, savedNode.etag, savedNode.content));
    } catch (cause) {
      setStoredEditor({ ...editor, saveState: "error", saveError: errorMessage(cause), saveWarning: null });
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
        onChange={(nextContent) => {
          setStoredEditor({
            ...editor,
            draft: nextContent,
            saveState: editor.saveState === "saved" || editor.saveState === "error" ? "idle" : editor.saveState,
            saveError: editor.saveState === "error" ? null : editor.saveError,
            saveWarning: null
          });
        }}
        onRevert={() => {
          setStoredEditor({ ...editor, draft: editor.baseContent, saveState: "idle", saveError: null, saveWarning: null });
        }}
        onSave={() => void save()}
      />
    </article>
  );
}

function useUnsavedNavigationGuard(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const message = "You have unsaved Markdown changes. Leave this page?";
    function beforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = message;
    }
    function captureLinkClick(event: MouseEvent) {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
      const target = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(target instanceof HTMLAnchorElement)) return;
      if (target.target || target.download || target.origin !== window.location.origin) return;
      if (window.confirm(message)) return;
      event.preventDefault();
      event.stopPropagation();
    }
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", captureLinkClick, true);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", captureLinkClick, true);
    };
  }, [dirty]);
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

function newStoredEditorState(key: string, path: string, etag: string, content: string): StoredEditorState {
  return {
    key,
    path,
    baseEtag: etag,
    baseContent: content,
    draft: content,
    saveState: "idle",
    saveError: null,
    saveWarning: null
  };
}

function shouldUseStoredEditor(editor: StoredEditorState, currentKey: string, path: string): boolean {
  if (editor.path !== path) return false;
  if (editor.key === currentKey) return true;
  if (editor.draft !== editor.baseContent) return true;
  return editor.saveState === "saved" || editor.saveState === "saving" || editor.saveState === "error" || editor.saveWarning !== null;
}

function newSavedEditorState(key: string, path: string, etag: string, content: string): StoredEditorState {
  return {
    key,
    path,
    baseEtag: etag,
    baseContent: content,
    draft: content,
    saveState: "saved",
    saveError: null,
    saveWarning: null
  };
}
