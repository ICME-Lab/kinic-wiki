import test from "node:test";
import assert from "node:assert/strict";

import {
  excludeCleanRemotePaths,
  hasStoredSnapshotRevision,
  initialSyncStalePaths,
  mergeDirtyPaths,
  shouldSkipAutoPull,
  shouldSkipPush,
  sortedUniquePaths
} from "./sync_logic";

test("push does not skip remote deletions when only deletions are pending", () => {
  assert.equal(shouldSkipPush(0, 1), false);
  assert.equal(shouldSkipPush(1, 0), false);
  assert.equal(shouldSkipPush(0, 0), true);
});

test("auto pull skips when dirty managed nodes exist", () => {
  assert.equal(shouldSkipAutoPull(false), false);
  assert.equal(shouldSkipAutoPull(true), true);
});

test("empty snapshot revision requires initial snapshot flow", () => {
  assert.equal(hasStoredSnapshotRevision(""), false);
  assert.equal(hasStoredSnapshotRevision("   "), false);
  assert.equal(hasStoredSnapshotRevision("v5:1:2f57696b69"), true);
});

test("successful push paths are removed from dirty paths before follow-up pull", () => {
  const dirtyPaths = new Set(["/Wiki/pushed.md", "/Wiki/local.md"]);
  const cleanRemotePaths = new Set(["/Wiki/pushed.md"]);

  assert.deepEqual(
    [...excludeCleanRemotePaths(dirtyPaths, cleanRemotePaths)].sort(),
    ["/Wiki/local.md"]
  );
  assert.deepEqual([...dirtyPaths].sort(), ["/Wiki/local.md", "/Wiki/pushed.md"]);
});

test("pending conflict paths remain dirty after clean remote writes advance sync time", () => {
  const dirtyPaths = new Set(["/Wiki/local.md"]);

  assert.deepEqual(
    [...mergeDirtyPaths(dirtyPaths, ["/Wiki/conflict.md", "/Wiki/local.md"])].sort(),
    ["/Wiki/conflict.md", "/Wiki/local.md"]
  );
});

test("sortedUniquePaths removes duplicates in stable order", () => {
  assert.deepEqual(
    sortedUniquePaths(["/Wiki/b.md", "/Wiki/a.md", "/Wiki/b.md"]),
    ["/Wiki/a.md", "/Wiki/b.md"]
  );
});

test("initial sync stale paths include managed and tracked-only missing nodes", () => {
  assert.deepEqual(
    initialSyncStalePaths(
      ["/Wiki/managed-stale.md", "/Wiki/remote.md"],
      ["/Wiki/tracked-only-stale.md", "/Wiki/managed-stale.md"],
      new Set(["/Wiki/remote.md"])
    ).sort(),
    ["/Wiki/managed-stale.md", "/Wiki/tracked-only-stale.md"]
  );
});
