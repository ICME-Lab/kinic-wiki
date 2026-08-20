// Where: workers/wiki-generator/tests/nns-audit.test.ts
// What: NNS discovery, durable enqueue, checkpoint resume, and publication integration tests.
// Why: No-backfill and no-double-billing behavior depend on state transitions across D1, Queue, AI, and VFS.
import assert from "node:assert/strict";
import test from "node:test";
import {
  claimNnsJob,
  completeNnsJob,
  markNnsJobQueued,
  initializeNnsCursor,
  listEnqueueableNnsProposalIds,
  loadNnsCursor,
  loadNnsJob,
  persistDiscoveredProposals
} from "../src/nns-jobs.js";
import { processNnsQueueMessageForTest, runNnsAuditPoll } from "../src/nns-audit.js";
import { TestQueue, workerConfig } from "./source-capture-fixtures.js";
import { nnsTestEnv, NnsTestVfs, SqliteD1 } from "./nns-fixtures.js";
import type { NnsProposalReviewQueueMessage } from "../src/types.js";

test("first poll stores the latest proposal id without backfilling", async () => {
  const db = new SqliteD1();
  const queue = new TestQueue<NnsProposalReviewQueueMessage>();
  const calls: string[] = [];
  try {
    const result = await runNnsAuditPoll(auditEnv(db, queue), {}, {
      fetchJson: async (url) => {
        calls.push(url);
        return { latest_proposal_id: 500 };
      },
      now: () => new Date("2026-08-20T00:00:00.000Z")
    });

    assert.deepEqual(result, {
      enabled: true,
      initialized: true,
      initialProposalId: 500,
      discovered: 0,
      enqueued: 0,
      resetFailed: 0
    });
    assert.deepEqual(calls, ["https://ic-api.internetcomputer.org/api/v3/latest-proposal-id"]);
    assert.equal(queue.messages.length, 0);
  } finally {
    db.close();
  }
});

test("discovery paginates by offset and filters proposal ids internally", async () => {
  const db = new SqliteD1();
  const queue = new TestQueue<NnsProposalReviewQueueMessage>();
  const urls: string[] = [];
  try {
    await runNnsAuditPoll(auditEnv(db, queue), {}, { fetchJson: async () => ({ latest_proposal_id: 100 }) });
    const result = await runNnsAuditPoll(auditEnv(db, queue), {}, {
      fetchJson: async (url) => {
        urls.push(url);
        if (url.endsWith("offset=0")) {
          return { data: Array.from({ length: 100 }, (_, index) => ({ proposal_id: 202 - index, action: index % 2 ? "Motion" : "Other" })) };
        }
        return { data: [{ proposal_id: 102 }, { proposal_id: 101 }, { proposal_id: 100 }] };
      }
    });

    assert.equal(result.discovered, 102);
    assert.equal(result.enqueued, 102);
    assert.deepEqual(urls, [
      "https://ic-api.internetcomputer.org/api/v3/proposals?limit=100&offset=0",
      "https://ic-api.internetcomputer.org/api/v3/proposals?limit=100&offset=100"
    ]);
    assert.equal(queue.messages[0]?.kind, "nns_proposal_review");
    assert.equal(queue.messages.at(-1)?.kind, "nns_proposal_review");
  } finally {
    db.close();
  }
});

test("a Queue send failure leaves the discovered job durable for the next poll", async () => {
  const db = new SqliteD1();
  const queue = new TestQueue<NnsProposalReviewQueueMessage>();
  const env = auditEnv(db, queue);
  const listResponse = async (url: string): Promise<unknown> =>
    url.endsWith("latest-proposal-id") ? { latest_proposal_id: 100 } : { data: [{ proposal_id: 101 }, { proposal_id: 100 }] };
  try {
    await runNnsAuditPoll(env, {}, { fetchJson: listResponse });
    queue.failSend = true;
    await assert.rejects(runNnsAuditPoll(env, {}, { fetchJson: listResponse }), /queue unavailable/);
    assert.equal((await loadNnsJob(db, "nns-db", 101))?.status, "discovered");

    queue.failSend = false;
    const result = await runNnsAuditPoll(env, {}, { fetchJson: listResponse });
    assert.equal(result.enqueued, 1);
    assert.equal((await loadNnsJob(db, "nns-db", 101))?.status, "queued");
  } finally {
    db.close();
  }
});

