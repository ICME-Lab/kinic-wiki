# Workflow

## Goal

Turn local source material into draft wiki pages that fit this repo's operating model:

- remote canister is the source of truth
- local `Wiki/` is the shared working copy
- humans review in Obsidian
- agents operate through CLI and filesystem edits

## Recommended Flow

1. Inspect the input material.
2. Group the material into candidate pages.
3. Decide page types and slugs before writing.
4. Draft pages locally.
5. Add or normalize links between those pages.
6. Stop at review-ready unless the user explicitly wants push.

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

- write or update local draft pages
- summarize what changed
- leave the result ready for Obsidian review

### Push-ready

Use this only when the user clearly wants publication.

- prepare review-ready pages
- confirm there are no obvious duplication or naming issues
- use the normal push path
