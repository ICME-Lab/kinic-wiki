# Shared Rules

## Goal

Keep repo-wide wiki workflow rules compact and reusable across `kinic-wiki-ingest`, `kinic-wiki-query`, and `kinic-wiki-lint`.

## Mirror Contract

Draft pages should fit the same form the plugin and CLI expect.

- path: `Wiki/pages/<slug>.md`
- links: prefer `[[slug]]`
- frontmatter keys:
  - `page_id`
  - `slug`
  - `page_type`
  - `revision_id`
  - `updated_at`
  - `mirror: true`

For unmanaged drafts before first import, frontmatter may be omitted during structure review. Once a page enters the managed mirror flow, it must match the mirror contract.

## Markdown And Review

- use clear headings
- keep intros short
- link related pages directly with `[[slug]]`
- avoid noisy link density
- prefer explicit summaries over vague bullets
- keep local markdown comfortable to inspect in Obsidian
- do not hide machine-only structure in normal page content

A draft is ready for push when:

- slug and page type are stable
- links are normalized
- the page does not obviously duplicate an existing page
- the human can understand the page directly in Obsidian

## Vault Operations

- keep paths and note names stable
- avoid breaking backlinks through careless renames
- prefer explicit note operations over hidden background rewrites
- do not invent parallel local stores for managed wiki content

## Optional Guidance

External tools and imported ideas are optional helpers, not workflow authorities.

- borrow selectively from `obsidian-skills` for Obsidian-facing conventions
- borrow selectively from `graphify` for page-map or relationship suggestions
- do not replace the repo source-of-truth model with external tooling
- do not use graph assistance as the revision system, sync engine, or final authority on page boundaries
- use graph assistance only when the input set is large or relationship-heavy
- skip graph assistance when direct drafting is simpler

When graph assistance is used, keep it between source intake and page mapping. The useful outputs are candidate page boundaries, links, and split/merge suggestions.
