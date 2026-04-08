// Where: plugins/kinic-wiki/mirror.ts
// What: Vault mirror reads and writes for FS-first remote nodes.
// Why: The plugin mirrors remote paths directly and tracks etags in file frontmatter.
import { App, Notice, TFile, TFolder, normalizePath } from "obsidian";

import {
  parseMirrorFrontmatter,
  serializeMirrorFile,
  stripManagedFrontmatter
} from "./frontmatter";
import { MirrorFrontmatter, NodeSnapshot, TrackedNodeState } from "./types";

export async function collectManagedNodes(app: App, mirrorRoot: string): Promise<Array<{ file: TFile; metadata: MirrorFrontmatter }>> {
  const root = managedRoot(mirrorRoot);
  const conflictRoot = conflictRootPath(mirrorRoot);
  const results: Array<{ file: TFile; metadata: MirrorFrontmatter }> = [];
  for (const file of app.vault.getFiles()) {
    if (!file.path.startsWith(root) || file.path.startsWith(conflictRoot) || file.path.endsWith(".wiki-fs-state.json")) {
      continue;
    }
    const metadata = parseMirrorFrontmatter(await app.vault.cachedRead(file));
    if (metadata !== null) {
      results.push({ file, metadata });
    }
  }
  return results;
}

export async function writeSnapshotMirror(app: App, mirrorRoot: string, nodes: NodeSnapshot[]): Promise<void> {
  for (const node of nodes) {
    await writeNodeMirror(app, mirrorRoot, node);
  }
}

export async function writeNodeMirror(app: App, mirrorRoot: string, node: NodeSnapshot): Promise<void> {
  const path = remoteToLocalPath(mirrorRoot, node.path);
  const frontmatter: MirrorFrontmatter = {
    path: node.path,
    kind: node.kind,
    etag: node.etag,
    updated_at: node.updated_at,
    mirror: true
  };
  await upsertTextFile(app, path, serializeMirrorFile(frontmatter, node.content));
}

export async function updateLocalNodeMetadata(app: App, mirrorRoot: string, node: NodeSnapshot): Promise<void> {
  await writeNodeMirror(app, mirrorRoot, node);
}

export async function removeMirrorPaths(app: App, mirrorRoot: string, removedPaths: string[]): Promise<void> {
  for (const remotePath of removedPaths) {
    const existing = app.vault.getAbstractFileByPath(remoteToLocalPath(mirrorRoot, remotePath));
    if (existing instanceof TFile) {
      await app.vault.delete(existing, true);
    }
  }
}

export async function removeStaleManagedFiles(app: App, mirrorRoot: string, activePaths: Set<string>): Promise<void> {
  for (const node of await collectManagedNodes(app, mirrorRoot)) {
    if (!activePaths.has(node.metadata.path)) {
      await app.vault.delete(node.file, true);
    }
  }
}

export async function collectChangedManagedNodeFiles(app: App, mirrorRoot: string, lastSyncedAt: number): Promise<TFile[]> {
  const results: TFile[] = [];
  for (const node of await collectManagedNodes(app, mirrorRoot)) {
    if (node.file.stat.mtime > lastSyncedAt) {
      results.push(node.file);
    }
  }
  return results;
}

export async function managedNodePayload(app: App, file: TFile): Promise<{ metadata: MirrorFrontmatter; content: string } | null> {
  const content = await app.vault.read(file);
  const metadata = parseMirrorFrontmatter(content);
  return metadata === null ? null : { metadata, content: stripManagedFrontmatter(content).trimStart() };
}

export function trackedNodesFromSnapshot(nodes: NodeSnapshot[]): TrackedNodeState[] {
  return nodes.map((node) => ({
    path: node.path,
    kind: node.kind,
    etag: node.etag
  }));
}

export function mergeTrackedNodes(
  trackedNodes: TrackedNodeState[],
  changedNodes: NodeSnapshot[],
  removedPaths: string[]
): TrackedNodeState[] {
  const removed = new Set(removedPaths);
  const merged = trackedNodes
    .filter((tracked) => !removed.has(tracked.path))
    .map((tracked) => ({ ...tracked }));
  for (const node of changedNodes) {
    const existing = merged.find((tracked) => tracked.path === node.path);
    if (existing !== undefined) {
      existing.kind = node.kind;
      existing.etag = node.etag;
      continue;
    }
    merged.push({
      path: node.path,
      kind: node.kind,
      etag: node.etag
    });
  }
  return merged.sort((left, right) => left.path.localeCompare(right.path));
}

export async function deletedTrackedNodes(
  app: App,
  mirrorRoot: string,
  trackedNodes: TrackedNodeState[]
): Promise<TrackedNodeState[]> {
  const currentPaths = new Set((await collectManagedNodes(app, mirrorRoot)).map((node) => node.metadata.path));
  return trackedNodes.filter((tracked) => !currentPaths.has(tracked.path));
}

export function currentManagedNodeFile(app: App, mirrorRoot: string): TFile | null {
  const activeFile = app.workspace.getActiveFile();
  if (activeFile === null) {
    return null;
  }
  return activeFile.path.startsWith(`${normalizePath(mirrorRoot)}/`) ? activeFile : null;
}

export async function openMirrorFile(app: App, path: string): Promise<void> {
  const file = app.vault.getAbstractFileByPath(normalizePath(path));
  if (file instanceof TFile) {
    await app.workspace.getLeaf(true).openFile(file);
  } else {
    new Notice(`File not found: ${path}`);
  }
}

export async function writeConflictFile(app: App, mirrorRoot: string, remotePath: string, conflictMarkdown: string): Promise<void> {
  await ensureFolder(app, `${mirrorRoot}/conflicts`);
  const basename = remotePath.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "conflict";
  await upsertTextFile(app, `${mirrorRoot}/conflicts/${basename}.conflict.md`, conflictMarkdown);
}

function remoteToLocalPath(mirrorRoot: string, remotePath: string): string {
  const normalized = normalizePath(remotePath);
  if (!normalized.startsWith("/Wiki")) {
    throw new Error(`unsupported remote path outside /Wiki: ${remotePath}`);
  }
  return normalizePath(`${mirrorRoot}/${normalized.replace(/^\/Wiki\/?/, "")}`);
}

async function ensureFolder(app: App, folderPath: string): Promise<void> {
  const normalized = normalizePath(folderPath);
  const segments = normalized.split("/").filter((segment) => segment.length > 0);
  let current = "";
  for (const segment of segments) {
    current = current.length === 0 ? segment : `${current}/${segment}`;
    const existing = app.vault.getAbstractFileByPath(current);
    if (!(existing instanceof TFolder)) {
      await app.vault.createFolder(current);
    }
  }
}

async function upsertTextFile(app: App, path: string, content: string): Promise<void> {
  const normalized = normalizePath(path);
  const existing = app.vault.getAbstractFileByPath(normalized);
  if (existing instanceof TFile) {
    await app.vault.modify(existing, content);
    return;
  }
  await ensureFolder(app, normalized.split("/").slice(0, -1).join("/"));
  await app.vault.create(normalized, content);
}

function managedRoot(mirrorRoot: string): string {
  return `${normalizePath(mirrorRoot)}/`;
}

function conflictRootPath(mirrorRoot: string): string {
  return `${normalizePath(mirrorRoot)}/conflicts/`;
}
