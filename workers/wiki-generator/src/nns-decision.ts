// Where: workers/wiki-generator/src/nns-decision.ts
// What: Decision evidence composition and deterministic Wiki rendering.
// Why: The signed vote must be traceable without trusting generated prose.
import { renderFrontmatter } from "./frontmatter.js";
import { actionDefinition } from "./nns-actions.js";
import type { GovernanceProposalSnapshot } from "./nns-governance.js";
import type { NnsJevDecision, NnsDeterministicChecks } from "./nns-jev.js";
import { actionPolicy, policyAllowsVote, sha256Hex, type LoadedNnsPolicy } from "./nns-policy.js";
import type { NnsArtifactNode, NnsProposalSnapshot } from "./nns-review.js";
import type { FetchedUrlSource } from "./url-fetch.js";

export type NnsDecisionRecord = {
  schemaVersion: 1;
  decisionId: string;
  proposalId: number;
  action: string;
  outcome: "ADOPT" | "REJECT" | "HOLD";
  autoVoteEligible: boolean;
  policyVersion: string;
  policyHash: string;
  policyEtag: string;
  evidenceHash: string;
  decidedAt: string;
  checks: NnsDeterministicChecks;
  jev: NnsJevDecision;
};

export async function buildDecisionRecord(input: {
  snapshot: NnsProposalSnapshot;
  governance: GovernanceProposalSnapshot | null;
  reference: FetchedUrlSource | null;
  references?: FetchedUrlSource[];
  policy: LoadedNnsPolicy;
  decision: NnsJevDecision;
  checks: NnsDeterministicChecks;
  decidedAt: string;
}): Promise<NnsDecisionRecord> {
  const modelMatchesPolicy = input.decision.model === input.policy.policy.jevModel;
  const decision = modelMatchesPolicy ? input.decision : {
    ...input.decision,
    autoVoteEligible: false,
    reasons: [...input.decision.reasons, "jev_model_changed_requires_shadow"]
  };
  const evidenceHash = await sha256Hex(canonicalJson({
    proposal: input.snapshot.rawRecord,
    governance: input.governance,
    references: (input.references ?? (input.reference ? [input.reference] : [])).map((reference) => ({
      url: reference.finalUrl,
      text: reference.text,
      truncated: reference.fetchedTruncated
    }))
  }));
  const decisionId = await sha256Hex(canonicalJson({
    proposalId: input.snapshot.proposalId,
    policyHash: input.policy.hash,
    evidenceHash,
    outcome: decision.outcome,
    model: decision.model,
    answer: decision.answer,
    checks: input.checks
  }));
  const definition = actionDefinition(input.snapshot.action);
  const selectedPolicy = actionPolicy(input.policy.policy, input.snapshot.action);
  return {
    schemaVersion: 1,
    decisionId,
    proposalId: input.snapshot.proposalId,
    action: input.snapshot.action,
    outcome: decision.outcome,
    autoVoteEligible: decision.autoVoteEligible
      && Boolean(definition?.autoVoteSupported)
      && selectedPolicy.autoVote
      && input.policy.valid
      && policyAllowsVote(input.policy.policy, input.snapshot.action, decision.outcome === "HOLD" ? undefined : decision.outcome),
    policyVersion: input.policy.policy.policyVersion,
    policyHash: input.policy.hash,
    policyEtag: input.policy.etag,
    evidenceHash,
    decidedAt: input.decidedAt,
    checks: input.checks,
    jev: decision
  };
}

export function governanceNode(snapshot: NnsProposalSnapshot, governance: GovernanceProposalSnapshot | null): NnsArtifactNode {
  const path = `/Sources/nns/proposals/${snapshot.proposalId}/governance.md`;
  const content = renderFrontmatter(
    {
      kind: "kinic.nns_governance_snapshot",
      schema_version: 1,
      proposal_id: snapshot.proposalId,
      captured_at: governance?.capturedAt ?? snapshot.capturedAt,
      available: governance !== null
    },
    [
      `# NNS Governance Snapshot ${snapshot.proposalId}`,
      "",
      governance ? "```json\n" + JSON.stringify(governance, null, 2) + "\n```" : "The proposal was not present in the authoritative pending-proposal response."
    ].join("\n")
  );
  return { path, kind: "source", content, metadataJson: JSON.stringify({ kind: "kinic.nns_governance_snapshot", proposal_id: snapshot.proposalId }) };
}

