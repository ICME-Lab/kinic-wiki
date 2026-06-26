import type { Identity } from "@icp-sdk/core/agent";
import { splitMarkdownFrontmatter } from "@/lib/markdown-frontmatter";
import type { CatalogSkill, SkillCorrection, SkillEvent, SkillRunEvidence, SkillRunSummary, SkillVersion } from "@/lib/skill-registry-catalog";
import type { ChildNode } from "@/lib/types";
import { listChildren, readNode } from "@/lib/vfs-client";

const DETAIL_READ_CONCURRENCY = 4;

export async function loadSkillCatalogDetails(canisterId: string, databaseId: string, skills: CatalogSkill[], identity?: Identity): Promise<CatalogSkill[]> {
  return mapConcurrent(skills, DETAIL_READ_CONCURRENCY, (skill) => loadSkillDetails(canisterId, databaseId, skill, identity));
}

async function loadSkillDetails(canisterId: string, databaseId: string, skill: CatalogSkill, identity?: Identity): Promise<CatalogSkill> {
  const [children, currentSkill, runs, corrections, versions, events] = await Promise.all([
    listRegistryChildren(canisterId, databaseId, skill.basePath, identity),
    readRegistryNode(canisterId, databaseId, `${skill.basePath}/SKILL.md`, identity),
    loadRecentRuns(canisterId, databaseId, skill.manifest.id, identity),
    loadCorrections(canisterId, databaseId, skill.manifest.id, identity),
    loadVersions(canisterId, databaseId, skill.basePath, identity),
    loadEvents(canisterId, databaseId, skill.manifest.id, identity)
  ]);
  const trust = summarizeRuns(runs);
  return {
    ...skill,
    missingFiles: missingPackageFiles(children),
    currentSkill: currentSkill?.content ?? "",
    corrections,
    recentRuns: runs.slice(0, 5),
    versions,
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

async function loadVersions(canisterId: string, databaseId: string, basePath: string, identity?: Identity): Promise<SkillVersion[]> {
  const entries = await listRegistryChildren(canisterId, databaseId, `${basePath}/versions`, identity);
  return entries
    .filter((entry) => entry.kind === "directory" || entry.kind === "folder")
    .map((entry) => ({ path: entry.path, updatedAt: String(entry.updatedAt ?? "") }))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 20);
}

async function loadCorrections(canisterId: string, databaseId: string, skillId: string, identity?: Identity): Promise<SkillCorrection[]> {
  const entries = await listRegistryChildren(canisterId, databaseId, `/Sources/skill-runs/${skillId}`, identity);
  const nodes = await Promise.all(entries.filter(isFileEntry).filter((entry) => entry.path.includes(".correction.") || entry.path.includes("shadow-correction-")).slice(-50).map((entry) => readRegistryNode(canisterId, databaseId, entry.path, identity)));
  return nodes
    .flatMap((node) => (node ? [parseCorrection(node.path, node.content)] : []))
    .sort((left, right) => right.recordedAt.localeCompare(left.recordedAt));
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
  const taskOutcome = fields.task_outcome ?? fields.outcome ?? "unknown";
  const agentOutcome = fields.agent_outcome ?? fields.outcome ?? "unknown";
  return { path, outcome: agentOutcome, taskOutcome, agentOutcome, task: fields.task ?? "", agent: fields.agent ?? "", recordedAt: fields.recorded_at ?? "" };
}

function parseEvent(path: string, content: string): SkillEvent | null {
  const fields = frontmatterFields(content);
  if (fields.kind !== "kinic.skill_event") return null;
  return { path, action: fields.action ?? "", actor: fields.actor ?? "", recordedAt: fields.recorded_at ?? "", targetPath: fields.target_path ?? "", result: fields.result ?? "" };
}

function parseCorrection(path: string, content: string): SkillCorrection {
  const fields = frontmatterFields(content);
  return { path, recordedAt: fields.recorded_at ?? "", preview: content.slice(0, 1000) };
}

function frontmatterFields(content: string): Record<string, string> {
  return Object.fromEntries(splitMarkdownFrontmatter(content)?.fields.map((field) => [field.key, field.value]) ?? []);
}
