import type { Identity } from "@icp-sdk/core/agent";
import { parseSkillManifest, type SkillManifest } from "@/lib/skill-manifest";
import type { ChildNode } from "@/lib/types";
import { listChildren, readNode } from "@/lib/vfs-client";

const REGISTRY_ROOTS = [
  { label: "Team", path: "/Wiki/skills", catalog: "private" }
] as const;
const MANIFEST_READ_CONCURRENCY = 8;

export type StatusFilter = "active" | "all" | "deprecated";

export type CatalogSkill = {
  catalog: "private" | "public";
  rootLabel: string;
  basePath: string;
  manifestPath: string;
  manifest: SkillManifest;
  missingFiles: string[];
  currentSkill: string;
  versions: SkillVersion[];
  corrections: SkillCorrection[];
  recentRuns: SkillRunEvidence[];
  proposals: SkillProposal[];
  runSummary: SkillRunSummary;
  trust: SkillRunSummary;
  events: SkillEvent[];
};

export type SkillRunEvidence = {
  path: string;
  outcome: string;
  taskOutcome: string;
  agentOutcome: string;
  task: string;
  agent: string;
  recordedAt: string;
};

export type SkillProposal = {
  proposalRoot: string;
  candidatePath: string;
  metricsPath: string;
  statusPath: string | null;
  id: string;
  title: string;
  status: string;
  createdAt: string;
  sourceRuns: string[];
  candidatePreview: string;
  baseEtag: string | null;
  appliedAt: string | null;
  metricsPreview: string;
};

export type SkillVersion = {
  path: string;
  updatedAt: string;
};

export type SkillCorrection = {
  path: string;
  recordedAt: string;
  preview: string;
};

export type EvolutionJob = {
  path: string;
  jobId: string;
  skillId: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  proposalId: string | null;
  error: string | null;
};

export type SkillEvent = {
  path: string;
  action: string;
  actor: string;
  recordedAt: string;
  targetPath: string;
  result: string;
};

export type SkillRunSummary = {
  runs: number;
  success: number;
  partial: number;
  fail: number;
  lastUsedAt: string | null;
  lastOutcome: string | null;
};

export type CatalogSummary = {
  total: number;
  promoted: number;
  reviewed: number;
  draft: number;
  deprecated: number;
};

export async function loadSkillCatalog(canisterId: string, databaseId: string, identity?: Identity): Promise<CatalogSkill[]> {
  const entryGroups = await Promise.all(
    REGISTRY_ROOTS.map(async (root) => {
      const entries = await listRegistryChildren(canisterId, databaseId, root.path, identity);
      return entries.filter((entry) => entry.kind === "directory" || entry.kind === "folder").map((entry) => ({ root, entry }));
    })
  );
  const loaded = await mapConcurrent<(typeof entryGroups)[number][number], CatalogSkill | null>(entryGroups.flat(), MANIFEST_READ_CONCURRENCY, async ({ root, entry }) => {
    const manifestPath = `${entry.path}/manifest.md`;
    const node = await readRegistryNode(canisterId, databaseId, manifestPath, identity);
    const manifest = node ? parseSkillManifest(node.content) : null;
    if (!manifest) return null;
    const trust = emptyRunSummary();
    return {
      catalog: root.catalog,
      rootLabel: root.label,
      basePath: entry.path,
      manifestPath,
      manifest,
      missingFiles: [],
      currentSkill: "",
      versions: [],
      corrections: [],
      recentRuns: [],
      proposals: [],
      runSummary: trust,
      trust,
      events: []
    };
  });
  return loaded.filter(isCatalogSkill).sort(compareSkills);
}

export function filterSkills(skills: CatalogSkill[], query: string, statusFilter: StatusFilter): CatalogSkill[] {
  const normalized = query.trim().toLowerCase();
  return skills.filter((skill) => {
    const status = skill.manifest.status ?? "draft";
    if (statusFilter === "active" && status === "deprecated") return false;
    if (statusFilter === "deprecated" && status !== "deprecated") return false;
    if (!normalized) return true;
    return searchableSkillText(skill).includes(normalized);
  });
}

export function summarizeSkills(skills: CatalogSkill[]): CatalogSummary {
  const summary: CatalogSummary = { total: skills.length, promoted: 0, reviewed: 0, draft: 0, deprecated: 0 };
  for (const skill of skills) {
    const status = skill.manifest.status ?? "draft";
    if (status === "promoted") summary.promoted += 1;
    else if (status === "reviewed") summary.reviewed += 1;
    else if (status === "deprecated") summary.deprecated += 1;
    else summary.draft += 1;
  }
  return summary;
}

export function statusRank(status: string | null): number {
  if (status === "promoted") return 0;
  if (status === "reviewed") return 1;
  if (status === "draft" || !status) return 2;
  if (status === "deprecated") return 3;
  return 4;
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

function emptyRunSummary(): SkillRunSummary {
  return { runs: 0, success: 0, partial: 0, fail: 0, lastUsedAt: null, lastOutcome: null };
}

function isCatalogSkill(skill: CatalogSkill | null): skill is CatalogSkill {
  return skill !== null;
}

function compareSkills(left: CatalogSkill, right: CatalogSkill): number {
  return statusRank(left.manifest.status) - statusRank(right.manifest.status) || left.manifest.id.localeCompare(right.manifest.id);
}

function searchableSkillText(skill: CatalogSkill): string {
  const manifest = skill.manifest;
  return [
    skill.catalog,
    skill.basePath,
    manifest.id,
    manifest.title,
    manifest.summary,
    manifest.status,
    manifest.version,
    ...manifest.tags,
    ...manifest.useCases,
    ...manifest.knowledge,
    ...manifest.related,
    ...Object.values(manifest.provenance)
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
}
