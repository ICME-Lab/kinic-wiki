import test from "node:test";
import assert from "node:assert/strict";

import {
  excludeCleanRemotePaths,
  hasStoredSnapshotRevision,
  isSnapshotRecoveryError,
  initialSyncStalePaths,
  mergeInitialSnapshotNodes,
  mergeDirtyPaths,
  normalizeStoredSnapshotRevision,
  snapshotRecoveryNotice,
  shouldRestartInitialSync,
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
  assert.equal(hasStoredSnapshotRevision("v3:1:0:2f57696b69:old-state-hash"), false);
  assert.equal(hasStoredSnapshotRevision("broken"), false);
  assert.equal(hasStoredSnapshotRevision("v5:1:2f57696b69"), true);
});

test("snapshot recovery errors require explicit resync", () => {
  assert.equal(isSnapshotRecoveryError("known_snapshot_revision is no longer available"), true);
  assert.equal(isSnapshotRecoveryError("known_snapshot_revision is invalid"), true);
  assert.equal(isSnapshotRecoveryError("snapshot_revision is no longer current"), true);
  assert.equal(
    isSnapshotRecoveryError("target_snapshot_revision is no longer current for changed path"),
    true
  );
  assert.equal(isSnapshotRecoveryError("snapshot_session_id has expired"), true);
  assert.equal(isSnapshotRecoveryError("other failure"), false);
});

test("initial sync restart helper matches snapshot change errors", () => {
  assert.equal(shouldRestartInitialSync("snapshot_revision is no longer current"), true);
  assert.equal(
    shouldRestartInitialSync("target_snapshot_revision is no longer current for changed path"),
    true
  );
  assert.equal(shouldRestartInitialSync("snapshot_session_id has expired"), true);
  assert.equal(shouldRestartInitialSync("known_snapshot_revision is no longer available"), false);
});

test("snapshot recovery notice uses generic snapshot wording", () => {
  assert.equal(
    snapshotRecoveryNotice("target_snapshot_revision is no longer current for changed path"),
    "Remote snapshot changed. Run Kinic Wiki: Initial sync again."
  );
  assert.equal(
    snapshotRecoveryNotice("snapshot_session_id has expired"),
    "Remote snapshot changed. Run Kinic Wiki: Initial sync again."
  );
  assert.equal(
    snapshotRecoveryNotice("known_snapshot_revision is no longer available"),
    "Remote history unavailable. Run Kinic Wiki: Initial sync."
  );
  assert.equal(snapshotRecoveryNotice("other failure"), null);
});

test("normalizeStoredSnapshotRevision discards legacy or broken tokens", () => {
  assert.equal(normalizeStoredSnapshotRevision(" v5:42:2f57696b69 "), "v5:42:2f57696b69");
  assert.equal(normalizeStoredSnapshotRevision("v3:1:0:2f57696b69:old-state-hash"), "");
  assert.equal(normalizeStoredSnapshotRevision(""), "");
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

test("mergeInitialSnapshotNodes keeps one node per path with delta winning", () => {
  assert.deepEqual(
    mergeInitialSnapshotNodes(
      [
        { path: "/Wiki/a.md", etag: "old-a" },
        { path: "/Wiki/b.md", etag: "old-b" }
      ],
      [
        { path: "/Wiki/b.md", etag: "new-b" },
        { path: "/Wiki/c.md", etag: "new-c" }
      ],
      ["/Wiki/a.md"]
    ),
    [
      { path: "/Wiki/b.md", etag: "new-b" },
      { path: "/Wiki/c.md", etag: "new-c" }
    ]
  );
});