test("an unordered API page is rejected before advancing the discovery watermark", async () => {
  const db = new SqliteD1();
  const queue = new TestQueue<NnsProposalReviewQueueMessage>();
  const env = auditEnv(db, queue);
  try {
    await runNnsAuditPoll(env, {}, { fetchJson: async () => ({ latest_proposal_id: 100 }) });
    await assert.rejects(
      runNnsAuditPoll(env, {}, { fetchJson: async () => ({ data: [{ proposal_id: 101 }, { proposal_id: 102 }] }) }),
      /not ordered newest first/
    );
    assert.equal((await loadNnsCursor(db, "nns-db"))?.latest_proposal_id, 100);
    assert.equal(queue.messages.length, 0);
  } finally {
    db.close();
  }
});

test("a VFS retry resumes the D1 checkpoint without a second AI request", async () => {
  const db = new SqliteD1();
  const queue = new TestQueue<NnsProposalReviewQueueMessage>();
  const env = auditEnv(db, queue);
  const vfs = new NnsTestVfs();
  const message = { kind: "nns_proposal_review" as const, databaseId: "nns-db", proposalId: 101 };
  let reviewRequests = 0;
  try {
    const cursor = await initializeNnsCursor(db, "nns-db", 100);
    await persistDiscoveredProposals(db, cursor, [101], 101);
    await markNnsJobQueued(db, "nns-db", 101);
    vfs.failWritePathOnce = "/Sources/nns/proposals/101/proposal.md";
    vfs.etagConflictPathOnce = "/Knowledge/nns/index.md";
    const context = {
      config: workerConfig(),
      vfs,
      fetchJson: async () => ({ ...proposalDetail(101, "OPEN"), url: "https://example.com/proposal-101" }),
      fetchReference: async () => {
        throw new Error("reference unavailable");
      },
      requestReview: async () => {
        reviewRequests += 1;
        return reviewResponse("ADOPT");
      },
      now: () => new Date("2026-08-20T00:00:00.000Z")
    };

    const first = await processNnsQueueMessageForTest(env, message, context, { leaseOwner: "attempt-1", attempts: 1 });
    assert.equal(first.kind, "retry");
    assert.equal((await loadNnsJob(db, "nns-db", 101))?.status, "generated");

    const second = await processNnsQueueMessageForTest(env, message, context, { leaseOwner: "attempt-2", attempts: 2 });
    assert.deepEqual(second, { kind: "ack" });
    assert.equal(reviewRequests, 1);
    assert.equal((await loadNnsJob(db, "nns-db", 101))?.status, "completed");
    assert.ok(vfs.nodes.has("/Sources/nns/proposals/101/proposal.md"));
    assert.ok(vfs.nodes.has("/Knowledge/nns/proposals/101/review.md"));
    assert.ok(vfs.nodes.has("/Knowledge/nns/review-policy.md"));
    assert.ok(vfs.nodes.has("/Knowledge/nns/index.md"));
    assert.match(vfs.nodes.get("/Knowledge/nns/proposals/101/review.md")?.content ?? "", /NEEDS_CLARIFICATION/);
    assert.doesNotMatch(vfs.nodes.get("/Sources/nns/proposals/101/proposal.md")?.content ?? "", /latest_tally|known_neurons_ballots/);
  } finally {
    db.close();
  }
});

