# Obsidian Rules

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

For unmanaged drafts before first import, frontmatter may be omitted if the user is still reviewing structure. Once a page enters the managed mirror flow, it must match the mirror contract.

## Markdown Preferences

- use clear headings
- keep intros short
- link related pages directly with `[[slug]]`
- avoid noisy link density
- prefer explicit summaries over vague bullets

## Human Review

The local markdown should be comfortable to inspect in Obsidian:

- readable titles
- stable section structure
- obvious backlinks through wikilinks
- no hidden machine-only format

## Push Readiness

A draft is ready for push when:

- slug and page type are stable
- links are normalized
- the page does not obviously duplicate an existing page
- the human can understand the page by opening it directly in Obsidian
