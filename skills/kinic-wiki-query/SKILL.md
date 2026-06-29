---
name: kinic-wiki-query
description: Search and read Kinic Wiki VFS databases from wiki.kinic.xyz URLs or database IDs using kinic-vfs-cli; use for find, search, inspect, read, summarize, or answer-only wiki queries.
---

# Kinic Wiki Query

Use this skill when the user wants to:

- find, search, inspect, read, or summarize wiki content
- answer questions from a `https://wiki.kinic.xyz/db/<database_id>/...` URL
- answer questions from a raw Kinic database ID such as `db_pfy2cqesybpl`
- explore what the wiki currently contains before deciding on edits or ingestion

Do not use this skill for:

- first-pass source ingestion
- health-only wiki inspection
- routine page creation or repair
- editing, deleting, redacting, or mutating knowledge nodes; use `kinic-wiki-edit`
- portable AI handoff or OKF Context Pack export; use `kinic-context-pack`
- skill store package lifecycle work; use `kinic-skill-registry`

Core rules:

- Treat the canister wiki as the source of truth.
- Organized knowledge nodes live under `/Knowledge/...`; raw sources live under `/Sources/<provider>/<id>.md`.
- Treat local Markdown as review or drafting aid unless a workflow explicitly writes it back through VFS commands.
- Use `kinic-vfs-cli` first for `wiki.kinic.xyz` URLs. Do not start from Web HTML parsing.
- Never run destructive or write commands.
- Default to answer-only behavior.
- Read the minimum note set needed to support the answer.
- Cite paths actually read, not only search hits.
- Include source URL and source path when node metadata provides them. Do not invent missing metadata.

Read [query.md](query.md) before doing substantive Kinic Wiki query work.