test("a provider retry reuses the first proposal and reference capture", async () => {
  const db = new SqliteD1();
  const queue = new TestQueue<NnsProposalReviewQueueMessage>();
  const env = auditEnv(db, queue);
  const vfs = new NnsTestVfs();
  const message = { kind: "nns_proposal_review" as const, databaseId: "nns-db", proposalId: 104 };
  let detailRequests = 0;
  let referenceRequests = 0;
  let reviewRequests = 0;
  try {
    const cursor = await initializeNnsCursor(db, "nns-db", 103);
    await persistDiscoveredProposals(db, cursor, [104], 104);
    await markNnsJobQueued(db, "nns-db", 104);
    const context = {
      config: workerConfig(),
      vfs,
      fetchJson: async () => {
        detailRequests += 1;
        return { ...proposalDetail(104, detailRequests === 1 ? "OPEN" : "EXECUTED"), url: "https://example.com/proposal-104" };
      },
      fetchReference: async (url: string, maxBytes: number) => {
        referenceRequests += 1;
        return {
          url,
          finalUrl: url,
          title: "Proposal reference",
          contentType: "text/plain",
          text: "Stable captured reference evidence.",
          fetchedTruncated: false,
          fetchedBytes: 35,
          maxFetchedBytes: maxBytes
        };
      },
      requestReview: async () => {
        reviewRequests += 1;
        if (reviewRequests === 1) throw new Error("temporary provider failure");
        return reviewResponse("ADOPT");
      },
      now: () => new Date("2026-08-20T00:00:00.000Z")
    };

    const first = await processNnsQueueMessageForTest(env, message, context, { leaseOwner: "provider-1", attempts: 1 });
    assert.equal(first.kind, "retry");
    assert.equal((await loadNnsJob(db, "nns-db", 104))?.status, "queued");
    assert.ok((await loadNnsJob(db, "nns-db", 104))?.captured_input);

    const second = await processNnsQueueMessageForTest(env, message, context, { leaseOwner: "provider-2", attempts: 2 });
    assert.deepEqual(second, { kind: "ack" });
    assert.equal(detailRequests, 1);
    assert.equal(referenceRequests, 1);
    assert.equal(reviewRequests, 2);
    assert.match(vfs.nodes.get("/Sources/nns/proposals/104/proposal.md")?.content ?? "", /status_at_capture: "OPEN"/);
    assert.match(vfs.nodes.get("/Knowledge/nns/proposals/104/review.md")?.content ?? "", /\*\*ADOPT\*\*/);
    assert.equal((await loadNnsJob(db, "nns-db", 104))?.captured_input, null);
  } finally {
    db.close();
  }
});

test("a captured reference is truncated to the D1 checkpoint byte limit", async () => {
  const db = new SqliteD1();
  const queue = new TestQueue<NnsProposalReviewQueueMessage>();
  const env = auditEnv(db, queue);
  const vfs = new NnsTestVfs();
  const message = { kind: "nns_proposal_review" as const, databaseId: "nns-db", proposalId: 106 };
  try {
    const cursor = await initializeNnsCursor(db, "nns-db", 105);
    await persistDiscoveredProposals(db, cursor, [106], 106);
    await markNnsJobQueued(db, "nns-db", 106);
    const result = await processNnsQueueMessageForTest(
      env,
      message,
      {
        config: workerConfig(),
        vfs,
        fetchJson: async () => ({ ...proposalDetail(106, "OPEN"), url: "https://example.com/proposal-106" }),
        fetchReference: async (url, maxBytes) => ({
          url,
          finalUrl: url,
          title: "Large reference",
          contentType: "text/plain",
          text: "\u0000".repeat(300_000),
          fetchedTruncated: false,
          fetchedBytes: 300_000,
          maxFetchedBytes: maxBytes
        }),
        requestReview: async () => {
          throw new Error("temporary provider failure");
        }
      },
      { leaseOwner: "large-reference", attempts: 1 }
    );

    assert.equal(result.kind, "retry");
    const serialized = (await loadNnsJob(db, "nns-db", 106))?.captured_input ?? "";
    assert.ok(new TextEncoder().encode(serialized).byteLength <= 1024 * 1024);
    const captured = JSON.parse(serialized) as { reference?: { text?: string; fetchedTruncated?: boolean } };
    assert.ok((captured.reference?.text?.length ?? 0) > 0);
    assert.equal(captured.reference?.fetchedTruncated, true);
  } finally {
    db.close();
  }
});

