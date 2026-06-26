# Kinic Wiki Ingest Workflow

## Goal

Turn evidence source material into review-ready wiki updates under the canister-backed llm-wiki model.

## Workflow

1. Inspect the source material and the user focus.
2. If the source is noisy web or PDF-derived text, normalize it first.
3. Decide whether the source should also be persisted under `/Sources/...`.
4. Read existing wiki context with `read-node-context` by starting from `/Knowledge/index.md` and the canonical role-matched notes before broad search.
   - If `/Knowledge/index.md` is missing and the workflow will create or reorganize wiki pages, create or repair it before stopping.
5. Use `search-remote` or `search-path-remote` only when the relevant canonical notes are missing, ambiguous, or insufficient.
   - For wiki-only inspection or edits, pass `--prefix /Knowledge` or `path: "/Knowledge"` unless evidence source material is explicitly needed.
6. Choose the minimum coherent set of pages to update.
7. Edit `/Knowledge/...` directly through `kinic-vfs-cli` remote VFS commands.
   - Authenticated CLI writes default to Internet Identity via `icp identity default`.
   - Use `--allow-non-ii-identity` only when the user explicitly chooses a PEM or other non-II operator identity.
8. When a reorganization needs explicit removal of obsolete `/Knowledge/...` page groups, inspect the target first with `list-nodes --prefix <path> --recursive --json`, report the count, then use `delete-tree` from the CLI rather than treating deletion as an implicit side effect.
9. If a relevant `log.md` exists or the user asks for logging, update it for every page creation, deletion, or edit done in the workflow. Do not create `log.md` by default.
10. When appending to `log.md`, read only the recent tail first, for example `tail -n 5`, unless a longer window is clearly needed.
11. Append one new log line per workflow mutation. Do not rewrite or restructure older log entries.
12. Keep `/Knowledge/index.md` navigable for new page creation and deletion. Do not create folders or scope indexes by default. Run `rebuild-scope-index --scope <scope>` only when the user explicitly wants a scope landing page. Use `rebuild-index` only for broad repair. Skip rebuilds for routine small edits.
13. Stop at review-ready unless the user explicitly asks for push.
14. If the user wants an OKF bundle after the wiki structure is ready, hand off to `kinic-context-pack`; do not export as an ingest side effect.

## LLM Wiki Scope Setup

Use this workflow only when the user explicitly asks for scoped structure, repairing a thin benchmark import, or converting raw notes into a compounding LLM Wiki.

1. Identify the scope root, for example `/Knowledge/<scope>`, and list existing pages under it before writing.
2. Confirm evidence sources live under `/Sources/...`; do not move or rewrite evidence source nodes during scope setup.
3. Create or update only the scope-level pages the scoped structure needs:
   - `index.md`: optional scoped catalog and navigation entry point.
   - `overview.md`: optional corpus-level synthesis and reading guide.
   - `schema.md`: optional scope-local conventions and maintenance rules.
   - `log.md`: optional append-only chronological record for scoped updates.
   - `topics/*.md`: optional category or topic synthesis pages that connect related source-level notes.
4. Do not stop with a missing `/Knowledge/index.md`; the root catalog is required.
5. Keep any scoped `index.md` compact. Link to overview, schema, log, topic pages, and important child pages instead of embedding the full synthesis.
6. Put corpus-wide meaning in `overview.md`, topic-level synthesis in `topics/*.md`, and source/conversation recap in each child `summary.md`.
7. When regenerating `summary.md`, read the evidence source path and existing `events.md`, `plans.md`, `open_questions.md`, and `provenance.md` first. Write recap, outcome, important decisions, unresolved points, and source links; do not promote exact stable facts into summary.
8. Use source path-level evidence links by default unless the user asks for turn, line, or claim-level provenance.
9. After setup, append one `log.md` entry when a log page exists, and update `/Knowledge/index.md`. Rebuild a scope index only when that scoped `index.md` is intended.

## Conversation Source Setup

Use this workflow when turning one raw conversation source into wiki material.

1. Confirm the evidence source lives at `/Sources/<provider>/<id>.md`; do not move or rewrite it during synthesis.
2. Read the full evidence source and any existing wiki page that already cites the same source.
3. Let the LLM choose a concrete, content-specific title from the conversation. Do not use the opaque `source_id` as the public page title unless it is the only meaningful identifier.
4. Default to one flat page at `/Knowledge/<llm-generated-title>.md`.
5. In that page, include only the sections that the source actually supports: `Summary`, `Key Facts`, `Decisions`, `Open Questions`, `Follow-ups`, and `Provenance`.
6. Put a source path reference in `Provenance`, for example `/Sources/<provider>/<id>.md`.
7. If this creates a new page, ensure `/Knowledge/index.md` links to it before stopping. Do not create `/Knowledge/conversations`, `/Knowledge/conversations/index.md`, or any other folder unless the user explicitly asks for that hierarchy.
8. Do not create fixed empty scaffolds such as `facts.md`, `events.md`, `plans.md`, `preferences.md`, `open_questions.md`, `provenance.md`, and `log.md` by default.
9. Split into multiple flat pages only when the conversation is large, will receive continuing updates, or clearly needs role-specific retrieval paths. If splitting, state the page map before writing. Do not add folders unless the user explicitly asks for hierarchy.

