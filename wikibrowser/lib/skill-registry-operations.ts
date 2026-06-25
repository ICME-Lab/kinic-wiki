import type { Identity } from "@icp-sdk/core/agent";
import type { CatalogSkill } from "@/lib/skill-registry-catalog";
import type { WikiNode } from "@/lib/types";
import { readNode, writeNodeAuthenticated } from "@/lib/vfs-client";
import { ensureParentFoldersAuthenticated } from "@/lib/vfs-folders";

export type SkillStatus = "draft" | "reviewed" | "promoted" | "deprecated";
export type RunOutcome = "success" | "partial" | "fail";

export async function updateSkillStatus(
  canisterId: string,
  databaseId: string,
  identity: Identity,
  skill: CatalogSkill,
  status: SkillStatus,
  reason: string
): Promise<void> {
  const node = await requireNode(canisterId, databaseId, skill.manifestPath, identity);
  const updates: Record<string, string | null> = { status };
  if (status === "promoted") updates.promoted_at = new Date().toISOString();
  if (status === "deprecated") {
    updates.deprecated_at = new Date().toISOString();
    if (reason.trim()) updates.deprecated_reason = reason.trim();
  }
  if (status !== "promoted") updates.promoted_at = null;
  if (status !== "deprecated") {
    updates.deprecated_at = null;
    updates.deprecated_reason = null;
  }
  await writeNodeAuthenticated(canisterId, identity, {
    databaseId,
    path: skill.manifestPath,
    kind: "file",
    content: replaceRootFrontmatter(node.content, updates),
    metadataJson: node.metadataJson,
    expectedEtag: node.etag
  });
  await recordSkillEvent(canisterId, databaseId, identity, skill.manifest.id, {
    action: `status.${status}`,
    targetPath: skill.manifestPath,
    result: "success"
  });
}

export async function recordSkillRun(
  canisterId: string,
  databaseId: string,
  identity: Identity,
  skill: CatalogSkill,
  input: { task: string; outcome: RunOutcome; agent: string; notes: string }
): Promise<void> {
  const manifestNode = await requireNode(canisterId, databaseId, skill.manifestPath, identity);
  const skillNode = await requireNode(canisterId, databaseId, `${skill.basePath}/SKILL.md`, identity);
  const now = new Date().toISOString();
  const task = input.task.trim();
  const agent = input.agent.trim() || "browser";
  const path = `/Sources/skill-runs/${skill.manifest.id}/${Date.now()}.md`;
  const content = [
    "---",
    "kind: kinic.skill_run",
    "schema_version: 1",
    `skill_id: ${quoteYaml(skill.manifest.id)}`,
    `skill_hash: ${await sha256Hex(skillNode.content)}`,
    `manifest_hash: ${await sha256Hex(manifestNode.content)}`,
    `task: ${quoteYaml(task)}`,
    `task_hash: ${await sha256Hex(task)}`,
    `outcome: ${input.outcome}`,
    `agent: ${quoteYaml(agent)}`,
    "recorded_by: browser",
    `recorded_at: ${now}`,
    "---",
    "# Skill Run",
    "",
    input.notes.trim() || "- no notes"
  ].join("\n");
  await ensureParentFoldersAuthenticated(canisterId, databaseId, identity, path);
  await writeNodeAuthenticated(canisterId, identity, {
    databaseId,
    path,
    kind: "source",
    content,
    metadataJson: "{}",
    expectedEtag: null
  });
  await recordSkillEvent(canisterId, databaseId, identity, skill.manifest.id, {
    action: "run.record",
    targetPath: path,
    result: input.outcome
  });
}

export async function recordSkillEvent(
  canisterId: string,
  databaseId: string,
  identity: Identity,
  skillId: string,
  input: { action: string; targetPath: string; result: string }
): Promise<void> {
  const now = new Date().toISOString();
  const actor = identity.getPrincipal().toText();
  const path = `/Sources/skill-events/${skillId}/${Date.now()}.md`;
  const content = [
    "---",
    "kind: kinic.skill_event",
    "schema_version: 1",
    `skill_id: ${quoteYaml(skillId)}`,
    `action: ${quoteYaml(input.action)}`,
    `actor: ${quoteYaml(actor)}`,
    `recorded_at: ${now}`,
    `target_path: ${quoteYaml(input.targetPath)}`,
    `result: ${quoteYaml(input.result)}`,
    "---",
    "# Skill Event"
  ].join("\n");
  await ensureParentFoldersAuthenticated(canisterId, databaseId, identity, path);
  await writeNodeAuthenticated(canisterId, identity, {
    databaseId,
    path,
    kind: "file",
    content,
    metadataJson: "{}",
    expectedEtag: null
  });
}

async function requireNode(canisterId: string, databaseId: string, path: string, identity: Identity): Promise<WikiNode> {
  const node = await readNode(canisterId, databaseId, path, identity);
  if (!node) throw new Error(`Node not found: ${path}`);
  return node;
}

function replaceRootFrontmatter(content: string, updates: Record<string, string | null>): string {
  if (!content.startsWith("---\n")) throw new Error("Markdown frontmatter is missing.");
  const rest = content.slice(4);
  const end = frontmatterEnd(rest);
  if (end < 0) throw new Error("Markdown frontmatter terminator is missing.");
  const lines = rest.slice(0, end).split("\n");
  const pending = new Set(Object.keys(updates));
  const replaced = lines.map((line) => {
    const match = line.match(/^([^:\s][^:]*):(.*)$/);
    if (!match) return line;
    const key = match[1].trim();
    if (!(key in updates)) return line;
    pending.delete(key);
    const update = updates[key];
    if (update === null) return null;
    return `${key}: ${quoteYaml(update)}`;
  }).filter((line): line is string => line !== null);
  for (const key of pending) {
    const update = updates[key];
    if (update === null) continue;
    replaced.push(`${key}: ${quoteYaml(update)}`);
  }
  return `---\n${replaced.join("\n")}${rest.slice(end)}`;
}

function frontmatterEnd(rest: string): number {
  const match = rest.match(/\n---(?:\n|$)/);
  return match?.index ?? -1;
}

function quoteYaml(value: string): string {
  return JSON.stringify(value);
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
