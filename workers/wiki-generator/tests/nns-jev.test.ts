// Where: workers/wiki-generator/tests/nns-jev.test.ts
// What: Jev schema validation, fixed decision gates, and retry tests.
// Why: Model output is untrusted input to a signing workflow.
import assert from "node:assert/strict";
import test from "node:test";
import { aggregateJevDecision, JevRequestError, parseJevResponse, requestJevDecision, type NnsJevAnswer } from "../src/nns-jev.js";
import { parseNnsAutovotePolicy, DEFAULT_NNS_AUTOVOTE_POLICY } from "../src/nns-policy.js";

const policy = parseNnsAutovotePolicy(DEFAULT_NNS_AUTOVOTE_POLICY);
const checks = {
  policyValid: true,
  proposalOpen: true,
  beforeDeadline: true,
  dashboardMatchesGovernance: true,
  actionKnown: true,
  requiredEvidenceComplete: true
};

test("Jev ADOPT requires every fixed probability gate", () => {
  assert.equal(aggregateJevDecision(answer("ADOPT"), policy, checks).outcome, "ADOPT");
  assert.equal(aggregateJevDecision(answer("ADOPT", { choice: 0.949 }), policy, checks).outcome, "HOLD");
  assert.equal(aggregateJevDecision(answer("ADOPT", { risk: 0.101 }), policy, checks).outcome, "HOLD");
});

test("Jev REJECT requires evidence-backed policy violation or material risk", () => {
  assert.equal(aggregateJevDecision(answer("REJECT", { violation: 0.96 }), policy, checks).outcome, "REJECT");
  assert.equal(aggregateJevDecision(answer("REJECT", { violation: 0.2, risk: 0.2 }), policy, checks).outcome, "HOLD");
  assert.equal(aggregateJevDecision(answer("REJECT", { evidence: 0.2, violation: 0.99 }), policy, checks).outcome, "HOLD");
});

test("any failed deterministic check forces HOLD", () => {
  assert.equal(aggregateJevDecision(answer("ADOPT"), policy, { ...checks, dashboardMatchesGovernance: false }).outcome, "HOLD");
  assert.equal(aggregateJevDecision(answer("ADOPT"), policy, { ...checks, policyValid: false }).outcome, "HOLD");
});

test("Jev response parser rejects unknown choices, missing fields, and invalid probabilities", () => {
  const valid = wireAnswer();
  assert.equal(parseJevResponse(valid).recommendation.choice, "ADOPT");
  assert.throws(() => parseJevResponse({ ...valid, answers: { ...(valid.answers as object), recommendation: { type: "choice", choice: "MAYBE", probabilities: {}, confidence: 1 } } }), JevRequestError);
  assert.throws(() => parseJevResponse({ answers: {} }), JevRequestError);
  const invalid = wireAnswer() as { answers: Record<string, { noul?: number }> };
  invalid.answers.violates_policy!.noul = Number.NaN;
  assert.throws(() => parseJevResponse(invalid), JevRequestError);
});

test("Jev client retries 429 and 529 within a fixed bound", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls += 1;
    if (calls < 3) return new Response("busy", { status: calls === 1 ? 429 : 529 });
    return Response.json(wireAnswer());
  };
  const result = await requestJevDecision({ proposal: 1 }, policy, "test-key", fetcher);
  assert.equal(result.answer.recommendation.choice, "ADOPT");
  assert.equal(calls, 3);
});

test("Jev client rejects oversized responses without retrying", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls += 1;
    return new Response("{}", { headers: { "content-length": String(300 * 1024) } });
  };
  await assert.rejects(requestJevDecision({}, policy, "test-key", fetcher), (error: unknown) =>
    error instanceof JevRequestError && error.code === "jev_response_too_large" && !error.retryable
  );
  assert.equal(calls, 1);
});

test("Jev client bounds timeout retries and then returns a typed error", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls += 1;
    throw new DOMException("timed out", "TimeoutError");
  };
  await assert.rejects(requestJevDecision({}, policy, "test-key", fetcher), (error: unknown) =>
    error instanceof JevRequestError && error.code === "jev_timeout"
  );
  assert.equal(calls, 3);
});

function answer(choice: "ADOPT" | "REJECT", overrides: { choice?: number; risk?: number; violation?: number; evidence?: number } = {}): NnsJevAnswer {
  const selected = overrides.choice ?? 0.96;
  return {
    recommendation: {
      choice,
      probabilities: choice === "ADOPT" ? { ADOPT: selected, REJECT: 0.02, HOLD: 1 - selected - 0.02 } : { ADOPT: 0.02, REJECT: selected, HOLD: 1 - selected - 0.02 },
      confidence: 0.95
    },
    descriptionMatchesPayload: 0.99,
    requiredEvidencePresent: overrides.evidence ?? 0.99,
    materialClaimsSupported: 0.99,
    violatesPolicy: overrides.violation ?? 0.01,
    materialUnboundedRisk: overrides.risk ?? 0.01
  };
}

function wireAnswer(): Record<string, unknown> {
  return {
    model: "jev-test",
    answers: {
      recommendation: { type: "choice", choice: "ADOPT", probabilities: { ADOPT: 0.97, REJECT: 0.01, HOLD: 0.02 }, confidence: 0.95 },
      description_matches_payload: { type: "noul", noul: 0.99 },
      required_evidence_present: { type: "noul", noul: 0.99 },
      material_claims_supported: { type: "noul", noul: 0.99 },
      violates_policy: { type: "noul", noul: 0.01 },
      material_unbounded_risk: { type: "noul", noul: 0.01 }
    }
  };
}
