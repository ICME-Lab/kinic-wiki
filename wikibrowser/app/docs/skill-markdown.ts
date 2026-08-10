import contextPackMarkdown from "../../../skills/kinic-context-pack/SKILL.md?raw";
import skillRegistryMarkdown from "../../../skills/kinic-skill-registry/SKILL.md?raw";
import wikiEditMarkdown from "../../../skills/kinic-wiki-edit/SKILL.md?raw";
import wikiIngestMarkdown from "../../../skills/kinic-wiki-ingest/SKILL.md?raw";
import wikiLintMarkdown from "../../../skills/kinic-wiki-lint/SKILL.md?raw";
import wikiMcpMarkdown from "../../../skills/kinic-wiki-mcp/SKILL.md?raw";
import wikiQueryMarkdown from "../../../skills/kinic-wiki-query/SKILL.md?raw";

const skillMarkdownBySlug: Record<string, string> = {
  "context-pack": contextPackMarkdown,
  edit: wikiEditMarkdown,
  ingest: wikiIngestMarkdown,
  lint: wikiLintMarkdown,
  mcp: wikiMcpMarkdown,
  query: wikiQueryMarkdown,
  registry: skillRegistryMarkdown
};

export function findSkillMarkdown(slug: string): string | null {
  return skillMarkdownBySlug[slug] ?? null;
}
