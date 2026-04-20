# Query Workflow

## Goal

Answer questions against the current wiki using CLI read and search commands, with optional durable write-back only when justified.

## Workflow

1. Read `index.md` first when it exists for the current scope.
2. Run `search-path-remote` to recall candidate paths and basenames before assuming the wiki lacks a page.
3. Run `search-remote` to recall candidate page content before assuming the wiki lacks evidence.
4. Use `read-node`, with `recent-nodes` or `list-nodes` only when needed, to collect the minimum relevant page set.
5. Synthesize a source-backed answer from current wiki material.
6. Only if the answer has durable reuse value, write a new or updated page under `/Wiki/...`.
7. When writing back, update `log.md` for every page creation, deletion, or edit.
8. Read only the recent tail of `log.md` before appending, for example `tail -n 5`, unless a longer window is clearly needed.
9. Append one new log line per write-back mutation. Do not rewrite or restructure older log entries.
10. Run `rebuild-index` by default for new page creation, deletion, or large restructures. Skip it for routine small edits.

## Working Rules

- Current repo-local note schema lives in [WIKI_CANONICALITY.md](../../../WIKI_CANONICALITY.md). Treat that file as the source of truth for current note names and role mapping.
- Prefer scope-first exploration.
- Once you open a conversation index or a note under one conversation path, try to finish inside that same conversation first.
- Within one conversation, start from `index.md`, then choose the structured note whose role best matches the question shape.
- Use `search-path-remote` and `search-remote` as standard recall steps, not exceptional fallback.
- Treat `search-path-remote` as path and basename recall.
- Treat `search-remote` as FTS-based content recall.
- If the question shape is still unclear after reading `index.md`, prefer the repo-local settled-fact, plan, timeline, and profile notes before broader recap or raw-source references.
- Return to broader search only after you fail to find direct evidence inside the current conversation scope.
- Treat note roles as part of the search strategy:
  - timeline notes for ordered events, dates, times, and event traces
  - settled-fact notes for stable facts and explicit attributes
  - plan notes for explicit plans, goals, and intended next steps
  - profile notes for attributes, background, and seed details
  - preference notes for stable preferences, likes, dislikes, and decision criteria
  - instruction notes for directives, constraints, promises, and obligations
  - unresolved-state notes for ambiguity, competing claims, and superseded state
  - recap notes for broad recap and multi-turn synthesis
- Preserve exact value formatting for dates, times, places, person names, and other explicit attribute values.
- Do not paraphrase, normalize, or complete an exact value when the wiki already states it directly.
- If the question is about order or time, for example `first`, `last`, `earliest`, `latest`, `when`, `before`, `after`, `at that time`, or a specific turn, do not answer from the index alone.
- Read the repo-local timeline note at least once before answering order, time, or turn-local questions.
- Use the timeline note to resolve order, timestamps, and turn-local events. Use settled-fact notes as secondary support for stable attributes or compressed summaries.
- Use the repo-local preference note first for preference questions.
- Use the repo-local instruction note first for directive, promise, or obligation questions.
- Use the repo-local unresolved-state note first for latest-value, change, contradiction, or superseded-fact questions.
- Use the repo-local recap note first for broad recap or multi-turn synthesis questions.
- For abstention questions, do not treat recap notes or cross-note synthesis as direct evidence for a missing relation or attribute.
- For abstention questions, only an explicit statement in a note counts as evidence. If you only find adjacent context, implications, or a synthesized recap, answer exactly `insufficient evidence`.
- For abstention questions, a broader topic match is not enough. The requested field, requested list, requested rationale, or requested relation must be stated directly in a note.
- For abstention questions, if the note only names a framework, style guide, product, or topic but does not list the requested items, rules, reasons, or relation, answer exactly `insufficient evidence`.
- For abstention questions, do not infer causality, influence, or motivation from separate facts. If one note mentions X and another note mentions Y, that does not establish that X caused or influenced Y.
- For contradiction questions, do not collapse conflicting statements into a single yes or no unless one note explicitly marks the latest or corrected value.
- For contradiction questions, prefer stating that the wiki contains conflicting information, or return the explicit settled value only when the unresolved-state note marks it directly.
- When the question asks for a single turn, a single timestamp, or a single attribute value, prefer extraction over summarization.
- Return the smallest answer span that directly matches the evidence.
- Value questions should return the exact value.
- Turn questions should return the referenced turn content as recorded in the note.
- Ordered event questions should return the selected event's exact time, value, or event text, whichever matches the question.
- Do not paraphrase dates, times, identifiers, quoted text, or the content of the referenced turn when the question is asking for that exact item.
- Use normal synthesis only for open-ended, comparative, or multi-fact explanation questions.
- Do not answer from an index, list, or search result alone.
- Do not conclude absence until you have checked both path recall and content recall for the current scope.
- Before the final answer, read at least one note that directly supports the answer.
- Treat the final answer as invalid until it is anchored to a note you actually read.
- Apply the same rule to `yes` / `no`, exact values, dates, times, places, identifiers, and short factual answers.
- If the requested attribute or value is not directly supported by the wiki pages you read, answer exactly `insufficient evidence`.
- When writing back, prefer `comparison`, `query_note`, or synthesis pages only when they add durable value.
- Avoid turning every answer into content churn.
- Keep `log.md` in sync with every write-back mutation.
- Keep `log.md` append-only so recent context can be read with `tail -n 5`.
- Do not treat page deletion as routine query behavior. Use it only for explicit restructures.
- When writing or editing structured notes, preserve note canonicality:
  - keep settled facts in the settled-fact note, not in recap or unresolved-state notes
  - keep time-ordered evidence in the timeline note, not in recap
  - keep unresolved questions, ambiguity, and competing claims out of settled-fact notes
  - keep recap notes coarse and human-oriented, not authoritative for exact or causal claims
  - keep source/provenance references separate from synthesized knowledge
- When contradiction signals exist, prefer improving the unresolved-state note or provenance trail over forcing a confident answer.
- When requested detail is missing, prefer silence in settled notes over creating a topic-only placeholder that looks answerable.

## Repo Contract

- Preferred query primitives:
  - CLI commands: `read-node`, `list-nodes`, `search-remote`, `search-path-remote`, `recent-nodes`
- Optional write-back primitives:
  - CLI commands: `write-node`, `append-node`, `edit-node`, `multi-edit-node`, `delete-tree`, `rebuild-index`
  - `delete-tree` is only for explicit page-set cleanup during a user-requested reorganization
  - `log.md` updates should be append-only and single-line

## Output

Prefer one of these outputs:

- a direct answer grounded in current wiki pages
- a comparison or synthesis summary
- an optional reusable page update under `/Wiki/...`

When writing back, include:

- why the result deserves durable storage
- which pages were created or updated
