// Where: workers/wiki-generator/src/nns-voter-jobs.ts
// What: Wiki-backed idempotency and state transitions for signed NNS votes.
// Why: Vote intent, ambiguity, and confirmation must remain visible beside the public decision.
import { renderFrontmatter } from "./frontmatter.js";
import type { NnsVoteIntent, NnsVoteStatus, WikiNode } from "./types.js";
import { ensureParentFolders, NodeMutationError, type VfsClient } from "./vfs.js";

const LEASE_MS = 5 * 60 * 1000;

export type NnsVoteRow = NnsVoteIntent & {
  status: NnsVoteStatus;
  lastError: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  updatedAt: string;
  publicationPending: boolean;
};

export async function claimVoteIntent(
  vfs: VfsClient,
  intent: NnsVoteIntent,
  owner: string,
  now = new Date()
): Promise<{ kind: "claimed"; row: NnsVoteRow } | { kind: "busy" } | { kind: "terminal"; row: NnsVoteRow } | { kind: "conflict"; row: NnsVoteRow }> {
  let loaded = await loadVoteNode(vfs, intent.databaseId, intent.proposalId);
  const nowIso = now.toISOString();
  if (!loaded) {
    const planned: NnsVoteRow = {
      ...intent, status: "planned", lastError: null, leaseOwner: null, leaseExpiresAt: null, updatedAt: nowIso,
      publicationPending: true
    };
    try { await writeVote(vfs, planned, null); }
    catch (error) {
      if (!(error instanceof NodeMutationError) || error.code !== "etag_conflict") throw error;
    }
    loaded = await loadVoteNode(vfs, intent.databaseId, intent.proposalId);
    if (!loaded) throw new Error("Wiki vote intent was not persisted");
  }
  let current = loaded.row;
  if (!sameIntent(current, intent)) {
    if (!["planned", "held", "failed"].includes(current.status) || current.leaseOwner) {
      return { kind: "conflict", row: current };
    }
    current = {
      ...intent, status: "planned", lastError: null, leaseOwner: null, leaseExpiresAt: null, updatedAt: nowIso,
      publicationPending: true
    };
    await writeVote(vfs, current, loaded.node.etag);
    loaded = await loadVoteNode(vfs, intent.databaseId, intent.proposalId);
    if (!loaded) throw new Error("replacement Wiki vote intent was not persisted");
  }
  if (terminal(current.status)) return { kind: "terminal", row: current };
  if (current.leaseOwner && current.leaseOwner !== owner && current.leaseExpiresAt && Date.parse(current.leaseExpiresAt) > now.getTime()) {
    return { kind: "busy" };
  }
  const claimed: NnsVoteRow = {
    ...current,
    leaseOwner: owner,
    leaseExpiresAt: new Date(now.getTime() + LEASE_MS).toISOString(),
    updatedAt: nowIso
  };
  try { await writeVote(vfs, claimed, loaded.node.etag); }
  catch (error) {
    if (error instanceof NodeMutationError && error.code === "etag_conflict") return { kind: "busy" };
    throw error;
  }
  return { kind: "claimed", row: claimed };
}

export async function setVoteStatus(
  vfs: VfsClient,
  intent: Pick<NnsVoteIntent, "databaseId" | "neuronId" | "proposalId">,
  owner: string,
  status: NnsVoteStatus,
  error: string | null = null,
  release = false,
  now = new Date()
): Promise<NnsVoteRow> {
  const loaded = await loadVoteNode(vfs, intent.databaseId, intent.proposalId);
  if (!loaded || loaded.row.neuronId !== intent.neuronId || loaded.row.leaseOwner !== owner) {
    throw new Error("Wiki vote intent lease was lost");
  }
  const row: NnsVoteRow = {
    ...loaded.row,
    status,
    lastError: error?.slice(0, 500) ?? null,
    leaseOwner: release ? null : loaded.row.leaseOwner,
    leaseExpiresAt: release ? null : loaded.row.leaseExpiresAt,
    updatedAt: now.toISOString(),
    publicationPending: true
  };
  await writeVote(vfs, row, loaded.node.etag);
  return row;
}

