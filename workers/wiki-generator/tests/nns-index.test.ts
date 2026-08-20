// Where: workers/wiki-generator/tests/nns-index.test.ts
// What: Dedicated NNS Worker HTTP, Queue concurrency, retry, and sanitized DLQ tests.
// Why: Runtime separation must preserve NNS delivery semantics without the general generation Queue.
import assert from "node:assert/strict";
import test from "node:test";
import worker, { parseNnsQueueMessage, processNnsQueueBatchForTest } from "../src/nns-index.js";
import { claimNnsJob, initializeNnsCursor, loadNnsJob, markNnsJobQueued, persistDiscoveredProposals } from "../src/nns-jobs.js";
import type { NnsProposalReviewFailureMessage, NnsProposalReviewQueueMessage } from "../src/types.js";
import { nnsTestEnv, SqliteD1 } from "./nns-fixtures.js";
import { TestQueue } from "./source-capture-fixtures.js";

test("private NNS HTTP entrypoint exposes health and disabled status", async () => {
  const db = new SqliteD1();
  try {
    const env = { ...nnsTestEnv(db), KINIC_NNS_AUDIT_DATABASE_ID: undefined };
    const health = await fetchWorker(new Request("https://nns-proposal-review.internal/healthz"), env);
    const status = await fetchWorker(new Request("https://nns-proposal-review.internal/status"), env);

    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });
    assert.equal(status.status, 200);
    assert.deepEqual(await status.json(), { enabled: false });
  } finally {
    db.close();
  }
});

test("private NNS run endpoint validates its body", async () => {
  const db = new SqliteD1();
  try {
    const response = await fetchWorker(
      new Request("https://nns-proposal-review.internal/run", { method: "POST", body: JSON.stringify({ retryFailed: "yes" }) }),
      nnsTestEnv(db)
    );

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "retryFailed must be a boolean" });
  } finally {
    db.close();
  }
});

test("scheduled entrypoint delegates to the disabled NNS poll without external work", async () => {
  const db = new SqliteD1();
  const promises: Promise<unknown>[] = [];
  try {
    if (!worker.scheduled) throw new Error("scheduled handler is required");
    await worker.scheduled(
      { scheduledTime: 0, cron: "*/15 * * * *", noRetry() {} },
      { ...nnsTestEnv(db), KINIC_NNS_AUDIT_DATABASE_ID: undefined },
      { waitUntil(promise) { promises.push(promise); } }
    );

    assert.equal(promises.length, 1);
    await Promise.all(promises);
  } finally {
    db.close();
  }
});

test("dedicated NNS Queue overlaps a configured delivery batch", async () => {
  const db = new SqliteD1();
  const messages = Array.from({ length: 4 }, (_, index) => recordingMessage(proposalMessage(index + 1), `nns-${index}`));
  let active = 0;
  let maxActive = 0;
  let release: (() => void) | undefined;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await processNnsQueueBatchForTest(nnsTestEnv(db), messages, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (active === messages.length) release?.();
      await barrier;
      active -= 1;
      return { kind: "ack" };
    });

    assert.equal(maxActive, 4);
    assert.deepEqual(messages.map((message) => [message.acks, message.retries]), [[1, 0], [1, 0], [1, 0], [1, 0]]);
  } finally {
    db.close();
  }
});

test("active NNS lease reschedules through only the dedicated Queue", async () => {
  const db = new SqliteD1();
  const queue = new TestQueue<NnsProposalReviewQueueMessage>();
  const body = proposalMessage(42);
  const message = recordingMessage(body, "nns-busy", 3);
  try {
    await processNnsQueueBatchForTest(nnsTestEnv(db, queue), [message], async () => ({
      kind: "reschedule",
      delaySeconds: 90,
      code: "nns_job_busy",
      message: "job is leased"
    }));

    assert.deepEqual(queue.messages, [body]);
    assert.deepEqual(queue.sendOptions, [{ delaySeconds: 90 }]);
    assert.equal(message.acks, 1);
    assert.equal(message.retries, 0);
  } finally {
    db.close();
  }
});

test("disabled NNS processing reschedules a valid delivery", async () => {
  const db = new SqliteD1();
  const queue = new TestQueue<NnsProposalReviewQueueMessage>();
  const message = recordingMessage(proposalMessage(43), "nns-disabled");
  try {
    await processNnsQueueBatchForTest({ ...nnsTestEnv(db, queue), KINIC_NNS_AUDIT_DATABASE_ID: undefined }, [message]);

    assert.deepEqual(queue.messages, [proposalMessage(43)]);
    assert.deepEqual(queue.sendOptions, [{ delaySeconds: 300 }]);
    assert.equal(message.acks, 1);
    assert.equal(message.retries, 0);
  } finally {
    db.close();
  }
});

