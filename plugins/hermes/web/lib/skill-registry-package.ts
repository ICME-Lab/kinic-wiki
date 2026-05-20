import type { Identity } from "@icp-sdk/core/agent";
import { readNode, writeNodeAuthenticated } from "@/lib/vfs-client";
import { ensureParentFoldersAuthenticated } from "@/lib/vfs-folders";

export type SkillCatalog = "private" | "public";

export type SkillPackageFile = {
  name: string;
  content: string;
};

export type SkillPackageInput = {
  id: string;
  catalog: SkillCatalog;
  files: SkillPackageFile[];
};

const PRIVATE_ROOT = "/Wiki/skills";
const PUBLIC_ROOT = PRIVATE_ROOT;

export async function upsertSkillPackage(canisterId: string, databaseId: string, identity: Identity, input: SkillPackageInput): Promise<string[]> {
  const skillId = cleanSkillId(input.id);
  const files = normalizeFiles(input.files, skillId);
  const basePath = `${input.catalog === "public" ? PUBLIC_ROOT : PRIVATE_ROOT}/${skillId}`;
  const written: string[] = [];
  for (const file of files) {
    const path = `${basePath}/${file.name}`;
    await ensureParentFoldersAuthenticated(canisterId, databaseId, identity, path);
    const current = await readNode(canisterId, databaseId, path, identity);
    await writeNodeAuthenticated(canisterId, identity, {
      databaseId,
      path,
      kind: "file",
      content: file.content,
      metadataJson: current?.metadataJson ?? "{}",
      expectedEtag: current?.etag ?? null
    });
    written.push(path);
  }
  return written;
}

export async function importPublicGitHubSkill(
  canisterId: string,
  databaseId: string,
  identity: Identity,
  input: { source: string; reference: string; id: string; catalog: SkillCatalog }
): Promise<string[]> {
  const source = parseGitHubSource(input.source);
  const ref = input.reference.trim() || "main";
  const sha = await resolveGitHubRef(source, ref);
  const baseUrl = `https://raw.githubusercontent.com/${source.owner}/${source.repo}/${sha}/${source.path ? `${source.path}/` : ""}`;
  const skill = await fetchRequiredText(`${baseUrl}SKILL.md`, "SKILL.md");
  const files: SkillPackageFile[] = [{ name: "SKILL.md", content: skill }];
  for (const name of ["manifest.md", "provenance.md", "evals.md"]) {
    const content = await fetchOptionalText(`${baseUrl}${name}`);
    if (content) files.push({ name, content });
  }
  for (const name of markdownPackageLinks(skill)) {
    if (files.some((file) => file.name === name)) continue;
    const content = await fetchOptionalText(`${baseUrl}${name}`);
    if (content) files.push({ name, content });
  }
  const written = await upsertSkillPackage(canisterId, databaseId, identity, {
    id: input.id,
    catalog: input.catalog,
    files: normalizeGitHubManifest(files, input.id, source, sha)
  });
  return written;
}

function normalizeFiles(files: SkillPackageFile[], skillId: string): SkillPackageFile[] {
  const cleaned = new Map<string, string>();
  for (const file of files) {
    const name = cleanPackageFileName(file.name);
    if (name && file.content.trim()) cleaned.set(name, file.content);
  }
  const skill = cleaned.get("SKILL.md");
  if (!skill) throw new Error("SKILL.md is required.");
  cleaned.set("manifest.md", normalizeManifestForSkill(skillId, cleaned.get("manifest.md") ?? manifestForSkill(skillId, skill)));
  return [...cleaned.entries()].map(([name, content]) => ({ name, content })).sort((left, right) => left.name.localeCompare(right.name));
}

function normalizeGitHubManifest(files: SkillPackageFile[], skillId: string, source: GitHubSource, sha: string): SkillPackageFile[] {
  const normalized = normalizeFiles(files, skillId);
  const manifest = normalized.find((file) => file.name === "manifest.md");
  if (!manifest) return normalized;
  manifest.content = setManifestProvenance(manifest.content, source, sha);
  return normalized;
}

function manifestForSkill(skillId: string, skill: string): string {
  const title = frontmatterValue(skill, "metadata.title") ?? skillId;
  const summary = frontmatterValue(skill, "description") ?? "";
  return [
    "---",
    "kind: kinic.skill",
    "schema_version: 1",
    `id: ${JSON.stringify(skillId)}`,
    "version: \"0.1.0\"",
    "entry: SKILL.md",
    `title: ${JSON.stringify(title)}`,
    `summary: ${JSON.stringify(summary)}`,
    "status: draft",
    "---",
    `# ${title}`
  ].join("\n");
}

function normalizeManifestForSkill(skillId: string, content: string): string {
  let next = content.startsWith("---\n") ? content : manifestForSkill(skillId, "");
  next = setRootFrontmatterField(next, "kind", "kinic.skill");
  next = setRootFrontmatterField(next, "schema_version", "1");
  next = setRootFrontmatterField(next, "id", skillId);
  next = setRootFrontmatterField(next, "entry", "SKILL.md");
  return next;
}

