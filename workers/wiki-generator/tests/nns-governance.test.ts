// Where: workers/wiki-generator/tests/nns-governance.test.ts
// What: Dashboard/Governance authoritative snapshot comparison tests.
// Why: A mismatched topic, action, or payload must stop automatic voting.
import assert from "node:assert/strict";
import test from "node:test";
import { dashboardMatchesGovernance, type GovernanceProposalSnapshot } from "../src/nns-governance.js";

const governance: GovernanceProposalSnapshot = {
  proposalId: "101", status: 1, topic: 4, deadlineTimestampSeconds: "2000000000",
  title: "Proposal 101", summary: "Summary", url: "", action: "Motion", actionDescription: "Motion",
  actionValue: { motion_text: "Do the thing", limit: "42" }, ballots: {}, capturedAt: "2026-08-20T00:00:00.000Z"
};

test("matching Dashboard and Governance snapshots accept numeric JSON representations", () => {
  assert.equal(dashboardMatchesGovernance({
    proposalId: 101, action: "ACTION_MOTION", topic: "TOPIC_GOVERNANCE", summary: "Summary",
    rawRecord: { payload: { limit: 42, motion_text: "Do the thing" } }
  }, governance), true);
});

test("topic, action, summary, and payload mismatches fail closed", () => {
  const base = { proposalId: 101, action: "Motion", topic: "Governance", summary: "Summary", rawRecord: { payload: governance.actionValue } };
  assert.equal(dashboardMatchesGovernance({ ...base, topic: "NodeAdmin" }, governance), false);
  assert.equal(dashboardMatchesGovernance({ ...base, action: "ManageNetworkEconomics" }, governance), false);
  assert.equal(dashboardMatchesGovernance({ ...base, summary: "Different" }, governance), false);
  assert.equal(dashboardMatchesGovernance({ ...base, rawRecord: { payload: { motion_text: "Changed", limit: 42 } } }, governance), false);
});
