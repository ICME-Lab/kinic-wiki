import test from "node:test";
import assert from "node:assert/strict";

import {
  parseMirrorFrontmatter,
  remoteDeleteConflictMarkdown,
  serializeMirrorFile,
  stripManagedFrontmatter
} from "./frontmatter";
import { conflictFilePath, findDeletedTrackedNodes, partitionPullUpdates } from "./mirror_logic";
import { NodeSnapshot, parsePluginSettings, TrackedNodeState } from "./types";

test("managed mirror frontmatter roundtrips path and etag", () => {
  const content = serializeMirrorFile({
    path: "/Wiki/nested/bar.md",
    kind: "file",
    etag: "etag-1",
    updated_at: 42,
    mirror: true
  }, "# Bar\n");

  const frontmatter = parseMirrorFrontmatter(content);
  assert.deepEqual(frontmatter, {
    path: "/Wiki/nested/bar.md",
    kind: "file",
    etag: "etag-1",
    updated_at: 42,
    mirror: true
  });
  assert.equal(stripManagedFrontmatter(content).trim(), "# Bar");
});

test("plugin settings preserve tracked nodes", () => {
  const settings = parsePluginSettings({
    replicaHost: "http://127.0.0.1:8000",
    canisterId: "aaaaa-aa",
    mirrorRoot: "Wiki",
    autoPullOnStartup: true,
    lastSnapshotRevision: "v5:1:2f57696b69",
    lastSyncedAt: 42,
    trackedNodes: [{
      path: "/Wiki/foo.md",
      kind: "file",
      etag: "etag-1"
    }]
  });

  assert.equal(settings.trackedNodes.length, 1);
  assert.equal(settings.trackedNodes[0].etag, "etag-1");
  assert.equal(settings.lastSnapshotRevision, "v5:1:2f57696b69");
});

test("plugin settings discard legacy snapshot revisions", () => {
  const settings = parsePluginSettings({
    lastSnapshotRevision: "v3:1:0:2f57696b69:old-state-hash"
  });

  assert.equal(settings.lastSnapshotRevision, "");
});

test("deletedTrackedNodes does not treat broken frontmatter files as deleted", () => {
  const trackedNodes: TrackedNodeState[] = [{
    path: "/Wiki/foo.md",
    kind: "file",
    etag: "etag-1"
  }];
  const deleted = findDeletedTrackedNodes(
    trackedNodes,
    (remotePath) => remoteToLocalPath("Wiki", remotePath),
    (localPath) => localPath === "Wiki/foo.md"
  );

  assert.deepEqual(deleted, []);
});

test("deletedTrackedNodes returns only tracked nodes whose local file is missing", () => {
  const trackedNodes: TrackedNodeState[] = [
    { path: "/Wiki/foo.md", kind: "file", etag: "etag-1" },
    { path: "/Wiki/missing.md", kind: "file", etag: "etag-2" }
  ];
  const deleted = findDeletedTrackedNodes(
    trackedNodes,
    (remotePath) => remoteToLocalPath("Wiki", remotePath),
    (localPath) => localPath === "Wiki/foo.md"
  );

  assert.deepEqual(deleted, [trackedNodes[1]]);
});

test("deletedTrackedNodes keeps normal mirror files out of delete set", () => {
  const trackedNodes: TrackedNodeState[] = [{
    path: "/Wiki/nested/bar.md",
    kind: "file",
    etag: "etag-1"
  }];
  const deleted = findDeletedTrackedNodes(
    trackedNodes,
    (remotePath) => remoteToLocalPath("Wiki", remotePath),
    (localPath) => localPath === "Wiki/nested/bar.md"
  );

  assert.deepEqual(deleted, []);
});

test("conflictFilePath keeps same basenames from different paths separate", () => {
  const first = conflictFilePath("Wiki", "/Wiki/a/foo.md");
  const second = conflictFilePath("Wiki", "/Wiki/b/foo.md");

  assert.match(first, /^Wiki\/conflicts\/a__foo--[0-9a-f]{16}\.conflict\.md$/);
  assert.match(second, /^Wiki\/conflicts\/b__foo--[0-9a-f]{16}\.conflict\.md$/);
  assert.notEqual(first, second);
});

test("conflictFilePath keeps a readable short stem when unicode segments collapse", () => {
  assert.match(conflictFilePath("Wiki", "/Wiki/日本/foo.md"), /^Wiki\/conflicts\/foo--[0-9a-f]{16}\.conflict\.md$/);
  assert.match(conflictFilePath("Wiki", "/Wiki/emoji/😀.md"), /^Wiki\/conflicts\/emoji--[0-9a-f]{16}\.conflict\.md$/);
});

