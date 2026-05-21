---
name: kinic-skill-registry
description: Kinic Skill Registry workflow skill for managing Agent Skills-compatible packages through kinic-vfs-cli skill commands, including upsert, import, find, inspect, run evidence, proposals, status changes, and lockfile-only install.
---

# Kinic Skill Registry

Use this skill when the user wants to:

- manage skill packages stored under `/Wiki/skills` or `/Wiki/public-skills`
- use `kinic-vfs-cli skill ...` commands
- find or inspect skills by task context
- record run evidence, promote, deprecate, or approve proposals
- create a lockfile-only install record

Do not use this skill for:

- ordinary wiki query, ingestion, or lint work
- browser UI implementation
- local agent runtime placement
- permission enforcement beyond database roles

Core rules:

- Treat [`../../../docs/SKILL_REGISTRY.md`](../../../docs/SKILL_REGISTRY.md) as the source of truth.
- Keep `kinic-vfs-cli` as the only public binary; do not introduce `skill-cli` or `wiki-cli`.
- Use `kinic-vfs-cli skill ...` for package lifecycle commands.
- Authenticated CLI commands default to Internet Identity through `icp identity default`; use `--allow-non-ii-identity` only for explicit operator workflows that require PEM or another non-II identity.
- `skill upsert` and `skill import github` write package files through the `write_nodes` batch API.
- Use `database link` or `--database-id` for DB selection; access control remains database-level.
- Treat packages as normal VFS nodes, not as canister schema.
- Keep `skill install` lockfile-only; do not copy package files into an agent runtime.
- Prefer `promoted` or `reviewed` skills and ignore `deprecated` skills unless auditing.
- Record usage evidence after a skill materially affects a task outcome.
- Proposal approval marks evidence accepted; it does not apply a diff to `SKILL.md`.

Before substantive registry work:

1. Read `docs/SKILL_REGISTRY.md`.
2. Confirm the target database is selected.
3. Use the smallest relevant command set:
   - package write: `skill upsert` or `skill import github`
   - discovery: `skill find`
   - inspection: `skill inspect`
   - evidence: `skill record-run`
   - lifecycle: `skill set-status`, `skill propose-improvement`, `skill approve-proposal`
   - downstream pinning: `skill install --lockfile`
