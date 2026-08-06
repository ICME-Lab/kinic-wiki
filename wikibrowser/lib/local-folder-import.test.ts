import { describe, expect, it, vi } from "vitest";
import {
  buildFolderImportWrites,
  FOLDER_IMPORT_SOURCE_FILE_BYTE_LIMIT,
  loadExistingImportNodes,
  prepareFolderImport,
  reconcileFolderImport,
  type FolderImportFile
} from "@/lib/local-folder-import";
import type { ChildNode } from "@/lib/types";

function source(path: string, content: string, size?: number): FolderImportFile {
  const bytes = new TextEncoder().encode(content);
  return {
    name: path.split("/").at(-1) ?? path,
    size: size ?? bytes.byteLength,
    webkitRelativePath: path,
    text: async () => content,
    arrayBuffer: async () => bytes.buffer
  };
}

function child(path: string, kind: ChildNode["kind"], etag: string | null = null): ChildNode {
  return {
    path,
    name: path.split("/").at(-1) ?? path,
    kind,
    etag,
    updatedAt: null,
    sizeBytes: null,
    isVirtual: kind === "directory",
    hasChildren: kind === "folder" || kind === "directory",
    isPublished: false
  };
}

describe("local folder import", () => {
  it("preserves the selected root and nested Markdown paths", async () => {
    const plan = await prepareFolderImport([
      source("notes/README.MD", "# Notes"),
      source("notes/design/auth.md", "# Auth")
    ], "/Knowledge");

    expect(plan.rootPath).toBe("/Knowledge/notes");
    expect(plan.folders).toEqual(["/Knowledge/notes", "/Knowledge/notes/design"]);
    expect(plan.files.map((file) => file.targetPath)).toEqual([
      "/Knowledge/notes/design/auth.md",
      "/Knowledge/notes/README.md"
    ]);
    expect(plan.markdownCount).toBe(2);
  });

  it("prefers Markdown when a PDF maps to the same target and reports exclusions", async () => {
    const plan = await prepareFolderImport([
      source("notes/a.pdf", "pdf"),
      source("notes/a.md", "markdown"),
      source("notes/.git/config", "hidden"),
      source("notes/image.png", "image")
    ], "/Memory", { extractPdf: async () => ({ content: "pdf markdown", metadataJson: "{}", pageCount: 1 }) });

    expect(plan.files).toHaveLength(1);
    expect(plan.files[0]?.format).toBe("markdown");
    expect(plan.excluded.map((entry) => entry.sourcePath)).toEqual([
      "notes/.git/config",
      "notes/a.pdf",
      "notes/image.png"
    ]);
    expect(plan.excluded.every((entry) => entry.category === "excluded")).toBe(true);
  });

  it("reports PDF conversion failures separately from ordinary exclusions", async () => {
    const plan = await prepareFolderImport([
      source("notes/broken.pdf", "broken"),
      source("notes/image.png", "image")
    ], "/Knowledge", {
      extractPdf: async () => {
        throw new Error("Invalid PDF structure.");
      }
    });

    expect(plan.excluded).toEqual([
      { sourcePath: "notes/broken.pdf", category: "conversion-failed", reason: "Invalid PDF structure." },
      { sourcePath: "notes/image.png", category: "excluded", reason: "Only Markdown and PDF files are supported." }
    ]);
  });

  it("rejects node and byte limits before writing", async () => {
    const many = Array.from({ length: 100 }, (_, index) => source(`notes/${index}.md`, "x"));
    const tooMany = await prepareFolderImport(many, "/Knowledge");
    expect(tooMany.nodeCount).toBe(101);
    expect(tooMany.limitError).toContain("limit is 100");

    const tooLarge = await prepareFolderImport([source("notes/large.md", "x".repeat(1_500_000))], "/Knowledge");
    expect(tooLarge.limitError).toContain("encoded write bytes");
  });

  it("excludes source files above 20 MB before reading them", async () => {
    const atLimit = source("notes/limit.md", "accepted", FOLDER_IMPORT_SOURCE_FILE_BYTE_LIMIT);
    const oversized = source("notes/large.pdf", "unread", FOLDER_IMPORT_SOURCE_FILE_BYTE_LIMIT + 1);
    const unsupported = source("notes/video.mp4", "unread", FOLDER_IMPORT_SOURCE_FILE_BYTE_LIMIT + 1);
    const extractPdf = vi.fn();
    const oversizedArrayBuffer = vi.spyOn(oversized, "arrayBuffer");

    const plan = await prepareFolderImport([atLimit, oversized, unsupported], "/Knowledge", { extractPdf });

    expect(plan.files.map((file) => file.sourcePath)).toEqual(["notes/limit.md"]);
    expect(plan.excluded.map((entry) => entry.sourcePath)).toEqual(["notes/large.pdf", "notes/video.mp4"]);
    expect(plan.excluded[0]?.reason).toContain("20,000,000 bytes or smaller");
    expect(extractPdf).not.toHaveBeenCalled();
    expect(oversizedArrayBuffer).not.toHaveBeenCalled();
  });

  it("stops after cancellation without reporting a conversion failure", async () => {
    const controller = new AbortController();
    const first = source("notes/a.md", "first");
    const second = source("notes/b.md", "second");
    let finishFirst!: (value: string) => void;
    first.text = vi.fn(() => new Promise<string>((resolve) => {
      finishFirst = resolve;
    }));
    second.text = vi.fn(async () => "second");

    const preparing = prepareFolderImport([first, second], "/Knowledge", { signal: controller.signal });
    await vi.waitFor(() => expect(first.text).toHaveBeenCalledTimes(1));
    controller.abort();
    finishFirst("first");

    await expect(preparing).rejects.toMatchObject({ name: "AbortError" });
    expect(second.text).not.toHaveBeenCalled();
  });

  it("passes cancellation to the active PDF extractor", async () => {
    const controller = new AbortController();
    const extractPdf = vi.fn((_file: FolderImportFile, signal?: AbortSignal) => new Promise<never>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true });
    }));

    const preparing = prepareFolderImport([source("notes/manual.pdf", "pdf")], "/Knowledge", {
      extractPdf,
      signal: controller.signal
    });
    await vi.waitFor(() => expect(extractPdf).toHaveBeenCalledTimes(1));
    expect(extractPdf.mock.calls[0]?.[1]).toBe(controller.signal);
    controller.abort();

    await expect(preparing).rejects.toMatchObject({ name: "AbortError" });
  });

  it("protects conflicts unless replacement is selected", async () => {
    const prepared = await prepareFolderImport([source("notes/a.md", "new")], "/Knowledge");
    const existing = new Map([
      ["/Knowledge/notes", child("/Knowledge/notes", "directory")],
      ["/Knowledge/notes/a.md", child("/Knowledge/notes/a.md", "file", "etag-1")]
    ]);
    const plan = reconcileFolderImport(prepared, existing);

    expect(plan.entries.map((entry) => entry.status)).toEqual(["merge", "conflict"]);
    expect(buildFolderImportWrites(plan, new Set())).toEqual([]);
    expect(buildFolderImportWrites(plan, new Set(["/Knowledge/notes/a.md"]))[0]).toMatchObject({
      path: "/Knowledge/notes/a.md",
      expectedEtag: "etag-1"
    });
  });

  it("discovers existing virtual folders only along incoming paths", async () => {
    const prepared = await prepareFolderImport([source("notes/topic/a.md", "a")], "/Knowledge");
    const listings = new Map<string, ChildNode[]>([
      ["/Knowledge", [child("/Knowledge/notes", "directory")]],
      ["/Knowledge/notes", [child("/Knowledge/notes/topic", "folder", "folder-etag")]],
      ["/Knowledge/notes/topic", [child("/Knowledge/notes/topic/a.md", "file", "file-etag")]]
    ]);
    const visited: string[] = [];
    const existing = await loadExistingImportNodes(prepared, async (path) => {
      visited.push(path);
      return listings.get(path) ?? [];
    });

    expect(visited).toEqual(["/Knowledge", "/Knowledge/notes", "/Knowledge/notes/topic"]);
    expect(existing.get("/Knowledge/notes")?.kind).toBe("directory");
    expect(existing.get("/Knowledge/notes/topic/a.md")?.etag).toBe("file-etag");
  });
});