## Bulk Source Ingest

Use this workflow when ingesting many local files, for example 10 or more evidence sources.

1. Normalize every evidence source path before writing. Each source file must use `/Sources/<provider>/<id>.md`; create the parent folder first.
2. Build the full write set before mutating remote state: evidence sources, wiki pages, and one append-only `log.md` entry only when a log page already exists or the user asks for logging.
3. Prefer `write-nodes --input <nodes.json>` for the write set instead of looping `write-node` for every file.
4. Set `expected_etag` for overwrites by reading current nodes first. Use `None` only for new nodes.
5. Do not run `rebuild-scope-index` if it would overwrite a detailed `index.md` that was just generated. If an index rebuild is needed, run it before restoring or rewriting the detailed index.
6. Verify with `status`, one representative `read-node`, and one representative `search-remote` over the affected prefix.

For bulk repair of existing wiki nodes without new source material, use `kinic-wiki-edit` instead of this ingest workflow.

## Working Rules

- Current repo-local note roles live in [docs/STORE_API.md](../../docs/STORE_API.md). Use it for concrete note names, trust model, and current role mapping.
- Runtime `facts.md` extraction policy follows [docs/STORE_API.md](../../docs/STORE_API.md). Keep skill guidance aligned with that rule, not with benchmark-specific phrasing.
- Treat local `Wiki/` content as the human review surface.
- Keep OKF Context Pack export separate from source ingestion; use `kinic-context-pack` after `/Knowledge/...` is ready.
- Prefer fewer stronger pages over many shallow stubs.
- For conversation sources, prefer one titled flat page over a directory of shallow role files unless the user explicitly asks for hierarchy.
- Reuse existing pages when possible instead of minting near-duplicates.
- Preserve note-role boundaries from `STORE_API.md` before adding new lines to any structured note.
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
- Keep existing `log.md` pages in sync with every page mutation.
- Keep `log.md` append-only so recent context can be read with `tail -n 5`.
- Do not hide push behind kinic-wiki-ingest.
- Preserve structured note roles from `STORE_API.md` while ingesting.
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

- Evidence source write path: `/Sources/<provider>/<id>.md`
- Evidence source append path: `/Sources/<provider>/<id>.md`
- Default conversation wiki path: `/Knowledge/<llm-generated-title>.md`
- Wiki target root: `/Knowledge/...`
- Preferred primitives:
  - Bulk writes: CLI `write-nodes --input <nodes.json>`
  - Multi-replacement single-node edit: CLI `multi-edit-node --path <path> --edits-file <edits-file> --expected-etag <etag>` where `<edits-file>` is a JSON file path such as `/tmp/edits.json`
  - Single-node CLI commands: `read-node-context`, `read-node`, `write-node`, `append-node`, `edit-node`, `delete-node`, `delete-tree`, `list-nodes`, `glob-nodes`, `search-remote`, `search-path-remote`, `graph-neighborhood`, `incoming-links`, `outgoing-links`, `rebuild-scope-index`, `rebuild-index`
  - Multi-node edits: use `write-nodes` only for prepared full-body replacements; otherwise build a path list, read etags, and run etag-aware per-node edits
- Delete semantics:
  - `delete-node`: delete one node path
  - `delete-tree`: delete real node paths under a prefix, deepest-first; inspect first with `list-nodes --prefix <path> --recursive --json`
- Listing semantics:
  - `list-children`: one-level tree or UI navigation
  - `list-nodes --prefix <path> --recursive`: bulk repair, lint, inventory, and destructive operation review
- `log.md` rule:
  - do not create it by default
  - if it exists or the user asks for logging, read only the recent tail before appending unless more history is needed
  - append one single-line event per mutation

## Output

Prefer one of these outputs:

- review-ready wiki page updates
- a page map and update plan before writing
- persisted evidence source plus linked wiki updates

When useful, also provide:

- pages created or updated
- source files used
- open questions that block push
- canonicality risks such as unresolved state leaking into settled notes, topic-only facts, or recap leaking into exact notes
- exact-value risks such as paraphrased `facts.md`, normalized fractions or spellings, or stable fact clauses being left only in `events.md`
