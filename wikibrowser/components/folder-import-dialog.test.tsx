// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FolderImportDialog } from "@/components/folder-import-dialog";
import { prepareFolderImport, reconcileFolderImport, type FolderImportFile } from "@/lib/local-folder-import";
import type { ChildNode } from "@/lib/types";

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal() { this.open = true; };
  HTMLDialogElement.prototype.close = function close() { this.open = false; };
});

afterEach(cleanup);

describe("FolderImportDialog", () => {
  it("allows cancellation while preparing but locks cancellation while writing", async () => {
    const onCancel = vi.fn();
    const prepared = await prepareFolderImport([source("notes/a.md", "new")], "/Knowledge");
    const plan = reconcileFolderImport(prepared, new Map());
    const { rerender } = render(
      <FolderImportDialog state={{ phase: "preparing", destinationDirectory: "/Knowledge" }} onCancel={onCancel} onImport={vi.fn()} />
    );

    expect(screen.getByText("20.00 MB per file · 100.00 MB total · 50.00 MB PDF · 1.50 MB encoded · up to 100 nodes")).toBeTruthy();
    const cancel = screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement;
    expect(cancel.disabled).toBe(false);
    fireEvent.click(cancel);
    expect(onCancel).toHaveBeenCalledTimes(1);

    onCancel.mockClear();
    rerender(<FolderImportDialog state={{ phase: "writing", plan }} onCancel={onCancel} onImport={vi.fn()} />);
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("keeps an existing file until replacement is explicitly selected", async () => {
    const prepared = await prepareFolderImport([source("notes/a.md", "new")], "/Knowledge");
    const existing = new Map<string, ChildNode>([
      ["/Knowledge/notes", child("/Knowledge/notes", "folder", "folder")],
      ["/Knowledge/notes/a.md", child("/Knowledge/notes/a.md", "file", "etag")]
    ]);
    const plan = reconcileFolderImport(prepared, existing);
    const onImport = vi.fn();
    render(<FolderImportDialog state={{ phase: "ready", plan }} onCancel={vi.fn()} onImport={onImport} />);

    expect(screen.getByText("1 existing file will be kept unless replacement is selected.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Import 0" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Import 1" }));
    expect(onImport).toHaveBeenCalledTimes(1);
    expect([...onImport.mock.calls[0][0]]).toEqual(["/Knowledge/notes/a.md"]);
  });
});

function source(path: string, content: string): FolderImportFile {
  const bytes = new TextEncoder().encode(content);
  return {
    name: path.split("/").at(-1) ?? path,
    size: bytes.byteLength,
    webkitRelativePath: path,
    text: async () => content,
    arrayBuffer: async () => bytes.buffer
  };
}

function child(path: string, kind: ChildNode["kind"], etag: string): ChildNode {
  return {
    path,
    name: path.split("/").at(-1) ?? path,
    kind,
    etag,
    updatedAt: null,
    sizeBytes: null,
    isVirtual: false,
    hasChildren: kind === "folder",
    isPublished: false
  };
}
