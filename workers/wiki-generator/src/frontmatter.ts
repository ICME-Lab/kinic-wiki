// Where: workers/wiki-generator/src/frontmatter.ts
// What: Small frontmatter parser/renderer for worker-owned ingest nodes.
// Why: URL ingest state needs deterministic metadata writes without a YAML dependency.
export type FrontmatterDocument = {
  fields: Record<string, string | null>;
  body: string;
};

type FrontmatterValue = string | number | boolean | null;

export function parseFrontmatter(content: string): FrontmatterDocument | null {
  if (!content.startsWith("---\n")) return null;
  const rest = content.slice(4);
  const end = rest.indexOf("\n---");
  if (end < 0) return null;
  const fields: Record<string, string | null> = {};
  for (const line of rest.slice(0, end).split("\n")) {
    const match = line.match(/^([^:\s][^:]*):(.*)$/);
    if (!match) continue;
    fields[match[1].trim()] = parseScalar(match[2].trim());
  }
  return {
    fields,
    body: rest.slice(end + 4).replace(/^\n/, "")
  };
}

export function renderFrontmatter(fields: Record<string, FrontmatterValue>, body: string): string {
  const lines = Object.entries(fields).map(([key, value]) => `${key}: ${formatScalar(value)}`);
  return `---\n${lines.join("\n")}\n---\n\n${body.trimStart()}`;
}

function parseScalar(value: string): string | null {
  if (value === "null") return null;
  if (value.startsWith('"') && value.endsWith('"')) {
    return JSON.parse(value);
  }
  return value;
}

function formatScalar(value: FrontmatterValue): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return JSON.stringify(String(value));
}
