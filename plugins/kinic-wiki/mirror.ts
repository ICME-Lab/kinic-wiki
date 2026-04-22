// Where: plugins/kinic-wiki/mirror.ts
// What: Vault mirror reads and writes for FS-first remote nodes.
// Why: The plugin mirrors remote paths directly and tracks etags in file frontmatter.
import { App, Notice, TFile, TFolder, normalizePath } from "obsidian";

import {
  parseMirrorFrontmatter,
  remoteDeleteConflictMarkdown,
  serializeMirrorFile,
  stripManagedFrontmatter
} from "./frontmatter";
import { conflictFilePath, findDeletedTrackedNodes } from "./mirror_logic";
import { MirrorFrontmatter, NodeMutationAck, NodeSnapshot, TrackedNodeState } from "./types";

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

export async function updateLocalNodeMetadata(
  app: App,
  mirrorRoot: string,
  node: NodeMutationAck
): Promise<void> {
  const localPath = remoteToLocalPath(mirrorRoot, node.path);
  const existing = app.vault.getAbstractFileByPath(localPath);
  if (!(existing instanceof TFile)) {
    throw new Error(`managed mirror file is missing: ${localPath}`);
  }
  const current = await app.vault.read(existing);
  const frontmatter: MirrorFrontmatter = {
    path: node.path,
    kind: node.kind,
    etag: node.etag,
    updated_at: node.updated_at,
    mirror: true
  };
  await app.vault.modify(existing, serializeMirrorFile(frontmatter, stripManagedFrontmatter(current).trimStart()));
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

export async function collectDirtyManagedNodePaths(
  app: App,
  mirrorRoot: string,
  lastSyncedAt: number,
  pendingConflictPaths = new Set<string>()
): Promise<Set<string>> {
  const dirtyPaths = new Set<string>();
  for (const node of await collectManagedNodes(app, mirrorRoot)) {
    if (node.file.stat.mtime > lastSyncedAt || pendingConflictPaths.has(node.metadata.path)) {
      dirtyPaths.add(node.metadata.path);
    }
  }
  return dirtyPaths;
}

export async function collectChangedManagedNodeFiles(
  app: App,
  mirrorRoot: string,
  lastSyncedAt: number,
  pendingConflictPaths = new Set<string>()
): Promise<TFile[]> {
  const results: TFile[] = [];
  for (const node of await collectManagedNodes(app, mirrorRoot)) {
    if (node.file.stat.mtime > lastSyncedAt || pendingConflictPaths.has(node.metadata.path)) {
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
  return findDeletedTrackedNodes(
    trackedNodes,
    (remotePath) => remoteToLocalPath(mirrorRoot, remotePath),
    (localPath) => app.vault.getAbstractFileByPath(localPath) instanceof TFile
  );
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
  await upsertTextFile(app, conflictFilePath(mirrorRoot, remotePath), conflictMarkdown);
}

export async function writeRemoteUpdateConflictFile(app: App, mirrorRoot: string, node: NodeSnapshot): Promise<void> {
  const body = [
    "# Remote update conflict",
    "",
    `Remote path: ${node.path}`,
    `Remote etag: ${node.etag}`,
    `Remote updated_at: ${node.updated_at}`,
    "",
    "## Remote content",
    "",
    node.content
  ].join("\n");
  await writeConflictFile(app, mirrorRoot, node.path, body);
}

export async function writeRemoteDeleteConflictFile(app: App, mirrorRoot: string, remotePath: string): Promise<void> {
  const localPath = remoteToLocalPath(mirrorRoot, remotePath);
  const existing = app.vault.getAbstractFileByPath(localPath);
  let localContent: string | undefined;
  if (existing instanceof TFile) {
    localContent = stripManagedFrontmatter(await app.vault.read(existing)).trimStart();
  }
  await writeConflictFile(app, mirrorRoot, remotePath, remoteDeleteConflictMarkdown(remotePath, localContent));
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
