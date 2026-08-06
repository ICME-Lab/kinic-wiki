import type { ChildNode, WriteNodeItem } from "@/lib/types";
import { extractPdfForFolderImport, type ExtractedPdfImport } from "@/lib/pdf-folder-import";

export const FOLDER_IMPORT_NODE_LIMIT = 100;
export const FOLDER_IMPORT_BYTE_LIMIT = 1_500_000;

export type FolderImportFile = Pick<File, "name" | "size" | "text" | "arrayBuffer"> & {
  webkitRelativePath: string;
};

export type FolderImportExclusion = {
  sourcePath: string;
  category: "excluded" | "conversion-failed";
  reason: string;
};

export type PreparedImportFile = {
  sourcePath: string;
  targetPath: string;
  format: "markdown" | "pdf";
  content: string;
  metadataJson: string;
};

export type PreparedFolderImport = {
  destinationDirectory: string;
  rootName: string;
  rootPath: string;
  folders: string[];
  files: PreparedImportFile[];
  excluded: FolderImportExclusion[];
  markdownCount: number;
  pdfCount: number;
  nodeCount: number;
  inputBytes: number;
  limitError: string | null;
};

export type ReconciledImportEntry = {
  path: string;
  kind: "folder" | "file";
  sourcePath: string | null;
  status: "new" | "merge" | "conflict" | "blocked";
  reason: string | null;
  expectedEtag: string | null;
  file: PreparedImportFile | null;
};

export type ReconciledFolderImport = PreparedFolderImport & {
  entries: ReconciledImportEntry[];
};

export async function prepareFolderImport(
  selectedFiles: FolderImportFile[],
  destinationDirectory: string,
  extractPdf: (file: FolderImportFile) => Promise<ExtractedPdfImport> = extractPdfForFolderImport
): Promise<PreparedFolderImport> {
  if (selectedFiles.length === 0) throw new Error("Choose a folder containing Markdown or PDF files.");
  const relativePaths = selectedFiles.map(relativePath);
  const rootName = relativePaths[0]?.split("/")[0]?.trim();
  if (!rootName || relativePaths.some((path) => path.split("/")[0] !== rootName)) {
    throw new Error("Choose one local folder at a time.");
  }

  const rootPath = joinImportPath(destinationDirectory, rootName);
  const excluded: FolderImportExclusion[] = [];
  const prepared: PreparedImportFile[] = [];
  const claimedTargets = new Set<string>();
  const sorted = selectedFiles
    .map((file, index) => ({ file, sourcePath: relativePaths[index] }))
    .sort((left, right) => formatRank(left.sourcePath) - formatRank(right.sourcePath) || left.sourcePath.localeCompare(right.sourcePath));

  for (const { file, sourcePath } of sorted) {
    const segments = sourcePath.split("/").filter(Boolean);
    if (segments.some((segment) => segment.startsWith("."))) {
      excluded.push({ sourcePath, category: "excluded", reason: "Hidden paths are not imported." });
      continue;
    }
    const extension = extensionOf(sourcePath);
    if (extension !== "md" && extension !== "pdf") {
      excluded.push({ sourcePath, category: "excluded", reason: "Only Markdown and PDF files are supported." });
      continue;
    }
    const relativeTarget = extension === "pdf"
      ? sourcePath.replace(/\.pdf$/i, ".md")
      : sourcePath.replace(/\.md$/i, ".md");
    const targetPath = joinImportPath(destinationDirectory, relativeTarget);
    if (claimedTargets.has(targetPath)) {
      excluded.push({ sourcePath, category: "excluded", reason: "Another selected file maps to the same Markdown path." });
      continue;
    }

    try {
      if (extension === "md") {
        prepared.push({ sourcePath, targetPath, format: "markdown", content: await file.text(), metadataJson: "{}" });
      } else {
        const pdf = await extractPdf(file);
        prepared.push({ sourcePath, targetPath, format: "pdf", content: pdf.content, metadataJson: pdf.metadataJson });
      }
      claimedTargets.add(targetPath);
    } catch (error) {
      excluded.push({ sourcePath, category: "conversion-failed", reason: error instanceof Error ? error.message : String(error) });
    }
  }

  const folders = importedFolderPaths(rootPath, prepared.map((file) => file.targetPath));
  const nodeCount = folders.length + prepared.length;
  const inputBytes = estimateImportInputBytes(folders, prepared);
  return {
    destinationDirectory,
    rootName,
    rootPath,
    folders,
    files: prepared.sort((left, right) => left.targetPath.localeCompare(right.targetPath)),
    excluded: excluded.sort((left, right) => left.sourcePath.localeCompare(right.sourcePath)),
    markdownCount: prepared.filter((file) => file.format === "markdown").length,
    pdfCount: prepared.filter((file) => file.format === "pdf").length,
    nodeCount,
    inputBytes,
    limitError: nodeCount > FOLDER_IMPORT_NODE_LIMIT
      ? `This folder needs ${nodeCount} nodes; the limit is ${FOLDER_IMPORT_NODE_LIMIT}.`
      : inputBytes > FOLDER_IMPORT_BYTE_LIMIT
        ? `This folder needs ${inputBytes.toLocaleString()} input bytes; the limit is ${FOLDER_IMPORT_BYTE_LIMIT.toLocaleString()}.`
        : null
  };
}

