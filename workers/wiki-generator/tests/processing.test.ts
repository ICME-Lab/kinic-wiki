// Where: workers/wiki-generator/tests/processing.test.ts
// What: Queue processing helper tests.
// Why: Optional worker log writes must not decide source generation status.
import assert from "node:assert/strict";
import test from "node:test";
import { bestEffortAppendWorkerLog, deepSeekRetryDelaySeconds, parseManualRunInput, parseQueueMessageEnvelope, processQueueMessage, processQueueMessageEnvelope, processSourceQueueMessageForTest, rankContextHits, runManual } from "../src/processing.js";
import { DeepSeekRequestError } from "../src/openai.js";
import type { ExportSnapshotPage, FetchUpdatesPage, SearchNodeHit, SourceJob, WikiNode, WriteNodeAck, WriteNodeRequest } from "../src/types.js";
import type { VfsClient } from "../src/vfs.js";
import { testEnv, TestQueue, TestR2Bucket, TestVfsClient, withFetchedPage, workerConfig } from "./source-capture-fixtures.js";

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

test("DeepSeek 503 without Retry-After uses equal-jitter overload backoff", () => {
  const error = new DeepSeekRequestError("deepseek_http_503", "overloaded", true);
  assert.equal(deepSeekRetryDelaySeconds(error, 1, 0), 30);
  assert.equal(deepSeekRetryDelaySeconds(error, 1, 1), 60);
  assert.equal(deepSeekRetryDelaySeconds(error, 2, 0), 60);
  assert.equal(deepSeekRetryDelaySeconds(error, 2, 1), 120);
  assert.equal(deepSeekRetryDelaySeconds(error, 3, 0), 120);
  assert.equal(deepSeekRetryDelaySeconds(error, 3, 1), 240);
  assert.equal(deepSeekRetryDelaySeconds(error, 4, 0), 150);
  assert.equal(deepSeekRetryDelaySeconds(error, 4, 1), 300);
});

test("DeepSeek retry delay honors Retry-After and leaves other failures on generic backoff", () => {
  assert.equal(deepSeekRetryDelaySeconds(new DeepSeekRequestError("deepseek_http_503", "overloaded", true, 240), 1, 0), 240);
  assert.equal(deepSeekRetryDelaySeconds(new DeepSeekRequestError("deepseek_http_500", "server error", true), 1, 0), undefined);
  assert.equal(deepSeekRetryDelaySeconds(null, 1, 0), undefined);
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
    canisterId: "6emaw-iyaaa-aaaay-aacka-cai",
    databaseId: "db_1",
    requestPath: "/Sources/source-capture-requests/1.md"
  });

  assert.equal(envelope.kind, "invalid");
  assert.equal(parseQueueMessageEnvelope({ kind: "source_capture", canisterId: "6emaw-iyaaa-aaaay-aacka-cai", databaseId: "db_1" }).kind, "invalid");
  assert.equal(
    parseQueueMessageEnvelope({
      kind: "source_capture",
      canisterId: "6emaw-iyaaa-aaaay-aacka-cai",
      databaseId: "db_1",
      requestPath: "/Sources/source-capture-requests/1.md",
      sessionNonce: ""
    }).kind,
    "invalid"
  );
  assert.equal(parseQueueMessageEnvelope({ kind: "source", databaseId: "db_1", sourcePath: "", sourceEtag: "etag-source" }).kind, "invalid");
  assert.deepEqual(
    parseQueueMessageEnvelope({ kind: "source", databaseId: "db_1", sourcePath: "/Sources/a/a.md", sourceEtag: "etag-source" }),
    {
      kind: "valid",
      message: {
        kind: "source",
        databaseId: "db_1",
        sourcePath: "/Sources/a/a.md",
        sourceEtag: "etag-source",
        requestPath: undefined,
        sessionNonce: undefined,
        outputLanguage: undefined
      }
    }
  );
  assert.equal(
    parseQueueMessageEnvelope({
      kind: "source",
      databaseId: "db_1",
      sourcePath: "/Sources/a/a.md",
      sourceEtag: "etag-source",
      outputLanguage: "unsupported"
    }).kind,
    "invalid"
  );
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

