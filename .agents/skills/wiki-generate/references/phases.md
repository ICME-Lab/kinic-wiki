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
- use the existing `wiki-cli push` or plugin push path

### Output

- pushed changes
- or a clear statement that the result is review-ready but not pushed
