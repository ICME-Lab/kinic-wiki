// Where: workers/wiki-generator/tests/processing.test.ts
// What: Queue processing helper tests.
// Why: Optional worker log writes must not decide source generation status.
import assert from "node:assert/strict";
import test from "node:test";
import { bestEffortAppendWorkerLog, parseManualRunInput, parseQueueMessageEnvelope, processQueueMessageEnvelope, processSourceQueueMessageForTest, runManual } from "../src/processing.js";
import type { ExportSnapshotPage, FetchUpdatesPage, SearchNodeHit, WikiNode, WriteNodeAck, WriteNodeRequest } from "../src/types.js";
import type { VfsClient } from "../src/vfs.js";
import { testEnv, TestQueue, TestVfsClient, workerConfig } from "./url-ingest-fixtures.js";

test("manual source run queues the validated source etag", async () => {
  const queue = new TestQueue();
  const vfs = new TestVfsClient();
  vfs.existingSource = sourceNode("etag-authorized");

  const response = await runManual(testEnv(queue), {
    databaseId: "db_1",
    sourcePath: "/Sources/web/abc.md",
    sourceEtag: "etag-authorized",
    sessionNonce: "session-1",
    dryRun: false
  }, { vfs });

  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { queued: true, sourcePath: "/Sources/web/abc.md", sourceEtag: "etag-authorized" });
  assert.equal(queue.messages.length, 1);
  const message = queue.messages[0];
  if (message?.kind !== "source") throw new Error("source queue message expected");
  assert.equal(message.sourceEtag, "etag-authorized");
  assert.equal(message.sessionNonce, "session-1");
});

test("manual source run rejects etag mismatch without queueing", async () => {
  const queue = new TestQueue();
  const vfs = new TestVfsClient();
  vfs.existingSource = sourceNode("etag-current");

  const response = await runManual(testEnv(queue), {
    databaseId: "db_1",
    sourcePath: "/Sources/web/abc.md",
    sourceEtag: "etag-authorized",
    dryRun: false
  }, { vfs });

  assert.equal(response.status, 409);
  assert.match(await response.text(), /source etag mismatch/);
  assert.equal(queue.messages.length, 0);
});

