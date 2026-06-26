import type { Identity } from "@icp-sdk/core/agent";
import { readNode, writeNodeAuthenticated } from "@/lib/vfs-client";
import { ensureParentFoldersAuthenticated } from "@/lib/vfs-folders";

export type SkillPackageFile = {
  name: string;
  content: string;
};

export type SkillPackageInput = {
  id: string;
  files: SkillPackageFile[];
};

const PRIVATE_ROOT = "/Skills";

export async function upsertSkillPackage(canisterId: string, databaseId: string, identity: Identity, input: SkillPackageInput): Promise<string[]> {
  const skillId = cleanSkillId(input.id);
  const files = normalizeFiles(input.files, skillId);
  const basePath = `${PRIVATE_ROOT}/${skillId}`;
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
  input: { source: string; reference: string; id: string }
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
  cleaned.set("manifest.md", normalizeManifestForSkill(skillId, cleaned.get("manifest.md") ?? manifestForSkill(skillId, skill), skill));
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
  const category = frontmatterValue(skill, "metadata.category");
  const license = frontmatterValue(skill, "license");
  return [
    "---",
    "kind: kinic.skill",
    "schema_version: 1",
    `id: ${JSON.stringify(skillId)}`,
    "version: \"0.1.0\"",
    "entry: SKILL.md",
    `title: ${JSON.stringify(title)}`,
    `summary: ${JSON.stringify(summary)}`,
    ...(category ? ["tags:", `  - ${JSON.stringify(category)}`] : []),
    "status: draft",
    ...(license ? ["provenance:", `  license: ${JSON.stringify(license)}`] : []),
    "---",
    `# ${title}`
  ].join("\n");
}

function normalizeManifestForSkill(skillId: string, content: string, skill: string): string {
  let next = content.startsWith("---\n") ? content : manifestForSkill(skillId, "");
  next = setRootFrontmatterField(next, "kind", "kinic.skill");
  next = setRootFrontmatterField(next, "schema_version", "1");
  next = setRootFrontmatterField(next, "id", skillId);
  next = setRootFrontmatterField(next, "entry", "SKILL.md");
  next = fillRootFrontmatterField(next, "title", frontmatterValue(skill, "metadata.title"));
  next = fillRootFrontmatterField(next, "summary", frontmatterValue(skill, "description"));
  next = fillListFrontmatterField(next, "tags", frontmatterValue(skill, "metadata.category"));
  next = fillNestedFrontmatterField(next, "provenance", "license", frontmatterValue(skill, "license"));
  return next;
}

function setManifestProvenance(content: string, source: GitHubSource, sha: string): string {
  const fields = [
    `  source: ${JSON.stringify(`github.com/${source.owner}/${source.repo}${source.path ? `/${source.path}` : ""}`)}`,
    `  source_url: ${JSON.stringify(`https://github.com/${source.owner}/${source.repo}/tree/${sha}${source.path ? `/${source.path}` : ""}`)}`,
    `  revision: ${JSON.stringify(sha)}`
  ];
  if (content.includes("\nprovenance:\n")) return content.replace(/\nprovenance:\n(?:  .+\n?)*/m, `\nprovenance:\n${fields.join("\n")}\n`);
  return insertBeforeFrontmatterTerminator(content, ["provenance:", ...fields]);
}

function setRootFrontmatterField(content: string, key: string, value: string): string {
  if (!content.startsWith("---\n")) throw new Error("manifest.md frontmatter is required.");
  const rest = content.slice(4);
  const end = frontmatterEnd(rest);
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

function fillRootFrontmatterField(content: string, key: string, value: string | null): string {
  if (!value || frontmatterValue(content, key)) return content;
  return setRootFrontmatterField(content, key, value);
}

function fillListFrontmatterField(content: string, key: string, value: string | null): string {
  if (!value || frontmatterHasListItems(content, key)) return content;
  return setListFrontmatterField(content, key, [value]);
}

function fillNestedFrontmatterField(content: string, parent: string, child: string, value: string | null): string {
  if (!value || frontmatterValue(content, `${parent}.${child}`)) return content;
  return setNestedFrontmatterField(content, parent, child, value);
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
  for (const target of markdownLinkTargets(content)) {
    const name = cleanPackageFileName(cleanMarkdownDestination(target));
    if (name) names.add(name);
  }
  return [...names];
}

function cleanSkillId(value: string): string {
  const id = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) || id.includes("..")) {
    throw new Error("Skill id must be a single path-safe segment.");
  }
  return id;
}

