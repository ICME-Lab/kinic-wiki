// Where: workers/wiki-generator/src/nns-voter.ts
// What: Private Queue consumer that preflights, submits, reconciles, and publishes one NNS vote.
// Why: A dedicated boundary keeps the neuron hotkey out of all review and generation code.
import { parseFrontmatter } from "./frontmatter.js";
import { createNnsGovernanceClient, NNS_PROPOSAL_STATUS_OPEN, type NnsGovernanceClient } from "./nns-governance.js";
import { NNS_AUTOVOTE_POLICY_PATH, loadNnsPolicyNode, policyAllowsVote, type LoadedNnsPolicy } from "./nns-policy.js";
import { createVfsClient, type VfsClient } from "./vfs.js";
import type { NnsVoterEnv } from "./nns-voter-env.js";
import { claimVoteIntent, loadVoteIntent, publishVoteRecord, setVoteStatus, type NnsVoteRow } from "./nns-voter-jobs.js";
import type { NnsVoteIntent } from "./types.js";

const FINAL_ATTEMPT = 5;

export default {
  async fetch(request): Promise<Response> {
    if (request.method === "GET" && new URL(request.url).pathname === "/healthz") return Response.json({ ok: true });
    return Response.json({ error: "not found" }, { status: 404 });
  },
  async queue(batch, env): Promise<void> {
    for (const message of batch.messages) await processMessage(env, message);
  }
} satisfies ExportedHandler<NnsVoterEnv, NnsVoteIntent>;

