// Where: workers/wiki-generator/tests/index.test.ts
// What: Entrypoint authorization and handler-shape tests.
// Why: Public triggers must stay bearer-protected and processing must remain Queue-driven.
import assert from "node:assert/strict";
import test from "node:test";
import worker, { processQueueBatchForTest } from "../src/index.js";
import { parseQueueMessageEnvelope, processQueueMessage } from "../src/processing.js";
import { testEnv, TestFetcher, TestQueue } from "./source-capture-fixtures.js";
import type { QueueMessage, SourceQueueMessage, WikiGenerationFailureMessage } from "../src/types.js";

Object.defineProperty(crypto.subtle, "timingSafeEqual", {
  configurable: true,
  value(left: Uint8Array, right: Uint8Array): boolean {
    if (left.length !== right.length) return false;
    return left.every((value, index) => value === right[index]);
  }
});

test("health check starts without authentication or external bindings", async () => {
  const response = await fetchWorker(new Request("https://wiki-generator.kinic.xyz/healthz"), testEnv(new TestQueue()));

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/json");
  assert.deepEqual(await response.json(), { ok: true });
});

test("NNS audit operations require authentication and proxy through the private service binding", async () => {
  const service = new TestFetcher();
  const env = { ...testEnv(new TestQueue()), NNS_PROPOSAL_REVIEW_SERVICE: service };
  const unauthorized = await fetchWorker(new Request("https://wiki-generator.kinic.xyz/nns-audit/status"), env);
  assert.equal(unauthorized.status, 401);

  const status = await fetchWorker(
    new Request("https://wiki-generator.kinic.xyz/nns-audit/status", { headers: { authorization: "Bearer worker-token" } }),
    env
  );
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), { enabled: false });

  const run = await fetchWorker(
    new Request("https://wiki-generator.kinic.xyz/nns-audit/run", { method: "POST", headers: { authorization: "Bearer worker-token" } }),
    env
  );
  assert.equal(run.status, 200);
  assert.deepEqual(await run.json(), { enabled: false, initialized: false, discovered: 0, enqueued: 0, resetFailed: 0 });
  assert.deepEqual(
    service.requests.map((request) => [request.method, new URL(request.url).pathname]),
    [["GET", "/status"], ["POST", "/run"]]
  );
  assert.deepEqual(await service.requests[1]?.json(), { retryFailed: false });
});

test("NNS audit run validates input before forwarding", async () => {
  const service = new TestFetcher();
  const env = { ...testEnv(new TestQueue()), NNS_PROPOSAL_REVIEW_SERVICE: service };
  const response = await fetchWorker(
    new Request("https://wiki-generator.kinic.xyz/nns-audit/run", {
      method: "POST",
      headers: { authorization: "Bearer worker-token", "content-type": "application/json" },
      body: JSON.stringify({ retryFailed: "yes" })
    }),
    env
  );

  assert.equal(response.status, 400);
  assert.equal(service.requests.length, 0);
});

test("NNS service binding failures use the public JSON error contract", async () => {
  const service = new TestFetcher();
  service.fail = true;
  const response = await fetchWorker(
    new Request("https://wiki-generator.kinic.xyz/nns-audit/status", { headers: { authorization: "Bearer worker-token" } }),
    { ...testEnv(new TestQueue()), NNS_PROPOSAL_REVIEW_SERVICE: service }
  );

  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "NNS review service unavailable" });
});

test("NNS service responses preserve status and JSON body", async () => {
  const service = new TestFetcher(() => Response.json({ error: "conflict" }, { status: 409 }));
  const response = await fetchWorker(
    new Request("https://wiki-generator.kinic.xyz/nns-audit/status", { headers: { authorization: "Bearer worker-token" } }),
    { ...testEnv(new TestQueue()), NNS_PROPOSAL_REVIEW_SERVICE: service }
  );

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "conflict" });
});

test("general Queue rejects NNS proposal review messages", () => {
  assert.deepEqual(parseQueueMessageEnvelope({ kind: "nns_proposal_review", databaseId: "nns-db", proposalId: 1 }), {
    kind: "invalid",
    reason: "queue message shape is invalid"
  });
});

test("source capture trigger requires worker token config", async () => {
  const response = await fetchWorker(sourceCaptureRequest(), { ...testEnv(new TestQueue()), KINIC_WIKI_WORKER_TOKEN: "" });

  assert.equal(response.status, 503);
  assert.match(await response.text(), /KINIC_WIKI_WORKER_TOKEN is required/);
});

test("source capture trigger rejects missing bearer token", async () => {
  const queue = new TestQueue();
  const response = await fetchWorker(sourceCaptureRequest(), testEnv(queue));

  assert.equal(response.status, 401);
  assert.match(await response.text(), /unauthorized/);
  assert.equal(queue.messages.length, 0);
});