test("conflictFilePath stays inside filesystem component limits", () => {
  const longParent = "deep".repeat(100);
  const longName = "emoji😀".repeat(100);
  const result = conflictFilePath("Wiki", `/Wiki/${longParent}/${longName}.md`);
  const fileName = result.split("/").pop();

  assert.ok(fileName);
  assert.ok(Buffer.byteLength(fileName, "utf8") <= 255);
  assert.match(fileName, /^[a-z0-9-]+(?:__[a-z0-9-]+)?--[0-9a-f]{16}\.conflict\.md$/);
});

test("partitionPullUpdates applies clean updates and keeps dirty conflicts local", () => {
  const trackedNodes: TrackedNodeState[] = [
    { path: "/Wiki/clean.md", kind: "file", etag: "old-clean" },
    { path: "/Wiki/dirty.md", kind: "file", etag: "old-dirty" },
    { path: "/Wiki/clean-delete.md", kind: "file", etag: "old-delete" },
    { path: "/Wiki/dirty-delete.md", kind: "file", etag: "old-dirty-delete" }
  ];
  const cleanUpdate = nodeSnapshot("/Wiki/clean.md", "new-clean");
  const dirtyUpdate = nodeSnapshot("/Wiki/dirty.md", "new-dirty");

  const result = partitionPullUpdates(
    [cleanUpdate, dirtyUpdate],
    ["/Wiki/clean-delete.md", "/Wiki/dirty-delete.md"],
    new Set(["/Wiki/dirty.md", "/Wiki/dirty-delete.md"]),
    trackedNodes
  );

  assert.deepEqual(result.safeChangedNodes, [cleanUpdate]);
  assert.deepEqual(result.conflictChangedNodes, [dirtyUpdate]);
  assert.deepEqual(result.safeRemovedPaths, ["/Wiki/clean-delete.md"]);
  assert.deepEqual(result.conflictRemovedPaths, ["/Wiki/dirty-delete.md"]);
  assert.deepEqual(result.nextTrackedNodes, [
    { path: "/Wiki/clean.md", kind: "file", etag: "new-clean" },
    { path: "/Wiki/dirty-delete.md", kind: "file", etag: "old-dirty-delete" },
    { path: "/Wiki/dirty.md", kind: "file", etag: "old-dirty" }
  ]);
});

test("partitionPullUpdates keeps dirty initial-sync stale files out of removals", () => {
  const trackedNodes: TrackedNodeState[] = [
    { path: "/Wiki/stale-clean.md", kind: "file", etag: "clean" },
    { path: "/Wiki/stale-dirty.md", kind: "file", etag: "dirty" },
    { path: "/Wiki/tracked-only-stale.md", kind: "file", etag: "tracked-only" }
  ];

  const result = partitionPullUpdates(
    [],
    ["/Wiki/stale-clean.md", "/Wiki/stale-dirty.md", "/Wiki/tracked-only-stale.md"],
    new Set(["/Wiki/stale-dirty.md"]),
    trackedNodes
  );

  assert.deepEqual(result.safeRemovedPaths, ["/Wiki/stale-clean.md", "/Wiki/tracked-only-stale.md"]);
  assert.deepEqual(result.conflictRemovedPaths, ["/Wiki/stale-dirty.md"]);
  assert.deepEqual(result.nextTrackedNodes, [
    { path: "/Wiki/stale-dirty.md", kind: "file", etag: "dirty" }
  ]);
});

test("remoteDeleteConflictMarkdown includes local content when available", () => {
  const result = remoteDeleteConflictMarkdown("/Wiki/dirty.md", "# Local\n\nbody");

  assert.match(result, /^# Remote delete conflict/);
  assert.match(result, /Remote path: \/Wiki\/dirty\.md/);
  assert.match(result, /Status: remote copy was deleted; dirty local copy was kept\./);
  assert.match(result, /Resolution: re-push the local file or delete the local file and pull again\./);
  assert.match(result, /## Local content/);
  assert.match(result, /# Local/);
});

test("remoteDeleteConflictMarkdown omits empty local content section", () => {
  const result = remoteDeleteConflictMarkdown("/Wiki/dirty.md");

  assert.doesNotMatch(result, /## Local content/);
});

function remoteToLocalPath(mirrorRoot: string, remotePath: string): string {
  const normalized = remotePath.replace(/\/+/g, "/");
  if (!normalized.startsWith("/Wiki")) {
    throw new Error(`unsupported remote path outside /Wiki: ${remotePath}`);
  }
  return `${mirrorRoot}/${normalized.replace(/^\/Wiki\/?/, "")}`.replace(/\/+/g, "/").replace(/\/$/, "");
}

function nodeSnapshot(path: string, etag: string): NodeSnapshot {
  return {
    path,
    kind: "file",
    content: `content for ${path}`,
    created_at: 1,
    updated_at: 2,
    etag,
    metadata_json: "{}"
  };
}