export async function processVoteIntentForTest(
  env: NnsVoterEnv,
  intent: NnsVoteIntent,
  owner = "vote-test-owner",
  context: { vfs?: VfsClient; governance?: NnsGovernanceClient; now?: () => Date } = {}
): Promise<NnsVoteRow> {
  const config = voterConfig(env);
  const vfs = context.vfs ?? (await createVfsClient(config, env.KINIC_NNS_VOTER_WIKI_IDENTITY_PEM));
  const claimed = await claimVoteIntent(vfs, intent, owner, context.now?.() ?? new Date());
  if (claimed.kind === "busy") throw new Error("vote intent is busy");
  if (claimed.kind === "conflict") return claimed.row;
  if (claimed.kind === "terminal") return publishVoteRecord(vfs, intent.databaseId, intent.proposalId);
  const reconciling = claimed.row.status === "submitting" || claimed.row.status === "accepted" || claimed.row.status === "unknown";
  if (!reconciling) {
    if (!config.enabled) return finish(env, intent, owner, "held", "autovote_disabled", vfs);
    if (intent.neuronId !== config.neuronId || intent.databaseId !== config.databaseId) {
      return finish(env, intent, owner, "conflict", "configured_target_mismatch", vfs);
    }
    const [policyNode, decisionNode] = await Promise.all([
      vfs.readNode(intent.databaseId, NNS_AUTOVOTE_POLICY_PATH),
      vfs.readNode(intent.databaseId, `/Knowledge/nns/proposals/${intent.proposalId}/decision.md`)
    ]);
    let policy;
    try { policy = await loadNnsPolicyNode(policyNode); }
    catch { return finish(env, intent, owner, "held", "policy_invalid", vfs); }
    const choice = intent.vote === "YES" ? "ADOPT" : "REJECT";
    if (!policy.valid || policy.hash !== intent.policyHash) {
      await env.NNS_PROPOSAL_REVIEW_QUEUE.send({
        kind: "nns_proposal_review", databaseId: intent.databaseId, proposalId: Number(intent.proposalId),
        reason: "policy_changed", previousDecisionId: intent.decisionHash
      });
      return finish(env, intent, owner, "held", "policy_changed", vfs);
    }
    if (!policyAllowsVote(policy.policy, intent.action, choice)) {
      return finish(env, intent, owner, "held", "policy_disallows_vote", vfs);
    }
    const fields = decisionNode ? parseFrontmatter(decisionNode.content)?.fields : null;
    if (!fields
      || fields.proposal_id !== intent.proposalId
      || fields.action !== intent.action
      || fields.outcome !== choice
      || fields.auto_vote_eligible !== "true"
      || fields.decision_id !== intent.decisionHash
      || fields.evidence_hash !== intent.evidenceHash
      || fields.policy_hash !== intent.policyHash) {
      return finish(env, intent, owner, "held", "decision_artifact_mismatch", vfs);
    }
  }
  const governance = context.governance ?? (await createNnsGovernanceClient(config.icHost, env.KINIC_NNS_VOTER_IDENTITY_PEM));
  const proposalId = BigInt(intent.proposalId);
  const neuronId = BigInt(intent.neuronId);
  const proposal = await governance.getProposal(proposalId);
  const nowSeconds = Math.floor((context.now?.() ?? new Date()).getTime() / 1000);
  const deadline = proposal?.deadlineTimestampSeconds ? Number(proposal.deadlineTimestampSeconds) : Number.NaN;
  if (!proposal) {
    return finish(env, intent, owner, reconciling ? "unknown" : "expired", reconciling ? "proposal_unavailable_during_reconciliation" : "proposal_not_open", vfs);
  }
  if (!reconciling && (proposal.status !== NNS_PROPOSAL_STATUS_OPEN || !Number.isFinite(deadline) || deadline <= nowSeconds)) {
    return finish(env, intent, owner, "expired", "proposal_not_open", vfs);
  }
  const proposalBallot = proposal.ballots[intent.neuronId];
  if (!proposalBallot || BigInt(proposalBallot.votingPower) <= 0n) {
    if (reconciling) return finish(env, intent, owner, "unknown", "ballot_unavailable_during_reconciliation", vfs);
    return finish(env, intent, owner, "held", "neuron_not_eligible", vfs);
  }
  const observedProposalVote = proposalBallot.vote === 1 ? "YES" : proposalBallot.vote === 2 ? "NO" : null;
  if (observedProposalVote) {
    return finish(env, intent, owner, observedProposalVote === intent.vote ? "confirmed" : "conflict", "existing_proposal_ballot", vfs);
  }
  let neuron;
  try {
    neuron = await governance.getNeuron(neuronId, proposalId);
  } catch (error) {
    if (reconciling) return finish(env, intent, owner, "unknown", "neuron_unavailable_during_reconciliation", vfs);
    throw error;
  }
  if (!neuron.authorized) {
    return finish(
      env,
      intent,
      owner,
      reconciling ? "unknown" : "held",
      reconciling ? "hotkey_not_authorized_during_reconciliation" : "hotkey_not_authorized",
      vfs
    );
  }
  if (neuron.existingVote) {
    return finish(env, intent, owner, neuron.existingVote === intent.vote ? "confirmed" : "conflict", "existing_ballot", vfs);
  }
  if (claimed.row.status === "submitting") {
    return finish(env, intent, owner, "unknown", "submission_interrupted_before_outcome_persisted", vfs);
  }
  if (claimed.row.status === "accepted" || claimed.row.status === "unknown") {
    return finish(env, intent, owner, claimed.row.status, claimed.row.lastError, vfs);
  }
  await transition(vfs, intent, owner, "simulating");
  try { await governance.simulateVote(neuronId, proposalId, intent.vote); }
  catch { return finish(env, intent, owner, "failed", "vote_simulation_failed", vfs); }
  const currentPolicyNode = await vfs.readNode(intent.databaseId, NNS_AUTOVOTE_POLICY_PATH);
  if (!currentPolicyNode) throw new Error("automatic-voting policy is missing before submission");
  let currentPolicy: LoadedNnsPolicy;
  try {
    currentPolicy = await loadNnsPolicyNode(currentPolicyNode);
  } catch { return holdForPolicyChange(env, intent, owner, vfs); }
  const choice = intent.vote === "YES" ? "ADOPT" : "REJECT";
  if (currentPolicy.hash !== intent.policyHash || !policyAllowsVote(currentPolicy.policy, intent.action, choice)) {
    return holdForPolicyChange(env, intent, owner, vfs);
  }
  await transition(vfs, intent, owner, "submitting");
  try {
    await governance.registerVote(neuronId, proposalId, intent.vote);
    await transition(vfs, intent, owner, "accepted");
  } catch {
    await transition(vfs, intent, owner, "unknown", "vote_submission_unknown");
  }
  try {
    const after = await governance.getNeuron(neuronId, proposalId);
    if (after.existingVote === intent.vote) return finish(env, intent, owner, "confirmed", null, vfs);
    if (after.existingVote) return finish(env, intent, owner, "conflict", "different_ballot_observed", vfs);
  } catch { /* Persist accepted/unknown below; never resend automatically. */ }
  const current = await loadVoteIntent(vfs, intent.databaseId, intent.neuronId, intent.proposalId);
  return finish(env, intent, owner, current?.status === "accepted" ? "accepted" : "unknown", current?.lastError ?? null, vfs);
}

