---
name: wiki-generate
description: Legacy entry skill for the llm-wiki repo. Use this only as a router to the current workflow skills: ingest, query, and lint.
---

# Wiki Generate

This skill is now a thin router.

Use one of these repo skills instead:

- [`ingest`](../ingest/SKILL.md) for source-driven wiki updates
- [`query`](../query/SKILL.md) for question answering and optional page synthesis
- [`lint`](../lint/SKILL.md) for wiki health inspection and repair planning

Choose by intent:

- new source material, PDFs, docs, or raw notes -> `ingest`
- questions against the wiki -> `query`
- health checks, duplication review, stale structure checks -> `lint`

Do not treat `wiki-generate` as the source-of-truth workflow anymore.
The active workflow contract now lives in the dedicated skills above.
