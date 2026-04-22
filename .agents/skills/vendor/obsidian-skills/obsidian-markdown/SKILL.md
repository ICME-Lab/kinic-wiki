---
name: obsidian-markdown
description: Create and edit Obsidian Flavored Markdown for vault notes. Use when working with wikilinks, embeds, callouts, properties, comments, tags, or other Obsidian-specific markdown syntax.
---

# Obsidian Markdown

This is a vendor-adapted skill derived from ideas in `kepano/obsidian-skills`, narrowed for this repo.

Use this skill when the task requires:

- valid Obsidian Flavored Markdown
- `[[wikilink]]` authoring
- note metadata/frontmatter
- callouts, embeds, comments, tags, math, or Mermaid in notes

Do not use this skill as the source-of-truth workflow. In this repo, that remains in the repo-specific workflow skills such as [`kinic-wiki-ingest`](../../../kinic-wiki-ingest/SKILL.md), [`kinic-wiki-query`](../../../kinic-wiki-query/SKILL.md), and [`kinic-wiki-lint`](../../../kinic-wiki-lint/SKILL.md).

## Core Rules

- Use `[[wikilinks]]` for notes inside the vault.
- Use standard Markdown links only for external URLs.
- Keep frontmatter minimal and purposeful.
- Prefer readable notes over heavy formatting.
- When writing for this repo's working copy, prefer the shared mirror contract from [`references/shared-rules.md`](../../../references/shared-rules.md).

## Obsidian-Specific Syntax

- Wikilinks: `[[Note]]`, `[[Note|Alias]]`, `[[Note#Heading]]`
- Embeds: `![[Note]]`, `![[image.png]]`
- Callouts: `> [!note]`, `> [!warning]`
- Comments: `%%hidden%%`
- Highlight: `==text==`
- Tags: `#tag`, `#nested/tag`

Read these references as needed:

- [references/wikilinks.md](references/wikilinks.md)
- [references/properties.md](references/properties.md)
- [references/callouts-and-embeds.md](references/callouts-and-embeds.md)