test("manual dry run uses Japanese target path for Japanese generated slug", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (): Promise<Response> =>
    Response.json({
      choices: [
        {
          message: {
            content: JSON.stringify({
              title: "日本語記事",
              slug: "日本語記事",
              labels: {
                summary: "概要",
                key_facts: "主要事実",
                decisions: "決定事項",
                open_questions: "未解決事項",
                follow_ups: "フォローアップ",
                related_context: "関連コンテキスト",
                provenance: "来歴",
                none: "なし"
              },
              summary: "日本語の要約",
              key_facts: [{ text: "本文は日本語で保持する。", source_path: "/Sources/web/abc123.md" }],
              decisions: [],
              open_questions: [],
              follow_ups: []
            })
          }
        }
      ]
    });
  try {
    const queue = new TestQueue();
    const vfs = new TestVfsClient();
    vfs.existingSource = {
      ...sourceNode("etag-current"),
      path: "/Sources/web/abc123.md",
      content: "# 日本語記事\n\nこれは日本語の記事です。"
    };

    const response = await runManual(testEnv(queue), {
      databaseId: "db_1",
      sourcePath: "/Sources/web/abc123.md",
      sourceEtag: "etag-current",
      dryRun: true
    }, { vfs });

    assert.equal(response.status, 200);
    const body = (await response.json()) as { targetPath?: string; content?: string };
    assert.equal(body.targetPath, "/Knowledge/conversations/日本語記事.md");
    assert.match(body.content ?? "", /## 概要/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("manual source run input requires source etag", () => {
  assert.equal(parseManualRunInput({ databaseId: "db_1", sourcePath: "/Sources/web/abc.md" }), "sourceEtag is required");
  assert.deepEqual(parseManualRunInput({
    databaseId: "db_1",
    sourcePath: "/Sources/web/abc.md",
    sourceEtag: "etag-source",
    sessionNonce: "session-1"
  }), {
    databaseId: "db_1",
    sourcePath: "/Sources/web/abc.md",
    sourceEtag: "etag-source",
    sessionNonce: "session-1",
    dryRun: false
  });
});

test("worker log append failure is non-fatal", async () => {
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  try {
    const written = await bestEffortAppendWorkerLog(failingLogVfs(), "db_1", "/Knowledge/conversations", "/Knowledge/conversations/a.md", "/Sources/a.md");

    assert.equal(written, false);
    assert.match(String(warnings[0]?.[0]), /failed to append wiki-generator log/);
  } finally {
    console.warn = originalWarn;
  }
});

test("legacy url ingest queue message without nonce marks request failed", async () => {
  const vfs = new TestVfsClient();
  vfs.requestNode = ingestRequestNode();
  const envelope = parseQueueMessageEnvelope({
    kind: "url_ingest",
    canisterId: "xis3j-paaaa-aaaai-axumq-cai",
    databaseId: "db_1",
    requestPath: "/Sources/ingest-requests/1.md"
  });

  assert.equal(envelope.kind, "legacy_url_ingest_missing_nonce");
  await processQueueMessageEnvelope(testEnv(new TestQueue()), envelope, { config: workerConfig(), vfs });

  assert.equal(vfs.lastRequest?.status, "failed");
  assert.match(vfs.lastRequest?.error ?? "", /sessionNonce is required/);
  assert.equal(parseQueueMessageEnvelope({ kind: "url_ingest", canisterId: "xis3j-paaaa-aaaai-axumq-cai", databaseId: "db_1" }).kind, "invalid");
  assert.equal(
    parseQueueMessageEnvelope({
      kind: "url_ingest",
      canisterId: "xis3j-paaaa-aaaai-axumq-cai",
      databaseId: "db_1",
      requestPath: "/Sources/ingest-requests/1.md",
      sessionNonce: ""
    }).kind,
    "invalid"
  );
  assert.equal(parseQueueMessageEnvelope({ kind: "source", databaseId: "db_1", sourcePath: "", sourceEtag: "etag-source" }).kind, "invalid");
  assert.equal(
    parseQueueMessageEnvelope({
      kind: "source",
      databaseId: "db_1",
      sourcePath: "/Sources/a/a.md",
      sourceEtag: "etag-source",
      requestPath: "/Knowledge/not-ingest.md",
      sessionNonce: "session-1"
    }).kind,
    "invalid"
  );
  assert.equal(
    parseQueueMessageEnvelope({
      kind: "source",
      databaseId: "db_1",
      sourcePath: "/Sources/a/a.md",
      sourceEtag: "etag-source",
      requestPath: "/Sources/ingest-requests/../bad.md",
      sessionNonce: "session-1"
    }).kind,
    "invalid"
  );
  assert.equal(
    parseQueueMessageEnvelope({
      kind: "url_ingest",
      canisterId: "canister-1",
      databaseId: "db_1",
      requestPath: "/Knowledge/not-ingest.md",
      sessionNonce: "session-1"
    }).kind,
    "invalid"
  );
  assert.equal(
    parseQueueMessageEnvelope({
      kind: "url_ingest",
      canisterId: "canister-1",
      databaseId: "db_1",
      requestPath: "/Sources/ingest-requests/../bad.md"
    }).kind,
    "invalid"
  );
});

test("source queue write cycles check failure does not call DeepSeek", async () => {
  const originalFetch = globalThis.fetch;
  let deepSeekCalls = 0;
  globalThis.fetch = async (): Promise<Response> => {
    deepSeekCalls += 1;
    return Response.json({});
  };
  try {
    await processSourceQueueMessageForTest(
      testEnv(new TestQueue()),
      { kind: "source", databaseId: "db_1", sourcePath: "/Sources/a/a.md", sourceEtag: "etag-source" },
      { config: workerConfig(), vfs: sourceVfs({ failWriteCycles: true }) }
    );

    assert.equal(deepSeekCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("source queue source run session check failure does not call DeepSeek", async () => {
  const originalFetch = globalThis.fetch;
  let deepSeekCalls = 0;
  const sourceSessionChecks: SourceSessionCheck[] = [];
  globalThis.fetch = async (): Promise<Response> => {
    deepSeekCalls += 1;
    return Response.json({});
  };
  try {
    await processSourceQueueMessageForTest(
      testEnv(new TestQueue()),
      { kind: "source", databaseId: "db_1", sourcePath: "/Sources/a/a.md", sourceEtag: "etag-source", sessionNonce: "session-1" },
      { config: workerConfig(), vfs: sourceVfs({ failSourceRunSession: true, sourceSessionChecks }) }
    );

    assert.deepEqual(sourceSessionChecks, [
      { databaseId: "db_1", sourcePath: "/Sources/a/a.md", sourceEtag: "etag-source", sessionNonce: "session-1" }
    ]);
    assert.equal(deepSeekCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("source queue uses source run session before DeepSeek", async () => {
  const originalFetch = globalThis.fetch;
  const sourceSessionChecks: SourceSessionCheck[] = [];
  const writtenPages: WriteNodeRequest[] = [];
  const db = new RecordingD1();
  let deepSeekCalls = 0;
  globalThis.fetch = async (): Promise<Response> => {
    deepSeekCalls += 1;
    return Response.json({ choices: [{ message: { content: draftJson() } }] });
  };
  try {
    await processSourceQueueMessageForTest(
      { ...testEnv(new TestQueue()), DB: db },
      { kind: "source", databaseId: "db_1", sourcePath: "/Sources/a/a.md", sourceEtag: "etag-source", sessionNonce: "session-1" },
      { config: workerConfig(), vfs: sourceVfs({ sourceSessionChecks, writtenPages }) }
    );

    assert.deepEqual(sourceSessionChecks, [
      { databaseId: "db_1", sourcePath: "/Sources/a/a.md", sourceEtag: "etag-source", sessionNonce: "session-1" }
    ]);
    assert.equal(deepSeekCalls, 1);
    assert.equal(writtenPages.length, 2);
    assert.equal(writtenPages[0]?.path, "/Knowledge/conversations/project-notes.md");
    assert.match(writtenPages[0]?.content ?? "", /## Summary/);
    assert.ok(db.runs.some((run) => run.query.includes("INSERT INTO source_jobs") && run.query.includes("status = 'completed'")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("request-bound source queue without session nonce fails before DeepSeek", async () => {
  const originalFetch = globalThis.fetch;
  let deepSeekCalls = 0;
  const requestWrites: WriteNodeRequest[] = [];
  globalThis.fetch = async (): Promise<Response> => {
    deepSeekCalls += 1;
    return Response.json({ choices: [{ message: { content: draftJson() } }] });
  };
  try {
    await processSourceQueueMessageForTest(
      testEnv(new TestQueue()),
      {
        kind: "source",
        databaseId: "db_1",
        sourcePath: "/Sources/a/a.md",
        sourceEtag: "etag-source",
        requestPath: "/Sources/ingest-requests/1.md"
      },
      { config: workerConfig(), vfs: sourceVfs({ requestNode: ingestRequestNode(), requestWrites }) }
    );

    assert.equal(deepSeekCalls, 0);
    assert.equal(requestWrites.length, 1);
    assert.match(requestWrites[0]?.content ?? "", /status: "failed"/);
    assert.match(requestWrites[0]?.content ?? "", /sessionNonce is required/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("request-bound source queue retries when gate failure cannot be recorded", async () => {
  const originalFetch = globalThis.fetch;
  let deepSeekCalls = 0;
  globalThis.fetch = async (): Promise<Response> => {
    deepSeekCalls += 1;
    return Response.json({ choices: [{ message: { content: draftJson() } }] });
  };
  try {
    await assert.rejects(
      processSourceQueueMessageForTest(
        testEnv(new TestQueue()),
        {
          kind: "source",
          databaseId: "db_1",
          sourcePath: "/Sources/a/a.md",
          sourceEtag: "etag-source",
          requestPath: "/Sources/ingest-requests/1.md"
        },
        { config: workerConfig(), vfs: sourceVfs({ requestNode: ingestRequestNode(), failRequestWrite: true }) }
      ),
      /request failed status write failed/
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
      { kind: "source", databaseId: "db_1", sourcePath: "/Sources/a/a.md", sourceEtag: "etag-source" },
      { config: workerConfig(), vfs: sourceVfs({ failDraftWrite: true }) }
    );

    assert.equal(deepSeekCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("missing queued source is recorded as failed", async () => {
  const originalFetch = globalThis.fetch;
  let deepSeekCalls = 0;
  const db = new RecordingD1();
  globalThis.fetch = async (): Promise<Response> => {
    deepSeekCalls += 1;
    return Response.json({ choices: [{ message: { content: draftJson() } }] });
  };
  try {
    await processSourceQueueMessageForTest(
      { ...testEnv(new TestQueue()), DB: db },
      { kind: "source", databaseId: "db_1", sourcePath: "/Sources/a/missing.md", sourceEtag: "etag-source" },
      { config: workerConfig(), vfs: sourceVfs() }
    );

    assert.equal(deepSeekCalls, 0);
    assert.ok(db.runs.some((run) => run.query.includes("INSERT INTO source_jobs") && run.query.includes("status = 'failed'") && run.query.includes("target_path = NULL")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function failingLogVfs(): VfsClient {
  return {
    checkDatabaseWriteCycles: async (): Promise<void> => {},
    checkSourceRunSession: async (): Promise<void> => {},
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

type SourceSessionCheck = {
  databaseId: string;
  sourcePath: string;
  sourceEtag: string;
  sessionNonce: string;
};

function sourceVfs(
  options: {
    failWriteCycles?: boolean;
    failDraftWrite?: boolean;
    failSourceRunSession?: boolean;
    sourceSessionChecks?: SourceSessionCheck[];
    writtenPages?: WriteNodeRequest[];
    requestNode?: WikiNode;
    requestWrites?: WriteNodeRequest[];
    failRequestWrite?: boolean;
  } = {}
): VfsClient {
  return {
    checkDatabaseWriteCycles: async (): Promise<void> => {
      if (options.failWriteCycles) throw new Error("database cycles are suspended");
    },
    checkSourceRunSession: async (databaseId, sourcePath, sourceEtag, sessionNonce): Promise<void> => {
      options.sourceSessionChecks?.push({ databaseId, sourcePath, sourceEtag, sessionNonce });
      if (options.failSourceRunSession) throw new Error("source run session denied");
    },
    checkUrlIngestTriggerSession: async (): Promise<void> => {},
    readNode: async (_databaseId: string, path: string): Promise<WikiNode | null> => {
      if (path === "/Sources/a/a.md") {
        return {
          path,
          kind: "source",
          content: "raw",
          etag: "etag-source",
          metadataJson: "{}"
        };
      }
      if (path === options.requestNode?.path) return options.requestNode;
      return null;
    },
    writeNode: async (request): Promise<WriteNodeAck> => {
      if (options.failDraftWrite) throw new Error("write failed after DeepSeek");
      if (request.path === options.requestNode?.path) {
        if (options.failRequestWrite) throw new Error("request failed status write failed");
        options.requestWrites?.push(request);
      } else {
        options.writtenPages?.push(request);
      }
      return { path: request.path, kind: request.kind, etag: "etag-write" };
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
    labels: {
      summary: "Summary",
      key_facts: "Key facts",
      decisions: "Decisions",
      open_questions: "Open questions",
      follow_ups: "Follow-ups",
      related_context: "Related context",
      provenance: "Provenance",
      none: "None"
    },
    summary: "Short summary",
    key_facts: [{ text: "Fact", source_path: "/Sources/a/a.md" }],
    decisions: [],
    open_questions: [],
    follow_ups: []
  });
}

function ingestRequestNode(): WikiNode {
  return {
    path: "/Sources/ingest-requests/1.md",
    kind: "file",
    content: [
      "---",
      "kind: kinic.url_ingest_request",
      "schema_version: 1",
      "status: generating",
      'url: "https://example.com/a"',
      'requested_by: "aaaaa-aa"',
      'requested_at: "2026-05-12T00:00:00.000Z"',
      'claimed_at: "2026-05-12T00:00:01.000Z"',
      'source_path: "/Sources/a/a.md"',
      "target_path: null",
      "finished_at: null",
      "error: null",
      "---",
      "",
      "# URL Ingest Request"
    ].join("\n"),
    etag: "etag-request",
    metadataJson: "{}"
  };
}

class RecordingD1 implements D1Database {
  readonly runs: { query: string; values: D1Value[] }[] = [];

  prepare(query: string): D1PreparedStatement {
    return new RecordingD1Statement(query, this.runs);
  }
}

class RecordingD1Statement implements D1PreparedStatement {
  private values: D1Value[] = [];

  constructor(
    readonly query: string,
    private readonly runs: { query: string; values: D1Value[] }[]
  ) {}

  bind(...values: D1Value[]): D1PreparedStatement {
    this.values = values;
    return this;
  }

  async first<T = unknown>(): Promise<T | null> {
    return null;
  }

  async run(): Promise<unknown> {
    this.runs.push({ query: this.query, values: this.values });
    return { query: this.query, values: this.values };
  }
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

function sourceNode(etag: string): WikiNode {
  return {
    path: "/Sources/web/abc.md",
    kind: "source",
    content: "evidence source",
    etag,
    metadataJson: "{}"
  };
}
