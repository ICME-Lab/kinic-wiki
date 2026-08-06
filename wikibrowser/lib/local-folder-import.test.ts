import { describe, expect, it } from "vitest";
import {
  buildFolderImportWrites,
  loadExistingImportNodes,
  prepareFolderImport,
  reconcileFolderImport,
  type FolderImportFile
} from "@/lib/local-folder-import";
import type { ChildNode } from "@/lib/types";

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
    ], "/Memory", async () => ({ content: "pdf markdown", metadataJson: "{}", pageCount: 1 }));

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
    ], "/Knowledge", async () => {
      throw new Error("Invalid PDF structure.");
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
    expect(tooLarge.limitError).toContain("input bytes");
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
