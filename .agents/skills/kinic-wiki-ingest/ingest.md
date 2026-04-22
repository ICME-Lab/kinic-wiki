# Kinic Wiki Ingest Workflow

## Goal

Turn raw source material into review-ready wiki updates under the canister-backed llm-wiki model.

## Workflow

1. Inspect the source material and the user focus.
2. If the source is noisy web or PDF-derived text, normalize it first.
3. Decide whether the source should also be persisted under `/Sources/raw/...`.
4. Read existing wiki context with `read-node`, `search-remote`, `search-path-remote`, `recent-nodes`, or `list-nodes`.
5. Choose the minimum coherent set of pages to update.
6. Edit `/Wiki/...` directly through `wiki-cli` remote VFS commands.
7. When a reorganization needs explicit removal of obsolete `/Wiki/...` page groups, use `delete-tree` from the CLI rather than treating deletion as an implicit side effect.
8. Update `log.md` for every page creation, deletion, or edit done in the workflow.
9. Read only the recent tail of `log.md` before appending, for example `tail -n 5`, unless a longer window is clearly needed.
10. Append one new log line per workflow mutation. Do not rewrite or restructure older log entries.
11. Run `rebuild-scope-index --scope <scope>` by default for new page creation, deletion, or large single-scope restructures. Use `rebuild-index` only for cross-scope restructures or explicit full repair. Skip rebuilds for routine small edits.
12. Stop at review-ready unless the user explicitly asks for push.

## Working Rules

- Current repo-local note schema lives in [WIKI_CANONICALITY.md](../../../WIKI_CANONICALITY.md). Use it for concrete note names and current role mapping.
- Treat local `Wiki/` content as the human review surface.
- Prefer fewer stronger pages over many shallow stubs.
- Reuse existing pages when possible instead of minting near-duplicates.
- Keep `log.md` in sync with every page mutation.
- Keep `log.md` append-only so recent context can be read with `tail -n 5`.
- Do not hide push behind kinic-wiki-ingest.
- Preserve structured note canonicality from `WIKI_CANONICALITY.md` while ingesting.
- When source material is noisy, prefer omission over polluting structured notes with low-confidence pseudo-facts.
- When a contradiction appears, preserve it in the canonical open-question area rather than silently normalizing it into a fact note.

## Repo Contract

- Raw source write path: `/Sources/raw/<source_id>/<source_id>.md`
- Raw source append path: `/Sources/raw/<source_id>/<source_id>.md`
- Wiki target root: `/Wiki/...`
- Preferred primitives:
  - CLI commands: `read-node`, `write-node`, `append-node`, `edit-node`, `delete-node`, `delete-tree`, `list-nodes`, `glob-nodes`, `recent-nodes`, `search-remote`, `search-path-remote`, `rebuild-scope-index`, `rebuild-index`
- Delete semantics:
  - `delete-node`: delete one node path
  - `delete-tree`: delete real node paths under a prefix, deepest-first
- `log.md` rule:
  - read only the recent tail before appending unless more history is needed
  - append one single-line event per mutation

## Output

Prefer one of these outputs:

- review-ready wiki page updates
- a page map and update plan before writing
- persisted raw source plus linked wiki updates

When useful, also provide:

- pages created or updated
- source files used
- open questions that block push
- canonicality risks such as unresolved state leaking into settled notes, topic-only facts, or recap leaking into exact notes
