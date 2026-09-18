// Where: workers/wiki-generator/tests/nns-voter.test.ts
// What: Voter kill switch, reconciliation, and no-resend tests.
// Why: At-least-once Queue delivery must never become a duplicate signed vote.
import assert from "node:assert/strict";
import test from "node:test";
import { renderFrontmatter } from "../src/frontmatter.js";
import { DEFAULT_NNS_AUTOVOTE_POLICY, NNS_AUTOVOTE_POLICY_PATH, sha256Hex } from "../src/nns-policy.js";
import type { NnsVoterEnv } from "../src/nns-voter-env.js";
import { processVoteIntentForTest } from "../src/nns-voter.js";
import { claimVoteIntent, setVoteStatus } from "../src/nns-voter-jobs.js";
import type { NnsVoteIntent } from "../src/types.js";
import { NnsTestVfs } from "./nns-fixtures.js";
import { TestQueue } from "./source-capture-fixtures.js";

test("voter kill switch records held before touching governance", async () => {
  const vfs = new NnsTestVfs();
  let governanceCalls = 0;
  {
    const row = await processVoteIntentForTest(voterEnv(false), baseIntent(), "kill-switch", {
      vfs,
      governance: governanceMock(() => { governanceCalls += 1; return null; })
    });
    assert.equal(row.status, "held");
    assert.equal(row.lastError, "autovote_disabled");
    assert.equal(governanceCalls, 0);
    assert.match(vfs.nodes.get("/Knowledge/nns/proposals/101/vote.md")?.content ?? "", /held/);
  }
});

test("successful vote is confirmed from the neuron ballot", async () => {
  const vfs = new NnsTestVfs();
  const intent = baseIntent();
  await seedLiveArtifacts(vfs, intent);
  let neuronReads = 0;
  let simulations = 0;
  let submissions = 0;
  {
    const row = await processVoteIntentForTest(voterEnv(true), intent, "confirmed", {
      vfs,
      governance: governanceMock(() => ({ neuronId: "9", authorized: true, existingVote: ++neuronReads === 1 ? null : "YES" }), {
        simulate: () => { simulations += 1; },
        submit: () => { submissions += 1; }
      }),
      now: () => new Date("2026-08-20T00:00:00.000Z")
    });
    assert.equal(row.status, "confirmed");
    assert.equal(simulations, 1);
    assert.equal(submissions, 1);
    assert.match(vfs.nodes.get("/Knowledge/nns/proposals/101/vote.md")?.content ?? "", /"publicationPending": false/);
    assert.match(vfs.nodes.get("/Knowledge/nns/system/votes/101.md")?.content ?? "", /"publicationPending": false/);
  }
});

test("ambiguous update is reconciled without automatic resubmission", async () => {
  const vfs = new NnsTestVfs();
  const intent = baseIntent();
  await seedLiveArtifacts(vfs, intent);
  let submissions = 0;
  const governance = governanceMock(
    () => ({ neuronId: "9", authorized: true, existingVote: null }),
    { submit: () => { submissions += 1; throw new Error("transport outcome unknown"); } }
  );
  {
    const first = await processVoteIntentForTest(voterEnv(true), intent, "unknown-1", { vfs, governance });
    assert.equal(first.status, "unknown");
    const second = await processVoteIntentForTest(voterEnv(true), intent, "unknown-2", { vfs, governance });
    assert.equal(second.status, "unknown");
    assert.equal(submissions, 1);
  }
});

test("redelivery from submitting state reconciles and never signs again", async () => {
  const vfs = new NnsTestVfs();
  const intent = baseIntent();
  await seedLiveArtifacts(vfs, intent);
  const claimed = await claimVoteIntent(vfs, intent, "crashed-submit");
  assert.equal(claimed.kind, "claimed");
  await setVoteStatus(vfs, intent, "crashed-submit", "submitting", null, true);
  let submissions = 0;
  {
    const row = await processVoteIntentForTest(voterEnv(true), intent, "reconcile-submit", {
      vfs,
      governance: governanceMock(
        () => ({ neuronId: "9", authorized: true, existingVote: null }),
        { submit: () => { submissions += 1; } }
      )
    });
    assert.equal(row.status, "unknown");
    assert.equal(submissions, 0);
  }
});

