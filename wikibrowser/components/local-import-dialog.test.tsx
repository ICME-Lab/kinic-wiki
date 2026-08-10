// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { LocalImportDialog } from "@/components/local-import-dialog";
import { prepareLocalImport, reconcileLocalImport, type LocalImportFile } from "@/lib/local-import";
import type { ChildNode } from "@/lib/types";

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal() { this.open = true; };
  HTMLDialogElement.prototype.close = function close() { this.open = false; };
});

afterEach(cleanup);

describe("LocalImportDialog", () => {
  it("allows cancellation while preparing but locks cancellation while writing", async () => {
    const onCancel = vi.fn();
    const prepared = await prepareLocalImport([source("notes/a.md", "new")], "/Knowledge", "folder");
    const plan = reconcileLocalImport(prepared, new Map());
    const { rerender } = render(
      <LocalImportDialog state={{ phase: "preparing", mode: "folder", destinationDirectory: "/Knowledge" }} onCancel={onCancel} onImport={vi.fn()} />
    );

    expect(screen.getByText("20.00 MB per file · 100.00 MB total · 50.00 MB PDF · 1.50 MB encoded · up to 100 nodes")).toBeTruthy();
    const cancel = screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement;
    expect(cancel.disabled).toBe(false);
    fireEvent.click(cancel);
    expect(onCancel).toHaveBeenCalledTimes(1);

    onCancel.mockClear();
    rerender(<LocalImportDialog state={{ phase: "writing", plan }} onCancel={onCancel} onImport={vi.fn()} />);
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("keeps an existing file until replacement is explicitly selected", async () => {
    const prepared = await prepareLocalImport([source("notes/a.md", "new")], "/Knowledge", "folder");
    const existing = new Map<string, ChildNode>([
      ["/Knowledge/notes", child("/Knowledge/notes", "folder", "folder")],
      ["/Knowledge/notes/a.md", child("/Knowledge/notes/a.md", "file", "etag")]
    ]);
    const plan = reconcileLocalImport(prepared, existing);
    const onImport = vi.fn();
    render(<LocalImportDialog state={{ phase: "ready", plan }} onCancel={vi.fn()} onImport={onImport} />);

    expect(screen.getByText("1 existing file will be kept unless replacement is selected.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Import 0" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Import 1" }));
    expect(onImport).toHaveBeenCalledTimes(1);
    expect([...onImport.mock.calls[0][0]]).toEqual(["/Knowledge/notes/a.md"]);
  });

  it("updates the write limit after replacement selection", async () => {
    const prepared = await prepareLocalImport([
      source("small.md", "small"),
      source("large.md", "x".repeat(1_500_000))
    ], "/Knowledge", "files");
    const plan = reconcileLocalImport(prepared, new Map<string, ChildNode>([
      ["/Knowledge/large.md", child("/Knowledge/large.md", "file", "etag-large")]
    ]));

    render(<LocalImportDialog state={{ phase: "ready", plan }} onCancel={vi.fn()} onImport={vi.fn()} />);

    expect(screen.queryByText(/encoded write bytes/)).toBeNull();
    expect((screen.getByRole("button", { name: "Import 1" }) as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByRole("checkbox"));

    expect(screen.getByText(/encoded write bytes/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Import 2" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows file-specific copy for a file selection", async () => {
    const prepared = await prepareLocalImport([source("guide.md", "# Guide")], "/Knowledge", "files");
    const plan = reconcileLocalImport(prepared, new Map());

    render(<LocalImportDialog state={{ phase: "ready", plan }} onCancel={vi.fn()} onImport={vi.fn()} />);

    expect(screen.getByRole("dialog", { name: "Import files" })).toBeTruthy();
    expect(screen.getByText("Local files → Wiki")).toBeTruthy();
    expect(screen.getByText("guide.md")).toBeTruthy();
  });
});

function source(path: string, content: string): LocalImportFile {
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
