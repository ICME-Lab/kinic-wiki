import type { Identity } from "@icp-sdk/core/agent";
import { splitMarkdownFrontmatter } from "@/lib/markdown-frontmatter";
import type { CatalogSkill, ProposalStatus, SkillEvent, SkillProposal, SkillRunEvidence, SkillRunSummary } from "@/lib/skill-registry-catalog";
import type { ChildNode } from "@/lib/types";
import { listChildren, readNode } from "@/lib/vfs-client";

const DETAIL_READ_CONCURRENCY = 4;

export async function loadSkillCatalogDetails(canisterId: string, databaseId: string, skills: CatalogSkill[], identity?: Identity): Promise<CatalogSkill[]> {
  return mapConcurrent(skills, DETAIL_READ_CONCURRENCY, (skill) => loadSkillDetails(canisterId, databaseId, skill, identity));
}

async function loadSkillDetails(canisterId: string, databaseId: string, skill: CatalogSkill, identity?: Identity): Promise<CatalogSkill> {
  const [children, runs, proposals, events] = await Promise.all([
    listRegistryChildren(canisterId, databaseId, skill.basePath, identity),
    loadRecentRuns(canisterId, databaseId, skill.manifest.id, identity),
    loadProposals(canisterId, databaseId, skill.basePath, identity),
    loadEvents(canisterId, databaseId, skill.manifest.id, identity)
  ]);
  const trust = summarizeRuns(runs);
  return {
    ...skill,
    missingFiles: missingPackageFiles(children),
    recentRuns: runs.slice(0, 5),
    proposals,
    runSummary: trust,
    trust,
    events
  };
}

async function loadRecentRuns(canisterId: string, databaseId: string, skillId: string, identity?: Identity): Promise<SkillRunEvidence[]> {
  const runDir = `/Sources/skill-runs/${skillId}`;
  const entries = await listRegistryChildren(canisterId, databaseId, runDir, identity);
  const nodes = await Promise.all(entries.filter(isFileEntry).slice(-100).map((entry) => readRegistryNode(canisterId, databaseId, entry.path, identity)));
  return nodes
    .flatMap((node) => (node ? [parseRunEvidence(node.path, node.content)] : []))
    .filter((run): run is SkillRunEvidence => Boolean(run))
    .sort((left, right) => right.recordedAt.localeCompare(left.recordedAt));
}