test("source capture trigger enqueues source capture message without background work", async () => {
  const context = recordingCtx();
  const queue = new TestQueue();
  const response = await fetchWorker(authorizedSourceCaptureRequest(), testEnv(queue), context);

  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), {
    accepted: true,
    databaseId: "db_1",
    requestPath: "/Sources/source-capture-requests/1.md"
  });
  assert.equal(context.waitUntilCount, 0);
  assert.deepEqual(queue.messages, [
    {
      kind: "source_capture",
      canisterId: "6emaw-iyaaa-aaaay-aacka-cai",
      databaseId: "db_1",
      requestPath: "/Sources/source-capture-requests/1.md",
      sessionNonce: "session-1"
    }
  ]);
});

test("source capture trigger rejects invalid request path before background work", async () => {
  const context = recordingCtx();
  const queue = new TestQueue();
  const response = await fetchWorker(authorizedSourceCaptureRequest({ requestPath: "/Sources/1.md" }), testEnv(queue), context);

  assert.equal(response.status, 400);
  assert.match(await response.text(), /invalid source capture request path/);
  assert.equal(context.waitUntilCount, 0);
  assert.equal(queue.messages.length, 0);
});

test("source capture trigger rejects missing canister config before background work", async () => {
  const context = recordingCtx();
  const queue = new TestQueue();
  const response = await fetchWorker(authorizedSourceCaptureRequest(), { ...testEnv(queue), KINIC_WIKI_CANISTER_ID: "" }, context);

  assert.equal(response.status, 500);
  assert.match(await response.text(), /KINIC_WIKI_CANISTER_ID is required/);
  assert.equal(context.waitUntilCount, 0);
  assert.equal(queue.messages.length, 0);
});

test("source capture trigger rejects canister mismatches before background work", async () => {
  const context = recordingCtx();
  const queue = new TestQueue();
  const response = await fetchWorker(authorizedSourceCaptureRequest({ canisterId: "aaaaa-aa" }), testEnv(queue), context);

  assert.equal(response.status, 400);
  assert.match(await response.text(), /canisterId does not match worker canister config/);
  assert.equal(context.waitUntilCount, 0);
  assert.equal(queue.messages.length, 0);
});

test("queue source capture message propagates config failures", async () => {
  await assert.rejects(
    processQueueMessage(testEnv(new TestQueue()), {
      kind: "source_capture",
      canisterId: "aaaaa-aa",
      databaseId: "db_1",
      requestPath: "/Sources/source-capture-requests/1.md",
      sessionNonce: "session-1"
    }),
    /canisterId does not match worker canister config/
  );
});

test("queue entrypoint applies retry disposition without acknowledging", async () => {
  const message = recordingMessage({ ...sourceMessage(0), sourcePath: "/Outside/0.md" }, "entrypoint-retry");
  if (!worker.queue) throw new Error("queue handler is required");

  await worker.queue({ messages: [message] }, testEnv(new TestQueue()));

  assert.equal(message.acks, 0);
  assert.equal(message.retries, 1);
});

test("queue batch overlaps four source jobs and acknowledges each once", async () => {
  const messages = Array.from({ length: 4 }, (_, index) => recordingMessage(sourceMessage(index), `source-${index}`));
  let active = 0;
  let maxActive = 0;
  const executions = new Map<string, number>();
  let release: (() => void) | undefined;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });

  await processQueueBatchForTest(testEnv(new TestQueue()), messages, async (_envelope, execution) => {
    executions.set(execution.leaseOwner, execution.attempts);
    active += 1;
    maxActive = Math.max(maxActive, active);
    if (active === 4) release?.();
    await barrier;
    active -= 1;
    return { kind: "ack" };
  });

  assert.equal(maxActive, 4);
  assert.deepEqual(messages.map((message) => [message.acks, message.retries]), [[1, 0], [1, 0], [1, 0], [1, 0]]);
  assert.deepEqual([...executions.entries()].sort(), messages.map((message) => [message.id, message.attempts]).sort());
});

test("queue batch keeps operational jobs sequential", async () => {
  const messages = [
    recordingMessage({ kind: "source_capture", canisterId: "6emaw-iyaaa-aaaay-aacka-cai", databaseId: "db_1", requestPath: "/Sources/source-capture-requests/1.md", sessionNonce: "nonce" }, "capture"),
    recordingMessage({ kind: "link_preview", canisterId: "6emaw-iyaaa-aaaay-aacka-cai", databaseId: "db_1", requestedAt: "2026-07-16T00:00:00.000Z" }, "preview")
  ];
  let active = 0;
  let maxActive = 0;

  await processQueueBatchForTest(testEnv(new TestQueue()), messages, async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await Promise.resolve();
    active -= 1;
    return { kind: "ack" };
  });

  assert.equal(maxActive, 1);
  assert.deepEqual(messages.map((message) => message.acks), [1, 1]);
});

