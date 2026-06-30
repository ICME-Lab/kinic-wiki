---
name: kinic-wiki-lint
description: Kinic Wiki workflow skill for inspecting local and remote wiki health without silently fixing it.
---

# Kinic Wiki Lint

Use this skill when the user wants to:

- inspect wiki health
- look for isolated or duplicated pages
- check whether `/Knowledge/index.md` is stale
- review missing links, weak structure, or outdated organization
- inspect database discovery metadata for public retrieval
- decide what to fix next without auto-applying changes

Do not use this skill for:

- primary source ingestion
- ordinary question answering
- hidden repair runs
- OKF bundle structure verification; use `kinic-context-pack` and `context-pack verify`
- skill store package lifecycle work; use `kinic-skill-registry`

Core rules:

- Treat the canister wiki as the source of truth.
- Organized wiki nodes live under `/Knowledge/...`; evidence sources live under `/Sources/<provider>/<id>.md`.
- Treat local Markdown as review or drafting aid unless a workflow explicitly writes it back through VFS commands.
- Default to report-only behavior.
- Do not silently fix pages.
- Prefer concrete findings over vague style commentary.
- Keep local lint and remote inspection conceptually separate.
- Check note-role boundary violations as well as missing pages.
- Treat exact-value drift in `facts.md` as a real canonicality problem, not a style nit.
- Use the embedded note-role rules in `lint.md` as the trust model. When this skill runs inside the repo and `docs/STORE_API.md` is available, use that file only as the current repo-local refinement.

Read [lint.md](lint.md) before doing substantive Kinic Wiki lint work.
