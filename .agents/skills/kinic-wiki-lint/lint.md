# Kinic Wiki Lint Workflow

## Goal

Inspect local and remote wiki health, report concrete findings, and propose the next repair action without silently applying fixes.

## Workflow

1. Decide whether the inspection target is local, remote, or both.
2. For local structure checks, use `wiki-cli lint-local`.
3. For remote checks, read `index.md`, inspect recent pages, and use `search-remote`, `search-path-remote`, `list-nodes`, `glob-nodes`, `recent-nodes`, and `read-node`.
4. Group findings into:
   - duplication
   - isolation
   - stale navigation or index
   - missing cross-links
   - ambiguous page boundaries
   - canonicality leaks between structured notes
   - unresolved contradiction state
5. Report findings first.
6. Only edit pages if the user asks for fixes or the workflow explicitly includes a repair step.

## Working Rules

- Current repo-local note schema lives in [WIKI_CANONICALITY.md](../../../WIKI_CANONICALITY.md). Use it for concrete note names and current role mapping.
- When `index.md` is stale, recommend or run `rebuild-scope-index --scope <scope>` for single-scope drift, or `rebuild-index` for broad repair.
- Recommend `rebuild-scope-index --scope <scope>` for new page creation, deletion, or large single-scope restructures. Recommend `rebuild-index` only for cross-scope restructures. Do not require rebuilds for routine small edits.
- Keep local lint separate from remote content review.
- Treat note role violations from `WIKI_CANONICALITY.md` as first-class findings.
- Prefer reporting the exact offending lines and the target canonical note, not generic prose.

## Repo Contract

- Local lint command: `wiki-cli lint-local --vault-path <path> [--json]`
- Remote inspection primitives:
  - CLI commands: `read-node`, `list-nodes`, `glob-nodes`, `recent-nodes`, `search-remote`, `search-path-remote`, `rebuild-scope-index`, `rebuild-index`

## Output

Prefer:

- a prioritized findings list
- a short next-action plan

Optionally include:

- candidate page merges
- candidate missing links
- recommendation to rebuild `index.md`, usually with `rebuild-scope-index --scope <scope>` first
- candidate canonicality repairs such as:
  - move exact settled values into the canonical fact note
  - move unresolved state into the canonical open-question note
  - remove exact-evidence lines from the summary note