async function loadProposals(canisterId: string, databaseId: string, basePath: string, identity?: Identity): Promise<SkillProposal[]> {
  const entries = await listRegistryChildren(canisterId, databaseId, `${basePath}/proposals`, identity);
  const proposalDirs = entries.filter((entry) => entry.kind === "directory" || entry.kind === "folder");
  const proposals = await Promise.all(proposalDirs.map((entry) => loadEvolutionProposal(canisterId, databaseId, entry.path, identity)));
  return proposals.filter((proposal): proposal is SkillProposal => Boolean(proposal)).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

async function loadEvolutionProposal(canisterId: string, databaseId: string, proposalRoot: string, identity?: Identity): Promise<SkillProposal | null> {
  const parsedRoot = parseProposalRoot(proposalRoot);
  if (!parsedRoot) return null;
  const { skillId, proposalId: id } = parsedRoot;
  const candidatePath = `${proposalRoot}/candidate/SKILL.md`;
  const metricsPath = `${proposalRoot}/metrics.json`;
  const statusPath = `${proposalRoot}/status.md`;
  const [candidate, metrics, status] = await Promise.all([
    readRegistryNode(canisterId, databaseId, candidatePath, identity),
    readRegistryNode(canisterId, databaseId, metricsPath, identity),
    readRegistryNode(canisterId, databaseId, statusPath, identity)
  ]);
  if (!candidate || !metrics || !status) return null;
  const metricsJson = parseJsonObject(metrics.content);
  const baseEtag = stringField(metricsJson, "base_etag");
  const statusFields = frontmatterFields(status.content);
  const proposalStatus = parseProposalStatus(statusFields.status);
  if (!baseEtag) return null;
  if (statusFields.kind !== "kinic.skill_evolution_proposal_status" || statusFields.schema_version !== "1") return null;
  if (statusFields.skill_id !== skillId || statusFields.proposal_id !== id) return null;
  if (!proposalStatus || !statusFields.recorded_at || Number.isNaN(Date.parse(statusFields.recorded_at))) return null;
  return {
    proposalRoot,
    candidatePath,
    metricsPath,
    statusPath,
    id,
    title: id,
    status: proposalStatus,
    createdAt: stringField(metricsJson, "created_at") ?? statusFields.recorded_at,
    sourceRuns: arrayStringField(metricsJson, "source_runs"),
    candidatePreview: candidate.content.slice(0, 1200),
    baseEtag,
    appliedAt: statusFields.recorded_at,
    metricsPreview: metrics.content.slice(0, 2000)
  };
}

async function loadEvents(canisterId: string, databaseId: string, skillId: string, identity?: Identity): Promise<SkillEvent[]> {
  const entries = await listRegistryChildren(canisterId, databaseId, `/Sources/skill-events/${skillId}`, identity);
  const nodes = await Promise.all(entries.filter(isFileEntry).slice(-20).map((entry) => readRegistryNode(canisterId, databaseId, entry.path, identity)));
  return nodes
    .flatMap((node) => (node ? [parseEvent(node.path, node.content)] : []))
    .filter((event): event is SkillEvent => Boolean(event))
    .sort((left, right) => right.recordedAt.localeCompare(left.recordedAt))
    .slice(0, 5);
}

async function listRegistryChildren(canisterId: string, databaseId: string, path: string, identity?: Identity): Promise<ChildNode[]> {
  try {
    return await listChildren(canisterId, databaseId, path, identity);
  } catch {
    return [];
  }
}

async function readRegistryNode(canisterId: string, databaseId: string, path: string, identity?: Identity) {
  try {
    return await readNode(canisterId, databaseId, path, identity);
  } catch {
    return null;
  }
}

async function mapConcurrent<Input, Output>(items: Input[], concurrency: number, worker: (item: Input) => Promise<Output>): Promise<Output[]> {
  const results: Output[] = [];
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

function missingPackageFiles(children: ChildNode[]): string[] {
  const names = new Set(children.filter(isFileEntry).map((child) => child.name));
  return ["manifest.md", "SKILL.md"].filter((name) => !names.has(name));
}

function isFileEntry(entry: ChildNode): boolean {
  return entry.kind !== "directory" && entry.kind !== "folder";
}

function parseProposalStatus(value: string | undefined): ProposalStatus | null {
  if (value === "proposed" || value === "reviewed" || value === "auto_applied" || value === "gate_failed" || value === "conflict") return value;
  return null;
}

function parseProposalRoot(proposalRoot: string): { skillId: string; proposalId: string } | null {
  const match = proposalRoot.match(/^\/Wiki\/skills\/([^/]+)\/proposals\/([^/]+)$/);
  if (!match) return null;
  const [, skillId, proposalId] = match;
  if (!isSafePathSegment(skillId) || !isSafePathSegment(proposalId)) return null;
  return { skillId, proposalId };
}

function isSafePathSegment(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) && !value.includes("..");
}

function summarizeRuns(runs: SkillRunEvidence[]): SkillRunSummary {
  const summary: SkillRunSummary = { runs: 0, success: 0, partial: 0, fail: 0, lastUsedAt: null, lastOutcome: null };
  for (const run of runs) {
    summary.runs += 1;
    if (run.outcome === "success") summary.success += 1;
    else if (run.outcome === "partial") summary.partial += 1;
    else if (run.outcome === "fail") summary.fail += 1;
    if (run.recordedAt && (!summary.lastUsedAt || run.recordedAt > summary.lastUsedAt)) {
      summary.lastUsedAt = run.recordedAt;
      summary.lastOutcome = run.outcome;
    }
  }
  return summary;
}

function parseRunEvidence(path: string, content: string): SkillRunEvidence | null {
  const fields = frontmatterFields(content);
  if (fields.kind !== "kinic.skill_run") return null;
  return { path, outcome: fields.outcome ?? "unknown", task: fields.task ?? "", agent: fields.agent ?? "", recordedAt: fields.recorded_at ?? "" };
}

function parseEvent(path: string, content: string): SkillEvent | null {
  const fields = frontmatterFields(content);
  if (fields.kind !== "kinic.skill_event") return null;
  return { path, action: fields.action ?? "", actor: fields.actor ?? "", recordedAt: fields.recorded_at ?? "", targetPath: fields.target_path ?? "", result: fields.result ?? "" };
}

function frontmatterFields(content: string): Record<string, string> {
  return Object.fromEntries(splitMarkdownFrontmatter(content)?.fields.map((field) => [field.key, field.value]) ?? []);
}

function parseJsonObject(content: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(content);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function stringField(value: Record<string, unknown>, key: string): string | null {
  return typeof value[key] === "string" ? value[key] : null;
}

function arrayStringField(value: Record<string, unknown>, key: string): string[] {
  const field = value[key];
  return Array.isArray(field) ? field.filter((item): item is string => typeof item === "string") : [];
}