async function holdForPolicyChange(
  env: NnsVoterEnv,
  intent: NnsVoteIntent,
  owner: string,
  vfs: VfsClient
): Promise<NnsVoteRow> {
  await env.NNS_PROPOSAL_REVIEW_QUEUE.send({
    kind: "nns_proposal_review",
    databaseId: intent.databaseId,
    proposalId: Number(intent.proposalId),
    reason: "policy_changed",
    previousDecisionId: intent.decisionHash
  });
  return finish(env, intent, owner, "held", "policy_changed", vfs);
}

async function processMessage(env: NnsVoterEnv, message: Message<unknown>): Promise<void> {
  const intent = parseVoteIntent(message.body);
  if (!intent) return deadLetter(env, message, null, "nns_vote_intent_invalid");
  try {
    await processVoteIntentForTest(env, intent, message.id);
    message.ack();
  } catch (error) {
    if (message.attempts < FINAL_ATTEMPT) return message.retry({ delaySeconds: Math.min(300, 15 * 2 ** (message.attempts - 1)) });
    await deadLetter(env, message, intent, error instanceof Error ? error.name : "nns_vote_failed");
  }
}

async function finish(
  env: NnsVoterEnv, intent: NnsVoteIntent, owner: string, status: NnsVoteRow["status"], error: string | null, vfs: VfsClient
): Promise<NnsVoteRow> {
  await setVoteStatus(vfs, intent, owner, status, error, true);
  return publishVoteRecord(vfs, intent.databaseId, intent.proposalId);
}

async function transition(
  vfs: VfsClient, intent: NnsVoteIntent, owner: string, status: NnsVoteRow["status"], error: string | null = null
): Promise<NnsVoteRow> {
  await setVoteStatus(vfs, intent, owner, status, error);
  return publishVoteRecord(vfs, intent.databaseId, intent.proposalId);
}

function voterConfig(env: NnsVoterEnv): { enabled: boolean; neuronId: string; databaseId: string; canisterId: string; icHost: string } {
  const neuronId = env.KINIC_NNS_VOTER_NEURON_ID?.trim() ?? "";
  const databaseId = env.KINIC_NNS_AUDIT_DATABASE_ID?.trim() ?? "";
  if (!/^[1-9][0-9]*$/.test(neuronId)) throw new Error("KINIC_NNS_VOTER_NEURON_ID is required");
  if (!databaseId) throw new Error("KINIC_NNS_AUDIT_DATABASE_ID is required");
  return {
    enabled: env.KINIC_NNS_AUTOVOTE_ENABLED === "true", neuronId, databaseId,
    canisterId: env.KINIC_WIKI_CANISTER_ID, icHost: env.KINIC_WIKI_IC_HOST || "https://icp0.io"
  };
}

export function parseVoteIntent(value: unknown): NnsVoteIntent | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  if (item.kind !== "nns_vote_intent" || item.vote !== "YES" && item.vote !== "NO") return null;
  const strings = ["databaseId", "proposalId", "neuronId", "action", "decisionHash", "policyHash", "evidenceHash", "decidedAt"] as const;
  if (strings.some((key) => typeof item[key] !== "string" || !(item[key] as string).trim())) return null;
  if (!/^[1-9][0-9]*$/.test(item.proposalId as string) || !/^[1-9][0-9]*$/.test(item.neuronId as string)) return null;
  if (!Number.isSafeInteger(Number(item.proposalId))) return null;
  return item as unknown as NnsVoteIntent;
}

async function deadLetter(env: NnsVoterEnv, message: Message<unknown>, intent: NnsVoteIntent | null, errorCode: string): Promise<void> {
  try {
    await env.NNS_VOTE_DLQ.send({ proposalId: intent?.proposalId, neuronId: intent?.neuronId, errorCode, failedAt: new Date().toISOString() });
    message.ack();
  } catch { message.retry({ delaySeconds: 300 }); }
}
