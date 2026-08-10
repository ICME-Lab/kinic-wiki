import { describe, expect, it, vi } from "vitest";
import {
  buildLocalImportWrites,
  LOCAL_IMPORT_PDF_TOTAL_BYTE_LIMIT,
  LOCAL_IMPORT_SOURCE_FILE_BYTE_LIMIT,
  LOCAL_IMPORT_SOURCE_TOTAL_BYTE_LIMIT,
  loadExistingLocalImportNodes,
  prepareLocalImport,
  reconcileLocalImport,
  type LocalImportFile
} from "@/lib/local-import";
import type { ChildNode } from "@/lib/types";

function source(path: string, content: string, size?: number): LocalImportFile {
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

describe("local import", () => {
  it("preserves the selected root and nested Markdown paths", async () => {
    const plan = await prepareLocalImport([
      source("notes/README.MD", "# Notes"),
      source("notes/design/auth.md", "# Auth")
    ], "/Knowledge", "folder");

    expect(plan.navigationPath).toBe("/Knowledge/notes");
    expect(plan.folders).toEqual(["/Knowledge/notes", "/Knowledge/notes/design"]);
    expect(plan.files.map((file) => file.targetPath)).toEqual([
      "/Knowledge/notes/design/auth.md",
      "/Knowledge/notes/README.md"
    ]);
    expect(plan.markdownCount).toBe(2);
  });

  it("imports one Markdown file directly into the destination and navigates to it", async () => {
    const plan = await prepareLocalImport([source("README.MD", "# Notes")], "/Knowledge/guides", "files");

    expect(plan.mode).toBe("files");
    expect(plan.selectionLabel).toBe("README.MD");
    expect(plan.folders).toEqual([]);
    expect(plan.files).toEqual([expect.objectContaining({
      sourcePath: "README.MD",
      targetPath: "/Knowledge/guides/README.md",
      format: "markdown"
    })]);
    expect(plan.navigationPath).toBe("/Knowledge/guides/README.md");
  });

  it("converts one PDF directly into Markdown and navigates to it", async () => {
    const extractPdf = vi.fn(async () => ({ content: "# Manual", metadataJson: "{\"import_type\":\"pdf_text\"}", pageCount: 1 }));
    const plan = await prepareLocalImport([source("manual.PDF", "pdf")], "/Knowledge", "files", { extractPdf });

    expect(plan.files).toEqual([expect.objectContaining({
      sourcePath: "manual.PDF",
      targetPath: "/Knowledge/manual.md",
      format: "pdf",
      content: "# Manual"
    })]);
    expect(plan.navigationPath).toBe("/Knowledge/manual.md");
    expect(extractPdf).toHaveBeenCalledTimes(1);
  });

  it("imports multiple files without a wrapper folder and returns to the destination", async () => {
    const extractPdf = vi.fn(async () => ({ content: "PDF content", metadataJson: "{}", pageCount: 1 }));
    const plan = await prepareLocalImport([
      source("alpha.md", "Markdown content"),
      source("beta.pdf", "pdf")
    ], "/Memory", "files", { extractPdf });

    expect(plan.selectionLabel).toBe("2 selected files");
    expect(plan.folders).toEqual([]);
    expect(plan.files.map((file) => file.targetPath)).toEqual(["/Memory/alpha.md", "/Memory/beta.md"]);
    expect(plan.navigationPath).toBe("/Memory");
  });

  it("prefers a selected Markdown file over a PDF with the same basename", async () => {
    const extractPdf = vi.fn();
    const plan = await prepareLocalImport([
      source("manual.pdf", "pdf"),
      source("manual.md", "Markdown content")
    ], "/Knowledge", "files", { extractPdf });

    expect(plan.files).toEqual([expect.objectContaining({ sourcePath: "manual.md", targetPath: "/Knowledge/manual.md" })]);
    expect(plan.excluded).toContainEqual(expect.objectContaining({ sourcePath: "manual.pdf", category: "excluded" }));
    expect(extractPdf).not.toHaveBeenCalled();
  });

  it("prefers Markdown when a PDF maps to the same target and reports exclusions", async () => {
    const plan = await prepareLocalImport([
      source("notes/a.pdf", "pdf"),
      source("notes/a.md", "markdown"),
      source("notes/.git/config", "hidden"),
      source("notes/image.png", "image")
    ], "/Memory", "folder", { extractPdf: async () => ({ content: "pdf markdown", metadataJson: "{}", pageCount: 1 }) });

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
    const plan = await prepareLocalImport([
      source("notes/broken.pdf", "broken"),
      source("notes/image.png", "image")
    ], "/Knowledge", "folder", {
      extractPdf: async () => {
        throw new Error("Invalid PDF structure.");
      }
    });

    expect(plan.excluded).toEqual([
      { sourcePath: "notes/broken.pdf", category: "conversion-failed", reason: "Invalid PDF structure." },
      { sourcePath: "notes/image.png", category: "excluded", reason: "Only Markdown and PDF files are supported." }
    ]);
  });

  it("rejects the maximum node count before reading files", async () => {
    const many = Array.from({ length: 100 }, (_, index) => source(`notes/${index}.md`, "x"));
    const readers = many.map((file) => vi.spyOn(file, "text"));

    await expect(prepareLocalImport(many, "/Knowledge", "folder")).rejects.toThrow("can produce 101 nodes; the limit is 100");
    expect(readers.every((reader) => reader.mock.calls.length === 0)).toBe(true);
  });

  it("reports the encoded write limit after reading files", async () => {
    const tooLarge = await prepareLocalImport([source("notes/large.md", "x".repeat(1_500_000))], "/Knowledge", "folder");
    expect(tooLarge.limitError).toContain("encoded write bytes");
  });

  it("enforces aggregate source limits before reading any candidate", async () => {
    const atLimit = Array.from({ length: 5 }, (_, index) => source(
      `notes/${index}.md`,
      "accepted",
      LOCAL_IMPORT_SOURCE_TOTAL_BYTE_LIMIT / 5
    ));
    await expect(prepareLocalImport(atLimit, "/Knowledge", "folder")).resolves.toMatchObject({ markdownCount: 5 });

    const overLimit = [
      ...Array.from({ length: 5 }, (_, index) => source(`notes/over-${index}.md`, "unread", LOCAL_IMPORT_SOURCE_FILE_BYTE_LIMIT)),
      source("notes/one-more.md", "unread", 1)
    ];
    const readers = overLimit.map((file) => vi.spyOn(file, "text"));

    await expect(prepareLocalImport(overLimit, "/Knowledge", "folder")).rejects.toThrow("Selected source files total 100,000,001 bytes");
    expect(readers.every((reader) => reader.mock.calls.length === 0)).toBe(true);
  });

  it("enforces aggregate PDF limits before loading the extractor", async () => {
    const extractPdf = vi.fn(async () => ({ content: "pdf markdown", metadataJson: "{}", pageCount: 1 }));
    const atLimit = [
      source("notes/a.pdf", "pdf", LOCAL_IMPORT_SOURCE_FILE_BYTE_LIMIT),
      source("notes/b.pdf", "pdf", LOCAL_IMPORT_SOURCE_FILE_BYTE_LIMIT),
      source("notes/c.pdf", "pdf", LOCAL_IMPORT_PDF_TOTAL_BYTE_LIMIT - (2 * LOCAL_IMPORT_SOURCE_FILE_BYTE_LIMIT))
    ];
    await expect(prepareLocalImport(atLimit, "/Knowledge", "folder", { extractPdf })).resolves.toMatchObject({ pdfCount: 3 });
    expect(extractPdf).toHaveBeenCalledTimes(3);

    extractPdf.mockClear();
    const overLimit = [
      source("notes/over-a.pdf", "pdf", LOCAL_IMPORT_SOURCE_FILE_BYTE_LIMIT),
      source("notes/over-b.pdf", "pdf", LOCAL_IMPORT_SOURCE_FILE_BYTE_LIMIT),
      source("notes/over-c.pdf", "pdf", LOCAL_IMPORT_PDF_TOTAL_BYTE_LIMIT - (2 * LOCAL_IMPORT_SOURCE_FILE_BYTE_LIMIT) + 1)
    ];
    const arrayBufferReaders = overLimit.map((file) => vi.spyOn(file, "arrayBuffer"));

    await expect(prepareLocalImport(overLimit, "/Knowledge", "folder", { extractPdf })).rejects.toThrow("Selected PDF files total 50,000,001 bytes");
    expect(extractPdf).not.toHaveBeenCalled();
    expect(arrayBufferReaders.every((reader) => reader.mock.calls.length === 0)).toBe(true);
  });

  it("excludes source files above 20 MB before reading them", async () => {
    const atLimit = source("notes/limit.md", "accepted", LOCAL_IMPORT_SOURCE_FILE_BYTE_LIMIT);
    const oversized = source("notes/large.pdf", "unread", LOCAL_IMPORT_SOURCE_FILE_BYTE_LIMIT + 1);
    const unsupported = source("notes/video.mp4", "unread", LOCAL_IMPORT_SOURCE_FILE_BYTE_LIMIT + 1);
    const extractPdf = vi.fn();
    const oversizedArrayBuffer = vi.spyOn(oversized, "arrayBuffer");

    const plan = await prepareLocalImport([atLimit, oversized, unsupported], "/Knowledge", "folder", { extractPdf });

    expect(plan.files.map((file) => file.sourcePath)).toEqual(["notes/limit.md"]);
    expect(plan.excluded.map((entry) => entry.sourcePath)).toEqual(["notes/large.pdf", "notes/video.mp4"]);
    expect(plan.excluded[0]?.reason).toContain("20,000,000 bytes or smaller");
    expect(extractPdf).not.toHaveBeenCalled();
    expect(oversizedArrayBuffer).not.toHaveBeenCalled();
  });

  it("falls back to a valid PDF when the preferred Markdown is oversized", async () => {
    const markdown = source("notes/manual.md", "unread", LOCAL_IMPORT_SOURCE_FILE_BYTE_LIMIT + 1);
    const extractPdf = vi.fn(async () => ({ content: "PDF content", metadataJson: "{}", pageCount: 1 }));

    const plan = await prepareLocalImport([markdown, source("notes/manual.pdf", "pdf")], "/Knowledge", "folder", { extractPdf });

    expect(plan.files).toEqual([expect.objectContaining({ sourcePath: "notes/manual.pdf", format: "pdf" })]);
    expect(plan.excluded).toContainEqual(expect.objectContaining({ sourcePath: "notes/manual.md", category: "excluded" }));
    expect(extractPdf).toHaveBeenCalledTimes(1);
  });

  it("falls back to a valid PDF when reading the preferred Markdown fails", async () => {
    const markdown = source("notes/manual.md", "unread");
    markdown.text = vi.fn(async () => { throw new Error("Local read failed."); });
    const extractPdf = vi.fn(async () => ({ content: "PDF content", metadataJson: "{}", pageCount: 1 }));

    const plan = await prepareLocalImport([markdown, source("notes/manual.pdf", "pdf")], "/Knowledge", "folder", { extractPdf });

    expect(plan.files).toEqual([expect.objectContaining({ sourcePath: "notes/manual.pdf", format: "pdf" })]);
    expect(plan.excluded).toContainEqual({ sourcePath: "notes/manual.md", category: "conversion-failed", reason: "Local read failed." });
    expect(extractPdf).toHaveBeenCalledTimes(1);
  });

  it("does not parse a duplicate PDF after the preferred Markdown succeeds", async () => {
    const extractPdf = vi.fn();

    const plan = await prepareLocalImport([
      source("notes/manual.pdf", "pdf"),
      source("notes/manual.md", "Markdown content")
    ], "/Knowledge", "folder", { extractPdf });

    expect(plan.files).toEqual([expect.objectContaining({ sourcePath: "notes/manual.md", format: "markdown" })]);
    expect(plan.excluded).toContainEqual(expect.objectContaining({ sourcePath: "notes/manual.pdf", category: "excluded" }));
    expect(extractPdf).not.toHaveBeenCalled();
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

    const preparing = prepareLocalImport([first, second], "/Knowledge", "folder", { signal: controller.signal });
    await vi.waitFor(() => expect(first.text).toHaveBeenCalledTimes(1));
    controller.abort();
    finishFirst("first");

    await expect(preparing).rejects.toMatchObject({ name: "AbortError" });
    expect(second.text).not.toHaveBeenCalled();
  });

  it("passes cancellation to the active PDF extractor", async () => {
    const controller = new AbortController();
    const extractPdf = vi.fn((_file: LocalImportFile, signal?: AbortSignal) => new Promise<never>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true });
    }));

    const preparing = prepareLocalImport([source("notes/manual.pdf", "pdf")], "/Knowledge", "folder", {
      extractPdf,
      signal: controller.signal
    });
    await vi.waitFor(() => expect(extractPdf).toHaveBeenCalledTimes(1));
    expect(extractPdf.mock.calls[0]?.[1]).toBe(controller.signal);
    controller.abort();

    await expect(preparing).rejects.toMatchObject({ name: "AbortError" });
  });

  it("protects conflicts unless replacement is selected", async () => {
    const prepared = await prepareLocalImport([source("notes/a.md", "new")], "/Knowledge", "folder");
    const existing = new Map([
      ["/Knowledge/notes", child("/Knowledge/notes", "directory")],
      ["/Knowledge/notes/a.md", child("/Knowledge/notes/a.md", "file", "etag-1")]
    ]);
    const plan = reconcileLocalImport(prepared, existing);

    expect(plan.entries.map((entry) => entry.status)).toEqual(["merge", "conflict"]);
    expect(buildLocalImportWrites(plan, new Set())).toEqual([]);
    expect(buildLocalImportWrites(plan, new Set(["/Knowledge/notes/a.md"]))[0]).toMatchObject({
      path: "/Knowledge/notes/a.md",
      expectedEtag: "etag-1"
    });
  });

  it("discovers existing virtual folders only along incoming paths", async () => {
    const prepared = await prepareLocalImport([source("notes/topic/a.md", "a")], "/Knowledge", "folder");
    const listings = new Map<string, ChildNode[]>([
      ["/Knowledge", [child("/Knowledge/notes", "directory")]],
      ["/Knowledge/notes", [child("/Knowledge/notes/topic", "folder", "folder-etag")]],
      ["/Knowledge/notes/topic", [child("/Knowledge/notes/topic/a.md", "file", "file-etag")]]
    ]);
    const visited: string[] = [];
    const existing = await loadExistingLocalImportNodes(prepared, async (path) => {
      visited.push(path);
      return listings.get(path) ?? [];
    });

    expect(visited).toEqual(["/Knowledge", "/Knowledge/notes", "/Knowledge/notes/topic"]);
    expect(existing.get("/Knowledge/notes")?.kind).toBe("directory");
    expect(existing.get("/Knowledge/notes/topic/a.md")?.etag).toBe("file-etag");
  });

  it("stops existing-node discovery after an in-flight listing is cancelled", async () => {
    const prepared = await prepareLocalImport([source("notes/topic/a.md", "a")], "/Knowledge", "folder");
    const controller = new AbortController();
    let finishListing!: (children: ChildNode[]) => void;
    const listChildrenAt = vi.fn(() => new Promise<ChildNode[]>((resolve) => {
      finishListing = resolve;
    }));

    const loading = loadExistingLocalImportNodes(prepared, listChildrenAt, controller.signal);
    await vi.waitFor(() => expect(listChildrenAt).toHaveBeenCalledTimes(1));
    controller.abort();
    finishListing([child("/Knowledge/notes", "directory")]);

    await expect(loading).rejects.toMatchObject({ name: "AbortError" });
    expect(listChildrenAt).toHaveBeenCalledTimes(1);
  });
});
