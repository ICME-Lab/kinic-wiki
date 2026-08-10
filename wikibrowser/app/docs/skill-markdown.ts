import contextPackMarkdown from "../../../skills/kinic-context-pack/SKILL.md?raw";
import contextPackReferenceMarkdown from "../../../skills/kinic-context-pack/context-pack.md?raw";
import skillRegistryReferenceMarkdown from "../../../docs/SKILL_REGISTRY.md?raw";
import skillRegistryMarkdown from "../../../skills/kinic-skill-registry/SKILL.md?raw";
import wikiEditMarkdown from "../../../skills/kinic-wiki-edit/SKILL.md?raw";
import wikiEditReferenceMarkdown from "../../../skills/kinic-wiki-edit/edit.md?raw";
import wikiIngestMarkdown from "../../../skills/kinic-wiki-ingest/SKILL.md?raw";
import wikiIngestReferenceMarkdown from "../../../skills/kinic-wiki-ingest/ingest.md?raw";
import wikiLintMarkdown from "../../../skills/kinic-wiki-lint/SKILL.md?raw";
import wikiLintReferenceMarkdown from "../../../skills/kinic-wiki-lint/lint.md?raw";
import wikiMcpMarkdown from "../../../skills/kinic-wiki-mcp/SKILL.md?raw";
import wikiMcpReferenceMarkdown from "../../../skills/kinic-wiki-mcp/references/tools.md?raw";
import wikiQueryMarkdown from "../../../skills/kinic-wiki-query/SKILL.md?raw";
import wikiQueryReferenceMarkdown from "../../../skills/kinic-wiki-query/query.md?raw";

export type SkillMarkdownReference = {
  href: string;
  markdown: string;
};

const skillMarkdownBySlug: Record<string, string> = {
  "context-pack": contextPackMarkdown,
  edit: wikiEditMarkdown,
  ingest: wikiIngestMarkdown,
  lint: wikiLintMarkdown,
  mcp: wikiMcpMarkdown,
  query: wikiQueryMarkdown,
  registry: skillRegistryMarkdown
};

const skillMarkdownReferencesBySlug: Record<string, SkillMarkdownReference[]> = {
  "context-pack": [{ href: "context-pack.md", markdown: contextPackReferenceMarkdown }],
  edit: [{ href: "edit.md", markdown: wikiEditReferenceMarkdown }],
  ingest: [{ href: "ingest.md", markdown: wikiIngestReferenceMarkdown }],
  lint: [{ href: "lint.md", markdown: wikiLintReferenceMarkdown }],
  mcp: [{ href: "references/tools.md", markdown: wikiMcpReferenceMarkdown }],
  query: [{ href: "query.md", markdown: wikiQueryReferenceMarkdown }],
  registry: [{ href: "../../docs/SKILL_REGISTRY.md", markdown: skillRegistryReferenceMarkdown }]
};

export function findSkillMarkdown(slug: string): string | null {
  return skillMarkdownBySlug[slug] ?? null;
}

export function findSkillMarkdownReferences(slug: string): SkillMarkdownReference[] {
  return skillMarkdownReferencesBySlug[slug] ?? [];
}
