// Where: workers/wiki-generator/tests/processing.test.ts
// What: Queue processing helper tests.
// Why: Optional worker log writes must not decide source generation status.
import assert from "node:assert/strict";
import test from "node:test";
import { bestEffortAppendWorkerLog } from "../src/processing.js";
import type { ExportSnapshotPage, FetchUpdatesPage, SearchNodeHit, WikiNode, WriteNodeAck } from "../src/types.js";
import type { VfsClient } from "../src/vfs.js";

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
