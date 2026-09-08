// Where: workers/wiki-generator/tests/nns-review.test.ts
// What: NNS snapshot sanitization and review contract tests.
// Why: Voting data exclusion and conservative recommendations are product invariants.
import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_NNS_REVIEW_POLICY,
  isOpenAtCapture,
  nnsReviewMessages,
  parseNnsReviewText,
  parseProposalDetailResponse,
  proposalReviewNode,
  proposalSourceNode,
  reviewDepthForAction
} from "../src/nns-review.js";

test("proposal snapshots recursively remove voting and outcome data", () => {
  const snapshot = parseProposalDetailResponse(
    {
      data: {
        proposal_id: 101,
        title: "Example",
        summary: "Change a parameter",
        topic: "NetworkEconomics",
        proposer: "80",
        proposer_name: "Named proposer neuron",
        dfinity_proposer: true,
        action_nns_function: "ManageNetworkEconomics",
        status: "OPEN",
        latest_tally: { yes: 10, no: 2, total: 12 },
        known_neurons_ballots: [{ neuron_id: 1, voting_power: 50 }],
        executed_timestamp_seconds: 999,
        failure_reason: { error_message: "execution failed" },
        success_value: { result: "executed" },
        reject_cost_e8s: 1_000_000_000,
        payload: {
          proposer: "nested-proposer",
          proposer_name: "Nested proposer name",
          dfinity_proposer: true,
          transaction_fee_e8s: 10_000,
          nested: { reward_status: "SETTLED", ballots: { 1: "YES" }, decision_timestamp_seconds: 123 },
          encoded: JSON.stringify({ voting_power: 99, safe_parameter: 5 })
        }
      }
    },
    101,
    "https://ic-api.internetcomputer.org/api/v3/proposals/101",
    "2026-08-20T00:00:00.000Z",
    300_000
  );

  const source = proposalSourceNode(snapshot);
  const promptInput = JSON.parse(nnsReviewMessages(snapshot, DEFAULT_NNS_REVIEW_POLICY, null, 120_000)[1]?.content ?? "{}") as {
    official_proposal_snapshot?: unknown;
  };
  const exposed = [
    JSON.stringify(snapshot.rawRecord),
    source.content,
    source.metadataJson,
    JSON.stringify(promptInput.official_proposal_snapshot)
  ].join("\n");
  assert.doesNotMatch(
    exposed,
    /latest_tally|known_neurons_ballots|voting_power|decision_timestamp|executed_timestamp|reward_status|ballots|proposer_name|dfinity_proposer|failure_reason|success_value|"proposer"/
  );
  assert.match(exposed, /transaction_fee_e8s/);
  assert.match(exposed, /safe_parameter/);
  assert.match(exposed, /reject_cost_e8s/);
  assert.deepEqual(Object.keys(snapshot.rawRecord).sort(), [
    "action",
    "payload",
    "proposal_id",
    "reject_cost_e8s",
    "status_at_capture",
    "summary",
    "title",
    "topic"
  ]);
  assert.equal(snapshot.rawRecord.action, "ManageNetworkEconomics");
  assert.equal(snapshot.rawRecord.status_at_capture, "OPEN");
  assert.equal(snapshot.statusAtCapture, "OPEN");
});

test("oversized proposal payload remains inside the public allowlist", () => {
  const snapshot = parseProposalDetailResponse(
    {
      proposal_id: 104,
      title: "Large proposal",
      summary: "Bound the public snapshot",
      topic: "Governance",
      url: "https://example.com/proposal-104",
      self_describing_action: "Motion",
      status: "OPEN",
      proposal_timestamp_seconds: 1,
      deadline_timestamp_seconds: 2,
      reject_cost_e8s: 3,
      payload: { motion_text: "x".repeat(20_000), ballots: { secret: true } }
    },
    104,
    "https://ic-api.internetcomputer.org/api/v3/proposals/104",
    "2026-08-20T00:00:00.000Z",
    800
  );

  assert.equal(snapshot.truncated, true);
  assert.ok(JSON.stringify(snapshot.rawRecord).length <= 800);
  assert.deepEqual(Object.keys(snapshot.rawRecord).sort(), [
    "action",
    "deadline_timestamp_seconds",
    "payload",
    "proposal_id",
    "proposal_timestamp_seconds",
    "reject_cost_e8s",
    "status_at_capture",
    "summary",
    "title",
    "topic",
    "url"
  ]);
  assert.equal(snapshot.rawRecord.action, "Motion");
  assert.equal(snapshot.rawRecord.reject_cost_e8s, 3);
  assert.equal("payload_truncated" in snapshot.rawRecord, false);
  assert.equal("payload_preview" in snapshot.rawRecord, false);
  assert.doesNotMatch(JSON.stringify(snapshot.rawRecord), /self_describing_action|ballots/);
});

