---
name: kinic-source-onboarding
description: Operator runbook for adding a new official docs source to Kinic docs context without mixing source curation with read-only user queries.
---

# Kinic Source Onboarding

Use this skill when adding or planning a new docs source for `/Wiki/sources`.

## Rules

- Prefer official documentation URLs.
- Prefer extending an existing source's crawl targets before creating a new source.
- Use only ASCII letters, numbers, `-`, and `.` in docs `source_id` segments; do not use `_`.
- Require at least overview, API reference, and examples coverage before a source is ready.
- Keep `coverage_role` explicit: `overview`, `api_reference`, or `examples`.
- For sitemap or GitHub tree ingestion, require an explicit `max_pages`.
- Do not hand-edit `registry.yaml` when a registry helper exists.
- Treat missing `register_source.py` as a blocker for automated onboarding; document the intended registry entry and stop before mutation.

## Workflow

1. Confirm the official docs URL and license posture.
2. Choose `source_id`, title, version strategy, trust level, and crawl targets.
3. Check whether an existing `source_id` should be extended.
4. Prepare coverage roles for minimum overview/API/examples coverage.
5. If `register_source.py` exists, use it; otherwise record the proposed registry entry for implementation.
6. Run validation or dry-run refresh if available.
7. Require `missing_required_roles` to be empty before marking the source ready.

## Boundary

This is an operator runbook. Normal users should use `kinic-docs-context-readonly` and `kinic-vfs-cli docs ...`.
