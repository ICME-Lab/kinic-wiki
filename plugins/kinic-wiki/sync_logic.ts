// Where: plugins/kinic-wiki/sync_logic.ts
// What: Pure sync decision helpers with no Obsidian runtime dependency.
// Why: Push gating should stay testable in Node without loading the plugin host.

export function shouldSkipPush(changedFileCount: number, deletedNodeCount: number): boolean {
  return changedFileCount === 0 && deletedNodeCount === 0;
}

export function shouldSkipAutoPull(hasDirtyManagedNodes: boolean): boolean {
  return hasDirtyManagedNodes;
}

export function hasStoredSnapshotRevision(snapshotRevision: string): boolean {
  return snapshotRevision.trim().length > 0;
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