function setManifestProvenance(content: string, source: GitHubSource, sha: string): string {
  const fields = [
    `  source: ${JSON.stringify(`github.com/${source.owner}/${source.repo}${source.path ? `/${source.path}` : ""}`)}`,
    `  source_url: ${JSON.stringify(`https://github.com/${source.owner}/${source.repo}/tree/${sha}${source.path ? `/${source.path}` : ""}`)}`,
    `  revision: ${JSON.stringify(sha)}`
  ];
  if (content.includes("\nprovenance:\n")) return content.replace(/\nprovenance:\n(?:  .+\n?)*/m, `\nprovenance:\n${fields.join("\n")}\n`);
  return content.replace(/\n---/, `\nprovenance:\n${fields.join("\n")}\n---`);
}

function setRootFrontmatterField(content: string, key: string, value: string): string {
  if (!content.startsWith("---\n")) throw new Error("manifest.md frontmatter is required.");
  const rest = content.slice(4);
  const end = rest.indexOf("\n---");
  if (end < 0) throw new Error("manifest.md frontmatter terminator is missing.");
  const lines = rest.slice(0, end).split("\n");
  let replaced = false;
  const next = lines.map((line) => {
    const match = line.match(/^([^:\s][^:]*):(.*)$/);
    if (!match || match[1].trim() !== key) return line;
    replaced = true;
    return `${key}: ${JSON.stringify(value)}`;
  });
  if (!replaced) next.push(`${key}: ${JSON.stringify(value)}`);
  return `---\n${next.join("\n")}${rest.slice(end)}`;
}

type GitHubSource = { owner: string; repo: string; path: string | null };

function parseGitHubSource(value: string): GitHubSource {
  const [repoPart, rawPath = ""] = value.trim().replace(/^https:\/\/github\.com\//, "").split(":");
  const parts = repoPart.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error("GitHub source must be owner/repo:path.");
  return { owner: parts[0], repo: parts[1], path: cleanGitHubPath(rawPath) };
}

async function resolveGitHubRef(source: GitHubSource, ref: string): Promise<string> {
  const response = await fetch(`https://api.github.com/repos/${source.owner}/${source.repo}/commits/${encodeURIComponent(ref)}`);
  if (!response.ok) throw new Error(`GitHub ref not found: ${ref}`);
  const payload: unknown = await response.json();
  if (!isCommitPayload(payload)) throw new Error("GitHub commit response is invalid.");
  return payload.sha;
}

async function fetchRequiredText(url: string, label: string): Promise<string> {
  const content = await fetchOptionalText(url);
  if (!content) throw new Error(`${label} missing in GitHub source.`);
  return content;
}

async function fetchOptionalText(url: string): Promise<string | null> {
  const response = await fetch(url);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub fetch failed: ${response.status}`);
  return response.text();
}

function markdownPackageLinks(content: string): string[] {
  const names = new Set<string>();
  for (const match of content.matchAll(/\]\(([^)]+)\)/g)) {
    const name = cleanPackageFileName(match[1].split(/[?#\s]/)[0] ?? "");
    if (name) names.add(name);
  }
  return [...names];
}

function cleanSkillId(value: string): string {
  const id = value.trim();
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) throw new Error("Skill id must use lowercase letters, numbers, _ or -.");
  return id;
}

function cleanPackageFileName(value: string): string | null {
  const name = value.trim().replace(/^\.\//, "");
  if (!name.endsWith(".md") || name.startsWith("/") || name.includes("..") || name.includes("://")) return null;
  return name;
}

function frontmatterValue(content: string, key: string): string | null {
  const start = content.startsWith("---\n") ? content.indexOf("\n---", 4) : -1;
  if (start < 0) return null;
  const parent = key.split(".")[0];
  let inParent = false;
  for (const line of content.slice(4, start).split("\n")) {
    if (line.startsWith(`${parent}:`)) inParent = true;
    const match = key.includes(".") && inParent ? line.trim().match(new RegExp(`^${key.split(".")[1]}:\\s*(.*)$`)) : line.match(new RegExp(`^${key}:\\s*(.*)$`));
    if (match) return cleanYaml(match[1]);
  }
  return null;
}

function cleanGitHubPath(value: string): string | null {
  const path = value.trim().replace(/^\/+|\/+$/g, "");
  if (!path) return null;
  if (path.includes("..") || path.includes("://")) throw new Error("GitHub path is invalid.");
  return path;
}

function cleanYaml(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("\"") && trimmed.endsWith("\"") ? trimmed.slice(1, -1) : trimmed;
}

function isCommitPayload(value: unknown): value is { sha: string } {
  return Boolean(value && typeof value === "object" && "sha" in value && typeof value.sha === "string" && /^[0-9a-f]{40}$/i.test(value.sha));
}