test("a final unhandled delivery records failure before dead-letter acknowledgement", async () => {
  const db = new SqliteD1();
  const dlq = new TestQueue<NnsProposalReviewFailureMessage>();
  const message = recordingMessage(proposalMessage(44), "nns-terminal", 5);
  try {
    const cursor = await initializeNnsCursor(db, "nns-db", 43);
    await persistDiscoveredProposals(db, cursor, [44], 44);
    await markNnsJobQueued(db, "nns-db", 44);
    await db.prepare("UPDATE nns_proposal_jobs SET captured_input = ?3 WHERE database_id = ?1 AND proposal_id = ?2").bind("nns-db", 44, "checkpoint").run();

    await processNnsQueueBatchForTest(nnsTestEnv(db, new TestQueue(), dlq), [message], async () => {
      throw new Error("identity initialization failed");
    });

    const job = await loadNnsJob(db, "nns-db", 44);
    assert.equal(job?.status, "failed");
    assert.equal(job?.captured_input, "checkpoint");
    assert.equal(message.acks, 1);
    assert.equal(dlq.messages[0]?.errorCode, "nns_queue_handler_unhandled");
  } finally {
    db.close();
  }
});

test("a final unhandled delivery does not overwrite another active lease", async () => {
  const db = new SqliteD1();
  const queue = new TestQueue<NnsProposalReviewQueueMessage>();
  const message = recordingMessage(proposalMessage(45), "nns-competing", 5);
  try {
    const cursor = await initializeNnsCursor(db, "nns-db", 44);
    await persistDiscoveredProposals(db, cursor, [45], 45);
    await markNnsJobQueued(db, "nns-db", 45);
    assert.equal((await claimNnsJob(db, proposalMessage(45), "active-owner")).kind, "generate");

    await processNnsQueueBatchForTest(nnsTestEnv(db, queue), [message], async () => {
      throw new Error("unexpected handler failure");
    });

    const job = await loadNnsJob(db, "nns-db", 45);
    assert.equal(job?.status, "processing");
    assert.equal(job?.lease_owner, "active-owner");
    assert.deepEqual(queue.messages, [proposalMessage(45)]);
    assert.equal(message.acks, 1);
  } finally {
    db.close();
  }
});

test("a final unhandled delivery reschedules when terminal D1 state cannot be recorded", async () => {
  const queue = new TestQueue<NnsProposalReviewQueueMessage>();
  const message = recordingMessage(proposalMessage(46), "nns-d1-outage", 5);
  const failingDb = {
    prepare(): D1PreparedStatement {
      throw new Error("D1 unavailable");
    }
  } as D1Database;

  await processNnsQueueBatchForTest(nnsTestEnv(failingDb, queue), [message], async () => {
    throw new Error("unexpected handler failure");
  });

  assert.deepEqual(queue.messages, [proposalMessage(46)]);
  assert.equal(message.acks, 1);
  assert.equal(message.retries, 0);
});

test("NNS DLQ diagnostics contain only proposal identity and error code", async () => {
  const db = new SqliteD1();
  const dlq = new TestQueue<NnsProposalReviewFailureMessage>();
  const message = recordingMessage(proposalMessage(123), "nns-final", 5);
  try {
    await processNnsQueueBatchForTest(nnsTestEnv(db, new TestQueue(), dlq), [message], async () => ({
      kind: "dead_letter",
      code: "nns_review_invalid",
      message: "provider body that must not be copied"
    }));

    assert.equal(message.acks, 1);
    assert.deepEqual(dlq.messages[0], {
      messageId: "nns-final",
      messageKind: "nns_proposal_review",
      databaseId: "nns-db",
      proposalId: 123,
      attempt: 5,
      errorCode: "nns_review_invalid",
      failedAt: dlq.messages[0]?.failedAt
    });
    assert.doesNotMatch(JSON.stringify(dlq.messages[0]), /provider body/);
  } finally {
    db.close();
  }
});

test("invalid NNS Queue messages are sanitized before dead-lettering", async () => {
  const db = new SqliteD1();
  const dlq = new TestQueue<NnsProposalReviewFailureMessage>();
  const message = recordingMessage({ kind: "nns_proposal_review", databaseId: "", proposalId: 0, secret: "do-not-copy" }, "nns-invalid");
  try {
    assert.equal(parseNnsQueueMessage(message.body), null);
    await processNnsQueueBatchForTest(nnsTestEnv(db, new TestQueue(), dlq), [message]);

    assert.equal(message.acks, 1);
    assert.equal(dlq.messages[0]?.messageKind, "invalid");
    assert.equal(dlq.messages[0]?.errorCode, "nns_queue_message_invalid");
    assert.doesNotMatch(JSON.stringify(dlq.messages[0]), /do-not-copy/);
  } finally {
    db.close();
  }
});

function fetchWorker(request: Request, env: ReturnType<typeof nnsTestEnv>): Promise<Response> {
  if (!worker.fetch) throw new Error("fetch handler is required");
  return Promise.resolve(worker.fetch(request, env, { waitUntil() {} }));
}

function proposalMessage(proposalId: number): NnsProposalReviewQueueMessage {
  return { kind: "nns_proposal_review", databaseId: "nns-db", proposalId };
}

function recordingMessage(
  body: unknown,
  id: string,
  attempts = 1
): Message<unknown> & { acks: number; retries: number; retryOptions: ({ delaySeconds?: number } | undefined)[] } {
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
