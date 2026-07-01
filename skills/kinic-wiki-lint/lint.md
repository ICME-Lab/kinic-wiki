# Kinic Wiki Lint Workflow

## Goal

Inspect local and remote wiki health, report concrete findings, and propose the next repair action without silently applying fixes.

## Workflow

1. Decide whether the inspection target is local, remote, or both.
2. For local structure checks, inspect the relevant Markdown files directly. `kinic-vfs-cli` no longer provides local mirror lint.
3. For remote structure-only checks, start with `list-nodes`, `list-children`, and link commands; do not read `/Knowledge/index.md` just to build an inventory.
4. Read `/Knowledge/index.md` with `read-node-context` when navigation content, catalog staleness, or link-aware context is part of the finding, then inspect directly linked or role-matched notes before broad search.
5. Use `search-remote`, `search-path-remote`, `glob-nodes`, and additional link commands to confirm or expand findings after the narrow structure or catalog check.
   - For wiki-only inspection, pass `--prefix /Knowledge` or `path: "/Knowledge"` unless evidence source material is explicitly in scope.
6. Group findings into:
   - duplication
   - isolation
   - stale navigation or index
   - unrequested hierarchy or folder sprawl
   - missing cross-links
   - ambiguous page boundaries
   - weak database discovery metadata
   - canonicality leaks between structured notes
   - unresolved contradiction state
7. Report findings first.
8. Only edit pages if the user asks for fixes or the workflow explicitly includes a repair step.
9. For OKF bundle validation, use `kinic-context-pack` and `context-pack verify` instead of wiki lint rules.

## Read Strategy

1. Prefer CLI `query-context --json` for task-scoped remote context.
2. Use `list-nodes --prefix <path> --recursive --limit 100 --json` and link commands for structure checks that do not need content.
3. Use `search-remote` or `search-path-remote` with `--preview-mode content-start` to expand findings before full reads.
4. Use `query-sql` for known-path multi-node content reads when checking canonicality across several notes. If 2 or more known paths need bodies, default to one `query-sql` read instead of looping `read-node`.
5. Use CLI `export-snapshot --json` when a whole scope must be inspected.
6. Use CLI `fetch-updates --json` only when a trusted `snapshot_revision` already exists.
7. Use `read-node --json` for a single final offending-line confirmation.
8. Use `read-node-context` only when catalog, navigation, or link-aware context is needed. Do not use it for ordinary body reads or structure inventory.

## Working Rules

