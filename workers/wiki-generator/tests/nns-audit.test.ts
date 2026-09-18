// Where: workers/wiki-generator/tests/nns-audit.test.ts
// What: Wiki-backed discovery, evidence capture, checkpoint, and vote-intent tests.
// Why: The Wiki is the durable source of truth for the entire NNS automation workflow.
import assert from "node:assert/strict";
import test from "node:test";
import {
  initializeNnsCursor,
  loadNnsAuditStatus,
  loadNnsCursor,
  loadNnsJob,
  markNnsJobQueued,
  persistDiscoveredProposals
} from "../src/nns-jobs.js";
import { processNnsQueueMessageForTest, runNnsAuditPoll } from "../src/nns-audit.js";
import { DEFAULT_NNS_AUTOVOTE_POLICY, NNS_AUTOVOTE_POLICY_PATH, sha256Hex } from "../src/nns-policy.js";
import type { NnsGovernanceClient } from "../src/nns-governance.js";
import type { NnsProposalReviewQueueMessage, NnsVoteIntent } from "../src/types.js";
import { TestQueue, workerConfig } from "./source-capture-fixtures.js";
import { nnsTestEnv, NnsTestVfs } from "./nns-fixtures.js";

test("first poll stores the discovery cursor in the Wiki without backfilling", async () => {
  const queue = new TestQueue<NnsProposalReviewQueueMessage>();
  const vfs = new NnsTestVfs();
  const result = await runNnsAuditPoll(nnsTestEnv(queue), {}, {
    vfs,
    config: workerConfig(),
    fetchJson: async () => ({ latest_proposal_id: 500 }),
    now: () => new Date("2026-08-20T00:00:00.000Z")
  });
  assert.equal(result.initialized, true);
  assert.equal(result.initialProposalId, 500);
  assert.equal(queue.messages.length, 0);
  assert.equal((await loadNnsCursor(vfs, "nns-db"))?.latest_proposal_id, 500);
  assert.ok(vfs.nodes.has("/Knowledge/nns/system/discovery-state.md"));
});

test("daily discovery creates Wiki workflows before enqueueing proposals", async () => {
  const queue = new TestQueue<NnsProposalReviewQueueMessage>();
  const vfs = new NnsTestVfs();
  const env = nnsTestEnv(queue);
  await runNnsAuditPoll(env, {}, {
    vfs, config: workerConfig(), fetchJson: async () => ({ latest_proposal_id: 100 })
  });
  const result = await runNnsAuditPoll(env, {}, {
    vfs,
    config: workerConfig(),
    fetchJson: async () => ({ data: [{ proposal_id: 102 }, { proposal_id: 101 }, { proposal_id: 100 }] })
  });
  assert.equal(result.discovered, 2);
  assert.equal(result.enqueued, 2);
  assert.ok(vfs.nodes.has("/Knowledge/nns/system/workflows/101.md"));
  assert.ok(vfs.nodes.has("/Knowledge/nns/system/workflows/102.md"));
  assert.equal((await loadNnsJob(vfs, "nns-db", 101))?.status, "queued");
});

test("status scans only compact system state and reports invalid nodes", async () => {
  const vfs = new NnsTestVfs();
  vfs.nodes.set("/Knowledge/nns/system/workflows/broken.md", {
    path: "/Knowledge/nns/system/workflows/broken.md", kind: "file", content: "broken", etag: "bad", metadataJson: "{}"
  });
  vfs.nodes.set("/Knowledge/nns/proposals/1/review.md", {
    path: "/Knowledge/nns/proposals/1/review.md", kind: "file", content: "large public artifact", etag: "public", metadataJson: "{}"
  });
  const status = await loadNnsAuditStatus(vfs, "nns-db");
  assert.equal(status.invalidWorkflowCount, 1);
  assert.deepEqual(vfs.exportPrefixes, ["/Knowledge/nns/system/workflows", "/Knowledge/nns/system/votes"]);
});

