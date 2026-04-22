---
name: lint
description: Inspect llm-wiki structure and health using local and remote primitives. Use when checking for duplication, stale structure, weak linkage, or follow-up repair candidates without silently fixing them.
---

# Lint

Use this skill when the user wants to:

- inspect wiki health
- look for isolated or duplicated pages
- check whether `index.md` is stale
- review missing links, weak structure, or outdated organization
- decide what to fix next without auto-applying changes

Do not use this skill for:

- primary source ingestion
- ordinary question answering
- hidden repair runs

Core rules:

- Default to report-only behavior.
- Do not silently fix pages.
- Prefer concrete findings over vague style commentary.
- Keep local lint and remote inspection conceptually separate.
- Treat `WIKI_CANONICALITY.md` as the schema authority.

Read [lint.md](lint.md) before doing substantive lint work.

Read this reference when needed:

- shared mirror and markdown rules: [../wiki-generate/references/obsidian-rules.md](../wiki-generate/references/obsidian-rules.md)
