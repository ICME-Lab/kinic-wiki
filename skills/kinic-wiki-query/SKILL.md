---
name: kinic-wiki-query
description: Kinic Wiki workflow skill for querying the current knowledge base with the Agent Memory API as the primary path and CLI read/search commands as fallback.
---

# Kinic Wiki Query

Use this skill when the user wants to:

- ask questions against the current wiki
- compare topics, entities, or concepts already represented in the wiki
- explore what the wiki currently knows before deciding on further ingestion

Do not use this skill for:

- first-pass source ingestion
- health-only wiki inspection
- routine page creation or repair
- Skill Registry package lifecycle work; use `kinic-skill-registry`

Core rules:

- Treat the canister wiki as the source of truth.
- Organized wiki nodes live under `/Wiki/...`; raw sources live under `/Sources/raw/<provider>/<id>.md`.
- Treat local Markdown as review or drafting aid unless a workflow explicitly writes it back through VFS commands.
- Default to answer-only behavior.
- Read the minimum note set needed to support the answer.
- For exact extraction, prefer direct canonical-note reads over broad search.
- Cite the wiki pages actually used.
- Keep the read set narrow and intentional.
- For current note roles and boundaries, follow [../../docs/internal/WIKI_CANONICALITY.md](../../docs/internal/WIKI_CANONICALITY.md).

Read [query.md](query.md) before doing substantive Kinic Wiki query work.