test("Forum and linked evidence are fixed in the Wiki before Jev is called", async () => {
  const vfs = new NnsTestVfs();
  const env = nnsTestEnv();
  const message = { kind: "nns_proposal_review" as const, databaseId: "nns-db", proposalId: 101, reason: "discovery" as const };
  await seedJob(vfs, 101);
  const fetched: string[] = [];
  let observedEvidenceBeforeJev = false;
  const result = await processNnsQueueMessageForTest(env, message, {
    config: workerConfig(),
    ...decisionContext(),
    vfs,
    fetchJson: async () => ({
      ...proposalDetail(101, "OPEN"),
      summary: "Discussion: https://forum.dfinity.org/t/example/123 and spec https://example.com/spec"
    }),
    fetchReference: async (url, maxBytes) => {
      fetched.push(url);
      return {
        url, finalUrl: url, title: url.includes("forum") ? "Forum discussion" : "Specification",
        contentType: "text/plain", text: `Captured body for ${url}`, fetchedTruncated: false,
        fetchedBytes: 40, maxFetchedBytes: maxBytes
      };
    },
    requestJev: async () => {
      observedEvidenceBeforeJev = vfs.nodes.has("/Sources/nns/proposals/101/forum.md")
        && vfs.nodes.has("/Knowledge/nns/proposals/101/evidence.md");
      return jevAdopt();
    },
    requestReview: async () => reviewResponse("ADOPT"),
    now: () => new Date("2026-08-20T00:00:00.000Z")
  });
  assert.deepEqual(result, { kind: "ack" });
  assert.equal(observedEvidenceBeforeJev, true);
  assert.match(fetched[0] ?? "", /forum\.dfinity\.org/);
  assert.ok(fetched.some((url) => url === "https://example.com/spec"));
  assert.match(vfs.nodes.get("/Knowledge/nns/proposals/101/evidence.md")?.content ?? "", /forum\.dfinity\.org/);
});

test("Jev and evidence hashes use the exact UTF-8 bounded body stored in the Wiki", async () => {
  const vfs = new NnsTestVfs();
  const env = nnsTestEnv();
  const proposalId = 112;
  const message = { kind: "nns_proposal_review" as const, databaseId: "nns-db", proposalId, reason: "discovery" as const };
  await seedJob(vfs, proposalId);
  const detail = {
    ...proposalDetail(proposalId, "OPEN"),
    action: "ManageNetworkEconomics",
    summary: "Evidence https://example.com/economics"
  };
  const context = decisionContext();
  context.governance.getPendingProposal = async () => ({
    proposalId: String(proposalId), status: 1, topic: 4, deadlineTimestampSeconds: "2000000000",
    title: `Proposal ${proposalId}`, summary: detail.summary, url: "", action: "ManageNetworkEconomics",
    actionDescription: "ManageNetworkEconomics", actionValue: { motion_text: "Adopt an operational policy." },
    ballots: {}, capturedAt: "2026-08-20T00:00:00.000Z"
  });
  const observed: { jevState?: Record<string, unknown> } = {};
  const rawEvidence = "日本語".repeat(500);

  const result = await processNnsQueueMessageForTest(env, message, {
    config: { ...workerConfig(), maxSourceChars: 1_024, maxRawChars: 5_000 },
    ...context,
    vfs,
    fetchJson: async () => detail,
    fetchReference: async (url, maxBytes) => ({
      url, finalUrl: url, title: "Economics evidence", contentType: "text/plain",
      text: rawEvidence, fetchedTruncated: false,
      fetchedBytes: new TextEncoder().encode(rawEvidence).byteLength, maxFetchedBytes: maxBytes
    }),
    requestJev: async (state) => { observed.jevState = state; return jevAdopt(); },
    requestReview: async () => reviewResponse("ADOPT"),
    now: () => new Date("2026-08-20T00:00:00.000Z")
  });

  assert.deepEqual(result, { kind: "ack" });
  const sourceContent = vfs.nodes.get(`/Sources/nns/proposals/${proposalId}/reference.md`)?.content ?? "";
  const storedBody = sourceContent.match(/Category:[^\n]*\n\n([\s\S]*)$/)?.[1];
  assert.ok(storedBody);
  assert.ok(new TextEncoder().encode(storedBody).byteLength <= 1_024);
  const referenceEvidence = observed.jevState?.reference_evidence as { sources?: { text?: string }[] } | undefined;
  assert.equal(referenceEvidence?.sources?.[0]?.text, storedBody);

  const evidenceContent = vfs.nodes.get(`/Knowledge/nns/proposals/${proposalId}/evidence.md`)?.content ?? "";
  const manifestText = evidenceContent.match(/```json\n([\s\S]*?)\n```/)?.[1];
  assert.ok(manifestText);
  const manifest = JSON.parse(manifestText) as { attempts: { status: string; contentHash: string }[] };
  assert.equal(manifest.attempts[0]?.status, "truncated");
  assert.equal(manifest.attempts[0]?.contentHash, await sha256Hex(storedBody));
  assert.match(vfs.nodes.get(`/Knowledge/nns/proposals/${proposalId}/decision.md`)?.content ?? "", /\*\*HOLD\*\*/);
});

