# Kinic Wiki Ingest Workflow

## Goal

Turn raw source material into review-ready wiki updates under the canister-backed llm-wiki model.

## Workflow

1. Inspect the source material and the user focus.
2. If the source is noisy web or PDF-derived text, normalize it first.
3. Decide whether the source should also be persisted under `/Sources/raw/...`.
4. Read existing wiki context by starting from `index.md` and the canonical role-matched notes before broad search.
5. Use `search-remote` or `search-path-remote` only when the relevant canonical notes are missing, ambiguous, or insufficient.
6. Choose the minimum coherent set of pages to update.
7. Edit `/Wiki/...` directly through `vfs-cli` remote VFS commands.
8. When a reorganization needs explicit removal of obsolete `/Wiki/...` page groups, use `delete-tree` from the CLI rather than treating deletion as an implicit side effect.
9. Update `log.md` for every page creation, deletion, or edit done in the workflow.
10. Read only the recent tail of `log.md` before appending, for example `tail -n 5`, unless a longer window is clearly needed.
11. Append one new log line per workflow mutation. Do not rewrite or restructure older log entries.
12. Run `rebuild-scope-index --scope <scope>` by default for new page creation, deletion, or large single-scope restructures. Use `rebuild-index` only for cross-scope restructures or explicit full repair. Skip rebuilds for routine small edits.
13. Stop at review-ready unless the user explicitly asks for push.

## Working Rules

- Current repo-local note schema lives in [WIKI_CANONICALITY.md](../../../docs/internal/WIKI_CANONICALITY.md). Use it for concrete note names and current role mapping.
- Runtime `facts.md` extraction policy currently lives in [facts_policy.rs](../../../crates/vfs_cli_app/src/facts_policy.rs). Keep skill guidance aligned with that rule, not with benchmark-specific phrasing.
- Treat local `Wiki/` content as the human review surface.
- Prefer fewer stronger pages over many shallow stubs.
- Reuse existing pages when possible instead of minting near-duplicates.
- Preserve note-role boundaries from `WIKI_CANONICALITY.md` before adding new lines to any structured note.
- Put settled stable attributes, exact resolved values, current values, selected options, and stable relationship-duration in `facts.md`.
- Use `events.md` for chronology-only completed event entries, `plans.md` for future / pending / next action, and `summary.md` for recap only.
- Treat `facts.md` as an exact stable fact note, not a conversation residue note.
- Do not copy question-shaped lines such as `I'm trying to...`, `Can you help...`, or `what should I do...` into `facts.md`.
- Do not copy gratitude, acknowledgements, backchannels, or self-encouragement such as `Thanks...`, `Got it`, `Sounds good`, or `Yeah, ...` into any structured note unless they encode a real preference.
- Do not copy future-oriented schedule lines such as meetings, deadlines, recurring check-ins, or next-action commitments into `facts.md`; route them to `events.md` if they record a completed dated event, otherwise to `plans.md`.
- When a line mixes stable attributes with non-fact residue, keep only the settled exact attribute span in `facts.md` and route or drop the rest.
- Treat `topic-only mention` as exclusionary: a product, place, or person name belongs in `facts.md` only when the source states it as a settled attribute or settled exact answer, not when it is merely mentioned in a question.
- Do not synthesize a settled exact fact into `summary.md`; put exact stable values into the canonical fact-like note.
- When a source line already contains the settled answer span, keep that span nearly verbatim in `facts.md` instead of rewriting it into a looser summary.
- Do not normalize exact settled values across equivalent forms such as `4/52 -> 1/13`, `colour -> color`, `$1,200 per month -> $1,200/month`, or `Adidas Ultraboost -> running shoes`.
- Prefer one short fact clause per settled value when possible so later query workflows can extract the value without scanning a long recap paragraph.
- When old and new values both appear in source material, make the current value explicit in `facts.md` instead of leaving only the historical progression in `events.md` or `plans.md`.
- When ingesting PRs, diffs, review comments, or implementation notes, compress them into decisions, rationale, verification, follow-up, and open questions instead of copying code bodies.
- Treat repo file paths as `Source of Truth` pointers for code notes. Do not turn wiki pages into copied implementation references.
- Do not persist long diffs, generated docs, schema dumps, or code blocks as wiki knowledge unless the user explicitly asks for a short illustrative example.
- Keep `log.md` in sync with every page mutation.
- Keep `log.md` append-only so recent context can be read with `tail -n 5`.
- Do not hide push behind kinic-wiki-ingest.
- Preserve structured note canonicality from `WIKI_CANONICALITY.md` while ingesting.
- When source material is noisy, prefer omission over polluting structured notes with low-confidence pseudo-facts.
- When a contradiction appears, preserve it in the canonical open-question area rather than silently normalizing it into a fact note.

## Routing Examples

- `I'm Craig, a 44-year-old colour technologist...` → keep `44-year-old colour technologist` in `facts.md`
- `The filing fee used to be $5,000, but now the current budget is $8,000` → keep the current value in `facts.md`; historical progression stays in `events.md` if needed
- `I'm trying to decide if saving $600 is worth it` → not `facts.md`; usually omit or keep in `plans.md` only if it is an active decision
- `Thanks for the detailed guide!` → omit
- `I have a meeting with Ashlee at 3 PM on May 14, 2024` → `plans.md` if upcoming, `events.md` if completed
- `I've got a deadline to meet on November 10, 2024` → `plans.md`
- `I check in every Wednesday` or `I'll check in every Wednesday` → `plans.md`
- `I chose Adidas Ultraboost after trying both` → keep `Adidas Ultraboost` in `facts.md` if it is the settled selection
- `My parents live 12 miles away` → keep in `facts.md`
- `I summarized everything in one paragraph` → summary content belongs in `summary.md`, not `facts.md`
- `diff --git ...` or a pasted function body → do not copy; summarize the decision, source path, verification, and follow-up

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
- exact-value risks such as paraphrased `facts.md`, normalized fractions or spellings, or stable fact clauses being left only in `events.md`
