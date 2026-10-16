# Docs Index

## User Guides

- [PORTABLE_LEARNING.md](PORTABLE_LEARNING.md) — arbitrary-project setup, CLI-only plugins and durable learning jobs
- [CONTINUAL_LEARNING.md](CONTINUAL_LEARNING.md) — CLI learning, Codex/DSH integration, evaluation and guarded publication

- [CLI.md](CLI.md) — Official guide for kinic-vfs-cli
- [QUICKSTART_SKILL_KB.md](QUICKSTART_SKILL_KB.md) — Quickstart for the skill knowledge base
- [mcp.md](mcp.md) — MCP server usage
- [STORE_API.md](STORE_API.md) — Store API (read-only canister methods)
- [SKILL_REGISTRY.md](SKILL_REGISTRY.md) — Skill registry specification
- [Context Pack.md](<Context Pack.md>) — OKF handoff artifact specification
- [AGENT_TOOL_CALLING.md](AGENT_TOOL_CALLING.md) — Tool calling conventions for agents
- [DB_LIFECYCLE.md](DB_LIFECYCLE.md) — Database lifecycle

## Operations

- [IAP_PRODUCTION_RUNBOOK.md](IAP_PRODUCTION_RUNBOOK.md) — payment release acceptance and recovery constraints

- [RELEASE.md](RELEASE.md) — Release procedure
- [STAGING.md](STAGING.md) — Staging environment and deployment procedure
- [PUBLIC_SMOKE.md](PUBLIC_SMOKE.md) — Public environment smoke test procedure

## Legal

- [Privacy Policy](legal/privacy-policy.md) — Source for the published Kinic privacy policy
- [Support](legal/support.md) — Source for the published Kinic support page

## Dependency maintenance

- [DEPENDENCY_FORKS.md](internal/DEPENDENCY_FORKS.md) — Scope and update policy for forked dependencies

## Validation (validation/)

- [VFS_VALIDATION_PLAN.md](validation/VFS_VALIDATION_PLAN.md) — VFS validation plan
- [VFS_CORRECTNESS_CHECKLIST.md](validation/VFS_CORRECTNESS_CHECKLIST.md) — Correctness checklist
- [VFS_DEPLOYED_CANISTER_BENCHMARKS.md](validation/VFS_DEPLOYED_CANISTER_BENCHMARKS.md) — Deployed canister benchmark results


## Development records (Wiki)

Project entry: `/Knowledge/kinic-wiki/index.md`.
Wiki retains useful decisions, unresolved work and the authoritative records of
active cases. Do not upload every old plan or test log just to preserve it.
Completed task checklists and obsolete plans can remain in Git history.

The rationale for batch reads, SQL authorization and atomic mutations is at
`/Knowledge/kinic-wiki/decisions/wiki-io.md`. Learning implementation evidence
remains in the existing project workflow; product guidance is in
[AGENT_CONFIGURATION.md](AGENT_CONFIGURATION.md),
[CONTINUAL_LEARNING.md](CONTINUAL_LEARNING.md) and
[PORTABLE_LEARNING.md](PORTABLE_LEARNING.md).

Git retains code, executable tests and maintained product/operations documents.
Local document copies support active work; compare them with Wiki before cleanup
and preserve unpublished changes. Connection settings, selection, sync baselines
and recovery journals remain local and ignored. Plans 001/002 retain local copies
because their recorded review/device checks are unresolved.
