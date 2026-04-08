// Where: plugins/kinic-wiki/sync.ts
// What: Mirror, pull, push, and delete workflows for the FS-first plugin.
// Why: Commands should delegate to one service that owns node-based sync behavior end to end.
import { App, Notice, TFile } from "obsidian";

import { KinicCanisterClient } from "./client";
import {
  collectChangedManagedNodeFiles,
  currentManagedNodeFile,
  deletedTrackedNodes,
  mergeTrackedNodes,
  managedNodePayload,
  openMirrorFile,
  removeMirrorPaths,
  removeStaleManagedFiles,
  trackedNodesFromSnapshot,
  updateLocalNodeMetadata,
  writeConflictFile,
  writeSnapshotMirror
} from "./mirror";
import { shouldSkipPush } from "./sync_logic";
import { PluginSettings, TrackedNodeState } from "./types";

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
    const snapshot = await this.client().exportSnapshot();
    await writeSnapshotMirror(this.app, this.settings.mirrorRoot, snapshot.nodes);
    await removeStaleManagedFiles(
      this.app,
      this.settings.mirrorRoot,
      new Set(snapshot.nodes.map((node) => node.path))
    );
    await this.markSynced(snapshot.snapshot_revision, trackedNodesFromSnapshot(snapshot.nodes));
    new Notice(`Initial sync completed: ${snapshot.nodes.length} nodes`);
  }

  async pullUpdates(): Promise<void> {
    const client = this.client();
    const updates = await client.fetchUpdates(this.settings.lastSnapshotRevision);
    await writeSnapshotMirror(this.app, this.settings.mirrorRoot, updates.changed_nodes);
    await removeMirrorPaths(this.app, this.settings.mirrorRoot, updates.removed_paths);
    await this.markSynced(
      updates.snapshot_revision,
      mergeTrackedNodes(this.settings.trackedNodes, updates.changed_nodes, updates.removed_paths)
    );
    new Notice(`Pull complete: ${updates.changed_nodes.length} changed, ${updates.removed_paths.length} removed`);
  }

  async showStatus(): Promise<void> {
    const status = await this.client().status();
    new Notice(`Files ${status.file_count}, Sources ${status.source_count}, Deleted ${status.deleted_count}`);
  }

  async pushCurrentNote(): Promise<void> {
    const file = currentManagedNodeFile(this.app, this.settings.mirrorRoot);
    if (file === null) {
      new Notice("Current note is not a tracked local mirror node");
      return;
    }
    await this.pushFiles([file]);
  }

  async pushChangedNotes(): Promise<void> {
    const files = await collectChangedManagedNodeFiles(
      this.app,
      this.settings.mirrorRoot,
      this.settings.lastSyncedAt
    );
    const deletedNodes = await deletedTrackedNodes(
      this.app,
      this.settings.mirrorRoot,
      this.settings.trackedNodes
    );
    if (shouldSkipPush(files.length, deletedNodes.length)) {
      new Notice("No changed wiki files found");
      return;
    }
    await this.pushFiles(files, deletedNodes);
  }

  async deleteCurrentNote(): Promise<void> {
    const file = currentManagedNodeFile(this.app, this.settings.mirrorRoot);
    if (file === null) {
      new Notice("Current note is not a tracked local mirror node");
      return;
    }
    const payload = await managedNodePayload(this.app, file);
    if (payload === null) {
      new Notice("Current note is missing tracked mirror frontmatter");
      return;
    }
    await this.client().deleteNode(payload.metadata.path, payload.metadata.etag);
    if (this.app.vault.getAbstractFileByPath(file.path) instanceof TFile) {
      await this.app.vault.delete(file, true);
    }
    await this.syncTrackedState();
    new Notice("Deleted current wiki node");
  }

  async showConflicts(): Promise<void> {
    const prefix = `${this.settings.mirrorRoot}/conflicts/`;
    const conflict = this.app.vault.getMarkdownFiles().find((file) => file.path.startsWith(prefix));
    if (conflict === undefined) {
      new Notice("No conflict notes found");
      return;
    }
    await openMirrorFile(this.app, conflict.path);
  }

  private async pushFiles(files: TFile[], deletedNodes?: TrackedNodeState[]): Promise<void> {
    const client = this.client();
    let writes = 0;
    let conflicts = 0;
    for (const file of files) {
      const payload = await managedNodePayload(this.app, file);
      if (payload === null) {
        continue;
      }
      try {
        const result = await client.writeNode(
          payload.metadata.path,
          payload.metadata.kind,
          payload.content,
          payload.metadata.etag
        );
        await updateLocalNodeMetadata(this.app, this.settings.mirrorRoot, result.node);
        writes += 1;
      } catch (error: unknown) {
        conflicts += 1;
        const message = error instanceof Error ? error.message : String(error);
        await writeConflictFile(this.app, this.settings.mirrorRoot, payload.metadata.path, payload.content);
        new Notice(`Push conflict for ${payload.metadata.path}: ${message}`);
      }
    }

    const pendingDeletes = deletedNodes ?? await deletedTrackedNodes(
      this.app,
      this.settings.mirrorRoot,
      this.settings.trackedNodes
    );
    for (const tracked of pendingDeletes) {
      try {
        await client.deleteNode(tracked.path, tracked.etag);
      } catch (error: unknown) {
        conflicts += 1;
        const message = error instanceof Error ? error.message : String(error);
        new Notice(`Delete conflict for ${tracked.path}: ${message}`);
      }
    }

    await this.syncTrackedState();
    new Notice(`Push complete: ${writes} written, ${conflicts} conflicts`);
  }

  private async syncTrackedState(): Promise<void> {
    const updates = await this.client().fetchUpdates(this.settings.lastSnapshotRevision);
    await writeSnapshotMirror(this.app, this.settings.mirrorRoot, updates.changed_nodes);
    await removeMirrorPaths(this.app, this.settings.mirrorRoot, updates.removed_paths);
    await this.markSynced(
      updates.snapshot_revision,
      mergeTrackedNodes(this.settings.trackedNodes, updates.changed_nodes, updates.removed_paths)
    );
  }

  private async markSynced(snapshotRevision: string, trackedNodes: PluginSettings["trackedNodes"]): Promise<void> {
    this.settings.lastSnapshotRevision = snapshotRevision;
    this.settings.lastSyncedAt = Date.now();
    this.settings.trackedNodes = trackedNodes;
    await this.saveSettings();
  }

  private client(): KinicCanisterClient {
    return new KinicCanisterClient(this.settings.replicaHost, this.settings.canisterId);
  }
}
