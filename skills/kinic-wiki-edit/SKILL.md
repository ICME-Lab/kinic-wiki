---
name: kinic-wiki-edit
description: Kinic Wiki workflow skill for safe remote wiki page edits, redactions, leakage cleanup, and multi-node repair with etag-aware VFS commands.
---

# Kinic Wiki Edit

Use this skill when the user wants to:

- remove or redact leaked, stale, duplicated, or invalid text from wiki nodes
- edit existing `/Wiki/...` pages without new source ingestion
- repair many existing nodes after a lint, search, or incident finding
- apply the same text replacement across multiple wiki pages

Do not use this skill for:

- answer-only wiki queries; use `kinic-wiki-query`
- report-only health checks; use `kinic-wiki-lint`
- evidence source ingestion or new evidence synthesis; use `kinic-wiki-ingest`
- skill store package lifecycle work; use `kinic-skill-registry`

Core rules:

- Read [edit.md](edit.md) before mutating remote wiki nodes.
- Treat the canister wiki as the source of truth.
- Always read current node content and etag before editing.
- Prefer etag-aware CLI commands for existing node repair.
- Keep replacement scope explicit: path list, old text, new text, expected etag, verification.
- Update the affected scope `log.md` for every page edit.
- Stop and ask before destructive deletion, unclear redaction policy, or API-contract changes.
