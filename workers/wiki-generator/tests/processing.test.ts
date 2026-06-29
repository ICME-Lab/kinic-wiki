// Where: workers/wiki-generator/tests/processing.test.ts
// What: Queue processing helper tests.
// Why: Optional worker log writes must not decide source generation status.
import assert from "node:assert/strict";
import test from "node:test";
import { bestEffortAppendWorkerLog, parseManualRunInput, parseQueueMessageEnvelope, processQueueMessageEnvelope, processSourceQueueMessageForTest, rankContextHits, runManual } from "../src/processing.js";
import type { ExportSnapshotPage, FetchUpdatesPage, SearchNodeHit, SourceJob, WikiNode, WriteNodeAck, WriteNodeRequest } from "../src/types.js";
import type { VfsClient } from "../src/vfs.js";
import { testEnv, TestQueue, TestVfsClient, withFetchedPage, workerConfig } from "./source-capture-fixtures.js";

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

test("manual source run accepts session source paths", async () => {
  const queue = new TestQueue();
  const vfs = new TestVfsClient();
  vfs.existingSource = {
    ...sourceNode("etag-session"),
    path: "/Sources/sessions/codex/run_123.md"
  };

  const response = await runManual(
    testEnv(queue),
    {
      databaseId: "db_1",
      sourcePath: "/Sources/sessions/codex/run_123.md",
      sourceEtag: "etag-session",
      dryRun: false
    },
    { vfs }
  );

  assert.equal(response.status, 202);
  assert.equal(queue.messages.length, 1);
  const message = queue.messages[0];
  if (message?.kind !== "source") throw new Error("source queue message expected");
  assert.equal(message.sourcePath, "/Sources/sessions/codex/run_123.md");
});

test("context hits rank Sources after database notes", () => {
  assert.deepEqual(
    rankContextHits([
      contextHit("/Sources/web/a.md"),
      contextHit("/Memory/session.md"),
      contextHit("/Sources/web/b.md"),
      contextHit("/Knowledge/fact.md")
    ], "/Sources").map((hit) => hit.path),
    ["/Memory/session.md", "/Knowledge/fact.md", "/Sources/web/a.md", "/Sources/web/b.md"]
  );
});