export function reconcileFolderImport(prepared: PreparedFolderImport, existingNodes: Map<string, ChildNode>): ReconciledFolderImport {
  const entries: ReconciledImportEntry[] = [];
  const blockedFolders = new Set<string>();
  for (const path of prepared.folders) {
    const ancestor = blockedAncestor(path, blockedFolders);
    const existing = existingNodes.get(path);
    const blocked = ancestor || (existing && existing.kind !== "folder" && existing.kind !== "directory");
    if (blocked) blockedFolders.add(path);
    entries.push({
      path,
      kind: "folder",
      sourcePath: null,
      status: blocked ? "blocked" : existing ? "merge" : "new",
      reason: blocked ? `A file already occupies ${ancestor ?? path}.` : null,
      expectedEtag: null,
      file: null
    });
  }
  for (const file of prepared.files) {
    const ancestor = blockedAncestor(file.targetPath, blockedFolders);
    const existing = existingNodes.get(file.targetPath);
    const replaceable = existing?.kind === "file" && Boolean(existing.etag);
    const blocked = ancestor || (existing && !replaceable);
    entries.push({
      path: file.targetPath,
      kind: "file",
      sourcePath: file.sourcePath,
      status: blocked ? "blocked" : replaceable ? "conflict" : "new",
      reason: blocked ? `A non-Markdown node already occupies ${ancestor ?? file.targetPath}.` : null,
      expectedEtag: replaceable ? existing.etag : null,
      file
    });
  }
  return { ...prepared, entries };
}

export function buildFolderImportWrites(importPlan: ReconciledFolderImport, replacements: Set<string>): WriteNodeItem[] {
  return importPlan.entries
    .filter((entry) => entry.status === "new" || (entry.status === "conflict" && replacements.has(entry.path)))
    .sort(compareImportEntries)
    .map((entry) => entry.kind === "folder"
      ? { path: entry.path, kind: "folder", content: "", metadataJson: "{}", expectedEtag: null }
      : {
          path: entry.path,
          kind: "file",
          content: entry.file?.content ?? "",
          metadataJson: entry.file?.metadataJson ?? "{}",
          expectedEtag: entry.status === "conflict" ? entry.expectedEtag : null
        });
}

export async function loadExistingImportNodes(
  prepared: PreparedFolderImport,
  listChildrenAt: (path: string) => Promise<ChildNode[]>
): Promise<Map<string, ChildNode>> {
  const existing = new Map<string, ChildNode>();
  const incomingFolders = new Set(prepared.folders);
  const queue = [prepared.destinationDirectory];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const directory = queue.shift();
    if (!directory || visited.has(directory)) continue;
    visited.add(directory);
    const children = await listChildrenAt(directory);
    for (const child of children) {
      if (!prepared.folders.includes(child.path) && !prepared.files.some((file) => file.targetPath === child.path)) continue;
      existing.set(child.path, child);
      if (incomingFolders.has(child.path) && (child.kind === "folder" || child.kind === "directory")) queue.push(child.path);
    }
  }
  return existing;
}

function relativePath(file: FolderImportFile): string {
  const path = file.webkitRelativePath.replace(/^\/+/, "");
  if (!path || !path.includes("/")) throw new Error("The browser did not preserve the selected folder path.");
  return path;
}

function joinImportPath(directory: string, relativePath: string): string {
  return directory === "/" ? `/${relativePath}` : `${directory}/${relativePath}`;
}

function extensionOf(path: string): string {
  const match = /\.([^./]+)$/.exec(path);
  return match?.[1]?.toLowerCase() ?? "";
}

function formatRank(path: string): number {
  return extensionOf(path) === "md" ? 0 : extensionOf(path) === "pdf" ? 1 : 2;
}

function importedFolderPaths(rootPath: string, filePaths: string[]): string[] {
  if (filePaths.length === 0) return [];
  const folders = new Set<string>([rootPath]);
  for (const path of filePaths) {
    let parent = path.slice(0, path.lastIndexOf("/"));
    while (parent.startsWith(rootPath)) {
      folders.add(parent);
      if (parent === rootPath) break;
      parent = parent.slice(0, parent.lastIndexOf("/"));
    }
  }
  return [...folders].sort((left, right) => pathDepth(left) - pathDepth(right) || left.localeCompare(right));
}

function estimateImportInputBytes(folders: string[], files: PreparedImportFile[]): number {
  const encoder = new TextEncoder();
  return folders.reduce((total, path) => total + encoder.encode(path).byteLength + 2, 0)
    + files.reduce((total, file) => total
      + encoder.encode(file.targetPath).byteLength
      + encoder.encode(file.content).byteLength
      + encoder.encode(file.metadataJson).byteLength
      + 2, 0);
}

function blockedAncestor(path: string, blockedFolders: Set<string>): string | null {
  return [...blockedFolders].find((folder) => path === folder || path.startsWith(`${folder}/`)) ?? null;
}

function pathDepth(path: string): number {
  return path.split("/").filter(Boolean).length;
}

function compareImportEntries(left: ReconciledImportEntry, right: ReconciledImportEntry): number {
  if (left.kind !== right.kind) return left.kind === "folder" ? -1 : 1;
  return left.kind === "folder"
    ? pathDepth(left.path) - pathDepth(right.path) || left.path.localeCompare(right.path)
    : left.path.localeCompare(right.path);
}