function cleanPackageFileName(value: string): string | null {
  const name = value.trim().replace(/^\.\//, "");
  if (!name.endsWith(".md") || name.startsWith("/") || name.includes("..") || name.includes("://")) return null;
  const segments = name.split("/");
  if (segments.some((segment) => !segment || segment === ".")) return null;
  return name;
}

function frontmatterValue(content: string, key: string): string | null {
  return frontmatterField(content, key)?.value ?? null;
}

function frontmatterField(content: string, key: string): { value: string } | null {
  if (!content.startsWith("---\n")) return null;
  const rest = content.slice(4);
  const start = frontmatterEnd(rest);
  if (start < 0) return null;
  const parent = key.split(".")[0];
  const child = key.split(".")[1];
  let inParent = false;
  for (const line of rest.slice(0, start).split("\n")) {
    if (!line.startsWith(" ") && !line.startsWith("\t")) {
      inParent = line.startsWith(`${parent}:`);
    }
    const match = child && inParent ? line.trim().match(new RegExp(`^${child}:\\s*(.*)$`)) : line.match(new RegExp(`^${key}:\\s*(.*)$`));
    if (match) return { value: cleanYaml(match[1]) };
  }
  return null;
}

function frontmatterHasListItems(content: string, key: string): boolean {
  if (!content.startsWith("---\n")) return false;
  const rest = content.slice(4);
  const end = frontmatterEnd(rest);
  if (end < 0) return false;
  let inList = false;
  for (const line of rest.slice(0, end).split("\n")) {
    if (!line.startsWith(" ") && !line.startsWith("\t")) {
      const match = line.match(/^([^:\s][^:]*):/);
      inList = Boolean(match && match[1].trim() === key);
      continue;
    }
    if (inList && line.trim().startsWith("- ")) return true;
  }
  return false;
}

function setListFrontmatterField(content: string, key: string, values: string[]): string {
  if (!content.startsWith("---\n")) throw new Error("manifest.md frontmatter is required.");
  const rest = content.slice(4);
  const end = frontmatterEnd(rest);
  if (end < 0) throw new Error("manifest.md frontmatter terminator is missing.");
  const lines = rest.slice(0, end).split("\n");
  const replacement = [key + ":", ...values.map((value) => `  - ${JSON.stringify(value)}`)];
  const index = lines.findIndex((line) => line.match(/^([^:\s][^:]*):/)?.[1].trim() === key);
  if (index < 0) return `---\n${[...lines, ...replacement].join("\n")}${rest.slice(end)}`;
  let after = index + 1;
  while (after < lines.length && (lines[after].startsWith(" ") || lines[after].startsWith("\t"))) after += 1;
  return `---\n${[...lines.slice(0, index), ...replacement, ...lines.slice(after)].join("\n")}${rest.slice(end)}`;
}

function setNestedFrontmatterField(content: string, parent: string, child: string, value: string): string {
  if (!content.startsWith("---\n")) throw new Error("manifest.md frontmatter is required.");
  const rest = content.slice(4);
  const end = frontmatterEnd(rest);
  if (end < 0) throw new Error("manifest.md frontmatter terminator is missing.");
  const lines = rest.slice(0, end).split("\n");
  let parentIndex = -1;
  let childIndex = -1;
  let inParent = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.startsWith(" ") && !line.startsWith("\t")) {
      const match = line.match(/^([^:\s][^:]*):/);
      inParent = Boolean(match && match[1].trim() === parent);
      if (inParent) parentIndex = index;
      continue;
    }
    if (inParent && line.trim().match(new RegExp(`^${child}:`))) {
      childIndex = index;
      break;
    }
  }
  const replacement = `  ${child}: ${JSON.stringify(value)}`;
  if (childIndex >= 0) {
    const next = [...lines];
    next[childIndex] = replacement;
    return `---\n${next.join("\n")}${rest.slice(end)}`;
  }
  if (parentIndex >= 0) {
    const next = [...lines.slice(0, parentIndex + 1), replacement, ...lines.slice(parentIndex + 1)];
    return `---\n${next.join("\n")}${rest.slice(end)}`;
  }
  return `---\n${[...lines, parent + ":", replacement].join("\n")}${rest.slice(end)}`;
}

