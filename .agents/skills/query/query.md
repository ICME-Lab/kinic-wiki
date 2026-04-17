# Query Workflow

## Goal

Answer questions against the current wiki using CLI read and search commands, with optional durable write-back only when justified.

## Workflow

1. Start from `index.md` when it is likely to narrow the search.
2. Use `search-remote`, `search-path-remote`, `recent-nodes`, `list-nodes`, and `read-node` to collect the minimum relevant page set.
3. Synthesize a source-backed answer from current wiki material.
4. Only if the answer has durable reuse value, write a new or updated page under `/Wiki/...`.
5. When writing back, update `log.md` for every page creation, deletion, or edit.
6. Read only the recent tail of `log.md` before appending, for example `tail -n 5`, unless a longer window is clearly needed.
7. Append one new log line per write-back mutation. Do not rewrite or restructure older log entries.
8. Run `rebuild-index` by default for new page creation, deletion, or large restructures. Skip it for routine small edits.

## Working Rules

- Prefer scope-first exploration.
- Once you open a conversation index or a note under one conversation path, try to finish inside that same conversation first.
- Within one conversation, prefer this narrowing order: `index.md` -> `facts.md` / `plan.md` / `events.md` / `profile.md` -> `conversation.md`.
- Return to broader search only after you fail to find direct evidence inside the current conversation scope.
- Treat note roles as part of the search strategy:
  - `events.md` for ordered events, dates, times, and timelines
  - `facts.md` for stable facts and concise summaries
  - `plan.md` for explicit plans, goals, and intended next steps
  - `profile.md` for attributes, background, and seed details
- Preserve exact value formatting for dates, times, places, person names, and other explicit attribute values.
- Do not paraphrase, normalize, or complete an exact value when the wiki already states it directly.
- If the question is about order or time, for example `first`, `last`, `earliest`, `latest`, `when`, `before`, `after`, `at that time`, or a specific turn, do not answer from the index alone.
- Read `events.md` at least once before answering order, time, or turn-local questions.
- Use `events.md` to resolve order, timestamps, and turn-local events. Use `facts.md` as secondary support for stable attributes or compressed summaries.
- When the question asks for a single turn, a single timestamp, or a single attribute value, prefer extraction over summarization.
- Return the smallest answer span that directly matches the evidence.
- Value questions should return the exact value.
- Turn questions should return the referenced turn content as recorded in the note.
- Ordered event questions should return the selected event's exact time, value, or event text, whichever matches the question.
- Do not paraphrase dates, times, identifiers, quoted text, or the content of the referenced turn when the question is asking for that exact item.
- Use normal synthesis only for open-ended, comparative, or multi-fact explanation questions.
- If the requested attribute or value is not directly supported by the wiki pages you read, answer exactly `insufficient evidence`.
- When writing back, prefer `comparison`, `query_note`, or synthesis pages only when they add durable value.
- Avoid turning every answer into content churn.
- Keep `log.md` in sync with every write-back mutation.
- Keep `log.md` append-only so recent context can be read with `tail -n 5`.
- Do not treat page deletion as routine query behavior. Use it only for explicit restructures.

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