test("a submitted vote is reconciled while the kill switch is disabled", async () => {
  const vfs = new NnsTestVfs();
  const intent = baseIntent();
  await seedLiveArtifacts(vfs, intent);
  const claimed = await claimVoteIntent(vfs, intent, "submitted-owner");
  assert.equal(claimed.kind, "claimed");
  await setVoteStatus(vfs, intent, "submitted-owner", "submitting", null, true);
  let submissions = 0;
  const row = await processVoteIntentForTest(voterEnv(false), intent, "reconcile-disabled", {
    vfs,
    governance: governanceMock(() => ({ neuronId: "9", authorized: true, existingVote: "YES" }), {
      submit: () => { submissions += 1; }
    })
  });
  assert.equal(row.status, "confirmed");
  assert.equal(submissions, 0);
});

test("policy hash change holds the intent before governance", async () => {
  const vfs = new NnsTestVfs();
  const intent = baseIntent();
  await seedLiveArtifacts(vfs, intent);
  const policy = vfs.nodes.get(NNS_AUTOVOTE_POLICY_PATH)!;
  vfs.nodes.set(NNS_AUTOVOTE_POLICY_PATH, { ...policy, content: policy.content.replace("initial-shadow", "changed-policy"), etag: "changed-etag" });
  const env = voterEnv(true);
  let governanceCalls = 0;
  {
    const row = await processVoteIntentForTest(env, intent, "policy-change", {
      vfs,
      governance: governanceMock(() => { governanceCalls += 1; return { neuronId: "9", authorized: true, existingVote: null }; })
    });
    assert.equal(row.status, "held");
    assert.equal(row.lastError, "policy_changed");
    const reviews = env.NNS_PROPOSAL_REVIEW_QUEUE as TestQueue<{ reason: string }>;
    assert.equal(reviews.messages[0]?.reason, "policy_changed");
    assert.equal(governanceCalls, 0);
  }
});

test("policy is checked again after simulation before a vote is submitted", async () => {
  const vfs = new NnsTestVfs();
  const intent = baseIntent();
  await seedLiveArtifacts(vfs, intent);
  const env = voterEnv(true);
  let submissions = 0;
  const governance = governanceMock(
    () => ({ neuronId: "9", authorized: true, existingVote: null }),
    {
      simulate: () => {
        const policy = vfs.nodes.get(NNS_AUTOVOTE_POLICY_PATH)!;
        vfs.nodes.set(NNS_AUTOVOTE_POLICY_PATH, {
          ...policy,
          content: policy.content.replace("initial-shadow", "changed-during-simulation"),
          etag: "policy-changed-during-simulation"
        });
      },
      submit: () => { submissions += 1; }
    }
  );

  const row = await processVoteIntentForTest(env, intent, "policy-race", { vfs, governance });

  assert.equal(row.status, "held");
  assert.equal(row.lastError, "policy_changed");
  assert.equal(submissions, 0);
  const reviews = env.NNS_PROPOSAL_REVIEW_QUEUE as TestQueue<{ reason: string; previousDecisionId?: string }>;
  assert.equal(reviews.messages[0]?.reason, "policy_changed");
  assert.equal(reviews.messages[0]?.previousDecisionId, "decision-101");
});

