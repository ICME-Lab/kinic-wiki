import type { Identity } from "@icp-sdk/core/agent";
import type { CatalogSkill, SkillProposal } from "@/lib/skill-registry-catalog";
import type { WikiNode } from "@/lib/types";
import { readNode, writeNodeAuthenticated } from "@/lib/vfs-client";
import { ensureParentFoldersAuthenticated } from "@/lib/vfs-folders";

export type ProposalDiffPreview = {
  proposalPath: string;
  targetPath: string;
  nextContent: string;
  currentEtag: string;
  metadataJson: string;
  additions: number;
  removals: number;
};

export async function previewApplyProposalDiff(canisterId: string, databaseId: string, identity: Identity, skill: CatalogSkill, proposal: SkillProposal): Promise<ProposalDiffPreview> {
  const [current, candidate, metrics] = await Promise.all([
    requireNode(canisterId, databaseId, `${skill.basePath}/SKILL.md`, identity),
    requireNode(canisterId, databaseId, proposal.candidatePath, identity),
    requireNode(canisterId, databaseId, proposal.metricsPath, identity)
  ]);
  assertProposalGates(metrics.content);
  if (proposal.baseEtag && proposal.baseEtag !== current.etag) {
    throw new Error("Current SKILL.md etag no longer matches proposal base_etag.");
  }
  const counts = lineDelta(current.content, candidate.content);
  return {
    proposalPath: proposal.proposalRoot,
    targetPath: `${skill.basePath}/SKILL.md`,
    nextContent: candidate.content,
    currentEtag: current.etag,
    metadataJson: current.metadataJson,
    additions: counts.additions,
    removals: counts.removals
  };
}

export async function applyProposalDiff(canisterId: string, databaseId: string, identity: Identity, proposal: SkillProposal, preview: ProposalDiffPreview): Promise<void> {
  const basePath = preview.targetPath.replace(/\/SKILL\.md$/, "");
  const current = await requireNode(canisterId, databaseId, preview.targetPath, identity);
  if (current.etag !== preview.currentEtag) throw new Error("Current SKILL.md changed since preview.");
  const [manifest, metrics] = await Promise.all([
    readNode(canisterId, databaseId, `${basePath}/manifest.md`, identity),
    requireNode(canisterId, databaseId, proposal.metricsPath, identity)
  ]);
  assertProposalGates(metrics.content);
  const versionId = `${Date.now()}-${(await sha256Hex(current.content)).slice(0, 12)}`;
  const versionBase = `${basePath}/versions/${versionId}`;
  const versionSkillPath = `${versionBase}/SKILL.md`;
  await ensureParentFoldersAuthenticated(canisterId, databaseId, identity, versionSkillPath);
  await writeNodeAuthenticated(canisterId, identity, {
    databaseId,
    path: versionSkillPath,
    kind: "file",
    content: current.content,
    metadataJson: "{}",
    expectedEtag: null
  });
  if (manifest) {
    await writeNodeAuthenticated(canisterId, identity, {
      databaseId,
      path: `${versionBase}/manifest.md`,
      kind: "file",
      content: manifest.content,
      metadataJson: "{}",
      expectedEtag: null
    });
  }
  await writeNodeAuthenticated(canisterId, identity, {
    databaseId,
    path: preview.targetPath,
    kind: "file",
    content: preview.nextContent,
    metadataJson: preview.metadataJson,
    expectedEtag: preview.currentEtag
  });
  const statusPath = `${proposal.proposalRoot}/status.md`;
  await ensureParentFoldersAuthenticated(canisterId, databaseId, identity, statusPath);
  await writeNodeAuthenticated(canisterId, identity, {
    databaseId,
    path: statusPath,
    kind: "file",
    content: ["---", "kind: kinic.skill_evolution_proposal_status", "schema_version: 1", `proposal_id: ${JSON.stringify(proposal.id)}`, "status: auto_applied", `recorded_at: ${new Date().toISOString()}`, "---", "# Proposal Status"].join("\n"),
    metadataJson: "{}",
    expectedEtag: null
  });
}

async function requireNode(canisterId: string, databaseId: string, path: string, identity: Identity): Promise<WikiNode> {
  const node = await readNode(canisterId, databaseId, path, identity);
  if (!node) throw new Error(`Node not found: ${path}`);
  return node;
}

function lineDelta(before: string, after: string): { additions: number; removals: number } {
  const beforeLines = new Set(before.split("\n"));
  const afterLines = new Set(after.split("\n"));
  return {
    additions: [...afterLines].filter((line) => !beforeLines.has(line)).length,
    removals: [...beforeLines].filter((line) => !afterLines.has(line)).length
  };
}

function assertProposalGates(metricsContent: string): void {
  const metrics = parseJsonObject(metricsContent);
  for (const gate of ["candidate_score_gate", "semantic_drift_gate", "permission_gate"]) {
    if (gateStatus(metrics, gate) !== "pass") {
      throw new Error(`Proposal gate failed: ${gate}`);
    }
  }
}

function gateStatus(metrics: Record<string, unknown>, gate: string): string | null {
  const topLevel = metrics[gate];
  if (typeof topLevel === "string") return topLevel;
  const gates = metrics.gates;
  if (!gates || typeof gates !== "object" || Array.isArray(gates)) return null;
  const value = (gates as Record<string, unknown>)[gate];
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const status = (value as Record<string, unknown>).status;
    return typeof status === "string" ? status : null;
  }
  return null;
}

function parseJsonObject(content: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(content);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function sha256Hex(content: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
