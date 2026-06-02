export type SkillManifest = {
  kind: string;
  schemaVersion: string;
  id: string;
  version: string;
  entry: string;
  title: string | null;
  summary: string | null;
  tags: string[];
  useCases: string[];
  status: string | null;
  replaces: string[];
  related: string[];
  knowledge: string[];
  permissions: Record<string, string>;
  provenance: Record<string, string>;
};

export type SkillAccessCapabilities = {
  read: boolean;
  publish: boolean;
  admin: boolean;
};

// Browser rendering intentionally supports only the v1 frontmatter subset used by Skill Registry.
// Rust CLI owns full YAML parsing and validation.
export function parseSkillManifest(content: string): SkillManifest | null {
  const frontmatter = extractFrontmatter(content);
  if (!frontmatter) return null;
  const values = parseFrontmatter(frontmatter);
  if (scalar(values, "kind") !== "kinic.skill") return null;
  if (scalar(values, "schema_version") !== "1") return null;
  const id = scalar(values, "id");
  const version = scalar(values, "version");
  const entry = scalar(values, "entry");
  if (!id || !version || !entry) return null;
  if (!isSafeSkillId(id)) return null;
  if (entry !== "SKILL.md") return null;
  return {
    kind: "kinic.skill",
    schemaVersion: "1",
    id,
    version,
    entry,
    title: scalar(values, "title"),
    summary: scalar(values, "summary"),
    tags: values.tags ?? [],
    useCases: values.use_cases ?? [],
    status: scalar(values, "status"),
    replaces: values.replaces ?? [],
    related: values.related ?? [],
    knowledge: values.knowledge ?? [],
    permissions: nested(values, "permissions"),
    provenance: nested(values, "provenance")
  };
}

function isSafeSkillId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) && !value.includes("..");
}

export function isSkillRegistryPath(path: string): boolean {
  return path === "/Wiki/skills" || path.startsWith("/Wiki/skills/");
}

export function isPublicSkillRegistryPath(path: string): boolean {
  return false;
}

export function isAnySkillRegistryPath(path: string): boolean {
  return isSkillRegistryPath(path) || isPublicSkillRegistryPath(path);
}

export function manifestPathForSkillRegistryFile(path: string): string | null {
  if (!isAnySkillRegistryPath(path) || path.endsWith("/manifest.md")) return null;
  for (const file of ["/SKILL.md", "/provenance.md", "/evals.md"]) {
    if (path.endsWith(file)) {
      return `${path.slice(0, -file.length)}/manifest.md`;
    }
  }
  return null;
}

export function skillAccessCapabilities(roles: string[]): SkillAccessCapabilities {
  const admin = roles.includes("Admin");
  const writer = admin || roles.includes("Writer");
  return {
    read: writer || roles.includes("Reader"),
    publish: writer,
    admin
  };
}

export function formatSkillAccessCapabilities(capabilities: SkillAccessCapabilities): string {
  return `read:${formatBoolean(capabilities.read)} publish:${formatBoolean(capabilities.publish)} admin:${formatBoolean(capabilities.admin)}`;
}

export function skillAccessHint(mode: string | null, roles: string[], authenticated: boolean): string | null {
  if (mode !== "restricted" || roles.length > 0) return null;
  return authenticated
    ? "restricted namespace: missing Reader, Writer, or Admin role"
    : "database role required";
}

function extractFrontmatter(content: string): string | null {
  if (!content.startsWith("---\n")) return null;
  const rest = content.slice(4);
  const match = rest.match(/\n---(?:\n|$)/);
  return match?.index === undefined ? null : rest.slice(0, match.index);
}

function formatBoolean(value: boolean): string {
  return value ? "yes" : "no";
}

function parseFrontmatter(frontmatter: string): Record<string, string[]> {
  const root: Record<string, string[]> = {};
  let current: string | null = null;
  for (const line of frontmatter.split("\n")) {
    if (!line.trim()) continue;
    const item = line.trimStart().match(/^-\s+(.+)$/);
    if (item && current) {
      root[current] = [...(root[current] ?? []), cleanValue(item[1])];
      continue;
    }
    if (line.startsWith("  ") && current) {
      const nestedMatch = line.trim().match(/^([^:]+):(.*)$/);
      if (nestedMatch) {
        root[`${current}.${nestedMatch[1].trim()}`] = [cleanValue(nestedMatch[2])];
      }
      continue;
    }
    const match = line.match(/^([^:]+):(.*)$/);
    if (match) {
      current = match[1].trim();
      const value = cleanValue(match[2]);
      root[current] = value ? [value] : [];
    }
  }
  return root;
}

function scalar(values: Record<string, string[]>, key: string): string | null {
  return values[key]?.[0] ?? null;
}

function nested(values: Record<string, string[]>, parent: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (key.startsWith(`${parent}.`)) {
      result[key.slice(parent.length + 1)] = value[0] ?? "";
    }
  }
  return result;
}

function cleanValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return typeof parsed === "string" ? parsed : "";
    } catch {
      return "";
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1).replace(/''/g, "'");
  return trimmed;
}