test("a publication retry resumes the Wiki checkpoint without another Jev request", async () => {
  const vfs = new NnsTestVfs();
  const env = nnsTestEnv();
  const message = { kind: "nns_proposal_review" as const, databaseId: "nns-db", proposalId: 102, reason: "discovery" as const };
  await seedJob(vfs, 102);
  let jevCalls = 0;
  vfs.failWritePathOnce = "/Knowledge/nns/proposals/102/decision.md";
  const context = {
    config: workerConfig(),
    ...decisionContext(),
    vfs,
    fetchJson: async () => proposalDetail(102, "OPEN"),
    requestJev: async () => { jevCalls += 1; return jevAdopt(); },
    requestReview: async () => reviewResponse("ADOPT"),
    now: () => new Date("2026-08-20T00:00:00.000Z")
  };
  assert.equal((await processNnsQueueMessageForTest(env, message, context, { leaseOwner: "one", attempts: 1 })).kind, "retry");
  assert.equal((await loadNnsJob(vfs, "nns-db", 102))?.status, "generated");
  assert.deepEqual(await processNnsQueueMessageForTest(env, message, context, { leaseOwner: "two", attempts: 2 }), { kind: "ack" });
  assert.equal(jevCalls, 1);
  assert.equal((await loadNnsJob(vfs, "nns-db", 102))?.status, "completed");
});

test("live qualified Wiki policy queues the code-owned vote decision", async () => {
  const vfs = new NnsTestVfs();
  const env = nnsTestEnv();
  const voteQueue = env.NNS_VOTE_QUEUE as TestQueue<NnsVoteIntent>;
  const message = { kind: "nns_proposal_review" as const, databaseId: "nns-db", proposalId: 108, reason: "discovery" as const };
  await seedJob(vfs, 108);
  const livePolicy = DEFAULT_NNS_AUTOVOTE_POLICY
    .replace("enabled: false", "enabled: true")
    .replace("mode: shadow", "mode: live")
    .replace("auto_vote: false", "auto_vote: true");
  vfs.nodes.set(NNS_AUTOVOTE_POLICY_PATH, {
    path: NNS_AUTOVOTE_POLICY_PATH, kind: "file", content: livePolicy, etag: "policy-live", metadataJson: "{}"
  });
  const result = await processNnsQueueMessageForTest(env, message, {
    config: { ...workerConfig(), neuronId: "9" },
    ...decisionContext(),
    vfs,
    fetchJson: async () => proposalDetail(108, "OPEN"),
    requestReview: async () => reviewResponse("REJECT"),
    now: () => new Date("2026-08-20T00:00:00.000Z")
  });
  assert.deepEqual(result, { kind: "ack" });
  assert.equal(voteQueue.messages[0]?.vote, "YES");
  assert.match(vfs.nodes.get("/Knowledge/nns/proposals/108/review.md")?.content ?? "", /\*\*ADOPT\*\*/);
});

