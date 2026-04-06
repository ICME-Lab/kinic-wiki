// Where: plugins/kinic-wiki/mirror.ts
// What: Vault mirror reads and writes for Kinic wiki pages and system pages.
// Why: The plugin needs one place that owns all file system interactions under Wiki/.
import { App, Notice, TFile, TFolder, normalizePath } from "obsidian";

import { parseMirrorFrontmatter, serializeMirrorFile, stripManagedFrontmatter } from "./frontmatter";
import { normalizePageMarkdown, normalizeSystemMarkdown } from "./links";
import { MirrorFrontmatter, SystemPageSnapshot, WikiPageSnapshot } from "./types";

export async function collectKnownPages(app: App, mirrorRoot: string): Promise<MirrorFrontmatter[]> {
  const results: MirrorFrontmatter[] = [];
  for (const file of app.vault.getMarkdownFiles()) {
    if (!isManagedPageFile(file.path, mirrorRoot)) {
      continue;
    }
    const metadata = await readMirrorFrontmatterFromFile(app, file);
    if (metadata !== null) {
      results.push(metadata);
    }
  }
  return results;
}

export async function writeSnapshotMirror(
  app: App,
  mirrorRoot: string,
  pages: WikiPageSnapshot[],
  systemPages: SystemPageSnapshot[]
): Promise<void> {
  const knownSlugs = new Set(
    pages.length > 0 ? pages.map((page) => page.slug) : (await collectKnownPages(app, mirrorRoot)).map((page) => page.slug)
  );
  await ensureFolder(app, mirrorRoot);
  await ensureFolder(app, `${mirrorRoot}/pages`);
  for (const systemPage of systemPages) {
    const markdown = normalizeSystemMarkdown(systemPage.markdown, knownSlugs);
    await upsertTextFile(app, `${mirrorRoot}/${systemPage.slug}`, markdown);
  }
  for (const page of pages) {
    await writePageMirror(app, mirrorRoot, page, knownSlugs);
  }
}

export async function writePageMirror(
  app: App,
  mirrorRoot: string,
  page: WikiPageSnapshot,
  knownSlugs: Set<string>
): Promise<void> {
  const frontmatter: MirrorFrontmatter = {
    page_id: page.page_id,
    slug: page.slug,
    page_type: page.page_type,
    revision_id: page.revision_id,
    updated_at: page.updated_at,
    mirror: true
  };
  const body = normalizePageMarkdown(page.markdown, knownSlugs);
  await upsertTextFile(app, pagePath(mirrorRoot, page.slug), serializeMirrorFile(frontmatter, body));
}

export async function updateLocalRevisionMetadata(
  app: App,
  mirrorRoot: string,
  pageId: string,
  revisionId: string,
  updatedAt: number
): Promise<void> {
  const file = await findManagedPageFileById(app, mirrorRoot, pageId);
  if (file === null) {
    return;
  }
  const metadata = await readMirrorFrontmatterFromFile(app, file);
  if (metadata === null) {
    return;
  }
  const body = stripManagedFrontmatter(await app.vault.read(file));
  await upsertTextFile(
    app,
    file.path,
    serializeMirrorFile({ ...metadata, revision_id: revisionId, updated_at: updatedAt }, body)
  );
}

export async function removeManagedPagesByIds(
  app: App,
  mirrorRoot: string,
  removedPageIds: string[]
): Promise<void> {
  const removed = new Set(removedPageIds);
  for (const file of app.vault.getMarkdownFiles()) {
    if (!isManagedPageFile(file.path, mirrorRoot)) {
      continue;
    }
    const metadata = await readMirrorFrontmatterFromFile(app, file);
    if (metadata !== null && removed.has(metadata.page_id)) {
      await app.vault.delete(file, true);
    }
  }
}

export async function removeStaleManagedPages(
  app: App,
  mirrorRoot: string,
  activePageIds: Set<string>
): Promise<void> {
  for (const file of app.vault.getMarkdownFiles()) {
    if (!isManagedPageFile(file.path, mirrorRoot)) {
      continue;
    }
    const metadata = await readMirrorFrontmatterFromFile(app, file);
    if (metadata !== null && !activePageIds.has(metadata.page_id)) {
      await app.vault.delete(file, true);
    }
  }
}

export async function openMirrorFile(app: App, path: string): Promise<void> {
  const file = app.vault.getAbstractFileByPath(normalizePath(path));
  if (file instanceof TFile) {
    await app.workspace.getLeaf(true).openFile(file);
  } else {
    new Notice(`File not found: ${path}`);
  }
}

export async function writeConflictFile(
  app: App,
  mirrorRoot: string,
  slug: string,
  conflictMarkdown: string
): Promise<void> {
  await ensureFolder(app, `${mirrorRoot}/conflicts`);
  await upsertTextFile(app, `${mirrorRoot}/conflicts/${slug}.conflict.md`, conflictMarkdown);
}

export async function collectChangedManagedPageFiles(
  app: App,
  mirrorRoot: string,
  lastSyncedAt: number
): Promise<TFile[]> {
  const files: TFile[] = [];
  for (const file of app.vault.getMarkdownFiles()) {
    if (!isManagedPageFile(file.path, mirrorRoot) || file.stat.mtime <= lastSyncedAt) {
      continue;
    }
    if ((await readMirrorFrontmatterFromFile(app, file)) !== null) {
      files.push(file);
    }
  }
  return files;
}

export function currentManagedPageFile(app: App, mirrorRoot: string): TFile | null {
  const activeFile = app.workspace.getActiveFile();
  return activeFile !== null && isManagedPageFile(activeFile.path, mirrorRoot) ? activeFile : null;
}

export async function managedPagePayload(app: App, file: TFile): Promise<{
  metadata: MirrorFrontmatter;
  markdown: string;
} | null> {
  const content = await app.vault.read(file);
  const metadata = parseMirrorFrontmatter(content);
  return metadata === null ? null : { metadata, markdown: stripManagedFrontmatter(content).trimStart() };
}

async function readMirrorFrontmatterFromFile(app: App, file: TFile): Promise<MirrorFrontmatter | null> {
  return parseMirrorFrontmatter(await app.vault.cachedRead(file));
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

function isManagedPageFile(path: string, mirrorRoot: string): boolean {
  return normalizePath(path).startsWith(`${normalizePath(mirrorRoot)}/pages/`);
}

function pagePath(mirrorRoot: string, slug: string): string {
  return `${normalizePath(mirrorRoot)}/pages/${slug}.md`;
}

async function findManagedPageFileById(app: App, mirrorRoot: string, pageId: string): Promise<TFile | null> {
  for (const file of app.vault.getMarkdownFiles()) {
    if (!isManagedPageFile(file.path, mirrorRoot)) {
      continue;
    }
    const metadata = await readMirrorFrontmatterFromFile(app, file);
    if (metadata?.page_id === pageId) {
      return file;
    }
  }
  return null;
}
