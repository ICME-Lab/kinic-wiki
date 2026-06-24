// Where: workers/wiki-generator/src/wiki-skill.ts
// What: Versioned core wiki-generation rules for worker pages.
// Why: URL ingest should follow wiki semantics without depending on Skill Registry packages.
export const WIKI_SKILL_VERSION = 1;

const WIKI_RULES = [
  "Treat /Sources as evidence storage and /Wiki as the review surface.",
  "Create one review-ready wiki page unless the source clearly requires a split.",
  "Do not paste raw page text or transcript dumps into wiki pages.",
  "Keep only claims directly supported by the source.",
  "Prefer omission over low-confidence pseudo-facts.",
  "Write title, slug, section labels, summary, and generated prose in the source material's primary language.",
  "Section labels must be non-empty single-line strings.",
  "Preserve exact values, names, dates, money, and spelling from the source when they matter.",
  "Use the schema sections only when supported.",
  "Every generated item must cite the provided source_path.",
  "Do not invent follow-ups or decisions.",
  "Keep the generated page concise enough for human review."
];

export function buildWikiDraftSystemPrompt(): string {
  return [
    `You are using Kinic Wiki Core Skill v${WIKI_SKILL_VERSION}.`,
    "Generate one review-ready wiki page from raw source material.",
    ...WIKI_RULES.map((rule) => `- ${rule}`)
  ].join("\n");
}