test("link_preview queue message validates required fields", () => {
  const requestedAt = "2026-05-12T00:00:00.000Z";
  assert.deepEqual(parseQueueMessageEnvelope({ kind: "link_preview", canisterId: "canister-1", databaseId: "db_1", requestedAt }), {
    kind: "valid",
    message: { kind: "link_preview", canisterId: "canister-1", databaseId: "db_1", requestedAt }
  });
  assert.equal(parseQueueMessageEnvelope({ kind: "link_preview", databaseId: "db_1", requestedAt }).kind, "invalid");
  assert.equal(parseQueueMessageEnvelope({ kind: "link_preview", canisterId: "canister-1", requestedAt }).kind, "invalid");
  assert.equal(parseQueueMessageEnvelope({ kind: "link_preview", canisterId: "canister-1", databaseId: "db_1", requestedAt: "bad-date" }).kind, "invalid");
});

test("link_preview queue writes active anonymous public database image to R2", async () => {
  const bucket = new TestR2Bucket();
  await processQueueMessageEnvelope(
    { ...testEnv(new TestQueue()), LINK_PREVIEW_IMAGES: bucket },
    {
      kind: "valid",
      message: {
        kind: "link_preview",
        canisterId: "6emaw-iyaaa-aaaay-aacka-cai",
        databaseId: "db_active",
        requestedAt: "2026-05-12T00:00:00.000Z"
      }
    },
    {
      config: workerConfig(),
      publicVfs: {
        listPublicDatabases: async () => [
          { databaseId: "db_active", title: "Active DB", description: "Public DB", status: "active" },
          { databaseId: "db_pending", title: "Pending DB", description: "", status: "pending" }
        ]
      },
      renderLinkPreviewImage: async () => new Response(new Uint8Array([1, 2, 3]))
    }
  );

  assert.equal(bucket.puts.length, 1);
  assert.equal(bucket.puts[0]?.key, "db-link-preview/v1/db_active.png");
  assert.equal(bucket.puts[0]?.options?.httpMetadata?.contentType, "image/png");
  assert.equal(bucket.puts[0]?.options?.httpMetadata?.cacheControl, "public, max-age=300, s-maxage=86400");
});

test("link_preview queue skips non-public or inactive databases", async () => {
  const bucket = new TestR2Bucket();
  await processQueueMessageEnvelope(
    { ...testEnv(new TestQueue()), LINK_PREVIEW_IMAGES: bucket },
    {
      kind: "valid",
      message: {
        kind: "link_preview",
        canisterId: "6emaw-iyaaa-aaaay-aacka-cai",
        databaseId: "db_private",
        requestedAt: "2026-05-12T00:00:00.000Z"
      }
    },
    {
      config: workerConfig(),
      publicVfs: {
        listPublicDatabases: async () => [{ databaseId: "db_pending", title: "Pending DB", description: "", status: "pending" }]
      },
      renderLinkPreviewImage: async () => {
        throw new Error("render should not run");
      }
    }
  );

  assert.equal(bucket.puts.length, 0);
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

  assert.ok(db.runs.some((run) => run.query.includes("UPDATE source_jobs") && run.query.includes("SET status = 'failed'")));
});

