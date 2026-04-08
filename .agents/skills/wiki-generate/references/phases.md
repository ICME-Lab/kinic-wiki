# Phases

This file defines the concrete contract for each stage of `wiki-generate`.

## Phase 1: Source Intake

### Objective

Understand what the source material is and what the user wants from it.

### Inputs

- local markdown files
- notes folders
- mixed docs or research folders
- user constraints about scope and style

### Required decisions

- direct drafting or graph-assisted drafting
- review-first or push-ready
- draft only a few pages or build a page set

### Output

- a short statement of scope
- a list of source files or folders being used
- whether raw source should first be persisted with `wiki-cli ingest-source`
- optional note that graph assistance is justified

## Phase 2: Page Map

### Objective

Choose the initial information architecture before writing pages.

### Required output

- candidate pages
- one slug per page
- one page type per page
- likely links between pages

Graph-assisted tooling may help create this output, but the final page map must still be explicitly chosen in this phase.

### Minimum page map shape

- one `overview` page when the topic area is broad
- core `entity` or `concept` pages
- optional `comparison` or `query_note` pages only when justified

### Stop conditions

Pause and ask for confirmation if:

- the page map is very ambiguous
- multiple page decompositions are equally plausible
- the user asked for a narrow scope and the map is expanding too far

## Phase 3: Draft Writing

### Objective

Write the initial markdown pages in the same form humans will inspect.

### Rules

- write to `Wiki/pages/<slug>.md` when working directly in the local working copy
- use `wiki-cli generate-draft` when the user wants the CLI to produce review-ready drafts
- use `wiki-cli query-to-page` when the input is an LLM query/comparison result that should become a new page
- prefer `[[slug]]` links
- keep titles and intros clear
- prefer synthesis over copy-paste
- do not create machine-only intermediate formats

### Expected output

- draft page files
- coherent links between those files

## Phase 4: Review Gate

### Objective

Make the draft ready for human review in Obsidian.

### Checks

- links are normalized
- slug choices are stable
- page types still make sense
- duplicated pages are removed or merged
- the page reads clearly without external hidden context
- new draft pages have enough review metadata to be adopted with `wiki-cli adopt-draft`

### Output

- review-ready draft pages
- a short inventory:
  - pages created
  - pages updated
  - open questions

## Phase 5: Push Gate

### Objective

Push only when the content is ready and the user wants publication.

### Rules

- do not push automatically unless the user asked for it
- prefer review-first behavior
- use `wiki-cli adopt-draft` before `wiki-cli push` when the page is still an unmanaged draft
- use the existing `wiki-cli push` or plugin push path

### Output

- pushed changes
- or a clear statement that the result is review-ready but not pushed

## Phase 6: Lint Gate

### Objective

Inspect the local or remote wiki health report and let the LLM choose the next repair action.

### Rules

- use `wiki-cli lint-local` for local working copy structure checks before adopt or push
- use `wiki-cli lint` as a report-only command
- do not expect the CLI to fix or draft pages automatically
- use the report to decide whether to edit `Wiki/`, adopt a draft, or push another update