- Use the note-role rules in this file as the installed-skill trust model. When this skill runs inside the repo and `docs/STORE_API.md` is available, use that file for current repo-local note names and role refinements.
- When `/Knowledge/index.md` is stale, recommend a focused root catalog edit first. Recommend `rebuild-index` only for broad repair.
- Treat `/Knowledge/index.md` as the only required catalog. Do not flag missing `<scope>/index.md`, `overview.md`, `schema.md`, `log.md`, or `topics/*.md` unless the user explicitly requested that scoped structure.
- Flag folders, scoped indexes, and scaffold pages that were created without a clear user request or retrieval need.
- Recommend `rebuild-scope-index --scope <scope>` only when the user explicitly wants a scope landing page. Do not require rebuilds for routine small edits.
- Keep local lint separate from remote content review.
- Treat note-role boundary violations as first-class findings.
- Flag exact-value evidence leaking into `summary.md` or unresolved conflict leaking into settled notes as canonicality findings, not style notes.
- For target-note guidance, treat `facts.md` as the canonical note for exact stable fact, current value, selected option, and stable relationship-duration.
- Treat `events.md` as the canonical note for chronology-only completed events, `plans.md` for future / pending / next action, and `summary.md` for recap only.
- Flag stable exact facts that appear only in `events.md`, `plans.md`, or long recap prose but are missing from `facts.md`.
- Flag current value gaps where `old value` and `new value` are scattered across notes but `facts.md` does not state the current value explicitly.
- Flag chronology-only event lines inside `facts.md`.
- Flag future / pending lines inside `facts.md`.
- Flag recap prose inside `facts.md`.
- Flag normalized or paraphrased `facts.md` values when the settled source span is materially more exact, for example `1/13` instead of `4/52`, `color` instead of `colour`, or shortened money/date formats.
- Flag long code blocks, long diffs, generated docs, or schema dumps copied into wiki notes.
- Flag implementation snippets inside `facts.md`; code notes should point to repo source paths and record decisions, not copy code bodies.
- Flag `summary.md` pages that are mostly README or generated-doc copies instead of recap.
- Flag code notes that list file paths but omit the decision, rationale, verification, or follow-up that makes the note useful.
- For DB metadata health, inspect `database list --json` before content findings when the user asks about public retrieval or public memory discovery.
- Flag empty `description`, empty `llm_summary`, invalid `tags_json`, and empty tag arrays.
- Flag `description` and `llm_summary` when they are identical, nearly identical, or both just repeat the title.
- Flag name-only public DBs because `find_databases` cannot reliably select them for purpose queries.
- Treat `description` as the short human/DB-picker surface and `llm_summary` as the longer retrieval-planning surface. A good `llm_summary` names answerable question types, representative paths or domains, useful FTS search terms, and out-of-scope content.
- Do not auto-fix DB metadata during lint. Recommend `kinic-wiki-ingest` DB Metadata Refresh for candidate generation.
- For canonicality checks, avoid reading every candidate body one by one. Use inventory and previews first, then `query-sql` for the narrow path set.
- Once 2 or more candidate paths are accepted for body comparison, use `query-sql` by default and reserve `read-node` for one final offending node.
- Prefer reporting the exact offending lines and the target canonical note, not generic prose.
- When possible, phrase findings as `offending line -> target note` rather than broad page-level commentary.

## Repo Contract

- Local lint: inspect Markdown files directly; no local mirror lint command exists.
- OKF bundle validation: use `kinic-vfs-cli context-pack verify <bundle-dir>` through `kinic-context-pack`.
- Remote inspection primitives:
  - Store API CLI preferred entrypoint: `query-context --json`
  - Store API CLI scope reads: `export-snapshot --json`, `fetch-updates --json`
  - CLI commands: `memory-manifest`, `query-context`, `source-evidence`, `export-snapshot`, `fetch-updates`, `read-node-context`, `read-node`, `list-nodes`, `glob-nodes`, `search-remote`, `search-path-remote`, `query-sql`, `graph-neighborhood`, `incoming-links`, `outgoing-links`, `rebuild-scope-index`, `rebuild-index`
  - DB metadata inspection: `database list --json`
  - Use `list-children` for one-level tree navigation.
  - Use `list-nodes --prefix <path> --recursive --limit 100 --json` for inventory, bulk repair review, and destructive operation review.
  - Use search `--preview-mode content-start` before full content reads.
  - Use `query-sql` for narrow known-path multi-node reads from `fs_nodes`; 2 or more known paths should use `query-sql` by default.
  - Use `read-node-context` only for link-aware catalog/navigation checks.

## Output

Prefer:

- a prioritized findings list
- a short next-action plan

Optionally include:

- candidate page merges
- candidate missing links
- recommendation to repair `/Knowledge/index.md`, usually by focused edit; use `rebuild-index` only for broad repair
- candidate canonicality repairs such as:
  - move exact settled values into the canonical fact note
  - move current value into `facts.md`
  - move chronology-only event lines out of `facts.md` into `events.md`
  - move future / pending lines out of `facts.md` into `plans.md`
  - move unresolved state into the canonical open-question note
  - remove exact-evidence lines from the summary note
  - restore the source-faithful exact span inside `facts.md`
  - replace copied code or diffs with source-path pointers plus decision, rationale, verification, and follow-up
