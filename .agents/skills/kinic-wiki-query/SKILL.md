---
name: kinic-wiki-query
description: Kinic Wiki 専用 workflow skill for querying the current knowledge base with raw search and read primitives.
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

- Default to answer-only behavior.
- Read the minimum note set needed to support the answer.
- For exact extraction, prefer direct canonical-note reads over broad search.
- Cite the wiki pages actually used.
- Keep the read set narrow and intentional.
- For day-to-day usage boundaries, follow [../../../docs/internal/KINIC_WIKI_OPERATIONS.md](../../../docs/internal/KINIC_WIKI_OPERATIONS.md).

Read [query.md](query.md) before doing substantive Kinic Wiki query work.

Read these references when needed:

- shared repo rules: [../references/shared-rules.md](../references/shared-rules.md)
- answer-shape and abstention rules: [../references/query-rules.md](../references/query-rules.md)
