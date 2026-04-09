import test from "node:test";
import assert from "node:assert/strict";

import {
  parseMirrorFrontmatter,
  serializeMirrorFile,
  stripManagedFrontmatter
} from "./frontmatter";
import { conflictFilePath, findDeletedTrackedNodes } from "./mirror_logic";
import { parsePluginSettings, TrackedNodeState } from "./types";

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
    lastSnapshotRevision: "snap-1",
    lastSyncedAt: 42,
    trackedNodes: [{
      path: "/Wiki/foo.md",
      kind: "file",
      etag: "etag-1"
    }]
  });

  assert.equal(settings.trackedNodes.length, 1);
  assert.equal(settings.trackedNodes[0].etag, "etag-1");
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

function remoteToLocalPath(mirrorRoot: string, remotePath: string): string {
  const normalized = remotePath.replace(/\/+/g, "/");
  if (!normalized.startsWith("/Wiki")) {
    throw new Error(`unsupported remote path outside /Wiki: ${remotePath}`);
  }
  return `${mirrorRoot}/${normalized.replace(/^\/Wiki\/?/, "")}`.replace(/\/+/g, "/").replace(/\/$/, "");
}