test("active lease reschedules the source before acknowledging the original", async () => {
  const mainQueue = new TestQueue();
  const failureQueue = new TestQueue<WikiGenerationFailureMessage>();
  const env = { ...testEnv(mainQueue), WIKI_GENERATION_DLQ: failureQueue };
  const body = { ...sourceMessage(3), sessionNonce: "same-primary-queue-only" };
  const message = recordingMessage(body, "source-busy", 5);

  await processQueueBatchForTest(env, [message], async () => ({
    kind: "reschedule",
    delaySeconds: 241,
    code: "source_job_busy",
    message: "source generation is already leased"
  }));

  assert.deepEqual(mainQueue.messages, [body]);
  assert.deepEqual(mainQueue.sendOptions, [{ delaySeconds: 241 }]);
  assert.equal(message.acks, 1);
  assert.equal(message.retries, 0);
  assert.equal(failureQueue.messages.length, 0);
});

test("active lease reschedule failure retries without acknowledging", async () => {
  const mainQueue = new TestQueue();
  mainQueue.failSend = true;
  const message = recordingMessage(sourceMessage(4), "source-busy-send-failed", 5);

  await processQueueBatchForTest(testEnv(mainQueue), [message], async () => ({
    kind: "reschedule",
    delaySeconds: 120,
    code: "source_job_busy",
    message: "source generation is already leased"
  }));

  assert.equal(message.acks, 0);
  assert.equal(message.retries, 1);
  assert.deepEqual(message.retryOptions, [{ delaySeconds: 120 }]);
});

test("fifth failed attempt sends only sanitized failure data then acknowledges", async () => {
  const mainQueue = new TestQueue();
  const failureQueue = new TestQueue<WikiGenerationFailureMessage>();
  const env = { ...testEnv(mainQueue), WIKI_GENERATION_DLQ: failureQueue };
  const message = recordingMessage({ ...sourceMessage(1), sessionNonce: "secret-nonce" }, "source-final", 5);

  await processQueueBatchForTest(env, [message], async () => ({ kind: "retry", delaySeconds: 30, code: "deepseek_http_429", message: "provider payload" }));

  assert.equal(message.acks, 1);
  assert.equal(message.retries, 0);
  assert.equal(failureQueue.messages.length, 1);
  assert.deepEqual(failureQueue.messages[0], {
    messageId: "source-final",
    messageKind: "source",
    databaseId: "db_1",
    sourcePath: "/Sources/a/1.md",
    sourceEtag: "etag-1",
    attempt: 5,
    errorCode: "deepseek_http_429",
    failedAt: failureQueue.messages[0]?.failedAt
  });
  assert.doesNotMatch(JSON.stringify(failureQueue.messages[0]), /secret-nonce|provider payload/);
});

test("failure Queue outage retries the original message without acknowledging", async () => {
  const failureQueue = new TestQueue<WikiGenerationFailureMessage>();
  failureQueue.failSend = true;
  const env = { ...testEnv(new TestQueue()), WIKI_GENERATION_DLQ: failureQueue };
  const message = recordingMessage(sourceMessage(2), "source-dlq-outage", 5);

  await processQueueBatchForTest(env, [message], async () => ({ kind: "dead_letter", code: "source_commit_transient", message: "VFS unavailable" }));

  assert.equal(message.acks, 0);
  assert.equal(message.retries, 1);
  assert.equal(failureQueue.messages.length, 0);
});

function authorizedSourceCaptureRequest(body: Record<string, string> = {}): Request {
  return sourceCaptureRequest({ authorization: "Bearer worker-token" }, body);
}

function sourceCaptureRequest(headers: Record<string, string> = {}, body: Record<string, string> = {}): Request {
  return new Request("https://wiki-generator.kinic.xyz/source-capture", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({
      canisterId: "6emaw-iyaaa-aaaay-aacka-cai",
      databaseId: "db_1",
      requestPath: "/Sources/source-capture-requests/1.md",
      sessionNonce: "session-1",
      ...body
    })
  });
}

function fetchWorker(request: Request, env: ReturnType<typeof testEnv>, executionContext: ExecutionContext = ctx()): Promise<Response> {
  if (!worker.fetch) throw new Error("fetch handler is required");
  return Promise.resolve(worker.fetch(request, env, executionContext));
}

function ctx(): ExecutionContext {
  return {
    waitUntil(_promise: Promise<unknown>) {}
  };
}

function recordingCtx(): ExecutionContext & { waitUntilCount: number } {
  return {
    waitUntilCount: 0,
    waitUntil(_promise: Promise<unknown>) {
      this.waitUntilCount += 1;
    }
  };
}

function sourceMessage(index: number): SourceQueueMessage {
  return { kind: "source", databaseId: "db_1", sourcePath: `/Sources/a/${index}.md`, sourceEtag: `etag-${index}` };
}

function recordingMessage(
  body: QueueMessage,
  id: string,
  attempts = 1
): Message<QueueMessage> & { acks: number; retries: number; retryOptions: ({ delaySeconds?: number } | undefined)[] } {
  return {
    id,
    attempts,
    body,
    acks: 0,
    retries: 0,
    retryOptions: [],
    ack() {
      this.acks += 1;
    },
    retry(options) {
      this.retries += 1;
      this.retryOptions.push(options);
    }
  };
}