function cleanGitHubPath(value: string): string | null {
  const path = value.trim().replace(/^\/+|\/+$/g, "");
  if (!path) return null;
  if (path.includes("..") || path.includes("://")) throw new Error("GitHub path is invalid.");
  return path;
}

function cleanYaml(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === "string") return parsed;
      throw new Error("Invalid quoted YAML scalar.");
    } catch {
      throw new Error("Invalid quoted YAML scalar.");
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1).replace(/''/g, "'");
  return trimmed;
}

function frontmatterEnd(rest: string): number {
  const match = rest.match(/\n---(?:\n|$)/);
  return match?.index ?? -1;
}

function insertBeforeFrontmatterTerminator(content: string, lines: string[]): string {
  if (!content.startsWith("---\n")) throw new Error("manifest.md frontmatter is required.");
  const rest = content.slice(4);
  const end = frontmatterEnd(rest);
  if (end < 0) throw new Error("manifest.md frontmatter terminator is missing.");
  const absoluteEnd = 4 + end;
  return `${content.slice(0, absoluteEnd)}\n${lines.join("\n")}${content.slice(absoluteEnd)}`;
}

function markdownLinkTargets(content: string): string[] {
  const targets: string[] = [];
  let index = 0;
  while (index < content.length) {
    const open = content.indexOf("](", index);
    if (open < 0) break;
    let cursor = open + 2;
    if (content[cursor] === "<") {
      const close = content.indexOf(">", cursor + 1);
      if (close >= 0 && content[close + 1] === ")") {
        targets.push(content.slice(cursor, close + 1));
        index = close + 2;
        continue;
      }
    }
    let depth = 0;
    while (cursor < content.length) {
      const char = content[cursor];
      if (char === "(") depth += 1;
      if (char === ")") {
        if (depth === 0) break;
        depth -= 1;
      }
      cursor += 1;
    }
    if (cursor < content.length) targets.push(content.slice(open + 2, cursor));
    index = cursor + 1;
  }
  return targets;
}

function cleanMarkdownDestination(value: string): string {
  const trimmed = value.trim();
  const withoutTitle = markdownDestinationWithoutTitle(trimmed);
  const destination = withoutTitle.startsWith("<") && withoutTitle.endsWith(">") ? withoutTitle.slice(1, -1) : withoutTitle;
  return destination.split(/[?#]/)[0]?.trim() ?? "";
}

function markdownDestinationWithoutTitle(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("<")) {
    const close = trimmed.indexOf(">");
    if (close > 0) {
      const destination = trimmed.slice(1, close);
      const suffix = trimmed.slice(close + 1).trim();
      if (!suffix || isMarkdownTitleSuffix(suffix)) return destination;
    }
  }
  return stripQuotedMarkdownTitle(trimmed, "\"") ?? stripQuotedMarkdownTitle(trimmed, "'") ?? stripParenthesizedMarkdownTitle(trimmed) ?? trimmed;
}

function stripQuotedMarkdownTitle(value: string, quote: string): string | null {
  if (!value.endsWith(quote)) return null;
  for (let index = value.length - 2; index > 0; index -= 1) {
    if (value[index] === quote && /\s/.test(value[index - 1] ?? "")) {
      const destination = value.slice(0, index - 1).trimEnd();
      if (isMarkdownDestinationCandidate(destination)) return destination;
    }
  }
  return null;
}

function stripParenthesizedMarkdownTitle(value: string): string | null {
  if (!value.endsWith(")")) return null;
  const titleStart = value.lastIndexOf(" (");
  if (titleStart < 0) return null;
  const destination = value.slice(0, titleStart).trimEnd();
  return isMarkdownDestinationCandidate(destination) ? destination : null;
}

function isMarkdownTitleSuffix(value: string): boolean {
  return (value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'")) || (value.startsWith("(") && value.endsWith(")"));
}

function isMarkdownDestinationCandidate(value: string): boolean {
  const unwrapped = value.startsWith("<") && value.endsWith(">") ? value.slice(1, -1) : value;
  const destination = unwrapped.split(/[?#]/)[0]?.trim() ?? "";
  return Boolean(destination && !destination.startsWith("#") && !destination.startsWith("/") && !destination.includes("://") && destination.endsWith(".md"));
}

function isCommitPayload(value: unknown): value is { sha: string } {
  return Boolean(value && typeof value === "object" && "sha" in value && typeof value.sha === "string" && /^[0-9a-f]{40}$/i.test(value.sha));
}
