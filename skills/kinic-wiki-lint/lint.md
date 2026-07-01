# Kinic Wiki Lint Workflow

## Goal

Inspect local or remote wiki health without silently fixing it.
Report concrete findings with paths, evidence, severity, and suggested next actions.

## CLI Reference

- Use `kinic-vfs-cli` for remote VFS inspection.
- Run `kinic-vfs-cli --help` for the command list.
- Run `kinic-vfs-cli <command> --help` before using an unfamiliar inspection command.
- Use `docs/CLI.md` as the full CLI usage reference when working inside this repo.

## Workflow

1. Confirm target database and access with `status --json` when inspecting remote state.
2. Keep local Markdown checks separate from remote canister checks.
3. Use `list-nodes` for structure, prefix, and etag inventory.
4. Use `read-node-context` only when catalog, navigation, or link-aware context matters.
5. Use `search-remote`, `search-path-remote`, and link commands to confirm or expand findings.
6. Prefer `query-context --json` for task-scoped remote context.
7. Use `query-sql` for 2 or more known-path content reads during canonicality checks.
8. Use `read-node --json` for one final offending-line confirmation.
9. Use snapshot/export commands only when a whole scope must be inspected or a trusted snapshot revision is already available. Check the command help before use.

## Findings

- Report exact paths and the command category used to verify the issue.
- Treat exact-value drift in `facts.md` as a real canonicality issue.
- Flag exact evidence leaking into summaries as a canonicality finding, not a style note.
- Prefer concrete missing-link, stale-index, duplicate-page, isolated-page, and note-role boundary findings.
- Do not produce vague style commentary without a path-specific impact.

## Safety

- Do not mutate remote wiki nodes in this skill.
- Do not use `delete-node`, `delete-tree`, write, append, edit, rebuild, or proposal/status mutation commands.
- If a repair is needed, hand off to `kinic-wiki-edit` or `kinic-wiki-ingest`.
- For OKF bundle validation, use `kinic-context-pack`.
