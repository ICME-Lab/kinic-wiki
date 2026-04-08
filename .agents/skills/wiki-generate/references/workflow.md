# Workflow

## Goal

Turn local source material into draft wiki pages that fit this repo's operating model:

- remote canister is the source of truth
- local `Wiki/` is the shared working copy
- humans review in Obsidian
- agents operate through CLI and filesystem edits

## Recommended Flow

1. For source-driven drafting, start with `wiki-cli source-to-draft --vault-path ... --input ...`.
2. Add `--persist-sources` when those markdown files should also be retained as raw remote sources.
3. Inspect the resulting page map and draft pages.
4. If you need finer control, fall back to `wiki-cli ingest-source` or `wiki-cli generate-draft` directly.
5. If the work product is a query/comparison result rather than source drafting, use `wiki-cli query-to-page`.
6. Add or normalize links between those pages.
7. Review in Obsidian.
8. Use `wiki-cli adopt-draft` for new pages, then `wiki-cli push` for later updates.
9. Run `wiki-cli lint-local --vault-path ...` before adopt-draft or push when you want a local structure pass.
10. Run `wiki-cli lint` after review or push when you want a remote health pass.
11. Stop at review-ready unless the user explicitly wants push.

## Drafting Heuristics

### Prefer fewer, stronger pages

Good first pages:

- one `overview` page for the area
- 2-5 `entity` or `concept` pages for the core topics
- optional `comparison` or `query_note` pages when there is clear analysis value

Avoid:

- one page per paragraph
- placeholder stubs with no real synthesis
- duplicate pages that differ only in title wording

### Slug Rules

- lowercase
- stable
- specific but short
- based on canonical topic names

Examples:

- `agent-memory`
- `wiki-sync`
- `obsidian-working-copy`

### Page Type Rules

- `overview`: navigation and summary
- `entity`: concrete named thing
- `concept`: abstract mechanism or idea
- `comparison`: explicit tradeoff page
- `query_note`: ongoing investigation or synthesis
- `source_summary`: one source or one tightly-bound source set

## When To Use Graph Assistance

Graph-style generation is useful when:

- the source folder is large
- relationships matter more than chronology
- the user wants candidate pages rather than one direct import

In that case, produce:

- a page map
- candidate relationships
- a smaller set of final draft pages

Do not treat graph output as final truth. It is draft material for the working copy.

Use it as an optional assistant between source intake and page mapping, not as a replacement for review or push control.

## Delivery Modes

### Review-first

Use this by default.

- persist raw source first when the input should be retained as source-of-truth material
- prefer `source-to-draft` to create or update local draft pages
- summarize what changed
- leave the result ready for Obsidian review

### Push-ready

Use this only when the user clearly wants publication.

- persist raw source first if relevant
- prepare review-ready pages
- adopt new draft pages into managed pages
- confirm there are no obvious duplication or naming issues
- use the normal push path