test("only selected proposal actions receive focused review depth", () => {
  assert.equal(reviewDepthForAction("Motion"), "focused");
  assert.equal(reviewDepthForAction("ManageNetworkEconomics"), "focused");
  assert.equal(reviewDepthForAction("CreateServiceNervousSystem"), "focused");
  assert.equal(reviewDepthForAction("ExecuteNnsFunction"), "basic");
});

test("focused actions receive their action-specific review instructions", () => {
  const cases = [
    ["Motion", /non-binding scope/],
    ["ManageNetworkEconomics", /current baselines/],
    ["CreateServiceNervousSystem", /fallback controllers/],
    ["ExecuteNnsFunction", /generic review policy/]
  ] as const;
  for (const [action, expected] of cases) {
    const snapshot = parseProposalDetailResponse(
      { proposal_id: 200, title: "Review", status: "OPEN", action, payload: {} },
      200,
      "https://ic-api.internetcomputer.org/api/v3/proposals/200",
      "2026-08-20T00:00:00.000Z",
      300_000
    );
    assert.match(nnsReviewMessages(snapshot, DEFAULT_NNS_REVIEW_POLICY, null, 120_000)[0]?.content ?? "", expected);
  }
});

test("truncated proposal evidence cannot produce an adopt or reject recommendation", () => {
  const response = JSON.stringify(reviewCandidate("ADOPT"));
  assert.equal(parseNnsReviewText(response, true).recommendation, "NEEDS_CLARIFICATION");
  assert.equal(parseNnsReviewText(JSON.stringify(reviewCandidate("NEEDS_CLARIFICATION")), true).recommendation, "NEEDS_CLARIFICATION");
});

test("review pages contain the fixed English section contract and AI disclaimer", () => {
  const snapshot = parseProposalDetailResponse(
    {
      proposal_id: 102,
      title: "Motion example",
      summary: "A non-binding motion",
      topic: "Governance",
      proposer: "aaaaa-aa",
      action: "Motion",
      status: "OPEN",
      payload: { motion_text: "Do the thing" }
    },
    102,
    "https://ic-api.internetcomputer.org/api/v3/proposals/102",
    "2026-08-20T00:00:00.000Z",
    300_000
  );
  const source = proposalSourceNode(snapshot);
  const review = proposalReviewNode(snapshot, parseNnsReviewText(JSON.stringify(reviewCandidate("NEEDS_CLARIFICATION"))), "model", null);

  assert.match(source.content, /kinic\.nns_proposal_snapshot/);
  assert.equal(JSON.parse(review.metadataJson).generated_by, "nns-proposal-review-worker");
  assert.match(review.content, /## Executive Summary/);
  assert.match(review.content, /## Type-Specific Checks/);
  assert.match(review.content, /## AI-Generated Review Disclaimer/);
  assert.match(review.content, /recommendation: "NEEDS_CLARIFICATION"/);
});

test("non-open capture gets deterministic NOT_APPLICABLE without an AI draft", () => {
  const snapshot = parseProposalDetailResponse(
    { proposal_id: 103, title: "Closed", status: "EXECUTED", action: "Motion", payload: {} },
    103,
    "https://ic-api.internetcomputer.org/api/v3/proposals/103",
    "2026-08-20T00:00:00.000Z",
    300_000
  );
  const review = proposalReviewNode(snapshot, null, "unused", null);

  assert.equal(isOpenAtCapture(snapshot.statusAtCapture), false);
  assert.match(review.content, /review_status: "skipped_not_open"/);
  assert.match(review.content, /recommendation: "NOT_APPLICABLE"/);
  assert.match(review.content, /No AI analysis was run/);
});

function reviewCandidate(recommendation: "ADOPT" | "REJECT" | "NEEDS_CLARIFICATION"): Record<string, unknown> {
  return {
    executive_summary: "The proposal needs review.",
    proposed_action: "Change one parameter.",
    evidence_reviewed: ["Official proposal snapshot"],
    benefits: ["Possible benefit"],
    risks: ["Possible risk"],
    missing_information: ["Current baseline"],
    type_specific_checks: ["Baseline was not provided"],
    recommendation,
    rationale: "The captured evidence does not establish the current baseline."
  };
}