test("enqueue CAS preserves an active generated lease", async () => {
  const db = new SqliteD1();
  const queue = new TestQueue<NnsProposalReviewQueueMessage>();
  const env = auditEnv(db, queue);
  const vfs = new NnsTestVfs();
  const message = { kind: "nns_proposal_review" as const, databaseId: "nns-db", proposalId: 105 };
  try {
    const cursor = await initializeNnsCursor(db, "nns-db", 104);
    await persistDiscoveredProposals(db, cursor, [105], 105);
    await markNnsJobQueued(db, "nns-db", 105);
    vfs.failWritePathOnce = "/Sources/nns/proposals/105/proposal.md";
    const first = await processNnsQueueMessageForTest(
      env,
      message,
      {
        config: workerConfig(),
        vfs,
        fetchJson: async () => proposalDetail(105, "OPEN"),
        requestReview: async () => reviewResponse("NEEDS_CLARIFICATION")
      },
      { leaseOwner: "generator-1", attempts: 1 }
    );
    assert.equal(first.kind, "retry");
    assert.deepEqual(await listEnqueueableNnsProposalIds(db, "nns-db"), [105]);

    const claim = await claimNnsJob(db, message, "active-generator");
    assert.equal(claim.kind, "resume");
    assert.equal(await markNnsJobQueued(db, "nns-db", 105), false);
    const active = await loadNnsJob(db, "nns-db", 105);
    assert.equal(active?.status, "generated");
    assert.equal(active?.lease_owner, "active-generator");
    await completeNnsJob(db, message, "active-generator");
    assert.equal((await loadNnsJob(db, "nns-db", 105))?.status, "completed");
  } finally {
    db.close();
  }
});

test("a proposal first seen as non-open is recorded without calling AI", async () => {
  const db = new SqliteD1();
  const queue = new TestQueue<NnsProposalReviewQueueMessage>();
  const env = auditEnv(db, queue);
  const vfs = new NnsTestVfs();
  const message = { kind: "nns_proposal_review" as const, databaseId: "nns-db", proposalId: 102 };
  let reviewRequests = 0;
  try {
    vfs.nodes.set("/Knowledge/nns/review-policy.md", {
      path: "/Knowledge/nns/review-policy.md",
      kind: "file",
      content: "# Administrator policy\n\nKeep this edit.",
      etag: "admin-etag",
      metadataJson: "{}"
    });
    const cursor = await initializeNnsCursor(db, "nns-db", 101);
    await persistDiscoveredProposals(db, cursor, [102], 102);
    await markNnsJobQueued(db, "nns-db", 102);
    const result = await processNnsQueueMessageForTest(
      env,
      message,
      {
        config: workerConfig(),
        vfs,
        fetchJson: async () => proposalDetail(102, "EXECUTED"),
        requestReview: async () => {
          reviewRequests += 1;
          return reviewResponse("ADOPT");
        }
      },
      { leaseOwner: "closed", attempts: 1 }
    );

    assert.deepEqual(result, { kind: "ack" });
    assert.equal(reviewRequests, 0);
    assert.equal(vfs.nodes.get("/Knowledge/nns/review-policy.md")?.content, "# Administrator policy\n\nKeep this edit.");
    assert.match(vfs.nodes.get("/Knowledge/nns/proposals/102/review.md")?.content ?? "", /NOT_APPLICABLE/);
  } finally {
    db.close();
  }
});

