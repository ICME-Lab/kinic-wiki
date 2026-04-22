---
name: ingest
description: Ingest raw source material into the llm-wiki workflow. Use when turning local files, folders, notes, or normalized source material into review-ready wiki updates under the current canister-backed model.
---

# Ingest

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
- PDF handling stays inside ingest as source normalization.
- Treat `WIKI_CANONICALITY.md` as the schema authority.

Read [ingest.md](ingest.md) before doing substantive ingest work.

Read these references when needed:

- shared mirror and markdown rules: [../wiki-generate/references/obsidian-rules.md](../wiki-generate/references/obsidian-rules.md)
- optional graph assistance: [../wiki-generate/references/graph-assisted.md](../wiki-generate/references/graph-assisted.md)
- external input guidance: [../wiki-generate/references/external-inputs.md](../wiki-generate/references/external-inputs.md)
- vendor markdown rules: [../vendor/obsidian-skills/obsidian-markdown/SKILL.md](../vendor/obsidian-skills/obsidian-markdown/SKILL.md)
- vendor vault guidance: [../vendor/obsidian-skills/obsidian-cli/SKILL.md](../vendor/obsidian-skills/obsidian-cli/SKILL.md)
- vendor source cleanup: [../vendor/obsidian-skills/defuddle/SKILL.md](../vendor/obsidian-skills/defuddle/SKILL.md)
