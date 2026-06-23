# Kinic Wiki Lint Workflow

## Goal

Inspect local and remote wiki health, report concrete findings, and propose the next repair action without silently applying fixes.

## Workflow

1. Decide whether the inspection target is local, remote, or both.
2. For local structure checks, inspect the relevant Markdown files directly. `kinic-vfs-cli` no longer provides local mirror lint.
3. For remote checks, read `/Wiki/index.md` first with `read-node-context`, then inspect directly linked or role-matched notes before broad search.
4. Use `search-remote`, `search-path-remote`, `list-nodes`, `glob-nodes`, and link commands only to confirm or expand findings after direct note inspection.
   - For wiki-only inspection, pass `--prefix /Wiki` or `path: "/Wiki"` unless raw source material is explicitly in scope.
5. Group findings into:
   - duplication
   - isolation
   - stale navigation or index
   - unrequested hierarchy or folder sprawl
   - missing cross-links
   - ambiguous page boundaries
   - canonicality leaks between structured notes
   - unresolved contradiction state
6. Report findings first.
7. Only edit pages if the user asks for fixes or the workflow explicitly includes a repair step.
8. For OKF bundle validation, use `kinic-context-pack` and `context-pack verify` instead of wiki lint rules.

## Working Rules

- Current repo-local note roles live in [docs/STORE_API.md](../../docs/STORE_API.md). Use it for concrete note names, role mapping, and trust model.
- When `/Wiki/index.md` is stale, recommend a focused root catalog edit first. Recommend `rebuild-index` only for broad repair.
- Treat `/Wiki/index.md` as the only required catalog. Do not flag missing `<scope>/index.md`, `overview.md`, `schema.md`, `log.md`, or `topics/*.md` unless the user explicitly requested that scoped structure.
- Flag folders, scoped indexes, and scaffold pages that were created without a clear user request or retrieval need.
- Recommend `rebuild-scope-index --scope <scope>` only when the user explicitly wants a scope landing page. Do not require rebuilds for routine small edits.
- Keep local lint separate from remote content review.
- Treat note role violations from `STORE_API.md` as first-class findings.
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
- Prefer reporting the exact offending lines and the target canonical note, not generic prose.
- When possible, phrase findings as `offending line -> target note` rather than broad page-level commentary.

## Repo Contract

- Local lint: inspect Markdown files directly; no local mirror lint command exists.
- OKF bundle validation: use `kinic-vfs-cli context-pack verify <bundle-dir>` through `kinic-context-pack`.
- Remote inspection primitives:
  - CLI commands: `read-node-context`, `read-node`, `list-nodes`, `glob-nodes`, `search-remote`, `search-path-remote`, `graph-neighborhood`, `incoming-links`, `outgoing-links`, `rebuild-scope-index`, `rebuild-index`
  - Use `list-children` for one-level tree navigation.
  - Use `list-nodes --prefix <path> --recursive --json` for inventory, bulk repair review, and destructive operation review.

## Output

Prefer:

- a prioritized findings list
- a short next-action plan

Optionally include:

- candidate page merges
- candidate missing links
- recommendation to repair `/Wiki/index.md`, usually by focused edit; use `rebuild-index` only for broad repair
- candidate canonicality repairs such as:
  - move exact settled values into the canonical fact note
  - move current value into `facts.md`
  - move chronology-only event lines out of `facts.md` into `events.md`
  - move future / pending lines out of `facts.md` into `plans.md`
  - move unresolved state into the canonical open-question note
  - remove exact-evidence lines from the summary note
  - restore the source-faithful exact span inside `facts.md`
  - replace copied code or diffs with source-path pointers plus decision, rationale, verification, and follow-up