test("a completed job with a failed index update is re-enqueued by a later poll", async () => {
  const db = new SqliteD1();
  const queue = new TestQueue<NnsProposalReviewQueueMessage>();
  const env = auditEnv(db, queue);
  const vfs = new NnsTestVfs();
  const message = { kind: "nns_proposal_review" as const, databaseId: "nns-db", proposalId: 107 };
  try {
    const cursor = await initializeNnsCursor(db, "nns-db", 106);
    await persistDiscoveredProposals(db, cursor, [107], 107);
    await markNnsJobQueued(db, "nns-db", 107);
    vfs.failWritePath = "/Knowledge/nns/index.md";

    const first = await processNnsQueueMessageForTest(
      env,
      message,
      {
        config: workerConfig(),
        vfs,
        fetchJson: async () => proposalDetail(107, "OPEN"),
        requestReview: async () => reviewResponse("NEEDS_CLARIFICATION")
      },
      { leaseOwner: "index-failure", attempts: 5 }
    );

    assert.equal(first.kind, "dead_letter");
    const completed = await loadNnsJob(db, "nns-db", 107);
    assert.equal(completed?.status, "completed");
    assert.equal(completed?.index_pending, 1);

    vfs.failWritePath = null;
    const poll = await runNnsAuditPoll(
      env,
      {},
      {
        fetchJson: async () => ({ data: [{ proposal_id: 107 }, { proposal_id: 106 }] }),
        now: () => new Date(Date.now() + 16 * 60 * 1000)
      }
    );
    assert.equal(poll.enqueued, 1);
    assert.deepEqual(queue.messages, [message]);
    assert.equal((await loadNnsJob(db, "nns-db", 107))?.status, "completed");

    const second = await processNnsQueueMessageForTest(env, message, { config: workerConfig(), vfs }, { leaseOwner: "index-retry", attempts: 1 });
    assert.deepEqual(second, { kind: "ack" });
    assert.equal((await loadNnsJob(db, "nns-db", 107))?.index_pending, 0);
    assert.ok(vfs.nodes.has("/Knowledge/nns/index.md"));
  } finally {
    db.close();
  }
});

test("create-only publication refuses different existing proposal content", async () => {
  const db = new SqliteD1();
  const queue = new TestQueue<NnsProposalReviewQueueMessage>();
  const env = auditEnv(db, queue);
  const vfs = new NnsTestVfs();
  const message = { kind: "nns_proposal_review" as const, databaseId: "nns-db", proposalId: 103 };
  try {
    const cursor = await initializeNnsCursor(db, "nns-db", 102);
    await persistDiscoveredProposals(db, cursor, [103], 103);
    await markNnsJobQueued(db, "nns-db", 103);
    vfs.nodes.set("/Sources/nns/proposals/103/proposal.md", {
      path: "/Sources/nns/proposals/103/proposal.md",
      kind: "source",
      content: "different content",
      etag: "existing-etag",
      metadataJson: "{}"
    });

    const result = await processNnsQueueMessageForTest(
      env,
      message,
      {
        config: workerConfig(),
        vfs,
        fetchJson: async () => proposalDetail(103, "OPEN"),
        requestReview: async () => reviewResponse("NEEDS_CLARIFICATION")
      },
      { leaseOwner: "conflict", attempts: 1 }
    );

    assert.equal(result.kind, "dead_letter");
    assert.equal(result.kind === "dead_letter" ? result.code : "", "nns_create_only_conflict");
    assert.equal((await loadNnsJob(db, "nns-db", 103))?.status, "failed");
    assert.equal(vfs.nodes.get("/Sources/nns/proposals/103/proposal.md")?.content, "different content");
  } finally {
    db.close();
  }
});

function auditEnv(db: D1Database, queue: TestQueue<NnsProposalReviewQueueMessage>) {
  return nnsTestEnv(db, queue);
}

function proposalDetail(proposalId: number, status: string): Record<string, unknown> {
  return {
    proposal_id: proposalId,
    title: `Proposal ${proposalId}`,
    summary: "Review this proposal.",
    topic: "Governance",
    proposer: "aaaaa-aa",
    action: "Motion",
    status,
    latest_tally: { yes: 1, no: 0 },
    known_neurons_ballots: [{ neuron_id: 1 }],
    payload: { motion_text: "Adopt an operational policy." }
  };
}

function reviewResponse(recommendation: "ADOPT" | "REJECT" | "NEEDS_CLARIFICATION"): Record<string, unknown> {
  return {
    choices: [
      {
        message: {
          content: JSON.stringify({
            executive_summary: "The proposal is understandable but lacks implementation details.",
            proposed_action: "Adopt a non-binding policy.",
            evidence_reviewed: ["Official proposal snapshot"],
            benefits: ["Clarifies intent"],
            risks: ["No implementation owner"],
            missing_information: ["Owner and timeline"],
            type_specific_checks: ["The motion is non-binding"],
            recommendation,
            rationale: "Material implementation details are not captured."
          })
        }
      }
    ]
  };
}
