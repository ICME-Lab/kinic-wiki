---
name: query
description: Query the llm-wiki knowledge base using raw search and read primitives. Use when answering questions against the current wiki without turning routine answers into page churn.
---

# Query

Use this skill when the user wants to:

- ask questions against the current wiki
- compare topics, entities, or concepts already represented in the wiki
- explore what the wiki currently knows before deciding on further ingestion

Do not use this skill for:

- first-pass source ingestion
- health-only wiki inspection
- routine page creation or repair

Core rules:

- Default to answer-only behavior.
- Read the minimum note set needed to support the answer.
- Cite the wiki pages actually used.
- Keep the read set narrow and intentional.

Read [query.md](query.md) before doing substantive query work.

Read this reference when needed:

- shared mirror and markdown rules: [../wiki-generate/references/obsidian-rules.md](../wiki-generate/references/obsidian-rules.md)
- answer-shape and abstention rules: [../wiki-generate/references/query-answer-rules.md](../wiki-generate/references/query-answer-rules.md)
