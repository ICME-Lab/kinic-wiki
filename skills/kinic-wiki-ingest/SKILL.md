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
- initialize or repair an explicit LLM Wiki scope when the user asks for scoped structure
- generate conversation wiki pages from raw sources, preferring one review-ready page unless the source clearly needs a split
- create review-ready wiki pages without pushing immediately

Do not use this skill for:

- ad hoc question answering without source intake
- health-only review of an existing wiki
- hidden publish or push workflows
- OKF Context Pack export after wiki structure exists; use `kinic-context-pack`
- Skill Registry package lifecycle work; use `kinic-skill-registry`
- leakage cleanup or broad existing-node repair without new source ingestion; use `kinic-wiki-edit`

Core rules:

- Treat the canister wiki as the source of truth.
- Organized wiki nodes live under `/Wiki/...`; raw sources live under `/Sources/raw/<provider>/<id>.md`.
- Treat local Markdown as review or drafting aid unless the workflow explicitly writes it back through VFS commands.
- Stop at review-ready unless the user explicitly asks for push. `review-ready` means edits and any existing or requested `log.md` updates are complete, but no push or publish step has run.
- Keep source persistence separate from wiki synthesis.
- Hand off to `kinic-context-pack` when the user asks to export a completed `/Wiki/...` scope for AI handoff.
- For conversation sources, default to one generated wiki page rather than a fixed page scaffold.
- Read current canonical notes before editing them.
- Preserve settled exact fact spans in `facts.md` instead of paraphrasing or normalizing them away.
- Do not rewrite exact values such as dates, money, fractions, spellings, product names, or role labels when a settled source span already exists.
- `facts.md` is not a transcript dump. Exclude gratitude, acknowledgements, question phrasing, tentative future plans, scheduled meetings, deadlines, and dated event lines unless they are being routed to their canonical note.
- When a relevant `log.md` already exists or the user asks for logging, update it append-only.
- Do not create `log.md` by default.
- PDF handling stays inside kinic-wiki-ingest as source normalization.
- Treat [../../docs/AGENT_MEMORY_API.md](../../docs/AGENT_MEMORY_API.md) as the trust model and note-role contract.

Read [ingest.md](ingest.md) before doing substantive Kinic Wiki ingest work.
