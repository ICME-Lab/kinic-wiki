import type { ChildNode, WriteNodeItem } from "@/lib/types";
import type { ExtractedPdfImport } from "@/lib/pdf-local-import";

export const LOCAL_IMPORT_NODE_LIMIT = 100;
export const LOCAL_IMPORT_BYTE_LIMIT = 1_500_000;
export const LOCAL_IMPORT_SOURCE_FILE_BYTE_LIMIT = 20_000_000;
export const LOCAL_IMPORT_SOURCE_TOTAL_BYTE_LIMIT = 100_000_000;
export const LOCAL_IMPORT_PDF_TOTAL_BYTE_LIMIT = 50_000_000;

export type LocalImportMode = "files" | "folder";

export type LocalImportFile = Pick<File, "name" | "size" | "text" | "arrayBuffer"> & {
  webkitRelativePath: string;
};

export type LocalImportExclusion = {
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

export type PreparedLocalImport = {
  mode: LocalImportMode;
  destinationDirectory: string;
  selectionLabel: string;
  navigationPath: string;
  folders: string[];
  files: PreparedImportFile[];
  excluded: LocalImportExclusion[];
  markdownCount: number;
  pdfCount: number;
};

export type LocalImportWriteSummary = {
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

export type ReconciledLocalImport = PreparedLocalImport & {
  entries: ReconciledImportEntry[];
};

export type PrepareLocalImportOptions = {
  extractPdf?: (file: LocalImportFile, signal?: AbortSignal) => Promise<ExtractedPdfImport>;
  signal?: AbortSignal;
};

async function defaultExtractPdf(file: LocalImportFile, signal?: AbortSignal): Promise<ExtractedPdfImport> {
  if (import.meta.env.SSR) {
    throw new Error("PDF import is only available in the browser.");
  }
  const { extractPdfForLocalImport } = await import("@/lib/pdf-local-import");
  return extractPdfForLocalImport(file, signal);
}

export async function prepareLocalImport(
  selectedFiles: LocalImportFile[],
  destinationDirectory: string,
  mode: LocalImportMode,
  options: PrepareLocalImportOptions = {}
): Promise<PreparedLocalImport> {
  const { extractPdf = defaultExtractPdf, signal } = options;
  throwIfAborted(signal);
  if (selectedFiles.length === 0) {
    throw new Error(mode === "folder" ? "Choose a folder containing Markdown or PDF files." : "Choose one or more Markdown or PDF files.");
  }
  const sourcePaths = selectedFiles.map((file) => sourcePath(file, mode));
  const rootName = mode === "folder" ? folderRootName(sourcePaths) : null;
  const rootPath = rootName ? joinImportPath(destinationDirectory, rootName) : null;
  const selectionLabel = mode === "folder"
    ? rootName ?? ""
    : selectedFiles.length === 1 ? selectedFiles[0].name : `${selectedFiles.length} selected files`;

  const excluded: LocalImportExclusion[] = [];
  const prepared: PreparedImportFile[] = [];
  const candidates: Array<{ file: LocalImportFile; sourcePath: string; targetPath: string; extension: "md" | "pdf" }> = [];
  const sorted = selectedFiles
    .map((file, index) => ({ file, sourcePath: sourcePaths[index] }))
    .sort((left, right) => formatRank(left.sourcePath) - formatRank(right.sourcePath) || left.sourcePath.localeCompare(right.sourcePath));

  for (const { file, sourcePath } of sorted) {
    throwIfAborted(signal);
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
    if (file.size > LOCAL_IMPORT_SOURCE_FILE_BYTE_LIMIT) {
      excluded.push({
        sourcePath,
        category: "excluded",
        reason: `Source files must be ${LOCAL_IMPORT_SOURCE_FILE_BYTE_LIMIT.toLocaleString()} bytes or smaller.`
      });
      continue;
    }
    candidates.push({ file, sourcePath, targetPath, extension });
  }

  validateLocalImportSourceTotals(candidates);

  const candidateGroups = new Map<string, typeof candidates>();
  for (const candidate of candidates) {
    const group = candidateGroups.get(candidate.targetPath) ?? [];
    group.push(candidate);
    candidateGroups.set(candidate.targetPath, group);
  }
  for (const targetPath of [...candidateGroups.keys()].sort((left, right) => left.localeCompare(right))) {
    const group = candidateGroups.get(targetPath) ?? [];
    for (let index = 0; index < group.length; index += 1) {
      const { file, sourcePath, extension } = group[index];
      throwIfAborted(signal);
      try {
        if (extension === "md") {
          const content = await file.text();
          throwIfAborted(signal);
          prepared.push({ sourcePath, targetPath, format: "markdown", content, metadataJson: "{}" });
        } else {
          const pdf = await extractPdf(file, signal);
          throwIfAborted(signal);
          prepared.push({ sourcePath, targetPath, format: "pdf", content: pdf.content, metadataJson: pdf.metadataJson });
        }
        for (const duplicate of group.slice(index + 1)) {
          excluded.push({
            sourcePath: duplicate.sourcePath,
            category: "excluded",
            reason: "Another selected file maps to the same Markdown path."
          });
        }
        break;
      } catch (error) {
        if (isAbortError(error) || signal?.aborted) throw abortError();
        excluded.push({ sourcePath, category: "conversion-failed", reason: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  const folders = mode === "folder" && rootPath
    ? importedFolderPaths(rootPath, prepared.map((file) => file.targetPath))
    : [];
  const navigationPath = mode === "folder"
    ? rootPath ?? destinationDirectory
    : prepared.length === 1 ? prepared[0].targetPath : destinationDirectory;
  return {
    mode,
    destinationDirectory,
    selectionLabel,
    navigationPath,
    folders,
    files: prepared.sort((left, right) => left.targetPath.localeCompare(right.targetPath)),
    excluded: excluded.sort((left, right) => left.sourcePath.localeCompare(right.sourcePath)),
    markdownCount: prepared.filter((file) => file.format === "markdown").length,
    pdfCount: prepared.filter((file) => file.format === "pdf").length
  };
}

export function reconcileLocalImport(prepared: PreparedLocalImport, existingNodes: Map<string, ChildNode>): ReconciledLocalImport {
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

export function buildLocalImportWrites(importPlan: ReconciledLocalImport, replacements: Set<string>): WriteNodeItem[] {
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

export function summarizeLocalImportWrites(writes: WriteNodeItem[]): LocalImportWriteSummary {
  const nodeCount = writes.length;
  const inputBytes = estimateImportInputBytes(writes);
  return {
    nodeCount,
    inputBytes,
    limitError: nodeCount > LOCAL_IMPORT_NODE_LIMIT
      ? `This import needs ${nodeCount} nodes; the limit is ${LOCAL_IMPORT_NODE_LIMIT}.`
      : inputBytes > LOCAL_IMPORT_BYTE_LIMIT
        ? `This import needs ${inputBytes.toLocaleString()} encoded write bytes; the limit is ${LOCAL_IMPORT_BYTE_LIMIT.toLocaleString()}.`
        : null
  };
}

export async function loadExistingLocalImportNodes(
  prepared: PreparedLocalImport,
  listChildrenAt: (path: string) => Promise<ChildNode[]>,
  signal?: AbortSignal
): Promise<Map<string, ChildNode>> {
  const existing = new Map<string, ChildNode>();
  const incomingFolders = new Set(prepared.folders);
  const queue = [prepared.destinationDirectory];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const directory = queue.shift();
    if (!directory || visited.has(directory)) continue;
    visited.add(directory);
    throwIfAborted(signal);
    const children = await listChildrenAt(directory);
    throwIfAborted(signal);
    for (const child of children) {
      if (!prepared.folders.includes(child.path) && !prepared.files.some((file) => file.targetPath === child.path)) continue;
      existing.set(child.path, child);
      if (incomingFolders.has(child.path) && (child.kind === "folder" || child.kind === "directory")) queue.push(child.path);
    }
  }
  return existing;
}

function validateLocalImportSourceTotals(
  candidates: Array<{ file: LocalImportFile; sourcePath: string; targetPath: string; extension: "md" | "pdf" }>
): void {
  const sourceBytes = candidates.reduce((total, candidate) => total + candidate.file.size, 0);
  if (sourceBytes > LOCAL_IMPORT_SOURCE_TOTAL_BYTE_LIMIT) {
    throw new Error(`Selected source files total ${sourceBytes.toLocaleString()} bytes; the limit is ${LOCAL_IMPORT_SOURCE_TOTAL_BYTE_LIMIT.toLocaleString()}.`);
  }

  const pdfBytes = candidates.reduce((total, candidate) => total + (candidate.extension === "pdf" ? candidate.file.size : 0), 0);
  if (pdfBytes > LOCAL_IMPORT_PDF_TOTAL_BYTE_LIMIT) {
    throw new Error(`Selected PDF files total ${pdfBytes.toLocaleString()} bytes; the limit is ${LOCAL_IMPORT_PDF_TOTAL_BYTE_LIMIT.toLocaleString()}.`);
  }
}

function sourcePath(file: LocalImportFile, mode: LocalImportMode): string {
  if (mode === "folder") {
    const path = file.webkitRelativePath.replace(/^\/+/, "");
    if (!path || !path.includes("/")) throw new Error("The browser did not preserve the selected folder path.");
    return path;
  }
  if (!file.name || file.name.includes("/") || file.name.includes("\\")) {
    throw new Error("A selected file has an invalid name.");
  }
  return file.name;
}

function folderRootName(sourcePaths: string[]): string {
  const rootName = sourcePaths[0]?.split("/")[0]?.trim();
  if (!rootName || sourcePaths.some((path) => path.split("/")[0] !== rootName)) {
    throw new Error("Choose one local folder at a time.");
  }
  return rootName;
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

function estimateImportInputBytes(writes: WriteNodeItem[]): number {
  const encoder = new TextEncoder();
  return writes.reduce((total, write) => total
    + encoder.encode(write.path).byteLength
    + (write.kind === "folder"
      ? 2
      : encoder.encode(write.content).byteLength + encoder.encode(write.metadataJson).byteLength + 2), 0);
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

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function abortError(): DOMException {
  return new DOMException("Local import was cancelled.", "AbortError");
}
