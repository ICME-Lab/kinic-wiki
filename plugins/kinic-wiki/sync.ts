// Where: plugins/kinic-wiki/sync.ts
// What: Mirror, pull, push, and delete workflows for the Obsidian plugin.
// Why: Commands should delegate to one service that owns wiki sync behavior end to end.
import { App, Notice, TFile, normalizePath } from "obsidian";

import { KinicCanisterClient } from "./client";
import {
  collectChangedManagedPageFiles,
  collectKnownPages,
  currentManagedPageFile,
  managedPagePayload,
  openMirrorFile,
  removeManagedPagesByIds,
  removeStaleManagedPages,
  updateLocalRevisionMetadata,
  writeConflictFile,
  writePageMirror,
  writeSnapshotMirror
} from "./mirror";
import { CommitPageChange, PluginSettings } from "./types";

export class WikiSyncService {
  constructor(
    private readonly app: App,
    private readonly settings: PluginSettings,
    private readonly saveSettings: () => Promise<void>
  ) {}

  isConfigured(): boolean {
    return this.settings.replicaHost.trim().length > 0 && this.settings.canisterId.trim().length > 0;
  }

  async initialSync(): Promise<void> {
    const client = this.client();
    const snapshot = await client.exportWikiSnapshot();
    await writeSnapshotMirror(this.app, this.settings.mirrorRoot, snapshot.pages, snapshot.system_pages);
    await removeStaleManagedPages(
      this.app,
      this.settings.mirrorRoot,
      new Set(snapshot.pages.map((page) => page.page_id))
    );
    await this.markSynced(snapshot.snapshot_revision);
    if (this.settings.openIndexAfterInitialSync) {
      await openMirrorFile(this.app, `${this.settings.mirrorRoot}/index.md`);
    }
    new Notice(`Initial sync completed: ${snapshot.pages.length} pages`);
  }

  async pullUpdates(): Promise<void> {
    const client = this.client();
    const knownPages = await collectKnownPages(this.app, this.settings.mirrorRoot);
    const updates = await client.fetchWikiUpdates(this.settings.lastSnapshotRevision, knownPages);
    const knownSlugs = new Set([
      ...knownPages.map((page) => page.slug),
      ...updates.changed_pages.map((page) => page.slug)
    ]);
    for (const page of updates.changed_pages) {
      await writePageMirror(this.app, this.settings.mirrorRoot, page, knownSlugs);
    }
    await removeManagedPagesByIds(this.app, this.settings.mirrorRoot, updates.removed_page_ids);
    await writeSnapshotMirror(this.app, this.settings.mirrorRoot, [], updates.system_pages);
    await this.markSynced(updates.snapshot_revision);
    new Notice(`Pull complete: ${updates.changed_pages.length} changed, ${updates.removed_page_ids.length} removed`);
  }

  async openIndex(): Promise<void> {
    await openMirrorFile(this.app, `${this.settings.mirrorRoot}/index.md`);
  }

  async openLog(): Promise<void> {
    await openMirrorFile(this.app, `${this.settings.mirrorRoot}/log.md`);
  }

  async showStatus(): Promise<void> {
    const status = await this.client().status();
    new Notice(`Pages ${status.page_count}, Sources ${status.source_count}, System ${status.system_page_count}`);
  }

  async pushCurrentNote(): Promise<void> {
    const file = currentManagedPageFile(this.app, this.settings.mirrorRoot);
    if (file === null) {
      new Notice("Current note is not a managed wiki page");
      return;
    }
    await this.pushFiles([file]);
  }

  async pushChangedNotes(): Promise<void> {
    const files = await collectChangedManagedPageFiles(
      this.app,
      this.settings.mirrorRoot,
      this.settings.lastSyncedAt
    );
    if (files.length === 0) {
      new Notice("No changed wiki notes found");
      return;
    }
    await this.pushFiles(files);
  }

  async deleteCurrentNote(): Promise<void> {
    const file = currentManagedPageFile(this.app, this.settings.mirrorRoot);
    if (file === null) {
      new Notice("Current note is not a managed wiki page");
      return;
    }
    const payload = await managedPagePayload(this.app, file);
    if (payload === null) {
      new Notice("Current note is missing managed frontmatter");
      return;
    }
    const response = await this.client().commitWikiChanges(this.settings.lastSnapshotRevision, [
      { change_type: "Delete", page_id: payload.metadata.page_id, base_revision_id: payload.metadata.revision_id, new_markdown: null }
    ]);
    await this.afterCommit(response);
    const deletedRemotely = response.manifest_delta.removed_page_ids.includes(payload.metadata.page_id);
    if (!deletedRemotely) {
      new Notice("Delete was rejected by the remote wiki");
      return;
    }
    if (this.app.vault.getAbstractFileByPath(file.path) instanceof TFile) {
      await this.app.vault.delete(file, true);
    }
    new Notice("Deleted current wiki page");
  }

  async showConflicts(): Promise<void> {
    const prefix = `${normalizePath(this.settings.mirrorRoot)}/conflicts/`;
    const conflict = this.app.vault.getMarkdownFiles().find((file) => file.path.startsWith(prefix));
    if (conflict === undefined) {
      new Notice("No conflict notes found");
      return;
    }
    await openMirrorFile(this.app, conflict.path);
  }

  private async pushFiles(files: TFile[]): Promise<void> {
    const changes: CommitPageChange[] = [];
    const payloads = new Map<string, { slug: string }>();
    for (const file of files) {
      const payload = await managedPagePayload(this.app, file);
      if (payload === null) {
        continue;
      }
      changes.push({
        change_type: "Update",
        page_id: payload.metadata.page_id,
        base_revision_id: payload.metadata.revision_id,
        new_markdown: payload.markdown
      });
      payloads.set(payload.metadata.page_id, { slug: payload.metadata.slug });
    }
    if (changes.length === 0) {
      new Notice("No valid managed notes selected for push");
      return;
    }
    const response = await this.client().commitWikiChanges(this.settings.lastSnapshotRevision, changes);
    await this.afterCommit(response);
    for (const conflict of response.rejected_pages) {
      const slug = payloads.get(conflict.page_id)?.slug ?? conflict.page_id;
      if (conflict.conflict_markdown !== null) {
        await writeConflictFile(this.app, this.settings.mirrorRoot, slug, conflict.conflict_markdown);
      }
    }
    new Notice(`Push complete: ${response.committed_pages.length} committed, ${response.rejected_pages.length} rejected`);
  }

  private async afterCommit(response: Awaited<ReturnType<KinicCanisterClient["commitWikiChanges"]>>): Promise<void> {
    for (const entry of response.manifest_delta.upserted_pages) {
      await updateLocalRevisionMetadata(
        this.app,
        this.settings.mirrorRoot,
        entry.page_id,
        entry.revision_id,
        entry.updated_at
      );
    }
    await removeManagedPagesByIds(this.app, this.settings.mirrorRoot, response.manifest_delta.removed_page_ids);
    await writeSnapshotMirror(this.app, this.settings.mirrorRoot, [], response.system_pages);
    await this.markSynced(response.snapshot_revision);
    if (response.snapshot_was_stale) {
      new Notice("Remote had advanced, but non-conflicting changes were still applied");
    }
  }

  private async markSynced(snapshotRevision: string): Promise<void> {
    this.settings.lastSnapshotRevision = snapshotRevision;
    this.settings.lastSyncedAt = Date.now();
    await this.saveSettings();
  }

  private client(): KinicCanisterClient {
    return new KinicCanisterClient(this.settings.replicaHost, this.settings.canisterId);
  }
}
