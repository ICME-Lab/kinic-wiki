export type FrontmatterField = {
  key: string;
  value: string;
};

export type MarkdownFrontmatter = {
  fields: FrontmatterField[];
  body: string;
};

export function splitMarkdownFrontmatter(content: string): MarkdownFrontmatter | null {
  if (!content.startsWith("---\n")) return null;
  const rest = content.slice(4);
  const end = rest.indexOf("\n---");
  if (end < 0) return null;
  const frontmatter = rest.slice(0, end);
  const bodyStart = end + "\n---".length;
  const body = rest.slice(bodyStart).replace(/^\n+/, "");
  return {
    fields: flattenFrontmatter(frontmatter),
    body
  };
}

function flattenFrontmatter(frontmatter: string): FrontmatterField[] {
  const fields: FrontmatterField[] = [];
  let parent: string | null = null;
  for (const line of frontmatter.split("\n")) {
    if (!line.trim()) continue;
    if (line.startsWith("  ") && parent) {
      const nested = line.trim().match(/^([^:]+):(.*)$/);
      if (nested) {
        fields.push({
          key: `${parent}.${nested[1].trim()}`,
          value: cleanValue(nested[2])
        });
      }
      continue;
    }
    const match = line.match(/^([^:]+):(.*)$/);
    if (!match) continue;
    parent = match[1].trim();
    const value = cleanValue(match[2]);
    if (value) {
      fields.push({ key: parent, value });
    }
  }
  return fields;
}

function cleanValue(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}
