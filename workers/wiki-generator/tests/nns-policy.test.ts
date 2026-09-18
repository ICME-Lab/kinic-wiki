// Where: workers/wiki-generator/tests/nns-policy.test.ts
// What: Strict Wiki policy contract tests.
// Why: A malformed or weakened mutable policy must fail closed.
import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_NNS_AUTOVOTE_POLICY, NnsPolicyError, parseNnsAutovotePolicy, policyAllowsVote } from "../src/nns-policy.js";

test("default policy evaluates in shadow and cannot vote", () => {
  const policy = parseNnsAutovotePolicy(DEFAULT_NNS_AUTOVOTE_POLICY);
  assert.equal(policy.actions.default?.evaluate, true);
  assert.equal(policyAllowsVote(policy, "Motion", "ADOPT"), false);
});

test("policy thresholds cannot weaken the code floor", () => {
  assert.throws(() => parseNnsAutovotePolicy(DEFAULT_NNS_AUTOVOTE_POLICY.replace("min_confidence: 0.90", "min_confidence: 0.89")), NnsPolicyError);
});

test("policy rejects unknown evidence, fields, and excessive rules", () => {
  assert.throws(() => parseNnsAutovotePolicy(DEFAULT_NNS_AUTOVOTE_POLICY.replace("[proposal, governance]", "[proposal, internet]")), NnsPolicyError);
  assert.throws(() => parseNnsAutovotePolicy(DEFAULT_NNS_AUTOVOTE_POLICY.replace("enabled: false", "enabled: false\nunknown: value")), NnsPolicyError);
  const rules = Array.from({ length: 33 }, (_, index) => `      - \"rule ${index}\"`).join("\n");
  assert.throws(() => parseNnsAutovotePolicy(DEFAULT_NNS_AUTOVOTE_POLICY.replace('      - "Use HOLD unless the captured evidence directly supports the decision."', rules)), NnsPolicyError);
});

test("policy can qualify ADOPT without enabling REJECT", () => {
  const live = DEFAULT_NNS_AUTOVOTE_POLICY
    .replace("enabled: false", "enabled: true")
    .replace("mode: shadow", "mode: live")
    .replace("auto_vote: false", "auto_vote: true\n    auto_vote_choices: [ADOPT]");
  const policy = parseNnsAutovotePolicy(live);
  assert.equal(policyAllowsVote(policy, "Motion", "ADOPT"), true);
  assert.equal(policyAllowsVote(policy, "Motion", "REJECT"), false);
});
