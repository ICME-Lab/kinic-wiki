---
name: kinic-wiki-ingest
description: Kinic Wiki 専用 workflow skill for ingesting raw source material into the current canister-backed wiki workflow.
---

# Kinic Wiki Ingest

Use this skill when the user wants to:

- ingest local markdown, notes, docs, or folders into the wiki
- normalize raw source material before wiki synthesis
- persist selected source material under `/Sources/raw/...`
- update existing wiki pages from new evidence
- create review-ready wiki pages without pushing immediately

Do not use this skill for:

- ad hoc question answering without source intake
- health-only review of an existing wiki
- hidden publish or push workflows

Core rules:

- Treat the canister wiki as the source of truth.
- Stop at review-ready unless the user explicitly asks for push.
- Keep source persistence separate from wiki synthesis.
- When pages are created, deleted, or edited, update `log.md`.
- Keep `log.md` append-only and easy to inspect with `tail -n 5`.
- PDF handling stays inside kinic-wiki-ingest as source normalization.
- Treat `WIKI_CANONICALITY.md` as the schema authority.

Read [ingest.md](ingest.md) before doing substantive Kinic Wiki ingest work.

Read these references when needed:

- shared repo rules: [../references/shared-rules.md](../references/shared-rules.md)
- vendor markdown rules: [../vendor/obsidian-skills/obsidian-markdown/SKILL.md](../vendor/obsidian-skills/obsidian-markdown/SKILL.md)
- vendor vault guidance: [../vendor/obsidian-skills/obsidian-cli/SKILL.md](../vendor/obsidian-skills/obsidian-cli/SKILL.md)
- vendor source cleanup: [../vendor/obsidian-skills/defuddle/SKILL.md](../vendor/obsidian-skills/defuddle/SKILL.md)
