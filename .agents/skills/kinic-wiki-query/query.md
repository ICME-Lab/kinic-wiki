# Kinic Wiki Query Workflow

## Goal

Answer questions against the current wiki using CLI read and search commands.

## Workflow

1. Read `index.md` first when it exists for the current scope.
2. Run `search-path-remote` to recall candidate paths before assuming the wiki lacks a page.
3. Run `search-remote` to recall candidate content before assuming the wiki lacks evidence.
4. Use `read-node`, with `recent-nodes` or `list-nodes` only when needed, to collect the minimum relevant note set.
5. Synthesize a source-backed answer from current wiki material.
6. If the user explicitly wants durable write-back, hand off to `kinic-wiki-ingest` instead of growing query-side mutation rules.

## Working Rules

- Current repo-local note schema lives in [docs/internal/WIKI_CANONICALITY.md](../../../docs/internal/WIKI_CANONICALITY.md). Treat that file as the source of truth for current note names and role mapping.
- Answer-shape rules live in [../references/query-rules.md](../references/query-rules.md). Use that file for abstention, extraction, and exact-value behavior.
- Prefer scope-first exploration.
- Once you open a conversation index or a note under one conversation path, try to finish inside that same conversation first.
- Within one conversation, start from `index.md`, then choose the structured note whose role best matches the question shape.
- Use `search-path-remote` and `search-remote` as standard recall steps, not exceptional fallback.
- Treat `search-path-remote` as path and basename recall.
- Treat `search-remote` as FTS-based content recall.
- If the question shape is still unclear after reading `index.md`, follow the current note roles from `docs/internal/WIKI_CANONICALITY.md` rather than inventing ad hoc search order.
- Return to broader search only after you fail to find direct evidence inside the current conversation scope.
- Do not answer from an index, list, or search result alone.
- Do not conclude absence until you have checked both path recall and content recall for the current scope.
- Before the final answer, read at least one note that directly supports the answer.
- Treat the final answer as invalid until it is anchored to a note you actually read.

## Repo Contract

- Preferred query primitives:
  - CLI commands: `read-node`, `list-nodes`, `search-remote`, `search-path-remote`, `recent-nodes`
