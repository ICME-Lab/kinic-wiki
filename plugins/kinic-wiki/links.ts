// Where: plugins/kinic-wiki/links.ts
// What: Markdown link normalization for the Obsidian mirror.
// Why: Graph View and backlinks work best when mirror files use stable [[slug]] links.
export function normalizePageMarkdown(markdown: string, knownSlugs: Set<string>): string {
  return normalizeWikiLinks(normalizeMarkdownLinks(markdown, knownSlugs), knownSlugs);
}

export function normalizeSystemMarkdown(markdown: string, knownSlugs: Set<string>): string {
  const linkedLists = markdown.replace(
    /^- ([A-Za-z0-9/_-]+) — /gm,
    (match: string, slug: string) => (knownSlugs.has(slug) ? `- [[${slug}]] — ` : match)
  );
  return normalizePageMarkdown(linkedLists, knownSlugs);
}

function normalizeWikiLinks(markdown: string, knownSlugs: Set<string>): string {
  return markdown.replace(/\[\[([^[\]]+)\]\]/g, (whole: string, rawTarget: string) => {
    const target = canonicalSlug(rawTarget);
    return knownSlugs.has(target) ? `[[${target}]]` : whole;
  });
}

function normalizeMarkdownLinks(markdown: string, knownSlugs: Set<string>): string {
  return markdown.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (whole: string, _label: string, url: string) => {
    const target = canonicalSlug(url);
    return knownSlugs.has(target) ? `[[${target}]]` : whole;
  });
}

function canonicalSlug(input: string): string {
  return input
    .trim()
    .replace(/^\.?\/*Wiki\/pages\//, "")
    .replace(/^pages\//, "")
    .replace(/\|.*$/, "")
    .replace(/\.md$/, "");
}
