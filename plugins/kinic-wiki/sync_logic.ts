// Where: plugins/kinic-wiki/sync_logic.ts
// What: Pure sync decision helpers with no Obsidian runtime dependency.
// Why: Push gating should stay testable in Node without loading the plugin host.

export function shouldSkipPush(changedFileCount: number, deletedNodeCount: number): boolean {
  return changedFileCount === 0 && deletedNodeCount === 0;
}
