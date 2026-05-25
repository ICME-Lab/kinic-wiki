// Where: workers/wiki-generator/tests/processing.test.ts
// What: Queue processing helper tests.
// Why: Optional worker log writes must not decide source generation status.
import assert from "node:assert/strict";
import test from "node:test";
import { bestEffortAppendWorkerLog, processSourceQueueMessageForTest } from "../src/processing.js";
import type { ExportSnapshotPage, FetchUpdatesPage, SearchNodeHit, WikiNode, WriteNodeAck } from "../src/types.js";
import type { VfsClient } from "../src/vfs.js";
import { testEnv, TestQueue, workerConfig } from "./url-ingest-fixtures.js";

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

test("source queue billable check failure does not call DeepSeek", async () => {
  const originalFetch = globalThis.fetch;
  let deepSeekCalls = 0;
  globalThis.fetch = async (): Promise<Response> => {
    deepSeekCalls += 1;
    return Response.json({});
  };
  try {
    await processSourceQueueMessageForTest(
      testEnv(new TestQueue()),
      { kind: "source", databaseId: "db_1", sourcePath: "/Sources/raw/a/a.md", sourceEtag: "etag-source" },
      { config: workerConfig(), vfs: sourceVfs({ failBillable: true }) }
    );

    assert.equal(deepSeekCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("failed status write after DeepSeek is non-retry", async () => {
  const originalFetch = globalThis.fetch;
  let deepSeekCalls = 0;
  globalThis.fetch = async (): Promise<Response> => {
    deepSeekCalls += 1;
    return Response.json({ choices: [{ message: { content: draftJson() } }] });
  };
  try {
    await processSourceQueueMessageForTest(
      { ...testEnv(new TestQueue()), DB: new FailingD1AfterFirstRun() },
      { kind: "source", databaseId: "db_1", sourcePath: "/Sources/raw/a/a.md", sourceEtag: "etag-source" },
      { config: workerConfig(), vfs: sourceVfs({ failDraftWrite: true }) }
    );

    assert.equal(deepSeekCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function failingLogVfs(): VfsClient {
  return {
    checkDatabaseBillable: async (): Promise<void> => {},
    checkUrlIngestTriggerSession: async (): Promise<void> => {},
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

function sourceVfs(options: { failBillable?: boolean; failDraftWrite?: boolean } = {}): VfsClient {
  return {
    checkDatabaseBillable: async (): Promise<void> => {
      if (options.failBillable) throw new Error("database billing is suspended");
    },
    checkUrlIngestTriggerSession: async (): Promise<void> => {},
    readNode: async (_databaseId: string, path: string): Promise<WikiNode | null> => {
      if (path === "/Sources/raw/a/a.md") {
        return {
          path,
          kind: "source",
          content: "raw",
          etag: "etag-source",
          metadataJson: "{}"
        };
      }
      return null;
    },
    writeNode: async (): Promise<WriteNodeAck> => {
      if (options.failDraftWrite) throw new Error("write failed after DeepSeek");
      return { path: "/Wiki/conversations/project-notes.md", kind: "file", etag: "etag-write" };
    },
    mkdirNode: async (): Promise<void> => {},
    searchNodes: async (): Promise<SearchNodeHit[]> => [],
    exportSnapshot: async (): Promise<ExportSnapshotPage> => ({ snapshotRevision: "rev", nodes: [], nextCursor: null }),
    fetchUpdates: async (): Promise<FetchUpdatesPage> => ({ snapshotRevision: "rev", changedNodes: [], removedPaths: [], nextCursor: null })
  };
}

function draftJson(): string {
  return JSON.stringify({
    title: "Project Notes",
    slug: "project-notes",
    summary: "Short summary",
    key_facts: [{ text: "Fact", source_path: "/Sources/raw/a/a.md" }],
    decisions: [],
    open_questions: [],
    follow_ups: []
  });
}

class FailingD1AfterFirstRun implements D1Database {
  private runCount = 0;

  prepare(query: string): D1PreparedStatement {
    return new FailingD1Statement(query, () => {
      this.runCount += 1;
      return this.runCount;
    });
  }
}

class FailingD1Statement implements D1PreparedStatement {
  private values: D1Value[] = [];

  constructor(
    private readonly query: string,
    private readonly nextRunCount: () => number
  ) {}

  bind(...values: D1Value[]): D1PreparedStatement {
    this.values = values;
    return this;
  }

  async first<T = unknown>(): Promise<T | null> {
    return null;
  }

  async run(): Promise<unknown> {
    if (this.nextRunCount() > 1) throw new Error("failed status write failed");
    return { query: this.query, values: this.values };
  }
}
