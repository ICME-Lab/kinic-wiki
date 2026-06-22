---
name: kinic-wiki-lint
description: Kinic Wiki workflow skill for inspecting local and remote wiki health without silently fixing it.
---

# Kinic Wiki Lint

Use this skill when the user wants to:

- inspect wiki health
- look for isolated or duplicated pages
- check whether `/Wiki/index.md` is stale
- review missing links, weak structure, or outdated organization
- decide what to fix next without auto-applying changes

Do not use this skill for:

- primary source ingestion
- ordinary question answering
- hidden repair runs
- OKF bundle structure verification; use `kinic-context-pack` and `context-pack verify`
- Skill Registry package lifecycle work; use `kinic-skill-registry`

Core rules:

- Treat the canister wiki as the source of truth.
- Organized wiki nodes live under `/Wiki/...`; raw sources live under `/Sources/raw/<provider>/<id>.md`.
- Treat local Markdown as review or drafting aid unless a workflow explicitly writes it back through VFS commands.
- Default to report-only behavior.
- Do not silently fix pages.
- Prefer concrete findings over vague style commentary.
- Keep local lint and remote inspection conceptually separate.
- Check note-role boundary violations as well as missing pages.
- Treat exact-value drift in `facts.md` as a real canonicality problem, not a style nit.
- Treat [../../docs/AGENT_MEMORY_API.md](../../docs/AGENT_MEMORY_API.md) as the trust model and note-role contract.

Read [lint.md](lint.md) before doing substantive Kinic Wiki lint work.
