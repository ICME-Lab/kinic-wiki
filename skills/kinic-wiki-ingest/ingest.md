# Kinic Wiki Ingest Workflow

## Goal

Turn source material into review-ready Kinic Wiki updates.
Keep raw evidence under `/Sources/...` and organized notes under `/Knowledge/...`.

## CLI Reference

- Use `kinic-vfs-cli` for all remote VFS reads and writes.
- Run `kinic-vfs-cli --help` for the command list.
- Run `kinic-vfs-cli <command> --help` before using an unfamiliar read or mutation command.
- Use `docs/CLI.md` as the full CLI usage reference when working inside this repo.

## Workflow

1. Confirm target database and access with `status --json`.
2. Inspect existing scope before drafting changes.
3. Prefer `query-context --json` for current wiki context.
4. Use `list-nodes` for path inventory, overwrite checks, and destructive-operation review.
5. Use `search-remote` or `search-path-remote` to find existing related notes before creating new pages.
6. Use `query-sql` for 2 or more known-path reads or bulk overwrite checks.
7. Persist source material under `/Sources/<provider>/<id>.md` before linking or synthesizing `/Knowledge/...`.
8. Write review-ready `/Knowledge/...` pages through CLI mutation commands only after the write set is clear.
9. Use `read-node --json` immediately before overwriting existing nodes and pass the returned etag through mutation guards.
10. Verify with a representative read and search over the affected prefix.

## Content Rules

- Preserve exact values such as dates, money, fractions, spellings, product names, and role labels.
- Keep transcript-like acknowledgements, tentative plans, and question phrasing out of `facts.md` unless they are canonical facts.
- Route unresolved items to the appropriate question/open item page instead of promoting them into settled notes.
- Keep source persistence separate from wiki synthesis.
- Do not move or rewrite existing evidence sources unless the user explicitly asks.
- Stop at review-ready unless the user explicitly asks to push or publish.

## Mutation Safety

- For existing nodes, always read current content and etag before mutation.
- Use `--expected-etag` when the command supports it.
- For `delete-tree`, inspect first with `list-nodes --prefix <path> --recursive --json` and report unexpected paths before deletion.
- Update an existing relevant `log.md` append-only when the workflow or user requires logging. Do not create `log.md` by default.

## Handoffs

- Use `kinic-wiki-query` for answer-only questions.
- Use `kinic-wiki-edit` for existing-node repair without new source intake.
- Use `kinic-context-pack` for portable AI handoff after the wiki structure exists.