test("submitted intents stay unknown when hotkey authorization is unavailable", async () => {
  const vfs = new NnsTestVfs();
  const intent = baseIntent();
  await seedLiveArtifacts(vfs, intent);
  const claimed = await claimVoteIntent(vfs, intent, "authorization-lost");
  assert.equal(claimed.kind, "claimed");
  await setVoteStatus(vfs, intent, "authorization-lost", "submitting", null, true);
  let submissions = 0;

  const unauthorized = await processVoteIntentForTest(voterEnv(true), intent, "unauthorized-reconcile", {
    vfs,
    governance: governanceMock(
      () => ({ neuronId: "9", authorized: false, existingVote: null }),
      { submit: () => { submissions += 1; } }
    )
  });
  assert.equal(unauthorized.status, "unknown");
  assert.equal(unauthorized.lastError, "hotkey_not_authorized_during_reconciliation");

  const unavailableGovernance = governanceMock(
    () => ({ neuronId: "9", authorized: true, existingVote: null }),
    { submit: () => { submissions += 1; } }
  );
  unavailableGovernance.getNeuron = async () => { throw new Error("not authorized"); };
  const unavailable = await processVoteIntentForTest(voterEnv(true), intent, "unavailable-reconcile", {
    vfs,
    governance: unavailableGovernance
  });
  assert.equal(unavailable.status, "unknown");
  assert.equal(unavailable.lastError, "neuron_unavailable_during_reconciliation");
  assert.equal(submissions, 0);
});

test("an existing following ballot is confirmed or conflicted without submission", async () => {
  const vfs = new NnsTestVfs();
  const intent = baseIntent();
  await seedLiveArtifacts(vfs, intent);
  let submissions = 0;
  const governance = governanceMock(
    () => ({ neuronId: "9", authorized: true, existingVote: null }),
    { submit: () => { submissions += 1; } }
  );
  governance.getProposal = async (proposalId: bigint) => ({
    proposalId: proposalId.toString(), status: 1, topic: 4, deadlineTimestampSeconds: "2000000000",
    title: "Proposal 101", summary: "Summary", url: "", action: "Motion", actionDescription: "Motion",
    actionValue: {}, ballots: { "9": { vote: 2, votingPower: "100" } }, capturedAt: "2026-08-20T00:00:00.000Z"
  });
  {
    const row = await processVoteIntentForTest(voterEnv(true), intent, "following-vote", { vfs, governance });
    assert.equal(row.status, "conflict");
    assert.equal(submissions, 0);
  }
});

test("Wiki publication failure after confirmation never resubmits the vote", async () => {
  const vfs = new NnsTestVfs();
  const intent = baseIntent();
  await seedLiveArtifacts(vfs, intent);
  vfs.failWritePathOnAttempt = { path: "/Knowledge/nns/proposals/101/vote.md", attempt: 4 };
  let neuronReads = 0;
  let submissions = 0;
  const governance = governanceMock(
    () => ({ neuronId: "9", authorized: true, existingVote: ++neuronReads === 1 ? null : "YES" }),
    { submit: () => { submissions += 1; } }
  );
  {
    await assert.rejects(processVoteIntentForTest(voterEnv(true), intent, "publish-fail", { vfs, governance }));
    vfs.failWritePathOnAttempt = null;
    const recovered = await processVoteIntentForTest(voterEnv(true), intent, "publish-fail", {
      vfs,
      governance
    });
    assert.equal(recovered.status, "confirmed");
    assert.equal(submissions, 1);
    assert.match(vfs.nodes.get("/Knowledge/nns/proposals/101/vote.md")?.content ?? "", /confirmed/);
  }
});

test("a reevaluated intent can replace an unsent held intent but not an unknown submission", async () => {
  const vfs = new NnsTestVfs();
  const original = baseIntent();
  {
    assert.equal((await claimVoteIntent(vfs, original, "held-owner")).kind, "claimed");
    await setVoteStatus(vfs, original, "held-owner", "held", "old_policy", true);
    const reevaluated = { ...original, decisionHash: "decision-102", policyHash: "policy-102", evidenceHash: "evidence-102" };
    const replacement = await claimVoteIntent(vfs, reevaluated, "replacement-owner");
    assert.equal(replacement.kind, "claimed");
    if (replacement.kind !== "claimed") return;
    assert.equal(replacement.row.decisionHash, "decision-102");
    await setVoteStatus(vfs, reevaluated, "replacement-owner", "unknown", "ambiguous", true);
    const unsafe = await claimVoteIntent(vfs, { ...reevaluated, decisionHash: "decision-103" }, "unsafe-owner");
    assert.equal(unsafe.kind, "conflict");
  }
});