test("a missing required reference is recorded and forces HOLD", async () => {
  const vfs = new NnsTestVfs();
  const env = nnsTestEnv();
  const message = { kind: "nns_proposal_review" as const, databaseId: "nns-db", proposalId: 109, reason: "discovery" as const };
  await seedJob(vfs, 109);
  const detail = {
    ...proposalDetail(109, "OPEN"), action: "ManageNetworkEconomics",
    summary: "Evidence https://example.com/ok and https://example.com/missing"
  };
  const context = decisionContext();
  context.governance.getPendingProposal = async () => ({
    proposalId: "109", status: 1, topic: 4, deadlineTimestampSeconds: "2000000000",
    title: "Proposal 109", summary: detail.summary, url: "", action: "ManageNetworkEconomics",
    actionDescription: "ManageNetworkEconomics", actionValue: { motion_text: "Adopt an operational policy." },
    ballots: {}, capturedAt: "2026-08-20T00:00:00.000Z"
  });
  const result = await processNnsQueueMessageForTest(env, message, {
    config: { ...workerConfig(), neuronId: "9" }, ...context, vfs,
    fetchJson: async () => detail,
    fetchReference: async (url, maxBytes) => {
      if (url.endsWith("/missing")) throw new Error("fetch unavailable");
      return { url, finalUrl: url, title: "Available", contentType: "text/plain", text: "evidence",
        fetchedTruncated: false, fetchedBytes: 8, maxFetchedBytes: maxBytes };
    },
    requestReview: async () => reviewResponse("ADOPT"),
    now: () => new Date("2026-08-20T00:00:00.000Z")
  });
  assert.deepEqual(result, { kind: "ack" });
  assert.match(vfs.nodes.get("/Knowledge/nns/proposals/109/evidence.md")?.content ?? "", /reference_fetch_failed/);
  assert.match(vfs.nodes.get("/Knowledge/nns/proposals/109/decision.md")?.content ?? "", /\*\*HOLD\*\*/);
  assert.equal((env.NNS_VOTE_QUEUE as TestQueue<NnsVoteIntent>).messages.length, 0);
});

test("a retry reuses an already published Governance snapshot", async () => {
  const vfs = new NnsTestVfs();
  const env = nnsTestEnv();
  const message = { kind: "nns_proposal_review" as const, databaseId: "nns-db", proposalId: 110, reason: "discovery" as const };
  await seedJob(vfs, 110);
  let governanceCalls = 0;
  const context = decisionContext();
  const originalGet = context.governance.getPendingProposal;
  context.governance.getPendingProposal = async (id) => { governanceCalls += 1; return originalGet(id); };
  vfs.failWritePathOnce = NNS_AUTOVOTE_POLICY_PATH;
  const queueContext = {
    config: workerConfig(), ...context, vfs, fetchJson: async () => proposalDetail(110, "OPEN"),
    requestReview: async () => reviewResponse("ADOPT"), now: () => new Date("2026-08-20T00:00:00.000Z")
  };
  assert.equal((await processNnsQueueMessageForTest(env, message, queueContext, { leaseOwner: "first", attempts: 1 })).kind, "retry");
  assert.deepEqual(await processNnsQueueMessageForTest(env, message, queueContext, { leaseOwner: "second", attempts: 2 }), { kind: "ack" });
  assert.equal(governanceCalls, 1);
});

