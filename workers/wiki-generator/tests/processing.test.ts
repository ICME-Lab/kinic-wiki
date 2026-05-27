// Where: workers/wiki-generator/tests/processing.test.ts
// What: Queue processing helper tests.
// Why: Optional worker log writes must not decide source generation status.
import assert from "node:assert/strict";
import test from "node:test";
import { bestEffortAppendWorkerLog, parseManualRunInput, runManual } from "../src/processing.js";
import type { ExportSnapshotPage, FetchUpdatesPage, SearchNodeHit, WikiNode, WriteNodeAck } from "../src/types.js";
import type { VfsClient } from "../src/vfs.js";
import { testEnv, TestQueue, TestVfsClient } from "./url-ingest-fixtures.js";

test("manual source run queues the validated source etag", async () => {
  const queue = new TestQueue();
  const vfs = new TestVfsClient();
  vfs.existingSource = sourceNode("etag-authorized");

  const response = await runManual(testEnv(queue), {
    databaseId: "db_1",
    sourcePath: "/Sources/raw/web/abc.md",
    sourceEtag: "etag-authorized",
    dryRun: false
  }, { vfs });

  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { queued: true, sourcePath: "/Sources/raw/web/abc.md", sourceEtag: "etag-authorized" });
  assert.equal(queue.messages.length, 1);
  const message = queue.messages[0];
  if (message?.kind !== "source") throw new Error("source queue message expected");
  assert.equal(message.sourceEtag, "etag-authorized");
});

test("manual source run rejects etag mismatch without queueing", async () => {
  const queue = new TestQueue();
  const vfs = new TestVfsClient();
  vfs.existingSource = sourceNode("etag-current");

  const response = await runManual(testEnv(queue), {
    databaseId: "db_1",
    sourcePath: "/Sources/raw/web/abc.md",
    sourceEtag: "etag-authorized",
    dryRun: false
  }, { vfs });

  assert.equal(response.status, 409);
  assert.match(await response.text(), /source etag mismatch/);
  assert.equal(queue.messages.length, 0);
});

test("manual source run input requires source etag", () => {
  assert.equal(parseManualRunInput({ databaseId: "db_1", sourcePath: "/Sources/raw/web/abc.md" }), "sourceEtag is required");
});

test("worker log append failure is non-fatal", async () => {
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  try {
    const written = await bestEffortAppendWorkerLog(failingLogVfs(), "db_1", "/Wiki/conversations", "/Wiki/conversations/a.md", "/Sources/raw/a.md");

    assert.equal(written, false);
    assert.match(String(warnings[0]?.[0]), /failed to append wiki-generator log/);
  } finally {
    console.warn = originalWarn;
  }
});

function failingLogVfs(): VfsClient {
  return {
    readNode: async (_databaseId: string, path: string): Promise<WikiNode | null> => ({
      path,
      kind: "file",
      content: "# Conversation Worker Log\n",
      etag: "etag-log",
      metadataJson: "{}"
    }),
    writeNode: async (): Promise<WriteNodeAck> => {
      throw new Error("etag conflict");
    },
    mkdirNode: async (): Promise<void> => {},
    searchNodes: async (): Promise<SearchNodeHit[]> => [],
    exportSnapshot: async (): Promise<ExportSnapshotPage> => ({ snapshotRevision: "rev", nodes: [], nextCursor: null }),
    fetchUpdates: async (): Promise<FetchUpdatesPage> => ({ snapshotRevision: "rev", changedNodes: [], removedPaths: [], nextCursor: null })
  };
}

function sourceNode(etag: string): WikiNode {
  return {
    path: "/Sources/raw/web/abc.md",
    kind: "source",
    content: "raw source",
    etag,
    metadataJson: "{}"
  };
}