test("context hits rank custom source prefix after database notes", () => {
  assert.deepEqual(
    rankContextHits([
      contextHit("/Evidence/raw/a.md"),
      contextHit("/Sources/raw/a.md"),
      contextHit("/Knowledge/fact.md"),
      contextHit("/Evidence/raw/b.md")
    ], "/Evidence").map((hit) => hit.path),
    ["/Sources/raw/a.md", "/Knowledge/fact.md", "/Evidence/raw/a.md", "/Evidence/raw/b.md"]
  );
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

test("source capture queue message without nonce is invalid", async () => {
  const envelope = parseQueueMessageEnvelope({
    kind: "source_capture",
    canisterId: "xis3j-paaaa-aaaai-axumq-cai",
    databaseId: "db_1",
    requestPath: "/Sources/source-capture-requests/1.md"
  });

  assert.equal(envelope.kind, "invalid");
  assert.equal(parseQueueMessageEnvelope({ kind: "source_capture", canisterId: "xis3j-paaaa-aaaai-axumq-cai", databaseId: "db_1" }).kind, "invalid");
  assert.equal(
    parseQueueMessageEnvelope({
      kind: "source_capture",
      canisterId: "xis3j-paaaa-aaaai-axumq-cai",
      databaseId: "db_1",
      requestPath: "/Sources/source-capture-requests/1.md",
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
      requestPath: "/Sources/source-capture-requests/../bad.md",
      sessionNonce: "session-1"
    }).kind,
    "invalid"
  );
  assert.equal(
    parseQueueMessageEnvelope({
      kind: "source_capture",
      canisterId: "canister-1",
      databaseId: "db_1",
      requestPath: "/Knowledge/not-ingest.md",
      sessionNonce: "session-1"
    }).kind,
    "invalid"
  );
  assert.equal(
    parseQueueMessageEnvelope({
      kind: "source_capture",
      canisterId: "canister-1",
      databaseId: "db_1",
      requestPath: "/Sources/source-capture-requests/../bad.md"
    }).kind,
    "invalid"
  );
  assert.deepEqual(parseQueueMessageEnvelope({
    kind: "source_capture",
    canisterId: "canister-1",
    databaseId: "db_1",
    requestPath: "/Sources/source-capture-requests/1.md",
    sessionNonce: "session-1"
  }), {
    kind: "valid",
    message: {
      kind: "source_capture",
      canisterId: "canister-1",
      databaseId: "db_1",
      requestPath: "/Sources/source-capture-requests/1.md",
      sessionNonce: "session-1"
    }
  });
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

test("source queue accepts skill-run source paths before source lookup", async () => {
  const db = new RecordingD1();

  await processSourceQueueMessageForTest(
    { ...testEnv(new TestQueue()), DB: db },
    { kind: "source", databaseId: "db_1", sourcePath: "/Sources/skill-runs/legal-review/1700000000000.md", sourceEtag: "etag-source" },
    { config: workerConfig(), vfs: sourceVfs() }
  );

  assert.ok(db.runs.some((run) => run.query.includes("INSERT INTO source_jobs") && run.query.includes("status = 'failed'")));
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
        requestPath: "/Sources/source-capture-requests/1.md"
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

test("request-bound source queue throws when gate failure cannot be recorded", async () => {
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
          requestPath: "/Sources/source-capture-requests/1.md"
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

test("valid queue envelope passes test context to source capture processing", async () => {
  const queue = new TestQueue();
  const vfs = new TestVfsClient();
  vfs.requestNode = ingestQueuedRequestNode();

  await withFetchedPage(async () => {
    await processQueueMessageEnvelope(
      testEnv(queue),
      {
        kind: "valid",
        message: {
          kind: "source_capture",
          canisterId: "xis3j-paaaa-aaaai-axumq-cai",
          databaseId: "db_1",
          requestPath: "/Sources/source-capture-requests/1.md",
          sessionNonce: "session-1"
        }
      },
      { config: workerConfig(), vfs }
    );
  });

  assert.equal(queue.messages.length, 1);
  assert.equal(vfs.sourceWrites, 1);
});

test("legacy url_ingest queue messages are acked with an explicit invalid reason", () => {
  assert.deepEqual(parseQueueMessageEnvelope({ kind: "url_ingest", databaseId: "db_1" }), {
    kind: "invalid",
    reason: "legacy url_ingest queue message is unsupported"
  });
});

test("stale source etag message attaches request to newer completed job", async () => {
  const requestWrites: WriteNodeRequest[] = [];
  const db = new StaticJobD1({
    database_id: "db_1",
    source_path: "/Sources/a/a.md",
    source_etag: "etag-new",
    status: "completed",
    target_path: "/Knowledge/conversations/new.md",
    attempts: 1,
    last_error: null,
    updated_at: "2026-05-12T00:00:00.000Z"
  });

  await processSourceQueueMessageForTest(
    { ...testEnv(new TestQueue()), DB: db },
    {
      kind: "source",
      databaseId: "db_1",
      sourcePath: "/Sources/a/a.md",
      sourceEtag: "etag-old",
      requestPath: "/Sources/source-capture-requests/1.md",
      sessionNonce: "session-1"
    },
    { config: workerConfig(), vfs: sourceVfs({ requestNode: ingestRequestNode(), requestWrites }) }
  );

  assert.equal(requestWrites.length, 1);
  assert.match(requestWrites[0]?.content ?? "", /status: "completed"/);
  assert.match(requestWrites[0]?.content ?? "", /target_path: "\/Knowledge\/conversations\/new.md"/);
  assert.equal(db.runs.length, 0);
});

test("stale source etag message does not overwrite newer queued job", async () => {
  const db = new StaticJobD1({
    database_id: "db_1",
    source_path: "/Sources/a/a.md",
    source_etag: "etag-new",
    status: "queued",
    target_path: null,
    attempts: 0,
    last_error: null,
    updated_at: "2026-05-12T00:00:00.000Z"
  });

  await processSourceQueueMessageForTest(
    { ...testEnv(new TestQueue()), DB: db },
    { kind: "source", databaseId: "db_1", sourcePath: "/Sources/a/a.md", sourceEtag: "etag-old" },
    { config: workerConfig(), vfs: sourceVfs() }
  );

  assert.equal(db.runs.length, 0);
});

function failingLogVfs(): VfsClient {
  return {
    checkDatabaseWriteCycles: async (): Promise<void> => {},
    checkSourceRunSession: async (): Promise<void> => {},
    checkSourceCaptureTriggerSession: async (): Promise<void> => {},
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
    checkSourceCaptureTriggerSession: async (): Promise<void> => {},
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
    path: "/Sources/source-capture-requests/1.md",
    kind: "file",
    content: [
      "---",
      "kind: kinic.source_capture_request",
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
      "# Source Capture Request"
    ].join("\n"),
    etag: "etag-request",
    metadataJson: "{}"
  };
}

function ingestQueuedRequestNode(): WikiNode {
  return {
    ...ingestRequestNode(),
    content: [
      "---",
      "kind: kinic.source_capture_request",
      "schema_version: 1",
      "status: queued",
      'url: "https://example.com/a"',
      'requested_by: "aaaaa-aa"',
      'requested_at: "2026-05-12T00:00:00.000Z"',
      "claimed_at: null",
      "source_path: null",
      "target_path: null",
      "finished_at: null",
      "error: null",
      "---",
      "",
      "# Source Capture Request"
    ].join("\n")
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

class StaticJobD1 implements D1Database {
  readonly runs: { query: string; values: D1Value[] }[] = [];

  constructor(private readonly job: SourceJob | null) {}

  prepare(query: string): D1PreparedStatement {
    return new StaticJobD1Statement(query, this.job, this.runs);
  }
}

class StaticJobD1Statement implements D1PreparedStatement {
  private values: D1Value[] = [];

  constructor(
    private readonly query: string,
    private readonly job: SourceJob | null,
    private readonly runs: { query: string; values: D1Value[] }[]
  ) {}

  bind(...values: D1Value[]): D1PreparedStatement {
    this.values = values;
    return this;
  }

  async first<T = unknown>(): Promise<T | null> {
    if (!this.query.includes("SELECT database_id, source_path, source_etag, status, target_path")) return null;
    if (this.job?.database_id !== this.values[0] || this.job.source_path !== this.values[1]) return null;
    return this.job as T;
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

function contextHit(path: string): SearchNodeHit {
  return {
    path,
    kind: "file",
    previewExcerpt: null,
    snippet: null
  };
}
