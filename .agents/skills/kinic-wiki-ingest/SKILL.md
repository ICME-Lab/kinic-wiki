---
name: kinic-wiki-ingest
description: Kinic Wiki workflow skill for ingesting raw source material into the current canister-backed wiki workflow.
---

# Kinic Wiki Ingest

Use this skill when the user wants to:

- ingest local markdown, notes, docs, or folders into the wiki
- normalize raw source material before wiki synthesis
- persist selected source material under `/Sources/raw/...`
- update existing wiki pages from new evidence
- repair existing wiki pages only when the edit is part of source intake; otherwise use `kinic-wiki-edit`
- initialize or repair an LLM Wiki scope with `index.md`, `overview.md`, `log.md`, `schema.md`, and `topics/`
- generate conversation wiki pages from raw sources, preferring one review-ready page unless the source clearly needs a split
- create review-ready wiki pages without pushing immediately

Do not use this skill for:

- ad hoc question answering without source intake
- health-only review of an existing wiki
- hidden publish or push workflows
- Skill Registry package lifecycle work; use `kinic-skill-registry`
- leakage cleanup or broad existing-node repair without new source ingestion; use `kinic-wiki-edit`

Core rules:

- Treat the canister wiki as the source of truth.
- Stop at review-ready unless the user explicitly asks for push. `review-ready` means edits and `log.md` updates are complete, but no push or publish step has run.
- Keep source persistence separate from wiki synthesis.
- For conversation sources, default to one generated wiki page rather than a fixed page scaffold.
- Read current canonical notes before editing them.
- Preserve settled exact fact spans in `facts.md` instead of paraphrasing or normalizing them away.
- Do not rewrite exact values such as dates, money, fractions, spellings, product names, or role labels when a settled source span already exists.
- `facts.md` is not a transcript dump. Exclude gratitude, acknowledgements, question phrasing, tentative future plans, scheduled meetings, deadlines, and dated event lines unless they are being routed to their canonical note.
- When pages are created, deleted, or edited, update `log.md`.
- Keep `log.md` append-only and easy to inspect with `tail -n 5`.
- PDF handling stays inside kinic-wiki-ingest as source normalization.
- Treat `WIKI_CANONICALITY.md` as the schema authority.
- For day-to-day usage boundaries, follow [../../../docs/internal/KINIC_WIKI_OPERATIONS.md](../../../docs/internal/KINIC_WIKI_OPERATIONS.md).

Read [ingest.md](ingest.md) before doing substantive Kinic Wiki ingest work.

Read these references when needed:

- shared repo rules: [../references/shared-rules.md](../references/shared-rules.md)
- vendor markdown rules: [../vendor/obsidian-skills/obsidian-markdown/SKILL.md](../vendor/obsidian-skills/obsidian-markdown/SKILL.md)
- vendor source cleanup: [../vendor/obsidian-skills/defuddle/SKILL.md](../vendor/obsidian-skills/defuddle/SKILL.md)
