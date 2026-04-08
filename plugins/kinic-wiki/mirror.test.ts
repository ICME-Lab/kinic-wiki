import test from "node:test";
import assert from "node:assert/strict";

import {
  parseMirrorFrontmatter,
  serializeMirrorFile,
  stripManagedFrontmatter
} from "./frontmatter";
import { parsePluginSettings } from "./types";

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
