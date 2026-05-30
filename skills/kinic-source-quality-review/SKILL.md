---
name: kinic-source-quality-review
description: Review Kinic docs source chunk quality, metadata, citation integrity, coverage, and raw evidence links before or after refresh.
---

# Kinic Source Quality Review

Use this skill when reviewing docs source quality, refresh reports, normalized chunks, or citation integrity.

## Rules

- Scope is docs source quality only.
- Leave generic Wiki health to `kinic-wiki-lint`.
- Warn when normalized chunk count is unexpectedly low or high.
- Warn when snippets are empty, code-only, or disconnected from citation context.
- Warn when citation is missing, non-absolute, or points to a local path other than an explicit `file://` source.
- Warn when `source_id`, `chunk_id`, `citation`, `version`, `source_type`, `target_label`, or `coverage_role` is missing.
- Confirm raw evidence links where available with read-only context commands.

## Workflow

1. Inspect normalized JSONL or refresh report summary.
2. Check required metadata fields for sampled chunks.
3. Check citation URL shape and source trust.
4. Compare chunk count and role coverage against expectations.
5. Use `kinic-vfs-cli docs source query ... --json` for stored chunk smoke.
6. Report blockers, warnings, and acceptable residual risk.

## Boundary

Do not edit source registry or wiki nodes from this skill. Hand off to `kinic-source-onboarding` or `kinic-source-refresh-operator` for operator changes.
