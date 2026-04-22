// Where: plugins/kinic-wiki/sync_logic.ts
// What: Pure sync decision helpers with no Obsidian runtime dependency.
// Why: Push gating should stay testable in Node without loading the plugin host.

const SNAPSHOT_REVISION_PATTERN = /^v5:(0|[1-9]\d*):[0-9a-f]+$/;
type SnapshotNode = { path: string };

export function shouldSkipPush(changedFileCount: number, deletedNodeCount: number): boolean {
  return changedFileCount === 0 && deletedNodeCount === 0;
}

export function shouldSkipAutoPull(hasDirtyManagedNodes: boolean): boolean {
  return hasDirtyManagedNodes;
}

export function hasStoredSnapshotRevision(snapshotRevision: string): boolean {
  return SNAPSHOT_REVISION_PATTERN.test(snapshotRevision.trim());
}

export function normalizeStoredSnapshotRevision(snapshotRevision: string): string {
  const normalized = snapshotRevision.trim();
  return hasStoredSnapshotRevision(normalized) ? normalized : "";
}

export function isSnapshotRecoveryError(message: string): boolean {
  return (
    message.includes("known_snapshot_revision is no longer available")
    || message.includes("known_snapshot_revision is invalid")
    || message.includes("snapshot_revision is no longer current")
    || message.includes("target_snapshot_revision is no longer current for changed path")
    || message.includes("snapshot_session_id has expired")
  );
}

export function shouldRestartInitialSync(message: string): boolean {
  return (
    message.includes("snapshot_revision is no longer current")
    || message.includes("target_snapshot_revision is no longer current for changed path")
    || message.includes("snapshot_session_id has expired")
  );
}

export function snapshotRecoveryNotice(message: string): string | null {
  if (!isSnapshotRecoveryError(message)) {
    return null;
  }
  if (shouldRestartInitialSync(message)) {
    return "Remote snapshot changed. Run Kinic Wiki: Initial sync again.";
  }
  return "Remote history unavailable. Run Kinic Wiki: Initial sync.";
}

export function excludeCleanRemotePaths(dirtyPaths: Set<string>, cleanRemotePaths: Set<string>): Set<string> {
  const filtered = new Set(dirtyPaths);
  for (const path of cleanRemotePaths) {
    filtered.delete(path);
  }
  return filtered;
}

export function mergeDirtyPaths(dirtyPaths: Set<string>, pendingConflictPaths: string[]): Set<string> {
  const merged = new Set(dirtyPaths);
  for (const path of pendingConflictPaths) {
    merged.add(path);
  }
  return merged;
}

export function sortedUniquePaths(paths: Iterable<string>): string[] {
  return [...new Set(paths)].sort((left, right) => left.localeCompare(right));
}

export function initialSyncStalePaths(
  managedPaths: string[],
  trackedPaths: string[],
  remotePaths: Set<string>
): string[] {
  const candidates = new Set([...managedPaths, ...trackedPaths]);
  return [...candidates].filter((path) => !remotePaths.has(path));
}

export function mergeInitialSnapshotNodes<T extends SnapshotNode>(
  snapshotNodes: T[],
  changedNodes: T[],
  removedPaths: string[]
): T[] {
  const removed = new Set(removedPaths);
  const merged = new Map<string, T>();
  for (const node of snapshotNodes) {
    if (removed.has(node.path)) {
      continue;
    }
    merged.set(node.path, node);
  }
  for (const node of changedNodes) {
    if (removed.has(node.path)) {
      continue;
    }
    merged.set(node.path, node);
  }
  return [...merged.values()].sort((left, right) => left.path.localeCompare(right.path));
}
