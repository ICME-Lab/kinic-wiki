---
name: kinic-wiki-lint
description: Kinic Wiki workflow skill for inspecting local and remote wiki health without silently fixing it.
---

# Kinic Wiki Lint

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
- Skill Registry package lifecycle work; use `kinic-skill-registry`

Core rules:

- Default to report-only behavior.
- Do not silently fix pages.
- Prefer concrete findings over vague style commentary.
- Keep local lint and remote inspection conceptually separate.
- Check note-role boundary violations as well as missing pages.
- Treat exact-value drift in `facts.md` as a real canonicality problem, not a style nit.
- Treat `WIKI_CANONICALITY.md` as the schema authority.
- For day-to-day usage boundaries, follow [../../../docs/internal/KINIC_WIKI_OPERATIONS.md](../../../docs/internal/KINIC_WIKI_OPERATIONS.md).

Read [lint.md](lint.md) before doing substantive Kinic Wiki lint work.

Read this reference when needed:

- shared repo rules: [../references/shared-rules.md](../references/shared-rules.md)
