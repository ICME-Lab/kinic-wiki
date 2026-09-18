// Where: workers/wiki-generator/tests/nns-index.test.ts
// What: Dedicated NNS Worker HTTP, Queue concurrency, retry, and sanitized DLQ tests.
// Why: Runtime separation must preserve delivery semantics after state moved to the Wiki.
import assert from "node:assert/strict";
import test from "node:test";
import worker, { parseNnsQueueMessage, processNnsQueueBatchForTest } from "../src/nns-index.js";
import type { NnsProposalReviewFailureMessage, NnsProposalReviewQueueMessage } from "../src/types.js";
import { nnsTestEnv } from "./nns-fixtures.js";
import { TestQueue } from "./source-capture-fixtures.js";

test("private NNS HTTP entrypoint exposes health and disabled status", async () => {
  const env = { ...nnsTestEnv(), KINIC_NNS_AUDIT_DATABASE_ID: undefined };
  const health = await fetchWorker(new Request("https://nns-proposal-review.internal/healthz"), env);
  const status = await fetchWorker(new Request("https://nns-proposal-review.internal/status"), env);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });
  assert.deepEqual(await status.json(), { enabled: false });
});

test("private NNS run endpoint validates its body", async () => {
  const response = await fetchWorker(
    new Request("https://nns-proposal-review.internal/run", { method: "POST", body: JSON.stringify({ retryFailed: "yes" }) }),
    nnsTestEnv()
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "retryFailed must be a boolean" });
});

test("scheduled entrypoint delegates to the disabled daily poll", async () => {
  const promises: Promise<unknown>[] = [];
  if (!worker.scheduled) throw new Error("scheduled handler is required");
  await worker.scheduled(
    { scheduledTime: 0, cron: "0 0 * * *", noRetry() {} },
    { ...nnsTestEnv(), KINIC_NNS_AUDIT_DATABASE_ID: undefined },
    { waitUntil(promise) { promises.push(promise); } }
  );
  assert.equal(promises.length, 1);
  await Promise.all(promises);
});

test("dedicated NNS Queue overlaps a configured delivery batch", async () => {
  const messages = Array.from({ length: 4 }, (_, index) => recordingMessage(proposalMessage(index + 1), `nns-${index}`));
  let active = 0;
  let maxActive = 0;
  let release: (() => void) | undefined;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  await processNnsQueueBatchForTest(nnsTestEnv(), messages, async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    if (active === messages.length) release?.();
    await barrier;
    active -= 1;
    return { kind: "ack" };
  });
  assert.equal(maxActive, 4);
  assert.deepEqual(messages.map((message) => [message.acks, message.retries]), [[1, 0], [1, 0], [1, 0], [1, 0]]);
});

test("active workflow reschedules through only the dedicated Queue", async () => {
  const queue = new TestQueue<NnsProposalReviewQueueMessage>();
  const body = proposalMessage(42);
  const message = recordingMessage(body, "nns-busy", 3);
  await processNnsQueueBatchForTest(nnsTestEnv(queue), [message], async () => ({
    kind: "reschedule", delaySeconds: 90, code: "nns_job_busy", message: "workflow is leased"
  }));
  assert.deepEqual(queue.messages, [body]);
  assert.deepEqual(queue.sendOptions, [{ delaySeconds: 90 }]);
  assert.equal(message.acks, 1);
});

test("NNS DLQ diagnostics contain only identity and error code", async () => {
  const dlq = new TestQueue<NnsProposalReviewFailureMessage>();
  const message = recordingMessage(proposalMessage(123), "nns-final", 5);
  await processNnsQueueBatchForTest(nnsTestEnv(new TestQueue(), dlq), [message], async () => ({
    kind: "dead_letter", code: "nns_review_invalid", message: "provider body that must not be copied"
  }));
  assert.equal(message.acks, 1);
  assert.equal(dlq.messages[0]?.errorCode, "nns_review_invalid");
  assert.doesNotMatch(JSON.stringify(dlq.messages[0]), /provider body/);
});

test("queue message parser accepts only the NNS review contract", () => {
  assert.deepEqual(parseNnsQueueMessage(proposalMessage(7)), proposalMessage(7));
  assert.equal(parseNnsQueueMessage({ kind: "nns_proposal_review", databaseId: "", proposalId: 7 }), null);
  assert.equal(parseNnsQueueMessage({ kind: "wiki_generation", databaseId: "nns-db", proposalId: 7 }), null);
});

async function fetchWorker(request: Request, env: ReturnType<typeof nnsTestEnv>): Promise<Response> {
  if (!worker.fetch) throw new Error("fetch handler is required");
  return worker.fetch(request, env, { waitUntil() {} });
}

function proposalMessage(proposalId: number): NnsProposalReviewQueueMessage {
  return { kind: "nns_proposal_review", databaseId: "nns-db", proposalId, reason: "discovery" };
}

function recordingMessage(body: unknown, id: string, attempts = 1): Message<unknown> & { acks: number; retries: number } {
  const state = {
    id,
    timestamp: new Date("2026-08-20T00:00:00.000Z"),
    body,
    attempts,
    acks: 0,
    retries: 0,
    ack() { state.acks += 1; },
    retry() { state.retries += 1; }
  };
  return state;
}
