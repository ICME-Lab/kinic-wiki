# Kinic Wiki Query Workflow

## Goal

Answer questions against the current wiki using the canister Agent Memory API when available, with CLI read/search commands as the fallback workflow.

## Workflow

1. On first contact with an unknown canister, call `memory_manifest` to confirm roots, limits, and the recommended entrypoint.
2. Prefer `query_context` for normal questions. Use `/Wiki` as the default `namespace`, the user request as `task`, and known names as `entities`.
3. Set `include_evidence = true` when the answer needs citations or trust checking.
4. Use `source_evidence` when you already know the exact node path and need source refs for that node.
5. Fall back to CLI primitives only when Agent Memory API calls are unavailable: read `/Wiki/index.md` with `read-node-context`, then use direct page reads before search.
6. Synthesize a source-backed answer from current wiki material.
7. If the user explicitly wants durable write-back, hand off to `kinic-wiki-ingest` instead of growing query-side mutation rules.

## Working Rules

- Current repo-local note schema lives in [docs/internal/WIKI_CANONICALITY.md](../../../docs/internal/WIKI_CANONICALITY.md). Treat that file as the source of truth for current note names and role mapping.
- Answer-shape rules live in [../references/query-rules.md](../references/query-rules.md). Use that file for abstention, extraction, and exact-value behavior.
- Prefer `/Wiki/index.md` and flat page reads before broad search.
- Treat `query_context` as the primary context bundle API. Do not repeat broad search if its returned nodes and evidence already answer the question.
- Treat `memory_manifest` as capability discovery, not as content evidence.
- Treat `source_evidence` as evidence lookup for a known node path.
- Do not assume `/Wiki/conversations`, per-conversation indexes, or scoped folders exist.
- Once you open a page that directly matches the question, try to answer from that page and its explicit links before widening search.
- For exact extraction or single-attribute questions, inspect the canonical note chain directly before any broad search.
- If a structured note such as `facts.md` exists and is empty for an extraction question, move to the next role-matched note instead of returning `insufficient evidence` early.
- Do not return `insufficient evidence` while a directly linked or role-matched page remains unread.
- Use `search-path-remote` and `search-remote` as targeted recall steps only after direct canonical-note context reads are insufficient.
- Use `graph-neighborhood` only when incoming or outgoing links from an already-read note are relevant to the question.
- Use `recent-nodes` for recent live nodes only. It is not a delete-aware change log.
- Treat `search-path-remote` as path and basename recall.
- Treat `search-remote` as FTS-based content recall.
- If the question shape is still unclear after reading `/Wiki/index.md`, follow the current note roles from `docs/internal/WIKI_CANONICALITY.md` rather than inventing ad hoc search order.
- Return to broader search only after `/Wiki/index.md`, direct page reads, and explicit links are insufficient.
- Do not answer from an index, list, or search result alone.
- Do not conclude absence until you have checked both path recall and content recall for `/Wiki` or the user-selected scope.
- Before the final answer, read at least one note that directly supports the answer.
- Treat the final answer as invalid until it is anchored to a note you actually read.
- Treat `facts.md` as the first stop for stable attributes and exact extraction.
- Treat `events.md` as the first stop for chronology, order, and elapsed time.
- Treat `plans.md` as the first stop for directives, intended actions, and temporary constraints.
- Treat `preferences.md` as the first stop for preferences and recommendation style.
- Treat `open_questions.md` as the first stop for unresolved conflicts and contradiction questions.
- Treat `summary.md` as recap support for summary-style synthesis, not as the primary source for exact extraction.
- For multi-value extraction, preserve the requested slot order instead of collapsing multiple values into a generic summary.

## Repo Contract

- Preferred query primitives:
  - Canister Agent Memory API: `memory_manifest`, `query_context`, `source_evidence`
  - CLI fallback commands: `read-node-context`, `read-node`, `list-nodes`, `search-remote`, `search-path-remote`, `recent-nodes`, `graph-neighborhood`, `incoming-links`, `outgoing-links`