export async function loadVoteIntent(vfs: VfsClient, databaseId: string, neuronId: string, proposalId: string): Promise<NnsVoteRow | null> {
  const loaded = await loadVoteNode(vfs, databaseId, proposalId);
  return loaded?.row.neuronId === neuronId ? loaded.row : null;
}

async function loadVoteNode(vfs: VfsClient, databaseId: string, proposalId: string): Promise<{ node: WikiNode; row: NnsVoteRow } | null> {
  const node = await vfs.readNode(databaseId, votePath(proposalId));
  if (!node) return null;
  const match = node.content.match(/```json\n([\s\S]*?)\n```/);
  if (!match) throw new Error("Wiki vote state is invalid");
  return { node, row: JSON.parse(match[1]!) as NnsVoteRow };
}

export async function publishVoteRecord(vfs: VfsClient, databaseId: string, proposalId: string): Promise<NnsVoteRow> {
  const loaded = await loadVoteNode(vfs, databaseId, proposalId);
  if (!loaded) throw new Error("Wiki vote state is missing");
  const row = loaded.row;
  const path = publicVotePath(proposalId);
  const existing = await vfs.readNode(databaseId, path);
  const publishedRow = { ...row, publicationPending: false };
  const content = renderVoteRecord(publishedRow);
  if (existing?.kind !== "file" || existing.content !== content) {
    await ensureParentFolders(vfs, databaseId, path);
    await vfs.writeNode({
      databaseId, path, kind: "file", content,
      metadataJson: JSON.stringify({
        kind: "kinic.nns_vote_record", schema_version: 3, proposal_id: row.proposalId,
        neuron_id: row.neuronId, status: row.status
      }),
      expectedEtag: existing?.etag ?? null
    });
  }
  if (!row.publicationPending) return row;
  const updated = publishedRow;
  await writeVote(vfs, updated, loaded.node.etag);
  return updated;
}

async function writeVote(vfs: VfsClient, row: NnsVoteRow, expectedEtag: string | null): Promise<void> {
  const path = votePath(row.proposalId);
  await ensureParentFolders(vfs, row.databaseId, path);
  const content = renderFrontmatter({
    kind: "kinic.nns_vote_state", schema_version: 3, proposal_id: row.proposalId,
    status: row.status, updated_at: row.updatedAt
  }, `# NNS vote state\n\n\`\`\`json\n${JSON.stringify(row, null, 2)}\n\`\`\``);
  await vfs.writeNode({
    databaseId: row.databaseId, path, kind: "file", content,
    metadataJson: JSON.stringify({ kind: "kinic.nns_vote_state", schema_version: 3 }), expectedEtag
  });
}

function renderVoteRecord(row: NnsVoteRow): string {
  const content = renderFrontmatter({
    kind: "kinic.nns_vote_record",
    schema_version: 3,
    proposal_id: row.proposalId,
    neuron_id: row.neuronId,
    vote: row.vote,
    status: row.status,
    decision_id: row.decisionHash,
    policy_hash: row.policyHash,
    evidence_hash: row.evidenceHash,
    decided_at: row.decidedAt,
    updated_at: row.updatedAt
  }, [
    `# NNS Proposal ${row.proposalId} Vote`,
    "",
    `- Intended vote: **${row.vote}**`,
    `- Status: **${row.status}**`,
    `- Detail: ${row.lastError ?? "none"}`,
    "",
    "> This page is the public projection of the ETag-protected voter state under /Knowledge/nns/system/votes.",
    "> A submitting, accepted, or unknown state is reconciled and is never automatically resent.",
    "",
    "```json",
    JSON.stringify(row, null, 2),
    "```"
  ].join("\n"));
  return content;
}

function votePath(proposalId: string): string {
  return `/Knowledge/nns/system/votes/${proposalId}.md`;
}

function publicVotePath(proposalId: string): string {
  return `/Knowledge/nns/proposals/${proposalId}/vote.md`;
}

function sameIntent(row: NnsVoteRow, intent: NnsVoteIntent): boolean {
  return row.databaseId === intent.databaseId && row.action === intent.action && row.vote === intent.vote
    && row.decisionHash === intent.decisionHash && row.policyHash === intent.policyHash
    && row.evidenceHash === intent.evidenceHash;
}

function terminal(status: NnsVoteStatus): boolean {
  return ["confirmed", "held", "conflict", "expired", "failed"].includes(status);
}
