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

- Current repo-local note schema lives in [docs/internal/WIKI_CANONICALITY.md](../../docs/internal/WIKI_CANONICALITY.md). Treat that file as the source of truth for current note names and role mapping.
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

## Answer Rules

- Prefer scope-first exploration.
- Read at least one note that directly supports the final answer.
- Do not answer from `index.md`, a list result, or a search hit alone.
- Do not conclude absence before reading the highest-priority role-matched note for the question.
- If the primary role-matched note is empty or lacks the value, inspect the next canonical note directly before broad search.
- Use `search-path-remote` and `search-remote` only after role-matched notes are still insufficient.
- Prefer reading the note whose role best matches the question shape before broad search.
- Preserve exact value formatting for dates, times, places, person names, identifiers, fractions, ratios, spelling variants, and other explicit attribute values.
- Do not paraphrase, normalize, translate, or complete an exact value when the wiki already states it directly.
- For exact-value or single-attribute extraction questions, answer with the value first and avoid explanation unless the question explicitly asks for it.
- When a note contains the requested value directly, stay on that span and do not drift into summary, background, or inferred context.
- Do not return `insufficient evidence` when the exact value is present in the note you read.
- Do not return `insufficient evidence` while a higher-priority canonical note remains unread.
- If a note you read already contains one requested slot, keep checking the remaining requested slots before concluding `insufficient evidence`.
- Return the smallest answer span that directly matches the evidence.
- For multi-value extraction, keep the answer aligned to the requested slots and preserve their order.
- For paired-slot extraction such as `when and where` or `age and role`, answer every requested slot in one short response.
- Return only the requested attribute, not nearby qualifiers, adjacent summary text, or generic recommendations.
- Use normal synthesis only for open-ended, comparative, or multi-fact explanation questions.
- For contradiction questions, if notes contain unresolved conflict, explicitly state that there is contradictory information and ask for clarification instead of choosing one side.
- For temporal questions, extract the relevant time anchors before answering and compute the result from those anchors.
- For ordering questions, return the ordered items directly instead of replacing the order with a thematic summary.
- If the question is about order or time, do not answer from the index alone.
- If the question asks for a single turn, timestamp, or attribute value, prefer extraction over summarization.
- If the requested attribute or value is not directly supported by the notes you read, answer exactly `insufficient evidence`.
- For abstention questions, only an explicit statement in a note counts as evidence.
- For abstention questions, do not treat recap notes, adjacent context, implication, or cross-note synthesis as direct evidence for a missing relation or attribute.
- Do not paraphrase quoted text or referenced turn content when the question asks for that exact item.

## Repo Contract

- Preferred query primitives:
  - Canister Agent Memory API: `memory_manifest`, `query_context`, `source_evidence`
  - CLI fallback commands: `read-node-context`, `read-node`, `list-children`, `list-nodes`, `search-remote`, `search-path-remote`, `recent-nodes`, `graph-neighborhood`, `incoming-links`, `outgoing-links`
  - Use `list-children` for one-level navigation and `list-nodes --prefix <path> --recursive --json` for inventory.
