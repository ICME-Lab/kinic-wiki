---
name: kinic-source-refresh-operator
description: Operator runbook for refreshing existing Kinic docs sources through dry-run, staging write, smoke, and production promotion gates.
---

# Kinic Source Refresh Operator

Use this skill for manual or scheduled docs source refresh operations.

## Rules

- Dry-run first.
- Review added, changed, and removed chunk counts.
- Require `missing_required_roles` to be empty.
- Treat warnings as `needs_review`.
- Do not promote to prod unless staging `wiki_write` and smoke checks pass.
- Keep refresh write operations separate from read-only docs context commands.
- If refresh tooling is missing, stop and report the missing prerequisite.

## Workflow

1. Run the source refresh dry-run for the target source or all sources.
2. Inspect coverage and quality gates.
3. Check abnormal added/changed/removed counts before any write.
4. Write to staging only after dry-run passes.
5. Run docs source list/query smoke against staging.
6. Promote to prod only when staging write and smoke both pass.
7. On prod failure, inspect rollback status before retrying.

## Boundary

Do not use this skill for user-facing docs retrieval. Use `kinic-docs-context-readonly` for read-only context.
