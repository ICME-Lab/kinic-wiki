# Vault Operations

## Principles

- keep file paths stable
- avoid breaking backlinks through careless renames
- prefer small, reviewable note changes
- assume a human may open the note immediately after the agent edits it

## In This Repo

For the managed wiki area:

- use `Wiki/pages/<slug>.md`
- keep links in `[[slug]]` form
- let `wiki-cli` and the plugin own push/pull behavior

Do not invent parallel local stores for content that should live in the working copy.