test("source queue uses source run session before DeepSeek", async () => {
  const originalFetch = globalThis.fetch;
  const sourceSessionChecks: SourceSessionCheck[] = [];
  const writtenPages: WriteNodeRequest[] = [];
  const db = new RecordingD1();
  const targetPath = "/Knowledge/conversations/project-notes.md";
  let deepSeekCalls = 0;
  globalThis.fetch = async (): Promise<Response> => {
    deepSeekCalls += 1;
    return Response.json({ choices: [{ message: { content: draftJson() } }] });
  };
  try {
    await processSourceQueueMessageForTest(
      { ...testEnv(new TestQueue()), DB: db },
      { kind: "source", databaseId: "db_1", sourcePath: "/Sources/a/a.md", sourceEtag: "etag-source", sessionNonce: "session-1" },
      {
        config: workerConfig(),
        vfs: sourceVfs({
          sourceSessionChecks,
          writtenPages,
          targetNode: {
            path: targetPath,
            kind: "file",
            content: "# Old generation\n\n- source_path: /Sources/a/a.md",
            etag: "etag-existing-target",
            metadataJson: "{}"
          }
        })
      }
    );

    assert.deepEqual(sourceSessionChecks, [
      { databaseId: "db_1", sourcePath: "/Sources/a/a.md", sourceEtag: "etag-source", sessionNonce: "session-1" }
    ]);
    assert.equal(deepSeekCalls, 1);
    assert.equal(writtenPages.length, 2);
    assert.equal(writtenPages[0]?.path, targetPath);
    assert.match(writtenPages[0]?.content ?? "", /## Summary/);
    assert.equal(writtenPages[0]?.expectedEtag, "etag-existing-target");
    assert.ok(db.runs.some((run) => run.query.includes("generated_target_etag = ?4") && run.values[3] === "etag-existing-target"));
    assert.ok(db.runs.some((run) => run.query.includes("UPDATE source_jobs") && run.query.includes("SET status = 'completed'")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("source queue applies overload backoff to DeepSeek 503 without Retry-After", async () => {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  globalThis.fetch = async (): Promise<Response> => new Response("overloaded", { status: 503, statusText: "Service Unavailable" });
  console.warn = () => {};
  try {
    const disposition = await processSourceQueueMessageForTest(
      { ...testEnv(new TestQueue()), DB: new RecordingD1() },
      { kind: "source", databaseId: "db_1", sourcePath: "/Sources/a/a.md", sourceEtag: "etag-source" },
      { config: workerConfig(), vfs: sourceVfs() },
      { leaseOwner: "retry-owner", attempts: 1 }
    );

    assert.equal(disposition.kind, "retry");
    if (disposition.kind !== "retry") throw new Error("retry disposition expected");
    assert.equal(disposition.code, "deepseek_http_503");
    assert.ok(disposition.delaySeconds >= 30 && disposition.delaySeconds <= 60);
  } finally {
    console.warn = originalWarn;
    globalThis.fetch = originalFetch;
  }
});

test("request-bound source queue records detailed schema failure without raw model output", async () => {
  const originalFetch = globalThis.fetch;
  const requestWrites: WriteNodeRequest[] = [];
  let deepSeekCalls = 0;
  globalThis.fetch = async (): Promise<Response> => {
    deepSeekCalls += 1;
    return Response.json({ choices: [{ message: { content: JSON.stringify({ title: "RAW_BAD_DRAFT_SENTINEL" }) } }] });
  };
  try {
    await processSourceQueueMessageForTest(
      testEnv(new TestQueue()),
      {
        kind: "source",
        databaseId: "db_1",
        sourcePath: "/Sources/a/a.md",
        sourceEtag: "etag-source",
        requestPath: "/Sources/source-capture-requests/1.md",
        sessionNonce: "session-1"
      },
      { config: workerConfig(), vfs: sourceVfs({ requestNode: ingestRequestNode(), requestWrites }) }
    );

    assert.equal(deepSeekCalls, 1);
    assert.equal(requestWrites.length, 1);
    assert.match(requestWrites[0]?.content ?? "", /status: "failed"/);
    assert.match(requestWrites[0]?.content ?? "", /generated knowledge page does not match schema: \/Sources\/a\/a\.md slug must be a string/);
    assert.doesNotMatch(requestWrites[0]?.content ?? "", /RAW_BAD_DRAFT_SENTINEL/);
    assert.doesNotMatch(requestWrites[0]?.metadataJson ?? "", /RAW_BAD_DRAFT_SENTINEL/);
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

test("VFS failure after DeepSeek checkpoints generation and returns retry", async () => {
  const originalFetch = globalThis.fetch;
  let deepSeekCalls = 0;
  const db = new RecordingD1();
  globalThis.fetch = async (): Promise<Response> => {
    deepSeekCalls += 1;
    return Response.json({ choices: [{ message: { content: draftJson() } }] });
  };
  try {
    const disposition = await processSourceQueueMessageForTest(
      { ...testEnv(new TestQueue()), DB: db },
      { kind: "source", databaseId: "db_1", sourcePath: "/Sources/a/a.md", sourceEtag: "etag-source" },
      { config: workerConfig(), vfs: sourceVfs({ failDraftWrite: true }) }
    );

    assert.equal(deepSeekCalls, 1);
    assert.equal(disposition.kind, "retry");
    assert.ok(db.runs.some((run) => run.query.includes("SET status = 'generated'")));
    assert.ok(db.runs.some((run) => run.query.includes("ELSE 'queued'")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("target read failure after DeepSeek resumes the saved checkpoint without another provider call", async () => {
  const originalFetch = globalThis.fetch;
  let deepSeekCalls = 0;
  const firstDb = new RecordingD1();
  globalThis.fetch = async (): Promise<Response> => {
    deepSeekCalls += 1;
    return Response.json({ choices: [{ message: { content: draftJson() } }] });
  };
  try {
    const firstDisposition = await processSourceQueueMessageForTest(
      { ...testEnv(new TestQueue()), DB: firstDb },
      { kind: "source", databaseId: "db_1", sourcePath: "/Sources/a/a.md", sourceEtag: "etag-source" },
      { config: workerConfig(), vfs: sourceVfs({ failTargetReads: 1 }) }
    );

    assert.equal(firstDisposition.kind, "retry");
    assert.equal(deepSeekCalls, 1);
    assert.ok(firstDb.runs.some((run) => run.query.includes("SET status = 'generated'") && run.query.includes("generated_target_observed = 0")));

    const resumedDb = generatedJobD1("# Project Notes\n\ncheckpointed", "/Knowledge/conversations/project-notes.md", null, false);
    const secondDisposition = await processSourceQueueMessageForTest(
      { ...testEnv(new TestQueue()), DB: resumedDb },
      { kind: "source", databaseId: "db_1", sourcePath: "/Sources/a/a.md", sourceEtag: "etag-source" },
      { config: workerConfig(), vfs: sourceVfs() },
      { leaseOwner: "retry-owner", attempts: 2 }
    );

    assert.equal(secondDisposition.kind, "ack");
    assert.equal(deepSeekCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("final VFS failure preserves the generated checkpoint for manual resume", async () => {
  const originalFetch = globalThis.fetch;
  const db = new RecordingD1();
  globalThis.fetch = async (): Promise<Response> => Response.json({ choices: [{ message: { content: draftJson() } }] });
  try {
    const disposition = await processSourceQueueMessageForTest(
      { ...testEnv(new TestQueue()), DB: db },
      { kind: "source", databaseId: "db_1", sourcePath: "/Sources/a/a.md", sourceEtag: "etag-source" },
      { config: workerConfig(), vfs: sourceVfs({ failDraftWrite: true }) },
      { leaseOwner: "final-owner", attempts: 5 }
    );

    assert.equal(disposition.kind, "dead_letter");
    assert.ok(db.runs.some((run) => run.query.includes("SET status = 'generated'")));
    assert.ok(db.runs.some((run) => run.query.includes("CASE WHEN status = 'generated' THEN 'generated'")));
    assert.equal(db.runs.some((run) => run.query.includes("SET status = 'failed'")), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("VFS identity initialization failure happens before the D1 lease claim", async () => {
  const db = new RecordingD1();
  const env = { ...testEnv(new TestQueue()), DB: db, KINIC_WIKI_WORKER_IDENTITY_PEM: "invalid-pem" };

  await assert.rejects(
    processQueueMessage(env, { kind: "source", databaseId: "db_1", sourcePath: "/Sources/a/a.md", sourceEtag: "etag-source" }),
    /PEM|identity|private key/i
  );

  assert.equal(db.runs.length, 0);
});

test("generated checkpoint retry commits without another DeepSeek call", async () => {
  const originalFetch = globalThis.fetch;
  let deepSeekCalls = 0;
  const writtenPages: WriteNodeRequest[] = [];
  const db = new StaticJobD1({
    database_id: "db_1",
    source_path: "/Sources/a/a.md",
    source_etag: "etag-source",
    status: "generated",
    target_path: null,
    attempts: 1,
    last_error: "VFS unavailable",
    lease_owner: null,
    lease_expires_at: null,
    generated_target_path: "/Knowledge/conversations/project-notes.md",
    generated_target_etag: null,
    generated_target_observed: 1,
    generated_content: "# Project Notes\n\ncheckpointed",
    generated_context_paths: "[]",
    llm_duration_ms: 100,
    updated_at: "2026-07-16T00:00:00.000Z"
  });
  globalThis.fetch = async (): Promise<Response> => {
    deepSeekCalls += 1;
    return Response.json({ choices: [{ message: { content: draftJson() } }] });
  };
  try {
    const disposition = await processSourceQueueMessageForTest(
      { ...testEnv(new TestQueue()), DB: db },
      { kind: "source", databaseId: "db_1", sourcePath: "/Sources/a/a.md", sourceEtag: "etag-source" },
      { config: workerConfig(), vfs: sourceVfs({ writtenPages }) },
      { leaseOwner: "retry-owner", attempts: 2 }
    );

    assert.equal(disposition.kind, "ack");
    assert.equal(deepSeekCalls, 0);
    assert.equal(writtenPages[0]?.path, "/Knowledge/conversations/project-notes.md");
    assert.match(writtenPages[0]?.content ?? "", /checkpointed/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("generated checkpoint retry skips an identical page already committed to VFS", async () => {
  const writtenPages: WriteNodeRequest[] = [];
  const content = "# Project Notes\n\ncheckpointed";
  const targetPath = "/Knowledge/conversations/project-notes.md";
  const db = generatedJobD1(content, targetPath);

  const disposition = await processSourceQueueMessageForTest(
    { ...testEnv(new TestQueue()), DB: db },
    { kind: "source", databaseId: "db_1", sourcePath: "/Sources/a/a.md", sourceEtag: "etag-source" },
    {
      config: workerConfig(),
      vfs: sourceVfs({
        targetNode: { path: targetPath, kind: "file", content, etag: "etag-committed", metadataJson: "{}" },
        writtenPages
      })
    },
    { leaseOwner: "retry-owner", attempts: 2 }
  );

  assert.equal(disposition.kind, "ack");
  assert.equal(writtenPages.some((write) => write.path === targetPath), false);
});

test("checkpoint without a target snapshot accepts an identical committed page", async () => {
  const writtenPages: WriteNodeRequest[] = [];
  const content = "# Project Notes\n\ncheckpointed";
  const targetPath = "/Knowledge/conversations/project-notes.md";
  const db = generatedJobD1(content, targetPath, null, false);

  const disposition = await processSourceQueueMessageForTest(
    { ...testEnv(new TestQueue()), DB: db },
    { kind: "source", databaseId: "db_1", sourcePath: "/Sources/a/a.md", sourceEtag: "etag-source" },
    {
      config: workerConfig(),
      vfs: sourceVfs({
        targetNode: { path: targetPath, kind: "file", content, etag: "etag-committed", metadataJson: "{}" },
        writtenPages
      })
    },
    { leaseOwner: "retry-owner", attempts: 2 }
  );

  assert.equal(disposition.kind, "ack");
  assert.equal(writtenPages.some((write) => write.path === targetPath), false);
});

test("checkpoint without a target snapshot refuses a different existing page", async () => {
  const writtenPages: WriteNodeRequest[] = [];
  const targetPath = "/Knowledge/conversations/project-notes.md";
  const db = generatedJobD1("# Project Notes\n\ncheckpointed", targetPath, null, false);

  const disposition = await processSourceQueueMessageForTest(
    { ...testEnv(new TestQueue()), DB: db },
    { kind: "source", databaseId: "db_1", sourcePath: "/Sources/a/a.md", sourceEtag: "etag-source" },
    {
      config: workerConfig(),
      vfs: sourceVfs({
        targetNode: {
          path: targetPath,
          kind: "file",
          content: "# Project Notes\n\nUser content",
          etag: "etag-user-content",
          metadataJson: "{}"
        },
        writtenPages
      })
    },
    { leaseOwner: "retry-owner", attempts: 2 }
  );

  assert.deepEqual(disposition, {
    kind: "dead_letter",
    code: "source_checkpoint_conflict",
    message: `checkpoint target changed before snapshot: ${targetPath}`
  });
  assert.equal(writtenPages.some((write) => write.path === targetPath), false);
});

test("generated checkpoint retry refuses to overwrite a page edited after commit", async () => {
  const writtenPages: WriteNodeRequest[] = [];
  const content = "# Project Notes\n\ncheckpointed";
  const targetPath = "/Knowledge/conversations/project-notes.md";
  const db = generatedJobD1(content, targetPath);

  const disposition = await processSourceQueueMessageForTest(
    { ...testEnv(new TestQueue()), DB: db },
    { kind: "source", databaseId: "db_1", sourcePath: "/Sources/a/a.md", sourceEtag: "etag-source" },
    {
      config: workerConfig(),
      vfs: sourceVfs({
        targetNode: {
          path: targetPath,
          kind: "file",
          content: `${content}\n\nUser edit\n\n- source_path: /Sources/a/a.md`,
          etag: "etag-user-edit",
          metadataJson: "{}"
        },
        writtenPages
      })
    },
    { leaseOwner: "retry-owner", attempts: 2 }
  );

  assert.deepEqual(disposition, {
    kind: "dead_letter",
    code: "source_checkpoint_conflict",
    message: `checkpoint target changed before commit: ${targetPath}`
  });
  assert.equal(writtenPages.some((write) => write.path === targetPath), false);
  assert.ok(db.firstRuns.some((run) => run.query.includes("ELSE 'queued'")));
});

test("generated checkpoint retry overwrites an unchanged page from the previous generation", async () => {
  const writtenPages: WriteNodeRequest[] = [];
  const content = "# Project Notes\n\nnew checkpointed content";
  const targetPath = "/Knowledge/conversations/project-notes.md";
  const db = generatedJobD1(content, targetPath, "etag-old-generation");

  const disposition = await processSourceQueueMessageForTest(
    { ...testEnv(new TestQueue()), DB: db },
    { kind: "source", databaseId: "db_1", sourcePath: "/Sources/a/a.md", sourceEtag: "etag-source" },
    {
      config: workerConfig(),
      vfs: sourceVfs({
        targetNode: {
          path: targetPath,
          kind: "file",
          content: "# Project Notes\n\nold generated content\n\n- source_path: /Sources/a/a.md",
          etag: "etag-old-generation",
          metadataJson: "{}"
        },
        writtenPages
      })
    },
    { leaseOwner: "retry-owner", attempts: 2 }
  );

  assert.equal(disposition.kind, "ack");
  const targetWrite = writtenPages.find((write) => write.path === targetPath);
  assert.equal(targetWrite?.content, content);
  assert.equal(targetWrite?.expectedEtag, "etag-old-generation");
});

test("request completion failure after D1 completion does not release or downgrade the job", async () => {
  const requestWriteAttempts: WriteNodeRequest[] = [];
  const content = "# Project Notes\n\ncheckpointed";
  const targetPath = "/Knowledge/conversations/project-notes.md";
  const db = generatedJobD1(content, targetPath);

  const disposition = await processSourceQueueMessageForTest(
    { ...testEnv(new TestQueue()), DB: db },
    {
      kind: "source",
      databaseId: "db_1",
      sourcePath: "/Sources/a/a.md",
      sourceEtag: "etag-source",
      requestPath: "/Sources/source-capture-requests/1.md"
    },
    {
      config: workerConfig(),
      vfs: sourceVfs({ requestNode: ingestRequestNode(), requestWriteAttempts, failRequestWrite: true })
    },
    { leaseOwner: "final-owner", attempts: 5 }
  );

  assert.deepEqual(disposition, {
    kind: "reschedule",
    delaySeconds: 30,
    code: "source_request_completion_transient",
    message: "request failed status write failed"
  });
  assert.ok(db.firstRuns.some((run) => run.query.includes("SET status = 'completed'")));
  assert.equal(db.firstRuns.some((run) => run.query.includes("ELSE 'queued'")), false);
  assert.equal(requestWriteAttempts.length, 1);
  assert.match(requestWriteAttempts[0]?.content ?? "", /status: "completed"/);
});

test("lost D1 completion response is confirmed before completing the request", async () => {
  const requestWrites: WriteNodeRequest[] = [];
  const content = "# Project Notes\n\ncheckpointed";
  const targetPath = "/Knowledge/conversations/project-notes.md";
  const db = new CompletionResponseLostD1(content, targetPath);

  const disposition = await processSourceQueueMessageForTest(
    { ...testEnv(new TestQueue()), DB: db },
    {
      kind: "source",
      databaseId: "db_1",
      sourcePath: "/Sources/a/a.md",
      sourceEtag: "etag-source",
      requestPath: "/Sources/source-capture-requests/1.md"
    },
    { config: workerConfig(), vfs: sourceVfs({ requestNode: ingestRequestNode(), requestWrites }) },
    { leaseOwner: "retry-owner", attempts: 2 }
  );

  assert.equal(disposition.kind, "ack");
  assert.equal(db.job.status, "completed");
  assert.equal(requestWrites.length, 1);
  assert.match(requestWrites[0]?.content ?? "", /status: "completed"/);
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
    assert.ok(db.runs.some((run) => run.query.includes("UPDATE source_jobs") && run.query.includes("SET status = 'failed'") && run.query.includes("target_path = NULL")));
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
          canisterId: "6emaw-iyaaa-aaaay-aacka-cai",
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
    lease_owner: null,
    lease_expires_at: null,
    generated_target_path: null,
    generated_target_etag: null,
    generated_target_observed: 0,
    generated_content: null,
    generated_context_paths: null,
    llm_duration_ms: null,
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
    lease_owner: null,
    lease_expires_at: null,
    generated_target_path: null,
    generated_target_etag: null,
    generated_target_observed: 0,
    generated_content: null,
    generated_context_paths: null,
    llm_duration_ms: null,
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
    listPublicDatabases: async () => [],
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
    requestWriteAttempts?: WriteNodeRequest[];
    failRequestWrite?: boolean;
    targetNode?: WikiNode;
    failTargetReads?: number;
  } = {}
): VfsClient {
  let remainingTargetReadFailures = options.failTargetReads ?? 0;
  return {
    listPublicDatabases: async (): Promise<[]> => [],
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
      if (path.startsWith("/Knowledge/conversations/") && remainingTargetReadFailures > 0) {
        remainingTargetReadFailures -= 1;
        throw new Error("target read failed after DeepSeek");
      }
      if (path === options.targetNode?.path) return options.targetNode;
      return null;
    },
    writeNode: async (request): Promise<WriteNodeAck> => {
      if (options.failDraftWrite) throw new Error("write failed after DeepSeek");
      if (request.path === options.requestNode?.path) {
        options.requestWriteAttempts?.push(request);
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
    this.runs.push({ query: this.query, values: this.values });
    if (this.query.includes("UPDATE source_jobs") && this.query.includes("ELSE 'processing'")) {
      return claimedJob(this.values) as T;
    }
    if (this.query.includes("UPDATE source_jobs") && this.query.includes("RETURNING database_id")) {
      return { database_id: this.values[0] } as T;
    }
    return null;
  }

  async run(): Promise<unknown> {
    this.runs.push({ query: this.query, values: this.values });
    return { query: this.query, values: this.values };
  }
}

class StaticJobD1 implements D1Database {
  readonly runs: { query: string; values: D1Value[] }[] = [];
  readonly firstRuns: { query: string; values: D1Value[] }[] = [];

  constructor(private readonly job: SourceJob | null) {}

  prepare(query: string): D1PreparedStatement {
    return new StaticJobD1Statement(query, this.job, this.runs, this.firstRuns);
  }
}

class StaticJobD1Statement implements D1PreparedStatement {
  private values: D1Value[] = [];

  constructor(
    private readonly query: string,
    private readonly job: SourceJob | null,
    private readonly runs: { query: string; values: D1Value[] }[],
    private readonly firstRuns: { query: string; values: D1Value[] }[]
  ) {}

  bind(...values: D1Value[]): D1PreparedStatement {
    this.values = values;
    return this;
  }

  async first<T = unknown>(): Promise<T | null> {
    this.firstRuns.push({ query: this.query, values: this.values });
    if (this.query.includes("UPDATE source_jobs") && this.query.includes("ELSE 'processing'")) {
      if (!this.job || this.job.database_id !== this.values[0] || this.job.source_path !== this.values[1] || this.job.source_etag !== this.values[2]) return null;
      if (this.job.status !== "queued" && this.job.status !== "processing" && this.job.status !== "generated") return null;
      return {
        ...this.job,
        status: this.job.status === "generated" ? "generated" : "processing",
        lease_owner: this.values[3],
        lease_expires_at: this.values[4],
        updated_at: this.values[5]
      } as T;
    }
    if (this.query.includes("UPDATE source_jobs") && this.query.includes("RETURNING database_id")) {
      return { database_id: this.values[0] } as T;
    }
    if (!this.query.includes("SELECT database_id, source_path, source_etag, status, target_path")) return null;
    if (this.job?.database_id !== this.values[0] || this.job.source_path !== this.values[1]) return null;
    return this.job as T;
  }

  async run(): Promise<unknown> {
    this.runs.push({ query: this.query, values: this.values });
    return { query: this.query, values: this.values };
  }
}

class CompletionResponseLostD1 implements D1Database {
  readonly job: SourceJob;

  constructor(content: string, targetPath: string) {
    this.job = {
      database_id: "db_1",
      source_path: "/Sources/a/a.md",
      source_etag: "etag-source",
      status: "generated",
      target_path: null,
      attempts: 1,
      last_error: null,
      lease_owner: null,
      lease_expires_at: null,
      generated_target_path: targetPath,
      generated_target_etag: null,
      generated_target_observed: 1,
      generated_content: content,
      generated_context_paths: "[]",
      llm_duration_ms: 100,
      updated_at: "2026-07-16T00:00:00.000Z"
    };
  }

  prepare(query: string): D1PreparedStatement {
    return new CompletionResponseLostD1Statement(query, this.job);
  }
}

class CompletionResponseLostD1Statement implements D1PreparedStatement {
  private values: D1Value[] = [];

  constructor(private readonly query: string, private readonly job: SourceJob) {}

  bind(...values: D1Value[]): D1PreparedStatement {
    this.values = values;
    return this;
  }

  async first<T = unknown>(): Promise<T | null> {
    if (this.query.includes("ELSE 'processing'")) {
      this.job.lease_owner = String(this.values[3]);
      this.job.lease_expires_at = String(this.values[4]);
      this.job.attempts += 1;
      return this.job as T;
    }
    if (this.query.includes("SET status = 'completed'")) {
      this.job.status = "completed";
      this.job.target_path = String(this.values[3]);
      this.job.lease_owner = null;
      this.job.lease_expires_at = null;
      throw new Error("D1 completion response was lost");
    }
    if (this.query.startsWith("SELECT database_id")) return this.job as T;
    return null;
  }

  async run(): Promise<unknown> {
    return {};
  }
}

function generatedJobD1(
  content: string,
  targetPath: string,
  expectedTargetEtag: string | null = null,
  targetObserved = true
): StaticJobD1 {
  return new StaticJobD1({
    database_id: "db_1",
    source_path: "/Sources/a/a.md",
    source_etag: "etag-source",
    status: "generated",
    target_path: null,
    attempts: 1,
    last_error: "commit incomplete",
    lease_owner: null,
    lease_expires_at: null,
    generated_target_path: targetPath,
    generated_target_etag: expectedTargetEtag,
    generated_target_observed: targetObserved ? 1 : 0,
    generated_content: content,
    generated_context_paths: "[]",
    llm_duration_ms: 100,
    updated_at: "2026-07-16T00:00:00.000Z"
  });
}

function claimedJob(values: D1Value[]): SourceJob {
  return {
    database_id: String(values[0]),
    source_path: String(values[1]),
    source_etag: String(values[2]),
    status: "processing",
    target_path: null,
    attempts: 1,
    last_error: null,
    lease_owner: String(values[3]),
    lease_expires_at: String(values[4]),
    generated_target_path: null,
    generated_target_etag: null,
    generated_target_observed: 0,
    generated_content: null,
    generated_context_paths: null,
    llm_duration_ms: null,
    updated_at: String(values[5])
  };
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
