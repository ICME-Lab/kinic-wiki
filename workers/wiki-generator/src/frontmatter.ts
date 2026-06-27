// Where: workers/wiki-generator/src/frontmatter.ts
// What: Small frontmatter parser/renderer for worker-owned ingest nodes.
// Why: source capture state needs deterministic metadata writes without a YAML dependency.
export type FrontmatterDocument = {
  fields: Record<string, string | null>;
  body: string;
};

type FrontmatterValue = string | number | boolean | null;

export function parseFrontmatter(content: string): FrontmatterDocument | null {
  if (!content.startsWith("---\n")) return null;
  const rest = content.slice(4);
  const terminator = frontmatterTerminator(rest);
  if (!terminator) return null;
  const fields: Record<string, string | null> = {};
  for (const line of rest.slice(0, terminator.index).split("\n")) {
    const match = line.match(/^([^:\s][^:]*):(.*)$/);
    if (!match) continue;
    fields[match[1].trim()] = parseScalar(match[2].trim());
  }
  return {
    fields,
    body: rest.slice(terminator.index + terminator.length)
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

function frontmatterTerminator(rest: string): { index: number; length: number } | null {
  const match = rest.match(/\n---(?:\n|$)/);
  if (!match || match.index === undefined) return null;
  return { index: match.index, length: match[0].length };
}

function formatScalar(value: FrontmatterValue): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return JSON.stringify(String(value));
}