function voterEnv(enabled: boolean): NnsVoterEnv {
  return {
    NNS_VOTE_DLQ: new TestQueue(),
    NNS_PROPOSAL_REVIEW_QUEUE: new TestQueue(),
    KINIC_NNS_AUTOVOTE_ENABLED: enabled ? "true" : "false",
    KINIC_NNS_VOTER_NEURON_ID: "9",
    KINIC_NNS_AUDIT_DATABASE_ID: "nns-db",
    KINIC_WIKI_CANISTER_ID: "6emaw-iyaaa-aaaay-aacka-cai",
    KINIC_WIKI_IC_HOST: "https://icp0.io",
    KINIC_NNS_VOTER_IDENTITY_PEM: "voter-pem",
    KINIC_NNS_VOTER_WIKI_IDENTITY_PEM: "wiki-pem"
  };
}

function baseIntent(): NnsVoteIntent {
  return {
    kind: "nns_vote_intent",
    databaseId: "nns-db",
    proposalId: "101",
    neuronId: "9",
    action: "Motion",
    vote: "YES",
    decisionHash: "decision-101",
    policyHash: "pending",
    evidenceHash: "evidence-101",
    decidedAt: "2026-08-20T00:00:00.000Z"
  };
}

async function seedLiveArtifacts(vfs: NnsTestVfs, intent: NnsVoteIntent): Promise<void> {
  const content = DEFAULT_NNS_AUTOVOTE_POLICY
    .replace("enabled: false", "enabled: true")
    .replace("mode: shadow", "mode: live")
    .replace("auto_vote: false", "auto_vote: true");
  intent.policyHash = await sha256Hex(content);
  vfs.nodes.set(NNS_AUTOVOTE_POLICY_PATH, {
    path: NNS_AUTOVOTE_POLICY_PATH, kind: "file", content, etag: "policy-etag", metadataJson: "{}"
  });
  const path = `/Knowledge/nns/proposals/${intent.proposalId}/decision.md`;
  vfs.nodes.set(path, {
    path,
    kind: "file",
    etag: "decision-etag",
    metadataJson: "{}",
    content: renderFrontmatter({
      proposal_id: intent.proposalId,
      action: intent.action,
      outcome: intent.vote === "YES" ? "ADOPT" : "REJECT",
      auto_vote_eligible: true,
      decision_id: intent.decisionHash,
      evidence_hash: intent.evidenceHash,
      policy_hash: intent.policyHash
    }, "# Decision")
  });
}

function governanceMock(
  neuron: () => { neuronId: string; authorized: boolean; existingVote: "YES" | "NO" | null } | null,
  hooks: { simulate?: () => void; submit?: () => void } = {}
) {
  const proposal = (proposalId: bigint) => ({
    proposalId: proposalId.toString(), status: 1, topic: 4, deadlineTimestampSeconds: "2000000000",
    title: "Proposal 101", summary: "Summary", url: "", action: "Motion", actionDescription: "Motion",
    actionValue: {}, ballots: { "9": { vote: 0, votingPower: "100" } }, capturedAt: "2026-08-20T00:00:00.000Z"
  });
  return {
    async getPendingProposal(proposalId: bigint) {
      return proposal(proposalId);
    },
    async getProposal(proposalId: bigint) { return proposal(proposalId); },
    async getNeuron() {
      const value = neuron();
      if (!value) throw new Error("unexpected governance access");
      return value;
    },
    async simulateVote() { hooks.simulate?.(); },
    async registerVote() { hooks.submit?.(); }
  };
}
