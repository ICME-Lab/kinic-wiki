# Kinic Wiki Edit Workflow

## Goal

Safely repair, redact, or update existing Kinic Wiki nodes.
Use this workflow only when the user asked for mutation or accepted a specific repair.

## CLI Reference

- Use `kinic-vfs-cli` for all remote reads and mutations.
- Run `kinic-vfs-cli --help` for the command list.
- Run `kinic-vfs-cli <command> --help` before using an unfamiliar mutation command.
- Use `docs/CLI.md` as the full CLI usage reference when working inside this repo.

## Workflow

1. Confirm target database and access with `status --json`.
2. Build the candidate path set with `query-context`, search, inventory, or link commands.
3. Use `query-sql` for 2 or more known-path reads when narrowing candidates.
4. Read every accepted target immediately before mutation with `read-node --json` or selected fields including `path`, `etag`, and `content`.
5. Apply the smallest safe mutation: `write-node`, `append-node`, `edit-node`, `multi-edit-node`, `delete-node`, or `delete-tree`.
6. Pass `--expected-etag` whenever the command supports it.
7. Verify the affected prefix with a narrow search or representative read.
8. Update the relevant scope `log.md` append-only when the repo workflow requires it.

## Mutation Safety

- Do not mutate from stale reads.
- Do not edit paths that were not explicitly accepted into the repair set.
- For `delete-tree`, inspect first with `list-nodes --prefix <path> --recursive --json` and stop if unexpected paths are present.
- Ask before destructive deletion, unclear redaction policy, or API-contract changes.
- For multi-node repairs, keep a path-by-path summary of old state, intended replacement, etag, command, and verification result.

## Boundaries

- Use `kinic-wiki-query` for answer-only work.
- Use `kinic-wiki-ingest` when new source material must be persisted or synthesized.
- Use `kinic-wiki-lint` for report-only health checks.