test("a policy change reevaluates a completed proposal and preserves decision history", async () => {
  const vfs = new NnsTestVfs();
  const env = nnsTestEnv();
  await seedJob(vfs, 111);
  const governance = decisionContext().governance as NnsGovernanceClient;
  const pending = await governance.getPendingProposal(111n);
  governance.getProposal = async () => pending;
  let jevCalls = 0;
  const context = {
    config: workerConfig(), governance, vfs,
    fetchJson: async () => proposalDetail(111, "OPEN"),
    requestJev: async () => { jevCalls += 1; return jevAdopt(); },
    requestReview: async () => reviewResponse("ADOPT"),
    now: () => new Date("2026-08-20T00:00:00.000Z")
  };
  const firstMessage = { kind: "nns_proposal_review" as const, databaseId: "nns-db", proposalId: 111, reason: "discovery" as const };
  assert.deepEqual(await processNnsQueueMessageForTest(env, firstMessage, context), { kind: "ack" });
  const firstDecisionId = (await loadNnsJob(vfs, "nns-db", 111))?.decision_id;
  assert.ok(firstDecisionId);
  const policy = vfs.nodes.get(NNS_AUTOVOTE_POLICY_PATH)!;
  vfs.nodes.set(NNS_AUTOVOTE_POLICY_PATH, {
    ...policy, content: policy.content.replace("initial-shadow", "second-shadow"), etag: "second-policy"
  });
  const secondMessage = {
    kind: "nns_proposal_review" as const, databaseId: "nns-db", proposalId: 111,
    reason: "policy_changed" as const, previousDecisionId: firstDecisionId
  };
  assert.deepEqual(await processNnsQueueMessageForTest(env, secondMessage, context, { leaseOwner: "reevaluate", attempts: 1 }), { kind: "ack" });
  const secondDecisionId = (await loadNnsJob(vfs, "nns-db", 111))?.decision_id;
  assert.notEqual(secondDecisionId, firstDecisionId);
  assert.ok(vfs.nodes.has(`/Knowledge/nns/proposals/111/decisions/${firstDecisionId}.md`));
  assert.ok(vfs.nodes.has(`/Knowledge/nns/proposals/111/decisions/${secondDecisionId}.md`));
  assert.equal(jevCalls, 2);
});

async function seedJob(vfs: NnsTestVfs, proposalId: number): Promise<void> {
  const cursor = await initializeNnsCursor(vfs, "nns-db", proposalId - 1);
  await persistDiscoveredProposals(vfs, cursor, [proposalId], proposalId);
  await markNnsJobQueued(vfs, "nns-db", proposalId);
}

function proposalDetail(proposalId: number, status: string): Record<string, unknown> {
  return {
    proposal_id: proposalId, title: `Proposal ${proposalId}`, summary: "Review this proposal.",
    topic: "Governance", action: "Motion", status,
    payload: { motion_text: "Adopt an operational policy." }
  };
}

function reviewResponse(recommendation: "ADOPT" | "REJECT" | "NEEDS_CLARIFICATION"): Record<string, unknown> {
  return { choices: [{ message: { content: JSON.stringify({
    executive_summary: "Summary", proposed_action: "Adopt policy",
    evidence_reviewed: ["Wiki evidence bundle"], benefits: ["Clarity"], risks: ["None identified"],
    missing_information: [], type_specific_checks: ["Motion checked"], recommendation, rationale: "Evidence supports the result."
  }) } }] };
}

function jevAdopt() {
  return {
    model: "jev-latest", durationMs: 1,
    answer: {
      recommendation: { choice: "ADOPT" as const, probabilities: { ADOPT: 0.97, REJECT: 0.01, HOLD: 0.02 }, confidence: 0.95 },
      descriptionMatchesPayload: 0.99, requiredEvidencePresent: 0.99, materialClaimsSupported: 0.99,
      violatesPolicy: 0.01, materialUnboundedRisk: 0.01
    }
  };
}

function decisionContext() {
  return {
    governance: {
      async getPendingProposal(proposalId: bigint) {
        return {
          proposalId: proposalId.toString(), status: 1, topic: 4, deadlineTimestampSeconds: "2000000000",
          title: `Proposal ${proposalId.toString()}`, summary: "Review this proposal.", url: "",
          action: "Motion", actionDescription: "Motion", actionValue: { motion_text: "Adopt an operational policy." },
          ballots: {}, capturedAt: "2026-08-20T00:00:00.000Z"
        };
      },
      async getProposal() { return null; },
      async getNeuron() { return { neuronId: "1", authorized: false, existingVote: null }; },
      async simulateVote() {},
      async registerVote() {}
    },
    requestJev: async () => jevAdopt()
  };
}