export function decisionNode(record: NnsDecisionRecord): NnsArtifactNode {
  const path = `/Knowledge/nns/proposals/${record.proposalId}/decision.md`;
  const checks = Object.entries(record.checks).map(([name, passed]) => `- ${passed ? "PASS" : "FAIL"}: ${name}`).join("\n");
  const probabilities = record.jev.answer?.recommendation.probabilities;
  const body = [
    `# NNS Proposal ${record.proposalId} Decision`,
    "",
    `**${record.outcome}**`,
    "",
    `Automatic vote eligible: ${record.autoVoteEligible ? "yes" : "no"}`,
    "",
    "## Deterministic checks",
    "",
    checks,
    "",
    "## Jev result",
    "",
    `- Model: ${record.jev.model}`,
    `- Confidence: ${record.jev.answer?.recommendation.confidence ?? "unavailable"}`,
    `- Choice probabilities: ${probabilities ? JSON.stringify(probabilities) : "unavailable"}`,
    `- Description matches payload: ${record.jev.answer?.descriptionMatchesPayload ?? "unavailable"}`,
    `- Required evidence present: ${record.jev.answer?.requiredEvidencePresent ?? "unavailable"}`,
    `- Material claims supported: ${record.jev.answer?.materialClaimsSupported ?? "unavailable"}`,
    `- Violates policy: ${record.jev.answer?.violatesPolicy ?? "unavailable"}`,
    `- Material unbounded risk: ${record.jev.answer?.materialUnboundedRisk ?? "unavailable"}`,
    `- Reasons: ${record.jev.reasons.join(", ")}`,
    "",
    "## Reproducibility identifiers",
    "",
    `- Policy version: ${record.policyVersion}`,
    `- Policy hash: ${record.policyHash}`,
    `- Policy ETag: ${record.policyEtag}`,
    `- Evidence hash: ${record.evidenceHash}`,
    `- Decision ID: ${record.decisionId}`,
    "",
    "> Jev returns constrained probabilistic judgments. This page records the exact gates used by code; it is not a proof that the judgment is correct."
  ].join("\n");
  return {
    path,
    kind: "file",
    content: renderFrontmatter({
      kind: "kinic.nns_proposal_decision",
      schema_version: 1,
      proposal_id: record.proposalId,
      action: record.action,
      outcome: record.outcome,
      auto_vote_eligible: record.autoVoteEligible,
      policy_version: record.policyVersion,
      policy_hash: record.policyHash,
      policy_etag: record.policyEtag,
      evidence_hash: record.evidenceHash,
      decision_id: record.decisionId,
      decided_at: record.decidedAt
    }, body),
    metadataJson: JSON.stringify({
      kind: "kinic.nns_proposal_decision",
      proposal_id: record.proposalId,
      outcome: record.outcome,
      decision_id: record.decisionId,
      policy_hash: record.policyHash,
      evidence_hash: record.evidenceHash
    })
  };
}

export function decisionHistoryNode(record: NnsDecisionRecord): NnsArtifactNode {
  const current = decisionNode(record);
  return {
    ...current,
    path: `/Knowledge/nns/proposals/${record.proposalId}/decisions/${record.decisionId}.md`,
    content: current.content.replace(
      "> Jev returns constrained probabilistic judgments. This page records the exact gates used by code; it is not a proof that the judgment is correct.",
      `> Immutable decision history. Current decision: [decision.md](<../decision.md>).\n\n\`\`\`json\n${JSON.stringify(record, null, 2)}\n\`\`\``
    ),
    metadataJson: JSON.stringify({
      kind: "kinic.nns_proposal_decision_history", schema_version: 1,
      proposal_id: record.proposalId, decision_id: record.decisionId
    })
  };
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sortValue(item)]));
  }
  return value;
}
