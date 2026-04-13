// Where: plugins/kinic-wiki/sync.ts
// What: Mirror, pull, push, and delete workflows for the FS-first plugin.
// Why: Commands should delegate to one service that owns node-based sync behavior end to end.
import { App, Notice, TFile } from "obsidian";

import { KinicCanisterClient } from "./client";
import {
  collectDirtyManagedNodePaths,
  collectManagedNodes,
  collectChangedManagedNodeFiles,
  currentManagedNodeFile,
  deletedTrackedNodes,
  managedNodePayload,
  openMirrorFile,
  removeMirrorPaths,
  updateLocalNodeMetadata,
  writeConflictFile,
  writeRemoteUpdateConflictFile,
  writeSnapshotMirror
} from "./mirror";
import { partitionPullUpdates } from "./mirror_logic";
import {
  excludeCleanRemotePaths,
  hasStoredSnapshotRevision,
  initialSyncStalePaths,
  mergeDirtyPaths,
  shouldSkipPush,
  sortedUniquePaths
} from "./sync_logic";
import { FetchUpdatesResponse, NodeSnapshot, PluginSettings, TrackedNodeState } from "./types";

interface SyncApplyResult {
  appliedChanges: number;
  appliedRemovals: number;
  conflictChanges: number;
  conflictRemovals: number;
}

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
    const result = await this.applyInitialSnapshot();
    new Notice(
      `Initial sync completed: ${result.appliedChanges} changed, ${result.appliedRemovals} removed, ${result.conflictChanges + result.conflictRemovals} conflicts`
    );
  }

  async pullUpdates(): Promise<void> {
    const result = await this.pullUpdatesWithDirtyPaths(await this.collectDirtyPaths());
    new Notice(
      `Pull complete: ${result.appliedChanges} changed, ${result.appliedRemovals} removed, ${result.conflictChanges + result.conflictRemovals} conflicts`
    );
  }

  async pullUpdatesWithDirtyPaths(dirtyPaths: Set<string>): Promise<SyncApplyResult> {
    if (!hasStoredSnapshotRevision(this.settings.lastSnapshotRevision)) {
      return this.applyInitialSnapshot(dirtyPaths);
    }
    const client = this.client();
    const updates = await client.fetchUpdates(this.settings.lastSnapshotRevision);
    return this.applyFetchedUpdates(updates, dirtyPaths);
  }

  async showStatus(): Promise<void> {
    const status = await this.client().status();
    new Notice(`Files ${status.file_count}, Sources ${status.source_count}`);
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
    const pendingConflictPaths = this.pendingConflictPathSet();
    const files = await collectChangedManagedNodeFiles(
      this.app,
      this.settings.mirrorRoot,
      this.settings.lastSyncedAt,
      pendingConflictPaths
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
    const syncResult = await this.syncTrackedState();
    new Notice(`Deleted current wiki node${formatSyncConflictSuffix(syncResult)}`);
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
    const cleanRemotePaths = new Set<string>();
    const unresolvedConflictPaths = new Set<string>();
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
        cleanRemotePaths.add(result.node.path);
        writes += 1;
      } catch (error: unknown) {
        conflicts += 1;
        unresolvedConflictPaths.add(payload.metadata.path);
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
        unresolvedConflictPaths.add(tracked.path);
        const message = error instanceof Error ? error.message : String(error);
        new Notice(`Delete conflict for ${tracked.path}: ${message}`);
      }
    }

    const syncResult = await this.syncTrackedState(cleanRemotePaths, unresolvedConflictPaths);
    new Notice(`Push complete: ${writes} written, ${conflicts} conflicts${formatSyncConflictSuffix(syncResult)}`);
  }

  private async applyInitialSnapshot(dirtyPaths?: Set<string>): Promise<SyncApplyResult> {
    const snapshot = await this.client().exportSnapshot();
    const managedNodes = await collectManagedNodes(this.app, this.settings.mirrorRoot);
    const remotePaths = new Set(snapshot.nodes.map((node) => node.path));
    const stalePaths = initialSyncStalePaths(
      managedNodes.map((node) => node.metadata.path),
      this.settings.trackedNodes.map((node) => node.path),
      remotePaths
    );
    return this.applyRemoteChanges(
      snapshot.snapshot_revision,
      snapshot.nodes,
      stalePaths,
      dirtyPaths ?? dirtyPathsFromManagedNodes(managedNodes, this.settings.lastSyncedAt)
    );
  }

  private async syncTrackedState(
    cleanRemotePaths = new Set<string>(),
    unresolvedConflictPaths = new Set<string>()
  ): Promise<SyncApplyResult> {
    const updates = await this.client().fetchUpdates(this.settings.lastSnapshotRevision);
    const dirtyPaths = excludeCleanRemotePaths(await this.collectDirtyPaths(), cleanRemotePaths);
    return this.applyFetchedUpdates(updates, dirtyPaths, unresolvedConflictPaths);
  }

  private async applyFetchedUpdates(
    updates: FetchUpdatesResponse,
    dirtyPaths: Set<string>,
    unresolvedConflictPaths = new Set<string>()
  ): Promise<SyncApplyResult> {
    return this.applyRemoteChanges(
      updates.snapshot_revision,
      updates.changed_nodes,
      updates.removed_paths,
      dirtyPaths,
      unresolvedConflictPaths
    );
  }

  private async applyRemoteChanges(
    snapshotRevision: string,
    changedNodes: NodeSnapshot[],
    removedPaths: string[],
    dirtyPaths: Set<string>,
    unresolvedConflictPaths = new Set<string>()
  ): Promise<SyncApplyResult> {
    const partition = partitionPullUpdates(
      changedNodes,
      removedPaths,
      dirtyPaths,
      this.settings.trackedNodes
    );

    await writeSnapshotMirror(this.app, this.settings.mirrorRoot, partition.safeChangedNodes);
    await removeMirrorPaths(this.app, this.settings.mirrorRoot, partition.safeRemovedPaths);
    for (const node of partition.conflictChangedNodes) {
      await writeRemoteUpdateConflictFile(this.app, this.settings.mirrorRoot, node);
    }
    await this.markSynced(
      snapshotRevision,
      partition.nextTrackedNodes,
      remoteConflictPaths(
        partition.conflictChangedNodes,
        partition.conflictRemovedPaths,
        unresolvedConflictPaths
      )
    );

    return {
      appliedChanges: partition.safeChangedNodes.length,
      appliedRemovals: partition.safeRemovedPaths.length,
      conflictChanges: partition.conflictChangedNodes.length,
      conflictRemovals: partition.conflictRemovedPaths.length
    };
  }

  private async markSynced(
    snapshotRevision: string,
    trackedNodes: PluginSettings["trackedNodes"],
    pendingConflictPaths: string[]
  ): Promise<void> {
    this.settings.lastSnapshotRevision = snapshotRevision;
    this.settings.lastSyncedAt = Date.now();
    this.settings.pendingConflictPaths = pendingConflictPaths;
    this.settings.trackedNodes = trackedNodes;
    await this.saveSettings();
  }

  private client(): KinicCanisterClient {
    return new KinicCanisterClient(this.settings.replicaHost, this.settings.canisterId);
  }

  async collectDirtyPaths(): Promise<Set<string>> {
    const dirtyPaths = await collectDirtyManagedNodePaths(
      this.app,
      this.settings.mirrorRoot,
      this.settings.lastSyncedAt,
      this.pendingConflictPathSet()
    );
    return mergeDirtyPaths(dirtyPaths, this.settings.pendingConflictPaths);
  }

  async hasDirtyManagedNodes(): Promise<boolean> {
    const dirtyPaths = await this.collectDirtyPaths();
    return dirtyPaths.size > 0;
  }

  private pendingConflictPathSet(): Set<string> {
    return new Set(this.settings.pendingConflictPaths);
  }
}

function formatSyncConflictSuffix(result: SyncApplyResult): string {
  const conflicts = result.conflictChanges + result.conflictRemovals;
  return conflicts === 0 ? "" : `, ${conflicts} remote sync conflicts`;
}

function dirtyPathsFromManagedNodes(
  managedNodes: Awaited<ReturnType<typeof collectManagedNodes>>,
  lastSyncedAt: number
): Set<string> {
  const dirtyPaths = new Set<string>();
  for (const node of managedNodes) {
    if (node.file.stat.mtime > lastSyncedAt) {
      dirtyPaths.add(node.metadata.path);
    }
  }
  return dirtyPaths;
}

function remoteConflictPaths(
  changedNodes: NodeSnapshot[],
  removedPaths: string[],
  unresolvedConflictPaths: Set<string>
): string[] {
  const paths = [
    ...changedNodes.map((node) => node.path),
    ...removedPaths,
    ...unresolvedConflictPaths
  ];
  return sortedUniquePaths(paths);
}
